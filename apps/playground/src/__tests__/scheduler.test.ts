// scheduler.test.ts — TASK-20261009-scheduling-framework E1/E4/E5/E7/E8 (ADR-0074 §5–§6): the
// scheduler's module store and composition root, with the three outside seams FAKED — the
// ticker (a factory that hands back the tick handler), the lock manager (held elsewhere, or
// absent so this context leads) and the step executor (a recorder) — over a REAL memory-backed
// user db and an injected clock. The planner, the protection rules, the floors, the election
// and the queue are the production ones.
//
// What this pins: a fresh file plans NOTHING (the watermark is born at `now`); a late
// occurrence runs once; 48 missed hourly collapse to ONE pending row the card counts as 1; a
// refused write between candidate rows leaves the watermark where it was (mutation: move
// `setSchedulerState` ahead of the rows → red); a follower never enqueues; the floors at
// `createTask`; the pending acts; the global pause; the registry-epoch reset and its re-init;
// idempotent init; the stale-claim sweep; the E8 hook; `allows('schedule') === false`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { SCHEDULE_PROPOSAL_TTL_MS, type ScheduleRun, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

import { resetThreadSessions } from '../agent/threadSessions.js';
import type { SnugPlatform } from '../platform/platform.js';
import { bumpScheduleRevision } from '../platform/signals.js';
import type { StepContext, StepExecutor, StepOutcome } from '../schedule/engine-types.js';
import type { LeaderLocks } from '../schedule/leader.js';
import {
  SCHEDULER_LOCK_NAME_FALLBACK,
  __resetSchedulerForTests,
  clearHistory,
  createTask,
  deleteTask,
  freshSchedulerState,
  initScheduler,
  lockNameFor,
  markAllSeen,
  markSeen,
  noteAppVersion,
  reconcile,
  resetScheduler,
  runAllPending,
  runNow,
  runPending,
  schedulerStore,
  setGlobalPause,
  setTaskEnabled,
  skipAllPending,
  skipPending,
  sweepStaleClaims,
  updateTask,
  type SchedulerDeps,
} from '../schedule/scheduler.js';
import type { Tick, Ticker } from '../schedule/tick.js';
import { installTestUserDb } from './userdbTestHelper.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Friday 2026-10-09 12:05Z — the hourly 12:00 occurrence is five minutes old: late, not missed. */
const NOW = Date.parse('2026-10-09T12:05:00.000Z');
const TWELVE = '2026-10-09T12:00:00.000Z';
const CREATED = '2026-10-01T00:00:00.000Z';
const iso = (ms: number): string => new Date(ms).toISOString();

const WEB: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };

let db: UserDb;
let clock: number;

interface FakeTicker {
  factory: SchedulerDeps['ticker'];
  /** Every ticker ever built — one per init. */
  built: Array<{ ticker: Ticker; started: boolean; stopped: boolean; fire: (kind: Tick['kind']) => void }>;
}

function fakeTicker(): FakeTicker {
  const built: FakeTicker['built'] = [];
  const factory: SchedulerDeps['ticker'] = (onTick, now) => {
    const entry: FakeTicker['built'][number] = {
      ticker: {
        start: () => {
          entry.started = true;
        },
        stop: () => {
          entry.stopped = true;
        },
        nextFireAt: () => undefined,
      },
      started: false,
      stopped: false,
      fire: (kind) => onTick({ kind, at: now() }),
    };
    built.push(entry);
    return entry.ticker;
  };
  return { factory, built };
}

/** A lock manager whose name is HELD by another tab: `ifAvailable` answers null, the blocking request parks until `release()`. */
function heldElsewhere(): LeaderLocks & { release: () => void; names: string[] } {
  const names: string[] = [];
  let grant: (() => void) | undefined;
  const request = (name: string, first: unknown, second?: unknown): Promise<unknown> => {
    names.push(name);
    const options = (typeof first === 'function' ? {} : first) as LockOptions;
    const callback = (typeof first === 'function' ? first : second) as (lock: Lock | null) => unknown;
    if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
    return new Promise((resolve) => {
      grant = () => resolve(callback({ name, mode: 'exclusive' }));
    });
  };
  return { request: request as LeaderLocks['request'], release: () => grant?.(), names };
}

interface Recorder {
  calls: Array<{ step: ScheduleStep; ctx: StepContext }>;
  execute: StepExecutor;
}

function recorder(answer: (step: ScheduleStep) => StepOutcome = () => ({ status: 'ok', summary: 'done', calls: { ai: 0, net: 0 } })): Recorder {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    execute: async (step, ctx) => {
      calls.push({ step, ctx });
      return answer(step);
    },
  };
}

const NOTIFY: ScheduleStep = { kind: 'notify', title: 'Water', body: 'the ferns' };
const THINK: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } };

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'Hourly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [NOTIFY],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 7 * DAY,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
  ...over,
});

const seed = (over: Partial<ScheduledTask> = {}): ScheduledTask => {
  const t = task(over);
  db.putScheduledTask(t);
  return t;
};

