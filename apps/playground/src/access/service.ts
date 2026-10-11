// access/service.ts — the Access Service: the ONE engine every door reads through
// (TASK-20261010-host-broker PR-2 AC9–AC10; ADR-0076 §1–§3; contract v2 D-PR2-1 effects named by
// the policy, performed here · D-PR2-5 the minute is a frame-only effect · D-PR2-7 · D-PR2-18;
// PR-3 ADR-0076 §4–§8; D-PR3-14 the three verbs · D-PR3-20 (d) the read's doorbell · D-PR3-21
// `discover` as a class; v2.1 notes E1-Q3/Q6/Q10, E2-Q3).
//
// THREE CALLERS, ONE BODY. The app's FRAME (`accessHandler.ts`), the CHAT beside the app and a
// SCHEDULE's step all come here with an `AccessCaller`; the policy (`policy.ts`) answers the
// verdict and this module PERFORMS what the verdict names — the `refused` line, the `expired`
// mark, the `source-restricted` pause — exactly where the handler performed it before PR-2 and
// nowhere else: `list` writes nothing, `release` performs no effect.
//
// `read` is the handler's former `query` body, byte-identical for a frame but for policy rule 4's
// one named invert (a session grant is never read with nobody present, whatever *also while I'm
// away* says): the per-app minute
// FIRST — every op counts, refused, unknown or not, so no frame can write history lines (or spend
// the host's work) faster than the limit; a frame-only effect, the chat being bounded by the
// user's turns and the schedule by its run ceilings (D-PR2-5) — then the verdict and its effect,
// then ONE read-only SELECT through the Worker under its wall clock (three consecutive timeouts
// pause the grant `reader-misbehaved`; a column change pauses it `source-changed`), the grant
// re-checked when the read dequeues (`stillReadable`, the policy's one spelling) and again when
// it answers (a stop or a pause that landed meanwhile wins — no rows leave), the cells MASKED by
// column name, the `read` line on the SOURCE's history — written BEFORE the rows leave, so a read
// the history could not record never happens — and the counters. `list` and `materialise` share
// ONE admission (`admitted`: the caller's rows the policy admits for `materialise`, nothing
// performed — the policy is the only rule); `release` gives back the caller's own grant.
//
// `materialise` is the chat's and the schedule's door (D-PR2-6, D-PR2-7): every grant the caller
// owns and may read — `read`'s own admission, rule by rule, performing nothing — is DUMPED
// through the Worker (`materialise.ts`: the recorded columns of each granted table under the
// caps, aliased `<alias>__<table>`, re-checked when the dump answers) and NO history line is
// written: the DDL block a brain then sees carries names, types and counts, the `list`-class
// disclosure. The one effect a dump names is performed here as a read performs it — a source
// whose columns changed since consent is paused `source-changed`. `recordRead` is the line BEFORE
// rows reach a brain: ONE `read` line per named grant — the posture, EVERY granted table, the rows
// handed over, the statement as the history keeps it — after re-checking the grant is still
// owned, active and unexpired (else `ended`), and `noteRead`; a line the history refuses answers
// `failed`, and the caller hands out only the tables of the ids answered `recorded`. Neither
// throws (D-PR2-18): a grant-level failure is a skip with its reason; a failure of the whole call
// answers the empty set with one skip naming the reader (its name folded to one line, as every
// name a brain reads is — `oneLine`), and the turn proceeds without shared tables.
//
// THE THREE VERBS OF PR-3 (D-PR3-14). `write` is a frame's one plain statement on a table the user
// let it change: the per-app minute FIRST — a write counts in the same window as a read, refused
// or not (E1-Q6) — then the table read off the statement's verb (`dmlTargetTable`; a statement
// that names none is not one plain INSERT, UPDATE or DELETE and is refused `statement` HERE,
// before any verdict — Gate-5 ENG-2), then the policy's `write` verdict (rules 1–3, attendance
// REQUIRED, the WhatsApp fact, the named table's `write`), then the Write Broker (`writeBroker.ts`: the plan on a fresh export, the seat, the journal, the
// `wrote` line, the doorbells) whose answer is the wire's. `refresh` is the policy's `refresh`
// verdict (rules 1–5 as a read, then the grant's `refresh` seat), then the refresh engine
// (`refresh.ts`: the three gates, the cooldown, the dispatch, the `refreshed` line) reached with
// `appRun.ts`'s `defaultAppRunDeps` through ONE lazy edge — the executors' pattern, so no
// top-level cycle through the run runtime is added (F8) — and its outcome IS the wire's shape.
// `discover` is the `ask`'s presence verdict, then a per-reader cache of the CLASS of what the
// library holds for `ACCESS_DISCOVER_CACHE_MS` (E1-Q10: keyed by the reader's app id, read with the
// engine's clock, and dropped by `resetAccessSession` — each entry carries the reader's frame-ends
// counter it was made at, which every reset moves, so a reset's entry is unreachable without this
// module holding a hook into grants.ts, D-IE1-2); a miss runs the same gather `request` runs and
// answers `none` · `one` · `several` — nothing recorded, nothing parked, `request`'s window
// untouched. The cache holds the IN-FLIGHT gather too (Gate-5 SEC-3): a miss parks its promise
// before the first export, concurrent calls await that one promise, and a gather that throws
// leaves no entry behind — eight asks at once are one walk of the library, not eight. A refusal's named effect is performed on a `read` ONLY (E1-Q3): a refused write,
// refresh or discover leaves the history and the grant exactly as they were.
//
// THE READ'S DOORBELL (D-PR3-20 (d)): after a frame's read is logged, and after each grant a chat
// turn's `recordRead` recorded, the SOURCE's live frame hears `access-read { grantId }` —
// uncoalesced, ids only. The scope a read or a dump is copied under is `readScopeOf(grant)`: the
// record's tables plus `snug_kv` when the user allowed the source's settings & notes (D-PR3-22).
//
// ONE INSTANCE over `accessDeps()` — the engine's file and clock, read at every call — behind a
// test seam in the `__setAccessDepsForTests` pattern: `__setAccessServiceForTests({ materialise })`
// overrides the named acts for every holder of `accessService()`, and no argument restores the
// real body. App-facing messages are `copy.ts`'s `ACCESS_APP_MESSAGES` — never a fact about
// another app the caller was not granted. Errors are data; what throws here is answered
// `HOST_ERROR` by the handler's own catch.
//
// LOAD ORDER (grants.ts's rule): nothing here calls another access module at the top level; the
// instance is built on first use.

