// responses-wire.ts — the OpenAI Responses wire shape, both directions, for the ChatGPT-plan
// adapter (TASK-20261023-siwc-chatgpt-plan D3, AC4, AC12). Pure functions over plain data so
// the HTTP flow in `openai-responses.ts` stays readable and the mapping is testable through it.
// Browser-safe: no Node APIs.

import type { AdapterMessage, TokenUsage, ToolCall, ToolDef } from './types.js';

export interface ResponsesRequestInput {
  model: string;
  system: string;
  messages: AdapterMessage[];
  tools: ToolDef[] | undefined;
  effort: string | undefined;
}

/**
 * The request body, exactly `{ model, instructions, input, tools?, reasoning?, store, stream }`.
 * The plan route rejects `temperature`, `max_output_tokens`, `store:true`, `stream:false`,
 * `metadata`, `user`, `previous_response_id` and more (measured; AC4 pins each absent), so
 * nothing optional is ever added here: `store:false` means the route remembers nothing and
 * `runAgentTurn` resends the whole conversation every iteration — which IS the full-context rule.
 * The system prompt rides `instructions`, never a system-role item; `cache` and
 * `maxOutputTokens` have no wire form on this route (the ceiling is client-side).
 */
export function buildResponsesBody(input: ResponsesRequestInput): Record<string, unknown> {
  return {
    model: input.model,
    instructions: input.system,
    input: toInputItems(input.messages),
    ...(input.tools !== undefined && input.tools.length > 0
      ? {
          tools: input.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }
      : {}),
    ...(input.effort !== undefined ? { reasoning: { effort: input.effort } } : {}),
    store: false,
    stream: true,
  };
}

/**
 * Conversation → Responses input items. An assistant turn that only called tools has no text
 * item (an empty `content` would be a second, meaningless message), and each call becomes its
 * own `function_call` item followed later by the matching `function_call_output`.
 */
