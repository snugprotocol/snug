// taskWriteAuthority.test.ts — TASK-20261010-host-broker PR-4 (contract v2 D-PR4-7, D-PR4-8,
// D-PR4-10; AC31): the user's acts on a schedule's write authority, over the scheduler's
// composition root with a REAL memory user db and an injected clock.
//
//  - `armTask(taskId)` — the consent's tick act: writes `writeAuthority { rowsPerRun: 200, armedAt:
//    now, armedVersion: the app's current version }` and clears a `disarmed` trace; offered only for
//    a task whose *Ask <App>'s AI* steps all name ONE app.
//  - `disarmTask(taskId)` — the row's *stop making changes on its own*: no trace (the user did it).
//  - `disarmAllTasks()` — Settings' *stop every schedule making changes on its own*: one task write
//    per ARMED task, answering how many.
//  - `updateTask`'s widening rules: an armed task loses its authority when its steps change (compared
//    by CANONICAL JSON — the editor sends `steps` on every save), its `ownerAppId` changes, or its
//    spec's minimum interval gets SHORTER; a title, alert or missed-policy edit never disarms. The
//    consent path re-arms through `armTask` (the same save's consent tick).
//  - kept across off/on and pause/resume (the walk's `stillArmed` refuses meanwhile).
//  - nothing but those acts writes an authority: `createTask` and a patch never carry one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleStep, ScheduledTask } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import { scheduleRevisionStore } from '../platform/signals.js';
import { armTask, disarmAllTasks, disarmTask } from '../schedule/acts.js';
import type { StepExecutor } from '../schedule/engine-types.js';
import { __resetSchedulerForTests, createTask, initScheduler, noteAppVersion, setTaskEnabled, updateTask, type SchedulerDeps, type TaskPatch } from '../schedule/scheduler.js';
import { installTestUserDb } from './userdbTestHelper.js';

const NOW = Date.parse('2026-10-11T09:00:00.000Z');
const CREATED = '2026-10-01T00:00:00.000Z';
const OLD_ARMED_AT = '2026-10-05T09:00:00.000Z';
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const WEB: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };

let db: UserDb;
let clock: number;

const THINK = (appId: string, prompt = 'tidy the notes'): ScheduleStep => ({ kind: 'app-think', appId, prompt, context: { maxRows: 50 } });

function seed(id: string, over: Partial<ScheduledTask> & Record<string, unknown> = {}): ScheduledTask {
  const task = {
    id,
    title: `Tidy ${id}`,
    enabled: true,
    enabledAt: CREATED,
    provenance: 'user',
    steps: [THINK('ledger')],
    spec: { kind: 'daily', time: '08:00', tz: 'UTC' },
    cron: '0 8 * * *',
    missedPolicy: 'ask',
    staleAfterMs: DAY,
    alert: 'inbox',
    appVersions: { ledger: 1 },
    createdAt: CREATED,
    updatedAt: CREATED,
    consecutiveFailures: 0,
    unseenResults: 0,
    ...over,
  } as ScheduledTask;
  db.putScheduledTask(task);
  return task;
}

const armedSeed = (id: string, over: Partial<ScheduledTask> & Record<string, unknown> = {}): ScheduledTask =>
  seed(id, { writeAuthority: { rowsPerRun: 200, armedAt: OLD_ARMED_AT, armedVersion: 1 }, ...over } as Partial<ScheduledTask>);

const authorityOf = (id: string): unknown => (db.getScheduledTask(id) as (ScheduledTask & { writeAuthority?: unknown }) | undefined)?.writeAuthority;
const traceOf = (id: string): unknown => (db.getScheduledTask(id) as (ScheduledTask & { disarmed?: unknown }) | undefined)?.disarmed;

beforeEach(async () => {
  __resetSchedulerForTests();
  clock = NOW;
  db = await installTestUserDb();
  db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
  db.installApp({ appId: 'notes', displayName: 'Notes', html: '<html>notes</html>' });
  const execute: StepExecutor = async () => ({ status: 'ok', calls: { ai: 0, net: 0 } });
  const deps: Partial<SchedulerDeps> = {
    db: () => Promise.resolve(db),
    execute,
    locks: undefined,
    ticker: () => ({ start: () => undefined, stop: () => undefined, nextFireAt: () => undefined }),
    now: () => new Date(clock),
    platform: () => WEB,
    allows: () => true,
  };
  await initScheduler(deps);
});