import {
  ACCESS_DISCOVER_CACHE_MS,
  ACCESS_ERROR_CODES,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_MAX_RESULT_BYTES,
  ACCESS_MAX_ROWS,
  ACCESS_TIMEOUT_STRIKES,
  isCredentialKeyName,
  scanForCredentialValues,
  type AccessCandidateClass,
  type AccessDuration,
  type AccessHints,
  type AccessLogVia,
  type AccessWriteAuthority,
} from '@snugprotocol/protocol';
import { dmlTargetTable, type UserDb } from '@snugprotocol/db';
import type { AccessHandlerResult } from '@snugprotocol/runner';

import { oneLine } from '../agent/sharedDdl.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { collectSources } from './consent.js';
import { ACCESS_APP_MESSAGES } from './copy.js';
import { ringRead } from './doorbell.js';
import { isExpired } from './grantFacts.js';
import {
  accessDeps,
  findAccessGrant,
  grantView,
  grantsForApp,
  iso,
  markExpiredOnce,
  noteRead,
  noteTimeout,
  queryRateLimited,
  readerFrameEnds,
  readerNameOf,
  releaseAccess,
  suspendAccess,
  type FoundAccessGrant,
  type LiveGrantRow,
} from './grants.js';
import { SourceTooLarge, materialiseGrants, readScopeOf, sourceBytesOf } from './materialise.js';
import { attendedFor, authorise, ownsGrant, stillReadable, type AccessCaller, type PolicyContext, type Refusal } from './policy.js';
import { scopedDump, scopedRead } from './scopedRead.js';
import { appendLine, brokeredWrite, loggedSql, writeRefused } from './writeBroker.js';