const run = (over: Partial<ScheduleRun> & Pick<ScheduleRun, 'dueAt' | 'status'>): ScheduleRun => ({
  id: `r-${over.dueAt}`,
  taskId: 't1',
  trigger: 'due',
  collapsedCount: 1,
  host: { kind: 'web' },
  steps: [],
  calls: { ai: 0, net: 0 },
  ...over,
});

const rows = (taskId = 't1'): ScheduleRun[] => db.listScheduleRuns(taskId);

interface Harness {
  ticker: FakeTicker;
  rec: Recorder;
  deps: Partial<SchedulerDeps>;
}

function harness(over: Partial<SchedulerDeps> = {}, answer?: (step: ScheduleStep) => StepOutcome): Harness {
  const ticker = fakeTicker();
  const rec = recorder(answer);
  return {
    ticker,
    rec,
    deps: {
      db: () => Promise.resolve(db),
      execute: rec.execute,
      locks: undefined, // no lock manager: this context leads
      ticker: ticker.factory,
      now: () => new Date(clock),
      platform: () => WEB,
      allows: () => true,
      ...over,
    },
  };
}

beforeEach(async () => {
  __resetSchedulerForTests();
  clock = NOW;
  db = await installTestUserDb();
  db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
});

afterEach(() => {
  __resetSchedulerForTests();
});

