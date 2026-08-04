// agent-turn.ts — THE single choke point through which any provider is called
// (task contract: no other module touches an adapter). Runs the system prompt +
// message history + tool-dispatch loop; with no tools it is JSON-only mode.

import { ERROR_CODES } from '@snugprotocol/protocol';

import type {
  AdapterError,
  AdapterMessage,
  AdapterResult,
  AgentAdapter,
  ToolCall,
  ToolDef,
} from './types.js';

export interface AgentTool {
  def: ToolDef;
  /** Tool execution; a thrown error is fed back to the model as an error string. */
  run: (input: Record<string, unknown>) => string | Promise<string>;
}

/**
 * One completed adapter round-trip — the observation the LLM inspector renders.
 * Emitted per iteration with the request AS SENT and the result AS RECEIVED. Purely
 * an observation channel: nothing here is persisted (TASK-20260803-hub-ops).
 */
export interface AgentRoundTrip {
  /** 0-based iteration index within this turn. */
  index: number;
  request: { system: string; messages: AdapterMessage[]; tools?: ToolDef[] };
  response: AdapterResult;
  durationMs: number;
}

export type AgentTurnEvent =
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; output: string }
  | ({ type: 'round_trip' } & AgentRoundTrip);

export interface RunAgentTurnOptions {
  adapter: AgentAdapter;
  system: string;
  messages: AdapterMessage[];
  /** Omitted/empty ⇒ JSON-only mode: the adapter receives NO tools. */
  tools?: AgentTool[];
  /** Cap on adapter round-trips (default 6); exceeding it is a terminal error result. */
  maxIterations?: number;
  signal?: AbortSignal;
  /** Streamed deltas from every iteration, in order — callers accumulate. */
  onDelta?: (delta: string) => void;
  onEvent?: (event: AgentTurnEvent) => void;
}

export type AgentTurnResult = { ok: true; text: string } | AdapterError;

/**
 * Cap on adapter round-trips per turn — a runaway-loop backstop, NOT a task budget.
 *
 * This was 6, which a real data-backed app build reaches on its own (KB consult ×2 ->
 * schema_apply -> artifact_write -> app_doc_write -> sign-off): builds died on the cap
 * with a terminal error, which is the "long builds silently drop" report. A ceiling that
 * a legitimate build can reach is a cliff, not a backstop — so it now sits far above any
 * real build while still bounding an infinite tool loop.
 */
export const DEFAULT_MAX_ITERATIONS = 48;

/**
 * Run one agent turn to completion. Returns the concatenation of all assistant text
 * across iterations — exactly what was streamed through onDelta, so host-side delta
 * accumulation and the final text agree.
 */
export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const { adapter, system, signal, onDelta, onEvent } = options;
  const tools = options.tools ?? [];
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const defs = tools.length > 0 ? tools.map((tool) => tool.def) : undefined;
  const conversation: AdapterMessage[] = [...options.messages];
  let text = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Snapshot the request as sent — the inspector renders this, and `conversation`
    // keeps growing, so a live reference would show the wrong thing later.
    const request = { system, messages: [...conversation], ...(defs !== undefined ? { tools: defs } : {}) };
    const startedAt = now();
    const result = await adapter.complete({ system, messages: conversation, tools: defs, signal, onDelta });
    onEvent?.({ type: 'round_trip', index: iteration, request, response: result, durationMs: now() - startedAt });
    if (!result.ok) {
      // Text from EARLIER completed iterations is real work — a drop on iteration N
      // must not discard what iterations 0..N-1 already streamed.
      const partial = `${text}${result.partialText ?? ''}`;
      return partial === '' ? result : { ...result, partialText: partial };
    }
    text += result.text;
    if (result.toolCalls.length === 0) return { ok: true, text };

    conversation.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      onEvent?.({ type: 'tool_call', call });
      const output = await dispatch(tools, call);
      onEvent?.({ type: 'tool_result', call, output });
      conversation.push({ role: 'tool', toolCallId: call.id, content: output });
    }
  }

  return {
    ok: false,
    code: ERROR_CODES.HOST_ERROR,
    message: `tool loop exceeded ${maxIterations} iterations without a final reply`,
    retryable: false,
    ...(text !== '' ? { partialText: text } : {}),
  };
}

/** Monotonic where available (browser + node), wall-clock elsewhere. Observation only. */
function now(): number {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

/** Tool errors are data fed back to the model — a bad tool call must not kill the turn. */
async function dispatch(tools: AgentTool[], call: ToolCall): Promise<string> {
  const tool = tools.find((candidate) => candidate.def.name === call.name);
  if (tool === undefined) return `Error: unknown tool "${call.name}"`;
  try {
    return await tool.run(call.input);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
