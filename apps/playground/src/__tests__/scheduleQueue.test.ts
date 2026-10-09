// scheduleQueue.test.ts — TASK-20261009-scheduling-framework E5/E7 (ADR-0074 §5–§6): the run
// queue. One run at a time, CLAIMED `running` before anything executes, bounded by an
// AbortController, folded into one status, written back with its calls, proposals and the
// task's counters; the notification is host-decided.
//
// Every case runs a RECORDING executor against a REAL memory-backed user db — the accessor
// whose upsert-by-(taskId, dueAt) the claim relies on is the production one, never a fake of it
// (lesson 2026-10-02: fakes share production shape). The db is opened here rather than through
// `userdbTestHelper` so this suite loads without the scheduler's composition root (and the
// executors it statically imports); it wires the same admission gate the helper does.
//
// MUTATION CHECKS (run during development, both red as predicted):
//  - remove the claim write (`db.putScheduleRun(claim)` in `runItem`) → "two queues over one
//    file: the second never re-runs an occurrence the first has claimed" reds — without the
//    claim the second queue finds no row while the first is still executing and runs it too;
//  - swap the drop-on-existing-row check (`existing.status !== 'pending'` → `=== 'pending'`)
//    → "a row carried in by a sync pull suppresses the local run" and "a pending row is
//    replaced by the claim and runs" both red.
import { createRequire } from 'node:module';

import { admitConnectionRequirement, type AdmissionChannel } from '@snugprotocol/auth';
import { createMemoryBackend, openUserDb, type ConnectionAdmissionGate, type UserDb } from '@snugprotocol/db';
import {
  SCHEDULE_DAILY_CEILINGS,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_PROPOSAL_TTL_MS,
  SCHEDULE_RUN_MAX_BYTES,
  type ScheduleRun,
  type ScheduleStep,
  type ScheduledTask,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scheduleRevisionStore } from '../platform/signals.js';
import type { StepContext, StepExecutor, StepOutcome } from '../schedule/engine-types.js';
import {
  DEFAULT_RUN_BOUNDS,
  createRunQueue,
  fitRunRow,
  foldRunStatus,
  laterInstant,
  runBoundMs,
  type RunQueue,
  type RunQueueDeps,
} from '../schedule/queue.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');
/** Byte-for-byte the gate `state/userdb.ts` installs on the production path. */
const admissionGate: ConnectionAdmissionGate = (requirement, context) =>
  admitConnectionRequirement(requirement, { channel: context.channel as AdmissionChannel });

const CREATED = '2026-10-01T00:00:00.000Z';
const DUE = '2026-10-09T12:00:00.000Z';
const NOW_MS = Date.parse('2026-10-09T12:00:30.000Z');

let db: UserDb;
let clock: number;
const now = (): Date => new Date(clock);

beforeEach(async () => {
  clock = NOW_MS;
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1, admissionGate });
  if (result.status !== 'ok') throw new Error(`test user db open failed: ${result.status}`);
  db = result.userDb;
  db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
});

afterEach(() => {
  vi.useRealTimers();
});

const NOTIFY: ScheduleStep = { kind: 'notify', title: 'Water', body: 'the ferns' };
const THINK: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } };

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'Hourly ledger',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [NOTIFY],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 3_600_000,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
  ...over,
});

/** Put the task in the file and answer it — the queue reads it fresh from there. */
const seed = (over: Partial<ScheduledTask> = {}): ScheduledTask => {
  const t = task(over);
  db.putScheduledTask(t);
  return t;
};

const ok = (summary?: string, calls = { ai: 0, net: 0 }, extra: Partial<StepOutcome> = {}): StepOutcome => ({
  status: 'ok',
  ...(summary !== undefined ? { summary } : {}),
  calls,
  ...extra,
});

interface Recorder {
  calls: Array<{ step: ScheduleStep; ctx: StepContext }>;
  execute: StepExecutor;
}

function recorder(answer: (step: ScheduleStep, ctx: StepContext) => StepOutcome | Promise<StepOutcome> = () => ok()): Recorder {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    execute: async (step, ctx) => {
      calls.push({ step, ctx });
      return answer(step, ctx);
    },
  };
}

