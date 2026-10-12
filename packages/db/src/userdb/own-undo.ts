// own-undo.ts — the storage of the OWN undo journal (TASK-20261010-host-broker PR-4, contract v2
// D-PR4-3; ADR-0076 §9): typed accessors over the `ownUndo:<appId>:<bucket>` settings rows, the
// sweeps `deleteApp` and `deleteScheduledTask` run, the untrusted import's drop, and the liveness
// read `clearScheduleHistory` keeps a run by.
//
// WHAT IT HOLDS. An own write — the user's approval of a change to an app's own data, or an armed
// schedule's change to its own app's data — goes through the Write Broker's capture seat, and the
// rows it touched are journaled here as `ownUndoEntrySchema` entries so the user can put them back
// for seven days. ONE JSON array row per BUCKET, newest first: `ownUndo:<appId>:<taskId>` for each
// armed schedule and `ownUndo:<appId>:approval` for the user's own approvals. The two buckets
// differ in the one way that matters:
//
//  - A TASK bucket REFUSES, never evicts: past `OWN_UNDO_MAX_LIVE` live entries, or past
//    `OWN_UNDO_ROW_MAX_BYTES` once its undone entries have given way, a put answers `'full'` and
//    writes nothing — a schedule must not erase an undo the user may still want, so the engine
//    checks `ownUndoRoom` BEFORE the seat and holds the change (`full`) instead.
//  - The APPROVAL bucket NEVER refuses: the user was present for each change, so its oldest live
//    entry gives way — on the count rule its oldest live entry, on the bytes rule its undone
//    entries first and then its oldest live ones.
//
// The postures are the access journal's (`access.ts`): WRITES FAIL CLOSED — a put parses strictly
// first (the schema's 64 KiB cap and per-cell credential walk included; ACCESS_INVALID leaves the
// file byte-identical) and is rebuilt from the STRICT read, so an element the strict parse refuses
// can neither hold a seat nor crowd the row; every put drops the expired. READS FAIL OPEN — a row or
// an element that does not parse is skipped, never thrown. An undone entry is kept, marked, until it
// expires, and never offered again. "Oldest" is by `at`, and among equal instants the one further
// back in the row (the row is newest first).
//
// EVERY ENTRY IN ITS OWN BUCKET (PR-4 Gate 5, A1). `ownUndoBelongsIn` is the one rule — an approval
// (no task) in `approval`, a schedule's change in the bucket its task id names, and never a task's in
// `approval` (a task whose id spells it included) — and it is asked everywhere a bucket is touched:
// the put refuses an entry outside it, every read leaves out an element outside it (so a planted
// one is never listed, never counted as live and never kept on the next put), and the engine asks
// it FIRST, before any seat, so a change is never made into a bucket that would then refuse its undo.
//
// HOMED BESIDE userdb.ts, like `schedules.ts` and `access.ts`: the seams are injected because
// userdb.ts imports this module; the sweeps and the import pass take a bare `SettingsSql`.

import {
  ACCESS_UNDO_MAX_BYTES,
  APPROVAL_WRITE_AUTHORITY,
  OWN_UNDO_MAX_LIVE,
  OWN_UNDO_ROW_MAX_BYTES,
  TASK_WRITE_AUTHORITY,
  USERDB_TABLES,
  ownUndoEntrySchema,
  utf8ByteLength,
  type OwnUndoEntry,
  type OwnWriteAuthority,
} from '@snugprotocol/protocol';
import { OWN_UNDO_APPROVAL_BUCKET, OWN_UNDO_SETTING_PREFIX, ownUndoKey, ownUndoPrefixFor } from './app-settings-keys.js';
import type { SettingsSql } from './schedules.js';
import type { UserDb } from './userdb.js';

// ------------------------------------------------------------------------- seams

/** The `USERDB_ERROR_CODES` keys an accessor may throw — mapped to the real code by the factory. */
export type OwnUndoRefusal = 'ACCESS_INVALID' | 'ACCESS_LIMIT' | 'NOT_FOUND';

