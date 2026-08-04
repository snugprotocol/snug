// llmInspector.ts — the LLM round-trip inspector: "what did we actually send the
// model, and what came back?" Fed by the adapters' `round_trip` AgentTurnEvent
// (packages/adapters/src/agent-turn.ts), which brackets every adapter.complete().
//
// THIS IS THE SIBLING OF run/inspector.ts, NOT AN EXTENSION OF IT (task D1).
// The two have deliberately OPPOSITE rules and must stay separate:
//   inspector.ts   — the bridge/frame timeline. STRUCTURAL ONLY: shapes, key names,
//                    sizes. Never a payload value. That is a privacy guarantee.
//   llmInspector.ts — the LLM timeline. Renders request/response BODIES on purpose;
//                    showing the prompt IS the feature.
// Extending inspector.ts to show bodies would invert its central rule, so this module
// carries its own guarantees instead:
//   * IN-MEMORY ONLY — nothing here is ever written to the user DB (AC14). There is no
//     persistence call in this file, and a byte-level export test enforces it.
//   * BOUNDED — a ring buffer, so a 30-minute build cannot exhaust memory (AC14).
//   * C1 — a BYOK credential must NEVER be rendered, even though bodies are (AC15).

import type { AdapterMessage, AgentRoundTrip, TokenUsage, ToolCall } from '@snugprotocol/adapters';

export interface LlmInspectorEntry {
  /** 0-based round-trip index within the turn (mirrors AgentRoundTrip.index). */
  index: number;
  /** The system prompt AS SENT, redacted. */
  system: string;
  /** The conversation AS SENT, redacted. */
  messages: AdapterMessage[];
  /** Tool NAMES offered on this round trip (the schemas are noise at this altitude). */
  toolNames: string[];
  /** Assistant text returned — or, on a failed round trip, the partial text salvaged. */
  text: string;
  toolCalls: ToolCall[];
  stopReason?: 'end' | 'tool_use';
  usage?: TokenUsage;
  durationMs: number;
  isError: boolean;
  code?: string;
  message?: string;
}

export interface LlmInspectorState {
  entries: LlmInspectorEntry[];
  /** Wall-clock across every round trip in the turn. */
  totalDurationMs: number;
  /** Running token total — display only; no cost accounting (out of scope). */
  totalUsage: TokenUsage;
}

export const initialLlmInspectorState: LlmInspectorState = { entries: [], totalDurationMs: 0, totalUsage: {} };

/**
 * Ring-buffer bound (AC14). A long build with the raised iteration ceiling (48) can
 * produce many round trips; this keeps the newest window and drops the oldest rather
 * than growing without limit.
 */
export const LLM_INSPECTOR_MAX_ENTRIES = 60;

/**
 * Credential shapes that must never render (C1, AC15). Bodies are shown verbatim
 * otherwise, so redaction happens on the way IN — an un-redacted value is never stored
 * in state, which is what the marker test asserts.
 *
 * Deliberately broad: matching too much costs a few masked characters, matching too
 * little leaks a key.
 */
const KEY_PATTERNS: RegExp[] = [
  // Anthropic / OpenAI style keys, including the sk-ant-/sk-proj- prefixed variants.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens in an authorization header that got echoed into a prompt.
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  // Google/GCP style.
  /\bAIza[A-Za-z0-9_-]{10,}/g,
];

const REDACTED = '«redacted»';

function redactText(value: string): string {
  let out = value;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Deep redaction over arbitrary tool input/output JSON — keys are preserved, values scrubbed. */
function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = redactValue(inner);
    return out as unknown as T;
  }
  return value;
}

const redactMessages = (messages: AdapterMessage[]): AdapterMessage[] => messages.map((m) => redactValue(m));
const redactCalls = (calls: ToolCall[]): ToolCall[] => calls.map((call) => redactValue(call));

function addUsage(total: TokenUsage, next: TokenUsage | undefined): TokenUsage {
  if (next === undefined) return total;
  const inputTokens = (total.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (total.outputTokens ?? 0) + (next.outputTokens ?? 0);
  return {
    ...(next.inputTokens !== undefined || total.inputTokens !== undefined ? { inputTokens } : {}),
    ...(next.outputTokens !== undefined || total.outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function toEntry(trip: AgentRoundTrip): LlmInspectorEntry {
  const { response } = trip;
  const base = {
    index: trip.index,
    system: redactText(trip.request.system),
    messages: redactMessages(trip.request.messages),
    toolNames: (trip.request.tools ?? []).map((tool) => tool.name),
    durationMs: trip.durationMs,
  };
  if (response.ok) {
    return {
      ...base,
      text: redactText(response.text),
      toolCalls: redactCalls(response.toolCalls),
      stopReason: response.stopReason,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      isError: false,
    };
  }
  return {
    ...base,
    // A dropped stream still did real work — show what was salvaged (Phase 1's partialText).
    text: redactText(response.partialText ?? ''),
    toolCalls: [],
    isError: true,
    code: response.code,
    message: redactText(response.message),
  };
}

/**
 * Fold one round trip (or a `'reset'` at turn start) into the timeline. A pure
 * reducer, exactly like inspectorReduce — the panel is a projection of this state and
 * holds nothing of its own.
 */
export function llmInspectorReduce(state: LlmInspectorState, action: AgentRoundTrip | 'reset'): LlmInspectorState {
  if (action === 'reset') return initialLlmInspectorState;
  const entries = [...state.entries, toEntry(action)].slice(-LLM_INSPECTOR_MAX_ENTRIES);
  return {
    entries,
    totalDurationMs: state.totalDurationMs + action.durationMs,
    totalUsage: addUsage(state.totalUsage, action.response.ok ? action.response.usage : undefined),
  };
}
