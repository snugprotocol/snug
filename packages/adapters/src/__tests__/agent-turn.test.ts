import { describe, expect, it } from 'vitest';

import { runAgentTurn, type AgentTool, type AgentTurnEvent } from '../agent-turn.js';
import { mockAdapter } from '../mock.js';
import type { AdapterRequest, AgentAdapter } from '../types.js';

function spyAdapter(inner: AgentAdapter): { calls: AdapterRequest[]; adapter: AgentAdapter } {
  const calls: AdapterRequest[] = [];
  return {
    calls,
    adapter: {
      complete(request) {
        calls.push({ ...request, messages: structuredClone(request.messages) });
        return inner.complete(request);
      },
    },
  };
}

const echoTool: AgentTool = {
  def: { name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' } },
  run: (input) => `echoed:${String(input.value)}`,
};

describe('runAgentTurn', () => {
  it('round-trips tool calls: result fed back as a tool message, final text returned', async () => {
    const { calls, adapter } = spyAdapter(
      mockAdapter([
        { text: 'Calling.', toolCalls: [{ name: 'echo', input: { value: 42 } }] },
        { text: ' Done.' },
      ]),
    );
    const events: AgentTurnEvent[] = [];
    const deltas: string[] = [];
    const result = await runAgentTurn({
      adapter,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [echoTool],
      onDelta: (d) => deltas.push(d),
      onEvent: (e) => events.push(e),
    });
    expect(result).toEqual({ ok: true, text: 'Calling. Done.' });
    expect(deltas.join('')).toBe('Calling. Done.'); // done text === accumulated deltas
    // Tool events unchanged; `round_trip` observations are interleaved (see long-run.test.ts).
    expect(events.filter((e) => e.type !== 'round_trip')).toEqual([
      { type: 'tool_call', call: { id: 'call_1_1', name: 'echo', input: { value: 42 } } },
      { type: 'tool_result', call: { id: 'call_1_1', name: 'echo', input: { value: 42 } }, output: 'echoed:42' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Calling.', toolCalls: [{ id: 'call_1_1', name: 'echo', input: { value: 42 } }] },
      { role: 'tool', toolCallId: 'call_1_1', content: 'echoed:42' },
    ]);
  });

  it('JSON-only mode: no tools option means the adapter receives tools: undefined', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"ok":true}' }]));
    const result = await runAgentTurn({ adapter, system: 'sys', messages: [{ role: 'user', content: 'go' }] });
    expect(result).toEqual({ ok: true, text: '{"ok":true}' });
    expect(calls[0]!.tools).toBeUndefined();
  });

  it('an empty tools array is also JSON-only mode', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'x' }]));
    await runAgentTurn({ adapter, system: 'sys', messages: [{ role: 'user', content: 'go' }], tools: [] });
    expect(calls[0]!.tools).toBeUndefined();
  });

  it('caps the loop at maxIterations and returns a terminal error result', async () => {
    const looping = mockAdapter(
      Array.from({ length: 10 }, () => ({ text: '', toolCalls: [{ name: 'echo', input: { value: 1 } }] })),
    );
    const { calls, adapter } = spyAdapter(looping);
    const result = await runAgentTurn({
      adapter,
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [echoTool],
      maxIterations: 2,
    });
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR', retryable: false });
    expect(calls).toHaveLength(2);
  });

  it('feeds an error string back to the model for unknown tools and for tools that throw', async () => {
    const throwing: AgentTool = {
      def: { name: 'boom', description: 'Throws.', inputSchema: { type: 'object' } },
      run: () => {
        throw new Error('kaput');
      },
    };
    const { calls, adapter } = spyAdapter(
      mockAdapter([
        { text: '', toolCalls: [{ name: 'missing', input: {} }, { name: 'boom', input: {} }] },
        { text: 'recovered' },
      ]),
    );
    const result = await runAgentTurn({
      adapter,
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [throwing],
    });
    expect(result).toEqual({ ok: true, text: 'recovered' });
    const toolMessages = calls[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toEqual([
      { role: 'tool', toolCallId: 'call_1_1', content: 'Error: unknown tool "missing"' },
      { role: 'tool', toolCallId: 'call_1_2', content: 'Error: kaput' },
    ]);
  });

  it('propagates adapter error results as data', async () => {
    const adapter = mockAdapter([{ text: '', error: { code: 'NETWORK_ERROR', message: 'down', retryable: true } }]);
    const result = await runAgentTurn({ adapter, system: 's', messages: [{ role: 'user', content: 'go' }] });
    expect(result).toEqual({ ok: false, code: 'NETWORK_ERROR', message: 'down', retryable: true });
  });
});
