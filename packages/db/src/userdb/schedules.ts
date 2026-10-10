// schedules.ts — the scheduler's storage (TASK-20261009-scheduling-framework C2–C4,
// ADR-0074 §2): typed accessors over the `schedule:*` settings rows, the `deleteApp`
// sweep, and the import/export passes.
//
// THE FILE IS THE RECORD. A task, its run history and the scheduler's state are
// namespaced `snug_settings` rows (SPEC §8.1 — no new table, no v7), so they travel with
// the file: into a backup, over a sync origin, through a hand edit. That is the point and
// also the hazard, because a task is EXECUTABLE INTENT — what parses later spends the
// user's brain, network budget and attention. Hence two postures:
//
//  - WRITES FAIL CLOSED. Every accessor parses through `@snugprotocol/protocol`'s strict
//    schemas BEFORE touching a row (the `parseConnectionRequirementStrict` rule), so a
//    refused write leaves the file byte-identical. The caps — 200 tasks, 16 KiB per task,
//    50 entries / 64 KiB per task's history, 2 MiB across every history — are enforced
//    here by refusing or pruning, never by trusting the caller.
//  - READS FAIL OPEN. A row that does not parse reads as "no such task" and is REPORTED
//    (`listUnreadableScheduleKeys`), never thrown: one corrupted row must not stop the
//    scheduler for every other task (the `parseRuntimeContract` posture).
//
// THE HOT READ PATH (M3). The engine lists every task's runs twice a minute, and the strict
// parse's credential walk is the expensive half of a read. Each accessor instance memoizes
// the parsed runs of a task's row by the row's EXACT stored bytes: a row whose bytes did not
// change parses zero times, a changed row re-parses only itself, the map holds one entry per
// task (dropped when the row goes), and every answer is a fresh array so a caller can never
// poison the memo. `scrubScheduleRunRows` and the import pass run on bare handles and read
// unmemoized — they are one-shot.
//
// NOT HERE: the frequency floor (it needs the cron core, which lives in the playground),
// and anything about WHEN a task runs. This module only decides what the file says.
//
// HOMED BESIDE userdb.ts, not inside it, so the factory grows by a spread and three
// call sites. The seams it needs (`select`/`run` on the open handle, the guarded settings
// write, the factory's error thrower) are injected rather than imported: userdb.ts
// imports this module, so this module cannot import userdb.ts back (the app-bundle.ts
// rule). The cascade and the import pass take a bare `SettingsSql` because they run on
// handles the factory does not wrap — the delete transaction, the import CANDIDATE and
// the export's throwaway copy.

import {
  RUN_STATUSES,
  SCHEDULE_MAX_TASKS,
  SCHEDULE_RUNS_MAX_BYTES,
  SCHEDULE_RUNS_MAX_ENTRIES,
  SCHEDULE_RUNS_TOTAL_MAX_BYTES,
  USERDB_TABLES,
  canonicalScheduleIntent,
  parseScheduledTask,
  parseSchedulerState,
  scheduleRunSchema,
  scheduledTaskSchema,
  schedulerStateSchema,
  utf8ByteLength,
  type RunStatus,
  type ScheduleRun,
  type ScheduleStep,
  type ScheduledTask,
} from '@snugprotocol/protocol';
import {
  SCHEDULER_STATE_SETTING_KEY,
  SCHEDULE_DECLINED_SETTING_PREFIX,
  SCHEDULE_MUTED_SETTING_PREFIX,
  SCHEDULE_RUNS_SETTING_PREFIX,
  SCHEDULE_SETTING_PREFIX,
  scheduleDeclinedSettingKey,
  scheduleDeclinedSettingPrefixFor,
  scheduleMutedSettingKey,
  scheduleRunsSettingKey,
  scheduleSettingKey,
  taskIdFromScheduleRunsSettingKey,
  taskIdFromScheduleSettingKey,
} from './app-settings-keys.js';
import type { UserDb } from './userdb.js';

// ------------------------------------------------------------------------- seams

/** The two statements this module needs from whichever sql.js handle it is pointed at. */
export interface SettingsSql {
  select(sql: string, params?: unknown[]): unknown[][];
  run(sql: string, params?: unknown[]): void;
}

/** The `USERDB_ERROR_CODES` keys an accessor may throw — mapped to the real code by the factory. */
export type ScheduleRefusal = 'SCHEDULE_INVALID' | 'SCHEDULE_LIMIT' | 'NOT_FOUND';

