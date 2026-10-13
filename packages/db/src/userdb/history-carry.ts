// history-carry.ts — the two-device access-history carry (TASK-20261010-host-broker PR-5, contract
// v2 D-PR5-8; ADR-0009 amended by ADR-0076): a sync resolution keeps BOTH devices' access history
// and lets a stop win, while the DATA stays a divergence the user resolves — never a merge.
//
//   snapshotLocalAccessHistory(sql)                 → the LOSER's history, read before the swap
//   carryAccessHistory(target, snapshot, {since})   → {carried, dropped, rewritten} — `target` is the WINNER
//   applyTombstones(target, revokedRows)            → how many rows were replaced
//
// Both directions run through here: *use the origin copy* (the pull — the import candidate wins,
// this device's history is the loser's) and *keep this device's copy* (`carryFromImage` — the live
// file wins, the pulled image's history is the loser's).
//
// HISTORY ONLY. `accessLog:*` lines are carried; `accessUndo:*` and `ownUndo:*` FOLLOW the winner:
// a journal describes rows that went with the winning data, so a carried inverse could plant a row
// the chosen copy never had, and dead entries would hold the 20 live seats.
//
// WHICH LINES. A line has no id, so identity is its NATURAL KEY `(at, kind, grantId, readerAppId)`
// (`at` by instant — the schema admits `…:00Z` beside `…:00.000Z`). A loser line is a candidate
// when it parses strictly and is NEWER than `since`. The PULL passes the sidecar's `lastSyncAt`:
// this device's lines older than that were already in the origin, so their absence from the winner
// is a prune or a *Clear history*, and carrying them back would undo that. *Keep this device's
// copy* passes `null` (G5-4): an origin line older than THIS device's last sync need not be one this
// device ever held — the natural-key match keeps that carry idempotent, and a *Clear history* made
// here since the last sync can come back as true records. A loser line the winner ALSO holds is a
// candidate whatever its `at` (G5-7): a coalesced group keeps its FIRST `at` while its count grows
// for up to a minute, so a group that began before `since` and grew after it still merges. A
// candidate whose source app the winner does not hold is dropped; one the winner already has
// MERGES into the winner's line (count and rows become the max, every other seat the winner's) and
// is not counted; the rest are CARRIED — a `wrote` line without its `undoId`, since the winner's
// journal holds no such entry. The row is merged newest first, a tie putting the winner's line
// first, and the winner's unreadable elements stay verbatim. A row a carry or a merge changed is
// written — and counted (`rewritten`), so the caller knows the file moved even when no line was
// added.
//
// THE CAPS NEVER THROW. The carried lines give way first — and ONLY they: the per-source caps, then
// the ceiling across every source, by the prune core `appendAccessLog` uses (`access-log-prune.ts`)
// with tiers that name nothing but carried lines (reads first, then the rest, each oldest first).
// The winner's own lines, protected or not, never give way to a carry; a winner already over a cap
// keeps exactly what it had.
//
// A STOP WINS. A grant revoked on the loser's side ends revoked on the winner's: the winner's row for
// that id — active, suspended or unreadable — becomes the loser's revoked row verbatim. Renewal mints
// a new id only after a revoke, so a revoked id is never legitimately live again. A row the winner
// ALREADY holds revoked is left as it is: the stop has won there, and two devices that each stopped
// the same grant must not trade `revokedAt` back and forth through the sync forever.

import {
  ACCESS_LOG_MAX_BYTES,
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_TOTAL_MAX_BYTES,
  USERDB_TABLES,
  accessLogEntrySchema,
  parseAccessGrant,
  type AccessGrant,
  type AccessLogEntry,
} from '@snugprotocol/protocol';
import { ACCESS_LOG_SETTING_PREFIX, accessGrantSettingKey, accessLogSettingKey, sourceAppIdFromAccessLogSettingKey } from './app-settings-keys.js';
import { bytesOf, looseEntries, looseView, pruneToFit, type PruneTier } from './access-log-prune.js';
import type { SettingsSql } from './schedules.js';

/** One handle's access history, as stored: the source app → the elements of its `accessLog:<source>` row. */
export interface AccessHistorySnapshot {
  readonly rows: ReadonlyMap<string, readonly unknown[]>;
}

/** What a carry did: lines ADDED to the winner, the loser's candidates that were not (an absent source, or a line that gave way to a cap) — a natural-key match is neither — and the history ROWS it wrote (a count-only merge is a write). */
export interface AccessHistoryCarry {
  carried: number;
  dropped: number;
  rewritten: number;
}