describe('boot (E1)', () => {
  it('a fresh file: schedulerState is born with watermark = now, nothing is planned, the view is ready and leading', async () => {
    seed(); // enabled since the 1st — but the file has never been reconciled: nothing before now was ever due HERE
    expect(db.getSchedulerState()).toBeUndefined();
    const h = harness();
    await initScheduler(h.deps);
    expect(db.getSchedulerState()).toEqual({ watermark: iso(NOW), globalPause: false, daily: { date: '2026-10-09', ai: 0, net: 0 } });
    expect(rows()).toEqual([]);
    expect(h.rec.calls).toHaveLength(0);
    const view = schedulerStore.get();
    expect(view.ready).toBe(true);
    expect(view.leader).toEqual({ leader: true, canSeeSiblings: false, reason: 'no-locks' });
    expect(view.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(view.lastReconcileAt).toBe(iso(NOW));
    expect(view.honesty).toBe('runs while this tab is open · other tabs can’t be seen from here');
    expect(h.ticker.built).toHaveLength(1);
    expect(h.ticker.built[0]?.started).toBe(true);
  });

  it('is idempotent: a second call answers the same promise and builds nothing twice', async () => {
    const h = harness();
    const setState = vi.spyOn(db, 'setSchedulerState');
    const first = initScheduler(h.deps);
    const second = initScheduler();
    expect(second).toBe(first);
    await first;
    await initScheduler();
    expect(h.ticker.built).toHaveLength(1);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it('allows("schedule") === false: resolves at once, the store stays ready:false, no row, no ticker', async () => {
    seed();
    const h = harness({ allows: () => false });
    await initScheduler(h.deps);
    expect(schedulerStore.get().ready).toBe(false);
    expect(db.getSchedulerState()).toBeUndefined();
    expect(h.ticker.built).toHaveLength(0);
  });

  it('sweeps `running` claims older than their bound to `interrupted` (stale claim) and leaves a live one alone', async () => {
    seed({ id: 't1' });
    seed({ id: 't2', steps: [THINK] });
    db.putScheduleRun(run({ taskId: 't1', id: 'old', dueAt: iso(NOW - 10 * MINUTE), status: 'running', startedAt: iso(NOW - 10 * MINUTE) }));
    db.putScheduleRun(run({ taskId: 't1', id: 'live', dueAt: iso(NOW - MINUTE), status: 'running', startedAt: iso(NOW - 30_000) }));
    db.putScheduleRun(run({ taskId: 't2', id: 'think', dueAt: iso(NOW - 4 * MINUTE), status: 'running', startedAt: iso(NOW - 4 * MINUTE) })); // inside the 300 s think bound
    db.putScheduleRun(run({ taskId: 't2', id: 'noStart', dueAt: iso(NOW - 3 * MINUTE), status: 'running' }));
    db.setSchedulerState(freshSchedulerState(iso(NOW)));
    await initScheduler(harness().deps);
    const byId = (id: string) => [...rows('t1'), ...rows('t2')].find((row) => row.id === id);
    expect(byId('old')).toMatchObject({ status: 'interrupted', reason: 'stale claim', finishedAt: iso(NOW) });
    expect(byId('live')?.status).toBe('running');
    expect(byId('think')?.status).toBe('running');
    expect(byId('noStart')).toMatchObject({ status: 'interrupted', reason: 'stale claim' });
    expect(sweepStaleClaims(db, new Date(clock))).toBe(0); // nothing left to sweep
  });

  it('the lock name is snug-scheduler:<file id> when the file id is known, else the constant fallback', () => {
    expect(lockNameFor(db, () => 'abc-123')).toBe('snug-scheduler:abc-123');
    expect(lockNameFor(db, () => undefined)).toBe(SCHEDULER_LOCK_NAME_FALLBACK);
    expect(SCHEDULER_LOCK_NAME_FALLBACK).toBe('snug-scheduler');
  });
});

describe('reconcile (E4/E5)', () => {
  it('an occurrence due in the past within the grace runs ONCE, as `late`; the next reconcile does not run it again', async () => {
    seed({ enabledAt: iso(NOW - 35 * MINUTE) });
    db.setSchedulerState(freshSchedulerState(iso(NOW - 10 * MINUTE))); // a file reconciled ten minutes ago: 12:00 is late, not history
    const h = harness();
    await initScheduler(h.deps);
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('ok'));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ dueAt: TWELVE, trigger: 'late', status: 'ok', host: { kind: 'web' } });
    expect(h.rec.calls).toHaveLength(1);
    expect(db.getScheduledTask('t1')?.ranThrough).toBe(TWELVE);
    expect(db.getSchedulerState()?.watermark).toBe(iso(NOW));
    clock += MINUTE;
    await reconcile('tick');
    await vi.waitFor(() => expect(schedulerStore.get().queued).toBe(0));
    expect(h.rec.calls).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('48 missed hourly occurrences become ONE pending row (collapsedCount 48) and the card count is 1', async () => {
    seed();
    clock = NOW + 15 * MINUTE; // 12:20 — the 12:00 occurrence is twenty minutes old: missed, like the 47 before it
    db.setSchedulerState(freshSchedulerState(iso(clock - 2 * DAY)));
    const h = harness();
    await initScheduler(h.deps);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'pending', trigger: 'catch-up', collapsedCount: 48, dueAt: TWELVE });
    expect(h.rec.calls).toHaveLength(0);
    expect(schedulerStore.get().pending).toBe(1);
    expect(db.getScheduledTask('t1')?.ranThrough).toBe(TWELVE);
    expect(db.getScheduledTask('t1')?.updatedAt, 'the advance is bookkeeping, not an edit (M16)').toBe(CREATED);
    expect(db.getSchedulerState()?.watermark).toBe(iso(clock));
  });

  it('a reconcile with nothing written since the last refresh re-reads NO rows: it plans over the view’s own (M3)', async () => {
    seed();
    const h = harness();
    await initScheduler(h.deps);
    const reads = vi.spyOn(db, 'listAllScheduleRuns');
    clock += 30_000;
    await reconcile('tick');
    expect(reads).toHaveBeenCalledTimes(0);
    db.putScheduleRun(run({ dueAt: iso(NOW - HOUR), status: 'ok' }));
    bumpScheduleRevision(); // a write announces itself: the refresh re-reads once, the reconcile after it reads nothing more
    await reconcile('tick');
    expect(reads).toHaveBeenCalledTimes(1);
    expect(schedulerStore.get().runsByTask.t1).toHaveLength(1);
    reads.mockRestore();
  });

  it('a `late` or `visible` reconcile sweeps a stale running claim that appeared after boot; a minute tick does not (S5)', async () => {
    seed();
    const h = harness();
    await initScheduler(h.deps);
    db.putScheduleRun(run({ id: 'ghost', dueAt: iso(NOW - 10 * MINUTE), status: 'running', startedAt: iso(NOW - 10 * MINUTE) }));
    bumpScheduleRevision();
    h.ticker.built[0]?.fire('minute');
    await vi.waitFor(() => expect(schedulerStore.get().lastReconcileAt).toBe(iso(clock)));
    expect(rows().find((row) => row.id === 'ghost')?.status).toBe('running');
    h.ticker.built[0]?.fire('late');
    await vi.waitFor(() => expect(rows().find((row) => row.id === 'ghost')?.status).toBe('interrupted'));
    expect(rows().find((row) => row.id === 'ghost')).toMatchObject({ reason: 'stale claim' });
    db.putScheduleRun(run({ id: 'ghost2', dueAt: iso(NOW - 9 * MINUTE), status: 'running', startedAt: iso(NOW - 9 * MINUTE) }));
    bumpScheduleRevision();
    h.ticker.built[0]?.fire('visible');
    await vi.waitFor(() => expect(rows().find((row) => row.id === 'ghost2')?.status).toBe('interrupted'));
  });

  it('a refused write between candidate rows leaves the watermark where it was (mutation: write the watermark first → red)', async () => {
    seed({ id: 't1' });
    seed({ id: 't2' });
    clock = NOW + 15 * MINUTE; // 12:20: 11:00 and 12:00 are both missed — ONE pending write per schedule
    const before = iso(clock - 2 * HOUR);
    db.setSchedulerState(freshSchedulerState(before));
    const original = db.putScheduleRun.bind(db);
    let writes = 0;
    const spy = vi.spyOn(db, 'putScheduleRun').mockImplementation((row) => {
      writes += 1;
      if (writes === 2) throw new Error('disk full');
      original(row);
    });
    await initScheduler(harness().deps);
    expect(db.getSchedulerState()?.watermark).toBe(before);
    expect(rows('t1')).toHaveLength(1);
    expect(rows('t2')).toHaveLength(0);
    expect(schedulerStore.get().lastError).toBe('disk full');
    spy.mockRestore();
    await reconcile('manual');
    expect(rows('t1')).toHaveLength(1); // t1's row and its advanced ranThrough dedupe its occurrences
    expect(rows('t2')).toHaveLength(1);
    expect(db.getSchedulerState()?.watermark).toBe(iso(clock));
    expect(schedulerStore.get().lastError).toBeUndefined();
  });

  it('a newer missed candidate supersedes an older pending row (skipped, reason superseded) — one card per schedule', async () => {
    seed();
    clock = NOW + 15 * MINUTE; // 12:20: 11:00 and 12:00 are missed and collapse to 12:00 (2), absorbing the older pending (2)
    db.putScheduleRun(run({ dueAt: iso(NOW - 3 * HOUR - 5 * MINUTE), status: 'pending', trigger: 'catch-up', collapsedCount: 2 }));
    db.setSchedulerState(freshSchedulerState(iso(NOW - 2 * HOUR)));
    await initScheduler(harness().deps);
    const byStatus = (status: ScheduleRun['status']) => rows().filter((row) => row.status === status);
    expect(byStatus('pending')).toEqual([expect.objectContaining({ dueAt: TWELVE, collapsedCount: 4 })]);
    expect(byStatus('skipped')).toEqual([expect.objectContaining({ reason: 'superseded' })]);
    expect(schedulerStore.get().pending).toBe(1);
  });

  it('the ticker drives reconcile: a `minute` tick after the clock moved past the next boundary runs the occurrence as due', async () => {
    seed();
    const h = harness();
    await initScheduler(h.deps);
    clock = Date.parse('2026-10-09T13:00:00.200Z');
    h.ticker.built[0]?.fire('minute');
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('ok'));
    expect(rows()[0]).toMatchObject({ dueAt: '2026-10-09T13:00:00.000Z', trigger: 'due' });
    expect(schedulerStore.get().lastReconcileAt).toBe(iso(clock));
  });

  it('a follower NEVER enqueues: a late occurrence stays unrun and the watermark stays; a promotion over its boot-time copy asks for a reload and plans NOTHING (S3)', async () => {
    seed({ enabledAt: iso(NOW - 35 * MINUTE) });
    const before = iso(NOW - 10 * MINUTE);
    db.setSchedulerState(freshSchedulerState(before)); // a leader would run 12:00 as late from here
    const locks = heldElsewhere();
    const h = harness({ locks });
    await initScheduler(h.deps);
    expect(schedulerStore.get().leader).toEqual({ leader: false, canSeeSiblings: true, reason: 'locks' });
    expect(schedulerStore.get().ready).toBe(true);
    expect(schedulerStore.get().needsReload).toBe(false);
    expect(schedulerStore.get().lastReconcileAt).toBeUndefined();
    // The lock is keyed on THIS file's id (`getFileId()`), so two files on one origin never share a ticker.
    const lockName = lockNameFor(db, (d) => d.getFileId());
    expect(lockName).toMatch(/^snug-scheduler:[0-9a-f-]{36}$/);
    expect(locks.names).toEqual([lockName, lockName]);
    h.ticker.built[0]?.fire('minute');
    h.ticker.built[0]?.fire('visible');
    await Promise.resolve();
    expect(h.rec.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
    expect(db.getSchedulerState()?.watermark).toBe(before);
    expect(schedulerStore.get().tasks.map((t) => t.id)).toEqual(['t1']); // the view is read all the same
    clock += MINUTE;
    locks.release(); // the leader tab closed: this tab is promoted over the handle it opened at boot — stale after the leader's writes
    await vi.waitFor(() => expect(schedulerStore.get().leader?.leader).toBe(true));
    expect(schedulerStore.get().needsReload).toBe(true);
    h.ticker.built[0]?.fire('minute');
    h.ticker.built[0]?.fire('late');
    await reconcile('manual');
    expect(h.rec.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
    expect(db.getSchedulerState()?.watermark).toBe(before);
    expect(schedulerStore.get().lastReconcileAt).toBeUndefined();
    expect(schedulerStore.get().tasks.map((t) => t.id)).toEqual(['t1']); // the view still reads
  });

  it('runs an *Ask the AI* step through the injected executor and records its proposals and calls', async () => {
    seed({ steps: [THINK], enabledAt: iso(NOW - 35 * MINUTE), missedPolicy: 'ask' });
    db.setSchedulerState(freshSchedulerState(iso(NOW - 10 * MINUTE)));
    const h = harness({}, () => ({
      status: 'ok',
      summary: 'two unpaid',
      calls: { ai: 1, net: 0 },
      proposals: [{ appId: 'ledger', sql: 'UPDATE ledger SET paid = 1 WHERE id = 7', summary: 'mark 7 paid' }],
    }));
    await initScheduler(h.deps);
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('ok'));
    expect(rows()[0]?.proposals).toEqual({ items: [{ appId: 'ledger', sql: 'UPDATE ledger SET paid = 1 WHERE id = 7', summary: 'mark 7 paid' }], expiresAt: iso(NOW + SCHEDULE_PROPOSAL_TTL_MS) });
    expect(db.getSchedulerState()?.daily).toEqual({ date: '2026-10-09', ai: 1, net: 0 });
    expect(schedulerStore.get().unseen).toBe(1);
  });
});

