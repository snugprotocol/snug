// Phase D of TASK-20260804-observability-caching: the round-trip surface's DATA layer.
//
// Three changes converge here, and AC7 is the load-bearing one:
//   AC6  payloads are kept WHOLE (expanding must show the complete body), so the
//        per-field ingest cap is gone.
//   AC7  which means the memory bound must come from somewhere else — a total-bytes
//        budget with oldest-first eviction. D2 calls this a deliberate weakening of a
//        per-entry cap into a global cap, so the eviction test is load-bearing.
//   AC8  in-flight entries appear as the call starts and settle on completion.
//   AC5  tools nest under the round trip that requested them, each with its own time.
import { describe, expect, it } from 'vitest';

import type { AgentRoundTrip, AgentTurnEvent } from '@snugprotocol/adapters';

import {
  LLM_INSPECTOR_MAX_BYTES,
  LLM_INSPECTOR_MAX_ENTRIES,
  initialLlmInspectorState,
  llmInspectorReduce,
  type LlmInspectorState,
} from '../run/llmInspector.js';

function trip(overrides: Partial<AgentRoundTrip> = {}): AgentRoundTrip {
  return {
    index: 0,
    request: { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
    response: { ok: true, text: 'reply', toolCalls: [], stopReason: 'end' },
    durationMs: 10,
    ...overrides,
  };
}

const feed = (events: Array<AgentTurnEvent | 'reset'>): LlmInspectorState =>
  events.reduce<LlmInspectorState>((state, e) => llmInspectorReduce(state, e), initialLlmInspectorState);

describe('AC8 — in-flight round trips are visible before they resolve', () => {
  it('creates a pending entry on round_trip_start', () => {
    const state = feed([{ type: 'round_trip_start', index: 0, request: { system: 'sys', messages: [] } }]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ index: 0, pending: true });
    // A pending entry has no outcome yet — the UI must not render a duration or stop reason.
    expect(state.entries[0]?.durationMs).toBeUndefined();
    expect(state.entries[0]?.stopReason).toBeUndefined();
  });

  it('settles the SAME entry on completion rather than appending a duplicate', () => {
    const state = feed([
      { type: 'round_trip_start', index: 0, request: { system: 'sys', messages: [] } },
      { type: 'round_trip', ...trip({ index: 0, durationMs: 1234 }) },
    ]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ index: 0, pending: false, durationMs: 1234, text: 'reply' });
  });

  it('shows the request as sent while pending, so the prompt is inspectable mid-call', () => {
    const state = feed([
      {
        type: 'round_trip_start',
        index: 0,
        request: { system: 'LIVE SYSTEM', messages: [{ role: 'user', content: 'live question' }] },
      },
    ]);
    expect(state.entries[0]?.system).toBe('LIVE SYSTEM');
    expect(state.entries[0]?.messages).toEqual([{ role: 'user', content: 'live question' }]);
  });

  it('redacts credentials in a PENDING entry too — C1 does not wait for completion (AC15)', () => {
    const state = feed([
      {
        type: 'round_trip_start',
        index: 0,
        request: { system: 'key sk-ant-secretsecret here', messages: [] },
      },
    ]);
    expect(state.entries[0]?.system).not.toContain('sk-ant-secretsecret');
    expect(state.entries[0]?.system).toContain('«redacted»');
  });

  it('tracks several concurrent-looking round trips by index', () => {
    const state = feed([
      { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
      { type: 'round_trip', ...trip({ index: 0 }) },
      { type: 'round_trip_start', index: 1, request: { system: 's', messages: [] } },
    ]);
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]?.pending).toBe(false);
    expect(state.entries[1]?.pending).toBe(true);
  });
});

