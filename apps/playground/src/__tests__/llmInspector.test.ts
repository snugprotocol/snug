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

// The reducer takes the whole AgentTurnEvent union now (it also renders in-flight calls
// and nested tools), so a completed round trip is fed as a tagged `round_trip` event.
// Every assertion below is unchanged.
const feed = (trips: AgentRoundTrip[]): LlmInspectorState =>
  trips.reduce(
    (state, trip) => llmInspectorReduce(state, { type: 'round_trip', ...trip }),
    initialLlmInspectorState as LlmInspectorState,
  );

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

  it('also masks non-provider secrets a user might paste into a prompt (defence in depth)', () => {
    // The host only ever handles anthropic/openai BYOK keys, and those ride in an HTTP
    // header the inspector never sees. These shapes can still reach it the moment a user
    // pastes one into chat — and this panel renders bodies verbatim.
    const secrets = [
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234',
      'AKIAIOSFODNN7EXAMPLE',
      'Basic dXNlcjpwYXNzd29yZA==',
      'Bearer abcdefghijklmnopqrstuvwx',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyAbCdEfGhIjKlMnOpQrStUvWx',
    ];
    for (const secret of secrets) {
      const state = feed([roundTrip({ request: { system: `auth ${secret}`, messages: [{ role: 'user', content: secret }] } })]);
      expect(JSON.stringify(state.entries), `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('masks the VALUE of a key/value secret pair but keeps the key NAME readable', () => {
    const state = feed([
      roundTrip({
        request: { system: 'x-api-key: abcdef1234567890abcdef', messages: [{ role: 'user', content: '"apiKey": "s3cret-value-here-9999"' }] },
      }),
    ]);
    const rendered = JSON.stringify(state.entries);
    expect(rendered).not.toContain('abcdef1234567890abcdef');
    expect(rendered).not.toContain('s3cret-value-here-9999');
    // The shape of the request must survive redaction — otherwise the panel is useless.
    expect(rendered).toContain('x-api-key');
    expect(rendered).toContain('apiKey');
  });

  it('redacts through every path a secret can arrive by (tool results, errors, nested inputs)', () => {
    const key = 'sk-ant-api03-EveryPathKey1234567';
    const viaToolResult = feed([
      roundTrip({ request: { system: 'x', messages: [{ role: 'tool', toolCallId: 't1', content: `result ${key}` }] } }),
    ]);
    expect(JSON.stringify(viaToolResult.entries)).not.toContain(key);

    const viaError = feed([
      roundTrip({ response: { ok: false, code: 'AUTH', message: `rejected ${key}`, retryable: false, partialText: `wrote ${key}` } }),
    ]);
    expect(JSON.stringify(viaError.entries)).not.toContain(key);

    const viaNestedInput = feed([
      roundTrip({
        response: {
          ok: true,
          text: '',
          toolCalls: [{ id: 'c1', name: 'schema_apply', input: { deep: { nested: [{ credential: key }] } } }],
          stopReason: 'tool_use',
        },
      }),
    ]);
    expect(JSON.stringify(viaNestedInput.entries)).not.toContain(key);
  });

  it('resets between turns without leaking the previous turn (AC14)', () => {
    const state = feed([roundTrip(), roundTrip({ index: 1 })]);
    const cleared = llmInspectorReduce(state, 'reset');
    expect(cleared.entries).toHaveLength(0);
    expect(cleared.totalDurationMs).toBe(0);
    expect(cleared.totalUsage).toEqual({});
  });
});
