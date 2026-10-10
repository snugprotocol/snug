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
// coalesce only on an identical `(grantId, sql)` within a minute of the coalesced entry's
// first read — never across a different statement, a withheld one, another grant, an
// attended/away change or an intervening entry.
//
// HOMED BESIDE userdb.ts, not inside it: the seams (`select`/`run` on the open handle, the
// guarded settings write, the factory's thrower, the app-row check, the clock) are injected
// because userdb.ts imports this module and it cannot import userdb.ts back. The cascade
// and the import pass take a bare `SettingsSql` (the delete transaction, the import
// CANDIDATE).

import {
  ACCESS_ENDED_RETENTION_MS,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_LOG_KINDS,
  ACCESS_LOG_MAX_BYTES,
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_TOTAL_MAX_BYTES,
  ACCESS_MAX_GRANTS,
  USERDB_TABLES,
  accessGrantSchema,
  accessHintsSchema,
  accessLogEntrySchema,
  accessPurposeSchema,
  canonicalAccessGrantIntent,
  parseAccessGrant,
  type AccessGrant,
  type AccessHints,
  type AccessLogEntry,
  type AccessLogKind,
} from '@snugprotocol/protocol';
import {
  ACCESS_DECLINED_SETTING_PREFIX,
  ACCESS_GRANT_SETTING_PREFIX,
  ACCESS_LOG_SETTING_PREFIX,
  ACCESS_MUTED_SETTING_PREFIX,
  accessDeclinedSettingKey,
  accessDeclinedSettingPrefixFor,
  accessGrantSettingKey,
  accessLogSettingKey,
  accessMutedSettingKey,
  grantIdFromAccessGrantSettingKey,
  sourceAppIdFromAccessLogSettingKey,
} from './app-settings-keys.js';
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
>;

// ----------------------------------------------------------------------- helpers

const SETTINGS = USERDB_TABLES.settings;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
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

