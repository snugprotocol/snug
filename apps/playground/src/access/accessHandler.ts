// access/accessHandler.ts — the runner's access seam for ONE composed frame
// (TASK-20261010-cross-app-access AC11–AC13; ADR-0075 §1–§9; D5, D6, D7, D10, D14, D19, D23).
//
// `createAccessHandlerFor(appId, frame)` is composed by the run view (`{ attended: true,
// generation }`) and the scheduler's hidden frame (`{ attended: false }`) for an OWNED app.
// `appId` is the HOST-assigned library id — the runner's `accessAppId`, the `dbNamespace`
// discipline — and the generation is the host's frame generation of the VISIBLE view. Every limit
// and every session grant keys on those two; the app-rolled `instanceId` identifies no one (a
// re-announce changes it at will). A call under any other `accessAppId` is answered exactly like
// an unknown grant.
//
// A SESSION GRANT ("while it's open") belongs to the visible frame of its generation and to
// nothing else: the hidden frame has no generation and never reads, lists or releases one — not
// even one ticked *also while I'm away* — so it is answered like any grant that is not its own.
//
// THE DOOR CLOSES FOR A DELEGATED RUN'S WINDOW (TASK-20261010-host-broker PR-1; ADR-0077 §3;
// contract v2 D-PR1-8). A run the user did not start may execute on the VISIBLE frame
// (`schedule/runPlacement.ts`); while one is in flight for this app the attended handler takes
// the hidden frame's posture, read PER OP: `request` is told `ACCESS_UNATTENDED` (a timer-fired
// run must not park a consent sheet — a stronger authority than a POST), `query` admits only a
// grant allowed *also while I'm away* (a session grant is this frame's but not readable, a
// `refused` line with `attended: false`), and a `read` line says `attended: false`. After the run
// the door reopens; the app's genuine ask is the ordinary strip, which needs the user's act anyway.
// `list` and `release` keep the frame's own posture (nothing is read or asked through them).
//
// THE OPS.
//  - `request`: a hidden frame is told `ACCESS_UNATTENDED` (nobody to ask; nothing recorded, no
//    window spent); then the shared ladder (`state/appAsk.ts` via consent.ts — the window per
//    app, the mutes, the declines by semantic hash, one pending per generation); then the
//    candidates — none → `ACCESS_NO_SOURCES` (nothing recorded, no strip). The gathering is an
//    await: if the frame the ask came from ended meanwhile (its view closed, a newer generation
//    was composed, a session reset), the ask parks NOTHING and is answered *not now* — a dead
//    frame's ask must never block the next frame of the same id. Else ONE pending is parked for
//    the strip and the answer is HELD until the user's act resolves it.
//  - `query`: the per-app minute FIRST — every query op counts, a refused one or an unknown id
//    too, so no frame can write history lines faster than the limit. Then the grant must be THIS
//    reader's (and, in memory, this visible frame's), active, not expired (expiry derived; marked
//    once), usable while away if the frame is hidden (else a `refused` line — at most ONE per
//    access per `ACCESS_LOG_COALESCE_MS`, so a hidden reader cannot push the source's real reads
//    out of its capped history), and its source free of a WhatsApp fact at THIS moment (else it
//    pauses `source-restricted`). Then ONE read-only SELECT (refused before any export), the
//    source's bytes (refused over 16 MiB), the read in the Worker under its wall
//    clock (three consecutive timeouts pause the grant `reader-misbehaved`; a column change
//    pauses it `source-changed`), the cells MASKED by column name, the `read` line on the source
//    — written BEFORE the rows leave, so a read the history could not record never happens —
//    and the counters.
//  - `list`: this reader's live grants as views (a hidden frame: the ones usable while away).
//  - `release`: the reader gives back its own grant.
//
// App-facing messages are `copy.ts`'s `ACCESS_APP_MESSAGES` — never a fact about another app the
// reader was not granted. Errors are data; anything unexpected answers `HOST_ERROR`.

import {
  ACCESS_ERROR_CODES,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_LOG_SQL_MAX_CHARS,
  ACCESS_MAX_RESULT_BYTES,
  ACCESS_MAX_ROWS,
  ACCESS_SOURCE_MAX_BYTES,
  ACCESS_TIMEOUT_STRIKES,
  ERROR_CODES,
  accessRequestHash,
  findRecordCredential,
  isCredentialKeyName,
  isReadOnlySelect,
  scanForCredentialValues,
  type AccessLogEntry,
  type AccessRequestFrame,
} from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import type { AccessHandler, AccessHandlerResult } from '@snugprotocol/runner';