// ---------------------------------------------------------------------------------------- shapes

export interface AccessReadInput {
  grantId: string;
  sql: string;
  params?: readonly unknown[];
}

/** One table of another app's data as the brain sees it: a copy in the scratch database under `<alias>__<table>`. */
export interface MaterialisedTable {
  grantId: string;
  sourceAppId: string;
  sourceName: string;
  alias: string;
  /** `${alias}__${table}` — the table in the scratch copy. */
  name: string;
  /** The source's own table name. */
  table: string;
  columns: string[];
  /** The declared type text where the dump allowed it, else ''. */
  types: string[];
  rows: unknown[][];
  truncated: boolean;
  totalRows?: number;
  duration: AccessDuration;
  expiresAt?: string;
}

export type MaterialiseSkipReason = 'drift' | 'timeout' | 'unavailable' | 'failed' | 'too-large' | 'copy-failed' | 'ended';

export interface MaterialiseSkip {
  grantId: string;
  sourceAppId: string;
  sourceName: string;
  reason: MaterialiseSkipReason;
}

export interface MaterialisedSet {
  tables: MaterialisedTable[];
  skipped: MaterialiseSkip[];
  /** Every `name`, sorted — the exact-name list the propose tool refuses against. */
  readOnlyTables: string[];
}

export const EMPTY_MATERIALISED_SET: MaterialisedSet = Object.freeze({ tables: [], skipped: [], readOnlyTables: [] });

export interface RecordReadInput {
  grantIds: readonly string[];
  sql?: string;
}

export interface RecordReadOutcome {
  recorded: string[];
  refused: MaterialiseSkip[];
}

/** One plain statement on a table the user let the reader change (PR-3, D-PR3-14); `authority` is `permission` from a frame. */
export interface AccessWriteInput {
  grantId: string;
  sql: string;
  params?: readonly unknown[];
  authority: AccessWriteAuthority;
}

export interface AccessRefreshInput {
  grantId: string;
}

export interface AccessDiscoverInput {
  hints?: AccessHints;
}

export interface AccessService {
  /** The handler's former `query` body, byte-identical for a frame but for policy rule 4's one named invert. */
  read(caller: AccessCaller, input: AccessReadInput): Promise<AccessHandlerResult>;
  /** Dumps the caller's live grants through the Worker, aliased; writes no line; never throws. */
  materialise(caller: AccessCaller): Promise<MaterialisedSet>;
  /** ONE `read` line per named grant, BEFORE rows reach a brain; never throws. */
  recordRead(caller: AccessCaller, set: MaterialisedSet, input: RecordReadInput): Promise<RecordReadOutcome>;
  list(caller: AccessCaller): Promise<AccessHandlerResult>;
  release(caller: AccessCaller, grantId: string): Promise<AccessHandlerResult>;
  /** PR-3: the minute, the verdict, the Write Broker — answers `{ ok, op: 'write', changes }` or the refusal. */
  write(caller: AccessCaller, input: AccessWriteInput): Promise<AccessHandlerResult>;
  /** PR-3: the verdict, then the refresh engine through the lazy edge — its outcome is the wire's. */
  refresh(caller: AccessCaller, input: AccessRefreshInput): Promise<AccessHandlerResult>;
  /** PR-3: the presence rule, then the cached class of the library — nothing recorded. */
  discover(caller: AccessCaller, input: AccessDiscoverInput): Promise<AccessHandlerResult>;
}

// --------------------------------------------------------------------------------------- answers

const refuse = (code: string, message: string, retryable: boolean): AccessHandlerResult => ({ ok: false, code, message, retryable });

