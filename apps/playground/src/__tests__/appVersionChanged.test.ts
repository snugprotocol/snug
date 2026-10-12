// appVersionChanged.test.ts — TASK-20261010-host-broker PR-4 (contract v2 D-PR4-7, D-PR4-8; AC31):
// the ONE fan-out disarms a task's write authority when the app it may change gets a new version —
// from EVERY source: the user's own edit and a starter update included, which pause nothing. The
// disarm is INDEPENDENT of the pause and its early returns (`pauseSchedulesForAppVersion` returns 0
// for `own`, the caller skips `starter`, `pauseForAppUpdate` early-returns for a task already
// paused): an authority armed on version N never survives into version N+1 without the user's
// consent again. The trace is `disarmed: { reason: 'app-updated', at }` — a disarm the user did not
// perform. The existing outcome pins (accessDrift.test.ts) are left as they are: this file asserts
// the file's state, never a new outcome field.
//
// The real memory user db; the instant is a passed-in string (no wall clock is read here).

import type { UserDb } from '@snugprotocol/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAccessSession } from '../access/grants.js';
import { onAppVersionChanged } from '../state/appVersionChanged.js';
import { installTestUserDb } from './userdbTestHelper.js';

const CREATED = '2026-10-01T00:00:00.000Z';
const ARMED_AT = '2026-10-05T09:00:00.000Z';
const NOW = '2026-10-11T09:00:00.000Z';
const DAY = 86_400_000;

let db: UserDb;
let ledger: string;
let pantry: string;

type TaskRow = Parameters<UserDb['putScheduledTask']>[0];

/** A one-app task asking `appId`'s AI, recorded at `version`; armed at `armedVersion` unless told otherwise. */
function taskOn(id: string, appId: string, over: Record<string, unknown> = {}): TaskRow {
  return {
    id,
    title: `Tidy ${id}`,
    enabled: true,
    enabledAt: CREATED,
    provenance: 'user',
    steps: [{ kind: 'app-think', appId, prompt: 'tidy the notes', context: { maxRows: 50 } }],
    spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
    cron: '0 * * * *',
    missedPolicy: 'ask',
    staleAfterMs: 7 * DAY,
    alert: 'inbox',
    appVersions: { [appId]: 1 },
    createdAt: CREATED,
    updatedAt: CREATED,
    consecutiveFailures: 0,
    unseenResults: 0,
    writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 1 },
    ...over,
  } as TaskRow;
}

const armed = (task: { writeAuthority?: unknown } | undefined): boolean => task?.writeAuthority !== undefined;

beforeEach(async () => {
  resetAccessSession();
  db = await installTestUserDb();
  ledger = db.installApp({ displayName: 'Ledger', html: '<html>ledger</html>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<html>pantry</html>' }).appId;
});

afterEach(() => {
  resetAccessSession();
  vi.restoreAllMocks();
});

