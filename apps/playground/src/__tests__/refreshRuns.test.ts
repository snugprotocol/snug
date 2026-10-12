// refreshRuns.test.ts — TASK-20261010-host-broker PR-5 (AC39d; contract v2 D-PR5-17, D-PR5-18; the
// abort seam). RED-FIRST: `access/refreshRuns.ts` does not exist yet (I-1 lands it whole).
//
// WHAT IT IS. A LEAF store (it imports nothing from `refresh.ts` or `appRun.ts`): ONE entry per
// refresh in flight, spanning its handovers — `{runId, sourceAppId, sourceName, requestedBy,
// placement: 'live' | 'headless' (updated IN PLACE), controller, waiters}`. The chip reads it
// (`useRefreshRuns`); the doors wait on it; four verbs end things:
//   - `cancelRefresh(runId)` — the chip's act: the dispatch's own controller aborts, the entry leaves;
//   - `abortAllRefreshes('reset')` — a file swap: every controller aborts, the store empties (the
//     engine writes NOTHING for a reset and the cooldown map is cleared — pinned in refresh.test.ts);
//   - `abortRefreshesFor(appId)` — an app delete: ONLY refreshes whose source or requester is that app;
//   - the LAST waiter leaving — a door's signal abandons only ITS wait; the shared dispatch is aborted
//     only when nobody waits on it any more.
//
// THE SURFACE THIS FILE ASSUMES beyond the contract's four verbs and the hook (v2.1 questions T-D Q1–Q3):
//   beginRefreshRun({runId, sourceAppId, sourceName, requestedBy, placement}) → RefreshRun (waiters 0)
//   setRefreshPlacement(runId, placement)      — the handover moves the SAME entry
//   joinRefreshRun(runId) → leave()            — one door's wait; leave() is idempotent
//   endRefreshRun(runId)                       — the engine's normal end (no abort)
//   listRefreshRuns() → readonly RefreshRun[]  — the non-hook read, oldest first
// `requestedBy` is the REQUESTING app's id (what `abortRefreshesFor` matches); the chip names the source.
import { afterEach, describe, expect, it } from 'vitest';

import {
  abortAllRefreshes,
  abortRefreshesFor,
  beginRefreshRun,
  cancelRefresh,
  endRefreshRun,
  joinRefreshRun,
  listRefreshRuns,
  setRefreshPlacement,
  type RefreshRun,
} from '../access/refreshRuns.js';

const begin = (runId: string, over: Partial<Pick<RefreshRun, 'sourceAppId' | 'sourceName' | 'requestedBy' | 'placement'>> = {}): RefreshRun =>
  beginRefreshRun({ runId, sourceAppId: 'ledger', sourceName: 'Ledger', requestedBy: 'budget', placement: 'headless', ...over });

afterEach(() => {
  abortAllRefreshes('reset');
});

describe('D-PR5-17 one entry per refresh, across its handovers', () => {
  it('begin → exactly one entry carrying the run id, the source, the requester and the placement; nothing aborted', () => {
    const run = begin('run-1');
    const listed = listRefreshRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ runId: 'run-1', sourceAppId: 'ledger', sourceName: 'Ledger', requestedBy: 'budget', placement: 'headless' });
    expect(run.controller.signal.aborted).toBe(false);
  });

  it('a handover updates the placement IN PLACE — still one entry, the same object, the same controller', () => {
    const run = begin('run-1', { placement: 'headless' });
    setRefreshPlacement('run-1', 'live');
    const listed = listRefreshRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.placement).toBe('live');
    expect(listed[0]!.controller).toBe(run.controller);
    expect(listed[0]!.runId).toBe('run-1');
  });

  it('endRefreshRun takes the entry away without aborting it (a normal end)', () => {
    const run = begin('run-1');
    endRefreshRun('run-1');
    expect(listRefreshRuns()).toEqual([]);
    expect(run.controller.signal.aborted).toBe(false);
  });

  it('two refreshes of two sources are two entries, oldest first', () => {
    begin('run-1', { sourceAppId: 'ledger', sourceName: 'Ledger' });
    begin('run-2', { sourceAppId: 'pantry', sourceName: 'Pantry' });
    expect(listRefreshRuns().map((run) => run.runId)).toEqual(['run-1', 'run-2']);
  });
});

describe('D-PR5-17 cancelRefresh — the chip’s act', () => {
  it('aborts the dispatch’s own controller and the entry leaves (the chip drops it)', () => {
    const run = begin('run-1');
    expect(cancelRefresh('run-1')).toBe(true);
    expect(run.controller.signal.aborted).toBe(true);
    expect(listRefreshRuns()).toEqual([]);
  });

  it('an unknown run id is a no-op answering false — no other entry is touched', () => {
    const run = begin('run-1');
    expect(cancelRefresh('run-other')).toBe(false);
    expect(run.controller.signal.aborted).toBe(false);
    expect(listRefreshRuns()).toHaveLength(1);
  });

  it('cancels ONLY the named run', () => {
    const one = begin('run-1', { sourceAppId: 'ledger' });
    const two = begin('run-2', { sourceAppId: 'pantry', sourceName: 'Pantry' });
    cancelRefresh('run-1');
    expect(one.controller.signal.aborted).toBe(true);
    expect(two.controller.signal.aborted).toBe(false);
    expect(listRefreshRuns().map((run) => run.runId)).toEqual(['run-2']);
  });
});