/** What the factory lends the accessors: its open check, its guarded settings write, its thrower. */
export interface ScheduleSeams extends SettingsSql {
  assertOpen(): void;
  /** `kvSet` on the settings table — carries `guardAddedBytes`. */
  setSetting(key: string, value: unknown): void;
  /** Throws the factory's `UserDbError` with the named code. */
  refuse(code: ScheduleRefusal, message: string): never;
}

export type ScheduleAccessors = Pick<
  UserDb,
  | 'listScheduledTasks'
  | 'listUnreadableScheduleKeys'
  | 'getScheduledTask'
  | 'putScheduledTask'
  | 'deleteScheduledTask'
  | 'listScheduleRuns'
  | 'listAllScheduleRuns'
  | 'putScheduleRun'
  | 'markScheduleRunSeen'
  | 'clearScheduleHistory'
  | 'getSchedulerState'
  | 'setSchedulerState'
  | 'listScheduleDeclines'
  | 'addScheduleDecline'
  | 'isScheduleMuted'
  | 'setScheduleMuted'
>;

// ----------------------------------------------------------------------- helpers

const SETTINGS = USERDB_TABLES.settings;
/** The escaped-prefix LIKE pattern the `auth:` and `shareLink:` sweeps use — `!`, `%`, `_` are literal. */
const likePrefix = (prefix: string): string => `${prefix.replace(/([!%_])/g, '!$1')}%`;
const PREFIX_WHERE = `key LIKE ? ESCAPE '!'`;
/** Instants compare by value, not by text: the schema admits `…:00Z` beside `…:00.000Z`. */
const instant = (iso: string): number => Date.parse(iso);

