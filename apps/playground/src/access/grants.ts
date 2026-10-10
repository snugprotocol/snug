// access/grants.ts — the access grants the engine holds and changes from the HOST side
// (TASK-20261010-cross-app-access AC11–AC14; ADR-0075 §2, §3, §9; D5, D6, D25).
//
// TWO KINDS OF GRANT, ONE SHAPE. *For a day*, *for a week* and *until I stop it* persist as
// `accessGrant:<id>` rows in the user's file (the db accessors parse before they write). *While
// it's open* — the default — is a MEMORY grant: the same record (validated through the same
// strict schema, then given `duration: { kind: 'session' }`), never written, bound to the
// reader's frame GENERATION (host-owned — an app's re-announce cannot mint a fresh one). It dies
// when the reader's view closes (the live host retracts), when a newer generation of the reader
// is composed, and at every session reset.
//
// WHAT CHANGES A GRANT, AND WHO HEARS. Every writer here keeps D25's invariants — `suspended` ⇔
// `suspendedReason`, `revoked` ⇔ `revokedAt`, both cleared when a grant goes back to `active` —
// writes ONE history line on the SOURCE's row (the source keeps the history, Q14), drops the
// grant's cached bytes, rings the reader's LIVE frame `access-changed { grantId }` (ids only —
// a hint, never content: ADR-0034) and bumps `accessRevisionStore` so every sheet re-reads.
// `expired` is never stored: it is derived from the duration at every read, and marked in the
// history ONCE.
//
// THE SESSION STATE this module keeps — memory grants, the reader generations, the per-app query
// windows, the expired marks — is dropped by `resetAccessSession`, the file-swap seam, together
// with consent.ts's pending asks and scopedRead.ts's cache.
//
// LOAD ORDER. This engine sits inside import cycles — the file-swap seams (`state/net.ts`,
// `state/userdb.ts`, `state/library.ts`, `state/sync.ts`) import this module for
// `resetAccessSession`, and their own graphs reach the run runtime that composes the handler —
// so NO module under access/ calls another access module at its top level: only leaf modules
// (the stores) are touched while modules load, and everything else is reached inside functions.
// (The egress rules come from the leaf `run/appCapabilityRules.ts`, not through the runtime.)
//
// THE RETRACT LISTENER is armed on USE (`armAccessListeners` — a handler composed, a grant
// made, an ask parked), never at module load: a load-time subscription is a side effect, and a
// test reset of the app-host registry would silently strip it for the rest of a suite. Each arm
// drops the previous subscription and subscribes again, so there is always exactly one.

import {
  ACCESS_CHANGED_EVENT,
  ACCESS_QUERY_RATE_PER_MINUTE,
  accessGrantSchema,
  durationFromExpiry,
  durationToExpiry,
  type AccessDuration,
  type AccessGrant,
  type AccessGrantDuration,
  type AccessGrantView,
  type AccessLogEntry,
  type AccessProvenance,
  type AccessSuspendReason,
} from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { notifyAppHost, subscribeAppHosts } from '../state/appHosts.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { createStore, useStore, type Store } from '../state/store.js';
import { getUserDb } from '../state/userdb.js';
import { dismissPendingAccess, resetConsentSession } from './consent.js';
import type { SourceApp } from './relevance.js';
import { clearScopedReadCache } from './scopedRead.js';

// ---------------------------------------------------------------------------------------- types

/** A memory grant: the persisted record's shape with the one duration that never persists. */
export type SessionAccessGrant = Omit<AccessGrant, 'duration'> & { duration: { kind: 'session' } };
export type AnyAccessGrant = AccessGrant | SessionAccessGrant;

/** A grant as the engine finds it: persisted, or in memory with the generation it is bound to. */
export interface FoundAccessGrant {
  grant: AnyAccessGrant;
  session: boolean;
  /** Session grants only; `undefined` = made from host chrome while the app was closed — it binds to the next frame. */
  generation?: number;
}

/** One row of an app's access, either direction — what the sheets render. */
export interface LiveGrantRow extends FoundAccessGrant {
  duration: AccessDuration;
  expiresAt?: string;
  /** Derived from the duration — never stored. */
  expired: boolean;
  /** Active, not expired, and its source holds no WhatsApp fact. */
  live: boolean;
  readerName: string;
  sourceName: string;
}

