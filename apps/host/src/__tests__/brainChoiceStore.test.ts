// brainChoiceStore.test.ts — the ONE home of the user's brain choice on the runner: WHICH of
// their own agents answers (`auto`, or a pin), and each brain's model and thinking level
// (TASK-20260922 AC4/AC5/AC6/AC8; TASK-20261003 B8, ADR-0071 §4–§5). PER-MACHINE and global
// across every app: it lives in this browser and is NEVER written to the user file, so
// nothing here reaches `packages/protocol`.
//
// MIGRATED 2026-10-03 (TASK-20261003 B8 — named in the plan), claim by claim. The store held
// ONE brain's `{ model, effort }` and a hard-coded list of Claude's five levels. It now holds
// `{ v: 2, choice, prefs: { [brainId]: { model, effort } } }`, and a level is whatever THAT
// brain's own wire entry lists. Where each old claim landed is said at its test.
import { describe, expect, it } from 'vitest';

import { BRAIN_AUTO } from '@playground/platform/copy';

import { BRAIN_CHOICE_STORAGE_KEY, createBrainChoiceStore, type BrainChoiceStorage, type BrainFacts } from '../brains/brainChoiceStore.js';

function memoryStorage(initial: Record<string, string> = {}): BrainChoiceStorage & { writes: [string, string][]; read(): unknown } {
  const map = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  return {
    writes,
    read: () => JSON.parse(map.get(BRAIN_CHOICE_STORAGE_KEY) ?? 'null') as unknown,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value]);
      map.set(key, value);
    },
  };
}

const throwing: BrainChoiceStorage = {
  getItem: () => {
    throw new Error('SecurityError: storage denied');
  },
  setItem: () => {
    throw new Error('SecurityError: storage denied');
  },
};

/** Two brains as the runner reports them: each with ITS OWN levels, per model. */
const CLAUDE: BrainFacts = {
  id: 'claude',
  state: 'ready',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  models: [
    { id: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-haiku-4-5-20251001', efforts: [] },
  ],
};
const CODEX: BrainFacts = { id: 'codex', state: 'ready', efforts: ['minimal', 'low', 'medium', 'high'], models: [{ id: 'gpt-5.5', efforts: ['low', 'high'] }] };

const make = (storage: BrainChoiceStorage | undefined = memoryStorage(), brains: readonly BrainFacts[] = [CLAUDE, CODEX]) =>
  createBrainChoiceStore({ storage, brains: () => brains });

describe('the stored shape is versioned, per brain — and the single-brain shape migrates (B8)', () => {
  it('starts with nothing chosen: auto, and no brain has a preference', () => {
    // WAS "starts with nothing chosen — the CLI’s own defaults": `{}` then, this now.
    expect(make().get()).toEqual({ choice: BRAIN_AUTO, prefs: {} });
    expect(BRAIN_AUTO).toBe('auto');
  });

  it('the PRE-TASK shape { model, effort } becomes auto + the claude entry — nothing the user chose is lost', () => {
    const store = make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify({ model: 'claude-sonnet-5', effort: 'low' }) }));
    expect(store.get()).toEqual({ choice: 'auto', prefs: { claude: { model: 'claude-sonnet-5', effort: 'low' } } });
  });

  it.each([
    ['a model alone', { model: 'haiku' }, { claude: { model: 'haiku' } }],
    ['an effort alone', { effort: 'max' }, { claude: { effort: 'max' } }],
    ['neither', {}, {}],
    ['a blank model', { model: '   ', effort: 'max' }, { claude: { effort: 'max' } }],
  ])('…with %s', (_label, legacy, prefs) => {
    expect(make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify(legacy) })).get()).toEqual({ choice: 'auto', prefs });
  });

  it('the first WRITE after a migration stores the new shape, exactly', () => {
    const storage = memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify({ model: 'claude-sonnet-5', effort: 'low' }) });
    make(storage).setEffort('claude', 'high');
    expect(storage.read()).toEqual({ v: 2, choice: 'auto', prefs: { claude: { model: 'claude-sonnet-5', effort: 'high' } } });
  });

  it('reads back what it wrote: the pin and every brain’s own preferences', () => {
    const storage = memoryStorage();
    const store = make(storage);
    store.setModel('claude', 'claude-sonnet-5-5');
    store.setEffort('claude', 'max');
    store.setModel('codex', 'gpt-5.5');
    store.choose('codex');
    const expected = { choice: 'codex', prefs: { claude: { model: 'claude-sonnet-5-5', effort: 'max' }, codex: { model: 'gpt-5.5' } } };
    expect(store.get()).toEqual(expected);
    expect(make(storage).get()).toEqual(expected);
    expect(storage.read()).toEqual({ v: 2, ...expected });
  });

  it('a version this build does not know is NOT guessed at — it reads as nothing chosen', () => {
    const future = { v: 3, selection: { brain: 'codex' }, prefs: { codex: { model: 'x' } } };
    expect(make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify(future) })).get()).toEqual({ choice: 'auto', prefs: {} });
  });

  it('a v2 value with junk in it keeps what is well-formed and drops the rest', () => {
    const stored = { v: 2, choice: 7, prefs: { claude: { model: ' sonnet ', effort: 4 }, codex: 'fast', '': { model: 'x' }, hermes: { model: '' } } };
    expect(make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify(stored) })).get()).toEqual({ choice: 'auto', prefs: { claude: { model: 'sonnet' } } });
  });

  it.each(['{not json', '"auto"', 'null', '[]', '7'])('ignores a corrupted stored value (%s) rather than spawning on nonsense', (saved) => {
    expect(make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: saved })).get()).toEqual({ choice: 'auto', prefs: {} });
  });

  it('is GLOBAL across apps: one key, with no app id in it (Gate 1 Q2)', () => {
    const storage = memoryStorage();
    make(storage).setModel('claude', 'opus');
    expect(storage.writes.map(([key]) => key)).toEqual([BRAIN_CHOICE_STORAGE_KEY]);
    expect(BRAIN_CHOICE_STORAGE_KEY).toBe('snug-host:brain-choice');
    expect(BRAIN_CHOICE_STORAGE_KEY).not.toMatch(/app/i);
  });

  it('survives storage that throws, in memory for this boot (the Safari rung)', () => {
    const store = make(throwing);
    expect(() => store.setModel('claude', 'haiku')).not.toThrow();
    expect(store.get().prefs).toEqual({ claude: { model: 'haiku' } });
  });

  it('works with NO storage at all — the guarded accessor answered undefined', () => {
    const store = createBrainChoiceStore({ storage: undefined, brains: () => [CLAUDE] });
    store.setEffort('claude', 'low');
    expect(store.get().prefs).toEqual({ claude: { effort: 'low' } });
  });
});

