// capToolCalls.test.ts — TASK-20261010-host-broker PR-4 (AC32a; contract v2 D-PR4-14, D-PR4-15).
//
// `capToolCalls(tools, max)` lives beside `buildDataTools` (`agent/dataTools.ts`) and is how the
// scheduled agent bounds its tool loop: ONE counter shared by every tool it wraps, so eight
// `data_query` calls and one `fetch_connection` call are nine calls, not eight and one. A call past
// the cap never reaches its tool and answers the contract's sentence, which the model reads as a
// tool result:
//
//   Error: this run may make at most <max> tool calls — answer now with what you have
//
// Without a cap the function is the identity — the SAME array, so a caller that passes no cap
// (the chat) offers exactly the tools it built.
//
// RED until `capToolCalls` is exported from `agent/dataTools.ts` (the import resolves to
// `undefined` before then, and every row calling it throws).

import { mockAdapter, runAgentTurn, type AgentTool } from '@snugprotocol/adapters';
import { APP_AGENT_MAX_TOOL_CALLS } from '@snugprotocol/protocol';
import { describe, expect, it, vi } from 'vitest';

import { capToolCalls } from '../agent/dataTools.js';

/** The contract's sentence for a cap of `max` — byte for byte (D-PR4-14). */
const capSentence = (max: number): string => `Error: this run may make at most ${max} tool calls — answer now with what you have`;

/** A tool that answers `<name>:<n>` and records every input it ran with. */
function recordingTool(name: string): AgentTool & { runs: Array<Record<string, unknown>> } {
  const runs: Array<Record<string, unknown>> = [];
  return {
    runs,
    def: { name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: {} } },
    run: (input) => {
      runs.push(input);
      return `${name}:${runs.length}`;
    },
  };
}

describe('capToolCalls — no cap is the identity', () => {
  it('without a cap the SAME array comes back — nothing is wrapped', () => {
    const tools = [recordingTool('a'), recordingTool('b')];
    expect(capToolCalls(tools)).toBe(tools);
  });

  it('an explicit `undefined` cap is the identity too', () => {
    const tools = [recordingTool('a')];
    expect(capToolCalls(tools, undefined)).toBe(tools);
  });
});

describe('capToolCalls — one counter shared across every tool', () => {
  it('keeps each tool’s definition, in order (the model is offered exactly the same tools)', () => {
    const a = recordingTool('a');
    const b = recordingTool('b');
    const capped = capToolCalls([a, b], 3);
    expect(capped.map((tool) => tool.def)).toEqual([a.def, b.def]);
    expect(capped.map((tool) => tool.def.name)).toEqual(['a', 'b']);
  });

  it('calls up to the cap reach their tools and answer what the tool answered', async () => {
    const a = recordingTool('a');
    const b = recordingTool('b');
    const [ca, cb] = capToolCalls([a, b], 3);
    expect(await ca!.run({ n: 1 })).toBe('a:1');
    expect(await cb!.run({ n: 2 })).toBe('b:1');
    expect(await ca!.run({ n: 3 })).toBe('a:2');
    expect(a.runs).toEqual([{ n: 1 }, { n: 3 }]);
    expect(b.runs).toEqual([{ n: 2 }]);
  });

  it('the call past the cap — on ANY tool — answers the sentence and never reaches the tool', async () => {
    const a = recordingTool('a');
    const b = recordingTool('b');
    const [ca, cb] = capToolCalls([a, b], 3);
    await ca!.run({});
    await ca!.run({});
    await ca!.run({});
    // The fourth call is on the OTHER tool: the counter is shared, so it is still the fourth.
    expect(await cb!.run({ n: 4 })).toBe(capSentence(3));
    expect(await ca!.run({ n: 5 })).toBe(capSentence(3));
    expect(b.runs).toEqual([]);
    expect(a.runs).toHaveLength(3);
  });

  it('a call whose tool throws still counts — the counter is the attempt, not the success', async () => {
    const boom: AgentTool = {
      def: { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
      run: vi.fn(() => {
        throw new Error('no');
      }),
    };
    const ok = recordingTool('ok');
    const [cboom, cok] = capToolCalls([boom, ok], 1);
    await expect(Promise.resolve().then(() => cboom!.run({}))).rejects.toThrow('no');
    expect(await cok!.run({})).toBe(capSentence(1));
    expect(ok.runs).toEqual([]);
  });

  it('two wrappings are two counters — a cap is per call of capToolCalls (one per run)', async () => {
    const a = recordingTool('a');
    const [first] = capToolCalls([a], 1);
    const [second] = capToolCalls([a], 1);
    expect(await first!.run({})).toBe('a:1');
    expect(await second!.run({})).toBe('a:2');
    expect(await first!.run({})).toBe(capSentence(1));
  });
});

describe('capToolCalls — the scheduled agent’s cap (APP_AGENT_MAX_TOOL_CALLS = 8), through the real tool loop', () => {
  it('the constant is 8', () => {
    expect(APP_AGENT_MAX_TOOL_CALLS).toBe(8);
  });

  it('nine calls in one round trip: eight reach the tool, the ninth is the model’s tool result reading the sentence', async () => {
    const lookup = recordingTool('lookup');
    const results: string[] = [];
    const adapter = mockAdapter([
      { text: '', toolCalls: Array.from({ length: 9 }, (_, i) => ({ name: 'lookup', input: { i } })) },
      { text: 'done with what I had' },
    ]);
    const result = await runAgentTurn({
      adapter,
      system: 'test',
      messages: [{ role: 'user', content: 'go' }],
      tools: capToolCalls([lookup], 8),
      onEvent: (event) => {
        if (event.type === 'tool_result') results.push(event.output);
      },
    });
    expect(result).toEqual({ ok: true, text: 'done with what I had', stopReason: 'end' });
    expect(lookup.runs).toHaveLength(8);
    expect(results).toHaveLength(9);
    expect(results.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => `lookup:${i + 1}`));
    expect(results[8]).toBe(capSentence(8));
  });
});
