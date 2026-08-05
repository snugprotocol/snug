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

import type {
  AdapterMessage,
  AgentRoundTrip,
  AgentRoundTripStart,
  AgentTurnEvent,
  TokenUsage,
  ToolCall,
} from '@snugprotocol/adapters';

/** One tool the model requested, nested under the round trip that asked for it (AC5). */
export interface LlmInspectorTool {
  id: string;
  name: string;
  /** Tool input AS SENT, redacted. */
  input: Record<string, unknown>;
  /** Tool output, redacted. Absent while the tool is still running. */
  output?: string;
  /** Elapsed time around the TOOL HANDLER. Absent while pending. */
  durationMs?: number;
  /** True between `tool_call` and `tool_result` — drives the live timer. */
  pending: boolean;
}

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
  /** Tools that actually RAN as a result of this round trip, each with its own time (AC5). */
  tools: LlmInspectorTool[];
  stopReason?: 'end' | 'tool_use';
  usage?: TokenUsage;
  /** The model as reported on the wire, never inferred from config (AC4). */
  model?: string;
  /** Wall-clock for the round trip. Absent while the call is still in flight (AC8). */
  durationMs?: number;
  /** True between `round_trip_start` and `round_trip` — drives the live timer (AC8). */
  pending: boolean;
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
  /** Approximate retained payload size, the quantity the AC7 budget bounds. */
  totalBytes: number;
}

export const initialLlmInspectorState: LlmInspectorState = {
  entries: [],
  totalDurationMs: 0,
  totalUsage: {},
  totalBytes: 0,
};

/**
 * Ring-buffer bound (AC14). A long build with the raised iteration ceiling (48) can
 * produce many round trips; this keeps the newest window and drops the oldest rather
 * than growing without limit.
 */
export const LLM_INSPECTOR_MAX_ENTRIES = 60;

/**
 * Total retained payload budget, in approximate bytes (AC7).
 *
 * This REPLACES the old per-field ingest cap, and the swap is deliberate (D2). Item 3 of
 * the task requires that expanding a body shows the COMPLETE payload, so truncating on
 * the way in is no longer allowed — which removes the mechanism that made the old bound
 * hold. The parent task's reviewer was right that "60 entries with unbounded per-entry
 * size is unbounded": the per-turn app context injects the app's whole HTML into
 * `system`, `messages` is a full conversation snapshot, and `artifact_write` inputs carry
 * entire app files.
 *
 * So the bound moves from per-entry to global: keep whole payloads, but evict the oldest
 * entries once the retained total exceeds this. A single 30-minute build in a tab that is
 * also running an app iframe and a sql.js database stays bounded either way — but by a
 * different mechanism, which is why the eviction test is load-bearing rather than
 * incidental.
 *
 * 8 MB is roughly a few whole-app builds' worth of prompts: large enough that ordinary
 * inspection never evicts, small enough to be a hard ceiling.
 */
export const LLM_INSPECTOR_MAX_BYTES = 8 * 1024 * 1024;

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
  // These are the ONLY credentials the host itself handles (BYOK is anthropic|openai),
  // and they never ride in a request BODY — the key travels in an HTTP header the
  // inspector never sees. They are matched anyway: a user who pastes their own key into
  // chat must not have it rendered back at them.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Bearer / Basic credentials echoed into a prompt.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{12,}=*/gi,
  // Google/GCP.
  /\bAIza[A-Za-z0-9_-]{10,}/g,
  // The rest are defence-in-depth for secrets a USER pastes into a prompt. The host never
  // holds these, but the inspector renders bodies verbatim, so anything key-shaped that
  // shows up is masked rather than displayed.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub PATs
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  // `api-key: <value>` / `x-api-key=<value>` / `"apiKey": "<value>"` style pairs — mask
  // the VALUE, keep the key name so the shape of the request stays readable.
  /((?:api[_-]?key|apikey|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{8,}=*)/gi,
];

const REDACTED = '«redacted»';