/** The verdict as the app hears it — the effect and the grant it carried stay on this side. */
const refused = (verdict: Refusal): AccessHandlerResult => refuse(verdict.code, verdict.message, verdict.retryable);

// One spelling per answer, so two refusals that must not be told apart are byte-identical.
const notGranted = (): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED, ACCESS_APP_MESSAGES.notGranted, false);
const queryFailed = (message: string = ACCESS_APP_MESSAGES.queryFailed): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_QUERY_FAILED, message, false);

/** The mask's replacement — the scan's and the scoped copy's own. */
const MASK = '***';

/** The door a caller came through, as a history line names it (D-PR3-6): the frame is the app's own act. */
function viaOf(caller: AccessCaller): AccessLogVia {
  switch (caller.kind) {
    case 'frame':
      return 'app';
    case 'chat':
      return 'chat';
    case 'schedule':
      return 'schedule';
  }
}

/** D-PR3-21: how many sources the library offers, as a class — the reader learns no name and no count. */
function classOf(count: number): AccessCandidateClass {
  if (count === 0) return 'none';
  return count === 1 ? 'one' : 'several';
}

/** The policy's context over the engine: its finder, the WhatsApp check and the instant the op started. */
export function policyContextFor(db: UserDb, now: number): PolicyContext {
  return {
    now,
    find: (grantId) => findAccessGrant(db, grantId),
    sourceRestricted: (sourceAppId) => appHasSidecarFact(db, sourceAppId),
  };
}

/**
 * Rows as objects keyed by COLUMN NAME, cell by cell (a duplicated column name never hides a
 * cell): every cell under a credential-named column crosses as `***` whatever it holds, and any
 * cell the value scan rejects in its column's context crosses as `***` too (ADR-0075 §6, D14).
 */
function maskRows(columns: readonly string[], rows: readonly unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell, index) => {
      const column = columns[index] ?? '';
      if (isCredentialKeyName(column)) return MASK;
      return scanForCredentialValues({ [column]: cell }).rejects.length > 0 ? MASK : cell;
    }),
  );
}

/** One `refused` line per access per coalescing window — the line is the fact, not the count. */
function logRefused(db: UserDb, readerAppId: string, grantId: string, sourceAppId: string, tables: string[], at: number): void {
  try {
    const recent = db
      .listAccessLog(sourceAppId)
      .some((entry) => entry.kind === 'refused' && entry.grantId === grantId && at - Date.parse(entry.at) < ACCESS_LOG_COALESCE_MS);
    if (recent) return;
    db.appendAccessLog(sourceAppId, { at: iso(at), kind: 'refused', grantId, readerAppId, readerName: readerNameOf(db, readerAppId), tables, attended: false });
  } catch {
    // the refusal stands whether or not the history had room for it
  }
}

// ----------------------------------------------------------------------------------------- body

/** One reader's cached discover class (D-PR3-21): made at `at`, while its frame-ends counter was `ends` (E1-Q10; D-IE1-2). */
interface DiscoverEntry {
  at: number;
  ends: number;
  candidates: AccessCandidateClass;
}