describe('createTask / updateTask / setTaskEnabled (floors, defaults, app versions)', () => {
  it('refuses a 1-minute schedule an app proposed, accepts a 5-minute one the user typed', async () => {
    await initScheduler(harness().deps);
    const refused = await createTask({ title: 'Nag', steps: [NOTIFY], spec: { kind: 'every', n: 1, unit: 'minutes', tz: 'UTC' }, provenance: 'app', ownerAppId: 'ledger' });
    expect(refused).toEqual({ ok: false, reason: 'too often: this would run every 1 minute, and a schedule that was suggested or imported may run at most every 15 minutes' });
    const accepted = await createTask({ title: 'Sip', steps: [NOTIFY], spec: { kind: 'every', n: 5, unit: 'minutes', tz: 'UTC' }, provenance: 'user' });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.task).toMatchObject({
      title: 'Sip',
      enabled: true,
      enabledAt: iso(NOW),
      cron: '*/5 * * * *',
      missedPolicy: 'run-once', // reminders only → catches up silently (Q12)
      staleAfterMs: 5 * MINUTE,
      alert: 'inbox',
      appVersions: {},
      provenance: 'user',
      createdAt: iso(NOW),
      updatedAt: iso(NOW),
    });
    expect(db.getScheduledTask(accepted.task.id)).toEqual(accepted.task);
    expect(schedulerStore.get().tasks.map((t) => t.title)).toEqual(['Sip']);
  });

  it('records each named app’s version at enable, defaults a spending schedule to `ask`, and refuses a missing app by name', async () => {
    await initScheduler(harness().deps);
    const thinking = await createTask({ title: 'Sum', steps: [THINK], spec: { kind: 'daily', time: '08:00', tz: 'UTC' }, provenance: 'user' });
    expect(thinking.ok && thinking.task.appVersions).toEqual({ ledger: 1 });
    expect(thinking.ok && thinking.task.missedPolicy).toBe('ask');
    const missing = await createTask({ title: 'Ghost', steps: [{ kind: 'app-think', appId: 'nope', prompt: 'x', context: { maxRows: 50 } }], spec: { kind: 'daily', time: '08:00', tz: 'UTC' }, provenance: 'user' });
    expect(missing).toEqual({ ok: false, reason: 'app "nope" is not installed in this file' });
    const secret = await createTask({ title: 'Leak', steps: [{ kind: 'notify', title: 'k', body: 'use sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD today' }], spec: { kind: 'daily', time: '08:00', tz: 'UTC' }, provenance: 'user' });
    expect(secret.ok).toBe(false);
    expect(!secret.ok && secret.reason).toMatch(/credential/);
    expect(db.listScheduledTasks().map((t) => t.title)).toEqual(['Sum']);
  });

  it('updateTask recompiles a changed spec under the floor of the task’s own provenance and stamps updatedAt', async () => {
    await initScheduler(harness().deps);
    const t = seed({ provenance: 'chat' });
    clock += MINUTE;
    const tooOften = await updateTask(t.id, { spec: { kind: 'every', n: 10, unit: 'minutes', tz: 'UTC' } });
    expect(tooOften.ok).toBe(false);
    const fine = await updateTask(t.id, { title: 'Daily', spec: { kind: 'daily', time: '09:30', tz: 'UTC' } });
    expect(fine.ok && fine.task).toMatchObject({ title: 'Daily', cron: '30 9 * * *', staleAfterMs: DAY, updatedAt: iso(clock) });
    expect(await updateTask('nope', { title: 'x' })).toEqual({ ok: false, reason: 'no such schedule' });
  });

  it('setTaskEnabled: off clears the pause reason; on resumes from now with fresh app versions and zeroed counters', async () => {
    await initScheduler(harness().deps);
    const t = seed({ steps: [THINK], appVersions: { ledger: 1 }, pausedReason: 'failures', enabled: false, consecutiveFailures: 5 });
    db.saveAppVersion('ledger', '<html>v2</html>');
    clock += MINUTE;
    const off = await setTaskEnabled(t.id, false);
    expect(off.ok && off.task).toMatchObject({ enabled: false, updatedAt: iso(clock) });
    expect(off.ok && off.task.pausedReason).toBeUndefined();
    const on = await setTaskEnabled(t.id, true);
    expect(on.ok && on.task).toMatchObject({ enabled: true, enabledAt: iso(clock), consecutiveFailures: 0, unseenResults: 0, appVersions: { ledger: 2 } });
  });

  it('setTaskEnabled(true) applies the floor of the task’s provenance and refuses an imported schedule until the editor’s reviewed save — both routed to review (S2/M2)', async () => {
    await initScheduler(harness().deps);
    const imported = seed({ id: 'imp', provenance: 'imported', enabled: false });
    const refused = await setTaskEnabled(imported.id, true);
    expect(refused).toEqual({ ok: false, reason: 'this schedule arrived with an imported file — review it before turning it on', route: 'review' });
    expect(db.getScheduledTask('imp')?.enabled).toBe(false);
    const reviewed = await setTaskEnabled(imported.id, true, { reviewed: true });
    expect(reviewed.ok && reviewed.task).toMatchObject({ enabled: true, provenance: 'imported', enabledAt: iso(NOW) });

    const tooOften = seed({ id: 'often', provenance: 'chat', enabled: false, spec: { kind: 'every', n: 10, unit: 'minutes', tz: 'UTC' }, cron: '*/10 * * * *' });
    const floor = await setTaskEnabled(tooOften.id, true);
    expect(floor.ok).toBe(false);
    expect(!floor.ok && floor.reason).toContain('15 minutes');
    expect(!floor.ok && floor.route).toBe('review');
    expect(db.getScheduledTask('often')?.enabled).toBe(false);
    const fine = await setTaskEnabled(seed({ id: 'ok', provenance: 'user', enabled: false, spec: { kind: 'every', n: 10, unit: 'minutes', tz: 'UTC' }, cron: '*/10 * * * *' }).id, true);
    expect(fine.ok).toBe(true);
  });
});

