// webllm.ts — the experimental in-browser brain (AL-07 / roadmap A7, ADR-0015).
//
// Activation is a URL flag (`?webllm=1`), NOT a mode: the persisted PlaygroundMode
// union and the settings mode picker are untouched — webllm must not appear as a
// first-class equal of byok/local/subscription until GA (1.2). When the flag is on,
// `resolveBrain` OVERRIDES whatever mode is configured:
//
//   flag off            → { kind: 'settings' }  (the playground behaves exactly as before)
//   flag on + WebGPU    → { kind: 'webllm' }    (turns run through the in-browser engine)
//   flag on, no WebGPU  → { kind: 'demo' }      (graceful fallback to the demo brain + banner)
//
// This function is THE decision line — every consumer (builder chat, app-frame
// transport, banner, settings card) reads it, and the tests assert here first
// (lessons 2026-08-05: test where the decision is made).

import { useMemo } from 'react';

import { WEBLLM_DEFAULT_MODEL } from '../agent/webllm/model.js';
import { useMode, type PlaygroundMode } from './mode.js';
import { createStore, useStore, type Store } from './store.js';

export const WEBLLM_FLAG_PARAM = 'webllm';

/** Pinned banner copy (task-file contract; asserted verbatim by unit + e2e tests). */
export const WEBLLM_FALLBACK_BANNER = 'this browser can’t run local models — showing the demo brain';

export type WebGpuStatus = 'unknown' | 'yes' | 'no';

export const webllmFlagStore: Store<boolean> = createStore<boolean>(false);
export const webgpuStore: Store<WebGpuStatus> = createStore<WebGpuStatus>('unknown');
/** Engine download/compile progress text while a model loads; undefined when idle. */
export const webllmLoadStatusStore: Store<string | undefined> = createStore<string | undefined>(undefined);

/**
 * `?webllm=1` exactly — an experimental flag should not answer to creative spellings.
 *
 * STICKY-FOR-SESSION (review 2026-08-06, finding 2 — deliberate): the flag is parsed
 * once at boot and ARMS the experiment for the whole SPA session. In-app navigation
 * drops the query string (`/run/:id` after a webllm build carries no flag), so
 * re-parsing on location change would silently kick a mid-flow user back to their
 * configured mode the moment they click anywhere — building with webllm and then
 * running the app on a different brain. Leaving the experiment is a hard reload
 * without the flag; the settings card says exactly that.
 */
export function parseWebllmFlag(search: string): boolean {
  return new URLSearchParams(search).get(WEBLLM_FLAG_PARAM) === '1';
}

/** Minimal structural slice of `navigator.gpu` — injectable for tests. */
export interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

/**
 * WebGPU presence = an ADAPTER actually answers. `'gpu' in navigator` alone lies:
 * browsers ship the API object on platforms where no adapter exists (software-only,
 * blocklisted GPUs), and `requestAdapter()` resolving null is the documented signal.
 * A probe failure is absence, never a crash — fallback is the safe direction.
 */
export async function detectWebGpu(gpu: GpuLike | undefined): Promise<boolean> {
  if (gpu === undefined) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
}

export type Brain =
  | { kind: 'settings' }
  | { kind: 'webllm'; model: string }
  | { kind: 'demo'; reason: 'no-webgpu' | 'probing' };

/** The one decision line (see module comment). 'unknown' never yields webllm: a turn
 * sent before the probe lands falls back to demo silently rather than racing the GPU. */
export function resolveBrain(flagOn: boolean, webgpu: WebGpuStatus): Brain {
  if (!flagOn) return { kind: 'settings' };
  if (webgpu === 'yes') return { kind: 'webllm', model: WEBLLM_DEFAULT_MODEL };
  return { kind: 'demo', reason: webgpu === 'no' ? 'no-webgpu' : 'probing' };
}

/** Non-hook read for factories (transport creation happens outside render). */
export function currentBrain(): Brain {
  return resolveBrain(webllmFlagStore.get(), webgpuStore.get());
}

export function useBrain(): Brain {
  const flag = useStore(webllmFlagStore);
  const gpu = useStore(webgpuStore);
  return useMemo(() => resolveBrain(flag, gpu), [flag, gpu]);
}

export function useWebllmFlag(): boolean {
  return useStore(webllmFlagStore);
}

/**
 * What kind of turn actually RUNS right now — the configured mode with the brain
 * override applied. THE one derivation (review 2026-08-06, finding 3): every surface
 * whose copy or behavior depends on "where do turns execute" (run-rail empty states,
 * the builder's server-turn branches) must consume this, never the raw mode, because
 * the brain makes the raw mode lie. The demo fallback runs the mock adapter through
 * the byok path, so it reports as 'byok'.
 */
export type TurnMode = PlaygroundMode | 'webllm';

export function resolveTurnMode(brain: Brain, mode: PlaygroundMode): TurnMode {
  if (brain.kind === 'webllm') return 'webllm';
  if (brain.kind === 'demo') return 'byok';
  return mode;
}

export function useTurnMode(): TurnMode {
  const brain = useBrain();
  const mode = useMode();
  return resolveTurnMode(brain, mode);
}

export interface InitWebllmOptions {
  /** Defaults to the page's location.search. */
  search?: string;
  /** Defaults to the page's navigator.gpu. Pass explicitly in tests. */
  gpu?: GpuLike | undefined;
}

/**
 * Boot hook (App effect; StrictMode-safe — idempotent). The gpu probe runs ONLY when
 * the flag is on: flag-off must leave zero webllm footprint, probe included (AC1).
 */
export async function initWebllm(options: InitWebllmOptions = {}): Promise<void> {
  const search = options.search ?? globalThis.location?.search ?? '';
  const flagOn = parseWebllmFlag(search);
  webllmFlagStore.set(flagOn);
  if (!flagOn) {
    webgpuStore.set('unknown');
    return;
  }
  const gpu =
    'gpu' in options ? options.gpu : (globalThis.navigator as Navigator & { gpu?: GpuLike }).gpu;
  webgpuStore.set((await detectWebGpu(gpu)) ? 'yes' : 'no');
}