function createAccessService(): AccessService {
  const now = (): number => accessDeps().now();
  /** Per reader: the class, or the gather still making it (SEC-3 — a concurrent ask awaits the same promise). */
  const discovered = new Map<string, DiscoverEntry | Promise<DiscoverEntry>>();

  /** This caller's grant by id — found and owned, else nothing (the caller answers not-granted). */
  const owned = (db: UserDb, caller: AccessCaller, grantId: string): FoundAccessGrant | undefined => {
    const found = findAccessGrant(db, grantId);
    return found !== undefined && ownsGrant(caller, found) ? found : undefined;
  };

  /**
   * The ONE admission `list` and `materialise` share: this caller's rows, in grant order, that
   * the policy admits for `materialise` — read once, performing nothing. A refusal is simply
   * absent (not owned, stopped, expired, nobody present for a grant that needs someone, the
   * source restricted) — never a skip, never a line. The policy is the only rule here.
   */
  const admitted = (db: UserDb, caller: AccessCaller, ctx: PolicyContext): LiveGrantRow[] =>
    grantsForApp(db, caller.appId, ctx.now).reads.filter((row) => authorise(ctx, caller, { kind: 'materialise', grantId: row.grant.id }).ok);

  /** Perform the ONE effect a `read` refusal names, on the grant it carried — where the handler did it. */
  async function perform(db: UserDb, caller: AccessCaller, verdict: Refusal, at: number): Promise<void> {
    const found = verdict.grant;
    if (verdict.effect === undefined || found === undefined) return;
    const { grant } = found;
    switch (verdict.effect) {
      case 'refused-line':
        logRefused(db, caller.appId, grant.id, grant.sourceAppId, grant.scope.tables.map((table) => table.name), at);
        return;
      case 'mark-expired':
        markExpiredOnce(db, grant, at);
        return;
      case 'suspend-source-restricted':
        await suspendAccess(db, grant.id, 'source-restricted', iso(at));
        return;
    }
  }

  async function read(caller: AccessCaller, input: AccessReadInput): Promise<AccessHandlerResult> {
    const db = await accessDeps().getDb();
    const at = now();
    // FIRST, for a frame: every query op counts against the minute — refused, unknown or not.
    if (caller.kind === 'frame' && queryRateLimited(caller.appId, at)) {
      return refuse(ACCESS_ERROR_CODES.ACCESS_RATE_LIMITED, ACCESS_APP_MESSAGES.queryRateLimited, true);
    }
    const ctx = policyContextFor(db, at);
    const verdict = authorise(ctx, caller, { kind: 'read', grantId: input.grantId, sql: input.sql });
    if (!verdict.ok) {
      await perform(db, caller, verdict, at);
      return refused(verdict);
    }
    const { grant: found } = verdict;
    const { grant } = found;
    const tables = grant.scope.tables.map((table) => table.name);
    // Read once per op: the posture the whole read is logged under (a run ending mid-read must not split it).
    const attendedNow = verdict.attended;

    let outcome: Awaited<ReturnType<typeof scopedRead>>;
    try {
      outcome = await scopedRead({
        grantId: grant.id,
        bytes: sourceBytesOf(db, grant.sourceAppId),
        scope: readScopeOf(grant),
        // Re-checked when the read DEQUEUES: a stop or a pause that landed while it waited behind
        // other reads ends it before any export, slice or worker (W6 finding 7).
        stillLive: () => stillReadable(ctx.find, caller, grant.id, now()) !== undefined,
        statement: { sql: input.sql, ...(input.params !== undefined ? { params: input.params } : {}) },
        caps: { maxRows: ACCESS_MAX_ROWS, maxBytes: ACCESS_MAX_RESULT_BYTES },
      });
    } catch (err) {
      return err instanceof SourceTooLarge ? queryFailed(ACCESS_APP_MESSAGES.tooLarge) : queryFailed();
    }

    const stamp = iso(now());
    /** The grant ended while the read waited or ran: a stop or a pause wins — no rows leave. */
    const endedMeanwhile = (current: FoundAccessGrant | undefined): AccessHandlerResult =>
      refuse(ACCESS_ERROR_CODES.ACCESS_REVOKED, current?.grant.status === 'suspended' ? ACCESS_APP_MESSAGES.paused : ACCESS_APP_MESSAGES.revoked, false);
    if (outcome.ok) {
      // The read took time: a stop or a pause that landed meanwhile wins — no rows leave.
      const current = owned(db, caller, grant.id);
      if (current === undefined || current.grant.status !== 'active') return endedMeanwhile(current);
      const rows = maskRows(outcome.columns, outcome.rows);
      const sql = loggedSql(input.sql);
      try {
        appendLine(db, grant.sourceAppId, {
          at: stamp,
          kind: 'read',
          grantId: grant.id,
          readerAppId: caller.appId,
          readerName: readerNameOf(db, caller.appId),
          tables,
          ...(sql !== undefined ? { sql } : {}),
          rows: rows.length,
          attended: attendedNow,
        });
      } catch {
        return queryFailed(); // a read the source's history cannot record does not happen
      }
      noteRead(db, grant.id, stamp);
      ringRead(grant.sourceAppId, grant.id);
      return {
        ok: true,
        op: 'query',
        columns: outcome.columns,
        rows,
        ...(outcome.truncated === true ? { truncated: true, ...(outcome.totalRows !== undefined ? { totalRows: outcome.totalRows } : {}) } : {}),
      };
    }
    switch (outcome.reason) {
      case 'ended': {
        const current = owned(db, caller, grant.id);
        if (current !== undefined && current.grant.status === 'active' && isExpired(current.grant, now())) {
          markExpiredOnce(db, current.grant, now());
          return refuse(ACCESS_ERROR_CODES.ACCESS_EXPIRED, ACCESS_APP_MESSAGES.expired, false);
        }
        return endedMeanwhile(current);
      }
      case 'unavailable':
        return queryFailed(ACCESS_APP_MESSAGES.noWorker);
      case 'timeout':
        if (noteTimeout(db, grant.id) >= ACCESS_TIMEOUT_STRIKES) await suspendAccess(db, grant.id, 'reader-misbehaved', stamp);
        return queryFailed(ACCESS_APP_MESSAGES.tookTooLong);
      case 'drift':
        await suspendAccess(db, grant.id, 'source-changed', stamp);
        return refuse(ACCESS_ERROR_CODES.ACCESS_REVOKED, ACCESS_APP_MESSAGES.sourceChanged, false);
      case 'refused':
        return refuse(ACCESS_ERROR_CODES.ACCESS_QUERY_REFUSED, ACCESS_APP_MESSAGES.queryRefused, false);
      case 'copy-failed':
        return queryFailed(); // its message names an object of the source — never for the app (typed, never parsed: W6 finding 12)
      case 'failed':
        return queryFailed(`${ACCESS_APP_MESSAGES.queryFailed}: ${outcome.message}`);
    }
  }

  async function list(caller: AccessCaller): Promise<AccessHandlerResult> {
    const db = await accessDeps().getDb();
    const ctx = policyContextFor(db, now());
    // Exactly `read`'s admission, read once for the whole list, performing nothing: this caller's,
    // its own session grants, and — with nobody present — only those usable while away.
    const grants = admitted(db, caller, ctx).map((row) => grantView(db, row.grant));
    return { ok: true, op: 'list', grants };
  }

  async function release(caller: AccessCaller, grantId: string): Promise<AccessHandlerResult> {
    const db = await accessDeps().getDb();
    const verdict = authorise(policyContextFor(db, now()), caller, { kind: 'release', grantId });
    if (!verdict.ok) return refused(verdict);
    return (await releaseAccess(caller.appId, grantId)) === 'released' ? { ok: true, op: 'release' } : notGranted();
  }

  /** The reader's library name for a skip naming the reader itself — never a throw inside a catch. */
  const readerNameQuietly = (db: UserDb | undefined, appId: string): string => {
    try {
      return db === undefined ? appId : readerNameOf(db, appId);
    } catch {
      return appId;
    }
  };

  async function materialise(caller: AccessCaller): Promise<MaterialisedSet> {
    let db: UserDb | undefined;
    try {
      db = await accessDeps().getDb();
      const at = now();
      const ctx = policyContextFor(db, at);
      const set = await materialiseGrants(db, caller, admitted(db, caller, ctx), { dump: scopedDump, now, find: ctx.find });
      // The one effect a dump names, performed as a read performs it: a source whose columns changed is paused.
      for (const skip of set.skipped) if (skip.reason === 'drift') await suspendAccess(db, skip.grantId, 'source-changed', iso(now()));
      return set;
    } catch {
      return { tables: [], skipped: [{ grantId: '', sourceAppId: caller.appId, sourceName: oneLine(readerNameQuietly(db, caller.appId)), reason: 'failed' }], readOnlyTables: [] };
    }
  }

  async function recordRead(caller: AccessCaller, set: MaterialisedSet, input: RecordReadInput): Promise<RecordReadOutcome> {
    const recorded: string[] = [];
    const refused: MaterialiseSkip[] = [];
    // In set order, once per grant, only the ids the caller named and the set holds.
    const wanted = new Set(input.grantIds);
    const ids = [...new Set(set.tables.map((table) => table.grantId))].filter((id) => wanted.has(id));
    const handedOf = (id: string): MaterialisedTable[] => set.tables.filter((table) => table.grantId === id);
    const refuse = (id: string, reason: MaterialiseSkipReason): void => {
      const first = handedOf(id)[0];
      if (first !== undefined) refused.push({ grantId: id, sourceAppId: first.sourceAppId, sourceName: first.sourceName, reason });
    };
    let db: UserDb;
    try {
      db = await accessDeps().getDb();
    } catch {
      for (const id of ids) refuse(id, 'failed'); // nothing is handed over without its line
      return { recorded, refused };
    }
    const attended = attendedFor(caller);
    const sql = input.sql === undefined ? undefined : loggedSql(input.sql);
    for (const id of ids) {
      try {
        const current = stillReadable((grantId) => findAccessGrant(db, grantId), caller, id, now());
        if (current === undefined) {
          refuse(id, 'ended');
          continue;
        }
        const { grant } = current;
        const stamp = iso(now());
        // The line BEFORE the rows leave: EVERY granted table (A-Q7), the rows handed over across this grant's tables.
        appendLine(db, grant.sourceAppId, {
          at: stamp,
          kind: 'read',
          grantId: id,
          readerAppId: caller.appId,
          readerName: readerNameOf(db, caller.appId),
          tables: grant.scope.tables.map((table) => table.name),
          ...(sql !== undefined ? { sql } : {}),
          rows: handedOf(id).reduce((sum, table) => sum + table.rows.length, 0),
          attended,
        });
        noteRead(db, id, stamp);
        ringRead(grant.sourceAppId, id);
        recorded.push(id);
      } catch {
        refuse(id, 'failed'); // a read the source's history cannot record does not happen
      }
    }
    return { recorded, refused };
  }

  async function write(caller: AccessCaller, input: AccessWriteInput): Promise<AccessHandlerResult> {
    const db = await accessDeps().getDb();
    const at = now();
    // FIRST, for a frame: a write counts in the minute it shares with reads — refused, unknown or not (E1-Q6).
    if (caller.kind === 'frame' && queryRateLimited(caller.appId, at)) {
      return refuse(ACCESS_ERROR_CODES.ACCESS_RATE_LIMITED, ACCESS_APP_MESSAGES.queryRateLimited, true);
    }
    // The table the statement names, read off its verb — a statement that names none is not one plain INSERT, UPDATE or DELETE: refused by name before any verdict (ENG-2).
    const table = dmlTargetTable(input.sql);
    if (table === undefined) return writeRefused('statement');
    const verdict = authorise(policyContextFor(db, at), caller, { kind: 'write', grantId: input.grantId, table });
    if (!verdict.ok) return refused(verdict); // no effect, no line (E1-Q3)
    return brokeredWrite(db, {
      targetAppId: verdict.grant.grant.sourceAppId,
      statement: { sql: input.sql, ...(input.params !== undefined ? { params: input.params } : {}) },
      table,
      authority: input.authority,
      via: viaOf(caller),
      grant: verdict.grant,
      caller,
    });
  }

  async function refresh(caller: AccessCaller, input: AccessRefreshInput): Promise<AccessHandlerResult> {
    const db = await accessDeps().getDb();
    const verdict = authorise(policyContextFor(db, now()), caller, { kind: 'refresh', grantId: input.grantId });
    if (!verdict.ok) return refused(verdict); // no effect, no line (E1-Q3)
    // The ONE lazy edge (F8): the engine and the run path's production seams, loaded at the call so no top-level cycle closes through the service.
    const [{ refreshSource }, { defaultAppRunDeps }] = await Promise.all([import('./refresh.js'), import('../schedule/appRun.js')]);
    return refreshSource(db, defaultAppRunDeps(), { grant: verdict.grant.grant, requestedBy: readerNameOf(db, caller.appId), via: viaOf(caller) });
  }

  async function discover(caller: AccessCaller, input: AccessDiscoverInput): Promise<AccessHandlerResult> {
    const db = await accessDeps().getDb();
    const at = now();
    const verdict = authorise(policyContextFor(db, at), caller, { kind: 'discover' });
    if (!verdict.ok) return refused(verdict);
    // The per-reader cache (E1-Q10): a hit — settled, or the gather still in flight (SEC-3) — answers the class and exports nothing; a reset of the session moved `ends`, so its entry misses.
    const ends = readerFrameEnds(caller.appId);
    const cached = discovered.get(caller.appId);
    const answer = (entry: DiscoverEntry): AccessHandlerResult => ({ ok: true, op: 'discover', candidates: entry.candidates });
    const usable = (entry: DiscoverEntry): boolean => entry.ends === ends && at - entry.at < ACCESS_DISCOVER_CACHE_MS;
    if (cached !== undefined) {
      const hit = await cached;
      if (usable(hit)) return answer(hit);
      // A stale hit: a concurrent ask may have parked a fresh gather while this one awaited — join it rather than run a second (SEC-3's burst after the cache expires).
      const parked = discovered.get(caller.appId);
      if (parked !== undefined && parked !== cached) {
        const fresh = await parked;
        if (usable(fresh)) return answer(fresh);
      }
    }
    // A miss parks its gather BEFORE the first export, so every concurrent ask awaits this one; a gather that throws leaves nothing behind.
    const gather = collectSources(db, caller.appId, input.hints).then((ranked) => ({ at, ends, candidates: classOf(ranked.matched.length + ranked.rest.length) }));
    discovered.set(caller.appId, gather);
    try {
      const entry = await gather;
      if (discovered.get(caller.appId) === gather) discovered.set(caller.appId, entry);
      return answer(entry);
    } catch (err) {
      if (discovered.get(caller.appId) === gather) discovered.delete(caller.appId);
      throw err;
    }
  }

  return { read, materialise, recordRead, list, release, write, refresh, discover };
}

