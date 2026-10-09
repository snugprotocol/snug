// schedules.test.ts — TASK-20261009-scheduling-framework C2: the typed accessors over the
// scheduler's settings rows (ADR-0074 §2).
//
// THE FILE IS THE RECORD. A task, its run history and the scheduler's state are
// namespaced `snug_settings` rows (`schedule:<taskId>`, `scheduleRuns:<taskId>`,
// `schedulerState`), so every accessor here is a boundary between what the engine
// believes and what a hand-edited, imported or synced row actually says. Two postures
// follow and both are tested:
//
//  - WRITES FAIL CLOSED. Nothing lands that did not pass the protocol's strict schema,
//    and every cap is proven by a FAILING WRITE, not by reading a constant back (lesson
//    2026-08-20: a cap nothing enforces is documentation, not a bound).
//  - READS FAIL OPEN. A row that does not parse reads as "no such task" and is REPORTED,
//    never thrown: one corrupted row must not stop the scheduler for every other task.
//
// The frequency floor is NOT enforced here — it needs the cron core, which lives in the
// playground; the accessor enforces shapes and caps only.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  SCHEDULE_MAX_TASKS,
  SCHEDULE_RUNS_MAX_BYTES,
  SCHEDULE_RUNS_MAX_ENTRIES,
  SCHEDULE_RUNS_TOTAL_MAX_BYTES,
  scheduleRunSchema,
  scheduledTaskSchema,
  type ScheduleRun,
  type ScheduledTask,
} from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import {
  SCHEDULER_STATE_SETTING_KEY,
  SCHEDULE_DECLINED_SETTING_PREFIX,
  SCHEDULE_MUTED_SETTING_PREFIX,
  SCHEDULE_RUNS_SETTING_PREFIX,
  SCHEDULE_SETTING_PREFIX,
  appIdFromScheduleMutedSettingKey,
  scheduleDeclinedSettingKey,
  scheduleDeclinedSettingPrefixFor,
  scheduleMutedSettingKey,
  scheduleRunsSettingKey,
  scheduleSettingKey,
  taskIdFromScheduleRunsSettingKey,
  taskIdFromScheduleSettingKey,
} from '../app-settings-keys.js';
import { USERDB_ERROR_CODES, UserDbError, openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

const AT = '2026-10-09T08:00:00.000Z';
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The i-th minute after a fixed epoch — unique, increasing ISO instants for run identities. */
const at = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

function task(id: string, overrides: Record<string, unknown> = {}): ScheduledTask {
  return scheduledTaskSchema.parse({
    id,
    title: `Task ${id}`,
    enabled: true,
    provenance: 'user',
    steps: [{ kind: 'notify', title: 'Water the plants', body: 'The ferns are thirsty.' }],
    spec: { kind: 'daily', time: '08:00', tz: 'device' },
    cron: '0 8 * * *',
    missedPolicy: 'run-once',
    staleAfterMs: 86_400_000,
    alert: 'inbox',
    appVersions: {},
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

function run(taskId: string, dueAt: string, overrides: Record<string, unknown> = {}): ScheduleRun {
  return scheduleRunSchema.parse({
    id: `run-${taskId}-${dueAt}`,
    taskId,
    dueAt,
    trigger: 'due',
    status: 'ok',
    host: { kind: 'web' },
    steps: [],
    ...overrides,
  });
}

/**
 * A run of ~7 KiB (five 1350-char PROSE step summaries — the credential walk is
 * super-linear in token length, so an unbroken token would be a cost no real summary
 * pays) — under the 8 KiB per-run cap, so nine fit a task row and ten do not.
 */
const heavyRun = (taskId: string, dueAt: string, status = 'ok'): ScheduleRun =>
  run(taskId, dueAt, {
    status,
    steps: Array.from({ length: 5 }, () => ({ status: 'ok', summary: 'the ferns are thirsty, '.repeat(59).slice(0, 1350) })),
  });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof UserDbError ? err.code : `not a UserDbError: ${String(err)}`;
  }
}

/** The bytes every runs row occupies, summed — the figure the 2 MiB ceiling is measured in. */
function storedRunBytes(): number {
  let total = 0;
  for (const key of db.listSettingKeys()) {
    if (taskIdFromScheduleRunsSettingKey(key) === undefined) continue;
    total += utf8Bytes(JSON.stringify(db.getSetting(key)));
  }
  return total;
}

describe('the key shapes (single-homed in app-settings-keys.ts)', () => {
  it('builds and parses each namespace; the parsers refuse bare prefixes and sibling namespaces', () => {
    expect(scheduleSettingKey('t1')).toBe(`${SCHEDULE_SETTING_PREFIX}t1`);
    expect(scheduleRunsSettingKey('t1')).toBe(`${SCHEDULE_RUNS_SETTING_PREFIX}t1`);
    expect(scheduleDeclinedSettingKey('app', 'abc')).toBe(`${SCHEDULE_DECLINED_SETTING_PREFIX}app:abc`);
    expect(scheduleDeclinedSettingPrefixFor('app')).toBe(`${SCHEDULE_DECLINED_SETTING_PREFIX}app:`);
    expect(scheduleMutedSettingKey('app')).toBe(`${SCHEDULE_MUTED_SETTING_PREFIX}app`);
    expect(SCHEDULER_STATE_SETTING_KEY).toBe('schedulerState');

    expect(taskIdFromScheduleSettingKey('schedule:t1')).toBe('t1');
    expect(taskIdFromScheduleSettingKey('schedule:')).toBeUndefined();
    // `scheduleRuns:` and `schedulerState` share the first eight letters with `schedule:`
    // — the parsers are exact, so a runs row can never be listed as a task.
    expect(taskIdFromScheduleSettingKey('scheduleRuns:t1')).toBeUndefined();
    expect(taskIdFromScheduleSettingKey('schedulerState')).toBeUndefined();
    expect(taskIdFromScheduleRunsSettingKey('scheduleRuns:t1')).toBe('t1');
    expect(taskIdFromScheduleRunsSettingKey('schedule:t1')).toBeUndefined();
    expect(appIdFromScheduleMutedSettingKey('scheduleMuted:app')).toBe('app');
    expect(appIdFromScheduleMutedSettingKey('scheduleMuted:')).toBeUndefined();

    for (const build of [
      () => scheduleSettingKey(''),
      () => scheduleRunsSettingKey(''),
      () => scheduleDeclinedSettingKey('', 'h'),
      () => scheduleDeclinedSettingKey('app', ''),
      () => scheduleMutedSettingKey(''),
    ]) {
      expect(build).toThrow();
    }
  });
});

describe('tasks — putScheduledTask / getScheduledTask / listScheduledTasks', () => {
  it('round-trips a task with the schema defaults filled into the stored bytes', () => {
    db.putScheduledTask(task('t1'));
    const stored = db.getScheduledTask('t1');
    expect(stored).toEqual(task('t1'));
    expect(stored?.consecutiveFailures).toBe(0);
    expect(stored?.unseenResults).toBe(0);
    expect(db.listScheduledTasks().map((t) => t.id)).toEqual(['t1']);
    // The row lives under the single-homed key, as the protocol's JSON.
    expect(db.getSetting(scheduleSettingKey('t1'))).toEqual(task('t1'));
  });

  it('replaces in place on the same id — the caller owns updatedAt; the accessor stores what it is given', () => {
    db.putScheduledTask(task('t1'));
    db.putScheduledTask(task('t1', { title: 'Renamed', enabled: false, updatedAt: '2026-10-10T08:00:00.000Z' }));
    expect(db.listScheduledTasks()).toHaveLength(1);
    expect(db.getScheduledTask('t1')?.title).toBe('Renamed');
    expect(db.getScheduledTask('t1')?.enabled).toBe(false);
    expect(db.getScheduledTask('t1')?.updatedAt).toBe('2026-10-10T08:00:00.000Z');
  });

  it('refuses an invalid task at the write boundary with SCHEDULE_INVALID and writes NOTHING', () => {
    const bad = { ...task('t1'), missedPolicy: 'whenever' } as unknown as ScheduledTask;
    expect(codeOf(() => db.putScheduledTask(bad))).toBe(USERDB_ERROR_CODES.SCHEDULE_INVALID);
    expect(db.getScheduledTask('t1')).toBeUndefined();
    expect(db.listSettingKeys().filter((k) => taskIdFromScheduleSettingKey(k) !== undefined)).toEqual([]);
  });

  it('refuses a task carrying a credential-shaped string — the C1 parse refusal reaches the write', () => {
    // Built WITHOUT the fixture's parse: the refusal under test is the accessor's.
    const smuggling = {
      ...task('t1'),
      steps: [
        {
          kind: 'app-think',
          appId: 'ledger',
          prompt: 'Use sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD to fetch my balance.',
          context: {},
        },
      ],
    } as unknown as ScheduledTask;
    expect(codeOf(() => db.putScheduledTask(smuggling))).toBe(USERDB_ERROR_CODES.SCHEDULE_INVALID);
    expect(db.getScheduledTask('t1')).toBeUndefined();
  });

  it('refuses a task over 16 KiB — proven by the failing write, not by reading the constant', () => {
    // Five app-think steps, each with four ~1 KiB context queries: ~24 KiB serialized.
    const query = `SELECT '${'q'.repeat(990)}'`;
    const steps = Array.from({ length: 5 }, (_, i) => ({
      kind: 'app-think',
      appId: `app-${i}`,
      prompt: 'Summarise.',
      context: { sql: [query, query, query, query] },
    }));
    const oversized = { ...task('t1'), steps } as unknown as ScheduledTask;
    expect(utf8Bytes(JSON.stringify(oversized))).toBeGreaterThan(16 * 1024);
    expect(codeOf(() => db.putScheduledTask(oversized))).toBe(USERDB_ERROR_CODES.SCHEDULE_INVALID);
    expect(db.getScheduledTask('t1')).toBeUndefined();
  });

  it(`admits ${SCHEDULE_MAX_TASKS} tasks and refuses the next with SCHEDULE_LIMIT; a replace at the cap still lands`, () => {
    for (let i = 0; i < SCHEDULE_MAX_TASKS; i += 1) db.putScheduledTask(task(`t${i}`));
    expect(db.listScheduledTasks()).toHaveLength(SCHEDULE_MAX_TASKS);

    expect(codeOf(() => db.putScheduledTask(task('one-too-many')))).toBe(USERDB_ERROR_CODES.SCHEDULE_LIMIT);
    expect(db.getScheduledTask('one-too-many')).toBeUndefined();
    expect(db.listScheduledTasks()).toHaveLength(SCHEDULE_MAX_TASKS);

    // The cap counts OTHER tasks: editing an existing one is not a 201st.
    db.putScheduledTask(task('t0', { title: 'Edited at the cap' }));
    expect(db.getScheduledTask('t0')?.title).toBe('Edited at the cap');

    // Deleting one frees the seat.
    db.deleteScheduledTask('t1');
    db.putScheduledTask(task('one-too-many'));
    expect(db.listScheduledTasks()).toHaveLength(SCHEDULE_MAX_TASKS);
  });

  it('SKIPS a row that does not parse and reports its key — a corrupted row never crashes the hub', () => {
    db.putScheduledTask(task('good'));
    // Planted through the raw settings writer: what a hand-edit or a foreign file leaves.
    db.setSetting(scheduleSettingKey('garbage'), { nope: true });
    db.setSetting(scheduleSettingKey('not-json-object'), 'a string');
    // A body whose id disagrees with its key is unreadable too: honoring it would let one
    // key answer for another task's runs row.
    db.setSetting(scheduleSettingKey('mismatch'), task('someone-else'));

    expect(db.listScheduledTasks().map((t) => t.id)).toEqual(['good']);
    expect(db.getScheduledTask('garbage')).toBeUndefined();
    expect(db.getScheduledTask('mismatch')).toBeUndefined();
    expect(db.listUnreadableScheduleKeys().sort()).toEqual(
      [scheduleSettingKey('garbage'), scheduleSettingKey('mismatch'), scheduleSettingKey('not-json-object')].sort(),
    );
  });

  it('deleteScheduledTask removes the task AND its runs row; an unknown id is a no-op', () => {
    db.putScheduledTask(task('t1'));
    db.putScheduleRun(run('t1', at(1)));
    db.putScheduledTask(task('t2'));
    db.putScheduleRun(run('t2', at(2)));

    db.deleteScheduledTask('t1');

    expect(db.getScheduledTask('t1')).toBeUndefined();
    expect(db.listScheduleRuns('t1')).toEqual([]);
    expect(db.getSetting(scheduleRunsSettingKey('t1'))).toBeUndefined();
    // The sibling is untouched.
    expect(db.getScheduledTask('t2')).toBeDefined();
    expect(db.listScheduleRuns('t2')).toHaveLength(1);
    expect(() => db.deleteScheduledTask('never-existed')).not.toThrow();
  });
});

describe('runs — putScheduleRun upserts by (taskId, dueAt), newest first', () => {
  beforeEach(() => {
    db.putScheduledTask(task('t1'));
    db.putScheduledTask(task('t2'));
  });

  it('a new dueAt lands at the FRONT; the same dueAt REPLACES in place (the claim becomes the result)', () => {
    db.putScheduleRun(run('t1', at(1), { status: 'running', startedAt: at(1) }));
    db.putScheduleRun(run('t1', at(2), { status: 'running', startedAt: at(2) }));
    expect(db.listScheduleRuns('t1').map((r) => r.dueAt)).toEqual([at(2), at(1)]);

    // The finalise of the first claim: same (taskId, dueAt), new status — one row, not two.
    db.putScheduleRun(run('t1', at(1), { status: 'ok', startedAt: at(1), finishedAt: at(3) }));
    const runs = db.listScheduleRuns('t1');
    expect(runs.map((r) => [r.dueAt, r.status])).toEqual([
      [at(2), 'running'],
      [at(1), 'ok'],
    ]);
    expect(runs[1]?.finishedAt).toBe(at(3));
    // Defaults are in the stored bytes.
    expect(runs[0]?.collapsedCount).toBe(1);
    expect(runs[0]?.calls).toEqual({ ai: 0, net: 0 });
  });

  it('listAllScheduleRuns groups by task; listScheduleRuns on an unknown task is empty', () => {
    db.putScheduleRun(run('t1', at(1)));
    db.putScheduleRun(run('t2', at(2)));
    db.putScheduleRun(run('t2', at(3)));
    const all = db.listAllScheduleRuns();
    expect(Object.keys(all).sort()).toEqual(['t1', 't2']);
    expect(all.t1?.map((r) => r.dueAt)).toEqual([at(1)]);
    expect(all.t2?.map((r) => r.dueAt)).toEqual([at(3), at(2)]);
    expect(db.listScheduleRuns('nope')).toEqual([]);
  });

  it('refuses an invalid run (SCHEDULE_INVALID) and a run for a task that does not exist (NOT_FOUND) — nothing is written', () => {
    const bad = { ...run('t1', at(1)), status: 'done' } as unknown as ScheduleRun;
    expect(codeOf(() => db.putScheduleRun(bad))).toBe(USERDB_ERROR_CODES.SCHEDULE_INVALID);
    expect(db.listScheduleRuns('t1')).toEqual([]);

    // A run row for a task the file does not hold would be an orphan nothing could reach
    // from a task — the shape a finalise AFTER the user deleted the task would leave.
    expect(codeOf(() => db.putScheduleRun(run('ghost', at(1))))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    expect(db.getSetting(scheduleRunsSettingKey('ghost'))).toBeUndefined();
  });

  it('a runs row that is not an array reads as empty; unreadable entries are skipped, readable ones kept', () => {
    db.setSetting(scheduleRunsSettingKey('t1'), { not: 'an array' });
    expect(db.listScheduleRuns('t1')).toEqual([]);

    db.setSetting(scheduleRunsSettingKey('t2'), [run('t2', at(1)), { garbage: true }, run('other-task', at(2))]);
    expect(db.listScheduleRuns('t2').map((r) => r.dueAt)).toEqual([at(1)]);
  });
});

describe('runs — the per-task caps are proven by failing or pruning writes', () => {
  beforeEach(() => {
    db.putScheduledTask(task('t1'));
  });

  it(`keeps at most ${SCHEDULE_RUNS_MAX_ENTRIES} entries: the OLDEST ok entry goes first`, () => {
    for (let i = 0; i < SCHEDULE_RUNS_MAX_ENTRIES; i += 1) db.putScheduleRun(run('t1', at(i)));
    expect(db.listScheduleRuns('t1')).toHaveLength(SCHEDULE_RUNS_MAX_ENTRIES);

    db.putScheduleRun(run('t1', at(SCHEDULE_RUNS_MAX_ENTRIES)));
    const runs = db.listScheduleRuns('t1');
    expect(runs).toHaveLength(SCHEDULE_RUNS_MAX_ENTRIES);
    expect(runs[0]?.dueAt).toBe(at(SCHEDULE_RUNS_MAX_ENTRIES));
    expect(runs.some((r) => r.dueAt === at(0)), 'the oldest ok run was pruned').toBe(false);
    expect(runs.some((r) => r.dueAt === at(1))).toBe(true);
  });

  it('prunes ok/skipped before failed/capped/no-handler/interrupted, oldest first within a tier', () => {
    // Oldest to newest: failed, interrupted, ok, skipped, then plain ok runs up to the cap.
    db.putScheduleRun(run('t1', at(0), { status: 'failed' }));
    db.putScheduleRun(run('t1', at(1), { status: 'interrupted' }));
    db.putScheduleRun(run('t1', at(2), { status: 'ok' }));
    db.putScheduleRun(run('t1', at(3), { status: 'skipped' }));
    for (let i = 4; i < SCHEDULE_RUNS_MAX_ENTRIES; i += 1) db.putScheduleRun(run('t1', at(i)));

    db.putScheduleRun(run('t1', at(100)));
    let dueAts = db.listScheduleRuns('t1').map((r) => r.dueAt);
    expect(dueAts).not.toContain(at(2)); // the oldest ok went, not the older failed/interrupted
    expect(dueAts).toContain(at(0));
    expect(dueAts).toContain(at(1));

    db.putScheduleRun(run('t1', at(101)));
    dueAts = db.listScheduleRuns('t1').map((r) => r.dueAt);
    expect(dueAts).not.toContain(at(3)); // then the skipped one
    // The tier-2 rows are still there: a failure's line of history outlives any ok result.
    expect(dueAts).toContain(at(0));
    expect(dueAts).toContain(at(1));
  });

  it('reaches tier 2 only once no ok/skipped entry is left — then oldest first, then SCHEDULE_LIMIT', () => {
    db.putScheduleRun(run('t1', at(0), { status: 'failed' }));
    db.putScheduleRun(run('t1', at(1), { status: 'interrupted' }));
    db.putScheduleRun(run('t1', at(2), { status: 'capped' }));
    db.putScheduleRun(run('t1', at(3), { status: 'no-handler' }));
    for (let i = 4; i < SCHEDULE_RUNS_MAX_ENTRIES; i += 1) db.putScheduleRun(run('t1', at(i), { status: 'needs-you' }));

    db.putScheduleRun(run('t1', at(100), { status: 'failed' }));
    expect(db.listScheduleRuns('t1').map((r) => r.dueAt)).not.toContain(at(0));
    db.putScheduleRun(run('t1', at(101), { status: 'failed' }));
    expect(db.listScheduleRuns('t1').map((r) => r.dueAt)).not.toContain(at(1));
    db.putScheduleRun(run('t1', at(102), { status: 'failed' }));
    db.putScheduleRun(run('t1', at(103), { status: 'failed' }));
    let dueAts = db.listScheduleRuns('t1').map((r) => r.dueAt);
    expect(dueAts).not.toContain(at(2));
    expect(dueAts).not.toContain(at(3));
    expect(dueAts).toHaveLength(SCHEDULE_RUNS_MAX_ENTRIES);

    // The four newest failures are now the only tier-2 rows; an unprunable arrival still
    // takes the oldest of THEM — never one of the 46 needs-you rows.
    db.putScheduleRun(run('t1', at(200), { status: 'needs-you' }));
    dueAts = db.listScheduleRuns('t1').map((r) => r.dueAt);
    expect(dueAts).not.toContain(at(100));
    expect(dueAts).toContain(at(101));
    expect(db.listScheduleRuns('t1').filter((r) => r.status === 'needs-you')).toHaveLength(47);
  });

  it('NEVER prunes pending, needs-you or running; when nothing prunable remains the write fails with SCHEDULE_LIMIT', () => {
    for (let i = 0; i < SCHEDULE_RUNS_MAX_ENTRIES; i += 1) {
      const status = i % 3 === 0 ? 'pending' : i % 3 === 1 ? 'needs-you' : 'running';
      db.putScheduleRun(run('t1', at(i), { status }));
    }
    const before = db.listScheduleRuns('t1');
    expect(before).toHaveLength(SCHEDULE_RUNS_MAX_ENTRIES);

    // The incoming ok run is the only prunable entry — pruning the row being written is
    // not a write, so the accessor refuses instead.
    expect(codeOf(() => db.putScheduleRun(run('t1', at(999))))).toBe(USERDB_ERROR_CODES.SCHEDULE_LIMIT);
    expect(db.listScheduleRuns('t1')).toEqual(before);

    // Acting on one (needs-you → ok) makes room: the next write prunes THAT one, not an unacted row.
    db.putScheduleRun(run('t1', at(1), { status: 'ok' }));
    db.putScheduleRun(run('t1', at(999)));
    const after = db.listScheduleRuns('t1');
    expect(after).toHaveLength(SCHEDULE_RUNS_MAX_ENTRIES);
    expect(after.map((r) => r.dueAt)).not.toContain(at(1));
    expect(after.filter((r) => r.status === 'ok').map((r) => r.dueAt)).toEqual([at(999)]);
  });

  it(`keeps a task's row at or under ${SCHEDULE_RUNS_MAX_BYTES} bytes — fewer than ${SCHEDULE_RUNS_MAX_ENTRIES} entries when they are heavy`, () => {
    let count = 0;
    while (count < SCHEDULE_RUNS_MAX_ENTRIES) {
      db.putScheduleRun(heavyRun('t1', at(count)));
      count += 1;
      const bytes = utf8Bytes(JSON.stringify(db.getSetting(scheduleRunsSettingKey('t1'))));
      expect(bytes).toBeLessThanOrEqual(SCHEDULE_RUNS_MAX_BYTES);
      if (db.listScheduleRuns('t1').length < count) break;
    }
    const runs = db.listScheduleRuns('t1');
    expect(runs.length, 'the byte cap bit before the entry cap could').toBeLessThan(SCHEDULE_RUNS_MAX_ENTRIES);
    expect(runs.length).toBeLessThan(count);
    expect(runs[0]?.dueAt).toBe(at(count - 1)); // the newest survived
    expect(runs.map((r) => r.dueAt)).not.toContain(at(0)); // the oldest went
  });

  it('a heavy history of nothing but needs-you rows refuses the write that would cross the byte cap', () => {
    let code: string | undefined;
    let written = 0;
    for (let i = 0; i < SCHEDULE_RUNS_MAX_ENTRIES && code === undefined; i += 1) {
      code = codeOf(() => db.putScheduleRun(heavyRun('t1', at(i), 'needs-you')));
      if (code === undefined) written += 1;
    }
    expect(code).toBe(USERDB_ERROR_CODES.SCHEDULE_LIMIT);
    expect(db.listScheduleRuns('t1')).toHaveLength(written);
    expect(utf8Bytes(JSON.stringify(db.getSetting(scheduleRunsSettingKey('t1'))))).toBeLessThanOrEqual(SCHEDULE_RUNS_MAX_BYTES);
  });
});

describe(`runs — the ${SCHEDULE_RUNS_TOTAL_MAX_BYTES}-byte ceiling across every task`, () => {
  // 8 heavy runs ≈ 56 KiB per task (under the per-task cap, so only the global ceiling can
  // prune); 40 tasks ≈ 2.2 MiB, over the ceiling by a few runs' worth.
  const TASKS = 40;
  const PER_TASK = 8;

  it('prunes the GLOBALLY oldest ok entries, one per write, and the total never exceeds the ceiling', () => {
    for (let t = 0; t < TASKS; t += 1) db.putScheduledTask(task(`t${t}`));
    let seq = 0;
    for (let t = 0; t < TASKS; t += 1) {
      for (let i = 0; i < PER_TASK; i += 1) {
        db.putScheduleRun(heavyRun(`t${t}`, at(seq)));
        seq += 1;
      }
      expect(storedRunBytes(), `after task t${t}`).toBeLessThanOrEqual(SCHEDULE_RUNS_TOTAL_MAX_BYTES);
    }
    // The oldest dueAts are t0's — they went first, in order, and only as many as needed.
    const t0 = db.listScheduleRuns('t0').map((r) => r.dueAt);
    expect(t0).not.toContain(at(0));
    expect(t0.length).toBeLessThan(PER_TASK);
    expect(t0).toEqual(t0.slice().sort().reverse()); // what remains of t0 is its newest runs, contiguous
    // The newest write is present and its own task's row is intact (no per-task prune fired).
    expect(db.listScheduleRuns(`t${TASKS - 1}`)).toHaveLength(PER_TASK);
    expect(db.listScheduleRuns(`t${TASKS - 1}`)[0]?.dueAt).toBe(at(seq - 1));
    // Exactly as much went as the ceiling required: the total sits within one run of it.
    const oneRun = utf8Bytes(JSON.stringify(heavyRun('t0', at(0)))) + 1;
    expect(storedRunBytes()).toBeGreaterThan(SCHEDULE_RUNS_TOTAL_MAX_BYTES - oneRun);
    const total = Object.values(db.listAllScheduleRuns()).reduce((n, runs) => n + runs.length, 0);
    expect(total).toBeLessThan(TASKS * PER_TASK);
  });

  it('with nothing prunable anywhere, the write that would cross the ceiling fails with SCHEDULE_LIMIT', () => {
    for (let t = 0; t < TASKS; t += 1) db.putScheduledTask(task(`t${t}`));
    let code: string | undefined;
    let seq = 0;
    outer: for (let t = 0; t < TASKS; t += 1) {
      for (let i = 0; i < PER_TASK; i += 1) {
        code = codeOf(() => db.putScheduleRun(heavyRun(`t${t}`, at(seq), 'needs-you')));
        seq += 1;
        if (code !== undefined) break outer;
      }
    }
    expect(code).toBe(USERDB_ERROR_CODES.SCHEDULE_LIMIT);
    expect(storedRunBytes()).toBeLessThanOrEqual(SCHEDULE_RUNS_TOTAL_MAX_BYTES);
    const all = db.listAllScheduleRuns();
    expect(Object.values(all).flat().every((r) => r.status === 'needs-you')).toBe(true);
  });
});

describe('runs — markScheduleRunSeen and clearScheduleHistory', () => {
  beforeEach(() => {
    db.putScheduledTask(task('t1'));
    db.putScheduledTask(task('t2'));
  });

  it('markScheduleRunSeen stamps seenAt on that one entry; an absent entry is a no-op; a bad stamp is refused', () => {
    db.putScheduleRun(run('t1', at(1)));
    db.putScheduleRun(run('t1', at(2)));
    db.markScheduleRunSeen('t1', at(1), at(5));
    const runs = db.listScheduleRuns('t1');
    expect(runs.find((r) => r.dueAt === at(1))?.seenAt).toBe(at(5));
    expect(runs.find((r) => r.dueAt === at(2))?.seenAt).toBeUndefined();

    expect(() => db.markScheduleRunSeen('t1', at(99), at(5))).not.toThrow();
    expect(() => db.markScheduleRunSeen('nope', at(1), at(5))).not.toThrow();
    expect(db.listScheduleRuns('t1')).toEqual(runs);

    expect(codeOf(() => db.markScheduleRunSeen('t1', at(2), 'yesterday'))).toBe(USERDB_ERROR_CODES.SCHEDULE_INVALID);
    expect(db.listScheduleRuns('t1').find((r) => r.dueAt === at(2))?.seenAt).toBeUndefined();
  });

  it('clearScheduleHistory(taskId) drops results but KEEPS pending, needs-you and running entries', () => {
    db.putScheduleRun(run('t1', at(1), { status: 'ok' }));
    db.putScheduleRun(run('t1', at(2), { status: 'failed' }));
    db.putScheduleRun(run('t1', at(3), { status: 'pending' }));
    db.putScheduleRun(run('t1', at(4), { status: 'needs-you' }));
    db.putScheduleRun(run('t1', at(5), { status: 'running', startedAt: at(5) }));
    db.putScheduleRun(run('t2', at(6), { status: 'ok' }));

    db.clearScheduleHistory('t1');

    expect(db.listScheduleRuns('t1').map((r) => [r.dueAt, r.status])).toEqual([
      [at(5), 'running'],
      [at(4), 'needs-you'],
      [at(3), 'pending'],
    ]);
    expect(db.listScheduleRuns('t2')).toHaveLength(1); // only the named task was cleared
  });

  it('clearScheduleHistory() with no task clears every task, and a row with nothing to keep is DELETED', () => {
    db.putScheduleRun(run('t1', at(1), { status: 'ok' }));
    db.putScheduleRun(run('t2', at(2), { status: 'ok' }));
    db.putScheduleRun(run('t2', at(3), { status: 'needs-you' }));

    db.clearScheduleHistory();

    expect(db.getSetting(scheduleRunsSettingKey('t1'))).toBeUndefined();
    expect(db.listScheduleRuns('t2').map((r) => r.status)).toEqual(['needs-you']);
  });
});

describe('schedulerState — getSchedulerState / setSchedulerState', () => {
  it('is absent until written, round-trips with defaults, and refuses an invalid state', () => {
    expect(db.getSchedulerState()).toBeUndefined();
    db.setSchedulerState({ watermark: AT, daily: { date: '2026-10-09', ai: 3, net: 7 } } as never);
    expect(db.getSchedulerState()).toEqual({
      watermark: AT,
      globalPause: false,
      daily: { date: '2026-10-09', ai: 3, net: 7 },
    });
    expect(codeOf(() => db.setSchedulerState({ watermark: 'now', daily: { date: '2026-10-09', ai: 0, net: 0 } } as never))).toBe(
      USERDB_ERROR_CODES.SCHEDULE_INVALID,
    );
    expect(db.getSchedulerState()?.watermark).toBe(AT);
    // The unreadable-row posture: a corrupt state reads as absent, never as a throw.
    db.setSetting(SCHEDULER_STATE_SETTING_KEY, { watermark: 42 });
    expect(db.getSchedulerState()).toBeUndefined();
  });
});

describe('app suggestions — declines and the per-app mute', () => {
  it('declines are per app and listed as hashes; the mute is a boolean whose clearing DELETES the row', () => {
    db.addScheduleDecline('app-a', 'hash-1');
    db.addScheduleDecline('app-a', 'hash-2');
    db.addScheduleDecline('app-b', 'hash-1');
    expect(db.listScheduleDeclines('app-a').sort()).toEqual(['hash-1', 'hash-2']);
    expect(db.listScheduleDeclines('app-b')).toEqual(['hash-1']);
    expect(db.listScheduleDeclines('app-c')).toEqual([]);

    expect(db.isScheduleMuted('app-a')).toBe(false);
    db.setScheduleMuted('app-a', true);
    expect(db.isScheduleMuted('app-a')).toBe(true);
    expect(db.isScheduleMuted('app-b')).toBe(false);
    expect(db.listSettingKeys()).toContain(scheduleMutedSettingKey('app-a'));

    db.setScheduleMuted('app-a', false);
    expect(db.isScheduleMuted('app-a')).toBe(false);
    expect(db.listSettingKeys()).not.toContain(scheduleMutedSettingKey('app-a'));
  });
});