describe('the pending acts, seen, history, delete', () => {
  it('runAllPending enqueues every pending row as a catch-up with its collapsed count; skipAllPending records the rest as skipped by the user', async () => {
    seed({ id: 't1' });
    seed({ id: 't2' });
    db.putScheduleRun(run({ taskId: 't1', dueAt: iso(NOW - 2 * HOUR), status: 'pending', trigger: 'catch-up', collapsedCount: 3 }));
    db.putScheduleRun(run({ taskId: 't2', dueAt: iso(NOW - 3 * HOUR), status: 'pending', trigger: 'catch-up', collapsedCount: 1 }));
    db.setSchedulerState(freshSchedulerState(iso(NOW)));
    const h = harness();
    await initScheduler(h.deps);
    expect(schedulerStore.get().pending).toBe(2);
    expect(await runAllPending()).toBe(2);
    await vi.waitFor(() => expect(h.rec.calls).toHaveLength(2));
    await vi.waitFor(() => expect(schedulerStore.get().pending).toBe(0));
    expect(rows('t1')[0]).toMatchObject({ status: 'ok', trigger: 'catch-up', collapsedCount: 3 });
    expect(rows('t2')[0]).toMatchObject({ status: 'ok', trigger: 'catch-up', collapsedCount: 1 });

    db.putScheduleRun(run({ taskId: 't1', dueAt: iso(NOW - 4 * HOUR), status: 'pending', trigger: 'catch-up' }));
    expect(await skipAllPending()).toBe(1);
    expect(rows('t1').find((row) => row.dueAt === iso(NOW - 4 * HOUR))).toMatchObject({ status: 'skipped', reason: 'user', finishedAt: iso(NOW) });
  });

  it('runPending / skipPending act on one row; an absent row refuses', async () => {
    seed();
    db.putScheduleRun(run({ dueAt: iso(NOW - 2 * HOUR), status: 'pending', trigger: 'catch-up', collapsedCount: 2 }));
    db.putScheduleRun(run({ dueAt: iso(NOW - 5 * HOUR), status: 'pending', trigger: 'catch-up' }));
    db.setSchedulerState(freshSchedulerState(iso(NOW)));
    const h = harness();
    await initScheduler(h.deps);
    expect(await skipPending('t1', iso(NOW - 5 * HOUR))).toEqual({ ok: true });
    expect(await skipPending('t1', iso(NOW - 5 * HOUR))).toEqual({ ok: false, reason: 'nothing is waiting for that time' });
    expect(await runPending('t1', iso(NOW - 2 * HOUR))).toEqual({ ok: true });
    await vi.waitFor(() => expect(rows().find((row) => row.dueAt === iso(NOW - 2 * HOUR))?.status).toBe('ok'));
    expect(h.rec.calls[0]?.ctx.run).toMatchObject({ trigger: 'catch-up', dueAt: iso(NOW - 2 * HOUR) });
    expect(await runPending('nope', iso(NOW))).toEqual({ ok: false, reason: 'no such schedule' });
  });

  it('runNow enqueues a manual run due this instant for an ENABLED schedule and refuses a disabled or paused one by name (M2)', async () => {
    seed();
    seed({ id: 'off', title: 'Night check', enabled: false });
    seed({ id: 'paused', title: 'Weekly sum', enabled: false, pausedReason: 'failures' });
    const h = harness();
    await initScheduler(h.deps);
    expect(await runNow('t1')).toEqual({ ok: true });
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('ok'));
    expect(rows()[0]).toMatchObject({ trigger: 'manual', dueAt: iso(NOW) });
    expect(await runNow('off')).toEqual({ ok: false, reason: '“Night check” is off — turn it on to run it' });
    expect(await runNow('paused')).toEqual({ ok: false, reason: '“Weekly sum” is off — turn it on to run it' });
    expect(rows('off')).toEqual([]);
    expect(await runNow('nope')).toEqual({ ok: false, reason: 'no such schedule' });
  });

  it('runPending and runAllPending skip a disabled schedule’s candidates (S1); a refused claim surfaces as the view’s lastError (S5)', async () => {
    seed({ id: 't1' });
    seed({ id: 'off', title: 'Night check', enabled: false });
    db.putScheduleRun(run({ taskId: 't1', dueAt: iso(NOW - 2 * HOUR), status: 'pending', trigger: 'catch-up' }));
    db.putScheduleRun(run({ taskId: 'off', dueAt: iso(NOW - 3 * HOUR), status: 'pending', trigger: 'catch-up' }));
    db.setSchedulerState(freshSchedulerState(iso(NOW)));
    const h = harness();
    await initScheduler(h.deps);
    expect(await runPending('off', iso(NOW - 3 * HOUR))).toEqual({ ok: false, reason: '“Night check” is off — turn it on to run it' });
    expect(await runAllPending()).toBe(1);
    await vi.waitFor(() => expect(h.rec.calls).toHaveLength(1));
    expect(h.rec.calls[0]?.ctx.task.id).toBe('t1');
    expect(rows('off')[0]?.status).toBe('pending');

    seed({ id: 'full' });
    for (let i = 0; i < 50; i += 1) {
      db.putScheduleRun(run({ taskId: 'full', id: `ny-${i}`, dueAt: iso(NOW - (i + 1) * HOUR), status: 'needs-you' }));
    }
    expect(await runNow('full')).toEqual({ ok: true });
    await vi.waitFor(() => expect(schedulerStore.get().lastError).toMatch(/waiting on the user/));
    expect(h.rec.calls).toHaveLength(1);
  });

  it('markSeen is a user gesture: seenAt stamped once, the task’s unseen count down by one; markAllSeen clears the rest', async () => {
    seed({ unseenResults: 3 });
    const results = [iso(NOW - HOUR), iso(NOW - 2 * HOUR), iso(NOW - 3 * HOUR)];
    for (const dueAt of results) db.putScheduleRun(run({ dueAt, status: 'ok' }));
    db.putScheduleRun(run({ dueAt: iso(NOW - 4 * HOUR), status: 'skipped' })); // not a result
    db.setSchedulerState(freshSchedulerState(iso(NOW)));
    await initScheduler(harness().deps);
    expect(schedulerStore.get().unseen).toBe(3);
    await markSeen('t1', results[0]!);
    await markSeen('t1', results[0]!); // twice: still one
    expect(rows().find((row) => row.dueAt === results[0])?.seenAt).toBe(iso(NOW));
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(2);
    expect(schedulerStore.get().unseen).toBe(2);
    expect(await markAllSeen()).toBe(2);
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(0);
    expect(schedulerStore.get().unseen).toBe(0);
    expect(rows().filter((row) => row.status === 'skipped')[0]?.seenAt).toBeUndefined();
  });

  it('opening a FAILED result keeps the counter consistent: the fold counted it, the gesture takes it off; a skip is never a result (M8)', async () => {
    seed({ enabledAt: iso(NOW - 35 * MINUTE) });
    db.setSchedulerState(freshSchedulerState(iso(NOW - 10 * MINUTE)));
    const h = harness({}, () => {
      throw new Error('no channel');
    });
    await initScheduler(h.deps);
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('failed'));
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(1);
    expect(schedulerStore.get().unseen).toBe(1);
    await markSeen('t1', TWELVE);
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(0);
    expect(schedulerStore.get().unseen).toBe(0);
    db.putScheduleRun(run({ dueAt: iso(NOW - 5 * HOUR), status: 'skipped', reason: 'stale' }));
    await markSeen('t1', iso(NOW - 5 * HOUR));
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(0);
    expect(rows().find((row) => row.status === 'skipped')?.seenAt).toBeUndefined();
  });

  it('clearHistory keeps what is not dealt with; deleteTask removes the schedule and its rows and the view follows', async () => {
    seed();
    db.putScheduleRun(run({ dueAt: iso(NOW - HOUR), status: 'ok' }));
    db.putScheduleRun(run({ dueAt: iso(NOW - 2 * HOUR), status: 'pending', trigger: 'catch-up' }));
    db.setSchedulerState(freshSchedulerState(iso(NOW)));
    await initScheduler(harness().deps);
    await clearHistory('t1');
    expect(rows().map((row) => row.status)).toEqual(['pending']);
    await deleteTask('t1');
    expect(db.getScheduledTask('t1')).toBeUndefined();
    expect(rows()).toEqual([]);
    expect(schedulerStore.get().tasks).toEqual([]);
    expect(schedulerStore.get().pending).toBe(0);
  });
});

