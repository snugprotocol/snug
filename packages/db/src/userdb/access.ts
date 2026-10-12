// access.ts — the storage of access between apps (TASK-20261010-cross-app-access AC8–AC10,
// ADR-0075 §2, §4, §7, §9): typed accessors over the `access*` settings rows, the `deleteApp`
// sweep, and the import pass. The `schedules.ts` shape, for the same reasons.
//
// THE FILE IS THE RECORD. A grant, a source's history, a reader's declines and its mute are
// namespaced `snug_settings` rows (spec 1.1 §8.1's carve-out — no new table, no v7), so they
// travel with the file: into a backup, over a sync origin, through a hand edit. A grant is
// AUTHORITY — what parses later lets one app read another's tables — so two postures:
//
//  - WRITES FAIL CLOSED. Every accessor parses through `@snugprotocol/protocol`'s strict
//    schemas BEFORE touching a row, so a refused write leaves the file byte-identical. The
//    caps — 100 LIVE grants, 200 entries / 64 KiB per source's history, 1 MiB across every
//    history — are enforced here by refusing or pruning, never by trusting the caller.
//  - READS FAIL OPEN. A row that does not parse reads as "no such grant" (and an untrusted
//    import removes it), never a throw: one corrupted row must not stop every other grant.
//
// THE HISTORY CANNOT BE MADE TO LIE (ADR-0075 §7). Pruning takes unreadable bytes first,
// then `read` entries (oldest first), then other entries — and NEVER the most recent
// `granted`, `revoked`, `suspended` or `released` entry of a grant THE FILE HOLDS (per grant
// AND per kind: a later revocation must not cost the record of when access began). The
// latest entries of a grant the file no longer holds — a session grant (never stored; a fresh
// id per allow) or an ended grant pruned after 30 days — are the LAST tier, oldest first,
// taken only when nothing else may go: protecting them forever would fill a source's history
// with entries nothing can take, and every later `read` would be refused for good (review
// finding 1; the stricter reading of §7's "per grant" is "per grant the file holds"). Consecutive reads
// coalesce within a minute of the coalesced entry's first read on an identical `(grantId, sql)`
// — or, for two reads that carry NO statement (the chat and scheduler doors' lines,
// TASK-20261010-host-broker PR-2 D-PR2-7), on identical `(grantId, readerAppId, attended,
// tables)` — never a statement against none, a different statement, another grant or reader,
// an attended/away change, an imported line, or across an intervening entry.
//
// THE UNDO JOURNAL (TASK-20261010-host-broker PR-3, D-PR3-7; spec 1.2 §22.4). `accessUndo:
// <targetAppId>` is ONE JSON array row per TARGET app, newest first, of `accessUndoEntrySchema`
// entries — the ROWS each brokered write changed, never statement text; an undo is built from
// the structure at undo time. The same two postures: a put parses STRICTLY first (the schema's
// 64 KiB cap and the per-cell credential walk included — ACCESS_INVALID leaves the file
// byte-identical) and NOT_FOUND names a target the file does not hold (D-Q9); a read skips
// what does not parse. A put REBUILDS the row from that same strict read (Gate-5 SEC-2): an
// element the strict parse refuses is worthless bytes and is dropped with the expired ones, so
// the per-reader count and the row's bytes are measured over exactly what `listAccessUndo`
// answers — a loosely-valid, strictly-unreadable element can neither hold a reader's seat nor
// crowd the row. Its caps (D-Q7, D-Q8): every put drops EXPIRED entries; an UNDONE entry
// is KEPT, marked, until it expires (§22.4) and is the FIRST to go when the row needs room;
// a LIVE entry is never evicted — the 21st live entry of one (target, reader) answers
// 'reader-cap' and writes nothing (S9: refuse, never evict), and a row that would still cross
// `ACCESS_UNDO_MAX_ROW_BYTES` after the undone entries gave way throws ACCESS_LIMIT (the
// engine pre-checks, so the throw is a belt). `deleteApp` sweeps the target's journal and the
// app's `accessWants:` declaration (D-Q12 — entries in OTHER targets' journals whose reader is
// the deleted app stay: the user may still undo what it changed); an untrusted import drops
// the journals, a trusted pull keeps them (the user's own device state).
//
// THE DECLARATION (TASK-20261010-host-broker PR-5, D-PR5-2). `accessWants:<appId>` is a host-
// derived MIRROR of the app's current html head (`access-wants.ts`), written at every admission
// (`insertVersion`) and re-derived on every import, both origins — never trusted from a file.
//
// THE PRUNE CORE lives in `access-log-prune.ts` (PR-5, D-PR5-8): the same tiers prune a history
// here and give way in the two-device history carry.
//
// HOMED BESIDE userdb.ts, not inside it: the seams (`select`/`run` on the open handle, the
// guarded settings write, the factory's thrower, the app-row check, the clock) are injected
// because userdb.ts imports this module and it cannot import userdb.ts back. The cascade
// and the import pass take a bare `SettingsSql` (the delete transaction, the import
// CANDIDATE).

