// long-run — the app-building path is a LONG, multi-round-trip task (TASK-20260803-hub-ops).
//
// Root cause of "builds silently drop": there is no timeout anywhere in the LLM path.
// The ceiling was DEFAULT_MAX_ITERATIONS = 6, never overridden by either caller, so a
// data-backed build (KB consult -> schema_apply -> artifact_write -> app_doc_write ->
// sign-off, plus any second KB consult) hit the cap and died with a terminal HOST_ERROR.
//
// Second failure mode: both adapters DISCARDED all accumulated text when a stream ended
// without its terminal event, so a build that dropped at minute 28 lost everything.

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MAX_ITERATIONS, runAgentTurn, type AgentTool, type AgentTurnEvent } from '../agent-turn.js';
import { anthropicAdapter } from '../anthropic.js';
import { mockAdapter, type MockTurn } from '../mock.js';
import { localAdapter } from '../local.js';
import { openaiAdapter } from '../openai.js';
import { block, fakeFetch, sseResponse } from './helpers.js';

const echoTool: AgentTool = {
  def: { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
  run: (input) => `echoed ${JSON.stringify(input)}`,
};

/** A build that needs `n` tool round-trips before its final sign-off turn. */
function buildScript(n: number): MockTurn[] {
  const turns: MockTurn[] = Array.from({ length: n }, (_, i) => ({
    text: `step ${i + 1}. `,
    toolCalls: [{ name: 'echo', input: { step: i + 1 } }],
  }));
  return [...turns, { text: 'done — your app is ready.' }];
}

describe('long-running builds', () => {
  it('completes a build needing 12 sequential tool round-trips (AC1)', async () => {
    const result = await runAgentTurn({
      adapter: mockAdapter(buildScript(12)),
      system: 's',
      messages: [{ role: 'user', content: 'build me a portfolio tracker' }],
      tools: [echoTool],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('step 12.');
      expect(result.text).toContain('done — your app is ready.');
    }
  });

  it('the default ceiling comfortably exceeds a real data-backed build', () => {
    // KB consult x2 + schema_apply + artifact_write + app_doc_write + sign-off = 6.
    // A default that merely equals the typical build is a cliff, not a ceiling.
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThanOrEqual(24);
  });

  it('still fails closed past the ceiling, naming the limit (AC2)', async () => {
    const endless = mockAdapter(
      Array.from({ length: 40 }, () => ({ text: '', toolCalls: [{ name: 'echo', input: {} }] })),
    );
    const result = await runAgentTurn({
      adapter: endless,
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [echoTool],
      maxIterations: 3,
    });

    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR', retryable: false });
    if (!result.ok) expect(result.message).toContain('3');
  });

  it('emits a round_trip observation per iteration with usage and timing (AC13)', async () => {
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: mockAdapter(buildScript(2)),
      system: 'system prompt here',
      messages: [{ role: 'user', content: 'build it' }],
      tools: [echoTool],
      onEvent: (event) => events.push(event),
    });

    const rounds = events.filter((e) => e.type === 'round_trip');
    expect(rounds).toHaveLength(3); // 2 tool turns + the final sign-off

    const first = rounds[0];
    if (first?.type !== 'round_trip') throw new Error('expected a round_trip event');
    expect(first.index).toBe(0);
    // The REQUEST as sent — this is what the inspector renders.
    expect(first.request.system).toBe('system prompt here');
    expect(first.request.messages[0]).toMatchObject({ role: 'user', content: 'build it' });
    expect(first.request.tools?.[0]?.name).toBe('echo');
    // The RESPONSE as received.
    expect(first.response.ok).toBe(true);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    // Later round-trips carry the growing conversation, so the inspector shows the
    // tool results that were fed back.
    const second = rounds[1];
    if (second?.type !== 'round_trip') throw new Error('expected a round_trip event');
    expect(second.request.messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

describe('partial text is never lost (AC3)', () => {
  const TRUNCATED_ANTHROPIC =
    block('message_start', '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1200}}}') +
    block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
    block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an app"}}');
  // ...connection dies here: no content_block_stop, no message_delta, no message_stop.

  it('anthropic returns the accumulated text alongside the drop error', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(TRUNCATED_ANTHROPIC));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const seen: string[] = [];

    const result = await adapter.complete({
      system: 's',
      messages: [{ role: 'user', content: 'build' }],
      onDelta: (d) => seen.push(d),
    });

    expect(seen.join('')).toBe('half an app');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.partialText).toBe('half an app');
    }
  });

  it('openai returns the accumulated text alongside the drop error', async () => {
    const truncated =
      block(null, '{"choices":[{"delta":{"content":"half an app"},"finish_reason":null}]}');
    const { fetchImpl } = fakeFetch(() => sseResponse(truncated));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });

    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'build' }] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.partialText).toBe('half an app');
  });

  it('runAgentTurn surfaces text accumulated across EARLIER completed iterations', async () => {
    // Iteration 1 succeeds with text + a tool call; iteration 2 dies mid-stream.
    // Losing iteration 1's text because iteration 2 dropped is the 28-minute bug.
    const adapter = mockAdapter([
      { text: 'planning your app. ', toolCalls: [{ name: 'echo', input: {} }] },
      { text: '', error: { code: 'STREAM_DROPPED', message: 'stream ended before completion', retryable: true } },
    ]);

    const result = await runAgentTurn({
      adapter,
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [echoTool],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.partialText).toContain('planning your app.');
  });
});