function queue(execute: StepExecutor, over: Partial<RunQueueDeps> = {}): RunQueue {
  return createRunQueue({ db: () => Promise.resolve(db), execute, now, hostInfo: () => ({ kind: 'web' }), ...over });
}

const rows = (taskId = 't1'): ScheduleRun[] => db.listScheduleRuns(taskId);
const item = (t: ScheduledTask, dueAt = DUE) => ({ task: t, dueAt, trigger: 'due' as const, collapsedCount: 1 });

/** A promise with its resolver in hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An executor that never answers on its own — only the queue's signal ends it. */
const hanging = (started: { resolve: (v: undefined) => void }): StepExecutor => (_step, ctx) =>
  new Promise<StepOutcome>((_resolve, reject) => {
    started.resolve(undefined);
    ctx.signal.addEventListener('abort', () => reject(new Error('aborted by the queue')));
  });

describe('one at a time, claimed before anything runs (E5)', () => {
  it('runs FIFO, one item at a time; each is `running` with `startedAt` before its first step executes', async () => {
    const t1 = seed({ id: 't1' });
    const t2 = seed({ id: 't2' });
    const gate = deferred<undefined>();
    const seen: Array<{ id: string; status: string | undefined; startedAt: string | undefined }> = [];
    const rec = recorder(async (_step, ctx) => {
      const row = db.listScheduleRuns(ctx.task.id)[0];
      seen.push({ id: ctx.task.id, status: row?.status, startedAt: row?.startedAt });
      if (ctx.task.id === 't1') await gate.promise;
      return ok();
    });
    const q = queue(rec.execute);
    q.enqueue(item(t1));
    q.enqueue(item(t2));
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(q.state.get()).toEqual({ running: { taskId: 't1', dueAt: DUE, startedAt: now().toISOString(), stepIndex: 0 }, queued: 1 });
    expect(rows('t2')).toEqual([]); // not claimed until its turn
    gate.resolve(undefined);
    await q.idle();
    expect(seen).toEqual([
      { id: 't1', status: 'running', startedAt: now().toISOString() },
      { id: 't2', status: 'running', startedAt: now().toISOString() },
    ]);
    expect(rows('t1')[0]?.status).toBe('ok');
    expect(rows('t2')[0]?.status).toBe('ok');
    expect(q.state.get()).toEqual({ queued: 0 });
  });

  it('two queues over one file: the second never re-runs an occurrence the first has claimed (mutation: drop the claim write → red)', async () => {
    const t = seed();
    const gate = deferred<undefined>();
    const first = recorder(async () => {
      await gate.promise;
      return ok();
    });
    const second = recorder();
    const a = queue(first.execute);
    const b = queue(second.execute);
    a.enqueue(item(t));
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    b.enqueue(item(t)); // another tab, the same occurrence, while the first is mid-run
    await b.idle();
    expect(second.calls).toHaveLength(0);
    gate.resolve(undefined);
    await a.idle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.status).toBe('ok');
  });

  it('a second enqueue of the same (taskId, dueAt) on one queue never runs twice', async () => {
    const t = seed();
    const rec = recorder();
    const q = queue(rec.execute);
    q.enqueue(item(t));
    q.enqueue(item(t));
    await q.idle();
    expect(rec.calls).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('a row carried in by a sync pull suppresses the local run (any status but pending)', async () => {
    const t = seed();
    db.putScheduleRun({ id: 'r-sync', taskId: 't1', dueAt: DUE, trigger: 'due', collapsedCount: 1, status: 'ok', host: { kind: 'desktop' }, steps: [], calls: { ai: 0, net: 0 } });
    const rec = recorder();
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rec.calls).toHaveLength(0);
    expect(rows()).toEqual([expect.objectContaining({ id: 'r-sync', status: 'ok', host: { kind: 'desktop' } })]);
  });

  it('a `pending` row is replaced by the claim — same id, same dueAt string — and runs', async () => {
    const t = seed();
    const pendingDueAt = '2026-10-09T12:00:00Z'; // the schema admits both spellings; the upsert compares strings
    db.putScheduleRun({ id: 'r-pending', taskId: 't1', dueAt: pendingDueAt, trigger: 'catch-up', collapsedCount: 7, status: 'pending', host: { kind: 'web' }, steps: [], calls: { ai: 0, net: 0 } });
    const rec = recorder();
    const q = queue(rec.execute);
    q.enqueue({ task: t, dueAt: DUE, trigger: 'catch-up', collapsedCount: 7 });
    await q.idle();
    expect(rec.calls).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id: 'r-pending', dueAt: pendingDueAt, status: 'ok', trigger: 'catch-up', collapsedCount: 7 });
  });

  it('a schedule deleted while it waited is dropped: no call, no row, no throw', async () => {
    const t = seed();
    const gate = deferred<undefined>();
    const rec = recorder(async () => {
      await gate.promise;
      return ok();
    });
    const q = queue(rec.execute);
    const t2 = seed({ id: 't2' });
    q.enqueue(item(t));
    q.enqueue(item(t2));
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
    db.deleteScheduledTask('t2');
    gate.resolve(undefined);
    await q.idle();
    expect(rec.calls.map((c) => c.ctx.task.id)).toEqual(['t1']);
    expect(db.getScheduledTask('t2')).toBeUndefined();
  });

  it('the step context carries the claim id, this run, the db, the signal and the clock — and no notify seat (the queue decides)', async () => {
    const t = seed();
    const rec = recorder();
    const q = queue(rec.execute, { notify: () => async () => 'shown' as const });
    q.enqueue({ task: t, dueAt: DUE, trigger: 'late', collapsedCount: 3 });
    await q.idle();
    const { ctx } = rec.calls[0]!;
    expect(ctx.run).toEqual({ id: rows()[0]?.id, taskId: 't1', dueAt: DUE, trigger: 'late' });
    expect(ctx.db).toBe(db);
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.now()).toEqual(now());
    expect(ctx.notify).toBeUndefined();
    expect(rows()[0]).toMatchObject({ trigger: 'late', collapsedCount: 3, host: { kind: 'web' } });
  });
});