function rowsUnder(sql: SettingsSql, prefix: string): Array<[key: string, raw: string]> {
  return sql
    .select(`SELECT key, value FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(prefix)])
    .map((row) => [String(row[0]), String(row[1])]);
}

function rawValue(sql: SettingsSql, key: string): string | undefined {
  const raw = sql.select(`SELECT value FROM ${SETTINGS} WHERE key = ?`, [key])[0]?.[0];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** The UNGUARDED settings write, for handles the factory does not wrap (a candidate, a copy). */
function writeRaw(sql: SettingsSql, key: string, value: unknown): void {
  sql.run(`INSERT OR REPLACE INTO ${SETTINGS} (key, value) VALUES (?, ?)`, [key, JSON.stringify(value)]);
}

function deleteKey(sql: SettingsSql, key: string): void {
  sql.run(`DELETE FROM ${SETTINGS} WHERE key = ?`, [key]);
}

function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * The tolerant task read plus the KEY/BODY AGREEMENT rule: a `schedule:a` row whose body
 * says `id: 'b'` is unreadable. Honoring it would let one key answer for another task's
 * runs row and seat — exactly what a hand edit or a crafted file could set up.
 */
function readTask(raw: string | undefined, taskId: string): ScheduledTask | undefined {
  const task = parseScheduledTask(raw);
  return task !== undefined && task.id === taskId ? task : undefined;
}

interface RunRow {
  runs: ScheduleRun[];
  /** Entries (or the whole row) that did not parse. The next write of the row drops them. */
  unreadable: number;
}

/** The tolerant history read: a non-array row is empty; an entry that fails the strict parse, or names another task, is skipped. */
function readRuns(raw: string | undefined, taskId: string): RunRow {
  if (raw === undefined) return { runs: [], unreadable: 0 };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { runs: [], unreadable: 1 };
  }
  if (!Array.isArray(json)) return { runs: [], unreadable: 1 };
  const runs: ScheduleRun[] = [];
  let unreadable = 0;
  for (const entry of json) {
    const parsed = scheduleRunSchema.safeParse(entry);
    if (parsed.success && parsed.data.taskId === taskId) runs.push(parsed.data);
    else unreadable += 1;
  }
  return { runs, unreadable };
}

// ----------------------------------------------------------------------- pruning

/** What pruning needs to know about an entry — read strictly (a validated run) or loosely (a raw row's element). */
interface EntryView {
  /** Undefined for an entry that is not a readable run: worthless bytes, pruned before anything else. */
  status: RunStatus | undefined;
  dueAt: number;
  /** The user opened it (`seenAt`) — what makes a `needs-you` row prunable. */
  seen: boolean;
}

/**
 * What pruning may take, in order: results nobody needs to act on first (and unreadable
 * bytes), then the failures (their one line of history is worth less than room for the
 * next result) and the `needs-you` results the user has already OPENED (S5: fifty of them
 * nobody acted on must not silence the schedule forever). NEVER `pending` (a persisted
 * catch-up candidate the missed card reads), an UNSEEN `needs-you` (a result still
 * waiting on the user) or `running` (a live claim — the boot sweep retires a stale one to
 * `interrupted`, which IS prunable). A task's `ranThrough` is the dedupe record that
 * survives any of this (ADR-0074 §5).
 */
const PRUNE_TIERS: ReadonlyArray<(entry: EntryView) => boolean> = [
  ({ status }) => status === undefined || status === 'ok' || status === 'skipped',
  ({ status, seen }) => status === 'failed' || status === 'capped' || status === 'no-handler' || status === 'interrupted' || (status === 'needs-you' && seen),
];

/** Survives `clearScheduleHistory`: everything the user has not yet dealt with — a seen `needs-you` has been (S5). */
const keptOnClear = (run: ScheduleRun): boolean => run.status === 'pending' || run.status === 'running' || (run.status === 'needs-you' && run.seenAt === undefined);

const strictView = (run: ScheduleRun): EntryView => ({ status: run.status, dueAt: instant(run.dueAt), seen: run.seenAt !== undefined });

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

/**
 * The LOOSE view, for the entries already in a row when a run is written. The write path
 * validates what it ADDS and only ever REMOVES from what was there, so a row is written
 * back as it was read, minus its victims — nothing already stored is re-parsed. The
 * strict parse's credential walk is super-linear in token length (measured 2026-10-09:
 * ~0.3 ms for a 7 KiB run of prose, ~10 ms for one of long unbroken tokens), and
 * re-validating a 64 KiB history, let alone 2 MiB of them near the ceiling, on every
 * write is a cost a hub would pay for every run. The READ path (`readRuns`) still vouches
 * for every entry it hands out. An unreadable entry reads as status-less: the first to go.
 */
function looseView(entry: unknown): EntryView {
  if (typeof entry !== 'object' || entry === null) return { status: undefined, dueAt: Number.NEGATIVE_INFINITY, seen: false };
  const { status, dueAt, seenAt } = entry as { status?: unknown; dueAt?: unknown; seenAt?: unknown };
  const parsedDueAt = typeof dueAt === 'string' ? instant(dueAt) : Number.NaN;
  return {
    status: typeof status === 'string' && RUN_STATUS_SET.has(status) ? (status as RunStatus) : undefined,
    dueAt: Number.isNaN(parsedDueAt) ? Number.NEGATIVE_INFINITY : parsedDueAt,
    seen: typeof seenAt === 'string',
  };
}

/** A history row's elements as stored, unvalidated: absent → none; a non-array row → one worthless element. */
function looseEntries(raw: string | undefined): unknown[] {
  if (raw === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return Array.isArray(json) ? json : [json];
}

/** The `dueAt` string of a stored element, if it has one — the upsert key, compared as written. */
function dueAtOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { dueAt } = entry as { dueAt?: unknown };
  return typeof dueAt === 'string' ? dueAt : undefined;
}

/**
 * The OLDEST prunable entry (by `dueAt` — the run's identity instant, so a catch-up run
 * recorded late for an old occurrence is still the old one) across the given rows, tier
 * by tier; `keep` is the entry being written, which is never its own victim. Returns the
 * row and index, or `undefined` when nothing may go.
 */
function pruneVictim<T>(
  rows: ReadonlyMap<string, T[]>,
  view: (entry: T) => EntryView,
  keep: T,
): { taskId: string; index: number } | undefined {
  for (const prunable of PRUNE_TIERS) {
    let victim: { taskId: string; index: number; dueAt: number } | undefined;
    for (const [taskId, entries] of rows) {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined || entry === keep) continue;
        const seen = view(entry);
        if (!prunable(seen)) continue;
        if (victim === undefined || seen.dueAt < victim.dueAt) victim = { taskId, index, dueAt: seen.dueAt };
      }
    }
    if (victim !== undefined) return { taskId: victim.taskId, index: victim.index };
  }
  return undefined;
}

const bytesOf = (entries: ReadonlyArray<unknown>): number => utf8ByteLength(JSON.stringify(entries));

// --------------------------------------------------------------------- accessors

export function createScheduleAccessors(seams: ScheduleSeams): ScheduleAccessors {
  const { assertOpen } = seams;
  // Declared with an explicit `never` so control flow narrows past each call — a
  // destructured `seams.refuse` would not (TS narrows only on explicitly typed names).
  function invalid(message: string): never {
    return seams.refuse('SCHEDULE_INVALID', message);
  }
  function limit(message: string): never {
    return seams.refuse('SCHEDULE_LIMIT', message);
  }
  function notFound(message: string): never {
    return seams.refuse('NOT_FOUND', message);
  }

  /**
   * The read memo (M3, see the header): one entry per task — the exact bytes the parse was
   * made from and what they parsed to. A hit is a string compare; a miss re-parses that one
   * row; an absent row drops the entry. Answers are COPIES.
   */
  const parsedRuns = new Map<string, { raw: string; runs: ScheduleRun[] }>();
  function runsOf(taskId: string, raw: string | undefined): ScheduleRun[] {
    if (raw === undefined) {
      parsedRuns.delete(taskId);
      return [];
    }
    const hit = parsedRuns.get(taskId);
    if (hit !== undefined && hit.raw === raw) return hit.runs.slice();
    const { runs } = readRuns(raw, taskId);
    parsedRuns.set(taskId, { raw, runs });
    return runs.slice();
  }

  function taskRows(): Array<{ key: string; task: ScheduledTask | undefined }> {
    const out: Array<{ key: string; task: ScheduledTask | undefined }> = [];
    for (const [key, raw] of rowsUnder(seams, SCHEDULE_SETTING_PREFIX)) {
      // Parse the key rather than trusting the prefix test (the `listAppModels` rule): a
      // bare `schedule:` row is unreadable, never a task with the empty id.
      const taskId = taskIdFromScheduleSettingKey(key);
      out.push({ key, task: taskId === undefined ? undefined : readTask(raw, taskId) });
    }
    return out;
  }

  /** Write every changed history row; more than one row goes as one transaction so a cap error cannot half-apply. */
  function writeRunRows(rows: ReadonlyMap<string, unknown[]>): void {
    const transactional = rows.size > 1;
    if (transactional) seams.run('BEGIN');
    try {
      for (const [taskId, entries] of rows) {
        const key = scheduleRunsSettingKey(taskId);
        if (entries.length === 0) deleteKey(seams, key);
        else seams.setSetting(key, entries);
      }
      if (transactional) seams.run('COMMIT');
    } catch (err) {
      if (transactional) {
        try {
          seams.run('ROLLBACK');
        } catch {
          /* nothing to roll back */
        }
      }
      throw err;
    }
  }

  return {
    listScheduledTasks() {
      assertOpen();
      return taskRows().flatMap(({ task }) => (task === undefined ? [] : [task]));
    },

    listUnreadableScheduleKeys() {
      assertOpen();
      return taskRows().flatMap(({ key, task }) => (task === undefined ? [key] : []));
    },

    getScheduledTask(taskId) {
      assertOpen();
      return readTask(rawValue(seams, scheduleSettingKey(taskId)), taskId);
    },

    putScheduledTask(task) {
      assertOpen();
      const parsed = scheduledTaskSchema.safeParse(task);
      if (!parsed.success) invalid(`scheduled task failed validation: ${issuesOf(parsed.error)}`);
      const key = scheduleSettingKey(parsed.data.id);
      // The cap counts OTHER rows — readable or not, a row holds a seat — so an edit of an
      // existing task at the cap still lands and a 201st does not.
      const others = Number(
        seams.select(`SELECT COUNT(*) FROM ${SETTINGS} WHERE ${PREFIX_WHERE} AND key <> ?`, [
          likePrefix(SCHEDULE_SETTING_PREFIX),
          key,
        ])[0]?.[0] ?? 0,
      );
      if (others >= SCHEDULE_MAX_TASKS) limit(`the file already holds ${SCHEDULE_MAX_TASKS} scheduled tasks`);
      seams.setSetting(key, parsed.data);
    },

    deleteScheduledTask(taskId) {
      assertOpen();
      deleteKey(seams, scheduleSettingKey(taskId));
      deleteKey(seams, scheduleRunsSettingKey(taskId));
      parsedRuns.delete(taskId);
    },

    listScheduleRuns(taskId) {
      assertOpen();
      return runsOf(taskId, rawValue(seams, scheduleRunsSettingKey(taskId)));
    },

    listAllScheduleRuns() {
      assertOpen();
      const out: Record<string, ScheduleRun[]> = {};
      const present = new Set<string>();
      for (const [key, raw] of rowsUnder(seams, SCHEDULE_RUNS_SETTING_PREFIX)) {
        const taskId = taskIdFromScheduleRunsSettingKey(key);
        if (taskId === undefined) continue;
        present.add(taskId);
        out[taskId] = runsOf(taskId, raw);
      }
      // The memo holds nothing a row no longer backs: bounded to the rows that exist.
      for (const taskId of parsedRuns.keys()) if (!present.has(taskId)) parsedRuns.delete(taskId);
      return out;
    },

    putScheduleRun(run) {
      assertOpen();
      const parsed = scheduleRunSchema.safeParse(run);
      if (!parsed.success) invalid(`schedule run failed validation: ${issuesOf(parsed.error)}`);
      const next = parsed.data;
      // A history row for a task the file does not hold would be an orphan no task can
      // reach — the shape a finalise landing AFTER the user deleted the task would leave.
      if (rawValue(seams, scheduleSettingKey(next.taskId)) === undefined) {
        notFound(`no scheduled task "${next.taskId}" for this run`);
      }
      const key = scheduleRunsSettingKey(next.taskId);
      const entries = looseEntries(rawValue(seams, key));
      // The upsert: the same (taskId, dueAt) is the same occurrence — a claim becoming its
      // result — and replaces in place; a new occurrence lands at the front.
      const existing = entries.findIndex((entry) => dueAtOf(entry) === next.dueAt);
      if (existing === -1) entries.unshift(next);
      else entries[existing] = next;
      const view = (entry: unknown): EntryView => (entry === next ? strictView(next) : looseView(entry));

      // The per-task caps: entries, then bytes.
      const own = new Map<string, unknown[]>([[next.taskId, entries]]);
      while (entries.length > SCHEDULE_RUNS_MAX_ENTRIES || bytesOf(entries) > SCHEDULE_RUNS_MAX_BYTES) {
        const victim = pruneVictim(own, view, next);
        if (victim === undefined) {
          limit(
            `the run history of task "${next.taskId}" is full of rows waiting on the user (${SCHEDULE_RUNS_MAX_ENTRIES} entries / ${SCHEDULE_RUNS_MAX_BYTES} bytes)`,
          );
        }
        entries.splice(victim.index, 1);
      }

      // The ceiling across every task. The common path is one SUM over the other rows'
      // stored bytes; only when it is crossed are the other histories read (loosely, like
      // this one) and pruned, globally oldest first; only the rows that changed are
      // rewritten, each as it was read minus its victims.
      const changed = new Map<string, unknown[]>(own);
      const othersStored = Number(
        seams.select(
          `SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) FROM ${SETTINGS} WHERE ${PREFIX_WHERE} AND key <> ?`,
          [likePrefix(SCHEDULE_RUNS_SETTING_PREFIX), key],
        )[0]?.[0] ?? 0,
      );
      if (bytesOf(entries) + othersStored > SCHEDULE_RUNS_TOTAL_MAX_BYTES) {
        const all = new Map<string, unknown[]>(own);
        for (const [otherKey, raw] of rowsUnder(seams, SCHEDULE_RUNS_SETTING_PREFIX)) {
          const taskId = taskIdFromScheduleRunsSettingKey(otherKey);
          if (taskId === undefined || taskId === next.taskId) continue;
          all.set(taskId, looseEntries(raw));
        }
        let total = 0;
        for (const list of all.values()) total += bytesOf(list);
        while (total > SCHEDULE_RUNS_TOTAL_MAX_BYTES) {
          const victim = pruneVictim(all, view, next);
          if (victim === undefined) {
            limit(`every task's run history is full of rows waiting on the user (${SCHEDULE_RUNS_TOTAL_MAX_BYTES} bytes across tasks)`);
          }
          const list = all.get(victim.taskId);
          if (list === undefined) break;
          const before = bytesOf(list);
          list.splice(victim.index, 1);
          total -= before - bytesOf(list);
          changed.set(victim.taskId, list);
        }
      }
      writeRunRows(changed);
    },

    markScheduleRunSeen(taskId, dueAt, seenAt) {
      assertOpen();
      const key = scheduleRunsSettingKey(taskId);
      const raw = rawValue(seams, key);
      if (raw === undefined) return;
      const runs = runsOf(taskId, raw);
      const at = runs.findIndex((entry) => entry.dueAt === dueAt);
      if (at === -1) return;
      const stamped = scheduleRunSchema.safeParse({ ...runs[at], seenAt });
      if (!stamped.success) invalid(`seenAt failed validation: ${issuesOf(stamped.error)}`);
      runs[at] = stamped.data;
      seams.setSetting(key, runs);
    },

    clearScheduleHistory(taskId) {
      assertOpen();
      const targets =
        taskId === undefined
          ? rowsUnder(seams, SCHEDULE_RUNS_SETTING_PREFIX).flatMap(([key, raw]) => {
              const id = taskIdFromScheduleRunsSettingKey(key);
              return id === undefined ? [] : [{ key, taskId: id, raw }];
            })
          : [{ key: scheduleRunsSettingKey(taskId), taskId, raw: rawValue(seams, scheduleRunsSettingKey(taskId)) }];
      for (const target of targets) {
        if (target.raw === undefined) continue;
        const kept = runsOf(target.taskId, target.raw).filter(keptOnClear);
        if (kept.length === 0) deleteKey(seams, target.key);
        else seams.setSetting(target.key, kept);
      }
    },

    getSchedulerState() {
      assertOpen();
      return parseSchedulerState(rawValue(seams, SCHEDULER_STATE_SETTING_KEY));
    },

    setSchedulerState(state) {
      assertOpen();
      const parsed = schedulerStateSchema.safeParse(state);
      if (!parsed.success) invalid(`scheduler state failed validation: ${issuesOf(parsed.error)}`);
      seams.setSetting(SCHEDULER_STATE_SETTING_KEY, parsed.data);
    },

    listScheduleDeclines(appId) {
      assertOpen();
      const prefix = scheduleDeclinedSettingPrefixFor(appId);
      return rowsUnder(seams, prefix)
        .map(([key]) => key.slice(prefix.length))
        .filter((hash) => hash.length > 0)
        .sort();
    },

    addScheduleDecline(appId, hash) {
      assertOpen();
      seams.setSetting(scheduleDeclinedSettingKey(appId, hash), true);
    },

    isScheduleMuted(appId) {
      assertOpen();
      const raw = rawValue(seams, scheduleMutedSettingKey(appId));
      if (raw === undefined) return false;
      try {
        return JSON.parse(raw) === true;
      } catch {
        return false;
      }
    },

    setScheduleMuted(appId, muted) {
      assertOpen();
      const key = scheduleMutedSettingKey(appId);
      // Clearing DELETES — absence is what "not muted" means.
      if (!muted) deleteKey(seams, key);
      else seams.setSetting(key, true);
    },
  };
}

