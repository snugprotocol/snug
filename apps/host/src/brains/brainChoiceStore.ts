// brainChoiceStore.ts — the user's brain choice on the runner (TASK-20260922, ADR-0070;
// TASK-20261003, ADR-0071 §4–§5): WHICH of their own agents answers (`auto`, or a pin), and
// each brain's model and thinking level. ONE store the brain chip renders and the local
// adapter reads AT CALL TIME, so a switch changes the NEXT think and spends nothing
// (ADR-0036 rule 3; ADR-0067 rule 3).
//
// PER-MACHINE and GLOBAL across every app (Gate 1 Q2, owner). The choice lives in THIS browser
// at the runner's origin and is NEVER written to the user file — not exported, not written into
// the page on save — so nothing here reaches `packages/protocol`. A model id that travelled with
// a file would name a model the receiving machine's agent may not have, and would break on
// arrival; ADR-0036 D1 rejected the same idea for the same reason on the other binding.
//
// PER BRAIN, in that brain's own words. The store holds no list of levels: what a brain
// offers is what the runner reports for it (`brains`), and nothing maps one brain's
// vocabulary onto another's — as ADR-0070 refused to map the CLI's `--effort` onto
// ADR-0067's `quick | default | complex`. A stored level is therefore not judged when it is
// READ (the runner's status arrives after this store is built): it is judged when it is SET,
// here, and when it is USED, by the composition.
//
// What the chip SHOWS is what ANSWERED, never what was asked (AC5, ADR-0059 rules 2 and 4):
// `answered` is fed by the runner's own report of the brain and the model that ran, so a
// substitution or a refusal is visible in words instead of a chip naming a model that never
// ran. It is this boot's knowledge and is not stored.

import { BRAIN_AUTO, brainLevels } from '@playground/platform/copy';
import { createStore } from '@playground/state/store';

export const BRAIN_CHOICE_STORAGE_KEY = 'snug-host:brain-choice';

/** The version of the stored shape. A value of any other version is not guessed at. */
const STORED_VERSION = 2;

/**
 * The brain the single-brain forms are about. Before the registry the store held one
 * `{ model?, effort? }` and the only brain was the user's `claude` CLI, so that is whose
 * preferences they were — and it is the entry the chat route's top-level `model` / `effort`
 * still mean (ADR-0071, B2).
 */
export const LEGACY_BRAIN = 'claude';

/** One brain's model and thinking level. Both absent = the brain's own defaults. */
export interface BrainPrefs {
  model?: string;
  effort?: string;
}

/** What the last think REPORTED: the brain that answered and the model it resolved. */
export interface BrainAnswered {
  brain: string;
  model?: string;
}

/** A refusal in the brain's own sentence, against the brain that gave it. */
export interface BrainRefused {
  brain: string;
  message: string;
}

export interface BrainChoiceState {
  /** `auto`, or the id of the brain the user pinned. */
  choice: string;
  prefs: Readonly<Record<string, BrainPrefs>>;
  answered?: BrainAnswered;
  /** Standing until a think answers again. */
  refused?: BrainRefused;
}

/** What the store needs to know of a brain to refuse a dead pin or a level it lacks: its wire entry. */
export interface BrainFacts {
  id: string;
  state: string;
  efforts: readonly string[];
  models: readonly { id: string; efforts: readonly string[] }[];
}