describe('a disabled schedule and the claim that cannot land (S1, S5)', () => {
  it('a disabled schedule is never claimed by a due or catch-up item — only the user’s own manual run goes', async () => {
    const t = seed({ enabled: false });
    const rec = recorder();
    const q = queue(rec.execute);
    q.enqueue({ task: t, dueAt: DUE, trigger: 'catch-up', collapsedCount: 3 });
    q.enqueue({ task: { ...t, enabled: true }, dueAt: '2026-10-09T13:00:00.000Z', trigger: 'due', collapsedCount: 1 }); // the ITEM says enabled; the file says off
    await q.idle();
    expect(rec.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
    q.enqueue({ task: t, dueAt: DUE, trigger: 'manual', collapsedCount: 1 });
    await q.idle();
    expect(rec.calls).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'ok', trigger: 'manual' });
  });

  it('after 50 needs-you results the next due run is still recorded (a seen one was pruned); with none seen the refused claim surfaces as lastError and counts as a failure', async () => {
    const needsYou = (taskId: string, i: number, seenAt?: string): ScheduleRun => ({
      id: `ny-${taskId}-${i}`,
      taskId,
      dueAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      trigger: 'due',
      collapsedCount: 1,
      status: 'needs-you',
      host: { kind: 'web' },
      steps: [],
      calls: { ai: 0, net: 0 },
      ...(seenAt !== undefined ? { seenAt } : {}),
    });
    const t1 = seed({ id: 't1' });
    for (let i = 0; i < 50; i += 1) db.putScheduleRun(needsYou('t1', i, i === 7 ? CREATED : undefined));
    const rec = recorder();
    const onChange = vi.fn();
    const q = queue(rec.execute, { onChange });
    q.enqueue(item(t1));
    await q.idle();
    expect(rec.calls).toHaveLength(1);
    expect(rows('t1')[0]).toMatchObject({ status: 'ok', dueAt: DUE });
    expect(rows('t1').map((r) => r.id)).not.toContain('ny-t1-7');
    expect(q.state.get().lastError).toBeUndefined();

    const t2 = seed({ id: 't2' });
    for (let i = 0; i < 50; i += 1) db.putScheduleRun(needsYou('t2', i));
    onChange.mockClear();
    for (let n = 1; n <= 5; n += 1) {
      q.enqueue({ task: t2, dueAt: new Date(Date.parse(DUE) + n * 3_600_000).toISOString(), trigger: 'due', collapsedCount: 1 });
      await q.idle();
      expect(rec.calls, `claim ${n}`).toHaveLength(1); // nothing runs unrecorded
      expect(q.state.get().lastError, `claim ${n}`).toMatch(/waiting on the user/);
      expect(db.getScheduledTask('t2')?.consecutiveFailures, `claim ${n}`).toBe(n);
    }
    expect(onChange).toHaveBeenCalled(); // the view learns of the refusal
    expect(db.getScheduledTask('t2')).toMatchObject({ enabled: false, pausedReason: 'failures' }); // the fifth refusal pauses it, like a fifth failure
    expect(rows('t2')).toHaveLength(50);
  });

  it('when the final row write fails, a minimal row — the status, finishedAt, bare step statuses, reason "result too large" — still replaces the claim (M17)', async () => {
    const t = seed({ steps: [NOTIFY, NOTIFY] });
    const original = db.putScheduleRun.bind(db);
    let writes = 0;
    vi.spyOn(db, 'putScheduleRun').mockImplementation((row) => {
      writes += 1;
      if (writes === 2) throw new Error('refused: too big');
      original(row);
    });
    const q = queue(recorder(() => ok('a long summary')).execute);
    q.enqueue(item(t));
    await q.idle();
    expect(writes).toBe(3);
    expect(rows()[0]).toMatchObject({ status: 'ok', finishedAt: now().toISOString(), reason: 'result too large', steps: [{ status: 'ok' }, { status: 'ok' }] });
    expect(rows()[0]?.steps[0]?.summary).toBeUndefined();
    expect(db.getScheduledTask('t1')?.ranThrough).toBe(DUE);
  });
});