// A leaf (`state/store.ts` and `state/appHosts.ts` only) — safe to import here.
import { delegatedRunFor } from '../schedule/runPlacement.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { accessAskLadder, accessAsksOff, collectSources, dismissStaleAccessAsk, parkAccessRequest, type ConsentOutcome } from './consent.js';
import { ACCESS_APP_MESSAGES } from './copy.js';
import {
  accessDeps,
  armAccessListeners,
  findAccessGrant,
  grantView,
  grantsForApp,
  isExpired,
  markExpiredOnce,
  noteReaderGeneration,
  noteRead,
  noteTimeout,
  queryRateLimited,
  readerFrameEnds,
  readerGeneration,
  releaseAccess,
  suspendAccess,
  type AnyAccessGrant,
  type FoundAccessGrant,
} from './grants.js';
import { scopedRead } from './scopedRead.js';

/** Who composed the handler: the visible view at its generation, or the hidden (scheduled) frame, which has none. */
export type AccessFrame = { attended: true; generation: number } | { attended: false };

type RequestOp = Extract<AccessRequestFrame, { op: 'request' }>;
type QueryOp = Extract<AccessRequestFrame, { op: 'query' }>;

const refuse = (code: string, message: string, retryable: boolean): AccessHandlerResult => ({ ok: false, code, message, retryable });

// One spelling per answer, so two refusals that must not be told apart are byte-identical.
const notGranted = (): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED, ACCESS_APP_MESSAGES.notGranted, false);
const notNow = (): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_DECLINED, ACCESS_APP_MESSAGES.notNow, true);
const hostError = (): AccessHandlerResult => refuse(ERROR_CODES.HOST_ERROR, ACCESS_APP_MESSAGES.hostError, true);
const queryFailed = (message: string = ACCESS_APP_MESSAGES.queryFailed): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_QUERY_FAILED, message, false);

/** The mask's replacement — the scan's and the scoped copy's own. */
const MASK = '***';

class SourceTooLarge extends Error {}