import {
  ACCESS_ENDED_RETENTION_MS,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_LOG_MAX_BYTES,
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_TOTAL_MAX_BYTES,
  ACCESS_MAX_GRANTS,
  ACCESS_UNDO_MAX_ENTRIES,
  ACCESS_UNDO_MAX_ROW_BYTES,
  USERDB_TABLES,
  accessGrantSchema,
  accessHintsSchema,
  accessLogEntrySchema,
  accessPurposeSchema,
  accessUndoEntrySchema,
  canonicalAccessGrantIntent,
  canonicalJson,
  parseAccessGrant,
  parseAccessWants,
  type AccessGrant,
  type AccessHints,
  type AccessLogEntry,
  type AccessUndoEntry,
  type AccessWants,
} from '@snugprotocol/protocol';
import { ACCESS_WANTS_SCAN_MAX_UNITS, extractAccessWants } from '../access-wants.js';
import {
  ACCESS_DECLINED_SETTING_PREFIX,
  ACCESS_GRANT_SETTING_PREFIX,
  ACCESS_LOG_SETTING_PREFIX,
  ACCESS_MUTED_SETTING_PREFIX,
  ACCESS_UNDO_SETTING_PREFIX,
  ACCESS_WANTS_SETTING_PREFIX,
  accessDeclinedSettingKey,
  accessDeclinedSettingPrefixFor,
  accessGrantSettingKey,
  accessLogSettingKey,
  accessMutedSettingKey,
  accessUndoSettingKey,
  accessWantsSettingKey,
  appIdFromAccessWantsSettingKey,
  grantIdFromAccessGrantSettingKey,
  sourceAppIdFromAccessLogSettingKey,
} from './app-settings-keys.js';
import { bytesOf, looseEntries, pruneToFit } from './access-log-prune.js';
import type { SettingsSql } from './schedules.js';
import type { UserDb } from './userdb.js';

// ------------------------------------------------------------------------- seams

/** The `USERDB_ERROR_CODES` keys an accessor may throw — mapped to the real code by the factory. */
export type AccessRefusal = 'ACCESS_INVALID' | 'ACCESS_LIMIT' | 'NOT_FOUND';

/** What the factory lends the accessors. */
export interface AccessSeams extends SettingsSql {
  assertOpen(): void;
  /** `kvSet` on the settings table — carries `guardAddedBytes`. */
  setSetting(key: string, value: unknown): void;
  /** Throws the factory's `UserDbError` with the named code. */
  refuse(code: AccessRefusal, message: string): never;
  /** True when the file holds this app row — a grant or a history never names an app the file does not hold. */
  hasApp(appId: string): boolean;
  /** Epoch milliseconds — liveness (`until`) and the ended-row retention are measured against it. */
  now(): number;
}

/** A reader's declined ask: the semantic hash plus what the reader's sheet shows beside *allow…*. */
export interface AccessDecline {
  /** `accessRequestHash()` of the ask — 16 lowercase hex digits. */
  hash: string;
  purpose: string;
  hints: AccessHints;
  /** When the user said *don't allow* (ISO instant). */
  at: string;
}

export type AccessAccessors = Pick<
  UserDb,
  | 'listAccessGrants'
  | 'getAccessGrant'
  | 'putAccessGrant'
  | 'deleteAccessGrant'
  | 'listAccessLog'
  | 'appendAccessLog'
  | 'clearAccessLog'
  | 'listAccessDeclines'
  | 'addAccessDecline'
  | 'clearAccessDecline'
  | 'isAccessMuted'
  | 'setAccessMuted'
  | 'listAccessUndo'
  | 'listAllAccessUndo'
  | 'putAccessUndo'
  | 'markAccessUndone'
  | 'getAccessWants'
  | 'listAccessWants'
>;

// ----------------------------------------------------------------------- helpers

const SETTINGS = USERDB_TABLES.settings;
/** The escaped-prefix LIKE pattern the `auth:`, `shareLink:` and `scheduleDeclined:` sweeps use — `!`, `%`, `_` are literal. */
const likePrefix = (prefix: string): string => `${prefix.replace(/([!%_])/g, '!$1')}%`;
const PREFIX_WHERE = `key LIKE ? ESCAPE '!'`;
/** Instants compare by value, not by text: the schema admits `…:00Z` beside `…:00.000Z`. */
const instant = (iso: string): number => Date.parse(iso);
/** `accessRequestHash()`'s output: FNV-1a 64 as 16 lowercase hex digits. */
const REQUEST_HASH_RULE = /^[0-9a-f]{16}$/;
/** The protocol's own ISO-instant rule (the log entry's `at` seat) — never retyped here. */
const isoInstantSchema = accessLogEntrySchema.shape.at;

function rowsUnder(sql: SettingsSql, prefix: string): Array<[key: string, raw: string]> {
  return sql
    .select(`SELECT key, value FROM ${SETTINGS} WHERE ${PREFIX_WHERE} ORDER BY key`, [likePrefix(prefix)])
    .map((row) => [String(row[0]), String(row[1])]);
}