/** What the factory lends the accessors — the access accessors' seams. */
export interface OwnUndoSeams extends SettingsSql {
  assertOpen(): void;
  /** `kvSet` on the settings table — carries `guardAddedBytes`. */
  setSetting(key: string, value: unknown): void;
  /** Throws the factory's `UserDbError` with the named code. */
  refuse(code: OwnUndoRefusal, message: string): never;
  /** True when the file holds this app row — a journal never names an app the file does not hold. */
  hasApp(appId: string): boolean;
  /** Epoch milliseconds — expiry is measured against it. */
  now(): number;
}

export type OwnUndoAccessors = Pick<UserDb, 'listOwnUndo' | 'putOwnUndo' | 'markOwnUndone' | 'ownUndoRoom'>;

/** Which bucket a listing reads: a schedule's (by its task id) or the user's approvals. */
export type OwnUndoListing = { taskId: string } | { bucket: typeof OWN_UNDO_APPROVAL_BUCKET };

// ------------------------------------------------------------------- the bucket rule

/**
 * Whether an entry with this authority and task belongs in `bucket` (PR-4 Gate 5, A1): the user's
 * approval — no task — in `approval`; a schedule's change in the bucket its own task id names, which
 * is never `approval`. The put, every read and the engine's seat ask this one rule.
 */
export function ownUndoBelongsIn(bucket: string, entry: { readonly authority: OwnWriteAuthority; readonly taskId?: string | undefined }): boolean {
  if (bucket === OWN_UNDO_APPROVAL_BUCKET) return entry.authority === APPROVAL_WRITE_AUTHORITY && entry.taskId === undefined;
  return entry.authority === TASK_WRITE_AUTHORITY && entry.taskId === bucket;
}

// ----------------------------------------------------------------------- helpers

const SETTINGS = USERDB_TABLES.settings;
/** The escaped-prefix LIKE pattern the other sweeps use — `!`, `%`, `_` are literal. */
const likePrefix = (prefix: string): string => `${prefix.replace(/([!%_])/g, '!$1')}%`;
const PREFIX_WHERE = `key LIKE ? ESCAPE '!'`;
/** Instants compare by value, not by text: the schema admits `…:00Z` beside `…:00.000Z`. */
const instant = (iso: string): number => Date.parse(iso);
const isoInstantSchema = ownUndoEntrySchema.shape.at;
const bytesOf = (entries: ReadonlyArray<unknown>): number => utf8ByteLength(JSON.stringify(entries));

function rawValue(sql: SettingsSql, key: string): string | undefined {
  const raw = sql.select(`SELECT value FROM ${SETTINGS} WHERE key = ?`, [key])[0]?.[0];
  return raw === undefined || raw === null ? undefined : String(raw);
}

function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
}

/** A row's elements as stored, unvalidated: absent → none; a non-array row → none (it holds nothing readable). */
function looseEntries(raw: string | undefined): unknown[] {
  if (raw === undefined) return [];
  try {
    const json: unknown = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

/** The STRICT read of one bucket: every element the own-undo schema accepts AND that belongs in it (A1), in row order (newest first). */
function readOwnUndo(raw: string | undefined, bucket: string): OwnUndoEntry[] {
  const entries: OwnUndoEntry[] = [];
  for (const item of looseEntries(raw)) {
    const parsed = ownUndoEntrySchema.safeParse(item);
    if (parsed.success && ownUndoBelongsIn(bucket, parsed.data)) entries.push(parsed.data);
  }
  return entries;
}

const isExpired = (entry: OwnUndoEntry, now: number): boolean => instant(entry.expiresAt) <= now;
/** LIVE: not undone and not expired — what `listOwnUndo` answers and what the count rule counts. */
const isLive = (entry: OwnUndoEntry, now: number): boolean => entry.undoneAt === undefined && !isExpired(entry, now);

/** The index of the OLDEST entry `pick` admits — by `at`, ties to the one further back in the newest-first row — or -1. */
function oldestWhere(entries: readonly OwnUndoEntry[], pick: (entry: OwnUndoEntry) => boolean): number {
  let victim = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || !pick(entry)) continue;
    const oldest = victim === -1 ? undefined : entries[victim];
    if (oldest === undefined || instant(entry.at) < instant(oldest.at)) victim = index;
  }
  return victim;
}