/** The held answer, once the user acted on the sheet (or the ask was dismissed). */
function answerFor(db: UserDb, outcome: ConsentOutcome, grant: AnyAccessGrant | undefined): AccessHandlerResult {
  switch (outcome.kind) {
    case 'allowed':
      return grant === undefined ? hostError() : { ok: true, op: 'request', grant: grantView(db, grant) };
    case 'not-now':
    case 'dismissed':
      return notNow();
    case 'declined':
      return refuse(ACCESS_ERROR_CODES.ACCESS_DECLINED, ACCESS_APP_MESSAGES.declined, false);
    case 'muted':
      return refuse(ACCESS_ERROR_CODES.ACCESS_DECLINED, ACCESS_APP_MESSAGES.muted, false);
    case 'failed':
      return hostError();
  }
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

/** The statement as the history keeps it: walked WHOLE first (a hit omits the seat), then cut. */
function loggedSql(sql: string): string | undefined {
  if (findRecordCredential({ sql }) !== undefined) return undefined;
  return sql.slice(0, ACCESS_LOG_SQL_MAX_CHARS);
}

export function createAccessHandlerFor(appId: string, frame: AccessFrame): AccessHandler {
  armAccessListeners();
  const { attended } = frame;
  /** The visible frame's generation; the hidden frame has none (`-1` is never a frame epoch, and is never compared for it). */
  const generation = frame.attended ? frame.generation : -1;
  if (frame.attended) {
    // The reader's attended frame is now this generation: older session grants and asks died with theirs.
    noteReaderGeneration(appId, frame.generation);
    dismissStaleAccessAsk(appId, frame.generation);
  }

  const now = (): number => accessDeps().now();
  const iso = (at: number): string => new Date(at).toISOString();
  const readerName = (db: UserDb): string => db.getApp(appId)?.displayName ?? appId;

  /** Is someone there to be asked RIGHT NOW: the visible frame, and no delegated run in flight for the app (D-PR1-8). */
  const present = (): boolean => attended && delegatedRunFor(appId) === undefined;

  /** A session grant is this frame's only when this is the VISIBLE frame of its generation. */
  const ownsSession = (session: { generation?: number }): boolean => attended && session.generation === generation;

  /** This reader's grant by id — a session grant only for the visible frame of its generation — else nothing (the caller answers not-granted). */
  function ownGrant(db: UserDb, grantId: string): FoundAccessGrant | undefined {
    const found = findAccessGrant(db, grantId);
    if (found === undefined || found.grant.readerAppId !== appId) return undefined;
    if (found.session && !ownsSession(found)) return undefined;
    return found;
  }

  async function request(db: UserDb, frame: RequestOp): Promise<AccessHandlerResult> {
    if (!present()) return refuse(ACCESS_ERROR_CODES.ACCESS_UNATTENDED, ACCESS_APP_MESSAGES.unattended, true);
    const reader = db.getApp(appId);
    if (reader === undefined) return notGranted();

    // `renew` is part of the ask only when it names one of THIS reader's grants (else hashed as absent).
    const renewed = frame.renew === undefined ? undefined : ownGrant(db, frame.renew);
    const semantics = { hints: frame.hints, renew: renewed?.grant.id };
    switch (accessAskLadder.consume({ appId, generation, ask: semantics, db, at: now() })) {
      case 'rate-limited':
        return refuse(ACCESS_ERROR_CODES.ACCESS_RATE_LIMITED, ACCESS_APP_MESSAGES.askRateLimited, true);
      case 'muted':
        return refuse(ACCESS_ERROR_CODES.ACCESS_DECLINED, accessAsksOff() ? ACCESS_APP_MESSAGES.askingOff : ACCESS_APP_MESSAGES.muted, false);
      case 'declined':
        return refuse(ACCESS_ERROR_CODES.ACCESS_DECLINED, ACCESS_APP_MESSAGES.declined, false);
      case 'pending':
        return refuse(ACCESS_ERROR_CODES.ACCESS_PENDING, ACCESS_APP_MESSAGES.pending, true);
      case 'accepted':
        break;
    }

    const ends = readerFrameEnds(appId);
    const candidates = await collectSources(db, appId, frame.hints);
    // The frame this ask came from ended during the gathering (view closed, session reset) or a
    // newer generation was composed: nobody is left to answer — park nothing, record nothing.
    const current = readerGeneration(appId);
    if (readerFrameEnds(appId) !== ends || (current !== undefined && current !== generation)) return notNow();
    if (candidates.matched.length + candidates.rest.length === 0) return refuse(ACCESS_ERROR_CODES.ACCESS_NO_SOURCES, ACCESS_APP_MESSAGES.noSources, false);
    // Re-checked after the await: a pending from this generation, or the user's own ask, is never replaced by an app.
    const waiting = accessAskLadder.pendingFor(appId);
    if (waiting !== undefined && (waiting.generation === generation || waiting.provenance === 'user')) {
      return refuse(ACCESS_ERROR_CODES.ACCESS_PENDING, ACCESS_APP_MESSAGES.pending, true);
    }

    return new Promise<AccessHandlerResult>((resolve) => {
      parkAccessRequest({
        db,
        reader,
        generation,
        purpose: frame.purpose,
        provenance: 'app',
        candidates,
        ...(frame.hints !== undefined ? { hints: frame.hints } : {}),
        ...(renewed !== undefined
          ? { renew: { grantId: renewed.grant.id, sourceAppId: renewed.grant.sourceAppId, tables: renewed.grant.scope.tables.map((table) => table.name) } }
          : {}),
        hash: accessRequestHash(semantics),
        settle: (outcome, grant) => {
          // Exactly one terminal answer, whatever building it throws (a view of a grant whose source vanished).
          let answer: AccessHandlerResult;
          try {
            answer = answerFor(db, outcome, grant);
          } catch {
            answer = hostError();
          }
          resolve(answer);
        },
      });
    });
  }

  /** Append a history line; a refused `sql` seat is dropped and the line tried again. Throws when the history refuses the line itself. */
  function logRead(db: UserDb, sourceAppId: string, entry: AccessLogEntry): void {
    try {
      db.appendAccessLog(sourceAppId, entry);
    } catch (err) {
      if (entry.sql === undefined) throw err;
      const { sql: _withheld, ...rest } = entry;
      db.appendAccessLog(sourceAppId, rest);
    }
  }

  /** One `refused` line per access per coalescing window — the line is the fact, not the count. */
  function logRefused(db: UserDb, grantId: string, sourceAppId: string, tables: string[], at: number): void {
    try {
      const recent = db
        .listAccessLog(sourceAppId)
        .some((entry) => entry.kind === 'refused' && entry.grantId === grantId && at - Date.parse(entry.at) < ACCESS_LOG_COALESCE_MS);
      if (recent) return;
      db.appendAccessLog(sourceAppId, { at: iso(at), kind: 'refused', grantId, readerAppId: appId, readerName: readerName(db), tables, attended: false });
    } catch {
      // the refusal stands whether or not the history had room for it
    }
  }

  async function query(db: UserDb, frame: QueryOp): Promise<AccessHandlerResult> {
    const at = now();
    // FIRST: every query op counts against the minute — refused, unknown or not — so no frame can
    // write history lines (or spend the host's work) faster than the limit.
    if (queryRateLimited(appId, at)) return refuse(ACCESS_ERROR_CODES.ACCESS_RATE_LIMITED, ACCESS_APP_MESSAGES.queryRateLimited, true);
    const found = ownGrant(db, frame.grantId);
    if (found === undefined) return notGranted();
    const { grant } = found;

    if (grant.status === 'revoked') return refuse(ACCESS_ERROR_CODES.ACCESS_REVOKED, ACCESS_APP_MESSAGES.revoked, false);
    if (grant.status === 'suspended') {
      return refuse(ACCESS_ERROR_CODES.ACCESS_REVOKED, grant.suspendedReason === 'source-changed' ? ACCESS_APP_MESSAGES.sourceChanged : ACCESS_APP_MESSAGES.paused, false);
    }
    if (isExpired(grant, at)) {
      markExpiredOnce(db, grant, at);
      return refuse(ACCESS_ERROR_CODES.ACCESS_EXPIRED, ACCESS_APP_MESSAGES.expired, false);
    }
    const tables = grant.scope.tables.map((table) => table.name);
    // Read once per op: the posture the whole read is logged under (a run ending mid-read must not split it).
    const attendedNow = present();
    if (!attendedNow && !grant.unattended) {
      logRefused(db, grant.id, grant.sourceAppId, tables, at);
      return notGranted();
    }
    if (appHasSidecarFact(db, grant.sourceAppId)) {
      await suspendAccess(db, grant.id, 'source-restricted', iso(at));
      return refuse(ACCESS_ERROR_CODES.ACCESS_REVOKED, ACCESS_APP_MESSAGES.paused, false);
    }
    if (!isReadOnlySelect(frame.sql)) return refuse(ACCESS_ERROR_CODES.ACCESS_QUERY_REFUSED, ACCESS_APP_MESSAGES.queryRefused, false);

    let outcome: Awaited<ReturnType<typeof scopedRead>>;
    try {
      outcome = await scopedRead({
        grantId: grant.id,
        bytes: async () => {
          const bytes = await db.exportAppRuntime(grant.sourceAppId);
          if (bytes.byteLength > ACCESS_SOURCE_MAX_BYTES) throw new SourceTooLarge();
          return bytes;
        },
        scope: grant.scope,
        // Re-checked when the read DEQUEUES: a stop or a pause that landed while it waited behind
        // other reads ends it before any export, slice or worker (W6 finding 7).
        stillLive: () => {
          const current = ownGrant(db, grant.id);
          return current !== undefined && current.grant.status === 'active' && !isExpired(current.grant, now());
        },
        statement: { sql: frame.sql, ...(frame.params !== undefined ? { params: frame.params } : {}) },
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
      const current = ownGrant(db, grant.id);
      if (current === undefined || current.grant.status !== 'active') return endedMeanwhile(current);
      const rows = maskRows(outcome.columns, outcome.rows);
      const sql = loggedSql(frame.sql);
      try {
        logRead(db, grant.sourceAppId, {
          at: stamp,
          kind: 'read',
          grantId: grant.id,
          readerAppId: appId,
          readerName: readerName(db),
          tables,
          ...(sql !== undefined ? { sql } : {}),
          rows: rows.length,
          attended: attendedNow,
        });
      } catch {
        return queryFailed(); // a read the source's history cannot record does not happen
      }
      noteRead(db, grant.id, stamp);
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
        const current = ownGrant(db, grant.id);
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

  function list(db: UserDb): AccessHandlerResult {
    const grants = grantsForApp(db, appId, now())
      .reads.filter((row) => row.live && (!row.session || ownsSession(row)) && (attended || row.grant.unattended))
      .map((row) => grantView(db, row.grant));
    return { ok: true, op: 'list', grants };
  }

  async function release(db: UserDb, grantId: string): Promise<AccessHandlerResult> {
    if (ownGrant(db, grantId) === undefined) return notGranted();
    return (await releaseAccess(appId, grantId)) === 'released' ? { ok: true, op: 'release' } : notGranted();
  }

  return {
    async handle(accessAppId, frame) {
      if (accessAppId !== appId) return notGranted();
      try {
        const db = await accessDeps().getDb();
        switch (frame.op) {
          case 'request':
            return await request(db, frame);
          case 'query':
            return await query(db, frame);
          case 'list':
            return list(db);
          case 'release':
            return await release(db, frame.grantId);
        }
      } catch {
        return hostError();
      }
    },
  };
}
