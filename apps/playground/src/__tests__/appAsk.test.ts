// appAsk.test.ts — the app-ask intake ladder on its own (TASK-20261010-cross-app-access W3;
// ADR-0074 §4 — extracted from schedule/scheduleRequest.ts so the scheduling suggestion and the
// access ask run ONE ladder). The rungs, in the order `consume` runs them: the rate limit (by
// app + generation for a schedule suggestion, by app alone for an access ask), the mutes (the
// per-browser switch, then the app's own row), the recorded declines by semantic hash, and
// one pending per frame generation. Each rung is also callable alone — the schedule intake
// interleaves its own parse, sender and cap checks between them.
//
// The ladder never reads the clock or the file itself: the caller passes `at` and the db, the
// options answer the mute and decline questions — so this suite needs no user db at all.

import { describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { createAppAsk, type AppAskOptions } from '../state/appAsk.js';

interface Ask {
  words: string[];
}
interface Pending {
  appId: string;
  generation: number;
  label: string;
}

const db = {} as UserDb; // the ladder only hands it to the injected questions

function ladder(over: Partial<AppAskOptions<Ask>> & { muted?: Set<string>; declines?: Map<string, string[]>; global?: { on: boolean } } = {}) {
  const muted = over.muted ?? new Set<string>();
  const declines = over.declines ?? new Map<string, string[]>();
  const global = over.global ?? { on: false };
  const ask = createAppAsk<Ask, Pending>({
    minGapMs: 10_000,
    hash: (value) => [...value.words].sort().join('|'),
    isMuted: (_db, appId) => muted.has(appId),
    isDeclined: (_db, appId, hash) => (declines.get(appId) ?? []).includes(hash),
    globalMute: () => global.on,
    ...over,
  });
  return { ask, muted, declines, global };
}

const pending = (appId: string, generation: number, label = 'first'): Pending => ({ appId, generation, label });

describe('the rate limit — by app + generation (the schedule suggestion) or by app alone (the access ask)', () => {
  it('by generation: a second ask inside the gap from the same generation is limited; a new generation has its own window', () => {
    const { ask } = ladder({ rateBy: 'generation' });
    expect(ask.rateLimited('a', 0, 1_000)).toBe(false);
    expect(ask.rateLimited('a', 0, 1_000 + 9_999)).toBe(true);
    expect(ask.rateLimited('a', 1, 1_000 + 9_999), 'a remount is a new instance').toBe(false);
    expect(ask.rateLimited('a', 1, 1_000 + 9_999 + 9_999)).toBe(true);
  });

  it('by app: a new generation does NOT reset the window — a remount (or a re-announce) cannot mint a fresh slot', () => {
    const { ask } = ladder({ rateBy: 'app' });
    expect(ask.rateLimited('a', 0, 1_000)).toBe(false);
    expect(ask.rateLimited('a', 1, 2_000)).toBe(true);
    expect(ask.rateLimited('a', 2, 10_999)).toBe(true);
    expect(ask.rateLimited('a', 2, 11_000)).toBe(false);
    expect(ask.rateLimited('b', 0, 11_000), 'another app has its own window').toBe(false);
  });

  it('a limited ask does not slide the window; the memory is ONE entry per app however many generations come and go', () => {
    const { ask } = ladder();
    for (let generation = 0; generation < 40; generation += 1) ask.rateLimited('a', generation, generation * 20_000);
    expect(ask.rateMemorySize()).toBe(1);
    expect(ask.rateLimited('a', 39, 39 * 20_000 + 5_000)).toBe(true);
    expect(ask.rateLimited('a', 39, 39 * 20_000 + 10_000), 'measured from the last ask that passed').toBe(false);
    ask.rateLimited('b', 0, 0);
    expect(ask.rateMemorySize()).toBe(2);
  });
});

describe('mutes, declines and the one pending', () => {
  it('the per-browser switch mutes every app; the app’s own row mutes that app only', () => {
    const { ask, muted, global } = ladder();
    expect(ask.muted(db, 'a')).toBe(false);
    muted.add('a');
    expect(ask.muted(db, 'a')).toBe(true);
    expect(ask.muted(db, 'b')).toBe(false);
    global.on = true;
    expect(ask.muted(db, 'b')).toBe(true);
  });

  it('a recorded decline is matched by the semantic hash the options define', () => {
    const { ask, declines } = ladder();
    declines.set('a', ['x|y']);
    expect(ask.declined(db, 'a', 'x|y')).toBe(true);
    expect(ask.declined(db, 'a', 'x')).toBe(false);
    expect(ask.declined(db, 'b', 'x|y')).toBe(false);
  });

  it('one pending per generation: the same generation is blocked, another generation is not; setPending/pendingFor/clear keep the store', () => {
    const { ask } = ladder();
    expect(ask.pendingBlocks('a', 0)).toBe(false);
    ask.setPending('a', pending('a', 0));
    expect(ask.pendingFor('a')).toEqual(pending('a', 0));
    expect(ask.store.get()).toEqual({ a: pending('a', 0) });
    expect(ask.pendingBlocks('a', 0)).toBe(true);
    expect(ask.pendingBlocks('a', 1)).toBe(false);
    ask.setPending('b', pending('b', 3));
    ask.setPending('a', undefined);
    expect(ask.store.get()).toEqual({ b: pending('b', 3) });
    const before = ask.store.get();
    ask.setPending('a', undefined);
    expect(ask.store.get(), 'clearing an absent pending does not publish a new value').toBe(before);
  });

  it('clear(appId) forgets one app’s window and pending; clear() forgets every app', () => {
    const { ask } = ladder();
    ask.rateLimited('a', 0, 0);
    ask.rateLimited('b', 0, 0);
    ask.setPending('a', pending('a', 0));
    ask.setPending('b', pending('b', 0));
    ask.clear('a');
    expect(ask.pendingFor('a')).toBeUndefined();
    expect(ask.pendingFor('b')).toBeDefined();
    expect(ask.rateLimited('a', 0, 1), 'a’s window is gone').toBe(false);
    expect(ask.rateLimited('b', 0, 1), 'b’s window is kept').toBe(true);
    ask.clear();
    expect(ask.store.get()).toEqual({});
    expect(ask.rateMemorySize()).toBe(0);
  });
});

describe('consume — the rungs in order: rate → muted → declined → pending → accepted', () => {
  it('answers each rung by name, and never parks anything itself', () => {
    const { ask, muted, declines } = ladder({ rateBy: 'app' });
    const words = { words: ['spend', 'ledger'] };
    expect(ask.consume({ appId: 'a', generation: 0, ask: words, db, at: 0 })).toBe('accepted');
    expect(ask.store.get(), 'consume decides; the caller parks').toEqual({});
    expect(ask.consume({ appId: 'a', generation: 0, ask: words, db, at: 1 })).toBe('rate-limited');
    ask.setPending('a', pending('a', 0));
    expect(ask.consume({ appId: 'a', generation: 0, ask: words, db, at: 20_000 })).toBe('pending');
    declines.set('a', ['ledger|spend']);
    expect(ask.consume({ appId: 'a', generation: 0, ask: words, db, at: 40_000 }), 'declined outranks pending').toBe('declined');
    muted.add('a');
    expect(ask.consume({ appId: 'a', generation: 0, ask: words, db, at: 60_000 }), 'muted outranks declined').toBe('muted');
    expect(ask.consume({ appId: 'a', generation: 0, ask: words, db, at: 60_001 }), 'the rate rung runs first, and counts every ask that reaches it').toBe('rate-limited');
  });

  it('reads the clock from the options when the caller passes none', () => {
    let now = 0;
    const { ask } = ladder({ now: () => now });
    expect(ask.consume({ appId: 'a', generation: 0, ask: { words: [] }, db })).toBe('accepted');
    now = 5_000;
    expect(ask.consume({ appId: 'a', generation: 0, ask: { words: [] }, db })).toBe('rate-limited');
  });
});