describe('AC5 — tools nest under the round trip that requested them', () => {
  it('attaches a tool to its requesting round trip with its own elapsed time', () => {
    const state = feed([
      { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
      { type: 'round_trip', ...trip({ index: 0 }) },
      { type: 'tool_call', call: { id: 't1', name: 'kb_lookup', input: { q: 'x' } }, roundTripIndex: 0 },
      {
        type: 'tool_result',
        call: { id: 't1', name: 'kb_lookup', input: { q: 'x' } },
        output: 'found',
        roundTripIndex: 0,
        durationMs: 42,
      },
    ]);
    expect(state.entries[0]?.tools).toMatchObject([{ name: 'kb_lookup', durationMs: 42, pending: false }]);
  });

  it('shows a tool as pending between its call and its result (AC8 for tools)', () => {
    const state = feed([
      { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
      { type: 'tool_call', call: { id: 't1', name: 'slow_tool', input: {} }, roundTripIndex: 0 },
    ]);
    expect(state.entries[0]?.tools).toMatchObject([{ name: 'slow_tool', pending: true }]);
    expect(state.entries[0]?.tools?.[0]?.durationMs).toBeUndefined();
  });

  it('routes each tool to its OWN round trip, not merely the newest', () => {
    const state = feed([
      { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
      { type: 'round_trip', ...trip({ index: 0 }) },
      { type: 'tool_call', call: { id: 'a', name: 'first', input: {} }, roundTripIndex: 0 },
      { type: 'round_trip_start', index: 1, request: { system: 's', messages: [] } },
      { type: 'tool_call', call: { id: 'b', name: 'second', input: {} }, roundTripIndex: 1 },
      // A late result for round trip 0 must still land on round trip 0.
      {
        type: 'tool_result',
        call: { id: 'a', name: 'first', input: {} },
        output: 'ok',
        roundTripIndex: 0,
        durationMs: 7,
      },
    ]);
    expect(state.entries[0]?.tools).toMatchObject([{ name: 'first', durationMs: 7 }]);
    expect(state.entries[1]?.tools).toMatchObject([{ name: 'second', pending: true }]);
  });

  it('redacts tool input and output — bodies are rendered, so C1 applies (AC15)', () => {
    const state = feed([
      { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
      { type: 'tool_call', call: { id: 't1', name: 'x', input: { token: 'sk-ant-toolsecretvalue' } }, roundTripIndex: 0 },
      {
        type: 'tool_result',
        call: { id: 't1', name: 'x', input: {} },
        output: 'leaked sk-ant-outputsecretvalue',
        roundTripIndex: 0,
        durationMs: 1,
      },
    ]);
    const serialized = JSON.stringify(state.entries[0]?.tools);
    expect(serialized).not.toContain('sk-ant-toolsecretvalue');
    expect(serialized).not.toContain('sk-ant-outputsecretvalue');
  });
});

describe('AC6 — payloads are kept whole so the expanded view is complete', () => {
  it('does NOT truncate a large payload at ingest', () => {
    const huge = `START${'x'.repeat(50_000)}END`;
    const state = feed([{ type: 'round_trip', ...trip({ request: { system: huge, messages: [] } }) }]);
    // The whole body survives — expanding must show the complete payload, not a prefix.
    expect(state.entries[0]?.system).toBe(huge);
    expect(state.entries[0]?.system).not.toContain('truncated');
  });

  it('still redacts credentials buried deep in a large payload', () => {
    // Truncation used to bound the redaction work AND drop late secrets. With payloads
    // kept whole, a key in the tail must still be scrubbed.
    const buried = `${'x'.repeat(50_000)} sk-ant-buriedsecretkey ${'y'.repeat(1000)}`;
    const state = feed([{ type: 'round_trip', ...trip({ request: { system: buried, messages: [] } }) }]);
    expect(state.entries[0]?.system).not.toContain('sk-ant-buriedsecretkey');
    expect(state.entries[0]?.system).toContain('«redacted»');
  });
});

describe('AC7 — the memory bound survives the no-truncation rule', () => {
  it('evicts OLDEST entries once the total-bytes budget is exceeded', () => {
    // The load-bearing test (D2/R1). The parent task's reviewer flagged "60 entries with
    // unbounded per-entry size is unbounded"; with the per-field cap gone, only a global
    // byte budget keeps that true. Each entry here is ~200KB, so a handful blows the budget.
    const bigPayload = 'z'.repeat(500_000);
    const state = Array.from({ length: 40 }).reduce<LlmInspectorState>(
      (acc, _, i) =>
        llmInspectorReduce(acc, {
          type: 'round_trip',
          ...trip({ index: i, request: { system: bigPayload, messages: [] } }),
        }),
      initialLlmInspectorState,
    );

    expect(state.entries.length).toBeLessThan(40); // eviction actually happened
    expect(state.totalBytes).toBeLessThanOrEqual(LLM_INSPECTOR_MAX_BYTES);
    // Newest kept, oldest dropped — a build's most recent activity is what matters.
    expect(state.entries.at(-1)?.index).toBe(39);
    expect(state.entries[0]?.index).toBeGreaterThan(0);
  });

  it('keeps at least the newest entry even when it alone exceeds the budget', () => {
    // A single round trip larger than the whole budget must not evict itself into an
    // empty panel — the user would see nothing at all for the call they just made.
    const monster = 'q'.repeat(LLM_INSPECTOR_MAX_BYTES * 2);
    const state = feed([{ type: 'round_trip', ...trip({ request: { system: monster, messages: [] } }) }]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.system).toBe(monster); // still whole (AC6)
  });

  it('still enforces the entry-count ceiling for many small round trips', () => {
    // The byte budget replaces the per-field cap, not the count cap — small entries must
    // not accumulate without limit either.
    const overflow = LLM_INSPECTOR_MAX_ENTRIES + 25;
    const state = Array.from({ length: overflow }).reduce<LlmInspectorState>(
      (acc, _, i) => llmInspectorReduce(acc, { type: 'round_trip', ...trip({ index: i }) }),
      initialLlmInspectorState,
    );
    expect(state.entries).toHaveLength(LLM_INSPECTOR_MAX_ENTRIES);
    expect(state.entries.at(-1)?.index).toBe(overflow - 1);
  });

  it('drops a pending entry that is evicted, without stranding its tools', () => {
    const bigPayload = 'z'.repeat(500_000);
    let state = feed([{ type: 'round_trip_start', index: 0, request: { system: 'small', messages: [] } }]);
    state = Array.from({ length: 40 }).reduce<LlmInspectorState>(
      (acc, _, i) =>
        llmInspectorReduce(acc, {
          type: 'round_trip',
          ...trip({ index: i + 1, request: { system: bigPayload, messages: [] } }),
        }),
      state,
    );
    // Entry 0 is long gone; a late tool_result for it must be a no-op, not a crash.
    const after = llmInspectorReduce(state, {
      type: 'tool_result',
      call: { id: 'orphan', name: 'x', input: {} },
      output: 'late',
      roundTripIndex: 0,
      durationMs: 5,
    });
    expect(after.entries.some((e) => e.index === 0)).toBe(false);
    expect(after.totalBytes).toBeLessThanOrEqual(LLM_INSPECTOR_MAX_BYTES);
  });
});

describe('AC13 — cache reporting is absent, not zero, when the provider said nothing', () => {
  it('exposes cache tokens when the provider reported them', () => {
    const state = feed([
      {
        type: 'round_trip',
        ...trip({
          response: {
            ok: true,
            text: 't',
            toolCalls: [],
            stopReason: 'end',
            usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheCreationTokens: 0 },
          },
        }),
      },
    ]);
    expect(state.entries[0]?.usage).toMatchObject({ cacheReadTokens: 900 });
  });

  it('leaves cache fields undefined when the provider did not report caching', () => {
    const state = feed([
      {
        type: 'round_trip',
        ...trip({
          response: { ok: true, text: 't', toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 10 } },
        }),
      },
    ]);
    expect(state.entries[0]?.usage?.cacheReadTokens).toBeUndefined();
    expect(state.totalUsage.cacheReadTokens).toBeUndefined();
  });

  it('accumulates cache tokens across round trips for the turn total', () => {
    const withCache = (n: number): AgentRoundTrip =>
      trip({
        response: {
          ok: true,
          text: 't',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: n },
        },
      });
    const state = feed([
      { type: 'round_trip', ...withCache(500) },
      { type: 'round_trip', ...withCache(300) },
    ]);
    expect(state.totalUsage.cacheReadTokens).toBe(800);
  });
});

describe('AC4 — the model name comes from the wire', () => {
  it('records the model the provider reported', () => {
    const state = feed([
      {
        type: 'round_trip',
        ...trip({
          response: { ok: true, text: 't', toolCalls: [], stopReason: 'end', model: 'claude-opus-5' },
        }),
      },
    ]);
    expect(state.entries[0]?.model).toBe('claude-opus-5');
  });

  it('leaves the model undefined rather than guessing when the provider was silent', () => {
    const state = feed([{ type: 'round_trip', ...trip() }]);
    expect(state.entries[0]?.model).toBeUndefined();
  });
});
