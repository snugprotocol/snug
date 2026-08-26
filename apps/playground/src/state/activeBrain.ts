// activeBrain.ts — what a turn sent RIGHT NOW would run on (TASK-20260826, ADR-0059).
//
// The live half of the ONE routing derivation: `adapterKindFor` (agent/adapter.ts)
// decides per constructed adapter; this module evaluates it against the CURRENT
// stores — the webllm brain override, the mode, the resolved default provider, and
// synchronous key presence — so disclosure surfaces (the brain chip, the demo
// callout) can never disagree with where the next turn actually executes. In
// particular the silent fall-through is surfaced here: a chosen provider whose key
// is missing routes to the demo brain, and this derivation says so.
//
// Scope note: per-app model/provider PINS can route one app's turns to the other
// KEYED provider — the run header's own selector owns that story. This derivation
// describes the global default route, which is also the only route that can land
// on the demo brain while a real brain is configured.

import { adapterKindFor, type AdapterKind } from '../agent/adapter.js';
import { byokKeyPresenceStore, modeStore, providerStore } from './mode.js';
import { useStore } from './store.js';
import { resolveBrain, webgpuStore, webllmFlagStore } from './webllm.js';

export type ActiveBrainKind = AdapterKind | 'subscription';

export function resolveActiveBrain(): ActiveBrainKind {
  // The experimental brain override wins over the configured mode (ADR-0015): its
  // demo fallback runs the mock adapter through the byok path, exactly like
  // useBuilderChat's `brain.kind === 'demo'` arm. A 'probing' fallback also reads
  // as demo — a turn sent before the WebGPU probe lands runs on the mock adapter.
  const brain = resolveBrain(webllmFlagStore.get(), webgpuStore.get());
  if (brain.kind === 'webllm') return 'webllm';
  if (brain.kind === 'demo') return 'demo';
  const mode = modeStore.get();
  if (mode === 'subscription') return 'subscription';
  const provider = providerStore.get();
  const keys = byokKeyPresenceStore.get();
  const hasKey = provider === 'anthropic' || provider === 'openai' ? keys[provider] : false;
  // `adapterKindFor` reads key PRESENCE only (`!== undefined`) — pinned by the AC1
  // suite — so a placeholder stands in for the value this module must never touch.
  return adapterKindFor({ mode, provider, ...(hasKey ? { key: 'present' } : {}) });
}

/** Store-reactive read for the chip and callout: re-renders on any feeding store. */
export function useActiveBrain(): ActiveBrainKind {
  useStore(webllmFlagStore);
  useStore(webgpuStore);
  useStore(modeStore);
  useStore(providerStore);
  useStore(byokKeyPresenceStore);
  return resolveActiveBrain();
}