describe('D-PR5-17 abortAllRefreshes(\'reset\') — a file swap', () => {
  it('aborts EVERY controller and empties the store', () => {
    const one = begin('run-1', { sourceAppId: 'ledger' });
    const two = begin('run-2', { sourceAppId: 'pantry', sourceName: 'Pantry', placement: 'live' });
    abortAllRefreshes('reset');
    expect(one.controller.signal.aborted).toBe(true);
    expect(two.controller.signal.aborted).toBe(true);
    expect(listRefreshRuns()).toEqual([]);
  });

  it('on an empty store it is a no-op (never a throw)', () => {
    expect(() => abortAllRefreshes('reset')).not.toThrow();
    expect(listRefreshRuns()).toEqual([]);
  });
});

describe('D-PR5-17 abortRefreshesFor(appId) — an app delete aborts only its own (S6)', () => {
  it('aborts a refresh whose SOURCE is the app', () => {
    const own = begin('run-1', { sourceAppId: 'ledger', requestedBy: 'budget' });
    const other = begin('run-2', { sourceAppId: 'pantry', sourceName: 'Pantry', requestedBy: 'meals' });
    abortRefreshesFor('ledger');
    expect(own.controller.signal.aborted).toBe(true);
    expect(other.controller.signal.aborted).toBe(false);
    expect(listRefreshRuns().map((run) => run.runId)).toEqual(['run-2']);
  });

  it('aborts a refresh whose REQUESTER is the app', () => {
    const asked = begin('run-1', { sourceAppId: 'ledger', requestedBy: 'budget' });
    const other = begin('run-2', { sourceAppId: 'pantry', sourceName: 'Pantry', requestedBy: 'meals' });
    abortRefreshesFor('budget');
    expect(asked.controller.signal.aborted).toBe(true);
    expect(other.controller.signal.aborted).toBe(false);
    expect(listRefreshRuns().map((run) => run.runId)).toEqual(['run-2']);
  });

  it('NEGATIVE: an app that is neither source nor requester of any refresh touches nothing', () => {
    const one = begin('run-1');
    abortRefreshesFor('weather');
    expect(one.controller.signal.aborted).toBe(false);
    expect(listRefreshRuns()).toHaveLength(1);
  });
});

describe('D-PR5-17 / D-PR5-18 the waiters — a door’s signal abandons only ITS wait (S14)', () => {
  it('each join counts one waiter', () => {
    begin('run-1');
    joinRefreshRun('run-1');
    joinRefreshRun('run-1');
    expect(listRefreshRuns()[0]!.waiters).toBe(2);
  });

  it('one of two waiters leaving does NOT abort the shared dispatch', () => {
    const run = begin('run-1');
    const leaveA = joinRefreshRun('run-1');
    joinRefreshRun('run-1');
    leaveA();
    expect(run.controller.signal.aborted).toBe(false);
    expect(listRefreshRuns()[0]!.waiters).toBe(1);
  });

  it('the LAST waiter leaving aborts the dispatch — nobody is waiting on it any more', () => {
    const run = begin('run-1');
    const leaveA = joinRefreshRun('run-1');
    const leaveB = joinRefreshRun('run-1');
    leaveA();
    expect(run.controller.signal.aborted).toBe(false);
    leaveB();
    expect(run.controller.signal.aborted).toBe(true);
  });

  it('a leave is idempotent — leaving twice never counts another door out', () => {
    const run = begin('run-1');
    const leaveA = joinRefreshRun('run-1');
    joinRefreshRun('run-1');
    leaveA();
    leaveA();
    expect(listRefreshRuns()[0]!.waiters).toBe(1);
    expect(run.controller.signal.aborted).toBe(false);
  });

  it('a leave after the run ended is a no-op (never a throw, never an abort of a finished run)', () => {
    const run = begin('run-1');
    const leave = joinRefreshRun('run-1');
    endRefreshRun('run-1');
    expect(() => leave()).not.toThrow();
    expect(run.controller.signal.aborted).toBe(false);
  });
});

describe('D-PR5-24 the leaf rule — refreshRuns.ts imports nothing from the engine or the run path', () => {
  it('no import of ./refresh.js, ../schedule/appRun.js or ./service.js (static or dynamic)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.resolve(__dirname, '../access/refreshRuns.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]\.\/refresh\.js['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\.\/schedule\/appRun\.js['"]/);
    expect(source).not.toMatch(/import\(\s*['"](\.\/refresh|\.\.\/schedule\/appRun|\.\/service)\.js['"]\s*\)/);
    expect(source).not.toMatch(/from\s+['"]\.\/service\.js['"]/);
  });
});