afterEach(() => {
  __resetSchedulerForTests();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------- arm / disarm acts

describe('armTask — the consent’s tick act (D-PR4-8)', () => {
  it('writes {rowsPerRun: 200, armedAt: now, armedVersion: the app’s current version}, clears a disarmed trace, bumps the revision', async () => {
    seed('t1', { disarmed: { reason: 'imported', at: CREATED } } as Partial<ScheduledTask>);
    const revision = scheduleRevisionStore.get();
    const result = await armTask('t1');
    expect(result).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: iso(NOW), armedVersion: db.getApp('ledger')!.currentVersion });
    expect(traceOf('t1')).toBeUndefined();
    expect(scheduleRevisionStore.get()).toBeGreaterThan(revision);
  });

  it('records the app’s CURRENT version, not the one the task recorded at enable', async () => {
    db.saveAppVersion('ledger', '<html>ledger v2</html>', 'edit');
    seed('t1');
    expect(await armTask('t1')).toMatchObject({ ok: true });
    expect((authorityOf('t1') as { armedVersion: number }).armedVersion).toBe(2);
  });

  it('is offered only for a ONE-app task: ask steps naming two apps are refused, nothing written', async () => {
    seed('multi', { steps: [THINK('ledger'), THINK('notes')], appVersions: { ledger: 1, notes: 1 } });
    const result = await armTask('multi');
    expect(result.ok).toBe(false);
    expect(authorityOf('multi')).toBeUndefined();
  });

  it('a missing schedule is refused', async () => {
    expect((await armTask('nope')).ok).toBe(false);
  });
});