function redactText(value: string): string {
  // Payloads are now kept whole (AC6), so redaction runs over the FULL body. Truncation
  // used to bound this work and incidentally drop secrets buried past the cap; neither
  // shortcut is available any more, so every byte is scrubbed.
  let out = value;
  for (const pattern of KEY_PATTERNS) {
    // Keep a leading capture group when the pattern has one (the `key:` half of a
    // name/value pair) so the request stays readable with only the VALUE masked;
    // patterns without a group are replaced whole.
    //
    // The group must be detected by TYPE, not by `=== undefined`. String.replace calls a
    // group-less pattern's callback as (match, offset, string), so a naive `prefix`
    // parameter binds to the offset NUMBER and spliced it into the output —
    // 'key sk-ant-…' rendered as 'key 4«redacted»' (Gate-5 review, 2026-08-05).
    out = out.replace(pattern, (_match, ...args: unknown[]) => {
      const first = args[0];
      return typeof first === 'string' ? `${first}${REDACTED}` : REDACTED;
    });
  }
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

/**
 * Sum one usage field, keeping it ABSENT unless at least one side reported it. AC13's
 * absent-not-zero rule: the UI shows a cached % only when a provider actually reported
 * caching, so a silent provider must not be folded in as a 0 that reads as "0% hit".
 */
function addField(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function addUsage(total: TokenUsage, next: TokenUsage | undefined): TokenUsage {
  if (next === undefined) return total;
  const summed = {
    inputTokens: addField(total.inputTokens, next.inputTokens),
    outputTokens: addField(total.outputTokens, next.outputTokens),
    cacheCreationTokens: addField(total.cacheCreationTokens, next.cacheCreationTokens),
    cacheReadTokens: addField(total.cacheReadTokens, next.cacheReadTokens),
  };
  return Object.fromEntries(Object.entries(summed).filter(([, v]) => v !== undefined));
}

/**
 * Approximate retained size of an entry. Deliberately cheap — the exact byte count does
 * not matter, only that the budget tracks payload growth. Measured on the redacted text
 * that is actually retained.
 */
function entryBytes(entry: LlmInspectorEntry): number {
  // EVERY retained string counts. Omitting one makes the budget a lie: `toolNames` and
  // `message` were both missed originally, and 60 entries offering 20 tools with long
  // names reported 360 bytes while retaining ~60 MB (Gate-5 review, 2026-08-05).
  let bytes = entry.system.length + entry.text.length + (entry.message?.length ?? 0);
  for (const name of entry.toolNames) bytes += name.length;
  for (const message of entry.messages) bytes += JSON.stringify(message).length;
  for (const call of entry.toolCalls) bytes += JSON.stringify(call).length;
  for (const tool of entry.tools) bytes += JSON.stringify(tool.input).length + (tool.output?.length ?? 0);
  return bytes;
}

/**
 * Elide the payloads of a single entry that is too big to retain whole.
 *
 * The last resort when dropping older entries cannot get under the budget — an entry
 * can keep GROWING after it is admitted (each `artifact_write` tool result appends a
 * whole app file), so "always keep the newest" cannot mean "keep it at any size".
 *
 * The entry survives as a record of what ran — index, model, timing, tool names — with
 * its bodies replaced by a marker. That is a real weakening of AC6 for this one entry,
 * and it is the honest trade: the alternative is an unbounded tab.
 */
const ELIDED = '…[elided: payload exceeded the inspector memory budget]';

function elide(entry: LlmInspectorEntry): LlmInspectorEntry {
  return {
    ...entry,
    system: ELIDED,
    messages: [],
    text: entry.text === '' ? '' : ELIDED,
    toolCalls: [],
    ...(entry.message !== undefined ? { message: ELIDED } : {}),
    tools: entry.tools.map((tool) => ({ ...tool, input: {}, ...(tool.output !== undefined ? { output: ELIDED } : {}) })),
  };
}

/**
 * Apply both bounds: the entry-count ceiling and the total-bytes budget (AC7).
 *
 * Oldest entries are evicted first — a build's most recent activity is what the user is
 * looking at. If the newest entry ALONE still blows the budget, its payloads are elided
 * rather than the entry dropped: an empty panel for the call you just made is useless,
 * and (the bug this replaced) draining the whole history for an entry that can never fit
 * loses the build record while still leaving the bound broken.
 */
function evict(entries: LlmInspectorEntry[]): { entries: LlmInspectorEntry[]; totalBytes: number } {
  let kept = entries.slice(-LLM_INSPECTOR_MAX_ENTRIES);
  let total = kept.reduce((sum, entry) => sum + entryBytes(entry), 0);
  if (total <= LLM_INSPECTOR_MAX_BYTES) return { entries: kept, totalBytes: total };

  // If the newest entry cannot fit even on its own, elide it FIRST — otherwise the loop
  // below would evict every older entry chasing a target it can never reach.
  const newest = kept.at(-1);
  if (newest !== undefined && entryBytes(newest) > LLM_INSPECTOR_MAX_BYTES) {
    kept = [...kept.slice(0, -1), elide(newest)];
    total = kept.reduce((sum, entry) => sum + entryBytes(entry), 0);
  }
  while (kept.length > 1 && total > LLM_INSPECTOR_MAX_BYTES) {
    total -= entryBytes(kept[0]!);
    kept = kept.slice(1);
  }
  return { entries: kept, totalBytes: total };
}

/** A round trip that has STARTED: request only, no outcome yet (AC8). */
function toPendingEntry(start: AgentRoundTripStart): LlmInspectorEntry {
  return {
    index: start.index,
    // Redaction applies to a pending entry too — C1 does not wait for completion (AC15).
    system: redactText(start.request.system),
    messages: redactMessages(start.request.messages),
    toolNames: (start.request.tools ?? []).map((tool) => tool.name),
    text: '',
    toolCalls: [],
    tools: [],
    pending: true,
    isError: false,
  };
}

/** Fold the completed outcome into a (usually pending) entry, preserving nested tools. */
function settleEntry(existing: LlmInspectorEntry | undefined, trip: AgentRoundTrip): LlmInspectorEntry {
  const { response } = trip;
  const base: LlmInspectorEntry = {
    ...(existing ?? toPendingEntry({ index: trip.index, request: trip.request })),
    // Re-read the request from the completed trip: it is the authoritative snapshot AS
    // SENT, and a `round_trip` can arrive without a preceding start (older callers).
    system: redactText(trip.request.system),
    messages: redactMessages(trip.request.messages),
    toolNames: (trip.request.tools ?? []).map((tool) => tool.name),
    durationMs: trip.durationMs,
    pending: false,
    isError: false,
  };
  if (response.ok) {
    return {
      ...base,
      text: redactText(response.text),
      toolCalls: redactCalls(response.toolCalls),
      stopReason: response.stopReason,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      ...(response.model !== undefined ? { model: response.model } : {}),
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

/** Apply a tool event to the round trip that requested it, leaving others untouched. */
function applyToTools(
  entries: LlmInspectorEntry[],
  roundTripIndex: number,
  update: (tools: LlmInspectorTool[]) => LlmInspectorTool[],
): LlmInspectorEntry[] {
  // A tool whose round trip has already been evicted is silently dropped — a late result
  // for a gone entry must be a no-op, never a crash.
  return entries.map((entry) => (entry.index === roundTripIndex ? { ...entry, tools: update(entry.tools) } : entry));
}

/**
 * Fold one agent-turn event (or a `'reset'` at turn start) into the timeline. A pure
 * reducer, exactly like inspectorReduce — the panel is a projection of this state and
 * holds nothing of its own.
 *
 * Takes the whole `AgentTurnEvent` union now rather than only completed round trips:
 * live progress (AC8) and nested tool timing (AC5) both arrive as their own events.
 */
export function llmInspectorReduce(state: LlmInspectorState, action: AgentTurnEvent | 'reset'): LlmInspectorState {
  if (action === 'reset') return initialLlmInspectorState;

  if (action.type === 'round_trip_start') {
    const { entries, totalBytes } = evict([...state.entries, toPendingEntry(action)]);
    return { ...state, entries, totalBytes };
  }

  if (action.type === 'round_trip') {
    const existing = state.entries.find((entry) => entry.index === action.index);
    const settled = settleEntry(existing, action);
    const next = existing === undefined ? [...state.entries, settled] : state.entries.map((e) => (e === existing ? settled : e));
    const { entries, totalBytes } = evict(next);
    return {
      entries,
      totalBytes,
      totalDurationMs: state.totalDurationMs + action.durationMs,
      totalUsage: addUsage(state.totalUsage, action.response.ok ? action.response.usage : undefined),
    };
  }

  if (action.type === 'tool_call') {
    const next = applyToTools(state.entries, action.roundTripIndex, (tools) => [
      ...tools,
      {
        id: action.call.id,
        name: action.call.name,
        input: redactValue(action.call.input),
        pending: true,
      },
    ]);
    const { entries, totalBytes } = evict(next);
    return { ...state, entries, totalBytes };
  }

  // tool_result — settle the matching pending tool with its own elapsed time (AC5).
  const next = applyToTools(state.entries, action.roundTripIndex, (tools) =>
    tools.map((tool) =>
      tool.id === action.call.id && tool.pending
        ? { ...tool, output: redactText(action.output), durationMs: action.durationMs, pending: false }
        : tool,
    ),
  );
  const { entries, totalBytes } = evict(next);
  return { ...state, entries, totalBytes };
}