// ------------------------------------------------------------- deleteApp (C3)

const namesApp = (step: ScheduleStep, appId: string): boolean => step.kind !== 'notify' && step.appId === appId;

/**
 * The cascade's share of the scheduler's rows, run INSIDE `deleteApp`'s transaction:
 *  - a task whose EVERY step names the app goes with its runs row — there is nothing left
 *    of it to run; a task that names another app too (or carries a reminder) is left
 *    byte-identical, and the engine marks the dead step's RESULT `appMissing` at run
 *    time from the missing app, so no task row is rewritten behind the user's back;
 *  - a task row that does not parse is left alone: the cascade cannot know whose it is;
 *  - the app's `scheduleDeclined:<appId>:*` rows by escaped prefix and its
 *    `scheduleMuted:<appId>` row by equality — the per-app-row-in-a-shared-namespace
 *    obligation (`appModel:`, `starterVersion:`, …): a missed key silently applies to a
 *    REUSED app id. Known limit, as for the `auth:` prefix: an app id containing a literal
 *    colon would over-match a sibling sharing that prefix — unreachable with UUID ids.
 */
export function sweepSchedulesForDeletedApp(sql: SettingsSql, appId: string): void {
  for (const [key, raw] of rowsUnder(sql, SCHEDULE_SETTING_PREFIX)) {
    const taskId = taskIdFromScheduleSettingKey(key);
    if (taskId === undefined) continue;
    const task = readTask(raw, taskId);
    if (task === undefined || !task.steps.every((step) => namesApp(step, appId))) continue;
    deleteKey(sql, key);
    deleteKey(sql, scheduleRunsSettingKey(taskId));
  }
  sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(scheduleDeclinedSettingPrefixFor(appId))]);
  deleteKey(sql, scheduleMutedSettingKey(appId));
}