describe('the global pause (E7) and the E8 hook', () => {
  it('setGlobalPause holds the queue: nothing is planned or run while paused (held occurrences come back late), and runNow refuses', async () => {
    seed({ enabledAt: iso(NOW - 35 * MINUTE) });
    db.setSchedulerState({ ...freshSchedulerState(iso(NOW - 10 * MINUTE)), globalPause: true });
    const h = harness();
    await initScheduler(h.deps);
    expect(h.rec.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
    expect(db.getSchedulerState()?.watermark).toBe(iso(NOW - 10 * MINUTE));
    expect(await runNow('t1')).toEqual({ ok: false, reason: 'all schedules are paused' });
    clock += 2 * MINUTE;
    await setGlobalPause(false);
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('ok'));
    expect(rows()[0]).toMatchObject({ trigger: 'late', dueAt: TWELVE });
    expect(db.getSchedulerState()).toMatchObject({ globalPause: false, watermark: iso(clock) });
  });

  it('pausing with a run in flight interrupts it (reason paused) and drops what waited', async () => {
    seed({ id: 't1', enabledAt: iso(NOW - 35 * MINUTE) });
    seed({ id: 't2', enabledAt: iso(NOW - 35 * MINUTE) });
    db.setSchedulerState(freshSchedulerState(iso(NOW - 10 * MINUTE))); // both have a late 12:00: one runs, one waits
    let release: (() => void) | undefined;
    const h = harness({}, () => ({ status: 'ok', calls: { ai: 0, net: 0 } }));
    h.rec.execute = (step, ctx) =>
      new Promise((resolve, reject) => {
        h.rec.calls.push({ step, ctx });
        release = () => resolve({ status: 'ok', calls: { ai: 0, net: 0 } });
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await initScheduler({ ...h.deps, execute: h.rec.execute });
    await vi.waitFor(() => expect(h.rec.calls).toHaveLength(1));
    expect(schedulerStore.get().queued).toBe(1);
    await setGlobalPause(true);
    await vi.waitFor(() => expect(rows('t1')[0]?.status).toBe('interrupted'));
    expect(rows('t1')[0]?.reason).toBe('paused');
    expect(rows('t2')).toEqual([]);
    expect(schedulerStore.get().running).toBeUndefined();
    expect(release).toBeDefined();
  });

  it('noteAppVersion: a shared or agent update pauses every schedule naming the app at another version; the user’s own edit changes nothing', async () => {
    seed({ id: 'names', steps: [THINK], appVersions: { ledger: 1 } });
    seed({ id: 'other', steps: [NOTIFY] });
    seed({ id: 'current', steps: [THINK], appVersions: { ledger: 2 } });
    await initScheduler(harness().deps);
    expect(await noteAppVersion('ledger', 2, 'own')).toBe(0);
    expect(db.getScheduledTask('names')).toMatchObject({ enabled: true });
    clock += MINUTE;
    expect(await noteAppVersion('ledger', 2, 'shared')).toBe(1);
    expect(db.getScheduledTask('names')).toMatchObject({ enabled: false, pausedReason: 'app-updated', appVersions: { ledger: 1 }, updatedAt: iso(clock) });
    expect(db.getScheduledTask('other')).toMatchObject({ enabled: true, updatedAt: CREATED });
    expect(db.getScheduledTask('current')).toMatchObject({ enabled: true });
    expect(await noteAppVersion('ledger', 3, 'agent')).toBe(1); // `current` drifts now; `names` is already paused for this
    expect(db.getScheduledTask('current')).toMatchObject({ enabled: false, pausedReason: 'app-updated' });
    expect(schedulerStore.get().tasks.filter((t) => t.pausedReason === 'app-updated')).toHaveLength(2);
  });
});

describe('the swap seams (E1)', () => {
  it('a registry-epoch bump resets the engine synchronously (ticker stopped, view cleared) and re-inits once the user db is ready', async () => {
    seed();
    const h = harness();
    await initScheduler(h.deps);
    expect(schedulerStore.get().ready).toBe(true);
    resetThreadSessions(); // the swap seam every file replacement goes through
    expect(schedulerStore.get().ready).toBe(false);
    expect(schedulerStore.get().tasks).toEqual([]);
    expect(h.ticker.built[0]?.stopped).toBe(true);
    await vi.waitFor(() => expect(schedulerStore.get().ready).toBe(true));
    expect(h.ticker.built).toHaveLength(2);
    expect(h.ticker.built[1]?.started).toBe(true);
    expect(schedulerStore.get().tasks.map((t) => t.id)).toEqual(['t1']); // the remembered deps still point at this file
  });

  it('resetScheduler aborts a run in flight (interrupted, file swap) and a later initScheduler boots afresh', async () => {
    seed({ enabledAt: iso(NOW - 35 * MINUTE) });
    db.setSchedulerState(freshSchedulerState(iso(NOW - 10 * MINUTE)));
    const started: Array<() => void> = [];
    const h = harness();
    const execute: StepExecutor = (_step, ctx) =>
      new Promise((_resolve, reject) => {
        started.push(() => undefined);
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await initScheduler({ ...h.deps, execute });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    resetScheduler();
    await vi.waitFor(() => expect(rows()[0]?.status).toBe('interrupted'));
    expect(rows()[0]?.reason).toBe('file swap');
    expect(schedulerStore.get().ready).toBe(false);
    await initScheduler();
    expect(schedulerStore.get().ready).toBe(true);
    expect(h.ticker.built).toHaveLength(2);
    expect(started).toHaveLength(1); // the recorded occurrence is never re-run
  });
});
