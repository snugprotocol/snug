// llmInspector.test.ts — the LLM round-trip inspector (TASK-20260803-hub-ops AC13-15).
//
// This surface is the OPPOSITE of run/inspector.ts: it deliberately renders request
// and response BODIES (that is the point — "what did we actually send the model?").
// Its guarantees are therefore different and are pinned here:
//   AC13 — per-round-trip request/response/usage/duration are captured.
//   AC14 — in-memory only + bounded (ring buffer); nothing is persisted.
//   AC15 — a BYOK key must NEVER appear, even though bodies ARE rendered.

import { describe, expect, it } from 'vitest';

import {
  initialLlmInspectorState,
  llmInspectorReduce,
  type LlmInspectorState,
  LLM_INSPECTOR_MAX_ENTRIES,
} from '../run/llmInspector.js';
import type { AgentRoundTrip } from '@snugprotocol/adapters';

const roundTrip = (overrides: Partial<AgentRoundTrip> = {}): AgentRoundTrip => ({
  index: 0,
  request: {
    system: 'you are the app builder',
    messages: [{ role: 'user', content: 'build me a chess app' }],
    tools: [{ name: 'artifact_write', description: 'write the app', inputSchema: { type: 'object' } }],
  },
  response: {
    ok: true,
    text: 'on it',
    toolCalls: [{ id: 'call-1', name: 'artifact_write', input: { html: '<html></html>' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 1200, outputTokens: 340 },
  },
  durationMs: 4200,
  ...overrides,
});

const feed = (trips: AgentRoundTrip[]): LlmInspectorState =>
  trips.reduce((state, trip) => llmInspectorReduce(state, trip), initialLlmInspectorState as LlmInspectorState);

describe('llmInspector', () => {
  it('captures request, response, usage and duration per round trip (AC13)', () => {
    const state = feed([roundTrip()]);
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0]!;
    expect(entry.index).toBe(0);
    expect(entry.system).toContain('app builder');
    expect(entry.messages).toHaveLength(1);
    expect(entry.toolNames).toEqual(['artifact_write']);
    expect(entry.text).toBe('on it');
    expect(entry.stopReason).toBe('tool_use');
    expect(entry.toolCalls).toEqual([{ id: 'call-1', name: 'artifact_write', input: { html: '<html></html>' } }]);
    expect(entry.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(entry.durationMs).toBe(4200);
    expect(entry.isError).toBe(false);
  });

  it('records a failed round trip as an error entry carrying its partial text (AC13)', () => {
    const state = feed([
      roundTrip({
        response: { ok: false, code: 'STREAM_DROPPED', message: 'the stream dropped', retryable: true, partialText: 'half a thought' },
      }),
    ]);
    const entry = state.entries[0]!;
    expect(entry.isError).toBe(true);
    expect(entry.code).toBe('STREAM_DROPPED');
    expect(entry.text).toBe('half a thought');
    expect(entry.stopReason).toBeUndefined();
  });

  it('keeps round trips in arrival order with a running turn total (AC13)', () => {
    const state = feed([roundTrip({ index: 0 }), roundTrip({ index: 1, durationMs: 800 }), roundTrip({ index: 2, durationMs: 200 })]);
    expect(state.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(state.totalDurationMs).toBe(4200 + 800 + 200);
    expect(state.totalUsage).toEqual({ inputTokens: 3600, outputTokens: 1020 });
  });

  it('is bounded by a ring buffer so a 30-minute build cannot exhaust memory (AC14)', () => {
    const overflow = LLM_INSPECTOR_MAX_ENTRIES + 25;
    const state = feed(Array.from({ length: overflow }, (_, index) => roundTrip({ index })));
    expect(state.entries).toHaveLength(LLM_INSPECTOR_MAX_ENTRIES);
    // The OLDEST are dropped; the most recent round trip is always present.
    expect(state.entries.at(-1)?.index).toBe(overflow - 1);
    expect(state.entries[0]?.index).toBe(overflow - LLM_INSPECTOR_MAX_ENTRIES);
  });

  it('never renders a BYOK key even though it renders request bodies (AC15)', () => {
    const KEY = 'sk-ant-secret-byok-key-do-not-render';
    const state = feed([
      roundTrip({
        request: {
          system: `you are the app builder. authorization: Bearer ${KEY}`,
          messages: [
            { role: 'user', content: `here is my key ${KEY}` },
            { role: 'assistant', content: 'ok', toolCalls: [{ id: 'c1', name: 'artifact_write', input: { apiKey: KEY } }] },
            { role: 'tool', toolCallId: 'c1', content: `wrote with ${KEY}` },
          ],
          tools: [{ name: 'artifact_write', description: `pass ${KEY}`, inputSchema: { type: 'object' } }],
        },
        response: {
          ok: true,
          text: `used ${KEY}`,
          toolCalls: [{ id: 'c2', name: 'artifact_write', input: { key: KEY } }],
          stopReason: 'end',
        },
      }),
    ]);
    expect(JSON.stringify(state.entries)).not.toContain(KEY);
    // Redaction must not silently blank the surface — the body is still there.
    expect(JSON.stringify(state.entries)).toContain('app builder');
  });

  it('redacts every known BYOK key shape wherever it appears (AC15)', () => {
    const keys = ['sk-ant-api03-abcdefghijklmnop', 'sk-proj-abcdefghijklmnopqrst', 'sk-abcdefghijklmnopqrstuvwx'];
    for (const key of keys) {
      const state = feed([roundTrip({ request: { system: `key=${key}`, messages: [{ role: 'user', content: key }] } })]);
      expect(JSON.stringify(state.entries)).not.toContain(key);
    }
  });

  it('resets between turns without leaking the previous turn (AC14)', () => {
    const state = feed([roundTrip(), roundTrip({ index: 1 })]);
    const cleared = llmInspectorReduce(state, 'reset');
    expect(cleared.entries).toHaveLength(0);
    expect(cleared.totalDurationMs).toBe(0);
    expect(cleared.totalUsage).toEqual({});
  });
});
