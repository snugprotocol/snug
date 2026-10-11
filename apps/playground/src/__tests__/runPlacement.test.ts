// runPlacement.test.ts — TASK-20261010-host-broker PR-1 (ADR-0077 §1–§5; contract v2 D-PR1-1,
// D-PR1-3, D-PR1-5, D-PR1-9). RED-FIRST: `schedule/runPlacement.ts` does not exist yet.
//
// WHAT THIS MODULE IS. The one rule that decides where an unattended run executes — the registry
// HAS the app (registered in this tab) → `live`, else `hidden` — and the in-memory record of a
// run in flight on the LIVE frame (a "delegated run"). The record is the seam every other piece
// reads per request: the run-scoped ask gate (does a run own this app right now?), the counting
// seams (`noteDelegatedCall`), the access handler (close the door for the window) and the
// running chip (*running in <app>*). It is in-memory only — D-PR1-1: no persisted shape changes.
//
// THE STICKY GENERATION (security blocker 1, D-PR1-3). Once a delegated run has begun on a frame
// generation, every later mutating call from that generation stays ask-only — after the run
// too — until the frame retracts or remounts. `beginDelegatedRun` records the generation and
// `endDelegatedRun` deliberately does NOT clear it; only `clearTouchedGeneration(appId, gen)`
// does, and only for the generation it names (a stale clear must never lift a newer posture).
//
// There is no reset seam in the contract, so every test uses its own app id and the afterEach
// ends what a test began and clears what it touched — through the public surface only.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_HANDOVERS,
  beginDelegatedRun,
  clearTouchedGeneration,
  delegatedRunFor,
  delegatedRunStore,
  endDelegatedRun,
  noteDelegatedCall,
  placeRun,
  touchedGeneration,
  type DelegatedRun,
} from '../schedule/runPlacement.js';
// Gate-5 folds F-6 / F-12 need the REAL registry. Never `__resetAppHostsForTest` here: it wipes the
// host listeners, including the belt `runPlacement.ts` installs at load (F-12).
import { registerAppHost, setAppHostGeneration } from '../state/appHosts.js';

const begun: Array<{ appId: string; runId: string; generation: number }> = [];

function begin(appId: string, over: Partial<Pick<DelegatedRun, 'appName' | 'runId' | 'taskId' | 'title' | 'generation'>> = {}) {
  const input = {
    appId,
    appName: 'Weather',
    runId: 'run-1',
    taskId: 't1',
    title: 'Morning forecast',
    generation: 1,
    ...over,
  };
  const result = beginDelegatedRun(input);
  begun.push({ appId, runId: input.runId, generation: input.generation });
  return result;
}

afterEach(() => {
  for (const { appId, runId, generation } of begun.splice(0)) {
    endDelegatedRun(appId, runId);
    clearTouchedGeneration(appId, generation);
  }
});

describe('placeRun — one rule (ADR-0077 §2, D-PR1-5)', () => {
  it('the registry HAS the app → `live`; otherwise → `hidden`', () => {
    const live = { has: (appId: string) => appId === 'weather' };
    expect(placeRun(live, 'weather')).toBe('live');
    expect(placeRun(live, 'ledger')).toBe('hidden');
  });

  it('asks the registry about THIS app id and nothing else', () => {
    const has = vi.fn(() => false);
    placeRun({ has }, 'weather');
    expect(has).toHaveBeenCalledWith('weather');
  });

  it('at most one handover per run', () => {
    expect(MAX_HANDOVERS).toBe(1);
  });
});

