// model-catalog.test.ts — TASK-20260817-per-app-model-selector AC2.
//
// The catalog is a PINNED, reviewed list of popular models per provider — deliberately
// not a live `/models` fetch (owner decision 2): a keyed network call has no Anthropic
// browser equivalent, and a hardcoded list is deterministic and testable.
//
// Two properties are load-bearing and both are asserted structurally rather than by
// eyeballing the literal:
//
//   1. The ≤5 bound is the OWNER'S ask ("up to 5"). A sixth entry must red this file,
//      not slip in unnoticed — a selector that quietly grows to 9 options is a different
//      control than the one that was approved.
//   2. Each provider's list CONTAINS that provider's existing `*_DEFAULT_MODEL`. Without
//      this the catalog and the default constant can drift apart, and the drift is
//      invisible: the Settings default would name a model the per-app selector cannot
//      offer, so an app could never be returned to its own inherited default through the
//      control (AC3's inherited option would render a value absent from the list).
//      Pinning it here means the two literals can never disagree.

import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  POPULAR_MODELS,
  popularModelsFor,
  type PopularModel,
} from '../index.js';

/** The owner's "up to 5" — the whole point of the bound is that it cannot be widened silently. */
const MAX_POPULAR_MODELS = 5;

describe('popular model catalog (AC2)', () => {
  it('offers between 1 and 5 models for every provider it knows', () => {
    const providers = Object.keys(POPULAR_MODELS) as (keyof typeof POPULAR_MODELS)[];
    // A catalog with no providers would pass every per-provider assertion below by
    // vacuity, so the shape is asserted first.
    expect(providers.length).toBeGreaterThan(0);

    for (const provider of providers) {
      const models = popularModelsFor(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(models.length).toBeLessThanOrEqual(MAX_POPULAR_MODELS);
    }
  });

  it('gives every entry a non-empty id and a non-empty label', () => {
    for (const provider of Object.keys(POPULAR_MODELS) as (keyof typeof POPULAR_MODELS)[]) {
      for (const model of popularModelsFor(provider)) {
        expect(model.id).toBeTypeOf('string');
        expect(model.id.trim()).not.toBe('');
        expect(model.label).toBeTypeOf('string');
        expect(model.label.trim()).not.toBe('');
      }
    }
  });

  it('never lists the same model id twice within one provider', () => {
    for (const provider of Object.keys(POPULAR_MODELS) as (keyof typeof POPULAR_MODELS)[]) {
      const ids = popularModelsFor(provider).map((m: PopularModel) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // The anti-drift pin. If someone edits ANTHROPIC_DEFAULT_MODEL without touching the
  // catalog (or prunes the default out of the catalog), this reds — which is exactly the
  // failure that would otherwise surface as "the inherited default isn't in my dropdown".
  it("contains each provider's own default model", () => {
    expect(popularModelsFor('anthropic').map((m) => m.id)).toContain(ANTHROPIC_DEFAULT_MODEL);
    expect(popularModelsFor('openai').map((m) => m.id)).toContain(OPENAI_DEFAULT_MODEL);
  });

  it('answers for both byok providers that can carry a model', () => {
    // `mock` deliberately has no catalog: it names no real model, and the selector is
    // hidden for it (AC7). Asking for it must not throw — it answers empty, so a caller
    // that forgets to gate renders no options rather than crashing the run header.
    expect(popularModelsFor('anthropic').length).toBeGreaterThan(0);
    expect(popularModelsFor('openai').length).toBeGreaterThan(0);
    expect(popularModelsFor('mock')).toEqual([]);
  });
});
