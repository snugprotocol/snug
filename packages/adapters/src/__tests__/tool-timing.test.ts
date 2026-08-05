// Phase C of TASK-20260804-observability-caching: per-tool elapsed time, attributed to
// the round trip that REQUESTED the tool (AC5, D0/Q3).
//
// The nesting is a deliberate presentation choice, not a literal containment: the model
// requests tools at the END of round trip N and they execute between N and N+1. So the
// attribution index is the requesting round trip, and the timing seam is the tool
// handler — NOT the LLM call.
import { describe, expect, it } from 'vitest';

import { runAgentTurn, type AgentTurnEvent } from '../agent-turn.js';
import { mockAdapter } from '../mock.js';
import type { AgentTool } from '../agent-turn.js';

/**
 * A controllable clock. `runAgentTurn` measures with `performance.now()`, which fake
 * timers do NOT drive — so the test stubs the clock itself and each tool advances it by
 * a known amount. This keeps the elapsed-time assertions exact instead of the vacuous
 * `toBeGreaterThan(0)` that a wall-clock sleep would force (R4, docs/lessons.md).
 */
function stubClock(): { restore: () => void; advance: (ms: number) => void } {
  const original = globalThis.performance.now;
  let current = 1_000;
  globalThis.performance.now = () => current;
  return {
    advance: (ms: number) => {
      current += ms;
    },
    restore: () => {
      globalThis.performance.now = original;
    },
  };
}

const slowTool = (name: string, ms: number, clock: { advance: (ms: number) => void }): AgentTool => ({
  def: { name, description: 'Slow.', inputSchema: { type: 'object' } },
  run: async () => {
    clock.advance(ms);
    return `${name}:done`;
  },
});

describe('AC5 — tools carry their own elapsed time, nested under the requesting round trip', () => {
  it('reports a duration on tool_result, measured around the handler', async () => {
    const clock = stubClock();
    try {
      const events: AgentTurnEvent[] = [];
      await runAgentTurn({
        adapter: mockAdapter([
          { text: 'Calling.', toolCalls: [{ name: 'slow', input: {} }] },
          { text: ' Done.' },
        ]),
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tools: [slowTool('slow', 250, clock)],
        onEvent: (e) => events.push(e),
      });

      const result = events.find((e) => e.type === 'tool_result');
      expect(result).toBeDefined();
      expect(result).toMatchObject({ type: 'tool_result', durationMs: 250 });
    } finally {
      clock.restore();
    }
  });

  it('attributes each tool to the round-trip index that requested it', async () => {
    // Two round trips, each requesting one tool. Tool from RT0 must be attributed to 0,
    // tool from RT1 to 1 — even though both execute AFTER their requesting call returned.
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: mockAdapter([
        { text: 'first', toolCalls: [{ name: 'a', input: {} }] },
        { text: 'second', toolCalls: [{ name: 'b', input: {} }] },
        { text: 'done' },
      ]),
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { def: { name: 'a', description: '', inputSchema: { type: 'object' } }, run: () => 'a-out' },
        { def: { name: 'b', description: '', inputSchema: { type: 'object' } }, run: () => 'b-out' },
      ],
      onEvent: (e) => events.push(e),
    });

    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(calls).toMatchObject([
      { call: { name: 'a' }, roundTripIndex: 0 },
      { call: { name: 'b' }, roundTripIndex: 1 },
    ]);
    expect(results).toMatchObject([
      { call: { name: 'a' }, roundTripIndex: 0 },
      { call: { name: 'b' }, roundTripIndex: 1 },
    ]);
  });

  it('times each tool independently when one round trip requests several', async () => {
    const clock = stubClock();
    try {
      const events: AgentTurnEvent[] = [];
      await runAgentTurn({
        adapter: mockAdapter([
          { text: 'Calling two.', toolCalls: [{ name: 'quick', input: {} }, { name: 'slow', input: {} }] },
          { text: 'done' },
        ]),
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tools: [slowTool('quick', 10, clock), slowTool('slow', 500, clock)],
        onEvent: (e) => events.push(e),
      });

      const results = events.filter((e) => e.type === 'tool_result');
      // Each tool's own elapsed time — not the total, and not a shared value.
      expect(results).toMatchObject([
        { call: { name: 'quick' }, durationMs: 10, roundTripIndex: 0 },
        { call: { name: 'slow' }, durationMs: 500, roundTripIndex: 0 },
      ]);
    } finally {
      clock.restore();
    }
  });

  it('still times and attributes a tool whose handler throws', async () => {
    // A failing tool is fed back to the model as an error string; its timing is just as
    // interesting as a successful one (often more so), so it must not be dropped.
    const events: AgentTurnEvent[] = [];
    await runAgentTurn({
      adapter: mockAdapter([
        { text: 'Calling.', toolCalls: [{ name: 'boom', input: {} }] },
        { text: 'done' },
      ]),
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          def: { name: 'boom', description: '', inputSchema: { type: 'object' } },
          run: () => {
            throw new Error('tool exploded');
          },
        },
      ],
      onEvent: (e) => events.push(e),
    });

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ roundTripIndex: 0 });
    expect(result).toHaveProperty('durationMs');
    expect((result as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });
});
