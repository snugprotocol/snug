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

// TASK-20260813 AC7 — every started round trip must be CLOSED.
//
// The reported bug: "sometimes the inspector timer keeps running after the call is
// done and it moves on to the next one." The inspector renders a live ticker for any
// entry with `pending: true`, and an entry becomes pending on `round_trip_start` and
// settles on `round_trip`. `runAgentTurn` awaited `adapter.complete()` with no
// try/catch, so a REJECTED call skipped the `round_trip` emit entirely and left that
// entry pending forever — ticking under the next call, exactly as described.
//
// This is not hypothetical: the webllm adapter throws on its function-calling path,
// and an aborted turn rejects with an AbortError. The mock/HTTP adapters return
// `ok:false` instead, which is why the happy-path suites never caught it.
//
// Asserted at the ADAPTERS altitude, not at the panel: this is where the decision to
// emit is made (docs/lessons.md 2026-08-05, "test where the DECISION is made").
describe('AC7 — a started round trip is always closed, even when the call throws', () => {
  const boom = (error: unknown): AgentAdapter => ({
    complete: () => Promise.reject(error),
  });

  it('emits a terminal round_trip when adapter.complete() rejects', async () => {
    const events: AgentTurnEvent[] = [];
    await expect(
      runAgentTurn({
        adapter: boom(new Error('webllm exploded')),
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        onEvent: (e) => events.push(e),
      }),
    ).resolves.toMatchObject({ ok: false });

    // The pair must balance. A start with no matching round_trip is the stuck timer.
    const starts = events.filter((e) => e.type === 'round_trip_start');
    const ends = events.filter((e) => e.type === 'round_trip');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ index: 0, response: { ok: false } });
  });

  it('reports the thrown message rather than swallowing it into a blank error', async () => {
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: boom(new Error('webllm exploded')),
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      onEvent: (e) => events.push(e),
    });
    const end = events.find((e) => e.type === 'round_trip');
    // The inspector renders this string; "[object Object]" or "" would make a real
    // failure unreadable in the one surface built to explain it.
    expect(end).toMatchObject({ response: { ok: false, message: expect.stringContaining('webllm exploded') } });
  });

  it('closes the round trip when the turn is aborted mid-call', async () => {
    // An abort rejects the in-flight completion. The entry must still settle, or the
    // timer keeps running under a turn the user deliberately stopped.
    const controller = new AbortController();
    const adapter: AgentAdapter = {
      complete: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    };

    const events: AgentTurnEvent[] = [];
    const turn = runAgentTurn({
      adapter,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    await Promise.resolve();
    controller.abort();
    await turn;

    expect(events.filter((e) => e.type === 'round_trip_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'round_trip')).toHaveLength(1);
  });

  it('still carries a duration, so the settled entry shows a real elapsed figure', async () => {
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: boom(new Error('nope')),
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      onEvent: (e) => events.push(e),
    });
    const end = events.find((e) => e.type === 'round_trip');
    // Not `toBeGreaterThan(0)` — a rejection can land inside the same millisecond, and
    // a flaky guard is worse than a loose one. The field must simply be a real number,
    // because the panel renders it in place of the live ticker.
    expect(end).toBeDefined();
    expect(typeof (end as { durationMs: number }).durationMs).toBe('number');
    expect(Number.isFinite((end as { durationMs: number }).durationMs)).toBe(true);
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
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    await adapter.complete({
      system: 'STABLE SYSTEM PROMPT',
      messages: [{ role: 'user', content: 'volatile question' }],
      tools: [TOOL],
      cache: true,
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
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [TOOL],
      cache: true,
    });
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
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, baseUrl: 'http://localhost:11434' });
    // Even when the caller asks, a local endpoint must not receive it.
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL], cache: true });

    const raw = calls[0]!.init.body as string;
    expect(raw).not.toContain('cache_control');
    // …and `system` stays a plain string on the local path, not the block array form.
    expect(typeof calls[0]!.bodyJson.system).toBe('string');
  });

  it('caches or not PER TURN on the same adapter instance (AC12 scope)', async () => {
    // One adapter, two turns. The hub builds a single adapter that serves both the
    // builder path and the app-frame path, so an adapter-level opt-in could not express
    // AC12's scope — it would cache the app-frame envelopes D0/Q2 excludes.
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 'builder prompt', messages: [{ role: 'user', content: 'build' }], cache: true });
    await adapter.complete({ system: 'app-frame prompt', messages: [{ role: 'user', content: '{"action":"move"}' }] });

    expect(JSON.stringify(calls[0]!.bodyJson)).toContain('cache_control');
    expect(JSON.stringify(calls[1]!.bodyJson)).not.toContain('cache_control');
  });

  it('defaults to no caching when the caller does not opt in', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(UNCACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });
    expect(calls[0]!.init.body as string).not.toContain('cache_control');
  });

  // TASK-20260805-doctrines-devex: the host gate must be EXACT, not a suffix match.
  // `endsWith('api.anthropic.com')` also matches sibling domains like
  // `notapi.anthropic.com` — an OpenAI-compatible proxy there would receive
  // `cache_control` as an unknown field (the fatal-on-local failure class above).
  // Unreachable today (no config surface exposes baseUrl) but it must be exact
  // BEFORE one does.
  it('treats a sibling domain (notapi.anthropic.com) as NOT supporting caching', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(UNCACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, baseUrl: 'https://notapi.anthropic.com' });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL], cache: true });

    expect(calls[0]!.init.body as string).not.toContain('cache_control');
    expect(typeof calls[0]!.bodyJson.system).toBe('string');
  });

  it('still caches on the exact Anthropic host with a non-default port (hostname gate, port-insensitive)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, baseUrl: 'https://api.anthropic.com:8443' });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL], cache: true });

    expect(JSON.stringify(calls[0]!.bodyJson)).toContain('cache_control');
  });
});

describe('AC15 — C1 holds at the new seams', () => {
  it('no credential appears in any emitted record, including the model and cache fields', async () => {
    const SECRET = 'sk-ant-super-secret-key';
    const { fetchImpl } = fakeFetch(() => sseResponse(CACHED_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: SECRET, fetch: fetchImpl });

    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ def: TOOL, run: () => 'ok' }],
      cache: true,
      onEvent: (e) => events.push(e),
    });

    expect(events.length).toBeGreaterThan(0);
    // Every emitted observation — start events, completed round trips, tool events —
    // is serialized and checked. The key must not appear anywhere.
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain('sk-ant');
  });
});
