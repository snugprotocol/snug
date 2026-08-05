// anthropic.ts — Anthropic Messages API adapter (streaming + tool use).
// Reached ONLY via runAgentTurn (single choke point). Browser-safe: fetch + Web Streams.

import { ERROR_CODES } from '@snugprotocol/protocol';

import {
  cancelledResult,
  httpErrorResult,
  isAbortError,
  networkErrorResult,
  streamDroppedResult,
} from './errors.js';
import { parseSse, tryParseJsonRecord } from './sse.js';
import type {
  AdapterMessage,
  AdapterResult,
  AgentAdapter,
  FetchLike,
  TokenUsage,
  ToolCall,
} from './types.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
/**
 * App building is a heavy, long-context task: a single artifact_write can carry a whole
 * single-file app. 8192 truncated real builds mid-file, so the default is the model's
 * 128K output ceiling. No beta header is needed — 128K output is built in on Claude 4.6+
 * (the old `output-128k-2025-02-19` opt-in is legacy and a no-op). The request MUST be
 * streamed at this size, which this adapter always does.
 */
const DEFAULT_MAX_TOKENS = 128_000;

export interface AnthropicAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Injectable for fixture-based tests — adapter tests never hit the network. */
  fetch?: FetchLike;
}

/**
 * Caching is an Anthropic-API feature. A `baseUrl` pointing anywhere else is an
 * OpenAI-compatible or local server that will reject `cache_control` as an unknown
 * field — the same failure class that `max_completion_tokens` caused on local turns in
 * the parent task. Opting in cannot override this (AC14).
 */
function supportsCaching(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('api.anthropic.com');
  } catch {
    return false;
  }
}

type WireMessage = { role: 'user' | 'assistant'; content: string | Record<string, unknown>[] };

/**
 * Map normalized messages to Anthropic shape: assistant tool calls become `tool_use`
 * content blocks; tool results become `tool_result` blocks on a user message, with
 * consecutive results merged into ONE user message (roles must alternate).
 */
function toAnthropicMessages(messages: AdapterMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (message.content !== '') blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      out.push({ role: 'assistant', content: blocks });
    } else {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const last = out[out.length - 1];
      if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

function parseToolInput(json: string): Record<string, unknown> {
  return tryParseJsonRecord(json === '' ? '{}' : json) ?? {};
}

export function anthropicAdapter(options: AnthropicAdapterOptions): AgentAdapter {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Whether this endpoint COULD cache; whether a given turn SHOULD is per-request.
  const endpointSupportsCaching = supportsCaching(baseUrl);

  return {
    async complete({ system, messages, tools, signal, onDelta, cache }): Promise<AdapterResult> {
      const caching = cache === true && endpointSupportsCaching;
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            // BYOK runs in the page (ADR-0008); Anthropic requires this explicit opt-in
            // before it will serve CORS to browser callers. Keys are the user's own.
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            // Render order is tools -> system -> messages, so ONE breakpoint on the last
            // system block caches tools+system together — the whole stable prefix. The
            // volatile tail (messages) deliberately carries none: a breakpoint there
            // would write a fresh entry per request and never read one.
            system: caching ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
            stream: true,
            messages: toAnthropicMessages(messages),
            ...(tools !== undefined && tools.length > 0
              ? {
                  tools: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                  })),
                }
              : {}),
          }),
          signal,
        });
      } catch (err) {
        return isAbortError(err) || signal?.aborted === true ? cancelledResult() : networkErrorResult(err);
      }
      if (!response.ok) return httpErrorResult(response.status, await safeText(response));

      let text = '';
      const toolCalls: ToolCall[] = [];
      const pending = new Map<number, { id: string; name: string; json: string }>();
      let completed = false;
      let wireModel: string | undefined;
      const usage: TokenUsage = {};
      try {
        for await (const event of parseSse(response.body)) {
          const payload = tryParseJsonRecord(event.data);
          if (payload === null) continue; // malformed block tolerated
          const type = typeof payload.type === 'string' ? payload.type : event.event;
          const index = typeof payload.index === 'number' ? payload.index : -1;
          if (type === 'content_block_start') {
            const block = asRecord(payload.content_block);
            if (block !== null && block.type === 'tool_use') {
              pending.set(index, { id: String(block.id ?? ''), name: String(block.name ?? ''), json: '' });
            }
          } else if (type === 'content_block_delta') {
            const delta = asRecord(payload.delta);
            if (delta === null) continue;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              text += delta.text;
              onDelta?.(delta.text);
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const entry = pending.get(index);
              if (entry !== undefined) entry.json += delta.partial_json;
            }
          } else if (type === 'content_block_stop') {
            const entry = pending.get(index);
            if (entry !== undefined) {
              pending.delete(index);
              toolCalls.push({ id: entry.id, name: entry.name, input: parseToolInput(entry.json) });
            }
          } else if (type === 'message_stop') {
            completed = true;
            break;
          } else if (type === 'error') {
            const error = asRecord(payload.error);
            return {
              ok: false,
              code: ERROR_CODES.HOST_ERROR,
              message: typeof error?.message === 'string' ? error.message : 'provider stream error',
              retryable: true,
              ...(text !== '' ? { partialText: text } : {}),
            };
          } else if (type === 'message_start') {
            // Usage rides here (input + cache) and on message_delta (output) — observation
            // only. The cache fields are set ONLY when the provider reported them, so an
            // absent field stays absent rather than becoming a misleading 0 (AC13).
            const message = asRecord(payload.message);
            // The model as the provider resolved it — an alias may differ from what we sent.
            if (typeof message?.model === 'string') wireModel = message.model;
            const usageRecord = asRecord(message?.usage);
            if (typeof usageRecord?.input_tokens === 'number') usage.inputTokens = usageRecord.input_tokens;
            if (typeof usageRecord?.cache_creation_input_tokens === 'number') {
              usage.cacheCreationTokens = usageRecord.cache_creation_input_tokens;
            }
            if (typeof usageRecord?.cache_read_input_tokens === 'number') {
              usage.cacheReadTokens = usageRecord.cache_read_input_tokens;
            }
          } else if (type === 'message_delta') {
            const usageRecord = asRecord(payload.usage);
            if (typeof usageRecord?.output_tokens === 'number') usage.outputTokens = usageRecord.output_tokens;
          }
          // ping — nothing to collect
        }
      } catch (err) {
        if (isAbortError(err) || signal?.aborted === true) return cancelledResult();
        return { ...streamDroppedResult(), ...(text !== '' ? { partialText: text } : {}) };
      }
      // A stream that ends without message_stop lost the rest of the reply — but NOT what
      // it already wrote. A 30-minute build that drops at minute 28 keeps its work.
      if (!completed) return { ...streamDroppedResult(), ...(text !== '' ? { partialText: text } : {}) };
      return {
        ok: true,
        text,
        toolCalls,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
        ...(wireModel !== undefined ? { model: wireModel } : {}),
      };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
