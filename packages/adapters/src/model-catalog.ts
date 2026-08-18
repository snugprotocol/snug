// model-catalog.ts — a small, PINNED list of popular models per provider.
//
// This exists so a per-app model selector can offer a short, reviewed menu instead of a
// free-text box (TASK-20260817, owner decision: "up to 5"). It is deliberately NOT a
// live `/models` fetch: that would cost a keyed network call on every render, has no
// browser-reachable Anthropic equivalent, and would make the control's contents
// untestable and dependent on the user's key working.
//
// The price of pinning is staleness — providers ship models faster than this file is
// edited. That is accepted rather than hidden: Settings keeps its free-text `model`
// field for any id not listed here, and an already-stored id that falls out of this
// catalog still resolves and is still SHOWN by the selector (AC11), so a pruned entry
// can never silently re-route an app to a model the user did not choose.
//
// Each list CONTAINS that provider's `*_DEFAULT_MODEL`. That is load-bearing, not
// tidiness: the selector renders the inherited Settings default as an option, so a
// default absent from this catalog would be a value the control could not offer — the
// user could pin a model and never get back. `model-catalog.test.ts` pins the invariant.

import { ANTHROPIC_DEFAULT_MODEL } from './anthropic.js';
import { OPENAI_DEFAULT_MODEL } from './openai.js';

/** One entry in the menu: the wire id, plus what a human should see. */
export interface PopularModel {
  /** The exact id sent as the request's `model` field. */
  readonly id: string;
  /** Short human label for the picker — never parsed, only displayed. */
  readonly label: string;
}

/**
 * The providers this catalog knows. `mock` is a real `ByokProvider` in the playground
 * but names no model at all (it is the demo brain), so it maps to an empty list rather
 * than being absent — a caller that forgets to gate renders no options instead of
 * throwing in an app header.
 */
export type CatalogProvider = 'anthropic' | 'openai' | 'mock';

/**
 * At most five per provider (the owner's ask). Ordered most-capable-first, because the
 * picker renders them in order and the first real entry is the one a user scanning the
 * list will read as the recommendation.
 */
export const POPULAR_MODELS: Readonly<Record<CatalogProvider, readonly PopularModel[]>> = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: ANTHROPIC_DEFAULT_MODEL, label: 'Claude Sonnet 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: OPENAI_DEFAULT_MODEL, label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  mock: [],
} as const;

/** The catalog for one provider; an unknown provider answers empty rather than throwing. */
export function popularModelsFor(provider: string): readonly PopularModel[] {
  return POPULAR_MODELS[provider as CatalogProvider] ?? [];
}
