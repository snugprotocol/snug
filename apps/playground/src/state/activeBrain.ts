// activeBrain.ts — what a turn sent RIGHT NOW would run on (TASK-20260826, ADR-0059).
//
// The live half of the ONE routing derivation: `adapterKindFor` (agent/adapter.ts)
// decides per constructed adapter; this module evaluates it against the CURRENT
// stores so disclosure surfaces (the brain chip, the demo callout) can never
// disagree with where the next turn actually executes. In particular the silent
// fall-through is surfaced here: a chosen provider whose key is missing routes to
// the demo brain, and this derivation says so.
//
// The send path layers MORE than the global stores (Gate-5 review — the lesson
// entry of 2026-08-26): this derivation models, in the send path's own order,
//   1. the webllm brain override (ADR-0015 — outranks the configured mode; its
//      demo fallback runs the mock adapter through byok, exactly like
//      useBuilderChat's `brain.kind === 'demo'` arm),
//   2. the subscription short-circuit,
//   3. the FRESH-THREAD builder pick (useBuilderChat: applied only under
//      `byok && provider !== 'mock'` — mirrored here verbatim, because a pick to
//      a keyed provider can make the real route differ from the resolved default
//      in BOTH directions),
//   4. the byok/local leaf via `adapterKindFor` on key presence.
//
// KNOWN EXCLUSION (queued in next-steps, not a claim of impossibility): the
// PER-APP provider pin (`builder.ts` `appProviderPinFor`) resolves per send for
// app-attached threads and is NOT modeled — a pinned provider whose key was
// deleted runs demo turns while this derivation names the global brain. The
// per-turn `brainKind` tag (stamped from the actual send config) and the model
// selector's "(key missing)" rendering are the disclosure for that state until
// the chip gains per-route context.

import { adapterKindFor, type AdapterKind } from '../agent/adapter.js';
import { builderPickStore, type BuilderPick } from './builderModel.js';
import {
  byokKeyPresenceStore,
  modeStore,
  providerStore,
  type ByokProvider,
  type KeyedProvider,
  type PlaygroundMode,
} from './mode.js';
import { useStore } from './store.js';
import { currentBrain, useBrain, type Brain } from './webllm.js';

export type ActiveBrainKind = AdapterKind | 'subscription';

/** Everything the resolution reads — one input type, so the hook's subscribe list
    and the resolver's read list cannot drift (the useTurnMode house pattern). */
export interface ActiveBrainInputs {
  brain: Brain;
  mode: PlaygroundMode;
  /** The RESOLVED default provider (mode.ts AC9 resolution). */
  provider: ByokProvider;
  keys: Record<KeyedProvider, boolean>;
  builderPick: BuilderPick | undefined;
}

export function resolveActiveBrainFrom(inputs: ActiveBrainInputs): ActiveBrainKind {
  if (inputs.brain.kind === 'host') return 'host'; // the platform pin outranks everything (P2)
  if (inputs.brain.kind === 'webllm') return 'webllm';
  if (inputs.brain.kind === 'demo') return 'demo';
  const { mode } = inputs;
  if (mode === 'subscription') return 'subscription';
  // The fresh-thread pick, under the send path's exact guard (useBuilderChat):
  // never under a mock default, byok only. An attached thread ignores the pick on
  // the send path too (the app's own pin governs there — see the exclusion above).
  const provider =
    mode === 'byok' && inputs.provider !== 'mock' && inputs.builderPick !== undefined
      ? inputs.builderPick.provider
      : inputs.provider;
  const hasKey = provider === 'anthropic' || provider === 'openai' ? inputs.keys[provider] : false;
  return adapterKindFor({ mode, provider, hasKey });
}

/** Non-hook read (factories, tests) — the currentBrain() precedent. */
export function resolveActiveBrain(): ActiveBrainKind {
  return resolveActiveBrainFrom({
    brain: currentBrain(),
    mode: modeStore.get(),
    provider: providerStore.get(),
    keys: byokKeyPresenceStore.get(),
    builderPick: builderPickStore.get(),
  });
}

/** Store-reactive read for the chip and callout. */
export function useActiveBrain(): ActiveBrainKind {
  return resolveActiveBrainFrom({
    brain: useBrain(),
    mode: useStore(modeStore),
    provider: useStore(providerStore),
    keys: useStore(byokKeyPresenceStore),
    builderPick: useStore(builderPickStore),
  });
}
