// ollama.ts — desktop Ollama autodetect (TASK-20260812 W2b, AC3), the webllm
// WebGPU-probe pattern (state/webllm.ts): 'unknown' until a PLATFORM probe answers.
// The web has no probe and stays 'unknown' forever — this module never falls back to
// fishing localhost with page fetch; probing ports is the shell's job, not the page's.

import { getPlatform } from '../platform/platform.js';
import { createStore, useStore, type Store } from './store.js';

export type OllamaStatus = 'unknown' | { running: boolean; models: string[] };

export const ollamaStore: Store<OllamaStatus> = createStore<OllamaStatus>('unknown');

/**
 * Boot hook (App effect; idempotent). A probe failure is absence, never a crash —
 * fallback is the safe direction, exactly like `detectWebGpu`.
 */
export async function refreshOllama(): Promise<void> {
  const probe = getPlatform().probeOllama;
  if (probe === undefined) return;
  try {
    ollamaStore.set(await probe());
  } catch {
    ollamaStore.set({ running: false, models: [] });
  }
}

export function useOllama(): OllamaStatus {
  return useStore(ollamaStore);
}
