// engine.ts — the ONE place the @mlc-ai/web-llm engine is created and cached.
//
// The playground builds a FRESH adapter per turn (adapter.ts contract), but a WebLLM
// engine load means downloading GB-scale weights and compiling shaders — so the engine
// is a module singleton keyed by model id, shared across adapters/turns. The dep is
// loaded via dynamic import so vite code-splits it out of the main bundle: flag-off
// visitors never fetch a byte of engine code (AC1).
//
// Types here are a narrow STRUCTURAL slice of the engine (exactly what the adapter
// consumes), so tests fake it through `setWebllmEngineLoaderForTests` and product code
// carries no type-level dependency on the lib's full surface.

import { webllmLoadStatusStore } from '../../state/webllm.js';

export interface WebllmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI-chunk-shaped slice of webllm's streaming output. */
export interface WebllmChunk {
  model?: string;
  choices?: {
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface WebllmChatRequest {
  messages: WebllmChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
}

export interface WebllmEngineLike {
  chat: {
    completions: {
      create(request: WebllmChatRequest): Promise<AsyncIterable<WebllmChunk>>;
    };
  };
  /** Stops the in-flight generation; the stream then ends early. Optional in fakes. */
  interruptGenerate?: () => void;
}

export type WebllmEngineLoader = (
  modelId: string,
  onProgress: (text: string) => void,
) => Promise<WebllmEngineLike>;

/** Production loader: dynamic import keeps the engine out of the main bundle. */
const defaultLoader: WebllmEngineLoader = async (modelId, onProgress) => {
  const webllm = await import('@mlc-ai/web-llm');
  const engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => onProgress(report.text),
  });
  // The full MLCEngine satisfies the structural slice; the cast localizes the lib type.
  return engine as unknown as WebllmEngineLike;
};

let testLoader: WebllmEngineLoader | undefined;
let cached: { modelId: string; promise: Promise<WebllmEngineLike> } | undefined;

export function setWebllmEngineLoaderForTests(loader: WebllmEngineLoader | undefined): void {
  testLoader = loader;
}

export function resetWebllmEngineForTests(): void {
  cached = undefined;
  webllmLoadStatusStore.set(undefined);
}

/**
 * The engine for `modelId`, loading it on first use. Load progress streams into
 * `webllmLoadStatusStore` for the UI. A FAILED load clears the cache entry so the
 * next turn retries (AC7) — a transient OOM must not brick the mode for the session.
 * Switching model ids replaces the cache (previous engine's GPU memory is left to the
 * browser — acceptable for the spike, the picker is GA scope).
 */
export function getWebllmEngine(modelId: string): Promise<WebllmEngineLike> {
  if (cached?.modelId === modelId) return cached.promise;
  const loader = testLoader ?? defaultLoader;
  webllmLoadStatusStore.set(`loading ${modelId}…`);
  const entry: { modelId: string; promise: Promise<WebllmEngineLike> } = {
    modelId,
    promise: loader(modelId, (text) => webllmLoadStatusStore.set(text)).then(
      (engine) => {
        webllmLoadStatusStore.set(undefined);
        return engine;
      },
      (err: unknown) => {
        if (cached === entry) cached = undefined;
        webllmLoadStatusStore.set(undefined);
        throw err;
      },
    ),
  };
  cached = entry;
  return entry.promise;
}