/** The slice of `localStorage` the store uses. */
export interface BrainChoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrainChoiceStore {
  /** A STABLE object until something changes — the chip reads it through `useSyncExternalStore`. */
  get(): BrainChoiceState;
  subscribe(listener: () => void): () => void;
  /** `auto`, or a brain that is READY. Throws on anything else: a pin that cannot answer is a dead control. */
  choose(id: string): void;
  /** The model for that brain's NEXT think; blank or undefined clears it back to the brain's default. */
  setModel(brain: string, model: string | undefined): void;
  /** The level for that brain's NEXT think; undefined clears it. Throws on a level the brain lacks. */
  setEffort(brain: string, effort: string | undefined): void;
  /** A think answered. Clears any standing refusal. */
  markAnswered(answered: BrainAnswered): void;
  /** A think was refused. What answered before is left as it was. */
  markRefused(refused: BrainRefused): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const clean = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** One brain's entry, with only what is well-formed; `undefined` when nothing is. */
function prefsOf(value: unknown): BrainPrefs | undefined {
  if (!isRecord(value)) return undefined;
  const model = clean(value.model);
  const effort = clean(value.effort);
  if (model === undefined && effort === undefined) return undefined;
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

type Stored = Pick<BrainChoiceState, 'choice' | 'prefs'>;

const NOTHING_CHOSEN: Stored = { choice: BRAIN_AUTO, prefs: {} };

/** What storage holds, as this build's shape. Total: denied, corrupt or unknown reads as nothing chosen. */
function parseStored(saved: string | null | undefined): Stored {
  if (typeof saved !== 'string' || saved === '') return NOTHING_CHOSEN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return NOTHING_CHOSEN;
  }
  if (!isRecord(parsed)) return NOTHING_CHOSEN;
  if (parsed.v === undefined) {
    // THE PRE-TASK SHAPE, `{ model?, effort? }` — the one brain there was (TASK-20260922).
    const legacy = prefsOf(parsed);
    return { choice: BRAIN_AUTO, prefs: legacy === undefined ? {} : { [LEGACY_BRAIN]: legacy } };
  }
  // A later build's shape: reading it as ours could pin a brain the user never picked.
  if (parsed.v !== STORED_VERSION) return NOTHING_CHOSEN;
  const prefs: Record<string, BrainPrefs> = {};
  if (isRecord(parsed.prefs)) {
    for (const [brain, value] of Object.entries(parsed.prefs)) {
      const entry = prefsOf(value);
      if (brain !== '' && entry !== undefined) prefs[brain] = entry;
    }
  }
  return { choice: clean(parsed.choice) ?? BRAIN_AUTO, prefs };
}

export function createBrainChoiceStore(options: {
  storage?: BrainChoiceStorage | undefined;
  /** What the runner last reported, read when a pin or a level is SET. */
  brains: () => readonly BrainFacts[];
}): BrainChoiceStore {
  const { storage, brains } = options;

  const read = (): Stored => {
    try {
      return parseStored(storage?.getItem(BRAIN_CHOICE_STORAGE_KEY));
    } catch {
      // Storage denied: no choice, which is every brain's own defaults.
      return NOTHING_CHOSEN;
    }
  };

  const store = createStore<BrainChoiceState>(read());

  /** The user's part of the state changed: keep it for this machine. */
  const update = (next: Stored): void => {
    store.set({ ...store.get(), ...next });
    try {
      storage?.setItem(BRAIN_CHOICE_STORAGE_KEY, JSON.stringify({ v: STORED_VERSION, choice: next.choice, prefs: next.prefs }));
    } catch {
      /* storage denied: the choice lives in memory for this boot */
    }
  };

  /** Replace one brain's entry; an entry with nothing in it is removed, not kept empty. */
  const withPrefs = (brain: string, entry: BrainPrefs): Stored => {
    const { [brain]: _replaced, ...others } = store.get().prefs;
    const kept = prefsOf(entry);
    return { choice: store.get().choice, prefs: kept === undefined ? others : { ...others, [brain]: kept } };
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    choose(id) {
      if (id !== BRAIN_AUTO) {
        const brain = brains().find((candidate) => candidate.id === id);
        // No dead pin (ADR-0071 §4): a pinned brain that is not ready answers nothing — the
        // demo brain would stand in — so it cannot be picked in the first place.
        if (brain?.state !== 'ready') throw new Error(`brainChoiceStore: "${id}" is not ready — a brain that cannot answer cannot be pinned`);
      }
      update({ choice: id, prefs: store.get().prefs });
    },
    setModel(brain, model) {
      const { model: _dropped, ...rest } = store.get().prefs[brain] ?? {};
      const next = clean(model);
      update(withPrefs(brain, next === undefined ? rest : { ...rest, model: next }));
    },
    setEffort(brain, effort) {
      const { effort: _dropped, ...rest } = store.get().prefs[brain] ?? {};
      if (effort === undefined) {
        update(withPrefs(brain, rest));
        return;
      }
      const facts = brains().find((candidate) => candidate.id === brain);
      if (facts === undefined) throw new Error(`brainChoiceStore: "${brain}" is not a brain this runner reported`);
      // The levels of the model this brain would run: a level it lacks is a flag its child
      // rejects, which turns a slower think into a refused one.
      const levels = brainLevels(facts, rest.model);
      if (!levels.includes(effort)) throw new Error(`brainChoiceStore: "${effort}" is not a thinking level of ${brain} (${levels.join(', ')})`);
      update(withPrefs(brain, { ...rest, effort }));
    },
    markAnswered(answered) {
      const model = clean(answered.model);
      // Answering clears a standing refusal: the chip must not keep warning about a think
      // the user has already moved past.
      const { refused: _cleared, ...rest } = store.get();
      store.set({ ...rest, answered: { brain: answered.brain, ...(model !== undefined ? { model } : {}) } });
    },
    markRefused(refused) {
      // What answered is LEFT AS IT WAS: a refused think ran on nothing, so it teaches
      // nothing about what is running. Only the refusal is new.
      store.set({ ...store.get(), refused });
    },
  };
}
