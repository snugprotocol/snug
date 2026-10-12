// applyArmed.test.ts — TASK-20261010-host-broker PR-4 (contract v2 D-PR4-11; AC31): the WALK an armed
// schedule's run takes at the queue's pooling point, after every step and BEFORE the run row is
// written — `schedule/applyArmed.ts applyArmed(db, run, task, items, { now })`.
//
// The order, every step observable:
//  1. `inTransaction(app)` FIRST — the app mid-change holds every item `busy` (no export, no seat);
//  2. the items re-dry-run IN ORDER on ONE scratch copy (`db.scratchRun(appId, items)`, the chat
//     card's rule) — those FRESH sequential counts are the truth: the seat's `expectChanges` and the
//     budget (never the step-time counts, each dry-run alone);
//  3. the longest PREFIX whose sum ≤ `rowsPerRun` — the rest held `over-limit`;
//  4. `applyOwnWrite(…, { requireUndo: true, stillArmed })`, `stillArmed()` evaluated after the last
//     await: the task present ∧ enabled ∧ unpaused ∧ the same `armedAt` ∧ the app's current version =
//     `armedVersion` ∧ no global pause — false holds `stopped`; a version mismatch also DISARMS with
//     the `app-updated` trace (the walk's belt — covers a version that arrived by trusted pull);
//  5. ONE seat call for the prefix → the `ownUndo` entry (`authority: task`, `via: schedule`, `runId`,
//     `taskId`) and the claim row rewritten with the `applied` seat IN THE SAME SYNCHRONOUS TICK.
// The held reasons are ONE table (`SCHEDULE_HELD_REASONS`). What reaches this function is the run's
// ARMABLE items (the queue passes only `ok` steps' items and never calls it on an aborted run — those
// two rules are pinned through the queue in scheduleQueue.test.ts).
//
// The module is NEW: it is imported statically here (this file is the only one that imports it).
// Real memory user db, the real Write Broker and the real driver seat; the clock is injected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION, SCHEDULE_HELD_REASONS, type ScheduleProposalItem, type ScheduleRun, type ScheduledTask } from '@snugprotocol/protocol';

import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import { resetScopedReadForTests } from '../access/scopedRead.js';
import { applyArmed } from '../schedule/applyArmed.js';
import { installTestUserDb } from './userdbTestHelper.js';

const NOW = Date.parse('2026-10-11T09:00:00.000Z');
const CREATED = '2026-10-01T00:00:00.000Z';
const ARMED_AT = '2026-10-05T09:00:00.000Z';
const DUE = '2026-10-11T08:00:00.000Z';
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let db: UserDb;
let clock: number;
let seq = 0;
const now = (): Date => new Date(clock);

type ArmedTask = ScheduledTask & { writeAuthority?: { rowsPerRun: number; armedAt: string; armedVersion: number }; disarmed?: { reason: string; at: string } };
type HeldItem = ScheduleProposalItem & { held?: string };
interface WalkResult {
  applied?: { appId: string; undoId?: string; undoable?: false; items: Array<{ summary?: string; changes: number }> };
  items: HeldItem[];
}

async function exec(sql: string): Promise<void> {
  const answer = await db.driver.handle('ledger', { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `x-${++seq}`, instanceId: 'frame', op: 'exec', sql });
  if (!answer.ok) throw new Error(`exec failed: ${JSON.stringify(answer)}`);
}

async function rowsOf(sql: string): Promise<unknown[][] | undefined> {
  const answer = await db.driver.handle('ledger', { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `r-${++seq}`, instanceId: 'check', op: 'exec', sql });
  return answer.ok ? answer.rows : undefined;
}

const NOTES = 'SELECT id, body, done FROM notes ORDER BY id';
const UNTOUCHED = [
  [1, 'a', 0],
  [2, 'b', 0],
  [3, 'c', 0],
];

function armedTask(over: Partial<ArmedTask> = {}): ArmedTask {
  return {
    id: 't1',
    title: 'Tidy the notes',
    enabled: true,
    enabledAt: CREATED,
    provenance: 'user',
    steps: [{ kind: 'app-think', appId: 'ledger', prompt: 'tidy the notes', context: { maxRows: 50 } }],
    spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
    cron: '0 * * * *',
    missedPolicy: 'ask',
    staleAfterMs: DAY,
    alert: 'inbox',
    appVersions: { ledger: 1 },
    createdAt: CREATED,
    updatedAt: CREATED,
    consecutiveFailures: 0,
    unseenResults: 0,
    writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 1 },
    ...over,
  } as ArmedTask;
}

