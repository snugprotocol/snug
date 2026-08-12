// Ollama autodetect store (TASK-20260812 W2b item 4; AC3) — the webllm WebGPU-probe
// pattern: 'unknown' until a PLATFORM probe answers. The web has no probe and stays
// 'unknown' forever — refreshOllama must never fall back to fishing localhost with
// page fetch (the page never probes ports on its own).
//
// Platform is set-once, so every case takes a fresh module registry.
import { describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

const DESKTOP_CAPS = { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } as const;

async function fresh(platform?: SnugPlatform): Promise<typeof import('../state/ollama.js')> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  return import('../state/ollama.js');
}

describe('refreshOllama', () => {
  it('web (no probe): stays unknown and NEVER touches page fetch', async () => {
    const ollama = await fresh();
    const pageFetch = vi.spyOn(globalThis, 'fetch');

    await ollama.refreshOllama();

    expect(ollama.ollamaStore.get()).toBe('unknown');
    expect(pageFetch, 'no fetch fallback on web — the probe is platform-only').not.toHaveBeenCalled();
    pageFetch.mockRestore();
  });

  it('desktop: the platform probe result lands in the store', async () => {
    const ollama = await fresh({
      kind: 'desktop',
      probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2', 'qwen3:4b'] }),
      capabilities: DESKTOP_CAPS,
    });

    await ollama.refreshOllama();

    expect(ollama.ollamaStore.get()).toEqual({ running: true, models: ['llama3.2', 'qwen3:4b'] });
  });

  it('desktop, no Ollama: a not-running answer is stored as-is', async () => {
    const ollama = await fresh({
      kind: 'desktop',
      probeOllama: () => Promise.resolve({ running: false, models: [] }),
      capabilities: DESKTOP_CAPS,
    });

    await ollama.refreshOllama();

    expect(ollama.ollamaStore.get()).toEqual({ running: false, models: [] });
  });

  it('a throwing probe is absence, never a crash (webllm pattern)', async () => {
    const ollama = await fresh({
      kind: 'desktop',
      probeOllama: () => Promise.reject(new Error('ipc broke')),
      capabilities: DESKTOP_CAPS,
    });

    await ollama.refreshOllama();

    expect(ollama.ollamaStore.get()).toEqual({ running: false, models: [] });
  });
});