// ----------------------------------------------------------------------------------------- deps

export interface AccessDeps {
  getDb: () => Promise<UserDb>;
  now: () => number;
}

const defaultDeps = (): AccessDeps => ({ getDb: getUserDb, now: Date.now });
let deps: AccessDeps = defaultDeps();

/** The engine's file and clock — every module under access/ reads them here, at the call. */
export function accessDeps(): AccessDeps {
  return deps;
}

/** Test seam: hold the clock, hand over the db. No argument restores the defaults. */
export function __setAccessDepsForTests(over?: Partial<AccessDeps>): void {
  deps = { ...defaultDeps(), ...over };
}

// ------------------------------------------------------------------------------------ revision

/** Bumped on every change to any grant or history — the sheets subscribe and re-read. */
export const accessRevisionStore: Store<number> = createStore<number>(0);

export function bumpAccessRevision(): void {
  accessRevisionStore.set(accessRevisionStore.get() + 1);
}

export function useAccessRevision(): number {
  return useStore(accessRevisionStore);
}

// ------------------------------------------------------------------------------- session state

const sessions = new Map<string, { grant: SessionAccessGrant; generation: number | undefined }>();
/** The generation of each reader's attended frame, as last composed. */
const readerGenerations = new Map<string, number>();
/** Per app: the instants of the queries inside the last minute. */
const queryWindows = new Map<string, number[]>();
/** Grants whose `expired` line is written (the history check is the durable half). */
const expiredMarked = new Set<string>();
/**
 * How many times each reader's frame state has ENDED — its view closed, or a session reset for
 * it — plus `allEnds` for the resets of every app. Only ever grows (never cleared, so a sum can
 * never repeat): an ask compares it across its own await to learn that the frame it came from is
 * gone, even when the next frame of the same id reuses the same generation number.
 */
const frameEnds = new Map<string, number>();
let allEnds = 0;

const QUERY_WINDOW_MS = 60_000;
const iso = (at: number): string => new Date(at).toISOString();

/** The reader's attended frame generation, when one is open — a session grant made from host chrome binds to it (or, absent, to the next frame). */
export function readerGeneration(appId: string): number | undefined {
  return readerGenerations.get(appId);
}

/** A counter that moves whenever the reader's frame state ends (see `frameEnds`). */
export function readerFrameEnds(appId: string): number {
  return allEnds + (frameEnds.get(appId) ?? 0);
}

/** The reader's view closed: its session grants end with it ("while it's open"), and its app ask has nobody to answer. */
function onAppHostChange(appId: string, live: boolean): void {
  if (live) return;
  frameEnds.set(appId, (frameEnds.get(appId) ?? 0) + 1);
  readerGenerations.delete(appId);
  if (dropSessionsWhere((grant) => grant.readerAppId === appId)) bumpAccessRevision();
  // The user's own ask stays — they may be in Settings.
  dismissPendingAccess(appId, { onlyApp: true });
}

let disarm: (() => void) | undefined;

/** Subscribe the retract listener — again, if a reset of the registry dropped it. Idempotent: always exactly one subscription. */
export function armAccessListeners(): void {
  disarm?.();
  disarm = subscribeAppHosts(onAppHostChange);
}

/**
 * The reader's attended frame is now `generation` (the run view composed it). A session grant
 * made from host chrome while the app was closed binds to it; a session grant of any OTHER
 * generation died with its frame and is dropped.
 */
export function noteReaderGeneration(appId: string, generation: number): void {
  armAccessListeners();
  readerGenerations.set(appId, generation);
  let dropped = false;
  for (const [id, entry] of sessions) {
    if (entry.grant.readerAppId !== appId) continue;
    if (entry.generation === undefined) entry.generation = generation;
    else if (entry.generation !== generation) {
      sessions.delete(id);
      clearScopedReadCache(id);
      dropped = true;
    }
  }
  if (dropped) bumpAccessRevision();
}

function dropSessionsWhere(predicate: (grant: SessionAccessGrant) => boolean): boolean {
  let dropped = false;
  for (const [id, entry] of sessions) {
    if (!predicate(entry.grant)) continue;
    sessions.delete(id);
    clearScopedReadCache(id);
    dropped = true;
  }
  return dropped;
}