// --------------------------------------------------------- import / export (C4)

/**
 * A `running` or `pending` entry older than this at import is `interrupted`: no host is
 * still executing a claim from a file that has been to disk and back, and a day-old
 * catch-up candidate from another device is not this device's to offer.
 */
export const SCHEDULE_IMPORTED_CLAIM_MAX_AGE_MS = 24 * 3_600_000;

/** What `importUserDb` snapshots from the OPEN handle before the candidate goes live. */
export interface LocalScheduleSnapshot {
  /** taskId → `canonicalScheduleIntent` bytes of every readable local task (M4: the intent, not the bookkeeping). */
  tasks: Map<string, string>;
  watermark: string | undefined;
}

export function snapshotLocalSchedules(sql: SettingsSql): LocalScheduleSnapshot {
  const tasks = new Map<string, string>();
  for (const [key, raw] of rowsUnder(sql, SCHEDULE_SETTING_PREFIX)) {
    const taskId = taskIdFromScheduleSettingKey(key);
    const task = taskId === undefined ? undefined : readTask(raw, taskId);
    if (task !== undefined) tasks.set(task.id, canonicalScheduleIntent(task));
  }
  return { tasks, watermark: parseSchedulerState(rawValue(sql, SCHEDULER_STATE_SETTING_KEY))?.watermark };
}

