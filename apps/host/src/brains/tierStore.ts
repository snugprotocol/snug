// tierStore.ts — the thinking-level choice (TASK-20260906-host-brain-tier-control, ADR-0067):
// ONE store the brain chip renders (through the platform's `TierSeat`) and both sample
// adapters read AT CALL TIME (`tierFor(purpose)`), so a switch changes the next call and
// spends nothing. `auto` is today's per-purpose pins — app replies on `quick` (T1 S3), building
// and inferring on `default` (T4 S11) — and an explicit tier overrides every purpose.
//
// The choice lives in THIS browser at the artifact origin (`localStorage`, T1 S4b: 5 ms),
// never in the user file (not exported, not written into the page on save); where storage
// throws (Safari's denied third-party rung) it lives in memory for this boot. A tier the
// viewer's plan lacks is unknowable at boot (`limits()` names no tiers — sample.d.ts) and is
// learned from `modelTierApplied`: the asked tier is marked unavailable (listed, disabled,
// annotated) and the selection falls back to what answered. The mark, the note and the
// fallback are all PER BOOT — only the user's own choice is ever written, so a plan that
// changes is learned again on the next boot and the stored preference stays the user's
// (review residual 1). The note describes the substitution that disabled the option and
// lives as long as the mark does (review C1).

import type { HostModelTier, TierChoice, TierSeat, TierState } from '@playground/platform/platform';
import { createStore } from '@playground/state/store';

export type { HostModelTier, TierChoice, TierSeat, TierState };

export const TIER_STORAGE_KEY = 'snug-host:tier';
/** The contract's three tiers, in the order the chip lists them (sample.d.ts 0.2.41). */
export const HOST_TIER_OPTIONS: readonly HostModelTier[] = ['quick', 'default', 'complex'];
/** `modelTier` omitted = `default` — "the balanced everyday model" (sample.d.ts). */
export const VIEWER_DEFAULT_TIER: HostModelTier = 'default';
export type TierPurpose = 'app' | 'chat';
/** `auto`: the per-purpose pins T4 measured (AC1) — unchanged by this task. */
export const AUTO_TIERS: Readonly<Record<TierPurpose, HostModelTier>> = { app: 'quick', chat: 'default' };

const CHOICES: readonly TierChoice[] = ['auto', ...HOST_TIER_OPTIONS];
const isChoice = (value: unknown): value is TierChoice => typeof value === 'string' && (CHOICES as readonly string[]).includes(value);
const isTier = (value: unknown): value is HostModelTier => typeof value === 'string' && (HOST_TIER_OPTIONS as readonly string[]).includes(value);

/** The slice of `localStorage` the store uses. */
export interface TierStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TierStore {
  get(): TierState;
  subscribe(listener: () => void): () => void;
  /** The user's choice — what the NEXT call carries. Never calls the model. */
  set(choice: TierChoice): void;
  /** What the NEXT call for `purpose` carries — the choice, or under `auto` the purpose's pin, resolved through the unavailable marks. */
  tierFor(purpose: TierPurpose): HostModelTier;
  /** What a call asked for and what answered (`modelTierApplied`). */
  markApplied(asked: HostModelTier, answered: HostModelTier): void;
  seat(): TierSeat;
}

export function createTierStore(options: { storage?: TierStorage | undefined }): TierStore {
  const storage = options.storage;
  const read = (): TierChoice => {
    try {
      const saved = storage?.getItem(TIER_STORAGE_KEY);
      return isChoice(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  };
  const write = (choice: TierChoice): void => {
    try {
      storage?.setItem(TIER_STORAGE_KEY, choice);
    } catch {
      /* storage denied: the choice lives in memory for this boot */
    }
  };
  const store = createStore<TierState>({ choice: read(), unavailable: {} });

  const choose = (choice: TierChoice, persist: boolean): void => {
    const current = store.get();
    if (current.choice === choice) return;
    store.set({ ...current, choice });
    if (persist) write(choice);
  };

  const set = (choice: TierChoice): void => {
    if (!isChoice(choice)) throw new Error(`tierStore: "${String(choice)}" is not a thinking level (auto, quick, default, complex)`);
    choose(choice, true);
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    set,
    tierFor(purpose) {
      const { choice, unavailable } = store.get();
      const asked = choice === 'auto' ? AUTO_TIERS[purpose] : choice;
      return unavailable[asked] ?? asked;
    },
    markApplied(asked, answered) {
      // A host that answers outside the contract's tiers (review C2) teaches nothing: never adopt
      // an unknown value as the choice, never write it.
      if (!isTier(asked) || !isTier(answered)) return;
      const current = store.get();
      if (asked === answered) {
        // Honoured: clear the mark on THIS tier if it carried one, and the note if it was about it.
        if (current.unavailable[asked] === undefined) return;
        const unavailable = { ...current.unavailable };
        delete unavailable[asked];
        const keepNote = current.applied !== undefined && current.applied.asked !== asked;
        store.set({ choice: current.choice, unavailable, ...(keepNote ? { applied: current.applied } : {}) });
        return;
      }
      store.set({ ...current, applied: { asked, answered }, unavailable: { ...current.unavailable, [asked]: answered } });
      // The selection follows what answered — an explicit ask the plan lacks falls back (in memory
      // only: the stored preference stays the user's); a choice changed meanwhile, and `auto`, stay.
      if (current.choice === asked) choose(answered, false);
    },
    seat: () => ({
      options: HOST_TIER_OPTIONS,
      viewerDefault: VIEWER_DEFAULT_TIER,
      auto: AUTO_TIERS,
      state: { get: store.get, subscribe: store.subscribe },
      set,
    }),
  };
}