describe('the step rules', () => {
  it('a step whose app is gone is `blocked` (appMissing) without a call; the other steps still run; the run is needs-you', async () => {
    const t = seed({ steps: [{ kind: 'app-think', appId: 'gone', prompt: 'x', context: { maxRows: 50 } }, NOTIFY] });
    const rec = recorder(() => ok('reminded'));
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rec.calls.map((c) => c.step.kind)).toEqual(['notify']);
    expect(rows()[0]).toMatchObject({
      status: 'needs-you',
      reason: 'app missing',
      steps: [{ status: 'blocked', appMissing: true }, { status: 'ok', summary: 'reminded' }],
    });
  });

  it('the daily ceiling refuses an *Ask the AI* step — counting what this run already spent — and the run is `capped`', async () => {
    const t = seed({ steps: [THINK, THINK, NOTIFY] });
    db.setSchedulerState({ watermark: CREATED, globalPause: false, daily: { date: '2026-10-09', ai: SCHEDULE_DAILY_CEILINGS.ai - 1, net: 0 } });
    const rec = recorder((step) => (step.kind === 'app-think' ? ok('thought', { ai: 1, net: 0 }) : ok('reminded')));
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rec.calls.map((c) => c.step.kind)).toEqual(['app-think', 'notify']); // the second think never reached the executor
    expect(rows()[0]).toMatchObject({
      status: 'capped',
      reason: 'capped',
      steps: [{ status: 'ok', summary: 'thought' }, { status: 'refused' }, { status: 'ok', summary: 'reminded' }],
      calls: { ai: 1, net: 0 },
    });
    expect(db.getSchedulerState()?.daily).toEqual({ date: '2026-10-09', ai: SCHEDULE_DAILY_CEILINGS.ai, net: 0 });
  });

  it('a new UTC day starts the counters over before the ceiling is asked', async () => {
    const t = seed({ steps: [THINK] });
    db.setSchedulerState({ watermark: CREATED, globalPause: false, daily: { date: '2026-10-08', ai: SCHEDULE_DAILY_CEILINGS.ai, net: 0 } });
    const rec = recorder(() => ok('thought', { ai: 1, net: 0 }));
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]?.status).toBe('ok');
    expect(db.getSchedulerState()?.daily).toEqual({ date: '2026-10-09', ai: 1, net: 0 });
  });

  it('an executor that throws is a `failed` step with its message; the run is failed', async () => {
    const t = seed({ steps: [NOTIFY, NOTIFY] });
    let n = 0;
    const rec = recorder(() => {
      n += 1;
      if (n === 1) throw new Error('no channel');
      return ok('second');
    });
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'failed', reason: 'no channel', steps: [{ status: 'failed', summary: 'no channel' }, { status: 'ok', summary: 'second' }] });
    expect(db.getScheduledTask('t1')?.consecutiveFailures).toBe(1);
  });

  it('foldRunStatus: interrupted › capped › failed › needs-you (refused/blocked) › no-handler › ok', () => {
    expect(foldRunStatus([{ status: 'ok' }, { status: 'skipped' }], undefined, false)).toEqual({ status: 'ok' });
    expect(foldRunStatus([{ status: 'ok' }, { status: 'no-handler' }], undefined, false)).toEqual({ status: 'no-handler' });
    expect(foldRunStatus([{ status: 'refused', summary: 'demo brain' }, { status: 'no-handler' }], undefined, false)).toEqual({ status: 'needs-you', reason: 'demo brain' });
    expect(foldRunStatus([{ status: 'blocked', appMissing: true }], undefined, false)).toEqual({ status: 'needs-you', reason: 'app missing' });
    expect(foldRunStatus([{ status: 'refused' }, { status: 'failed', summary: 'boom' }], undefined, false)).toEqual({ status: 'failed', reason: 'boom' });
    expect(foldRunStatus([{ status: 'failed' }], undefined, true)).toEqual({ status: 'capped', reason: 'capped' });
    expect(foldRunStatus([{ status: 'ok' }], 'cancelled', true)).toEqual({ status: 'interrupted', reason: 'cancelled' });
  });

  it('runBoundMs: 300 s when any step asks the AI, else 120 s', () => {
    expect(runBoundMs([NOTIFY])).toBe(DEFAULT_RUN_BOUNDS.runMs);
    expect(runBoundMs([NOTIFY, THINK])).toBe(DEFAULT_RUN_BOUNDS.thinkMs);
    expect(runBoundMs([THINK], { runMs: 1, thinkMs: 2 })).toBe(2);
  });
});