/**
 * The run-history pass shared by import and export (ADR-0074 §6: "proposals are stripped
 * from run rows on every import, pull and export"). For every `scheduleRuns:` row:
 *  - `proposals` LEAVES every entry — a pending data change is this device's own
 *    dry-run against its own scratch copy, and a foreign file must never be able to
 *    plant an approval card (security F1), so the bytes never cross the file boundary in
 *    either direction;
 *  - with `importedAt` (import only, both paths — S1/S7): an entry whose `dueAt` is AFTER
 *    that instant is DROPPED (nothing can have run for a time that has not come; a planted
 *    one would dedupe the real occurrence and, as `pending`, sit on the missed card), and a
 *    `running`/`pending` claim started or due more than a day before it, or after it, is
 *    `interrupted` with reason `imported`;
 *  - an entry that does not parse is DROPPED: an entry the strict schema refuses cannot be
 *    shown to carry no proposal, and a non-array row is removed for the same reason.
 * Only rows that changed are rewritten, so a trusted pull keeps clean bytes stable.
 * Returns how many proposals were stripped.
 */
export function scrubScheduleRunRows(sql: SettingsSql, opts: { importedAt?: string } = {}): number {
  let stripped = 0;
  const importedAt = opts.importedAt === undefined ? undefined : instant(opts.importedAt);
  const oldest = importedAt === undefined ? undefined : importedAt - SCHEDULE_IMPORTED_CLAIM_MAX_AGE_MS;
  for (const [key, raw] of rowsUnder(sql, SCHEDULE_RUNS_SETTING_PREFIX)) {
    const taskId = taskIdFromScheduleRunsSettingKey(key);
    if (taskId === undefined) {
      deleteKey(sql, key);
      continue;
    }
    const { runs, unreadable } = readRuns(raw, taskId);
    let changed = unreadable > 0;
    const kept: ScheduleRun[] = [];
    for (const run of runs) {
      let next = run;
      if (importedAt !== undefined && instant(next.dueAt) > importedAt) {
        changed = true;
        continue;
      }
      if (next.proposals !== undefined) {
        const { proposals: _proposals, ...rest } = next;
        next = rest;
        stripped += 1;
        changed = true;
      }
      if (importedAt !== undefined && oldest !== undefined && (next.status === 'running' || next.status === 'pending')) {
        const since = instant(next.status === 'running' ? (next.startedAt ?? next.dueAt) : next.dueAt);
        if (since < oldest || since > importedAt) {
          next = { ...next, status: 'interrupted', reason: 'imported' };
          changed = true;
        }
      }
      kept.push(next);
    }
    if (!changed) continue;
    if (kept.length === 0) deleteKey(sql, key);
    else writeRaw(sql, key, kept);
  }
  return stripped;
}