describe('the pin: auto, or a brain that is READY — never a dead pin (ADR-0071 §4)', () => {
  it('pins a ready brain, and goes back to auto', () => {
    const store = make();
    store.choose('codex');
    expect(store.get().choice).toBe('codex');
    store.choose('auto');
    expect(store.get().choice).toBe('auto');
  });

  it.each(['logged-out', 'outdated', 'absent', 'unknown', 'rate-limited'])('REFUSES a brain that is %s, and the choice stays where it was', (state) => {
    const store = make(memoryStorage(), [CLAUDE, { ...CODEX, state }]);
    expect(() => store.choose('codex')).toThrow(/codex.*not ready/);
    expect(store.get().choice).toBe('auto');
  });

  it('refuses a brain the runner never reported', () => {
    const storage = memoryStorage();
    const store = make(storage);
    expect(() => store.choose('hermes')).toThrow(/hermes/);
    expect(store.get().choice).toBe('auto');
    expect(storage.writes).toEqual([]);
  });

  it('auto is always choosable — with no brain reported at all', () => {
    const store = make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify({ v: 2, choice: 'codex', prefs: {} }) }), []);
    expect(() => store.choose('auto')).not.toThrow();
    expect(store.get().choice).toBe('auto');
  });

  it('a pin whose brain LATER stops being ready stays the user’s pin — the store re-routes nothing', () => {
    // What then answers is the demo brain (the composition's rule, never another brain);
    // the store's part is not to move the choice behind the user's back.
    let brains: readonly BrainFacts[] = [CLAUDE, CODEX];
    const store = createBrainChoiceStore({ storage: memoryStorage(), brains: () => brains });
    store.choose('codex');
    brains = [CLAUDE, { ...CODEX, state: 'logged-out' }];
    expect(store.get().choice).toBe('codex');
  });
});