describe('after the steps: the row, the counters, the task, the notification', () => {
  it('sums calls, carries proposals with ONE expiresAt = finishedAt + 7 days, and charges the day', async () => {
    const t = seed({ steps: [THINK, THINK] });
    db.setSchedulerState({ watermark: CREATED, globalPause: false, daily: { date: '2026-10-09', ai: 3, net: 1 } });
    let n = 0;
    const rec = recorder(() => {
      n += 1;
      return ok(`thought ${n}`, { ai: 1, net: 0 }, {
        proposals: [{ appId: 'ledger', sql: `UPDATE ledger SET paid = 1 WHERE id = ${n}`, summary: `mark ${n}`, counts: { changes: 1 } }],
      });
    });
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    const row = rows()[0]!;
    expect(row.status).toBe('ok');
    expect(row.calls).toEqual({ ai: 2, net: 0 });
    expect(row.finishedAt).toBe(now().toISOString());
    expect(row.proposals).toEqual({
      items: [
        { appId: 'ledger', sql: 'UPDATE ledger SET paid = 1 WHERE id = 1', summary: 'mark 1', counts: { changes: 1 } },
        { appId: 'ledger', sql: 'UPDATE ledger SET paid = 1 WHERE id = 2', summary: 'mark 2', counts: { changes: 1 } },
      ],
      expiresAt: new Date(NOW_MS + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
    });
    expect(db.getSchedulerState()?.daily).toEqual({ date: '2026-10-09', ai: 5, net: 1 });
  });

  it('a two-step run over two apps pools the items with each one’s own appId — the card applies each against its own app (S4)', async () => {
    db.installApp({ appId: 'notes', displayName: 'Notes', html: '<html>notes</html>' });
    const t = seed({ steps: [THINK, { kind: 'app-think', appId: 'notes', prompt: 'tidy', context: { maxRows: 50 } }] });
    const rec = recorder((step) =>
      ok('thought', { ai: 1, net: 0 }, {
        proposals: [{ appId: step.kind === 'notify' ? 'none' : step.appId, sql: `DELETE FROM t WHERE app = '${step.kind === 'notify' ? '' : step.appId}'`, counts: { changes: 1 } }],
      }),
    );
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]?.proposals?.items.map((p) => p.appId)).toEqual(['ledger', 'notes']);
  });

  it('applies the outcome to the task: unseenResults +1 on ok, ranThrough = dueAt — read fresh, not from the item — and NEVER stamps updatedAt (M16)', async () => {
    const t = seed({ unseenResults: 2 });
    const gate = deferred<undefined>();
    const rec = recorder(async () => {
      await gate.promise;
      return ok();
    });
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
    db.putScheduledTask({ ...t, title: 'Renamed mid-run' }); // the user edited it while it ran
    clock += 5_000;
    gate.resolve(undefined);
    await q.idle();
    expect(db.getScheduledTask('t1')).toMatchObject({ title: 'Renamed mid-run', unseenResults: 3, ranThrough: DUE, updatedAt: CREATED });
  });

  it('ranThrough never moves backwards: a manual run for an older instant keeps the newer record', async () => {
    const t = seed({ ranThrough: '2026-10-09T13:00:00.000Z' });
    const q = queue(recorder().execute);
    q.enqueue({ task: t, dueAt: DUE, trigger: 'manual', collapsedCount: 1 });
    await q.idle();
    expect(db.getScheduledTask('t1')?.ranThrough).toBe('2026-10-09T13:00:00.000Z');
    expect(laterInstant(undefined, DUE)).toBe(DUE);
    expect(laterInstant('garbage', DUE)).toBe(DUE);
  });

  it('notifies ONCE per run, host-decided: only when the task says `notification`, with the body prefixed by the title and cut to 120', async () => {
    const t = seed({ alert: 'notification', steps: [NOTIFY, NOTIFY] });
    const notify = vi.fn<(n: { title: string; body: string }) => Promise<'shown' | 'denied' | 'unavailable'>>(async () => 'shown');
    const long = 'x'.repeat(200);
    const rec = recorder(() => ok('reminded', { ai: 0, net: 0 }, { alert: { title: 'Water', body: long } }));
    const q = queue(rec.execute, { notify: () => notify });
    q.enqueue(item(t));
    await q.idle();
    expect(notify).toHaveBeenCalledTimes(1);
    const body = notify.mock.calls[0]![0].body;
    expect(body.startsWith('Hourly ledger · xxx')).toBe(true);
    expect(body).toHaveLength(SCHEDULE_NOTIFY_BODY_MAX_CHARS);
    expect(notify.mock.calls[0]![0].title).toBe('Water');
  });

  it('never notifies for an `inbox` task, nor without a seat, nor when the executor suggested nothing', async () => {
    const notify = vi.fn<(n: { title: string; body: string }) => Promise<'shown' | 'denied' | 'unavailable'>>(async () => 'shown');
    const withAlert = recorder(() => ok('r', { ai: 0, net: 0 }, { alert: { title: 'a', body: 'b' } }));
    seed({ id: 't1', alert: 'inbox' });
    const q1 = queue(withAlert.execute, { notify: () => notify });
    q1.enqueue(item(task({ id: 't1' })));
    await q1.idle();
    seed({ id: 't2', alert: 'notification' });
    const q2 = queue(withAlert.execute); // no seat
    q2.enqueue(item(task({ id: 't2' })));
    await q2.idle();
    seed({ id: 't3', alert: 'notification' });
    const q3 = queue(recorder().execute, { notify: () => notify }); // no suggestion
    q3.enqueue(item(task({ id: 't3' })));
    await q3.idle();
    expect(notify).not.toHaveBeenCalled();
    expect(rows('t1')[0]?.status).toBe('ok');
    expect(rows('t2')[0]?.status).toBe('ok');
    expect(rows('t3')[0]?.status).toBe('ok');
  });

  it('bumps scheduleRevision and onChange after every write — the claim and the result', async () => {
    const t = seed();
    const before = scheduleRevisionStore.get();
    const onChange = vi.fn();
    const rec = recorder((_step, ctx) => {
      expect(scheduleRevisionStore.get()).toBe(before + 1); // the claim was announced before the step ran
      expect(ctx.signal.aborted).toBe(false);
      return ok();
    });
    const q = queue(rec.execute, { onChange });
    q.enqueue(item(t));
    await q.idle();
    expect(scheduleRevisionStore.get()).toBe(before + 2);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('fitRunRow shrinks a row that overflows the run cap — summaries shorter, then gone — and leaves a fitting row untouched', () => {
    const base: ScheduleRun = { id: 'r', taskId: 't1', dueAt: DUE, trigger: 'due', collapsedCount: 1, status: 'ok', host: { kind: 'web' }, steps: [{ status: 'ok', summary: 'fine' }], calls: { ai: 0, net: 0 } };
    expect(fitRunRow(base)).toBe(base);
    const fat: ScheduleRun = { ...base, steps: Array.from({ length: 5 }, () => ({ status: 'ok' as const, summary: 'y'.repeat(4096) })) };
    expect(new TextEncoder().encode(JSON.stringify(fat)).length).toBeGreaterThan(SCHEDULE_RUN_MAX_BYTES);
    const fitted = fitRunRow(fat);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(SCHEDULE_RUN_MAX_BYTES);
    expect(fitted.steps.every((step) => step.status === 'ok' && (step.summary?.length ?? 0) <= 512)).toBe(true);
  });
});

describe('the bound and the aborts', () => {
  it('a run past its bound is `interrupted` (reason timeout); the steps after it are skipped', async () => {
    vi.useFakeTimers();
    const t = seed({ steps: [NOTIFY, NOTIFY] });
    const started = deferred<undefined>();
    const q = queue(hanging(started));
    q.enqueue(item(t));
    await started.promise;
    expect(rows()[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_BOUNDS.runMs);
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'interrupted', reason: 'timeout', steps: [{ status: 'skipped' }, { status: 'skipped' }] });
  });

  it('the bound is 300 s when a step asks the AI — 120 s is not enough to interrupt it', async () => {
    vi.useFakeTimers();
    const t = seed({ steps: [THINK] });
    const started = deferred<undefined>();
    const q = queue(hanging(started));
    q.enqueue(item(t));
    await started.promise;
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_BOUNDS.runMs);
    expect(rows()[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_BOUNDS.thinkMs - DEFAULT_RUN_BOUNDS.runMs);
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'interrupted', reason: 'timeout' });
  });

  it('cancelCurrent aborts the running item: `interrupted`, reason cancelled; the task is otherwise untouched', async () => {
    const t = seed();
    const started = deferred<undefined>();
    const q = queue(hanging(started));
    q.enqueue(item(t));
    await started.promise;
    q.cancelCurrent();
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'interrupted', reason: 'cancelled', finishedAt: now().toISOString() });
    expect(db.getScheduledTask('t1')).toMatchObject({ consecutiveFailures: 0, unseenResults: 1, ranThrough: DUE }); // an interrupted run is a result to open (M8)
    expect(q.state.get()).toEqual({ queued: 0 });
  });

  it('abortAll(reason) drops waiting items UNCLAIMED and records the running one with the reason', async () => {
    const t1 = seed({ id: 't1' });
    const t2 = seed({ id: 't2' });
    const started = deferred<undefined>();
    const rec = recorder(hanging(started));
    const q = queue(rec.execute);
    q.enqueue(item(t1));
    q.enqueue(item(t2));
    await started.promise;
    expect(q.state.get().queued).toBe(1);
    q.abortAll('file swap');
    await q.idle();
    expect(rows('t1')[0]).toMatchObject({ status: 'interrupted', reason: 'file swap' });
    expect(rows('t2')).toEqual([]); // never claimed: the next reconcile finds it again
    expect(rec.calls).toHaveLength(1);
    expect(q.state.get()).toEqual({ queued: 0 });
  });

  it('an executor that ignores the signal — never settling after the abort — is still cut short: the bound bounds (M7)', async () => {
    const t = seed();
    const started = deferred<undefined>();
    const stuck: StepExecutor = () =>
      new Promise<StepOutcome>(() => {
        started.resolve(undefined);
      });
    const q = queue(stuck);
    q.enqueue(item(t));
    await started.promise;
    q.cancelCurrent();
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'interrupted', reason: 'cancelled', steps: [{ status: 'skipped' }] });
    expect(q.state.get()).toEqual({ queued: 0 });
  });

  it('cancelCurrent with nothing running is a no-op', () => {
    const q = queue(recorder().execute);
    expect(() => q.cancelCurrent()).not.toThrow();
    expect(() => q.abortAll('x')).not.toThrow();
  });
});