/** The entries a demoted task may not keep (S1): a candidate the missed card would run, a result with a *run now* on it. */
const ARMED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['pending', 'needs-you']);

/** Drop a demoted task's `pending` and `needs-you` entries from its history row (S1); the rest of the row stays as it was read. */
function disarmHistory(sql: SettingsSql, taskId: string): void {
  const key = scheduleRunsSettingKey(taskId);
  const raw = rawValue(sql, key);
  if (raw === undefined) return;
  const { runs, unreadable } = readRuns(raw, taskId);
  const kept = runs.filter((run) => !ARMED_STATUSES.has(run.status));
  if (kept.length === runs.length && unreadable === 0) return;
  if (kept.length === 0) deleteKey(sql, key);
  else writeRaw(sql, key, kept);
}

/** True when any history row could carry a proposal — the export's cheap test before it bothers with a copy. */
export function hasScheduleRunProposals(sql: SettingsSql): boolean {
  return (
    sql.select(`SELECT 1 FROM ${SETTINGS} WHERE ${PREFIX_WHERE} AND value LIKE '%"proposals"%' LIMIT 1`, [
      likePrefix(SCHEDULE_RUNS_SETTING_PREFIX),
    ]).length > 0
  );
}

/**
 * The import reconciliation for the scheduler's rows (ADR-0074 §2), run on the CANDIDATE
 * at the slot `reconcileImportedConnections` occupies — before it goes live, so every
 * path (UI import, sync pull-merge, applyRemote, recovery restore) inherits it.
 *
 * ON EVERY IMPORT the histories are scrubbed (`scrubScheduleRunRows` above).
 *
 * UNTRUSTED (`trustedOrigin` false — a file the user picked off disk, however empty the
 * hub; R-M2): a task is executable intent, so the same doctrine as connections and
 * runtime contracts applies. A task whose canonical INTENT bytes (`canonicalScheduleIntent`
 * — M4: never `ranThrough`, `updatedAt` or a counter, which every run moves) equal the
 * local task of the same id is left alone (a backup round trip must not disarm the user);
 * every other task lands `enabled:false, provenance:'imported'` with the rest of it intact
 * and readable, for the user to review and re-enable — the ONE consent surface (§4) — and
 * its `pending` and `needs-you` entries go (S1: a demoted task must have nothing the missed
 * card or a *run now* could fire). A `ranThrough` in the future is clamped to NOW on every
 * untrusted task (S1: a planted record must not hold a schedule silent). A task row that
 * does not parse is removed: it cannot be demoted, and a later, more lenient reader must
 * not find it armed. The watermark becomes NOW (a foreign past must not turn into a
 * catch-up storm; `globalPause` is kept, the daily counters are zeroed), written only when
 * the file carries scheduling rows at all, so an old backup imports exactly as before.
 * Declines and mutes are dropped: they are the user's own answers to THEIR apps'
 * suggestions, not something a file carries in.
 *
 * TRUSTED (the user's own configured origin — the sync pull and the recovery restore):
 * tasks stay as they are, unreadable rows included; the watermark is max(local,
 * imported) so a pull never rewinds a device behind the runs it already recorded.
 */