/** The claim the queue wrote before any step ran — the row the walk rewrites with `applied`. */
function claim(task: ArmedTask): ScheduleRun {
  const run: ScheduleRun = {
    id: 'run-1',
    taskId: task.id,
    dueAt: DUE,
    trigger: 'due',
    collapsedCount: 1,
    status: 'running',
    startedAt: iso(NOW - 60_000),
    host: { kind: 'web' },
    steps: [],
    calls: { ai: 0, net: 0 },
  };
  db.putScheduleRun(run);
  return run;
}

const item = (sql: string, changes = 1, summary?: string): ScheduleProposalItem => ({ appId: 'ledger', sql, ...(summary !== undefined ? { summary } : {}), counts: { changes } });

async function walk(task: ArmedTask, items: ScheduleProposalItem[], seedTask = true): Promise<WalkResult> {
  if (seedTask) db.putScheduledTask(task);
  const run = claim(task);
  return (await applyArmed(db, run, task, items, { now })) as unknown as WalkResult;
}

type OwnJournal = Pick<UserDb, 'listOwnUndo' | 'putOwnUndo'>;
const own = (): OwnJournal => db;
const claimRow = (): ScheduleRun & { applied?: WalkResult['applied'] } => db.listScheduleRuns('t1')[0] as ScheduleRun & { applied?: WalkResult['applied'] };

beforeEach(async () => {
  // The own journal's liveness is read against the db's WALL clock; the walk stamps with the injected
  // one. Only `Date` is faked, at NOW, so the two agree (no clock bomb seven days on).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetAccessSession();
  resetScopedReadForTests();
  clock = NOW;
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock });
  db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
  await db.applyAppDdl('ledger', ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, done INTEGER NOT NULL DEFAULT 0)']);
  await exec("INSERT INTO notes (id, body, done) VALUES (1, 'a', 0), (2, 'b', 0), (3, 'c', 0)");
});

afterEach(() => {
  vi.useRealTimers();
  __setAccessDepsForTests();
  resetAccessSession();
  resetScopedReadForTests();
  vi.restoreAllMocks();
});

// ======================================================================================

describe('the walk applies the prefix through ONE capture seat call, journaled to the task’s bucket', () => {
  it('two items apply in ONE seat call (requireUndo, the fresh counts as expectChanges); the entry is the task’s; the result carries the applied group and nothing held', async () => {
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1', 1, 'marks a'), item("UPDATE notes SET body = 'B' WHERE id = 2", 1, 'renames b')]);
    expect(seat).toHaveBeenCalledTimes(1);
    expect(seat.mock.calls[0]![0]).toBe('ledger');
    expect(seat.mock.calls[0]![1]).toMatchObject({
      own: [{ sql: 'UPDATE notes SET done = 1 WHERE id = 1' }, { sql: "UPDATE notes SET body = 'B' WHERE id = 2" }],
      capture: true,
      expectChanges: [1, 1],
      requireUndo: true,
    });
    expect(await rowsOf(NOTES)).toEqual([
      [1, 'a', 1],
      [2, 'B', 0],
      [3, 'c', 0],
    ]);
    const [entry] = own().listOwnUndo('ledger', { taskId: 't1' });
    expect(entry).toMatchObject({ authority: 'task', via: 'schedule', runId: 'run-1', taskId: 't1' });
    expect(result.applied).toEqual({ appId: 'ledger', undoId: entry!.id, items: [{ summary: 'marks a', changes: 1 }, { summary: 'renames b', changes: 1 }] });
    expect(result.items).toEqual([]);
  });

  it('the applied group carries NO SQL — and the claim row is rewritten with it (status still running)', async () => {
    await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1', 1, 'marks a')]);
    const row = claimRow();
    expect(row.status).toBe('running');
    expect(row.applied).toMatchObject({ appId: 'ledger', items: [{ summary: 'marks a', changes: 1 }] });
    expect(JSON.stringify(row.applied)).not.toMatch(/UPDATE|WHERE/);
  });

  it('the ownUndo entry and the claim row’s applied seat are written in the SAME synchronous tick (no await between them)', async () => {
    const putOwnUndo = (db as unknown as OwnJournal).putOwnUndo.bind(db);
    const putRun = db.putScheduleRun.bind(db);
    let tickOpen = false;
    let rowInTick: boolean | undefined;
    vi.spyOn(db as unknown as OwnJournal, 'putOwnUndo').mockImplementation(((...args: Parameters<OwnJournal['putOwnUndo']>) => {
      const answer = putOwnUndo(...args);
      tickOpen = true;
      queueMicrotask(() => {
        tickOpen = false;
      });
      return answer;
    }) as OwnJournal['putOwnUndo']);
    vi.spyOn(db, 'putScheduleRun').mockImplementation((row) => {
      if ('applied' in row && rowInTick === undefined) rowInTick = tickOpen;
      putRun(row);
    });
    await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1')]);
    expect(rowInTick, 'the claim row carrying applied was written before the entry’s tick ended').toBe(true);
  });
});