describe('*Run [app]* rows (PR-B A2/A4/A5): what the hidden frame spends and says rides the row', () => {
  const APP_RUN: ScheduleStep = { kind: 'app-run', appId: 'ledger' };
  const state = () => ({ watermark: CREATED, globalPause: false, daily: { date: DUE.slice(0, 10), ai: 0, net: 0 } });

  it('an app-run step’s net count (and its AI count) lands on the run row and on the day’s counters', async () => {
    db.setSchedulerState(state());
    const t = seed({ steps: [APP_RUN] });
    const q = queue(recorder(() => ok('refreshed', { ai: 1, net: 3 })).execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'ok', calls: { ai: 1, net: 3 }, steps: [{ status: 'ok', summary: 'refreshed' }] });
    expect(db.getSchedulerState()?.daily).toEqual({ date: DUE.slice(0, 10), ai: 1, net: 3 });
  });

  it('a `refused` app-run step (the refusing gate said no) folds the run to `needs-you` with the step’s own sentence as the reason', async () => {
    const t = seed({ steps: [APP_RUN, NOTIFY] });
    const q = queue(recorder((step) => (step.kind === 'app-run' ? { status: 'refused', summary: 'Ledger needs your OK — Snug doesn’t post to api.github.com while you’re away', calls: { ai: 0, net: 1 } } : ok('reminded'))).execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]).toMatchObject({
      status: 'needs-you',
      reason: 'Ledger needs your OK — Snug doesn’t post to api.github.com while you’re away',
      calls: { ai: 0, net: 1 },
      steps: [{ status: 'refused' }, { status: 'ok', summary: 'reminded' }], // the reminder after it still ran
    });
    expect(db.getScheduledTask('t1')?.consecutiveFailures).toBe(0); // the gate's refusal is not the app's failure
  });

  it('a `no-handler` app-run step (the app never announced) folds the run to `no-handler` and counts toward the failure pause', async () => {
    const t = seed({ steps: [APP_RUN] });
    const q = queue(recorder(() => ({ status: 'no-handler', summary: 'Ledger doesn’t know how to run on a schedule yet', calls: { ai: 0, net: 0 } })).execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]?.status).toBe('no-handler');
    expect(db.getScheduledTask('t1')?.consecutiveFailures).toBe(1);
  });

  it('the context’s `interrupt(reason)` seam records the run `interrupted` with THAT reason — "app opened" (mutation: drop `interrupt` from the context → red)', async () => {
    const t = seed({ steps: [APP_RUN, NOTIFY] });
    const rec = recorder(
      (_step, ctx) =>
        new Promise<StepOutcome>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          ctx.interrupt?.('app opened');
          if (ctx.interrupt === undefined) resolve(ok());
        }),
    );
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(rows()[0]).toMatchObject({ status: 'interrupted', reason: 'app opened', steps: [{ status: 'skipped' }, { status: 'skipped' }] });
  });

  it('`spent()` tells a step what the run already charged, so a step can ask the ceiling honestly', async () => {
    const t = seed({ steps: [APP_RUN, APP_RUN] });
    const seen: Array<{ ai: number; net: number } | undefined> = [];
    const rec = recorder((_step, ctx) => {
      seen.push(ctx.spent?.());
      return ok('x', { ai: 1, net: 2 });
    });
    const q = queue(rec.execute);
    q.enqueue(item(t));
    await q.idle();
    expect(seen).toEqual([
      { ai: 0, net: 0 },
      { ai: 1, net: 2 },
    ]);
  });
});