export function reconcileImportedSchedules(
  sql: SettingsSql,
  localTasks: ReadonlyMap<string, string>,
  localWatermark: string | undefined,
  trustedOrigin: boolean,
  now: string = new Date().toISOString(),
): { demotedTasks: number; strippedProposals: number } {
  const strippedProposals = scrubScheduleRunRows(sql, { importedAt: now });

  let demotedTasks = 0;
  let sawScheduleRows = false;
  for (const [key, raw] of rowsUnder(sql, SCHEDULE_SETTING_PREFIX)) {
    sawScheduleRows = true;
    if (trustedOrigin) continue;
    const taskId = taskIdFromScheduleSettingKey(key);
    const task = taskId === undefined ? undefined : readTask(raw, taskId);
    if (task === undefined) {
      deleteKey(sql, key);
      continue;
    }
    const clamped = task.ranThrough !== undefined && instant(task.ranThrough) > instant(now) ? { ...task, ranThrough: now } : task;
    if (localTasks.get(task.id) === canonicalScheduleIntent(task)) {
      if (clamped !== task) writeRaw(sql, key, clamped);
      continue;
    }
    const demoted = scheduledTaskSchema.safeParse({ ...clamped, enabled: false, provenance: 'imported' });
    // Only the whole-object byte cap can refuse here (a longer provenance word on a task
    // sitting exactly at it); such a row cannot be made safe, so it goes.
    if (!demoted.success) {
      deleteKey(sql, key);
      deleteKey(sql, scheduleRunsSettingKey(task.id));
    } else {
      writeRaw(sql, key, demoted.data);
      disarmHistory(sql, task.id);
    }
    demotedTasks += 1;
  }

  const stateRaw = rawValue(sql, SCHEDULER_STATE_SETTING_KEY);
  const imported = parseSchedulerState(stateRaw);
  if (trustedOrigin) {
    if (imported !== undefined) {
      const watermark =
        localWatermark !== undefined && instant(localWatermark) > instant(imported.watermark) ? localWatermark : imported.watermark;
      if (watermark !== imported.watermark) writeRaw(sql, SCHEDULER_STATE_SETTING_KEY, { ...imported, watermark });
    } else if (localWatermark !== undefined) {
      writeRaw(sql, SCHEDULER_STATE_SETTING_KEY, {
        watermark: localWatermark,
        globalPause: false,
        daily: { date: now.slice(0, 10), ai: 0, net: 0 },
      });
    }
  } else if (stateRaw !== undefined || sawScheduleRows) {
    writeRaw(sql, SCHEDULER_STATE_SETTING_KEY, {
      watermark: now,
      globalPause: imported?.globalPause ?? false,
      daily: { date: now.slice(0, 10), ai: 0, net: 0 },
    });
  }

  if (!trustedOrigin) {
    sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(SCHEDULE_DECLINED_SETTING_PREFIX)]);
    sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(SCHEDULE_MUTED_SETTING_PREFIX)]);
  }

  return { demotedTasks, strippedProposals };
}
