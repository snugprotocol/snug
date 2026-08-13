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
  request: { system: string; messages: AdapterMessage[]; tools?: ToolDef[]; maxOutputTokens?: number };
  response: AdapterResult;
  durationMs: number;
}

/**
 * A round trip that has STARTED but not returned. Emitted before `adapter.complete()`
 * is awaited, so the surface can show the call in flight with a live timer instead of
 * nothing at all until it finishes (AC8). Carries the request as sent; the response and
 * duration arrive later on the matching `round_trip`, correlated by `index`.
 */
export interface AgentRoundTripStart {
  index: number;
  request: { system: string; messages: AdapterMessage[]; tools?: ToolDef[]; maxOutputTokens?: number };
}

export type AgentTurnEvent =
  /**
   * `roundTripIndex` is the round trip that REQUESTED the tool. Note this is not literal
   * containment: the model requests tools at the end of round trip N, and they execute
   * between N and N+1. Attributing them to N is a deliberate presentation choice so the
   * UI can nest tools under the call that asked for them (D0/Q3).
   */
  | { type: 'tool_call'; call: ToolCall; roundTripIndex: number }
  /** `durationMs` brackets the TOOL HANDLER, not the LLM call. */
  | { type: 'tool_result'; call: ToolCall; output: string; roundTripIndex: number; durationMs: number }
  | ({ type: 'round_trip_start' } & AgentRoundTripStart)
  | ({ type: 'round_trip' } & AgentRoundTrip);

export interface RunAgentTurnOptions {
  adapter: AgentAdapter;
  system: string;
  messages: AdapterMessage[];
  /** Omitted/empty ⇒ JSON-only mode: the adapter receives NO tools. */
  tools?: AgentTool[];
  /** Cap on adapter round-trips (default 6); exceeding it is a terminal error result. */
  maxIterations?: number;
  /**
   * Ask for prompt caching on the stable tools+system prefix for this turn (AC12).
   *
   * Set by the CALLER, because only it knows the turn's shape: a builder/agent turn has
   * a large repeated prefix worth caching, an app-frame envelope does not (D0/Q2).
   */
  cache?: boolean;
  /**
   * Per-turn output ceiling, forwarded verbatim to the adapter (ADR-0018 D4).
   *
   * Set by the CALLER for the same reason as `cache`: only the call site knows whether
   * this turn is a Chess move under a runtime contract or an open-ended build. Adapters
   * clamp it against their own ceiling, so this can narrow but never widen.
   */
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Streamed deltas from every iteration, in order — callers accumulate. */
  onDelta?: (delta: string) => void;
  onEvent?: (event: AgentTurnEvent) => void;
}

/**
 * `stopReason` is the FINAL iteration's — the one that produced the reply the caller
 * will parse. `max_tokens` means that reply was cut off by the output cap and is
 * incomplete through no fault of the model (TASK-20260812 AC3: the bridge must not
 * charge a parse-failure strike for it). `tool_use` never reaches the caller: the
 * loop only returns after an iteration with no tool calls.
 */
export type AgentTurnResult = { ok: true; text: string; stopReason: 'end' | 'max_tokens' } | AdapterError;

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
    const request = {
      system,
      messages: [...conversation],
      ...(defs !== undefined ? { tools: defs } : {}),
      ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    };
    const startedAt = now();
    // Emitted BEFORE the await: a 30-minute build must show the call in flight, not an
    // empty panel until it returns. Same `index` correlates it with the `round_trip`.
    onEvent?.({ type: 'round_trip_start', index: iteration, request });
    // The await is GUARDED (TASK-20260813 AC7). An adapter is contracted to report
    // failure as `ok:false`, but not every one honours it: the webllm adapter throws on
    // its function-calling path, and an aborted completion rejects with an AbortError.
    // An escaping rejection used to skip the `round_trip` emit below, leaving the entry
    // opened by `round_trip_start` pending FOREVER — which is the inspector timer that
    // "keeps running after the call is done and moves to the next one".
    //
    // Converting to an `ok:false` result rather than rethrowing keeps one exit shape for
    // the whole loop: the existing `!result.ok` branch preserves partial text from
    // earlier iterations, which a rethrow would discard.
    let result: AdapterResult;
    try {
      result = await adapter.complete({
        system,
        messages: conversation,
        tools: defs,
        signal,
        onDelta,
        ...(options.cache === true ? { cache: true } : {}),
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
      });
    } catch (cause) {
      result = thrownToResult(cause);
    }
    onEvent?.({ type: 'round_trip', index: iteration, request, response: result, durationMs: now() - startedAt });
    if (!result.ok) {
      // Text from EARLIER completed iterations is real work — a drop on iteration N
      // must not discard what iterations 0..N-1 already streamed.
      const partial = `${text}${result.partialText ?? ''}`;
      return partial === '' ? result : { ...result, partialText: partial };
    }
    text += result.text;
    if (result.toolCalls.length === 0) {
      return { ok: true, text, stopReason: result.stopReason === 'max_tokens' ? 'max_tokens' : 'end' };
    }

    conversation.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      onEvent?.({ type: 'tool_call', call, roundTripIndex: iteration });
      // The timing seam is the handler. `dispatch` turns a thrown error into an error
      // string rather than rethrowing, so a failed tool is timed like any other.
      const toolStartedAt = now();
      const output = await dispatch(tools, call);
      onEvent?.({ type: 'tool_result', call, output, roundTripIndex: iteration, durationMs: now() - toolStartedAt });
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

/**
 * Turn an escaped adapter rejection into the `ok:false` result the loop expects (AC7).
 *
 * An abort is reported as CANCELLED rather than HOST_ERROR and is NOT retryable: the
 * user stopped the turn on purpose, so a retry would fight them, and a surface that
 * renders it as a crash would be lying about what happened.
 *
 * The message is carried through verbatim because the LLM inspector renders it — the
 * one surface whose entire job is explaining what the model did. Collapsing a real
 * stack into "[object Object]" there would defeat the feature.
 */
function thrownToResult(cause: unknown): AdapterError {
  const aborted =
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error && cause.name === 'AbortError');
  const message = cause instanceof Error ? cause.message : String(cause);
  return aborted
    ? { ok: false, code: ERROR_CODES.CANCELLED, message: message === '' ? 'turn aborted' : message, retryable: false }
    : {
        ok: false,
        code: ERROR_CODES.HOST_ERROR,
        // Named so the inspector shows WHERE it broke, not just what was thrown.
        message: `adapter threw: ${message === '' ? String(cause) : message}`,
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
