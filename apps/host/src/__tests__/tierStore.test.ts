// tierStore.test.ts — TASK-20260906-host-brain-tier-control AC2/AC3/AC4 (ADR-0067): the ONE
// home of the thinking-level choice the brain chip renders and the sample adapters read at
// call time. `auto` = today's per-purpose pins (app replies quick, building default); an
// explicit tier overrides every purpose. The choice lives in this browser (localStorage at
// the artifact origin; memory where storage is denied) and never in the user file. A tier
// the viewer's plan lacks is learned only from `modelTierApplied` and is then disabled and
// annotated, the selection falling back to what answered.
import { describe, expect, it } from 'vitest';

import { AUTO_TIERS, HOST_TIER_OPTIONS, TIER_STORAGE_KEY, VIEWER_DEFAULT_TIER, createTierStore, type TierStorage } from '../brains/tierStore.js';

function memoryStorage(initial: Record<string, string> = {}): TierStorage & { writes: [string, string][] } {
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

const throwing: TierStorage = {
  getItem: () => {
    throw new Error('SecurityError: storage denied');
  },
  setItem: () => {
    throw new Error('SecurityError: storage denied');
  },
};

describe('the contract facts pinned (sample.d.ts 0.2.41)', () => {
  it('three tiers, the viewer default is `default`, auto = quick for app replies / default for building', () => {
    expect(HOST_TIER_OPTIONS).toEqual(['quick', 'default', 'complex']);
    expect(VIEWER_DEFAULT_TIER).toBe('default');
    expect(AUTO_TIERS).toEqual({ app: 'quick', chat: 'default' });
  });
});

describe('the choice — auto by default, explicit overrides every purpose (AC2)', () => {
  it('boots on `auto`: app turns read quick, chat turns read default (today’s pins, unchanged)', () => {
    const store = createTierStore({ storage: memoryStorage() });
    expect(store.get()).toEqual({ choice: 'auto', unavailable: {} });
    expect(store.tierFor('app')).toBe('quick');
    expect(store.tierFor('chat')).toBe('default');
  });
  it('an explicit tier is read for BOTH purposes; the store notifies subscribers once per change', () => {
    const store = createTierStore({ storage: memoryStorage() });
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.set('complex');
    expect(store.tierFor('app')).toBe('complex');
    expect(store.tierFor('chat')).toBe('complex');
    store.set('complex'); // unchanged → no notification
    expect(notified).toBe(1);
    store.set('auto');
    expect(store.tierFor('app')).toBe('quick');
    expect(notified).toBe(2);
  });
  it('(N) an unknown choice is refused loudly — the chip only ever offers the seat’s options', () => {
    const store = createTierStore({ storage: memoryStorage() });
    expect(() => store.set('turbo' as never)).toThrow(/not a thinking level/);
    expect(store.get().choice).toBe('auto');
  });
});

describe('persistence — this browser, this origin (AC3)', () => {
  it('reads the saved choice at boot; an unknown or missing value boots on auto', () => {
    expect(createTierStore({ storage: memoryStorage({ [TIER_STORAGE_KEY]: 'quick' }) }).get().choice).toBe('quick');
    expect(createTierStore({ storage: memoryStorage({ [TIER_STORAGE_KEY]: 'nonsense' }) }).get().choice).toBe('auto');
    expect(createTierStore({ storage: memoryStorage() }).get().choice).toBe('auto');
    expect(createTierStore({}).get().choice).toBe('auto');
  });
  it('writes exactly the choice under the one key on set — nothing else, nothing on boot', () => {
    const storage = memoryStorage();
    const store = createTierStore({ storage });
    expect(storage.writes).toEqual([]);
    store.set('default');
    expect(storage.writes).toEqual([[TIER_STORAGE_KEY, 'default']]);
    // A second boot on the same storage finds it.
    expect(createTierStore({ storage }).get().choice).toBe('default');
  });
  it('(N) a storage that throws (Safari’s denied rung) falls back to memory: the choice works for this boot, nothing is thrown', () => {
    const store = createTierStore({ storage: throwing });
    expect(store.get().choice).toBe('auto');
    expect(() => store.set('quick')).not.toThrow();
    expect(store.tierFor('chat')).toBe('quick');
  });
});

describe('substitution — honest, derived, the selection falls back (AC4)', () => {
  it('an answer on the asked tier records nothing', () => {
    const store = createTierStore({ storage: memoryStorage() });
    store.set('complex');
    store.markApplied('complex', 'complex');
    expect(store.get()).toEqual({ choice: 'complex', unavailable: {} });
  });
  it('an answer on another tier marks the asked tier unavailable, records the pair, and moves the selection to what answered', () => {
    const store = createTierStore({ storage: memoryStorage() });
    store.set('complex');
    store.markApplied('complex', 'default');
    expect(store.get()).toEqual({ choice: 'default', applied: { asked: 'complex', answered: 'default' }, unavailable: { complex: 'default' } });
    expect(store.tierFor('app')).toBe('default');
    expect(store.tierFor('chat')).toBe('default');
  });
  it('under auto a substituted purpose tier resolves to what answered while the choice stays auto', () => {
    const store = createTierStore({ storage: memoryStorage() });
    store.markApplied('quick', 'default');
    expect(store.get().choice).toBe('auto');
    expect(store.get().unavailable).toEqual({ quick: 'default' });
    expect(store.tierFor('app')).toBe('default');
    expect(store.tierFor('chat')).toBe('default');
  });
  it('a later answer that honours the tier clears the mark; the substitution note is per boot, never persisted', () => {
    const storage = memoryStorage();
    const store = createTierStore({ storage });
    store.set('complex');
    store.markApplied('complex', 'default');
    store.markApplied('complex', 'complex');
    expect(store.get().unavailable).toEqual({});
    expect(store.get().applied).toBeUndefined();
    expect(storage.writes.map(([k]) => k)).toEqual([TIER_STORAGE_KEY, TIER_STORAGE_KEY]); // the choice writes only (set, then the fallback)
    expect(createTierStore({ storage }).get().unavailable).toEqual({});
  });
});

describe('the seat the platform carries (AC1)', () => {
  it('exposes the options, the viewer default, the auto label, the state and set — and nothing that calls the model', () => {
    const store = createTierStore({ storage: memoryStorage() });
    const seat = store.seat();
    expect(seat.options).toEqual(HOST_TIER_OPTIONS);
    expect(seat.viewerDefault).toBe('default');
    expect(seat.autoLabel).toMatch(/quick for app replies/);
    expect(seat.state.get().choice).toBe('auto');
    seat.set('quick');
    expect(store.tierFor('chat')).toBe('quick');
    expect(Object.keys(seat).sort()).toEqual(['autoLabel', 'options', 'set', 'state', 'viewerDefault']);
  });
});
