// brainChoiceStore.ts — the model and thinking-level choice for Binding B's CLI brain
// (TASK-20260922, ADR-0067's sibling for the other binding). ONE store the brain chip renders
// and the local adapter reads AT CALL TIME, so a switch changes the NEXT think and spends
// nothing (ADR-0036 rule 3; ADR-0067 rule 3).
//
// PER-MACHINE and GLOBAL across every app (Gate 1 Q2, owner). The choice lives in THIS browser
// at the artifact origin and is NEVER written to the user file — not exported, not written into
// the page on save — so nothing here reaches `packages/protocol`. A model id that travelled with
// a file would name a model the receiving machine's CLI may not have, and would break on
// arrival; ADR-0036 D1 rejected the same idea for the same reason on the other binding.
//
// The effort axis is the CLI's own `--effort` (measured on 2.1.278). It is deliberately NOT
// ADR-0067's `quick | default | complex`, which is the artifact runtime's `modelTier` contract
// on Binding A: a different axis on a different binding, and no mapping between them is
// invented (Gate 1 Q3).
//
// What the chip SHOWS is what ANSWERED, never what was asked (AC5, ADR-0059 rules 2 and 4):
// `active()` is fed by the brain's own report of the model the CLI resolved, so a substitution
// or a refusal is visible in words instead of a chip confidently naming a model that never ran.

import { createStore } from '@playground/state/store';

export const BRAIN_CHOICE_STORAGE_KEY = 'snug-host:brain-choice';

/** The thinking levels `claude --effort` documents (measured, 2.1.278). */
export const BRAIN_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type BrainEffortChoice = (typeof BRAIN_EFFORT_OPTIONS)[number];
const isEffort = (value: unknown): value is BrainEffortChoice => typeof value === 'string' && (BRAIN_EFFORT_OPTIONS as readonly string[]).includes(value);

/** What the NEXT think carries. Both absent = the CLI's own defaults, and argv unchanged. */
export interface BrainChoice {
  model?: string | undefined;
  effort?: BrainEffortChoice | undefined;
}

/** What the LAST think reported — the only thing the chip may call active. */
export interface BrainActive {
  /** The model id the CLI resolved, learned from a think that answered. */
  model?: string | undefined;
  /** A refusal in the CLI's own words, kept until a think answers again. */
  refusal?: string | undefined;
}

/** The slice of `localStorage` the store uses. */
export interface BrainChoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrainChoiceStore {
  choice(): BrainChoice;
  active(): BrainActive;
  subscribe(listener: () => void): () => void;
  /** The model for the NEXT think; blank or undefined clears it back to the CLI's default. */
  setModel(model: string | undefined): void;
  /** The effort for the NEXT think; undefined clears it. Throws on a level the CLI lacks. */
  setEffort(effort: BrainEffortChoice | undefined): void;
  /** A think answered: the id the CLI resolved. Clears any standing refusal. */
  markAnswered(resolvedModel: string): void;
  /** A think was refused, in the CLI's own words. The active model is left as it was. */
  markRefused(model: string, message: string): void;
}

interface State {
  choice: BrainChoice;
  active: BrainActive;
}

const cleanModel = (model: string | undefined): string | undefined => {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed === '' ? undefined : trimmed;
};

export function createBrainChoiceStore(options: { storage?: BrainChoiceStorage | undefined }): BrainChoiceStore {
  const storage = options.storage;

  const read = (): BrainChoice => {
    try {
      const saved = storage?.getItem(BRAIN_CHOICE_STORAGE_KEY);
      if (typeof saved !== 'string' || saved === '') return {};
      const parsed: unknown = JSON.parse(saved);
      if (parsed === null || typeof parsed !== 'object') return {};
      const { model, effort } = parsed as { model?: unknown; effort?: unknown };
      // A stored effort this CLI no longer documents is dropped rather than spawned on: the
      // child would reject the flag, turning a slower think into a refused one. The MODEL is
      // kept — it is free text validated by the CLI itself, and staleness there fails by name.
      return { ...(cleanModel(typeof model === 'string' ? model : undefined) === undefined ? {} : { model: cleanModel(model as string) }), ...(isEffort(effort) ? { effort } : {}) };
    } catch {
      // Denied, or nonsense in storage: no choice, which is the CLI's own defaults.
      return {};
    }
  };

  const store = createStore<State>({ choice: read(), active: {} });

  const write = (choice: BrainChoice): void => {
    try {
      storage?.setItem(BRAIN_CHOICE_STORAGE_KEY, JSON.stringify(choice));
    } catch {
      /* storage denied: the choice lives in memory for this boot */
    }
  };

  const update = (choice: BrainChoice): void => {
    store.set({ ...store.get(), choice });
    write(choice);
  };

  return {
    choice: () => store.get().choice,
    active: () => store.get().active,
    subscribe: store.subscribe,
    setModel(model) {
      const next = cleanModel(model);
      update({ ...store.get().choice, ...(next === undefined ? { model: undefined } : { model: next }) });
    },
    setEffort(effort) {
      if (effort !== undefined && !isEffort(effort)) {
        throw new Error(`brainChoiceStore: "${String(effort)}" is not a thinking level (${BRAIN_EFFORT_OPTIONS.join(', ')})`);
      }
      update({ ...store.get().choice, effort });
    },
    markAnswered(resolvedModel) {
      const model = cleanModel(resolvedModel);
      if (model === undefined) return;
      // Answering clears a standing refusal: the chip must not keep warning about a model
      // the user has already moved off.
      store.set({ ...store.get(), active: { model } });
    },
    markRefused(model, message) {
      const current = store.get();
      // The active model is LEFT AS IT WAS: a refused think ran on nothing, so it teaches
      // nothing about what is running. Only the refusal is new.
      store.set({ ...current, active: { ...current.active, refusal: message } });
    },
  };
}
