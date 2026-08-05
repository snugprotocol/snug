// types.ts — the provider-agnostic adapter contract (dependency injection via plain
// interfaces, per docs/standards/typescript.md). Browser-safe: the BYOK playground
// constructs adapters directly, so nothing here may touch Node APIs.

/** Provider-agnostic tool definition; providers map it to their own wire shape. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07-ish object schema) for the tool input. */
  inputSchema: Record<string, unknown>;
}

/** One tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Normalized conversation message. `tool` messages carry a tool result back to the
 * model; adapters translate them into the provider's shape (Anthropic: `tool_result`
 * user blocks; OpenAI: `role: "tool"` messages).
 */
export type AdapterMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface AdapterRequest {
  system: string;
  messages: AdapterMessage[];
  /** Omitted or empty ⇒ no tools are offered (JSON-only mode). */
  tools?: ToolDef[];
  signal?: AbortSignal;
  /** Streamed DELTAS (not cumulative) — callers accumulate. */
  onDelta?: (delta: string) => void;
  /**
   * Ask for prompt caching on the STABLE PREFIX (tools + system) for THIS turn.
   *
   * Per-turn rather than per-adapter because one adapter instance can serve turns of
   * different shapes: the hub's `/invoke` builds a single adapter that answers both the
   * builder path (large repeated prefix — worth caching) and the app-frame path (small
   * self-contained envelopes, below the model-dependent minimum — where a breakpoint
   * would pay a 1.25x write premium on a prefix that is never read). Only the caller
   * knows which turn it is running. Providers that do not support caching ignore it.
   */
  cache?: boolean;
}

/** Errors as data — never thrown across the adapter boundary. */
export interface AdapterError {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  /**
   * Text streamed before the failure, when any. A long build that dies at minute 28
   * must not lose what it already wrote — callers render this alongside the error
   * instead of showing an empty reply.
   */
  partialText?: string;
}

/**
 * Token accounting, when the provider reports it. Observation only — never persisted.
 *
 * The cache fields are OPTIONAL AND ABSENT when the provider said nothing about caching
 * — never coerced to 0. The UI distinguishes "cached 0%" from "this provider does not
 * report caching", so an absent field and a zero mean different things (AC13).
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens written to the cache this request (paid at the ~1.25x write premium). */
  cacheCreationTokens?: number;
  /** Tokens served from the cache this request (paid at ~0.1x). */
  cacheReadTokens?: number;
}

export type AdapterResult =
  | {
      ok: true;
      text: string;
      toolCalls: ToolCall[];
      stopReason: 'end' | 'tool_use';
      usage?: TokenUsage;
      /**
       * The model as reported ON THE WIRE by the provider — not the configured id, which
       * can be an alias the provider resolves to something else. Absent when the provider
       * did not say; the UI shows what was reported rather than guessing (AC4).
       */
      model?: string;
    }
  | AdapterError;

/** The one seam through which any provider is reached (see runAgentTurn). */
export interface AgentAdapter {
  complete(request: AdapterRequest): Promise<AdapterResult>;
}

/** Injectable fetch for fixture-based tests; defaults to the global. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