/**
 * The file-swap seam (and an app's delete): drop the memory grants, the limiters, the pending
 * asks (dismissed — nothing recorded) and the scoped cache — for ONE app (as reader or source)
 * or, with no argument, for every app.
 */
export function resetAccessSession(appId?: string): void {
  if (appId === undefined) {
    allEnds += 1;
    sessions.clear();
    readerGenerations.clear();
    queryWindows.clear();
    expiredMarked.clear();
  } else {
    frameEnds.set(appId, (frameEnds.get(appId) ?? 0) + 1);
    dropSessionsWhere((grant) => grant.readerAppId === appId || grant.sourceAppId === appId);
    readerGenerations.delete(appId);
    queryWindows.delete(appId);
  }
  clearScopedReadCache();
  resetConsentSession(appId);
  bumpAccessRevision();
}

/** ≤ `ACCESS_QUERY_RATE_PER_MINUTE` queries a minute per app: true when this one is over (and it is not counted). */
export function queryRateLimited(appId: string, at: number): boolean {
  const recent = (queryWindows.get(appId) ?? []).filter((instant) => at - instant < QUERY_WINDOW_MS);
  if (recent.length >= ACCESS_QUERY_RATE_PER_MINUTE) {
    queryWindows.set(appId, recent);
    return true;
  }
  recent.push(at);
  queryWindows.set(appId, recent);
  return false;
}

// ------------------------------------------------------------------------------ derived facts

/** The duration the user chose. A persisted `until` reads `day` or `week` by the protocol's own inverse of `durationToExpiry`. */
export function durationOf(grant: AnyAccessGrant): AccessDuration {
  if (grant.duration.kind === 'session') return 'session';
  if (grant.duration.kind === 'always') return 'always';
  return durationFromExpiry(grant.grantedAt, grant.duration.at);
}

export function expiresAtOf(grant: AnyAccessGrant): string | undefined {
  return grant.duration.kind === 'until' ? grant.duration.at : undefined;
}

export function isExpired(grant: AnyAccessGrant, now: number): boolean {
  const at = expiresAtOf(grant);
  return at !== undefined && Date.parse(at) <= now;
}

/** Usable right now: active, not expired, and its source holds no WhatsApp fact (D6 — checked at every read). */
export function isLive(grant: AnyAccessGrant, now: number, db: UserDb): boolean {
  return grant.status === 'active' && !isExpired(grant, now) && !appHasSidecarFact(db, grant.sourceAppId);
}

/** A grant by id — in memory first, then the file. An id the file cannot key reads as absent. */
export function findAccessGrant(db: UserDb, grantId: string): FoundAccessGrant | undefined {
  const session = sessions.get(grantId);
  if (session !== undefined) return { grant: session.grant, session: true, generation: session.generation };
  try {
    const grant = db.getAccessGrant(grantId);
    return grant === undefined ? undefined : { grant, session: false };
  } catch {
    return undefined;
  }
}

/**
 * What the reader LEARNS about a grant (ADR-0075 §5): the source's library name and tile, the
 * tables with their columns, the duration. THROWS when the source has no library row — a view
 * with no name would be refused by the reader's own parser and the call would never settle, so
 * the caller answers a host error instead (W6 finding 10).
 */
export function grantView(db: UserDb, grant: AnyAccessGrant): AccessGrantView {
  const source = db.getApp(grant.sourceAppId);
  if (source === undefined) throw new Error('the other app is not in this file');
  const expiresAt = expiresAtOf(grant);
  return {
    id: grant.id,
    access: grant.access,
    source: {
      displayName: source.displayName,
      ...(source.iconEmoji !== undefined ? { iconEmoji: source.iconEmoji } : {}),
      ...(source.iconColor !== undefined ? { iconColor: source.iconColor } : {}),
    },
    tables: grant.scope.tables.map((table) => ({ name: table.name, columns: [...table.columns] })),
    duration: durationOf(grant),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    unattended: grant.unattended,
  };
}

/**
 * Every grant the app is part of, both directions, persisted and in memory, with the derived facts.
 * Left out: a STOPPED session grant (its tombstone only answers the reader `ACCESS_REVOKED` until
 * its frame ends — there is nothing to renew or remove), and a grant whose reader or source has no
 * library row (it can be neither shown nor described to the reader — W6 finding 10).
 */