function toInputItems(messages: AdapterMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      if (message.content !== '' || calls.length === 0) out.push({ role: 'assistant', content: message.content });
      for (const call of calls) {
        out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
    } else {
      out.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stream events → accumulated state
// ---------------------------------------------------------------------------------------------

/** A function call under assembly, keyed by `output_index`; `.done`'s `arguments` is authoritative. */
interface PendingCall {
  id: string;
  name: string;
  args: string;
  done: string | undefined;
}

/** How the stream ended, when it did — only `completed` is success. */
export type ResponsesTerminal =
  | { kind: 'completed'; response: Record<string, unknown> }
  | { kind: 'incomplete'; reason: string; response: Record<string, unknown> }
  | { kind: 'failed'; code: string; message: string };

export interface ResponsesStreamState {
  text: string;
  calls: Map<number, PendingCall>;
  terminal: ResponsesTerminal | undefined;
  /**
   * Every output character so far — the text AND the function-call arguments — for the
   * client-side ceiling (S6): the route gives no server-side cap, and a runaway tool call is
   * output just as prose is. Kept as a running count so the ceiling check is O(1) per event.
   */
  outputChars: number;
}

export function emptyStreamState(): ResponsesStreamState {
  return { text: '', calls: new Map(), terminal: undefined, outputChars: 0 };
}

/**
 * Fold one parsed event into the state; returns the delta text when the event carried one so
 * the caller can stream it and check the ceiling. Everything not named here — `response.created`,
 * `in_progress`, `content_part.*`, `output_text.done`, `response.metadata` (which carries a
 * `delta`-looking field of its own), reasoning items, anything newer — is ignored on purpose:
 * the type is the dispatch key, never the presence of a field.
 */
export function applyResponsesEvent(
  state: ResponsesStreamState,
  data: Record<string, unknown>,
  fallbackType: string,
): string | undefined {
  const type = typeof data.type === 'string' ? data.type : fallbackType;
  switch (type) {
    case 'response.output_text.delta': {
      if (typeof data.delta !== 'string' || data.delta === '') return undefined;
      state.text += data.delta;
      state.outputChars += data.delta.length;
      return data.delta;
    }
    case 'response.output_item.added': {
      const item = asRecord(data.item);
      if (item === null || item.type !== 'function_call') return undefined;
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      state.calls.set(indexOf(data), {
        id: typeof item.call_id === 'string' ? item.call_id : '',
        name: typeof item.name === 'string' ? item.name : '',
        args,
        done: undefined,
      });
      state.outputChars += args.length;
      return undefined;
    }
    case 'response.function_call_arguments.delta': {
      const entry = state.calls.get(indexOf(data));
      if (entry !== undefined && typeof data.delta === 'string') {
        entry.args += data.delta;
        state.outputChars += data.delta.length;
      }
      return undefined;
    }
    case 'response.function_call_arguments.done': {
      const entry = state.calls.get(indexOf(data));
      if (entry !== undefined && typeof data.arguments === 'string') {
        // Authoritative, and usually the deltas' concatenation; only what the deltas did not carry counts again.
        state.outputChars += Math.max(0, data.arguments.length - entry.args.length);
        entry.done = data.arguments;
      }
      return undefined;
    }
    case 'response.completed': {
      state.terminal = { kind: 'completed', response: asRecord(data.response) ?? {} };
      return undefined;
    }
    case 'response.incomplete': {
      const response = asRecord(data.response) ?? {};
      const details = asRecord(response.incomplete_details);
      const reason = typeof details?.reason === 'string' ? details.reason : 'unknown';
      state.terminal = { kind: 'incomplete', reason, response };
      return undefined;
    }
    case 'response.failed': {
      const response = asRecord(data.response);
      state.terminal = toFailure(asRecord(response?.error));
      return undefined;
    }
    case 'error': {
      state.terminal = toFailure(data);
      return undefined;
    }
    default:
      return undefined;
  }
}

function toFailure(error: Record<string, unknown> | null): ResponsesTerminal {
  return {
    kind: 'failed',
    code: typeof error?.code === 'string' ? error.code : '',
    message: typeof error?.message === 'string' ? error.message : '',
  };
}

/** Assembled calls in `output_index` order; arguments that never parsed become an empty input. */
export function toolCallsOf(state: ResponsesStreamState): ToolCall[] {
  return [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => {
      const raw = entry.done ?? entry.args;
      return { id: entry.id, name: entry.name, input: parseRecord(raw === '' ? '{}' : raw) ?? {} };
    });
}

/**
 * Usage as the wire reports it — each field only when the provider said it. The route reports
 * `input_tokens_details.cached_tokens` and `cache_write_tokens`; a reported 0 is a fact ("cached
 * 0%"), an absent field means "said nothing" — the UI tells those apart (AC13), so nothing is
 * coerced.
 */
export function usageOf(response: Record<string, unknown>): TokenUsage | undefined {
  const wire = asRecord(response.usage);
  if (wire === null) return undefined;
  const usage: TokenUsage = {};
  if (typeof wire.input_tokens === 'number') usage.inputTokens = wire.input_tokens;
  if (typeof wire.output_tokens === 'number') usage.outputTokens = wire.output_tokens;
  const details = asRecord(wire.input_tokens_details);
  if (typeof details?.cached_tokens === 'number') usage.cacheReadTokens = details.cached_tokens;
  if (typeof details?.cache_write_tokens === 'number') usage.cacheCreationTokens = details.cache_write_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function wireModelOf(response: Record<string, unknown>): string | undefined {
  return typeof response.model === 'string' ? response.model : undefined;
}

/** The `detail` or `error.message` of a pre-stream error body when the body is JSON; else the raw text. */
export function errorDetailOf(bodyText: string): string {
  const body = parseRecord(bodyText);
  if (body === null) return bodyText;
  if (typeof body.detail === 'string') return body.detail;
  const error = asRecord(body.error);
  if (typeof error?.message === 'string') return error.message;
  return bodyText;
}

function indexOf(data: Record<string, unknown>): number {
  return typeof data.output_index === 'number' ? data.output_index : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}
