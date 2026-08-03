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
  /** Injectable for fixture-based tests — adapter tests never hit the network. */
  fetch?: FetchLike;
}

const SETUP_HINT =
  'could not reach the local model endpoint. Check that it is running, that it allows this origin ' +
  '(for Ollama: set OLLAMA_ORIGINS to include this hub, e.g. OLLAMA_ORIGINS=*), and that you are not ' +
  'loading the hub over https while the endpoint is plain http://localhost (Safari blocks that as mixed content).';

export function localAdapter(options: LocalAdapterOptions = {}): AgentAdapter {
  const inner = openaiAdapter({
    apiKey: options.apiKey ?? 'local',
    baseUrl: options.baseUrl ?? LOCAL_DEFAULT_BASE_URL,
    ...(options.model !== undefined ? { model: options.model } : {}),
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