export function grantsForApp(db: UserDb, appId: string, now: number): { reads: LiveGrantRow[]; readBy: LiveGrantRow[] } {
  const found: FoundAccessGrant[] = [
    ...db.listAccessGrants().map((grant) => ({ grant, session: false })),
    ...[...sessions.values()]
      .filter((entry) => entry.grant.status !== 'revoked')
      .map((entry) => ({ grant: entry.grant, session: true, generation: entry.generation })),
  ].filter((entry) => db.getApp(entry.grant.readerAppId) !== undefined && db.getApp(entry.grant.sourceAppId) !== undefined);
  const nameOf = (id: string): string => db.getApp(id)?.displayName ?? '';
  const row = (entry: FoundAccessGrant): LiveGrantRow => {
    const expiresAt = expiresAtOf(entry.grant);
    return {
      ...entry,
      duration: durationOf(entry.grant),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      expired: isExpired(entry.grant, now),
      live: isLive(entry.grant, now, db),
      readerName: nameOf(entry.grant.readerAppId),
      sourceName: nameOf(entry.grant.sourceAppId),
    };
  };
  return {
    reads: found.filter((entry) => entry.grant.readerAppId === appId).map(row),
    readBy: found.filter((entry) => entry.grant.sourceAppId === appId).map(row),
  };
}

// ------------------------------------------------------------------------------------- writers

/** Write a grant back where it lives — the file, or memory. */
function store(db: UserDb, found: FoundAccessGrant, next: AnyAccessGrant): void {
  if (found.session) {
    const entry = sessions.get(next.id);
    if (entry !== undefined) entry.grant = next as SessionAccessGrant;
    return;
  }
  db.putAccessGrant(next as AccessGrant);
}

/** A lifecycle line on the SOURCE's history, named by the reader's library row. */
function lifecycleLine(db: UserDb, grant: AnyAccessGrant, kind: AccessLogEntry['kind'], at: string, extra: Partial<AccessLogEntry> = {}): AccessLogEntry {
  return {
    at,
    kind,
    grantId: grant.id,
    readerAppId: grant.readerAppId,
    readerName: db.getApp(grant.readerAppId)?.displayName ?? grant.readerAppId,
    ...extra,
  };
}

/** Best effort for an END of access: stopping must never fail because the history is full. */
function logQuietly(db: UserDb, sourceAppId: string, entry: AccessLogEntry): void {
  try {
    db.appendAccessLog(sourceAppId, entry);
  } catch {
    // the stop still holds; the history refused the line (its caps) — never a reason to keep access alive
  }
}

/** `status: 'active'` with both D25 seats cleared. */
function withoutEndings<G extends AnyAccessGrant>(grant: G): G {
  const { suspendedReason: _reason, revokedAt: _revoked, ...rest } = grant;
  return rest as G;
}

/** Ring the reader's LIVE frame: `access-changed { grantId }` — ids only. Silent when it is not open. */
export function ringReader(readerAppId: string, grantId: string): void {
  notifyAppHost(readerAppId, ACCESS_CHANGED_EVENT, { grantId });
}

export interface CreateGrantInput {
  readerAppId: string;
  /** The source as the consent sheet DISCLOSED it — its tables and their columns (a `RankedSource` satisfies it). */
  source: SourceApp;
  /** The tables the user ticked. */
  tables: readonly string[];
  duration: AccessDuration;
  unattended: boolean;
  purpose: string;
  provenance: AccessProvenance;
  /** Session grants: the reader's frame generation; absent = the next frame that opens. */
  generation?: number;
  now: number;
  /** A grant being allowed again: re-activated in place when it is this pair's and not stopped. */
  renew?: string;
}

/**
 * THE writer behind the user's *allow* (never the app's): a persisted grant for day/week/always,
 * a memory grant for the session; the scope is the ticked tables with their NON-sensitive columns
 * exactly as disclosed (D23 — a credential-named column is never in a scope); a `granted` line on
 * the source. Refuses (throws, nothing written) a source that is the asking app, a source the file
 * does not hold or that holds a WhatsApp fact, and a choice naming no table — or a table the
 * source did not offer, or one with no shareable column. A suspended or expired grant of the same
 * pair named by `renew` is re-activated in place (D25: its reason cleared); a stopped one is never
 * re-armed.
 */
