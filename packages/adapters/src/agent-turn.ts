// agent-turn.ts — THE single choke point through which any provider is called
// (task contract: no other module touches an adapter). Runs the system prompt +
// message history + tool-dispatch loop; with no tools it is JSON-only mode.

import { ERROR_CODES } from '@snugprotocol/protocol';

import type {
  AdapterError,
  AdapterMessage,
  AgentAdapter,
  ToolCall,
  ToolDef,
} from './types.js';

export interface AgentTool {
  def: ToolDef;
  /** Tool execution; a thrown error is fed back to the model as an error string. */
  run: (input: Record<string, unknown>) => string | Promise<string>;
}

export type AgentTurnEvent =
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; output: string };

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

export const DEFAULT_MAX_ITERATIONS = 6;

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
    const result = await adapter.complete({ system, messages: conversation, tools: defs, signal, onDelta });
    if (!result.ok) return result;
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
  };
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
