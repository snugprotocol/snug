// webllmAdapter.ts — the in-browser WebLLM adapter, implementing the SAME
// AgentAdapter contract as anthropic/openai/local and reached ONLY through
// runAgentTurn — which is what makes the think panel's round_trip_start/round_trip
// feed work here for free (AC4).
//
// Tools are REFUSED, not silently dropped: @mlc-ai/web-llm@0.2.84 gates
// `ChatCompletionRequest.tools` on five 8B-class Hermes models and its hardcoded
// function-calling path throws on any custom system message — structurally
// incompatible with Snug's builder prompt (see the task file's Decisions). The
// builder's webllm branch therefore never offers tools; a request that carries them
// anyway is a caller bug and gets a typed error result (errors are data — nothing is
// thrown across this boundary).
//
// The `cache` request flag is accepted and ignored per the AdapterRequest contract
// (ADR-0012): there is no prompt cache in-browser, and the usage result carries NO
// cache fields — absent, never zero.

import { STREAM_DROPPED_CODE, type AdapterResult, type AgentAdapter, type TokenUsage } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { getWebllmEngine, type WebllmChatMessage, type WebllmEngineLike } from './engine.js';
import { WEBLLM_DEFAULT_MODEL } from './model.js';

export { WEBLLM_DEFAULT_MODEL } from './model.js';

/** Classified as HOST_ERROR at frame boundaries (protocol R5), like STREAM_DROPPED. */
export const WEBLLM_TOOLS_UNSUPPORTED_CODE = 'WEBLLM_TOOLS_UNSUPPORTED';
export const WEBLLM_LOAD_FAILED_CODE = 'WEBLLM_LOAD_FAILED';

export interface WebllmAdapterOptions {
  /** Prebuilt web-llm model id; default per ADR-0015. */
  model?: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const cancelled = (partialText: string): AdapterResult => ({
  ok: false,
  code: ERROR_CODES.CANCELLED,
  message: 'stopped',
  retryable: false,
  ...(partialText !== '' ? { partialText } : {}),
});

export function webllmAdapter(options: WebllmAdapterOptions = {}): AgentAdapter {
  const model = options.model ?? WEBLLM_DEFAULT_MODEL;
  return {
    async complete({ system, messages, tools, signal, onDelta }): Promise<AdapterResult> {
      const carriesToolTraffic =
        (tools !== undefined && tools.length > 0) ||
        messages.some(
          (entry) =>
            entry.role === 'tool' || (entry.role === 'assistant' && (entry.toolCalls?.length ?? 0) > 0),
        );
      if (carriesToolTraffic) {
        return {
          ok: false,
          code: WEBLLM_TOOLS_UNSUPPORTED_CODE,
          message:
            'the in-browser model cannot run tools (web-llm function calling is limited to 8B Hermes models ' +
            'and excludes custom system prompts) — webllm turns must be offered no tools',
          retryable: false,
        };
      }
      const isAborted = (): boolean => signal?.aborted === true;
      if (isAborted()) return cancelled('');

      let engine: WebllmEngineLike;
      try {
        engine = await getWebllmEngine(model);
      } catch (err) {
        return {
          ok: false,
          code: WEBLLM_LOAD_FAILED_CODE,
          message: `could not load the in-browser model ${model} (${message(err)}) — retrying may help; the model downloads on first use and needs WebGPU memory`,
          retryable: true,
        };
      }

      // System prompt travels as the leading system message (webllm's OpenAI-shaped
      // API); after the tool refusal above only user/assistant entries remain.
      const wireMessages: WebllmChatMessage[] = [
        { role: 'system', content: system },
        ...messages.map((entry) => ({ role: entry.role as 'user' | 'assistant', content: entry.content })),
      ];

      const onAbort = (): void => engine.interruptGenerate?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      let text = '';
      let finishReason: string | null = null;
      let wireModel: string | undefined;
      let usage: TokenUsage | undefined;
      try {
        const stream = await engine.chat.completions.create({
          messages: wireMessages,
          stream: true,
          stream_options: { include_usage: true },
          // Qwen3-family models think by default; a 4K context building a whole app
          // cannot afford think tokens, so the empty-think prefill is requested. The
          // knob is a Qwen3 template convention — never sent to other families.
          ...(model.startsWith('Qwen3') ? { extra_body: { enable_thinking: false } } : {}),
        });
        for await (const chunk of stream) {
          if (isAborted()) break;
          if (typeof chunk.model === 'string' && chunk.model !== '') wireModel = chunk.model;
          const choice = chunk.choices?.[0];
          const content = choice?.delta?.content;
          if (typeof content === 'string' && content !== '') {
            text += content;
            onDelta?.(content);
          }
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
            finishReason = choice.finish_reason;
          }
          if (chunk.usage !== undefined) {
            const mapped: TokenUsage = {};
            if (typeof chunk.usage.prompt_tokens === 'number') mapped.inputTokens = chunk.usage.prompt_tokens;
            if (typeof chunk.usage.completion_tokens === 'number') mapped.outputTokens = chunk.usage.completion_tokens;
            if (Object.keys(mapped).length > 0) usage = mapped;
          }
        }
      } catch (err) {
        if (isAborted()) return cancelled(text);
        return {
          ok: false,
          code: STREAM_DROPPED_CODE,
          message: `the in-browser model failed mid-generation (${message(err)})`,
          retryable: true,
          ...(text !== '' ? { partialText: text } : {}),
        };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }

      if (isAborted()) return cancelled(text);
      if (finishReason === null) {
        // The stream ended without a finish_reason — treat like a dropped stream and
        // keep what was already written (same rule as the network adapters).
        return {
          ok: false,
          code: STREAM_DROPPED_CODE,
          message: 'the in-browser model stream ended without finishing',
          retryable: true,
          ...(text !== '' ? { partialText: text } : {}),
        };
      }

      return {
        ok: true,
        text,
        toolCalls: [],
        stopReason: 'end',
        ...(usage !== undefined ? { usage } : {}),
        // The wire model name: what the ENGINE reports on its chunks; the configured id
        // only when chunks carried none (AC5 — the id shown is what actually ran).
        model: wireModel ?? model,
      };
    },
  };
}