/** LIVE: status `active` and not expired. Read loosely, so a row the strict parse refuses but that CLAIMS to be live still holds a seat. */
function isLive(grant: { status?: unknown; duration?: unknown }, now: number): boolean {
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

const LOG_KIND_SET: ReadonlySet<string> = new Set(ACCESS_LOG_KINDS);
/** The lifecycle kinds whose LATEST entry per grant is never pruned (ADR-0075 §7). */
const PROTECTED_KINDS: ReadonlySet<AccessLogKind> = new Set<AccessLogKind>(['granted', 'revoked', 'suspended', 'released']);

interface EntryView {
  /** Undefined for an element that is not a readable entry: worthless bytes, pruned first. */
  kind: AccessLogKind | undefined;
  grantId: string | undefined;
  at: number;
}

/**
 * The LOOSE view of a stored element — the write path validates what it ADDS and only ever
 * REMOVES from what was there, so nothing already stored is re-parsed on every append (the
 * strict parse's credential walk is the expensive half of a read; the `schedules.ts` M3
 * reasoning). The READ path (`readLog`) still vouches for every entry it hands out.
 */
function looseView(item: unknown): EntryView {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return { kind: undefined, grantId: undefined, at: Number.NEGATIVE_INFINITY };
  const { kind, grantId, at } = item as { kind?: unknown; grantId?: unknown; at?: unknown };
  const parsedAt = typeof at === 'string' ? instant(at) : Number.NaN;
  return {
    kind: typeof kind === 'string' && LOG_KIND_SET.has(kind) ? (kind as AccessLogKind) : undefined,
    grantId: typeof grantId === 'string' ? grantId : undefined,
    at: Number.isNaN(parsedAt) ? Number.NEGATIVE_INFINITY : parsedAt,
  };
}

/** The latest protected-kind entry per (grant, kind) in one row, as index → grantId. Ties keep the newer position. */
function protectedIndices(entries: readonly unknown[]): Map<number, string> {
  const latest = new Map<string, { index: number; at: number; grantId: string }>();
  entries.forEach((item, index) => {
    const view = looseView(item);
    if (view.kind === undefined || !PROTECTED_KINDS.has(view.kind) || view.grantId === undefined) return;
    const slot = `${view.grantId}\u0000${view.kind}`;
    const seen = latest.get(slot);
    // The row is stored newest first, so on an equal instant the LOWER index is the newer entry.
    if (seen === undefined || view.at > seen.at) latest.set(slot, { index, at: view.at, grantId: view.grantId });
  });
  return new Map([...latest.values()].map(({ index, grantId }) => [index, grantId]));
}

/**
 * Pruning tiers, in order: unreadable bytes, then reads, then every other entry that is not
 * the latest of its kind for its grant — and LAST the latest entries of a grant the file no
 * longer holds (`protectedGrant` is that entry's grant id, `undefined` for an unprotected one).
 */
type PruneTier = (view: EntryView, protectedGrant: string | undefined, heldGrants: ReadonlySet<string>) => boolean;
const PRUNE_TIERS: readonly PruneTier[] = [
  ({ kind }, guard) => guard === undefined && kind === undefined,
  ({ kind }, guard) => guard === undefined && kind === 'read',
  ({ kind }, guard) => guard === undefined && kind !== undefined && kind !== 'read',
  (_view, guard, held) => guard !== undefined && !held.has(guard),
];

/**
 * The OLDEST prunable element across the given rows, tier by tier; `keep` (the entry being
 * written) is never its own victim. `heldGrants` is read only when the last tier is reached.
 * Returns the row and index, or `undefined` when nothing may go.
 */
function pruneVictim(
  rows: ReadonlyMap<string, unknown[]>,
  keep: unknown,
  heldGrants: () => ReadonlySet<string>,
): { sourceAppId: string; index: number } | undefined {
  const guarded = new Map<string, Map<number, string>>();
  for (const [sourceAppId, entries] of rows) guarded.set(sourceAppId, protectedIndices(entries));
  const none: ReadonlySet<string> = new Set();
  for (const [tier, prunable] of PRUNE_TIERS.entries()) {
    const held = tier === PRUNE_TIERS.length - 1 ? heldGrants() : none;
    let victim: { sourceAppId: string; index: number; at: number } | undefined;
    for (const [sourceAppId, entries] of rows) {
      const fenced = guarded.get(sourceAppId);
      for (let index = 0; index < entries.length; index += 1) {
        const item = entries[index];
        if (item === keep) continue;
        const view = looseView(item);
        if (!prunable(view, fenced?.get(index), held)) continue;
        if (victim === undefined || view.at < victim.at) victim = { sourceAppId, index, at: view.at };
      }
    }
    if (victim !== undefined) return { sourceAppId: victim.sourceAppId, index: victim.index };
  }
  return undefined;
}

const bytesOf = (entries: ReadonlyArray<unknown>): number => utf8Bytes(JSON.stringify(entries));

/**
 * The coalesced entry when `next` continues `head`, else `undefined`. ONLY an identical
 * `(grantId, sql)` read: both reads, the same grant, the same NON-withheld statement, the same
 * attended/away fact, neither imported, and `next` within `ACCESS_LOG_COALESCE_MS` of the
 * coalesced entry's `at` — the FIRST read of the group, so one entry never spans more than a
 * minute. The merged entry keeps that `at`, counts both, and carries the newest row count.
 */
function coalesced(head: unknown, next: AccessLogEntry): AccessLogEntry | undefined {
  if (next.kind !== 'read' || next.sql === undefined || next.imported === true) return undefined;
  const parsed = accessLogEntrySchema.safeParse(head);
  if (!parsed.success) return undefined;
  const prior = parsed.data;
  if (prior.kind !== 'read' || prior.imported === true) return undefined;
  if (prior.grantId !== next.grantId || prior.readerAppId !== next.readerAppId) return undefined;
  if (prior.sql === undefined || prior.sql !== next.sql || prior.attended !== next.attended) return undefined;
  const gap = instant(next.at) - instant(prior.at);
  if (!(gap >= 0 && gap <= ACCESS_LOG_COALESCE_MS)) return undefined;
  const merged = accessLogEntrySchema.safeParse({
    ...prior,
    count: (prior.count ?? 1) + (next.count ?? 1),
    ...(next.rows !== undefined ? { rows: next.rows } : {}),
  });
  return merged.success ? merged.data : undefined;
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
      if (isLive(next, now)) {
        let live = 0;
        for (const [otherKey, raw] of rowsUnder(seams, ACCESS_GRANT_SETTING_PREFIX)) {
          if (otherKey === key) continue;
          const other = looseObject(raw);
          if (other !== undefined && isLive(other, now)) live += 1;
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
      while (entries.length > ACCESS_LOG_MAX_ENTRIES || bytesOf(entries) > ACCESS_LOG_MAX_BYTES) {
        const victim = pruneVictim(own, written, held);
        if (victim === undefined) {
          limit(`the access history of "${sourceAppId}" holds nothing that may be pruned (${ACCESS_LOG_MAX_ENTRIES} entries / ${ACCESS_LOG_MAX_BYTES} bytes)`);
        }
        entries.splice(victim.index, 1);
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
        let total = 0;
        for (const list of all.values()) total += bytesOf(list);
        while (total > ACCESS_LOG_TOTAL_MAX_BYTES) {
          const victim = pruneVictim(all, written, held);
          if (victim === undefined) limit(`every source's access history holds nothing that may be pruned (${ACCESS_LOG_TOTAL_MAX_BYTES} bytes across sources)`);
          const list = all.get(victim.sourceAppId);
          if (list === undefined) break;
          const before = bytesOf(list);
          list.splice(victim.index, 1);
          total -= before - bytesOf(list);
          changed.set(victim.sourceAppId, list);
        }
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
 *    that prefix — unreachable with UUID ids.
 */
export function sweepAccessForDeletedApp(sql: SettingsSql, appId: string): void {
  for (const [key, raw] of rowsUnder(sql, ACCESS_GRANT_SETTING_PREFIX)) {
    const grant = looseObject(raw);
    if (grant !== undefined && (grant.readerAppId === appId || grant.sourceAppId === appId)) deleteKey(sql, key);
  }
  deleteKey(sql, accessLogSettingKey(appId));
  sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(accessDeclinedSettingPrefixFor(appId))]);
  deleteKey(sql, accessMutedSettingKey(appId));
}

// --------------------------------------------------------------- import (AC10)

/** grantId → `canonicalAccessGrantIntent` of every readable LOCAL grant, read from the open handle before the candidate goes live. */
export function snapshotLocalAccessGrants(sql: SettingsSql): Map<string, string> {
  const grants = new Map<string, string>();
  for (const [key, raw] of rowsUnder(sql, ACCESS_GRANT_SETTING_PREFIX)) {
    const grantId = grantIdFromAccessGrantSettingKey(key);
    const grant = grantId === undefined ? undefined : readGrant(raw, grantId);
    if (grant !== undefined) grants.set(grant.id, canonicalAccessGrantIntent(grant));
  }
  return grants;
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
 * schedule doctrine applies. A grant whose `canonicalAccessGrantIntent` equals the local grant
 * of the same id stays exactly as it arrived (a backup round trip must not disarm the user —
 * counters and status move with ordinary use and are not intent). Every other grant lands
 * `suspended / imported` with `updatedAt` = the import instant and the rest of it intact, for
 * the user to review and *allow again* — EXCEPT a `revoked` grant, which stays revoked: it is
 * already inert, and suspending it would make a grant the user never gave revivable with one
 * tap. Declines and mutes are dropped (the user's own answers, not something a file carries
 * in), and every history entry is tagged `imported: true` (shown under its own heading);
 * entries that do not parse are dropped.
 *
 * TRUSTED (the user's own configured origin): grants, declines, mutes and histories stay as
 * they are — a grant row this hub cannot parse included (the `schedules.ts` precedent, review
 * finding 2): it may be a NEWER hub's grant carrying a field this spec does not know; it is
 * inert here (the tolerant read answers "no such grant"), and removing it would sync the loss
 * back to the device that wrote it.
 */
export function reconcileImportedAccessGrants(
  sql: SettingsSql,
  localGrants: ReadonlyMap<string, string>,
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
    if (localGrants.get(grant.id) === canonicalAccessGrantIntent(grant)) continue;
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
    sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(ACCESS_DECLINED_SETTING_PREFIX)]);
    sql.run(`DELETE FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(ACCESS_MUTED_SETTING_PREFIX)]);
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
