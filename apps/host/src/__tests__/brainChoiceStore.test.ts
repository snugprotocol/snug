// brainChoiceStore.test.ts — TASK-20260922 S5 (AC4/AC5/AC6/AC8): the ONE home of the model and
// thinking-level choice for Binding B's CLI brain. PER-MACHINE and global across every app
// (Gate 1 Q2): it lives in this browser and is NEVER written to the user file, so nothing here
// reaches `packages/protocol`. The axis is the CLI's own `--effort`, deliberately NOT
// ADR-0067's `quick|default|complex` — a different axis on a different binding (Q3).
import { describe, expect, it } from 'vitest';

import { BRAIN_CHOICE_STORAGE_KEY, BRAIN_EFFORT_OPTIONS, createBrainChoiceStore, type BrainChoiceStorage } from '../brains/brainChoiceStore.js';

function memoryStorage(initial: Record<string, string> = {}): BrainChoiceStorage & { writes: [string, string][] } {
  const map = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  return {
    writes,
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

describe('the effort axis is the CLI’s own, not ADR-0067’s tiers', () => {
  it('offers exactly the five levels `claude --effort` documents (measured, 2.1.278)', () => {
    expect(BRAIN_EFFORT_OPTIONS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('is NOT the artifact runtime’s tier vocabulary — no mapping is invented (Q3)', () => {
    for (const tier of ['quick', 'default', 'complex']) {
      expect(BRAIN_EFFORT_OPTIONS as readonly string[]).not.toContain(tier);
    }
  });
});

describe('the choice is the user’s, and takes effect on the NEXT think', () => {
  it('starts with nothing chosen — the CLI’s own defaults, and argv unchanged from pre-task', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    expect(store.choice()).toEqual({});
  });

  it('remembers a model and an effort for this machine', () => {
    const storage = memoryStorage();
    const store = createBrainChoiceStore({ storage });
    store.setModel('haiku');
    store.setEffort('max');
    expect(store.choice()).toEqual({ model: 'haiku', effort: 'max' });
    expect(createBrainChoiceStore({ storage }).choice()).toEqual({ model: 'haiku', effort: 'max' });
  });

  it('is GLOBAL across apps: one key, with no app id in it (Gate 1 Q2)', () => {
    const storage = memoryStorage();
    createBrainChoiceStore({ storage }).setModel('opus');
    expect(storage.writes.map(([key]) => key)).toEqual([BRAIN_CHOICE_STORAGE_KEY]);
    expect(BRAIN_CHOICE_STORAGE_KEY).not.toMatch(/app/i);
  });

  it('clears a choice back to the CLI’s default', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    store.setModel('haiku');
    store.setModel(undefined);
    expect(store.choice().model).toBeUndefined();
  });

  it('never stores an effort outside the five — a rejected flag is a refused think', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    expect(() => store.setEffort('turbo' as never)).toThrow(/turbo/);
    expect(store.choice().effort).toBeUndefined();
  });

  it('treats a blank model as no choice, never as a model named ""', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    store.setModel('   ');
    expect(store.choice().model).toBeUndefined();
  });

  it('ignores a corrupted stored value rather than spawning on nonsense', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: '{not json' }) });
    expect(store.choice()).toEqual({});
  });

  it('drops a stored effort that this CLI no longer documents, keeping the model', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage({ [BRAIN_CHOICE_STORAGE_KEY]: JSON.stringify({ model: 'haiku', effort: 'ludicrous' }) }) });
    expect(store.choice()).toEqual({ model: 'haiku' });
  });

  it('notifies subscribers so the chip re-renders on a switch', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    let seen = 0;
    store.subscribe(() => { seen += 1; });
    store.setEffort('low');
    expect(seen).toBe(1);
  });

  it('survives storage that throws, in memory for this boot (the Safari rung)', () => {
    const store = createBrainChoiceStore({ storage: throwing });
    expect(() => store.setModel('haiku')).not.toThrow();
    expect(store.choice().model).toBe('haiku');
  });
});

describe('what ACTUALLY answered, never what was asked (AC5, ADR-0059 rule 2)', () => {
  it('reports no active model until a think has answered', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    store.setModel('haiku');
    expect(store.active().model).toBeUndefined();
  });

  it('reports the RESOLVED id a think came back with, not the alias asked for', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    store.setModel('haiku');
    store.markAnswered('claude-haiku-4-5-20251001');
    expect(store.active().model).toBe('claude-haiku-4-5-20251001');
  });

  it('a refused think leaves the active model as it was and records the refusal in words', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    store.markAnswered('claude-haiku-4-5-20251001');
    store.markRefused('nope-not-a-model', 'There’s an issue with the selected model (nope-not-a-model).');
    expect(store.active().model).toBe('claude-haiku-4-5-20251001');
    expect(store.active().refusal).toMatch(/nope-not-a-model/);
  });

  it('clears a refusal once a think answers again', () => {
    const store = createBrainChoiceStore({ storage: memoryStorage() });
    store.markRefused('bad', 'refused: bad');
    store.markAnswered('claude-haiku-4-5');
    expect(store.active().refusal).toBeUndefined();
  });

  it('keeps the user’s own choice after a refusal — only the machine’s report changes', () => {
    const storage = memoryStorage();
    const store = createBrainChoiceStore({ storage });
    store.setModel('nope-not-a-model');
    store.markRefused('nope-not-a-model', 'refused');
    expect(createBrainChoiceStore({ storage }).choice().model).toBe('nope-not-a-model');
  });
});