// ----------------------------------------------------------------------- helpers

const SETTINGS = USERDB_TABLES.settings;
/** The escaped-prefix LIKE the `access.ts` sweeps use — `!`, `%`, `_` are literal. */
const likePrefix = (prefix: string): string => `${prefix.replace(/([!%_])/g, '!$1')}%`;
const PREFIX_WHERE = `key LIKE ? ESCAPE '!'`;

function rawValue(sql: SettingsSql, key: string): string | undefined {
  const raw = sql.select(`SELECT value FROM ${SETTINGS} WHERE key = ?`, [key])[0]?.[0];
  return raw === undefined || raw === null ? undefined : String(raw);
}

function writeRow(sql: SettingsSql, key: string, value: unknown): void {
  sql.run(`INSERT OR REPLACE INTO ${SETTINGS} (key, value) VALUES (?, ?)`, [key, JSON.stringify(value)]);
}

/** Every `accessLog:<source>` row, keyed by its source; a key that names no source is not a history. */
function historyRows(sql: SettingsSql): Map<string, string> {
  const rows = new Map<string, string>();
  for (const row of sql.select(`SELECT key, value FROM ${SETTINGS} WHERE ${PREFIX_WHERE} ORDER BY key`, [likePrefix(ACCESS_LOG_SETTING_PREFIX)])) {
    const source = sourceAppIdFromAccessLogSettingKey(String(row[0]));
    if (source !== undefined) rows.set(source, String(row[1]));
  }
  return rows;
}

function heldApps(sql: SettingsSql): ReadonlySet<string> {
  return new Set(sql.select(`SELECT app_id FROM ${USERDB_TABLES.apps}`).map((row) => String(row[0])));
}

const keyOf = (instant: number, kind: string, grantId: string, readerAppId: string): string => `${instant}\u0000${kind}\u0000${grantId}\u0000${readerAppId}`;

/** The natural key of a line — it carries no id (an older strict hub would skip a line that did). */
const naturalKey = (entry: AccessLogEntry): string => keyOf(Date.parse(entry.at), entry.kind, entry.grantId, entry.readerAppId);

/** A stored element's natural key read LOOSELY — no strict parse; `undefined` when a seat is missing. Equal to `naturalKey` of the element's strict parse. */
function looseKey(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const { at, kind, grantId, readerAppId } = item as Record<string, unknown>;
  if (typeof at !== 'string' || typeof kind !== 'string' || typeof grantId !== 'string' || typeof readerAppId !== 'string') return undefined;
  const instant = Date.parse(at);
  return Number.isNaN(instant) ? undefined : keyOf(instant, kind, grantId, readerAppId);
}

/** Whether a loser element would raise the winner element's count or rows — read loosely; `mergeCounts` decides on the strict parse. */
function wouldRaise(loser: unknown, winner: unknown): boolean {
  const { count, rows } = loser as { count?: unknown; rows?: unknown };
  const there = winner as { count?: unknown; rows?: unknown };
  const thereCount = typeof there.count === 'number' ? there.count : 1;
  return (typeof count === 'number' && count > thereCount) || (typeof rows === 'number' && (typeof there.rows !== 'number' || rows > there.rows));
}

/** A loser line the carry considers; `newer` — past `since` — may be carried, an older one may only merge into the winner's twin. */
interface Candidate {
  entry: AccessLogEntry;
  newer: boolean;
}

/**
 * The loser's lines a carry may consider, strictly readable: every line newer than `since` (−∞: every
 * line), and an older line whose natural key the winner's row holds (`twins`, keyed loosely) and
 * whose count or rows would raise the twin's. The loose checks first: an old line costs no strict
 * parse unless it can change the winner (the credential walk is the dear half).
 */
function candidatesOf(elements: readonly unknown[], since: number, twins: ReadonlyMap<string, unknown>): Candidate[] {
  const candidates: Candidate[] = [];
  for (const item of elements) {
    const newer = looseView(item).at > since;
    if (!newer) {
      const key = twins.size === 0 ? undefined : looseKey(item);
      const twin = key === undefined ? undefined : twins.get(key);
      if (twin === undefined || !wouldRaise(item, twin)) continue;
    }
    const parsed = accessLogEntrySchema.safeParse(item);
    if (parsed.success) candidates.push({ entry: parsed.data, newer });
  }
  return candidates;
}

