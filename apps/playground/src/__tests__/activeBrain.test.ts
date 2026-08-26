// activeBrain.test.ts — TASK-20260826-demo-brain-clarity AC2 (ADR-0059 rules 1/2).
//
// `resolveActiveBrain` is the LIVE half of the one derivation: what would a turn
// sent RIGHT NOW run on? It layers the webllm brain override and the subscription
// mode over `adapterKindFor`, reading the same stores the send path reads
// (`providerStore` resolved default, synchronous key presence). Tested at the
// decision line (lessons 2026-08-05): every disclosure surface consumes this, so
// this file is where the truth of the chip and the callout is pinned.

import { beforeEach, describe, expect, it } from 'vitest';

import { resolveActiveBrain } from '../state/activeBrain.js';
import { builderPickStore } from '../state/builderModel.js';
import { byokKeyPresenceStore, modeStore, providerStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';

beforeEach(() => {
  // The zero-key boot default: byok + mock, no keys, no webllm flag, no pick.
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  builderPickStore.set(undefined);
});

describe('resolveActiveBrain (AC2)', () => {
  it('is the demo brain on the zero-key default', () => {
    expect(resolveActiveBrain()).toBe('demo');
  });

  it('names the keyed provider when its key is present', () => {
    providerStore.set('anthropic');
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    expect(resolveActiveBrain()).toBe('anthropic');

    providerStore.set('openai');
    byokKeyPresenceStore.set({ anthropic: false, openai: true });
    expect(resolveActiveBrain()).toBe('openai');
  });

  it('is the demo brain for a CHOSEN provider whose key is missing — the trap case', () => {
    // resolveDefaultProvider honors an explicit choice unconditionally, so the
    // resolved provider can be 'anthropic' with no key saved (choice made, key
    // deleted). The send path falls through to the mock adapter; the surface
    // must say so.
    providerStore.set('anthropic');
    byokKeyPresenceStore.set({ anthropic: false, openai: true });
    expect(resolveActiveBrain()).toBe('demo');
  });

  it('follows the mode: local and subscription regardless of keys', () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: true });
    modeStore.set('local');
    expect(resolveActiveBrain()).toBe('local');
    modeStore.set('subscription');
    expect(resolveActiveBrain()).toBe('subscription');
  });

  it('layers the fresh-thread builder pick with the send path’s guard — the review’s worst finding', () => {
    // The dangerous direction (Gate-5 review): explicit anthropic choice whose key was
    // deleted (resolved provider stays 'anthropic', presence false) + a fresh-thread
    // pick for keyed openai. The send path routes freshPick.provider WITH a real key
    // (useBuilderChat guard: byok && provider !== 'mock' && pick) — so saying 'demo'
    // here would claim "nothing is called" while a turn spends the user's key.
    providerStore.set('anthropic');
    byokKeyPresenceStore.set({ anthropic: false, openai: true });
    builderPickStore.set({ provider: 'openai', model: 'gpt-test' });
    expect(resolveActiveBrain()).toBe('openai');

    // A pick to a provider whose key is ALSO missing still lands on demo.
    byokKeyPresenceStore.set({ anthropic: false, openai: false });
    expect(resolveActiveBrain()).toBe('demo');

    // Guard parity: under a 'mock' resolved provider the send path ignores the pick
    // (provider !== 'mock' fails), so the derivation must too.
    providerStore.set('mock');
    byokKeyPresenceStore.set({ anthropic: false, openai: true });
    expect(resolveActiveBrain()).toBe('demo');

    // And the pick is a byok concern only — local mode routes local regardless.
    providerStore.set('anthropic');
    modeStore.set('local');
    expect(resolveActiveBrain()).toBe('local');
  });

  it('the webllm brain override outranks everything: webllm on WebGPU, demo otherwise', () => {
    providerStore.set('anthropic');
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    webllmFlagStore.set(true);
    webgpuStore.set('yes');
    expect(resolveActiveBrain()).toBe('webllm');
    // No WebGPU — the documented fallback runs the mock adapter through byok.
    webgpuStore.set('no');
    expect(resolveActiveBrain()).toBe('demo');
    // Probe still in flight — a turn sent now falls back to demo, so say demo.
    webgpuStore.set('unknown');
    expect(resolveActiveBrain()).toBe('demo');
  });
});