describe('the fresh sequential counts are the truth — expectChanges AND the budget (F5)', () => {
  const MARK = 'UPDATE notes SET done = 1 WHERE id IN (1, 2)';
  const SWEEP = 'DELETE FROM notes WHERE done = 1';

  it('re-dry-runs the items IN ORDER on ONE scratch copy; the second item’s count is the count AFTER the first (2), never its step-time count (0)', async () => {
    const scratch = vi.spyOn(db, 'scratchRun');
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    await walk(armedTask(), [item(MARK, 2), item(SWEEP, 0)]);
    expect(scratch).toHaveBeenCalledTimes(1);
    expect(scratch.mock.calls[0]![0]).toBe('ledger');
    expect(scratch.mock.calls[0]![1].map((statement) => statement.sql)).toEqual([MARK, SWEEP]);
    expect(seat.mock.calls[0]![1]).toMatchObject({ expectChanges: [2, 2] });
    expect(await rowsOf(NOTES)).toEqual([[3, 'c', 0]]);
  });

  it('the budget is the fresh counts: rowsPerRun 3 keeps the longest prefix (2) — the sweep (fresh 2, stale 0) is held over-limit', async () => {
    const result = await walk(armedTask({ writeAuthority: { rowsPerRun: 3, armedAt: ARMED_AT, armedVersion: 1 } }), [item(MARK, 2), item(SWEEP, 0)]);
    expect(result.applied?.items).toEqual([{ changes: 2 }]);
    expect(result.items).toEqual([{ ...item(SWEEP, 0), held: 'over-limit' }]);
    expect(await rowsOf(NOTES)).toEqual([
      [1, 'a', 1],
      [2, 'b', 1],
      [3, 'c', 0],
    ]);
  });

  it('the longest PREFIX — an item past the budget stops it: later items are over-limit even if they would fit', async () => {
    const result = await walk(armedTask({ writeAuthority: { rowsPerRun: 2, armedAt: ARMED_AT, armedVersion: 1 } }), [
      item('UPDATE notes SET done = 1 WHERE id = 1'),
      item('UPDATE notes SET done = 1 WHERE id IN (2, 3)', 2),
      item("UPDATE notes SET body = 'z' WHERE id = 1"),
    ]);
    expect(result.applied?.items.map((applied) => applied.changes)).toEqual([1]);
    expect(result.items.map((held) => held.held)).toEqual(['over-limit', 'over-limit']);
  });

  it('a first item alone over rowsPerRun: nothing applies, the seat is never reached, every item over-limit', async () => {
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask({ writeAuthority: { rowsPerRun: 1, armedAt: ARMED_AT, armedVersion: 1 } }), [item(MARK, 2)]);
    expect(seat).not.toHaveBeenCalled();
    expect(result.applied).toBeUndefined();
    expect(result.items).toEqual([{ ...item(MARK, 2), held: 'over-limit' }]);
    expect(await rowsOf(NOTES)).toEqual(UNTOUCHED);
  });
});

