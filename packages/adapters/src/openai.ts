// openai.ts — OpenAI Chat Completions adapter (streaming + tools).
// Reached ONLY via runAgentTurn (single choke point). Browser-safe: fetch + Web Streams.

import {
  cancelledResult,
  httpErrorResult,
  isAbortError,
  networkErrorResult,
  streamDroppedResult,
} from './errors.js';
import { parseSse, tryParseJsonRecord } from './sse.js';
import type { AdapterMessage, AdapterResult, AgentAdapter, FetchLike, TokenUsage, ToolCall } from './types.js';

export const OPENAI_DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Matches the anthropic adapter: an app build can emit a whole single-file app. */
const DEFAULT_MAX_TOKENS = 128_000;

export interface OpenAiAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Output ceiling; app builds are long, so the default matches the anthropic adapter. */
  maxTokens?: number;
  /** Injectable for fixture-based tests — adapter tests never hit the network. */
  fetch?: FetchLike;
}

/** System prompt travels as the leading `system` message; tool results as `role: "tool"`. */
function toOpenAiMessages(system: string, messages: AdapterMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      out.push({
        role: 'assistant',
        content: message.content === '' && calls.length > 0 ? null : message.content,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return out;
}

export function openaiAdapter(options: OpenAiAdapterOptions): AgentAdapter {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? OPENAI_DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async complete({ system, messages, tools, signal, onDelta }): Promise<AdapterResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            max_completion_tokens: maxTokens,
            messages: toOpenAiMessages(system, messages),
            ...(tools !== undefined && tools.length > 0
              ? {
                  tools: tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
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
      let finishReason: string | null = null;
      let wireModel: string | undefined;
      const usage: TokenUsage = {};
      const pending = new Map<number, { id: string; name: string; args: string }>();
      try {
        for await (const event of parseSse(response.body)) {
          if (event.data.trim() === '[DONE]') break;
          const chunk = tryParseJsonRecord(event.data);
          if (chunk === null) continue; // malformed block tolerated
          const choice = Array.isArray(chunk.choices) ? asRecord(chunk.choices[0]) : null;
          if (choice === null) continue;
          const delta = asRecord(choice.delta);
          if (delta !== null) {
            if (typeof delta.content === 'string' && delta.content !== '') {
              text += delta.content;
              onDelta?.(delta.content);
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const raw of delta.tool_calls) {
                const call = asRecord(raw);
                if (call === null) continue;
                const index = typeof call.index === 'number' ? call.index : 0;
                const entry = pending.get(index) ?? { id: '', name: '', args: '' };
                if (typeof call.id === 'string' && call.id !== '') entry.id = call.id;
                const fn = asRecord(call.function);
                if (fn !== null) {
                  if (typeof fn.name === 'string' && fn.name !== '') entry.name = fn.name;
                  if (typeof fn.arguments === 'string') entry.args += fn.arguments;
                }
                pending.set(index, entry);
              }
            }
          }
          if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
            finishReason = choice.finish_reason;
          }
          if (typeof chunk.model === 'string') wireModel = chunk.model;
          // Usage rides on the final chunk. OpenAI reports cache reads as
          // `prompt_tokens_details.cached_tokens` — normalized to the same TokenUsage
          // shape as Anthropic's so the UI has one contract. Absent stays absent (AC13).
          const usageRecord = asRecord(chunk.usage);
          if (usageRecord !== null) {
            if (typeof usageRecord.prompt_tokens === 'number') usage.inputTokens = usageRecord.prompt_tokens;
            if (typeof usageRecord.completion_tokens === 'number') usage.outputTokens = usageRecord.completion_tokens;
            const details = asRecord(usageRecord.prompt_tokens_details);
            if (typeof details?.cached_tokens === 'number') usage.cacheReadTokens = details.cached_tokens;
          }
        }
      } catch (err) {
        if (isAbortError(err) || signal?.aborted === true) return cancelledResult();
        return { ...streamDroppedResult(), ...(text !== '' ? { partialText: text } : {}) };
      }
      // No finish_reason means the stream died mid-reply — keep what was already written.
      if (finishReason === null) {
        return { ...streamDroppedResult(), ...(text !== '' ? { partialText: text } : {}) };
      }

      const toolCalls: ToolCall[] = [...pending.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => ({
          id: entry.id,
          name: entry.name,
          input: tryParseJsonRecord(entry.args === '' ? '{}' : entry.args) ?? {},
        }));
      return {
        ok: true,
        text,
        toolCalls,
        stopReason: finishReason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use' : 'end',
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
