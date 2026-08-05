// Phase B of TASK-20260804-observability-caching: the adapters half of the live
// round-trip surface (AC4, AC8) and prompt caching (AC12-AC15).
//
// Why these assertions are shaped the way they are:
//  - AC8 needs proof the start event fires BEFORE the call resolves, not merely that
//    two events arrive in order — so the adapter blocks on a deferred the test controls.
//  - AC12/AC13 follow R2: "we sent cache_control" proves nothing about whether a cache
//    was created (the minimum cacheable prefix is model-dependent — 512/1024/2048/4096 —
//    and below it the API silently does not cache). The load-bearing assertion is on a
//    mocked provider response REPORTING a cache read.
import { describe, expect, it, vi } from 'vitest';

import { runAgentTurn, type AgentTurnEvent } from '../agent-turn.js';
import { anthropicAdapter } from '../anthropic.js';
import { mockAdapter } from '../mock.js';
import { openaiAdapter } from '../openai.js';
import type { AdapterResult, AgentAdapter, ToolDef } from '../types.js';
import { block, fakeFetch, sseResponse } from './helpers.js';

const TOOL: ToolDef = {
  name: 'kb_lookup',
  description: 'Retrieves the knowledge base.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

/** Anthropic stream reporting cache activity in message_start usage (AC13). */
const CACHED_FIXTURE =
  block(
    'message_start',
    '{"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":2048}}}',
  ) +
  block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}') +
  block('content_block_stop', '{"type":"content_block_stop","index":0}') +
  block('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}') +
  block('message_stop', '{"type":"message_stop"}');

/** Same stream with no cache fields at all — the provider did not report caching. */
const UNCACHED_FIXTURE =
  block('message_start', '{"type":"message_start","message":{"id":"msg_2","model":"claude-opus-5","usage":{"input_tokens":12}}}') +
  block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}') +
  block('content_block_stop', '{"type":"content_block_stop","index":0}') +
  block('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}') +
  block('message_stop', '{"type":"message_stop"}');

const OPENAI_CACHED_FIXTURE =
  block(null, '{"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}') +
  block(null, '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":1024}}}') +
  block(null, '[DONE]');

describe('AC8 — round trips are observable as they start', () => {
  it('emits round_trip_start BEFORE adapter.complete() resolves', async () => {
    // A deferred the test resolves by hand: while complete() is pending, the start
    // event must already have fired. This is what "live, not on completion" means.
    let release!: (result: AdapterResult) => void;
    const pending = new Promise<AdapterResult>((resolve) => {
      release = resolve;
    });
    const adapter: AgentAdapter = { complete: () => pending };

    const events: AgentTurnEvent[] = [];
    const turn = runAgentTurn({
      adapter,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      onEvent: (e) => events.push(e),
    });
    await Promise.resolve(); // let runAgentTurn reach the await

    expect(events.map((e) => e.type)).toEqual(['round_trip_start']);
    expect(events[0]).toMatchObject({ type: 'round_trip_start', index: 0 });
    expect(events.some((e) => e.type === 'round_trip')).toBe(false);

    release({ ok: true, text: 'done', toolCalls: [], stopReason: 'end' });
    await turn;

    // …and it still settles to the completed round trip, same index.
    expect(events.map((e) => e.type)).toEqual(['round_trip_start', 'round_trip']);
    expect(events[1]).toMatchObject({ type: 'round_trip', index: 0 });
  });

  it('carries the request as sent on the start event, so the panel can render it live', async () => {
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: mockAdapter([{ text: 'ok' }]),
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'go' }],
      onEvent: (e) => events.push(e),
    });
    const start = events.find((e) => e.type === 'round_trip_start');
    expect(start).toMatchObject({ request: { system: 'SYSTEM', messages: [{ role: 'user', content: 'go' }] } });
  });
});

describe('AC4 — the wire model name is reported, not guessed', () => {
  it('anthropic reports the model from message_start', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, model: 'claude-opus-5' });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe('claude-opus-5');
  });

  it('surfaces the model on the round trip so the UI never has to infer it', async () => {
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: {
        complete: async () => ({ ok: true, text: 'x', toolCalls: [], stopReason: 'end', model: 'claude-opus-5' }),
      },
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      onEvent: (e) => events.push(e),
    });
    const done = events.find((e) => e.type === 'round_trip');
    expect(done).toMatchObject({ response: { model: 'claude-opus-5' } });
  });
});

describe('AC12/AC13 — prompt caching on the stable prefix', () => {
  it('puts cache_control on the LAST system block and nowhere else (tools+system prefix)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, cache: true });
    await adapter.complete({
      system: 'STABLE SYSTEM PROMPT',
      messages: [{ role: 'user', content: 'volatile question' }],
      tools: [TOOL],
    });

    const body = calls[0]!.bodyJson;
    // Render order is tools -> system -> messages; a breakpoint on the last system
    // block caches tools+system together. One breakpoint, on the stable prefix.
    const system = body.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });

    // The volatile tail must NOT carry a breakpoint — that would write a new cache
    // entry per request and never read one.
    const serialized = JSON.stringify(body.messages);
    expect(serialized).not.toContain('cache_control');
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(JSON.stringify(tools)).not.toContain('cache_control');
  });

  it('reports cache-read tokens the provider actually returned (R2: the honest assertion)', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, cache: true });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toMatchObject({
        inputTokens: 12,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 2048,
      });
    }
  });

  it('omits cache fields entirely when the provider did not report caching (absent, not zero)', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(UNCACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toBeDefined();
      expect(result.usage).not.toHaveProperty('cacheReadTokens');
      expect(result.usage).not.toHaveProperty('cacheCreationTokens');
    }
  });

  it('parses OpenAI cached_tokens into the same shape', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(OPENAI_CACHED_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toMatchObject({ cacheReadTokens: 1024 });
  });
});

describe('AC14 — caching is never requested from endpoints that do not support it', () => {
  // The parent task shipped `max_completion_tokens` to local endpoints and broke every
  // local turn. Same failure class: an unknown field on a local/Ollama body is fatal.
  it('sends NO cache_control and no cache field to a local endpoint', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(UNCACHED_FIXTURE));
    const adapter = anthropicAdapter({
      apiKey: 'k',
      fetch: fetchImpl,
      baseUrl: 'http://localhost:11434',
      cache: true, // even when the caller asks, a local endpoint must not receive it
    });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });

    const raw = calls[0]!.init.body as string;
    expect(raw).not.toContain('cache_control');
    // …and `system` stays a plain string on the local path, not the block array form.
    expect(typeof calls[0]!.bodyJson.system).toBe('string');
  });

  it('defaults to no caching when the caller does not opt in', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(UNCACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });
    expect(calls[0]!.init.body as string).not.toContain('cache_control');
  });
});

describe('AC15 — C1 holds at the new seams', () => {
  it('no credential appears in any emitted record, including the model and cache fields', async () => {
    const SECRET = 'sk-ant-super-secret-key';
    const { fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: SECRET, fetch: fetchImpl, cache: true });

    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ def: TOOL, run: () => 'ok' }],
      onEvent: (e) => events.push(e),
    });

    expect(events.length).toBeGreaterThan(0);
    // Every emitted observation — start events, completed round trips, tool events —
    // is serialized and checked. The key must not appear anywhere.
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain('sk-ant');
  });
});