describe('busy — inTransaction FIRST, before the re-dry-run (D-PR4-5)', () => {
  it('the app mid-change (its frame’s BEGIN): every item held busy — no scratchRun export (it would discard the app’s transaction), no seat', async () => {
    await exec('BEGIN');
    await exec("UPDATE notes SET body = 'mine' WHERE id = 3");
    const scratch = vi.spyOn(db, 'scratchRun');
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1'), item('UPDATE notes SET done = 1 WHERE id = 2')]);
    expect(scratch).not.toHaveBeenCalled();
    expect(seat).not.toHaveBeenCalled();
    expect(result.applied).toBeUndefined();
    expect(result.items.map((held) => held.held)).toEqual(['busy', 'busy']);
    expect(await db.driver.inTransaction('ledger')).toBe(true);
    await exec('ROLLBACK');
  });
});

describe('stillArmed — evaluated after the last await, immediately before the seat (S7)', () => {
  const MUTATIONS: Array<[string, () => void]> = [
    ['the task switched off', () => db.putScheduledTask({ ...(db.getScheduledTask('t1') as ArmedTask), enabled: false })],
    ['the task paused', () => db.putScheduledTask({ ...(db.getScheduledTask('t1') as ArmedTask), enabled: false, pausedReason: 'failures' })],
    ['the task deleted', () => db.deleteScheduledTask('t1')],
    ['the authority stopped', () => {
      const { writeAuthority: _gone, ...rest } = db.getScheduledTask('t1') as ArmedTask;
      db.putScheduledTask(rest as ScheduledTask);
    }],
    ['the task re-armed (a different armedAt)', () =>
      db.putScheduledTask({ ...(db.getScheduledTask('t1') as ArmedTask), writeAuthority: { rowsPerRun: 200, armedAt: iso(NOW), armedVersion: 1 } } as ScheduledTask)],
    ['the global pause', () => db.setSchedulerState({ watermark: iso(NOW), globalPause: true, daily: { date: '2026-10-11', ai: 0, net: 0 } })],
  ];

  it.each(MUTATIONS)('%s WHILE the re-dry-run was in flight → every item held stopped, the seat never reached, nothing changed', async (_label, mutate) => {
    const original = db.scratchRun.bind(db);
    vi.spyOn(db, 'scratchRun').mockImplementation(async (...args) => {
      const answer = await original(...args);
      mutate(); // lands during the walk's last await
      return answer;
    });
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1')]);
    expect(seat).not.toHaveBeenCalled();
    expect(result.applied).toBeUndefined();
    expect(result.items.map((held) => held.held)).toEqual(['stopped']);
    expect(await rowsOf(NOTES)).toEqual(UNTOUCHED);
    expect(own().listOwnUndo('ledger', { taskId: 't1' })).toEqual([]);
  });

  it('the app’s version is no longer armedVersion (e.g. it arrived by a trusted pull) → stopped AND disarmed with the app-updated trace', async () => {
    db.saveAppVersion('ledger', '<html>ledger v2</html>', 'pulled');
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1')]);
    expect(seat).not.toHaveBeenCalled();
    expect(result.items.map((held) => held.held)).toEqual(['stopped']);
    const task = db.getScheduledTask('t1') as ArmedTask;
    expect(task.writeAuthority).toBeUndefined();
    expect(task.disarmed).toEqual({ reason: 'app-updated', at: iso(NOW) });
    expect(await rowsOf(NOTES)).toEqual(UNTOUCHED);
  });

  it('the decision reads the FILE, not the task captured at claim: a task the file holds as unarmed never applies, whatever the captured copy says', async () => {
    const { writeAuthority: _gone, ...unarmed } = armedTask();
    db.putScheduledTask(unarmed as ScheduledTask);
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1')], false);
    expect(seat).not.toHaveBeenCalled();
    expect(result.applied).toBeUndefined();
    expect(await rowsOf(NOTES)).toEqual(UNTOUCHED);
  });
});