describe('beginDelegatedRun / endDelegatedRun — the record of a run on the live frame', () => {
  it('begin answers ok with a fresh record: nothing counted, nothing refused, nothing granted, not asking, signal live', () => {
    const result = begin('pl-begin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.run;
    expect(run).toMatchObject({
      appId: 'pl-begin',
      appName: 'Weather',
      runId: 'run-1',
      taskId: 't1',
      title: 'Morning forecast',
      generation: 1,
      calls: { ai: 0, net: 0 },
      refused: [],
      granted: 0,
      asking: false,
    });
    expect(run.signal.aborted).toBe(false);
    expect(delegatedRunFor('pl-begin')).toBe(run);
    expect(delegatedRunStore.get().get('pl-begin')).toBe(run);
  });

  it('refuses a SECOND run for the same app — `{ ok: false, reason }`, never a throw — and the first stays in flight', () => {
    const first = begin('pl-second', { runId: 'run-1' });
    expect(first.ok).toBe(true);
    let second: ReturnType<typeof beginDelegatedRun> | undefined;
    expect(() => {
      second = begin('pl-second', { runId: 'run-2' });
    }).not.toThrow();
    expect(second?.ok).toBe(false);
    if (second !== undefined && !second.ok) expect(typeof second.reason).toBe('string');
    expect(delegatedRunFor('pl-second')?.runId).toBe('run-1');
  });

  it('the store is per app: a run for another app begins alongside', () => {
    expect(begin('pl-a').ok).toBe(true);
    expect(begin('pl-b').ok).toBe(true);
    expect(delegatedRunFor('pl-a')?.appId).toBe('pl-a');
    expect(delegatedRunFor('pl-b')?.appId).toBe('pl-b');
  });

  it('end ABORTS the run’s signal (every parked prompt listens to it), removes the entry, and returns the final record', () => {
    const result = begin('pl-end');
    if (!result.ok) throw new Error('begin refused');
    const run = result.run;
    run.calls.ai += 1;
    run.calls.net += 2;
    run.granted += 1;
    run.refused.push({ host: 'api.example.com', method: 'POST', why: 'declined' });

    const final = endDelegatedRun('pl-end', 'run-1');

    expect(run.signal.aborted).toBe(true);
    expect(delegatedRunFor('pl-end')).toBeUndefined();
    expect(delegatedRunStore.get().has('pl-end')).toBe(false);
    expect(final).toEqual({
      calls: { ai: 1, net: 2 },
      refused: [{ host: 'api.example.com', method: 'POST', why: 'declined' }],
      granted: 1,
    });
  });

  it('the record is MUTABLE and shared: what the gate writes through `delegatedRunFor` is what `end` returns', () => {
    begin('pl-shared');
    const seen = delegatedRunFor('pl-shared');
    if (seen === undefined) throw new Error('no run');
    seen.granted += 2;
    expect(endDelegatedRun('pl-shared', 'run-1')?.granted).toBe(2);
  });

  it('end with nothing in flight answers undefined', () => {
    expect(endDelegatedRun('pl-nothing', 'run-1')).toBeUndefined();
  });

  it('end for a DIFFERENT run id leaves the run in flight untouched (the runId is the key it ends by)', () => {
    const result = begin('pl-other-run', { runId: 'run-1' });
    if (!result.ok) throw new Error('begin refused');
    expect(endDelegatedRun('pl-other-run', 'run-9')).toBeUndefined();
    expect(delegatedRunFor('pl-other-run')).toBe(result.run);
    expect(result.run.signal.aborted).toBe(false);
  });

  it('a run can begin again for the app once the last one ended', () => {
    begin('pl-again', { runId: 'run-1' });
    endDelegatedRun('pl-again', 'run-1');
    const again = begin('pl-again', { runId: 'run-2' });
    expect(again.ok).toBe(true);
  });
});

describe('noteDelegatedCall — counting follows the run (ADR-0077 §4)', () => {
  it('is a no-op when no run is in flight (never creates one, never throws)', () => {
    expect(() => noteDelegatedCall('pl-none', 'ai')).not.toThrow();
    expect(() => noteDelegatedCall('pl-none', 'net')).not.toThrow();
    expect(delegatedRunFor('pl-none')).toBeUndefined();
  });

  it('increments the run’s own counter for each kind', () => {
    begin('pl-count');
    noteDelegatedCall('pl-count', 'ai');
    noteDelegatedCall('pl-count', 'net');
    noteDelegatedCall('pl-count', 'net');
    expect(delegatedRunFor('pl-count')?.calls).toEqual({ ai: 1, net: 2 });
    expect(endDelegatedRun('pl-count', 'run-1')?.calls).toEqual({ ai: 1, net: 2 });
  });

  it('counts on THIS app’s run only', () => {
    begin('pl-count-a');
    begin('pl-count-b');
    noteDelegatedCall('pl-count-a', 'net');
    expect(delegatedRunFor('pl-count-a')?.calls.net).toBe(1);
    expect(delegatedRunFor('pl-count-b')?.calls.net).toBe(0);
  });
});

describe('touchedGeneration — the sticky ask-only posture (D-PR1-3, security blocker 1)', () => {
  it('is undefined for an app no delegated run ever touched', () => {
    expect(touchedGeneration('pl-untouched')).toBeUndefined();
  });

  it('is SET by begin, KEPT by end (a handler may POST after its result), and cleared only by its own generation', () => {
    begin('pl-sticky', { generation: 3 });
    expect(touchedGeneration('pl-sticky')).toBe(3);

    endDelegatedRun('pl-sticky', 'run-1');
    expect(touchedGeneration('pl-sticky')).toBe(3);

    clearTouchedGeneration('pl-sticky', 2); // a stale clear (an older frame retracting)
    expect(touchedGeneration('pl-sticky')).toBe(3);

    clearTouchedGeneration('pl-sticky', 3);
    expect(touchedGeneration('pl-sticky')).toBeUndefined();
  });

  it('a later run on a newer generation moves the posture to that generation', () => {
    begin('pl-sticky-2', { runId: 'run-1', generation: 1 });
    endDelegatedRun('pl-sticky-2', 'run-1');
    begin('pl-sticky-2', { runId: 'run-2', generation: 2 });
    expect(touchedGeneration('pl-sticky-2')).toBe(2);
  });

  it('a refused begin does not touch the generation', () => {
    begin('pl-sticky-refused', { runId: 'run-1', generation: 1 });
    begin('pl-sticky-refused', { runId: 'run-2', generation: 5 });
    expect(touchedGeneration('pl-sticky-refused')).toBe(1);
  });
});

describe('delegatedRunStore — notifies on PRESENCE changes (the chip and the gate read it)', () => {
  it('a begin and an end each notify; a counted call (a mutation of the record) does not', () => {
    const listener = vi.fn();
    const unsubscribe = delegatedRunStore.subscribe(listener);
    try {
      begin('pl-notify');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(delegatedRunStore.get().has('pl-notify')).toBe(true);

      noteDelegatedCall('pl-notify', 'ai');
      expect(listener).toHaveBeenCalledTimes(1);

      endDelegatedRun('pl-notify', 'run-1');
      expect(listener).toHaveBeenCalledTimes(2);
      expect(delegatedRunStore.get().has('pl-notify')).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('a refused begin does not notify', () => {
    begin('pl-notify-refused', { runId: 'run-1' });
    const listener = vi.fn();
    const unsubscribe = delegatedRunStore.subscribe(listener);
    try {
      begin('pl-notify-refused', { runId: 'run-2' });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1, Gate-5 folds F-6 and F-12 — the sticky posture against the REAL
// registry (`state/appHosts.ts`). This suite imports `runPlacement.ts` and `appHosts.ts` ONLY —
// never `state/net.ts` — so what it observes is `runPlacement.ts`'s own behaviour.
//
// F-6 (security MINOR) A REMOUNT mid-run: the instance that could have read the run's kv input is
// the one that stays. `endDelegatedRun` refreshes the touched generation to the LIVE one while the
// registration token still matches — so the new generation inherits the ask-only posture.
//
// F-12 (maintainability MINOR) THE BELT HAS ONE HOME: the registry listener that clears the touched
// generation on a retraction lives in `runPlacement.ts`. Isolating the belt from the structural
// token match takes one trick: a run begun with NO registration captures `token: undefined`, a
// registration then hides the posture (token mismatch) and its retraction makes the tokens equal
// again — so without a belt the posture REVIVES; with the belt, the retraction cleared it. (The
// limit: this proves a retraction clears the record from `runPlacement.ts` alone; the realistic
// begin-under-a-registration case is covered by the token match and by netState's retraction pin.)
// ---------------------------------------------------------------------------------------------

describe('the sticky posture against the real registry (Gate-5 folds F-6, F-12)', () => {
  const unregisters: Array<() => void> = [];
  afterEach(() => {
    for (const unregister of unregisters.splice(0).reverse()) unregister();
  });

  function openView(appId: string, generation: number): () => void {
    const unregister = registerAppHost(appId, vi.fn());
    setAppHostGeneration(appId, generation);
    unregisters.push(unregister);
    return unregister;
  }

  it('F-6: a REMOUNT mid-run (generation 1 → 2, same registration) → after `endDelegatedRun` the touched generation is the LIVE one, 2', () => {
    openView('pl-f6-remount', 1);
    expect(begin('pl-f6-remount', { generation: 1 }).ok).toBe(true);
    expect(touchedGeneration('pl-f6-remount')).toBe(1);
    setAppHostGeneration('pl-f6-remount', 2); // RunView's frameEpoch effect: a remount is not a retraction
    endDelegatedRun('pl-f6-remount', 'run-1');
    expect(touchedGeneration('pl-f6-remount'), 'the instance that stays inherits the ask-only posture').toBe(2);
  });

  it('F-6 guard: without a remount the run ends on the generation it began on', () => {
    openView('pl-f6-same', 3);
    begin('pl-f6-same', { generation: 3 });
    endDelegatedRun('pl-f6-same', 'run-1');
    expect(touchedGeneration('pl-f6-same')).toBe(3);
  });

  it('F-12: a retraction clears the touched generation through `runPlacement.ts`’s OWN registry listener (`state/net.ts` never loaded here) — the posture does not revive when the tokens match again', () => {
    begin('pl-f12-belt', { generation: 0 }); // no registration: the record captures token `undefined`
    endDelegatedRun('pl-f12-belt', 'run-1');
    expect(touchedGeneration('pl-f12-belt')).toBe(0);
    const unregister = openView('pl-f12-belt', 0);
    expect(touchedGeneration('pl-f12-belt'), 'a new registration hides it (token match)').toBeUndefined();
    unregister(); // the retraction — the belt must clear the record now
    expect(touchedGeneration('pl-f12-belt'), 'cleared by the belt, not merely hidden').toBeUndefined();
  });
});