describe('the model and the level are per brain, in that brain’s own words (ADR-0071 §5)', () => {
  it('has NO level list of its own: a level is whatever the brain’s wire entry lists', () => {
    // WAS "offers exactly the five levels `claude --effort` documents": the page's own list
    // (`BRAIN_EFFORT_OPTIONS`) is gone — it was Claude's, and a second brain has other words.
    const store = make();
    store.setEffort('codex', 'minimal');
    store.setEffort('claude', 'xhigh');
    expect(store.get().prefs).toEqual({ codex: { effort: 'minimal' }, claude: { effort: 'xhigh' } });
  });

  it('never stores a level the brain lacks — a rejected flag is a refused think', () => {
    // WAS "never stores an effort outside the five".
    const store = make();
    expect(() => store.setEffort('codex', 'max')).toThrow(/"max" is not a thinking level of codex \(minimal, low, medium, high\)/);
    expect(() => store.setEffort('claude', 'turbo')).toThrow(/turbo/);
    expect(store.get().prefs).toEqual({});
  });

  it('nothing maps one vocabulary onto another: a tier word, or another brain’s level, is just a word the brain lacks', () => {
    // WAS "is NOT the artifact runtime’s tier vocabulary — no mapping is invented (Q3)".
    const store = make();
    for (const tier of ['quick', 'default', 'complex']) expect(() => store.setEffort('claude', tier)).toThrow();
    expect(() => store.setEffort('claude', 'minimal'), 'Codex has it; Claude does not').toThrow();
  });

  it('the levels are the CHOSEN MODEL’S own: a model with fewer levels takes fewer, one with none takes none', () => {
    const store = make();
    store.setModel('codex', 'gpt-5.5');
    expect(() => store.setEffort('codex', 'medium'), 'gpt-5.5 lists low and high only').toThrow(/low, high/);
    store.setEffort('codex', 'high');
    store.setModel('claude', 'claude-haiku-4-5-20251001');
    expect(() => store.setEffort('claude', 'low'), 'Haiku 4.5 has no thinking axis').toThrow();
  });

  it('a model typed by hand that the catalogue does not list takes the brain’s default levels', () => {
    const store = make();
    store.setModel('claude', 'claude-some-future-model');
    expect(() => store.setEffort('claude', 'max')).not.toThrow();
  });

  it('a level for a brain the runner never reported is refused', () => {
    expect(() => make().setEffort('hermes', 'low')).toThrow(/hermes/);
  });

  it('clearing is always allowed — back to the brain’s own default', () => {
    const store = make();
    store.setModel('claude', 'haiku');
    store.setEffort('claude', 'max');
    store.setModel('claude', undefined);
    store.setEffort('claude', undefined);
    expect(store.get().prefs).toEqual({});
  });

  it('treats a blank model as no choice, never as a model named ""', () => {
    const store = make();
    store.setModel('claude', '   ');
    expect(store.get().prefs).toEqual({});
  });

  it('one brain’s preference never touches another’s', () => {
    const store = make();
    store.setModel('claude', 'claude-sonnet-5-5');
    store.setModel('codex', 'gpt-5.5');
    store.setModel('claude', undefined);
    expect(store.get().prefs).toEqual({ codex: { model: 'gpt-5.5' } });
  });

  it('KEEPS a stored level it cannot judge yet — the vocabulary arrives with the runner’s status', () => {
    // MIGRATED from "drops a stored effort that this CLI no longer documents, keeping the
    // model". The store used to hold Claude's list and judged at read; a brain's levels now
    // come from the wire, which is empty when the store is read at boot. The drop moved to
    // where the level is USED: the composition sends and shows only a level the brain lists
    // (composeLocal.test.ts — "a stored level the brain no longer lists…").
    const store = make(memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify({ model: 'haiku', effort: 'ludicrous' }) }), []);
    expect(store.get().prefs).toEqual({ claude: { model: 'haiku', effort: 'ludicrous' } });
  });

  it('notifies subscribers, and hands them a NEW state object — the chip re-renders on a switch', () => {
    const store = make();
    const before = store.get();
    let seen = 0;
    store.subscribe(() => void (seen += 1));
    store.setEffort('claude', 'low');
    expect(seen).toBe(1);
    expect(store.get()).not.toBe(before);
    expect(store.get(), 'and the SAME object until something changes').toBe(store.get());
  });
});

describe('what ACTUALLY answered, never what was asked (AC5, ADR-0059 rule 2)', () => {
  it('reports nothing answered until a think has answered', () => {
    const store = make();
    store.setModel('claude', 'haiku');
    expect(store.get().answered).toBeUndefined();
  });

  it('reports the brain that answered and the id it resolved, not the alias asked for', () => {
    const store = make();
    store.setModel('claude', 'haiku');
    store.markAnswered({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
    expect(store.get().answered).toEqual({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
  });

  it('a brain that answered without naming a model is still the brain that answered', () => {
    const store = make();
    store.markAnswered({ brain: 'codex', model: '  ' });
    expect(store.get().answered).toEqual({ brain: 'codex' });
  });

  it('a refused think leaves what answered as it was and records the refusal AGAINST ITS BRAIN, in words', () => {
    const store = make();
    store.markAnswered({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
    store.markRefused({ brain: 'codex', message: 'Codex has reached its usage limit.' });
    expect(store.get().answered).toEqual({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
    expect(store.get().refused).toEqual({ brain: 'codex', message: 'Codex has reached its usage limit.' });
  });

  it('clears a refusal once a think answers again', () => {
    const store = make();
    store.markRefused({ brain: 'claude', message: 'refused: bad' });
    store.markAnswered({ brain: 'claude', model: 'claude-haiku-4-5' });
    expect(store.get().refused).toBeUndefined();
  });

  it('keeps the user’s own choice after a refusal — only the machine’s report changes', () => {
    const storage = memoryStorage();
    const store = make(storage);
    store.setModel('claude', 'nope-not-a-model');
    store.markRefused({ brain: 'claude', message: 'refused' });
    expect(make(storage).get().prefs).toEqual({ claude: { model: 'nope-not-a-model' } });
  });

  it('what answered is this boot’s — it is never written to storage', () => {
    const storage = memoryStorage();
    const store = make(storage);
    store.markAnswered({ brain: 'claude', model: 'claude-opus-5-5' });
    store.markRefused({ brain: 'claude', message: 'refused' });
    expect(storage.writes).toEqual([]);
  });
});
