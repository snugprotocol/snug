// local.ts — local-LLM adapter: an OpenAI-compatible endpoint on the user's machine
// (Ollama, LM Studio, llama.cpp server, …). Delegates wholesale to the OpenAI adapter —
// the wire shape is identical — and turns bare network failures into the two setup
// problems local endpoints actually have in a browser (plan F17): the endpoint not
// allowing this origin (OLLAMA_ORIGINS) and https pages blocking http://localhost.
import { ERROR_CODES } from '@snugprotocol/protocol';

import { openaiAdapter } from './openai.js';
import type { AgentAdapter, FetchLike } from './types.js';

export const LOCAL_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export interface LocalAdapterOptions {
  /** OpenAI-compatible base URL; default: Ollama's. */
  baseUrl?: string;
  model?: string;
  /** Most local servers ignore auth; a placeholder keeps the wire shape valid. */
  apiKey?: string;
  /** Output cap sent to the local server; see LOCAL_DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** Injectable for fixture-based tests — adapter tests never hit the network. */
  fetch?: FetchLike;
}

/**
 * Local servers are NOT frontier models. The OpenAI adapter defaults to a 128K output cap,
 * which is right for current hosted models but far above what a local 7B-class model can
 * emit — and some OpenAI-compatible servers reject a cap larger than the model's context
 * with a 400, which would fail every local turn. A modest default keeps local mode working;
 * override per call when the local model genuinely supports more.
 */
export const LOCAL_DEFAULT_MAX_TOKENS = 8192;

const SETUP_HINT =
  'could not reach the local model endpoint. Check that it is running, that it allows this origin ' +
  '(for Ollama: set OLLAMA_ORIGINS to include this hub, e.g. OLLAMA_ORIGINS=*), and that you are not ' +
  'loading the hub over https while the endpoint is plain http://localhost (Safari blocks that as mixed content).';

export function localAdapter(options: LocalAdapterOptions = {}): AgentAdapter {
  const inner = openaiAdapter({
    apiKey: options.apiKey ?? 'local',
    baseUrl: options.baseUrl ?? LOCAL_DEFAULT_BASE_URL,
    ...(options.model !== undefined ? { model: options.model } : {}),
    maxTokens: options.maxTokens ?? LOCAL_DEFAULT_MAX_TOKENS,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return {
    async complete(request) {
      const result = await inner.complete(request);
      if (!result.ok && result.code === ERROR_CODES.NETWORK_ERROR) {
        return { ...result, message: `${SETUP_HINT} (${result.message})` };
      }
      return result;
    },
  };
}