describe('onAppVersionChanged disarms on EVERY source (D-PR4-8)', () => {
  it.each(['own', 'starter', 'shared', 'agent'] as const)('%s: the armed task naming the app loses its authority, with the app-updated trace', (source) => {
    db.putScheduledTask(taskOn('t1', ledger));
    onAppVersionChanged(db, ledger, 2, source, NOW);
    const task = db.getScheduledTask('t1');
    expect(task, source).toBeDefined();
    expect(armed(task), source).toBe(false);
    expect(task?.disarmed, source).toEqual({ reason: 'app-updated', at: NOW });
  });

  it('own and starter disarm WITHOUT pausing: the schedule stays on (the pause rule is unchanged)', () => {
    db.putScheduledTask(taskOn('t-own', ledger));
    onAppVersionChanged(db, ledger, 2, 'own', NOW);
    expect(db.getScheduledTask('t-own')).toMatchObject({ enabled: true });
    expect(db.getScheduledTask('t-own')?.pausedReason).toBeUndefined();

    db.putScheduledTask(taskOn('t-starter', pantry));
    onAppVersionChanged(db, pantry, 2, 'starter', NOW);
    expect(db.getScheduledTask('t-starter')).toMatchObject({ enabled: true });
    expect(armed(db.getScheduledTask('t-starter'))).toBe(false);
  });

  it('shared and agent both pause AND disarm', () => {
    db.putScheduledTask(taskOn('t1', ledger));
    onAppVersionChanged(db, ledger, 2, 'shared', NOW);
    expect(db.getScheduledTask('t1')).toMatchObject({ enabled: false, pausedReason: 'app-updated', disarmed: { reason: 'app-updated', at: NOW } });
    expect(armed(db.getScheduledTask('t1'))).toBe(false);
  });

  it('independent of the pause’s early returns: a task ALREADY paused (by failures, or by an earlier update) is disarmed too', () => {
    db.putScheduledTask(taskOn('failing', ledger, { enabled: false, pausedReason: 'failures' }));
    db.putScheduledTask(taskOn('updated', ledger, { enabled: false, pausedReason: 'app-updated' }));
    db.putScheduledTask(taskOn('off', ledger, { enabled: false }));
    onAppVersionChanged(db, ledger, 3, 'agent', NOW);
    for (const id of ['failing', 'updated', 'off']) {
      expect(armed(db.getScheduledTask(id)), id).toBe(false);
      expect(db.getScheduledTask(id)?.disarmed, id).toEqual({ reason: 'app-updated', at: NOW });
    }
  });

  it('a task armed for ANOTHER app is untouched; an UNARMED task naming the app gets no trace', () => {
    db.putScheduledTask(taskOn('theirs', pantry));
    const plain = taskOn('plain', ledger);
    delete (plain as { writeAuthority?: unknown }).writeAuthority;
    db.putScheduledTask(plain);
    onAppVersionChanged(db, ledger, 2, 'own', NOW);
    expect(armed(db.getScheduledTask('theirs'))).toBe(true);
    expect(db.getScheduledTask('theirs')?.disarmed).toBeUndefined();
    expect(db.getScheduledTask('plain')?.disarmed).toBeUndefined();
  });

  it('the rest of the task is kept as it was — steps, spec, title, counters; only the authority goes and the trace arrives', () => {
    const before = taskOn('t1', ledger, { unseenResults: 3, consecutiveFailures: 1 });
    db.putScheduledTask(before);
    onAppVersionChanged(db, ledger, 2, 'own', NOW);
    const after = db.getScheduledTask('t1')!;
    const { writeAuthority: _gone, ...expected } = before as TaskRow & { writeAuthority?: unknown };
    const { disarmed, updatedAt: _stamp, ...rest } = after as typeof after & { disarmed?: unknown };
    const { updatedAt: _was, ...expectedRest } = expected as typeof expected & { updatedAt: string };
    expect(rest).toEqual(expectedRest);
    expect(disarmed).toEqual({ reason: 'app-updated', at: NOW });
  });
});

// PR-4 Gate-5 A2 [AUTH-F12] — the disarm runs FIRST in the fan-out, so it must never throw at the
// update: each task's write is its own try/catch (warned), the other tasks are still disarmed, and the
// rest of the fan-out (the pause; the reader-access pause — pinned in accessDrift.test.ts) still runs.
describe('disarmSchedulesForAppVersion never throws at the update (A2)', () => {
  it('one armed task’s row refused by the file: the call returns, the OTHER armed task is still disarmed, the refused one stays as it was', () => {
    db.putScheduledTask(taskOn('refused', ledger));
    db.putScheduledTask(taskOn('fine', ledger));
    const put = db.putScheduledTask.bind(db);
    vi.spyOn(db, 'putScheduledTask').mockImplementation((task) => {
      if (task.id === 'refused') throw new Error('the file refused the row');
      put(task);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => onAppVersionChanged(db, ledger, 2, 'own', NOW)).not.toThrow();
    expect(armed(db.getScheduledTask('fine'))).toBe(false);
    expect(db.getScheduledTask('fine')?.disarmed).toEqual({ reason: 'app-updated', at: NOW });
    expect(armed(db.getScheduledTask('refused')), 'the walk’s armedVersion belt stops it at its seat instead').toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('an agent update with the disarm refused still pauses the schedules it names (the fan-out goes on)', () => {
    db.putScheduledTask(taskOn('t1', ledger));
    const put = db.putScheduledTask.bind(db);
    vi.spyOn(db, 'putScheduledTask').mockImplementation((task) => {
      if ((task as { disarmed?: unknown }).disarmed !== undefined && (task as { pausedReason?: unknown }).pausedReason === undefined) throw new Error('refused');
      put(task);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => onAppVersionChanged(db, ledger, 2, 'agent', NOW)).not.toThrow();
    expect(db.getScheduledTask('t1')).toMatchObject({ enabled: false, pausedReason: 'app-updated' });
  });
});