/** The winner's elements by their loose natural key — the first element of a key, as `byKey` keeps the first. */
function twinsOf(stored: readonly unknown[]): Map<string, unknown> {
  const twins = new Map<string, unknown>();
  for (const item of stored) {
    const key = looseKey(item);
    if (key !== undefined && !twins.has(key)) twins.set(key, item);
  }
  return twins;
}

const NO_TWINS: ReadonlyMap<string, unknown> = new Map();

/** A carried line as the winner may hold it: a `wrote` line loses its `undoId` (the winner's journal has no such entry). */
function carriedForm(entry: AccessLogEntry): Record<string, unknown> {
  if (entry.undoId === undefined) return { ...entry };
  const { undoId: _gone, ...rest } = entry;
  return rest;
}

/** Fold a matching loser line into the winner's: count and rows become the max. Answers whether the winner's line changed. */
function mergeCounts(winner: Record<string, unknown>, loser: AccessLogEntry): boolean {
  let changed = false;
  const winnerCount = typeof winner.count === 'number' ? winner.count : 1;
  if (loser.count !== undefined && loser.count > winnerCount) {
    winner.count = loser.count;
    changed = true;
  }
  if (loser.rows !== undefined && (typeof winner.rows !== 'number' || loser.rows > winner.rows)) {
    winner.rows = loser.rows;
    changed = true;
  }
  return changed;
}

/**
 * The winner's row with the carried lines merged in, newest first: `carried` is sorted newest first,
 * the winner's elements keep their stored order, a tie takes the winner's line first, and an element
 * with no readable instant stays where the winner had it (it rides with the line before it).
 */
function mergeNewestFirst(winner: readonly unknown[], carried: readonly Record<string, unknown>[]): unknown[] {
  const incoming = [...carried].sort((a, b) => looseView(b).at - looseView(a).at);
  const merged: unknown[] = [];
  let next = 0;
  for (const item of winner) {
    const at = looseView(item).at;
    if (at !== Number.NEGATIVE_INFINITY) {
      while (next < incoming.length && looseView(incoming[next]).at > at) merged.push(incoming[next++]);
    }
    merged.push(item);
  }
  while (next < incoming.length) merged.push(incoming[next++]);
  return merged;
}

/** The carry's prune tiers: ONLY carried lines may go — reads first, then the rest, then a carried line that is the latest of its kind. */
function carriedFirst(carried: ReadonlySet<unknown>): readonly PruneTier[] {
  return [
    (view, guard, _held, item) => carried.has(item) && guard === undefined && view.kind === 'read',
    (_view, guard, _held, item) => carried.has(item) && guard === undefined,
    (_view, _guard, _held, item) => carried.has(item),
  ];
}

/** The carry's tiers never ask which grants the file holds — the winner's own lines are never a victim. */
const NO_GRANTS: ReadonlySet<string> = new Set();
const noHeldGrants = (): ReadonlySet<string> => NO_GRANTS;

// ----------------------------------------------------------------------- the carry

/** The access history the handle `sql` holds — read from the loser BEFORE a swap (the import) or from a pulled image (`carryFromImage`). */
export function snapshotLocalAccessHistory(sql: SettingsSql): AccessHistorySnapshot {
  const rows = new Map<string, readonly unknown[]>();
  for (const [source, raw] of historyRows(sql)) rows.set(source, looseEntries(raw));
  return { rows };
}

/**
 * Carry the loser's history lines newer than `since` (every line when `null`, or when `since` is not
 * an instant — losing a line is what the carry exists to prevent) into the WINNER `target`, and merge
 * the count of every loser line the winner also holds, whatever its `at`. Total over the data: a
 * malformed row or a full history never throws — the carried lines give way instead; only an engine
 * failure of the write itself propagates, as every import pass's does (`carryFromImage` rolls it
 * back). Only rows that changed are written — and counted as `rewritten` — so a pull with nothing
 * to carry is byte-identical.
 */