export async function createGrantFromDecision(db: UserDb, input: CreateGrantInput): Promise<AnyAccessGrant> {
  armAccessListeners();
  const reader = db.getApp(input.readerAppId);
  if (reader === undefined) throw new Error('the asking app is not in this file');
  if (input.source.appId === input.readerAppId) throw new Error('an app never needs access to itself');
  if (db.getApp(input.source.appId) === undefined) throw new Error('the other app is not in this file');
  if (appHasSidecarFact(db, input.source.appId)) throw new Error('that app keeps messages from others to itself');

  const chosen = [...new Set(input.tables)];
  if (chosen.length === 0) throw new Error('choose at least one table');
  const tables = chosen.map((name) => {
    const offered = input.source.tables.find((table) => table.name === name);
    if (offered === undefined) throw new Error(`the other app offers no table "${name}"`);
    const columns = offered.columns.filter((column) => !column.sensitive).map((column) => column.name);
    if (columns.length === 0) throw new Error(`"${name}" has nothing that can be read`);
    return { name, columns };
  });

  const at = iso(input.now);
  // `durationToExpiry` answers no instant for exactly the durations that never expire (the session, always).
  const expiry = durationToExpiry(input.duration, input.now);
  const persistedDuration: AccessGrantDuration = expiry === undefined ? { kind: 'always' } : { kind: 'until', at: expiry };

  const renewing = input.renew === undefined ? undefined : findAccessGrant(db, input.renew);
  const inPlace: AccessGrant | undefined =
    renewing !== undefined &&
    !renewing.session &&
    input.duration !== 'session' &&
    renewing.grant.readerAppId === input.readerAppId &&
    renewing.grant.sourceAppId === input.source.appId &&
    renewing.grant.status !== 'revoked'
      ? (renewing.grant as AccessGrant)
      : undefined;

  const record = accessGrantSchema.parse({
    ...(inPlace !== undefined ? withoutEndings(inPlace) : { reads: 0 }),
    id: inPlace?.id ?? crypto.randomUUID(),
    readerAppId: input.readerAppId,
    sourceAppId: input.source.appId,
    scope: { tables },
    access: 'read',
    purpose: input.purpose,
    duration: persistedDuration,
    unattended: input.unattended,
    status: 'active',
    provenance: input.provenance,
    readerVersion: reader.currentVersion,
    grantedAt: at,
    updatedAt: at,
    timeouts: 0,
  });

  let grant: AnyAccessGrant;
  if (input.duration === 'session') {
    const session: SessionAccessGrant = { ...record, duration: { kind: 'session' } };
    sessions.set(session.id, { grant: session, generation: input.generation });
    grant = session;
  } else {
    db.putAccessGrant(record);
    grant = record;
  }

  try {
    db.appendAccessLog(input.source.appId, lifecycleLine(db, grant, 'granted', at, { tables: tables.map((table) => table.name) }));
  } catch (err) {
    // The history must never lack the line that says when access began: undo the grant.
    if (grant.duration.kind === 'session') sessions.delete(grant.id);
    else if (inPlace !== undefined) db.putAccessGrant(inPlace);
    else db.deleteAccessGrant(grant.id);
    throw err;
  }
  expiredMarked.delete(grant.id);
  clearScopedReadCache(grant.id);
  bumpAccessRevision();
  return grant;
}

/**
 * Stop or give back: `revoked` + `revokedAt`, the history line, the ring, the bump. False when
 * already stopped. A SESSION grant keeps a revoked TOMBSTONE in memory (W6 finding 8): its reader's
 * next `query` answers `ACCESS_REVOKED` like any stopped grant, never the "ask first" of an unknown
 * id; the tombstone is dropped with its frame (retract, newer generation, session reset) like the
 * grant was, and the sheets never list it.
 */
function endGrant(db: UserDb, found: FoundAccessGrant, kind: 'revoked' | 'released', at: string): boolean {
  if (found.grant.status === 'revoked') return false;
  store(db, found, { ...withoutEndings(found.grant), status: 'revoked', revokedAt: at, updatedAt: at });
  logQuietly(db, found.grant.sourceAppId, lifecycleLine(db, found.grant, kind, at));
  clearScopedReadCache(found.grant.id);
  ringReader(found.grant.readerAppId, found.grant.id);
  bumpAccessRevision();
  return true;
}