describe('disarmTask and disarmAllTasks — the kill switches are ACTS (D-PR4-10)', () => {
  it('disarmTask (the row’s act): the authority goes, NO trace (the user did it), the schedule stays on', async () => {
    armedSeed('t1');
    expect(await disarmTask('t1')).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toBeUndefined();
    expect(traceOf('t1')).toBeUndefined();
    expect(db.getScheduledTask('t1')?.enabled).toBe(true);
  });

  it('disarmAllTasks (the Settings act): every armed task loses its authority, ONE task write each — an unarmed task is not written', async () => {
    armedSeed('a1');
    armedSeed('a2', { steps: [THINK('notes')], appVersions: { notes: 1 } });
    seed('plain');
    const writes = vi.spyOn(db, 'putScheduledTask');
    expect(await disarmAllTasks()).toBe(2);
    expect(authorityOf('a1')).toBeUndefined();
    expect(authorityOf('a2')).toBeUndefined();
    expect(writes.mock.calls.map((call) => call[0].id).sort()).toEqual(['a1', 'a2']);
    expect(traceOf('a1')).toBeUndefined();
  });

  it('disarmAllTasks with nothing armed answers 0 and writes nothing', async () => {
    seed('plain');
    const writes = vi.spyOn(db, 'putScheduledTask');
    expect(await disarmAllTasks()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------- updateTask's widening rules

describe('updateTask — what widens a schedule’s authority disarms it; what does not, never does (D-PR4-8)', () => {
  it('the steps CHANGED (compared by canonical JSON) → disarmed, with no trace (the user edited it)', async () => {
    armedSeed('t1');
    expect(await updateTask('t1', { steps: [THINK('ledger', 'tidy AND delete old notes')] })).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toBeUndefined();
    expect(traceOf('t1')).toBeUndefined();
  });

  it('a tools:true step is a widening too → disarmed', async () => {
    armedSeed('t1');
    expect(await updateTask('t1', { steps: [{ ...THINK('ledger'), tools: true } as ScheduleStep] })).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toBeUndefined();
  });

  it('the SAME steps re-sent (the editor sends steps on every save — keys in another order) → still armed: never `patch.steps !== undefined`', async () => {
    armedSeed('t1');
    const reordered = { context: { maxRows: 50 }, prompt: 'tidy the notes', appId: 'ledger', kind: 'app-think' } as unknown as ScheduleStep;
    expect(await updateTask('t1', { steps: [reordered] })).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: OLD_ARMED_AT, armedVersion: 1 });
  });

  it('a title, alert or missed-policy edit NEVER disarms', async () => {
    armedSeed('t1');
    expect(await updateTask('t1', { title: 'Nightly tidy' })).toMatchObject({ ok: true });
    expect(await updateTask('t1', { alert: 'notification' })).toMatchObject({ ok: true });
    expect(await updateTask('t1', { missedPolicy: 'skip' })).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: OLD_ARMED_AT, armedVersion: 1 });
  });

  it('a SHORTER minimum interval disarms (daily → every 2 hours); a longer or equal one does not (daily 08:00 → daily 09:30 · → weekly)', async () => {
    armedSeed('shorter');
    expect(await updateTask('shorter', { spec: { kind: 'every', n: 2, unit: 'hours', tz: 'UTC' } })).toMatchObject({ ok: true });
    expect(authorityOf('shorter')).toBeUndefined();

    armedSeed('same');
    expect(await updateTask('same', { spec: { kind: 'daily', time: '09:30', tz: 'UTC' } })).toMatchObject({ ok: true });
    expect(authorityOf('same')).toBeDefined();

    armedSeed('longer');
    expect(await updateTask('longer', { spec: { kind: 'weekly', days: ['mon'], time: '08:00', tz: 'UTC' } })).toMatchObject({ ok: true });
    expect(authorityOf('longer')).toBeDefined();
  });

  it('an ownerAppId change disarms', async () => {
    armedSeed('t1', { provenance: 'app', ownerAppId: 'ledger' });
    expect(await updateTask('t1', { ownerAppId: 'notes' } as unknown as TaskPatch)).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toBeUndefined();
  });

  it('the consent path: the same save’s consent tick re-arms with a FRESH armedAt and the app’s current version', async () => {
    armedSeed('t1');
    clock = NOW + 60_000;
    expect(await updateTask('t1', { steps: [THINK('ledger', 'tidy AND archive')] })).toMatchObject({ ok: true });
    expect(await armTask('t1')).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: iso(NOW + 60_000), armedVersion: 1 });
  });

  it('a patch can never WRITE an authority (only the tick and the editor’s control do): a smuggled writeAuthority on an unarmed task is ignored', async () => {
    seed('t1');
    expect(await updateTask('t1', { title: 'x', writeAuthority: { rowsPerRun: 200, armedAt: iso(NOW), armedVersion: 1 } } as unknown as TaskPatch)).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toBeUndefined();
    // The passing twin: the act does write it.
    expect(await armTask('t1')).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toBeDefined();
  });

  it('createTask never writes an authority, whatever its input carries', async () => {
    const created = await createTask({
      title: 'Tidy',
      steps: [THINK('ledger')],
      spec: { kind: 'daily', time: '08:00', tz: 'UTC' },
      provenance: 'user',
      writeAuthority: { rowsPerRun: 200, armedAt: iso(NOW), armedVersion: 1 },
    } as unknown as Parameters<typeof createTask>[0]);
    expect(created.ok).toBe(true);
    if (created.ok) expect((created.task as ScheduledTask & { writeAuthority?: unknown }).writeAuthority).toBeUndefined();
    // The passing twin: the act arms it.
    if (created.ok) expect(await armTask(created.task.id)).toMatchObject({ ok: true });
  });
});

// ------------------------------------------------------------------------------- what keeps it

describe('kept across off/on and pause/resume — nothing applies meanwhile, but the consent stands (D-PR4-8)', () => {
  it('off then on: the authority is kept as it was', async () => {
    armedSeed('t1');
    expect(await setTaskEnabled('t1', false)).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: OLD_ARMED_AT, armedVersion: 1 });
    expect(await setTaskEnabled('t1', true)).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: OLD_ARMED_AT, armedVersion: 1 });
  });

  it('a failures pause and its resume keep it', async () => {
    armedSeed('t1', { enabled: false, pausedReason: 'failures' });
    expect(await setTaskEnabled('t1', true)).toMatchObject({ ok: true });
    expect(authorityOf('t1')).toEqual({ rowsPerRun: 200, armedAt: OLD_ARMED_AT, armedVersion: 1 });
  });

  it('an app version change through the act (noteAppVersion — the user’s own edit) disarms with the app-updated trace', async () => {
    armedSeed('t1');
    await noteAppVersion('ledger', 2, 'own');
    expect(authorityOf('t1')).toBeUndefined();
    expect(traceOf('t1')).toEqual({ reason: 'app-updated', at: iso(NOW) });
  });
});