function rawValue(sql: SettingsSql, key: string): string | undefined {
  const raw = sql.select(`SELECT value FROM ${SETTINGS} WHERE key = ?`, [key])[0]?.[0];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** The UNGUARDED settings write, for handles the factory does not wrap (an import candidate). */
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

/** A stored value as a plain object, or `undefined` — the LOOSE read the caps and the sweep use. */
function looseObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(raw);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tolerant grant read plus the KEY/BODY AGREEMENT rule: an `accessGrant:a` row whose body
 * says `id: 'b'` is unreadable — honouring it would let one key answer for another grant.
 */
function readGrant(raw: string | undefined, grantId: string): AccessGrant | undefined {
  const grant = parseAccessGrant(raw);
  return grant !== undefined && grant.id === grantId ? grant : undefined;
}

/** A `duration: { kind: 'until', at }` that has passed — expiry is DERIVED, never stored. */
function untilPassed(duration: unknown, now: number): boolean {
  if (typeof duration !== 'object' || duration === null) return false;
  const { kind, at } = duration as { kind?: unknown; at?: unknown };
  return kind === 'until' && typeof at === 'string' && instant(at) <= now;
}

/**
 * ACTIVE AND UNEXPIRED: status `active` and an `until` not passed. Read loosely, so a row the strict
 * parse refuses but that CLAIMS to be live still holds a seat. (Not the engine's `isUsableNow`,
 * which also checks the source's sidecar fact.)
 */
function isActiveUnexpired(grant: { status?: unknown; duration?: unknown }, now: number): boolean {
  return grant.status === 'active' && !untilPassed(grant.duration, now);
}

/**
 * When an ENDED grant ended — revoked (`revokedAt`, else `updatedAt`) or an `until` that has
 * passed, whichever came first — or `undefined` for a grant that has not ended (active and
 * unexpired, or suspended: a suspension waits on the user, it is not an ending).
 */
function endedAt(grant: Record<string, unknown>, now: number): number | undefined {
  const ends: number[] = [];
  if (grant.status === 'revoked') {
    const stamp = typeof grant.revokedAt === 'string' ? grant.revokedAt : typeof grant.updatedAt === 'string' ? grant.updatedAt : undefined;
    if (stamp !== undefined) ends.push(instant(stamp));
  }
  if (untilPassed(grant.duration, now)) ends.push(instant((grant.duration as { at: string }).at));
  const valid = ends.filter((end) => !Number.isNaN(end));
  return valid.length === 0 ? undefined : Math.min(...valid);
}

// -------------------------------------------------------------- the access log

interface LogRow {
  entries: AccessLogEntry[];
  /** Entries (or the whole row) that did not parse. The next write of the row drops them. */
  unreadable: number;
}

/** The STRICT history read: a non-array row is empty; an entry that fails the strict parse is skipped. */
function readLog(raw: string | undefined): LogRow {
  if (raw === undefined) return { entries: [], unreadable: 0 };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { entries: [], unreadable: 1 };
  }
  if (!Array.isArray(json)) return { entries: [], unreadable: 1 };
  const entries: AccessLogEntry[] = [];
  let unreadable = 0;
  for (const item of json) {
    const parsed = accessLogEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else unreadable += 1;
  }
  return { entries, unreadable };
}

/** The same table list, in the same order — or both absent. */
function sameTables(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((table, index) => table === b[index]);
}

/**
 * The coalesced entry when `next` continues `head`, else `undefined`. ONLY two reads of the
 * same grant and reader, the same attended/away fact, neither imported, that are identical in
 * what identifies the read: the same NON-withheld statement — or, when NEITHER carries one
 * (the chat and scheduler doors' lines, D-PR2-7), the same `tables` — and `next` within
 * `ACCESS_LOG_COALESCE_MS` of the coalesced entry's `at` — the FIRST read of the group, so one
 * entry never spans more than a minute. The merged entry keeps that `at`, counts both, and
 * carries the newest row count.
 */
function coalesced(head: unknown, next: AccessLogEntry): AccessLogEntry | undefined {
  if (next.kind !== 'read' || next.imported === true) return undefined;
  const parsed = accessLogEntrySchema.safeParse(head);
  if (!parsed.success) return undefined;
  const prior = parsed.data;
  if (prior.kind !== 'read' || prior.imported === true) return undefined;
  if (prior.grantId !== next.grantId || prior.readerAppId !== next.readerAppId) return undefined;
  if (prior.attended !== next.attended) return undefined;
  const identical = next.sql === undefined ? prior.sql === undefined && sameTables(prior.tables, next.tables) : prior.sql === next.sql;
  if (!identical) return undefined;
  const gap = instant(next.at) - instant(prior.at);
  if (!(gap >= 0 && gap <= ACCESS_LOG_COALESCE_MS)) return undefined;
  const merged = accessLogEntrySchema.safeParse({
    ...prior,
    count: (prior.count ?? 1) + (next.count ?? 1),
    ...(next.rows !== undefined ? { rows: next.rows } : {}),
  });
  return merged.success ? merged.data : undefined;
}

// ------------------------------------------------------------- the undo journal

/** The LOOSE view of a stored journal element — what `markAccessUndone` reads to find the id it marks (it marks what it finds); the put and the caps read the STRICT parse (SEC-2). */
interface UndoView {
  id: string;
  readerAppId: string;
  /** Epoch milliseconds. */
  at: number;
  expiresAt: number;
  undone: boolean;
}

/** `undefined` for an element that is not a readable entry — worthless bytes, dropped by the next put. */
function undoView(item: unknown): UndoView | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const { id, readerAppId, at, expiresAt, undoneAt } = item as { id?: unknown; readerAppId?: unknown; at?: unknown; expiresAt?: unknown; undoneAt?: unknown };
  const atMs = typeof at === 'string' ? instant(at) : Number.NaN;
  const expiresMs = typeof expiresAt === 'string' ? instant(expiresAt) : Number.NaN;
  if (typeof id !== 'string' || typeof readerAppId !== 'string' || Number.isNaN(atMs) || Number.isNaN(expiresMs)) return undefined;
  return { id, readerAppId, at: atMs, expiresAt: expiresMs, undone: undoneAt !== undefined };
}

/** LIVE: not undone and not expired — what `listAccessUndo` answers and what the per-reader cap counts. */
const isLiveUndo = (view: { undone: boolean; expiresAt: number }, now: number): boolean => !view.undone && view.expiresAt > now;