// ----------------------------------------------------------------------------------- instance

let real: AccessService | undefined;
let overrides: Partial<AccessService> = {};

/** The body behind the facade, resolved at every call so an override set after a holder took the service still applies. */
function current(): AccessService {
  real ??= createAccessService();
  return {
    read: overrides.read ?? real.read,
    materialise: overrides.materialise ?? real.materialise,
    recordRead: overrides.recordRead ?? real.recordRead,
    list: overrides.list ?? real.list,
    release: overrides.release ?? real.release,
    write: overrides.write ?? real.write,
    refresh: overrides.refresh ?? real.refresh,
    discover: overrides.discover ?? real.discover,
  };
}

const facade: AccessService = {
  read: (caller, input) => current().read(caller, input),
  materialise: (caller) => current().materialise(caller),
  recordRead: (caller, set, input) => current().recordRead(caller, set, input),
  list: (caller) => current().list(caller),
  release: (caller, grantId) => current().release(caller, grantId),
  write: (caller, input) => current().write(caller, input),
  refresh: (caller, input) => current().refresh(caller, input),
  discover: (caller, input) => current().discover(caller, input),
};

/** The one service, over `accessDeps()` — built on first use. */
export function accessService(): AccessService {
  return facade;
}

/** Test seam (the `__setAccessDepsForTests` pattern): override the named acts; no argument restores the real body. */
export function __setAccessServiceForTests(over?: Partial<AccessService>): void {
  overrides = over === undefined ? {} : { ...over };
}