describe('output token limits (AC6-AC8)', () => {
  it('anthropic requests the 128K output ceiling by default', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      sseResponse(block('message_stop', '{"type":"message_stop"}')),
    );
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]?.bodyJson.max_tokens).toBe(128_000);
    // 128K output is built in on current models — no beta opt-in. The legacy
    // `output-128k-2025-02-19` header is a no-op and must NOT be re-added.
    expect(calls[0]?.headers['anthropic-beta']).toBeUndefined();
  });

  it('anthropic honours a maxTokens override on the wire', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      sseResponse(block('message_stop', '{"type":"message_stop"}')),
    );
    const adapter = anthropicAdapter({ apiKey: 'k', maxTokens: 4096, fetch: fetchImpl });

    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]?.bodyJson.max_tokens).toBe(4096);
  });

  it('openai sends an explicit max output token field (absent entirely before)', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      sseResponse(block(null, '{"choices":[{"delta":{},"finish_reason":"stop"}]}')),
    );
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]?.bodyJson.max_completion_tokens).toBe(128_000);
  });

  it('openai honours a maxTokens override', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      sseResponse(block(null, '{"choices":[{"delta":{},"finish_reason":"stop"}]}')),
    );
    const adapter = openaiAdapter({ apiKey: 'k', maxTokens: 2048, fetch: fetchImpl });

    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]?.bodyJson.max_completion_tokens).toBe(2048);
  });
});

describe('token usage is captured for the inspector', () => {
  it('anthropic reports input/output token usage from message_start + message_delta', async () => {
    const fixture =
      block('message_start', '{"type":"message_start","message":{"id":"m","usage":{"input_tokens":1234}}}') +
      block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
      block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}') +
      block('content_block_stop', '{"type":"content_block_stop","index":0}') +
      block('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":567}}') +
      block('message_stop', '{"type":"message_stop"}');
    const { fetchImpl } = fakeFetch(() => sseResponse(fixture));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 567 });
  });
});

describe('local adapter output cap (Gate-5 review)', () => {
  it('does not send the frontier 128K cap to a local server', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      sseResponse(block(null, '{"choices":[{"delta":{},"finish_reason":"stop"}]}')),
    );
    const adapter = localAdapter({ fetch: fetchImpl });

    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    // 128_000 exceeds what a local 7B-class model can emit, and some OpenAI-compatible
    // servers reject a cap above the model's context with a 400 — that would fail EVERY
    // local-mode turn.
    expect(calls[0]?.bodyJson.max_completion_tokens).toBe(8192);
  });

  it('still honours an explicit override', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      sseResponse(block(null, '{"choices":[{"delta":{},"finish_reason":"stop"}]}')),
    );
    const adapter = localAdapter({ maxTokens: 512, fetch: fetchImpl });

    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]?.bodyJson.max_completion_tokens).toBe(512);
  });
});