describe('the held reasons — ONE table (SCHEDULE_HELD_REASONS)', () => {
  it('the table is exactly the contract’s', () => {
    expect([...SCHEDULE_HELD_REASONS]).toEqual(['busy', 'changed', 'cannot-undo', 'full', 'failed', 'over-limit', 'stopped']);
  });

  it('full: the task’s bucket holds 20 live changes → every prefix item held full, nothing committed', async () => {
    for (let i = 0; i < 20; i += 1) {
      own().putOwnUndo('ledger', 't1', {
        id: crypto.randomUUID(),
        at: iso(NOW - (20 - i) * 60_000),
        expiresAt: iso(NOW + 7 * DAY),
        authority: 'task',
        via: 'schedule',
        runId: `run-old-${i}`,
        taskId: 't1',
        steps: [{ table: 'notes', op: 'update', columns: ['done'], rows: [{ rowid: 3, before: [0], after: [0] }] }],
      } as never);
    }
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1'), item('UPDATE notes SET done = 1 WHERE id = 2')]);
    expect(seat).not.toHaveBeenCalled();
    expect(result.items.map((held) => held.held)).toEqual(['full', 'full']);
    expect(await rowsOf(NOTES)).toEqual(UNTOUCHED);
  });

  it.each([
    ['a function', "UPDATE notes SET body = upper('a') WHERE id = 1"],
    ['arithmetic', 'UPDATE notes SET done = done + 1 WHERE id = 1'],
    ['no WHERE', 'UPDATE notes SET done = 1'],
  ])('cannot-undo (%s): an item that cannot be captured is never applied under the authority — the whole prefix held, nothing committed', async (_label, sql) => {
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 2'), item(sql, sql.includes('WHERE') ? 1 : 3)]);
    expect(result.applied).toBeUndefined();
    expect(result.items.map((held) => held.held)).toEqual(['cannot-undo', 'cannot-undo']);
    expect(await rowsOf(NOTES)).toEqual(UNTOUCHED);
  });

  it('cannot-undo: the kv table is never captured (admit refuses snug_kv) — the item stays pending, held', async () => {
    const kv = await db.driver.handle('ledger', { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `kv-${++seq}`, instanceId: 'frame', op: 'kvSet', key: 'k', value: 'v' } as never);
    expect(kv.ok).toBe(true);
    const result = await walk(armedTask(), [item("UPDATE snug_kv SET value = 'w' WHERE key = 'k'")]);
    expect(result.applied).toBeUndefined();
    expect(result.items.map((held) => held.held)).toEqual(['cannot-undo']);
  });

  it('changed: the data moved between the re-dry-run and the seat (the seat’s drift halt) → held changed, rolled back', async () => {
    const original = db.scratchRun.bind(db);
    vi.spyOn(db, 'scratchRun').mockImplementation(async (...args) => {
      const answer = await original(...args);
      await exec('INSERT INTO notes (id, body, done) VALUES (4, \'d\', 0)'); // the app wrote meanwhile
      return answer;
    });
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE done = 0', 3)]);
    expect(result.applied).toBeUndefined();
    expect(result.items.map((held) => held.held)).toEqual(['changed']);
    expect(await rowsOf('SELECT count(*) FROM notes WHERE done = 1')).toEqual([[0]]);
  });

  it('every held reason the walk writes is in the table', async () => {
    const result = await walk(armedTask({ writeAuthority: { rowsPerRun: 1, armedAt: ARMED_AT, armedVersion: 1 } }), [item('UPDATE notes SET done = 1 WHERE id IN (1, 2)', 2)]);
    for (const held of result.items) expect(SCHEDULE_HELD_REASONS as readonly string[]).toContain(held.held);
  });
});

describe('the authority covers its OWN app only (D-PR4-2)', () => {
  it('a cross-app item never applies under the task’s authority — it stays pending', async () => {
    db.installApp({ appId: 'pantry', displayName: 'Pantry', html: '<html>pantry</html>' });
    await db.applyAppDdl('pantry', ['CREATE TABLE items (id INTEGER PRIMARY KEY, qty INTEGER)']);
    const seat = vi.spyOn(db.driver, 'brokeredWrite');
    const cross: ScheduleProposalItem = { appId: 'pantry', sql: 'UPDATE items SET qty = 0 WHERE id = 1', counts: { changes: 0 } };
    const result = await walk(armedTask(), [item('UPDATE notes SET done = 1 WHERE id = 1'), cross]);
    for (const call of seat.mock.calls) expect(call[0]).toBe('ledger');
    expect(result.items.map((pending) => pending.appId)).toContain('pantry');
    expect(result.applied?.appId ?? 'ledger').toBe('ledger');
  });
});