/** The host's *stop* (either app's sheet, Settings, the strip's undo). Unknown or already-stopped: nothing changes. */
export async function revokeAccess(grantId: string): Promise<void> {
  const db = await deps.getDb();
  const found = findAccessGrant(db, grantId);
  if (found === undefined) return;
  endGrant(db, found, 'revoked', iso(deps.now()));
}

/** The reader's own `release`: only its own grant, never one already stopped. */
export async function releaseAccess(readerAppId: string, grantId: string): Promise<'released' | 'not-granted'> {
  const db = await deps.getDb();
  const found = findAccessGrant(db, grantId);
  if (found === undefined || found.grant.readerAppId !== readerAppId) return 'not-granted';
  return endGrant(db, found, 'released', iso(deps.now())) ? 'released' : 'not-granted';
}

/**
 * Pause a LIVE grant (active, not expired) for `reason`: the suspended row, a `suspended` line
 * with the reason on the source, the ring, the bump. False — nothing written — when the grant is
 * unknown, stopped, already paused or expired.
 */
export async function suspendAccess(db: UserDb, grantId: string, reason: AccessSuspendReason, now: string): Promise<boolean> {
  const found = findAccessGrant(db, grantId);
  if (found === undefined || found.grant.status !== 'active' || isExpired(found.grant, Date.parse(now))) return false;
  store(db, found, { ...withoutEndings(found.grant), status: 'suspended', suspendedReason: reason, updatedAt: now });
  logQuietly(db, found.grant.sourceAppId, lifecycleLine(db, found.grant, 'suspended', now, { reason }));
  clearScopedReadCache(grantId);
  ringReader(found.grant.readerAppId, grantId);
  bumpAccessRevision();
  return true;
}

/** Write the `expired` line once per grant (memory, then the history itself). True when it wrote it. */
export function markExpiredOnce(db: UserDb, grant: AnyAccessGrant, now: number): boolean {
  if (!isExpired(grant, now) || expiredMarked.has(grant.id)) return false;
  expiredMarked.add(grant.id);
  if (db.listAccessLog(grant.sourceAppId).some((entry) => entry.kind === 'expired' && entry.grantId === grant.id)) return false;
  logQuietly(db, grant.sourceAppId, lifecycleLine(db, grant, 'expired', iso(now)));
  bumpAccessRevision();
  return true;
}

/**
 * The connection-approve / import seam (AC14, D6): a source that now holds a WhatsApp fact
 * suspends every LIVE grant that reads it `source-restricted`. Answers how many paused.
 */
export async function suspendIfSourceRestricted(db: UserDb, sourceAppId: string, now: string): Promise<number> {
  if (!appHasSidecarFact(db, sourceAppId)) return 0;
  const at = Date.parse(now);
  const ids = [
    ...db.listAccessGrants().filter((grant) => grant.sourceAppId === sourceAppId),
    ...[...sessions.values()].map((entry) => entry.grant).filter((grant) => grant.sourceAppId === sourceAppId),
  ]
    .filter((grant) => grant.status === 'active' && !isExpired(grant, at))
    .map((grant) => grant.id);
  let paused = 0;
  for (const id of ids) if (await suspendAccess(db, id, 'source-restricted', now)) paused += 1;
  return paused;
}

/**
 * A read happened: `reads` + 1, `lastReadAt`, and the consecutive-timeout count back to 0 — on the
 * grant as it is NOW (a read takes up to the wall clock; a stop that landed meanwhile must never
 * be written back over, and two reads must both count).
 */
export function noteRead(db: UserDb, grantId: string, at: string): void {
  const fresh = findAccessGrant(db, grantId);
  if (fresh === undefined) return;
  store(db, fresh, { ...fresh.grant, reads: fresh.grant.reads + 1, lastReadAt: at, timeouts: 0 });
  bumpAccessRevision();
}

/** A read outran the clock: the consecutive count on the grant as it is NOW, persisted with it. Answers the new count (0: the grant is gone). */
export function noteTimeout(db: UserDb, grantId: string): number {
  const fresh = findAccessGrant(db, grantId);
  if (fresh === undefined) return 0;
  const timeouts = fresh.grant.timeouts + 1;
  store(db, fresh, { ...fresh.grant, timeouts });
  return timeouts;
}
