import { describe, expect, it } from 'vitest';

import { mockAdapter, type MockTurn } from '../mock.js';

const SCRIPT: MockTurn[] = [
  {
    deltas: ['Buil', 'ding'],
    text: 'Building',
    toolCalls: [{ name: 'artifact_write', input: { content: '<p>hi</p>' } }],
  },
  { text: 'Done!' },
];

describe('mockAdapter', () => {
  it('streams scripted deltas and returns the turn text and tool calls', async () => {
    const adapter = mockAdapter(SCRIPT);
    const deltas: string[] = [];
    const first = await adapter.complete({ system: '', messages: [], onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(['Buil', 'ding']);
    expect(first).toEqual({
      ok: true,
      text: 'Building',
      toolCalls: [{ id: 'call_1_1', name: 'artifact_write', input: { content: '<p>hi</p>' } }],
      stopReason: 'tool_use',
    });
    const second = await adapter.complete({ system: '', messages: [] });
    expect(second).toEqual({ ok: true, text: 'Done!', toolCalls: [], stopReason: 'end' });
  });

  it('is deterministic: two instances of the same script produce identical results', async () => {
    const a = mockAdapter(SCRIPT);
    const b = mockAdapter(SCRIPT);
    expect(await a.complete({ system: '', messages: [] })).toEqual(await b.complete({ system: '', messages: [] }));
    expect(await a.complete({ system: '', messages: [] })).toEqual(await b.complete({ system: '', messages: [] }));
  });

  it('streams text as a single delta when deltas are not scripted', async () => {
    const adapter = mockAdapter([{ text: 'hello' }]);
    const deltas: string[] = [];
    await adapter.complete({ system: '', messages: [], onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(['hello']);
  });

  it('returns an error result (never throws) when the script is exhausted', async () => {
    const adapter = mockAdapter([]);
    const result = await adapter.complete({ system: '', messages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('HOST_ERROR');
      expect(result.retryable).toBe(false);
    }
  });

  it('plays scripted error turns as error results', async () => {
    const adapter = mockAdapter([{ text: '', error: { code: 'NETWORK_ERROR', message: 'down', retryable: true } }]);
    expect(await adapter.complete({ system: '', messages: [] })).toEqual({
      ok: false,
      code: 'NETWORK_ERROR',
      message: 'down',
      retryable: true,
    });
  });
});