/** What a bucket keeps when it is next written: its readable entries, in it by the bucket rule, that have not expired. */
const keptIn = (sql: SettingsSql, appId: string, bucket: string, now: number): OwnUndoEntry[] =>
  readOwnUndo(rawValue(sql, ownUndoKey(appId, bucket)), bucket).filter((entry) => !isExpired(entry, now));

/** Room for one more FULL entry beside the live ones: the separating comma and the schema's whole-entry cap. */
const roomForOneMore = (live: readonly OwnUndoEntry[]): boolean => (live.length === 0 ? 2 : bytesOf(live) + 1) + ACCESS_UNDO_MAX_BYTES <= OWN_UNDO_ROW_MAX_BYTES;

// --------------------------------------------------------------------- accessors

export function createOwnUndoAccessors(seams: OwnUndoSeams): OwnUndoAccessors {
  const { assertOpen } = seams;
  // Declared with an explicit `never` so control flow narrows past each call (the schedules.ts note).
  function invalid(message: string): never {
    return seams.refuse('ACCESS_INVALID', message);
  }
  function limit(message: string): never {
    return seams.refuse('ACCESS_LIMIT', message);
  }
  function notFound(message: string): never {
    return seams.refuse('NOT_FOUND', message);
  }

  return {
    listOwnUndo(appId, which, options = {}) {
      assertOpen();
      const bucket = 'taskId' in which ? which.taskId : which.bucket;
      if (appId.length === 0 || bucket.length === 0) return [];
      const now = seams.now();
      // An undone entry is kept, marked, until it expires: listed only when asked for — a page saying *undone* after a reload (A12).
      const shown = options.includeUndone === true ? (entry: OwnUndoEntry): boolean => !isExpired(entry, now) : (entry: OwnUndoEntry): boolean => isLive(entry, now);
      return keptIn(seams, appId, bucket, now).filter(shown);
    },

    putOwnUndo(appId, bucket, entry) {
      assertOpen();
      const parsed = ownUndoEntrySchema.safeParse(entry);
      if (!parsed.success) invalid(`own undo entry failed validation: ${issuesOf(parsed.error)}`);
      const approval = bucket === OWN_UNDO_APPROVAL_BUCKET;
      // An entry goes to its own bucket only (A1) — so a schedule's entry can never ride the bucket
      // that never refuses (a task whose id spells `approval` included).
      if (!ownUndoBelongsIn(bucket, parsed.data)) invalid(`an own undo entry belongs in its own bucket, not "${bucket}"`);
      if (!seams.hasApp(appId)) notFound(`no app "${appId}" to keep this journal`);
      const key = ownUndoKey(appId, bucket);
      const now = seams.now();
      // Rebuilt from the STRICT read: the expired, the unreadable and the out-of-bucket are dropped; an undone entry stays, marked.
      const kept = keptIn(seams, appId, bucket, now);
      // The count rule: a schedule's bucket refuses; the user's approvals give their oldest live entry way.
      while (kept.filter((other) => isLive(other, now)).length >= OWN_UNDO_MAX_LIVE) {
        if (!approval) return 'full';
        kept.splice(oldestWhere(kept, (other) => isLive(other, now)), 1);
      }
      // The bytes rule: undone entries give way first; then the approval bucket's oldest live entry, while a schedule's refuses.
      const row = (): unknown[] => [parsed.data, ...kept];
      while (bytesOf(row()) > OWN_UNDO_ROW_MAX_BYTES) {
        let victim = oldestWhere(kept, (other) => other.undoneAt !== undefined);
        if (victim === -1) {
          if (!approval) return 'full';
          victim = oldestWhere(kept, () => true);
        }
        // Unreachable while an entry is capped at a quarter of the row; the belt keeps the loop finite.
        if (victim === -1) limit(`one own undo entry cannot fit the ${OWN_UNDO_ROW_MAX_BYTES}-byte row of "${appId}"`);
        kept.splice(victim, 1);
      }
      seams.setSetting(key, row());
      return 'ok';
    },

    markOwnUndone(appId, bucket, id, at) {
      assertOpen();
      const stamp = isoInstantSchema.safeParse(at);
      if (!stamp.success) invalid(`undo instant failed validation: ${issuesOf(stamp.error)}`);
      const key = ownUndoKey(appId, bucket);
      const raw = rawValue(seams, key);
      if (raw === undefined) return;
      // It marks what it finds (the access journal's rule): the element is located loosely, by its id.
      const entries = looseEntries(raw);
      const index = entries.findIndex((item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === id);
      if (index === -1) return; // an unknown id is a no-op
      entries[index] = { ...(entries[index] as Record<string, unknown>), undoneAt: stamp.data };
      seams.setSetting(key, entries);
    },

    ownUndoRoom(appId, bucket) {
      assertOpen();
      // The approval bucket never refuses a put, so it always has room.
      if (bucket === OWN_UNDO_APPROVAL_BUCKET) return true;
      const now = seams.now();
      const live = keptIn(seams, appId, bucket, now).filter((entry) => isLive(entry, now));
      return live.length < OWN_UNDO_MAX_LIVE && roomForOneMore(live);
    },
  };
}

// ------------------------------------------------------------- liveness (clearScheduleHistory)

/**
 * The ids of a bucket's LIVE entries, read from a bare handle — what `clearScheduleHistory` keeps
 * a run by when its `applied` group or an `approved` entry can still be undone (D-PR4-18).
 */
export function liveOwnUndoIds(sql: SettingsSql, appId: string, bucket: string, now: number): ReadonlySet<string> {
  if (appId.length === 0 || bucket.length === 0) return new Set();
  return new Set(
    keptIn(sql, appId, bucket, now)
      .filter((entry) => isLive(entry, now))
      .map((entry) => entry.id),
  );
}

// ------------------------------------------------------------------- the sweeps

/** `deleteApp`'s share, INSIDE its transaction: every bucket of the app, by escaped prefix — nothing is left to put back. */
export function sweepOwnUndoForDeletedApp(sql: SettingsSql, appId: string): void {
  sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(ownUndoPrefixFor(appId))]);
}

/**
 * `deleteScheduledTask`'s share: the task's bucket under EVERY app the file holds, by equality — a
 * schedule's steps may have named another app when it was armed. Never the approval bucket, even
 * for a task whose id spells it: the user's own approvals are not the schedule's to take.
 */
export function sweepOwnUndoForDeletedTask(sql: SettingsSql, taskId: string): void {
  if (taskId.length === 0 || taskId === OWN_UNDO_APPROVAL_BUCKET) return;
  for (const row of sql.select(`SELECT app_id FROM ${USERDB_TABLES.apps}`)) {
    const appId = String(row[0] ?? '');
    if (appId.length > 0) sql.run(`DELETE FROM ${SETTINGS} WHERE key = ?`, [ownUndoKey(appId, taskId)]);
  }
}

// ------------------------------------------------------------------------- import

/**
 * An UNTRUSTED import drops the whole namespace: a journal names rows to write back into an app,
 * and a foreign file must never plant an undo the user did not make (the access journal's rule).
 * A trusted pull keeps it — the user's own device state.
 */
export function dropImportedOwnUndo(sql: SettingsSql): void {
  sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(OWN_UNDO_SETTING_PREFIX)]);
}