export function carryAccessHistory(target: SettingsSql, snapshot: AccessHistorySnapshot, options: { since: string | null }): AccessHistoryCarry {
  const parsedSince = options.since === null ? Number.NaN : Date.parse(options.since);
  const since = Number.isNaN(parsedSince) ? Number.NEGATIVE_INFINITY : parsedSince;
  let dropped = 0;
  let held: ReadonlySet<string> | undefined;
  let winnerRows: Map<string, string> | undefined;
  /** Every carried line still in a row — by identity, so the tiers can name them. */
  const carried = new Set<unknown>();
  /** The rows the carry touched, and those whose winner lines a merge changed. */
  const touched = new Map<string, unknown[]>();
  const recounted = new Set<string>();

  for (const [source, elements] of snapshot.rows) {
    if (elements.length === 0) continue;
    held ??= heldApps(target);
    if (!held.has(source)) {
      dropped += candidatesOf(elements, since, NO_TWINS).length; // a history never names an app the file does not hold
      continue;
    }
    winnerRows ??= historyRows(target);
    const stored = looseEntries(winnerRows.get(source));
    const candidates = candidatesOf(elements, since, twinsOf(stored));
    if (candidates.length === 0) continue;
    const byKey = new Map<string, Record<string, unknown>>();
    for (const item of stored) {
      const parsed = accessLogEntrySchema.safeParse(item);
      const key = parsed.success ? naturalKey(parsed.data) : undefined;
      if (key !== undefined && !byKey.has(key)) byKey.set(key, item as Record<string, unknown>);
    }
    const added: Record<string, unknown>[] = [];
    for (const { entry: candidate, newer } of candidates) {
      const key = naturalKey(candidate);
      const match = byKey.get(key);
      if (match !== undefined) {
        if (mergeCounts(match, candidate)) recounted.add(source);
        continue;
      }
      if (!newer) continue; // an older line only merges: one the winner lacks obeys `since`
      const line = carriedForm(candidate);
      byKey.set(key, line);
      added.push(line);
      carried.add(line);
    }
    if (added.length === 0 && !recounted.has(source)) continue;
    const merged = mergeNewestFirst(stored, added);
    touched.set(source, merged);
    // The per-source caps: entries, then bytes — only carried lines give way.
    const rowFits = (): boolean => merged.length <= ACCESS_LOG_MAX_ENTRIES && bytesOf(merged) <= ACCESS_LOG_MAX_BYTES;
    pruneToFit(new Map([[source, merged]]), rowFits, {
      heldGrants: noHeldGrants,
      tiers: carriedFirst(carried),
      onPruned: (_source, _entries, removed) => {
        carried.delete(removed);
        dropped += 1;
      },
    });
  }

  if (carried.size > 0) {
    // The ceiling across every source: the stored bytes of each row, the touched ones as merged.
    const sizes = new Map<string, number>();
    for (const row of target.select(`SELECT key, LENGTH(CAST(value AS BLOB)) FROM ${SETTINGS} WHERE ${PREFIX_WHERE}`, [likePrefix(ACCESS_LOG_SETTING_PREFIX)])) {
      sizes.set(String(row[0]), Number(row[1] ?? 0));
    }
    for (const [source, entries] of touched) sizes.set(accessLogSettingKey(source), bytesOf(entries));
    let total = 0;
    for (const size of sizes.values()) total += size;
    if (total > ACCESS_LOG_TOTAL_MAX_BYTES) {
      pruneToFit(touched, () => total <= ACCESS_LOG_TOTAL_MAX_BYTES, {
        heldGrants: noHeldGrants,
        tiers: carriedFirst(carried),
        onPruned: (source, entries, removed) => {
          const key = accessLogSettingKey(source);
          const after = bytesOf(entries);
          total -= (sizes.get(key) ?? after) - after;
          sizes.set(key, after);
          carried.delete(removed);
          dropped += 1;
        },
      });
    }
  }

  let rewritten = 0;
  for (const [source, entries] of touched) {
    if (!recounted.has(source) && !entries.some((item) => carried.has(item))) continue;
    writeRow(target, accessLogSettingKey(source), entries);
    rewritten += 1;
  }
  return { carried: carried.size, dropped, rewritten };
}

// ----------------------------------------------------------------------- the stops

/**
 * A stop wins: every grant row of `target` whose id is in `revoked` — active, suspended or unreadable
 * — becomes that full revoked row, verbatim. A row `target` already holds revoked stays (the stop has
 * won there), and an id `target` holds no row for is not planted. Answers how many rows were replaced.
 */
export function applyTombstones(target: SettingsSql, revoked: ReadonlyMap<string, AccessGrant>): number {
  let replaced = 0;
  for (const [grantId, row] of revoked) {
    // A belt over the caller's map: only a revoked row, under its own id, is ever written back.
    if (row.id !== grantId || row.status !== 'revoked') continue;
    const key = accessGrantSettingKey(grantId);
    const raw = rawValue(target, key);
    if (raw === undefined) continue;
    const there = parseAccessGrant(raw);
    if (there !== undefined && there.id === grantId && there.status === 'revoked') continue;
    writeRow(target, key, row);
    replaced += 1;
  }
  return replaced;
}
