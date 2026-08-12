// mock.ts — deterministic scripted adapter: powers tests, the offline demo, and the E2E.

import { ERROR_CODES } from '@snugprotocol/protocol';

import type { AdapterResult, AgentAdapter, ToolCall } from './types.js';

export interface MockTurn {
  /** Deltas streamed to onDelta; defaults to `[text]` (or nothing when text is ''). */
  deltas?: string[];
  /** Tool calls requested after the text; ids are generated deterministically. */
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Full text of the turn (callers usually make this deltas.join('')). */
  text: string;
  /** Scripted failure — returned instead of a success result. */
  error?: { code: string; message: string; retryable: boolean };
  /** Script a cap-truncated turn; ignored when the turn carries tool calls. */
  stopReason?: 'max_tokens';
}

/**
 * Scripted adapter: each complete() call consumes the next turn in order, regardless of
 * input. Fully deterministic — tool-call ids are `call_<turn>_<n>`. A call past the end
 * of the script returns a HOST_ERROR result (errors as data, never thrown).
 */
export function mockAdapter(script: readonly MockTurn[]): AgentAdapter {
  let turn = 0;
  return {
    async complete({ onDelta }): Promise<AdapterResult> {
      const current = script[turn];
      if (current === undefined) {
        return {
          ok: false,
          code: ERROR_CODES.HOST_ERROR,
          message: `mock script exhausted after ${script.length} turn(s)`,
          retryable: false,
        };
      }
      turn += 1;
      if (current.error !== undefined) return { ok: false, ...current.error };
      const deltas = current.deltas ?? (current.text === '' ? [] : [current.text]);
      for (const delta of deltas) onDelta?.(delta);
      const toolCalls: ToolCall[] = (current.toolCalls ?? []).map((call, i) => ({
        id: `call_${turn}_${i + 1}`,
        name: call.name,
        input: call.input,
      }));
      return {
        ok: true,
        text: current.text,
        toolCalls,
        stopReason: toolCalls.length > 0 ? 'tool_use' : (current.stopReason ?? 'end'),
      };
    },
  };
}