/** The STRICT journal read: a non-array row is empty; an entry the strict parse refuses is skipped. */
function readUndo(raw: string | undefined): AccessUndoEntry[] {
  const entries: AccessUndoEntry[] = [];
  for (const item of looseEntries(raw)) {
    const parsed = accessUndoEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

// --------------------------------------------------------------------- accessors

export function createAccessAccessors(seams: AccessSeams): AccessAccessors {
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

  function grantRows(): Array<{ key: string; grant: AccessGrant | undefined }> {
    return rowsUnder(seams, ACCESS_GRANT_SETTING_PREFIX).map(([key, raw]) => {
      // Parse the key rather than trusting the prefix test: a bare `accessGrant:` row is unreadable.
      const grantId = grantIdFromAccessGrantSettingKey(key);
      return { key, grant: grantId === undefined ? undefined : readGrant(raw, grantId) };
    });
  }

  /**
   * The ids of every grant row the file holds — by KEY, so a row the strict parse refuses still
   * keeps its history's latest entries (the stricter reading). Read once per append, lazily.
   */
  function heldGrantIds(): () => ReadonlySet<string> {
    let held: ReadonlySet<string> | undefined;
    return () => {
      held ??= new Set(
        rowsUnder(seams, ACCESS_GRANT_SETTING_PREFIX).flatMap(([key]) => {
          const grantId = grantIdFromAccessGrantSettingKey(key);
          return grantId === undefined ? [] : [grantId];
        }),
      );
      return held;
    };
  }

  /** Write every changed history row; more than one row goes as one transaction so a cap error cannot half-apply. */
  function writeLogRows(rows: ReadonlyMap<string, unknown[]>): void {
    const transactional = rows.size > 1;
    if (transactional) seams.run('BEGIN');
    try {
      for (const [sourceAppId, entries] of rows) {
        const key = accessLogSettingKey(sourceAppId);
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
    listAccessGrants() {
      assertOpen();
      return grantRows().flatMap(({ grant }) => (grant === undefined ? [] : [grant]));
    },

    getAccessGrant(grantId) {
      assertOpen();
      return readGrant(rawValue(seams, accessGrantSettingKey(grantId)), grantId);
    },

    putAccessGrant(grant) {
      assertOpen();
      const parsed = accessGrantSchema.safeParse(grant);
      if (!parsed.success) invalid(`access grant failed validation: ${issuesOf(parsed.error)}`);
      const next = parsed.data;
      for (const appId of [next.readerAppId, next.sourceAppId]) {
        if (!seams.hasApp(appId)) notFound(`no app "${appId}" for this access grant`);
      }
      const key = accessGrantSettingKey(next.id);
      const now = seams.now();
      // The cap counts OTHER live rows, so a replace at the cap still lands and a 101st live
      // grant does not. Ended and suspended grants hold no seat — but re-activating one is a
      // new live grant and is counted like one.
      if (isActiveUnexpired(next, now)) {
        let live = 0;
        for (const [otherKey, raw] of rowsUnder(seams, ACCESS_GRANT_SETTING_PREFIX)) {
          if (otherKey === key) continue;
          const other = looseObject(raw);
          if (other !== undefined && isActiveUnexpired(other, now)) live += 1;
        }
        if (live >= ACCESS_MAX_GRANTS) limit(`the file already holds ${ACCESS_MAX_GRANTS} live access grants`);
      }
      seams.setSetting(key, next);
      // Then prune ENDED rows older than the retention — never the row just written, and only
      // after the write landed, so a refused write changes nothing at all.
      const horizon = now - ACCESS_ENDED_RETENTION_MS;
      for (const [otherKey, raw] of rowsUnder(seams, ACCESS_GRANT_SETTING_PREFIX)) {
        if (otherKey === key) continue;
        const other = looseObject(raw);
        const ended = other === undefined ? undefined : endedAt(other, now);
        if (ended !== undefined && ended < horizon) deleteKey(seams, otherKey);
      }
    },

    deleteAccessGrant(grantId) {
      assertOpen();
      deleteKey(seams, accessGrantSettingKey(grantId));
    },

    listAccessLog(sourceAppId) {
      assertOpen();
      return readLog(rawValue(seams, accessLogSettingKey(sourceAppId))).entries;
    },

    appendAccessLog(sourceAppId, entry) {
      assertOpen();
      const parsed = accessLogEntrySchema.safeParse(entry);
      if (!parsed.success) invalid(`access-log entry failed validation: ${issuesOf(parsed.error)}`);
      if (!seams.hasApp(sourceAppId)) notFound(`no app "${sourceAppId}" to keep this history`);
      const key = accessLogSettingKey(sourceAppId);
      const entries = looseEntries(rawValue(seams, key));
      const merged = coalesced(entries[0], parsed.data);
      const written: AccessLogEntry = merged ?? parsed.data;
      if (merged !== undefined) entries[0] = merged;
      else entries.unshift(written);

      // The per-source caps: entries, then bytes.
      const own = new Map<string, unknown[]>([[sourceAppId, entries]]);
      const held = heldGrantIds();
      const rowFits = (): boolean => entries.length <= ACCESS_LOG_MAX_ENTRIES && bytesOf(entries) <= ACCESS_LOG_MAX_BYTES;
      if (!pruneToFit(own, rowFits, { keep: written, heldGrants: held })) {
        limit(`the access history of "${sourceAppId}" holds nothing that may be pruned (${ACCESS_LOG_MAX_ENTRIES} entries / ${ACCESS_LOG_MAX_BYTES} bytes)`);
      }

      // The ceiling across every source: one SUM over the other rows' stored bytes on the
      // common path; only when it is crossed are the other histories read (loosely) and
      // pruned, globally oldest first within each tier; only the rows that changed are rewritten.
      const changed = new Map<string, unknown[]>(own);
      const othersStored = Number(
        seams.select(`SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) FROM ${SETTINGS} WHERE ${PREFIX_WHERE} AND key <> ?`, [
          likePrefix(ACCESS_LOG_SETTING_PREFIX),
          key,
        ])[0]?.[0] ?? 0,
      );
      if (bytesOf(entries) + othersStored > ACCESS_LOG_TOTAL_MAX_BYTES) {
        const all = new Map<string, unknown[]>(own);
        for (const [otherKey, raw] of rowsUnder(seams, ACCESS_LOG_SETTING_PREFIX)) {
          const otherSource = sourceAppIdFromAccessLogSettingKey(otherKey);
          if (otherSource === undefined || otherSource === sourceAppId) continue;
          all.set(otherSource, looseEntries(raw));
        }
        const sizes = new Map<string, number>([...all].map(([source, list]) => [source, bytesOf(list)]));
        let total = 0;
        for (const size of sizes.values()) total += size;
        const pruned = pruneToFit(all, () => total <= ACCESS_LOG_TOTAL_MAX_BYTES, {
          keep: written,
          heldGrants: held,
          onPruned: (source, list) => {
            const after = bytesOf(list);
            total -= (sizes.get(source) ?? after) - after;
            sizes.set(source, after);
            changed.set(source, list);
          },
        });
        if (!pruned) limit(`every source's access history holds nothing that may be pruned (${ACCESS_LOG_TOTAL_MAX_BYTES} bytes across sources)`);
      }
      writeLogRows(changed);
    },

    clearAccessLog(sourceAppId) {
      assertOpen();
      const key = accessLogSettingKey(sourceAppId);
      const raw = rawValue(seams, key);
      if (raw === undefined) return;
      // *Clear history* clears the READS. Every lifecycle entry stays: it is the record of
      // when, and by whose act, access began and ended.
      const kept = readLog(raw).entries.filter((item) => item.kind !== 'read');
      if (kept.length === 0) deleteKey(seams, key);
      else seams.setSetting(key, kept);
    },

    listAccessDeclines(readerAppId) {
      assertOpen();
      const prefix = accessDeclinedSettingPrefixFor(readerAppId);
      const declines: AccessDecline[] = [];
      for (const [key, raw] of rowsUnder(seams, prefix)) {
        const hash = key.slice(prefix.length);
        const decline = readDecline(hash, raw);
        if (decline !== undefined) declines.push(decline);
      }
      // Newest first; the hash breaks a tie so the order is total.
      return declines.sort((a, b) => instant(b.at) - instant(a.at) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    },

    addAccessDecline(readerAppId, hash, decline) {
      assertOpen();
      const record = parseDecline(hash, decline);
      if (typeof record === 'string') invalid(record);
      seams.setSetting(accessDeclinedSettingKey(readerAppId, hash), record);
    },

    clearAccessDecline(readerAppId, hash) {
      assertOpen();
      deleteKey(seams, accessDeclinedSettingKey(readerAppId, hash));
    },

    isAccessMuted(readerAppId) {
      assertOpen();
      const raw = rawValue(seams, accessMutedSettingKey(readerAppId));
      if (raw === undefined) return false;
      try {
        return JSON.parse(raw) === true;
      } catch {
        return false;
      }
    },

    setAccessMuted(readerAppId, muted) {
      assertOpen();
      const key = accessMutedSettingKey(readerAppId);
      // Clearing DELETES — absence is what "not muted" means.
      if (!muted) deleteKey(seams, key);
      else seams.setSetting(key, true);
    },

    listAccessUndo(targetAppId, readerAppId) {
      assertOpen();
      const now = seams.now();
      return readUndo(rawValue(seams, accessUndoSettingKey(targetAppId))).filter(
        (entry) =>
          isLiveUndo({ undone: entry.undoneAt !== undefined, expiresAt: instant(entry.expiresAt) }, now) &&
          (readerAppId === undefined || entry.readerAppId === readerAppId),
      );
    },

    listAllAccessUndo(targetAppId) {
      assertOpen();
      return readUndo(rawValue(seams, accessUndoSettingKey(targetAppId)));
    },

    putAccessUndo(targetAppId, entry) {
      assertOpen();
      const parsed = accessUndoEntrySchema.safeParse(entry);
      if (!parsed.success) invalid(`undo entry failed validation: ${issuesOf(parsed.error)}`);
      if (!seams.hasApp(targetAppId)) notFound(`no app "${targetAppId}" to keep this journal`);
      const key = accessUndoSettingKey(targetAppId);
      const now = seams.now();
      // The row is rebuilt from the STRICT read (SEC-2): the expired and the unreadable are dropped
      // (D-Q7); an undone entry stays, marked. What the caps count below is what `listAccessUndo` answers.
      const kept = readUndo(rawValue(seams, key)).filter((entry) => instant(entry.expiresAt) > now);
      const liveness = (entry: AccessUndoEntry): { undone: boolean; expiresAt: number } => ({ undone: entry.undoneAt !== undefined, expiresAt: instant(entry.expiresAt) });
      // The per-reader cap REFUSES — never evicts a live entry (S9). Nothing is written.
      const live = kept.filter((entry) => entry.readerAppId === parsed.data.readerAppId && isLiveUndo(liveness(entry), now)).length;
      if (live >= ACCESS_UNDO_MAX_ENTRIES) return 'reader-cap';
      // The row cap: the OLDEST undone entry gives way first; when none is left the put is refused whole.
      const row = (): unknown[] => [parsed.data, ...kept];
      while (bytesOf(row()) > ACCESS_UNDO_MAX_ROW_BYTES) {
        let victim = -1;
        for (const [index, entry] of kept.entries()) {
          const oldest = victim === -1 ? undefined : kept[victim];
          if (entry.undoneAt !== undefined && (oldest === undefined || instant(entry.at) < instant(oldest.at))) victim = index;
        }
        if (victim === -1) limit(`the undo journal of "${targetAppId}" holds ${ACCESS_UNDO_MAX_ROW_BYTES} bytes of live entries and nothing may be pruned`);
        kept.splice(victim, 1);
      }
      seams.setSetting(key, row());
      return 'ok';
    },

    markAccessUndone(targetAppId, id, at) {
      assertOpen();
      const stamp = isoInstantSchema.safeParse(at);
      if (!stamp.success) invalid(`undo instant failed validation: ${issuesOf(stamp.error)}`);
      const key = accessUndoSettingKey(targetAppId);
      const raw = rawValue(seams, key);
      if (raw === undefined) return;
      const entries = looseEntries(raw);
      const index = entries.findIndex((item) => undoView(item)?.id === id);
      if (index === -1) return; // an unknown id is a no-op
      entries[index] = { ...(entries[index] as Record<string, unknown>), undoneAt: stamp.data };
      seams.setSetting(key, entries);
    },

    getAccessWants(appId) {
      assertOpen();
      return parseAccessWants(rawValue(seams, accessWantsSettingKey(appId)));
    },

    listAccessWants() {
      assertOpen();
      const wants = new Map<string, AccessWants>();
      for (const [key, raw] of rowsUnder(seams, ACCESS_WANTS_SETTING_PREFIX)) {
        const appId = appIdFromAccessWantsSettingKey(key);
        const declared = appId === undefined ? undefined : parseAccessWants(raw);
        if (appId !== undefined && declared !== undefined) wants.set(appId, declared);
      }
      return wants;
    },
  };
}

/** The stored decline body, or a refusal message. Each seat is checked by the protocol's own schema. */
function parseDecline(hash: string, decline: { purpose: string; hints: AccessHints; at: string }): Omit<AccessDecline, 'hash'> | string {
  if (!REQUEST_HASH_RULE.test(hash)) return 'a decline is keyed by an accessRequestHash (16 lowercase hex digits)';
  const purpose = accessPurposeSchema.safeParse(decline.purpose);
  if (!purpose.success) return `decline purpose failed validation: ${issuesOf(purpose.error)}`;
  const hints = accessHintsSchema.safeParse(decline.hints);
  if (!hints.success) return `decline hints failed validation: ${issuesOf(hints.error)}`;
  const at = isoInstantSchema.safeParse(decline.at);
  if (!at.success) return `decline instant failed validation: ${issuesOf(at.error)}`;
  return { purpose: purpose.data, hints: hints.data, at: at.data };
}

/** The tolerant decline read: `undefined` for a row that does not parse. */
function readDecline(hash: string, raw: string): AccessDecline | undefined {
  const body = looseObject(raw);
  if (body === undefined) return undefined;
  const record = parseDecline(hash, body as { purpose: string; hints: AccessHints; at: string });
  return typeof record === 'string' ? undefined : { hash, ...record };
}

// ------------------------------------------------------------- deleteApp (AC9)

/**
 * The cascade's share of the access rows, run INSIDE `deleteApp`'s transaction:
 *  - every grant where the app is the READER or the SOURCE — read LOOSELY, so a row the strict
 *    parse refuses but that names the app goes too (a later, more lenient reader must not
 *    find it armed against a reused id);
 *  - the app's own history row `accessLog:<appId>` by equality (the history of reads OF this
 *    app — nobody is left to read it). Entries in OTHER sources' histories that name this app
 *    as a reader stay: the source keeps its history;
 *  - its `accessDeclined:<appId>:*` rows by escaped prefix, and its `accessMuted:<appId>` row
 *    by equality — the per-app-row-in-a-shared-namespace obligation. Known limit, as for the
 *    `auth:` prefix: an app id containing a literal colon would over-match a sibling sharing
 *    that prefix — unreachable with UUID ids;
 *  - its own undo journal `accessUndo:<appId>` (the rows written INTO this app — nothing is
 *    left to put back) and its `accessWants:<appId>` declaration, each by equality (PR-3,
 *    D-Q12). Entries in OTHER targets' journals whose reader is this app stay: the user may
 *    still undo what it changed, and the reader's name is on the entry.
 */
export function sweepAccessForDeletedApp(sql: SettingsSql, appId: string): void {
  for (const [key, raw] of rowsUnder(sql, ACCESS_GRANT_SETTING_PREFIX)) {
    const grant = looseObject(raw);
    if (grant !== undefined && (grant.readerAppId === appId || grant.sourceAppId === appId)) deleteKey(sql, key);
  }
  deleteKey(sql, accessLogSettingKey(appId));
  sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(accessDeclinedSettingPrefixFor(appId))]);
  deleteKey(sql, accessMutedSettingKey(appId));
  deleteKey(sql, accessUndoSettingKey(appId));
  deleteKey(sql, accessWantsSettingKey(appId));
}

// ---------------------------------------------- the declaration (PR-5, D-PR5-2)

/**
 * Mirror one app's access declaration from its html: read the first `ACCESS_WANTS_SCAN_MAX_UNITS`
 * characters of the CURRENT version (or of `version`, the one an admission is making current),
 * and write the `accessWants:<appId>` row as the canonical JSON of what `extractAccessWants`
 * reads there — or DELETE it when the html declares nothing. A cell that is not TEXT (a BLOB a
 * foreign file planted) derives nothing (v2.1 N4). SQLite's `substr` counts characters and the
 * reader caps UTF-16 units itself, so the reader alone decides — the admission, an import and the
 * shared preview agree. A plain write, never the guarded `setSetting`: the row is derived, and a
 * declaration must never be the reason an install or an import is refused.
 */
export function writeAccessWantsFor(sql: SettingsSql, appId: string, version?: number): void {
  const prefix = `CASE WHEN typeof(v.html) = 'text' THEN substr(v.html, 1, ${ACCESS_WANTS_SCAN_MAX_UNITS}) END`;
  const row =
    version === undefined
      ? sql.select(
          `SELECT ${prefix} FROM ${USERDB_TABLES.apps} a JOIN ${USERDB_TABLES.appVersions} v ON v.app_id = a.app_id AND v.version = a.current_version WHERE a.app_id = ?`,
          [appId],
        )[0]
      : sql.select(`SELECT ${prefix} FROM ${USERDB_TABLES.appVersions} v WHERE v.app_id = ? AND v.version = ?`, [appId, version])[0];
  const head = row?.[0];
  const declared = typeof head === 'string' ? extractAccessWants(head) : undefined;
  if (declared === undefined) deleteKey(sql, accessWantsSettingKey(appId));
  else sql.run(`INSERT OR REPLACE INTO ${SETTINGS} (key, value) VALUES (?, ?)`, [accessWantsSettingKey(appId), canonicalJson(declared)]);
}

/**
 * Every import, whatever its origin (D-PR5-2): EVERY `accessWants:` row goes — a planted or an
 * orphan row is never read — then one is derived per app the file holds, from its own html. The
 * derivation is deterministic, so a trusted round trip is byte-identical (§22.1 rule 5's one
 * derived carve-out).
 */
export function rederiveAccessWants(sql: SettingsSql): void {
  sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(ACCESS_WANTS_SETTING_PREFIX)]);
  for (const row of sql.select(`SELECT app_id FROM ${USERDB_TABLES.apps} ORDER BY app_id`)) writeAccessWantsFor(sql, String(row[0]));
}

// --------------------------------------------------------------- import (AC10)

/** What `importUserDb` reads from the OPEN handle about the local grants before the candidate goes live. */
export interface LocalAccessGrantSnapshot {
  /** grantId → `canonicalAccessGrantIntent` of every ACTIVE local grant — the only ones that may vouch for an imported twin. */
  live: Map<string, string>;
  /**
   * grantId → the FULL local row of every grant the user stopped (an import never re-arms it): the
   * untrusted import stamps its `revokedAt`/`updatedAt` on the file's row, and a carry-enabled pull
   * puts the whole row back over whatever the origin says (a stop wins, PR-5 D-PR5-8).
   */
  revoked: Map<string, AccessGrant & { revokedAt: string }>;
  /** readerAppId → the reader's CURRENT code (html) here, for every reader of an active local grant. */
  readerHtml: Map<string, string | undefined>;
}

/** An app's current version's html in the handle `sql` reads, or `undefined` when it holds no such app. */
function currentHtml(sql: SettingsSql, appId: string): string | undefined {
  const raw = sql.select(
    `SELECT v.html FROM ${USERDB_TABLES.apps} a JOIN ${USERDB_TABLES.appVersions} v ON v.app_id = a.app_id AND v.version = a.current_version WHERE a.app_id = ?`,
    [appId],
  )[0]?.[0];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/**
 * The local grants, read from the open handle before the candidate goes live (W6 findings 2/3/27):
 * the intent of each ACTIVE grant (a revoked or paused local grant never vouches — the user's stop
 * or the pending review would otherwise vanish), the tombstone of each STOPPED grant, and the
 * current code of each active grant's reader (consent given to that code survives a file only
 * while the code does).
 */
export function snapshotLocalAccessGrants(sql: SettingsSql): LocalAccessGrantSnapshot {
  const snapshot: LocalAccessGrantSnapshot = { live: new Map(), revoked: new Map(), readerHtml: new Map() };
  for (const [key, raw] of rowsUnder(sql, ACCESS_GRANT_SETTING_PREFIX)) {
    const grantId = grantIdFromAccessGrantSettingKey(key);
    const grant = grantId === undefined ? undefined : readGrant(raw, grantId);
    if (grant === undefined) continue;
    if (grant.status === 'revoked' && grant.revokedAt !== undefined) {
      snapshot.revoked.set(grant.id, { ...grant, revokedAt: grant.revokedAt });
    } else if (grant.status === 'active') {
      snapshot.live.set(grant.id, canonicalAccessGrantIntent(grant));
      if (!snapshot.readerHtml.has(grant.readerAppId)) snapshot.readerHtml.set(grant.readerAppId, currentHtml(sql, grant.readerAppId));
    }
  }
  return snapshot;
}

/** What `importUserDb` reports about the access pass. */
export interface AccessImportReport {
  /** Grants that landed `suspended / imported` (always 0 on a trusted pull). */
  suspendedGrants: number;
  /** Grant rows that did not parse (or could not be made safe) and were removed — untrusted imports only (always 0 on a trusted pull). */
  removedGrants: number;
  /** History entries newly tagged `imported: true` (an already-tagged entry is not counted again). */
  taggedLogEntries: number;
}

/**
 * The import reconciliation for the access rows (ADR-0075 §9; spec 1.1 §22 — a hub
 * implementing Part VI MUST do this), run on the CANDIDATE beside `reconcileImportedSchedules`
 * — before it goes live, so every path (UI import, sync pull-merge, applyRemote, recovery
 * restore) inherits it.
 *
 * UNTRUSTED (a file the user picked off disk): a grant row that does not parse — or whose body
 * names another id than its key — is REMOVED and counted: it cannot be shown or demoted, and a
 * later, more lenient reader must not find it armed. A grant is AUTHORITY, so the connection and
 * schedule doctrine applies. A grant the user STOPPED here keeps its local tombstone whatever the
 * file says (`revoked`, the local `revokedAt` — an older copy of the file never re-arms a stop;
 * spec §22). A grant whose `canonicalAccessGrantIntent` equals an ACTIVE local grant of the same
 * id — and whose reader's current code in the file is the code this hub holds — stays exactly
 * as it arrived (a backup round trip must not disarm the user — counters and status move with
 * ordinary use and are not intent); a file that swaps the READER's code does not carry the
 * consent given to the old code (D18 at the file seam). Every other grant lands
 * `suspended / imported` with `updatedAt` = the import instant and the rest of it intact, for
 * the user to review and *allow again* — EXCEPT a `revoked` grant, which stays revoked: it is
 * already inert, and suspending it would make a grant the user never gave revivable with one
 * tap. Declines and mutes are dropped (the user's own answers, not something a file carries
 * in), and every history entry is tagged `imported: true` (shown under its own heading);
 * entries that do not parse are dropped. The undo journals are dropped too (PR-3, D-PR3-7): a
 * journal names rows to write back into an app, and a file must never plant one. The wants are
 * not this pass's: EVERY import re-derives them from the apps' own html (`rederiveAccessWants`,
 * PR-5 D-PR5-2).
 *
 * TRUSTED (the user's own configured origin): grants, declines, mutes, histories and journals
 * stay as they are — a grant row this hub cannot parse included (the `schedules.ts`
 * precedent, review finding 2): it may be a NEWER hub's grant carrying a field this spec does
 * not know; it is inert here (the tolerant read answers "no such grant"), and removing it
 * would sync the loss back to the device that wrote it.
 */
export function reconcileImportedAccessGrants(
  sql: SettingsSql,
  localGrants: LocalAccessGrantSnapshot,
  trustedOrigin: boolean,
  importedAt: string = new Date().toISOString(),
): AccessImportReport {
  let suspendedGrants = 0;
  let removedGrants = 0;
  let taggedLogEntries = 0;

  for (const [key, raw] of rowsUnder(sql, ACCESS_GRANT_SETTING_PREFIX)) {
    const grantId = grantIdFromAccessGrantSettingKey(key);
    const grant = grantId === undefined ? undefined : readGrant(raw, grantId);
    // A trusted pull KEEPS a row it cannot parse (the schedules precedent): it may be a newer
    // hub's grant, it is already inert here, and removing it would sync the loss back.
    if (trustedOrigin) continue;
    if (grant === undefined) {
      deleteKey(sql, key);
      removedGrants += 1;
      continue;
    }
    const tombstone = localGrants.revoked.get(grant.id);
    if (tombstone !== undefined) {
      if (grant.status === 'revoked') continue;
      const { suspendedReason: _reason, ...rest } = grant;
      const stopped = accessGrantSchema.safeParse({ ...rest, status: 'revoked', revokedAt: tombstone.revokedAt, updatedAt: tombstone.updatedAt });
      if (stopped.success) writeRaw(sql, key, stopped.data);
      else {
        deleteKey(sql, key);
        removedGrants += 1;
      }
      continue;
    }
    const sameReaderCode =
      localGrants.readerHtml.has(grant.readerAppId) && localGrants.readerHtml.get(grant.readerAppId) === currentHtml(sql, grant.readerAppId);
    if (sameReaderCode && localGrants.live.get(grant.id) === canonicalAccessGrantIntent(grant)) continue;
    if (grant.status === 'revoked') continue;
    if (grant.status === 'suspended' && grant.suspendedReason === 'imported') continue;
    const demoted = accessGrantSchema.safeParse({ ...grant, status: 'suspended', suspendedReason: 'imported', updatedAt: importedAt });
    // Only the whole-object byte cap can refuse here; such a row cannot be made safe, so it goes.
    if (!demoted.success) {
      deleteKey(sql, key);
      removedGrants += 1;
      continue;
    }
    writeRaw(sql, key, demoted.data);
    suspendedGrants += 1;
  }

  if (!trustedOrigin) {
    for (const prefix of [ACCESS_DECLINED_SETTING_PREFIX, ACCESS_MUTED_SETTING_PREFIX, ACCESS_UNDO_SETTING_PREFIX]) {
      sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(prefix)]);
    }
    for (const [key, raw] of rowsUnder(sql, ACCESS_LOG_SETTING_PREFIX)) {
      if (sourceAppIdFromAccessLogSettingKey(key) === undefined) {
        deleteKey(sql, key);
        continue;
      }
      const { entries, unreadable } = readLog(raw);
      let changed = unreadable > 0;
      const tagged = entries.map((item) => {
        if (item.imported === true) return item;
        changed = true;
        taggedLogEntries += 1;
        return { ...item, imported: true };
      });
      if (!changed) continue;
      if (tagged.length === 0) deleteKey(sql, key);
      else writeRaw(sql, key, tagged);
    }
  }

  return { suspendedGrants, removedGrants, taggedLogEntries };
}
