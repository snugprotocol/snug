// access/writeBroker.ts — the engine half of the Write Broker: one app's bounded, journaled,
// undoable write onto another app's table, and a change to an app's OWN data — the user's approval
// or a schedule's on its own — through the same seat, captured for its own undo (TASK-20261010-
// host-broker PR-3, PR-4; ADR-0076 §4–§5, §9; contract v2 D-PR3-7 the journal holds rows
// never SQL · D-PR3-8 one broker, two modes · D-PR3-11 the driver seat · D-PR3-12 five refusals ·
// D-PR3-15 the engine half · D-PR3-20 (c) the broker's doorbells · D-PR3-25 the vocabulary; v2.1
// notes E1-Q1/Q2/Q9/Q12, D-Q8/Q10/Q19/Q20; spec 1.2 §24.5 MUSTs 18–24).
//
// STRICT MODE — `brokeredWrite` (another app's data, authority `permission` from a frame's `write`
// the policy admitted). FIRST, before any queue or export, the driver's transaction record is READ
// (`db.driver.inTransaction`, code-fix D-FIX-1): a target mid-change answers `ACCESS_BUSY` here,
// because the plan's fresh export below reopens the connection and discards that very transaction
// (D-PR3-11's named residual) — the seat's own `busy` from its `BEGIN IMMEDIATE`, kept as the belt,
// could never see it. Then the order is the contract's and every step of it is observable:
//  (1) the plan job's DEQUEUE re-check — `stillWritable` (the policy's one spelling ∧ the table's
//      `write`), so a stop that landed while the job waited ends it before any export (S8);
//  (2) the plan in the Worker on a FRESH export (`scopedPlanWrite`: the grant's cached bytes are
//      evicted first, nothing of the plan is cached — F5/S15, E1-Q9) under the READ's clock — a
//      timeout is a strike through `noteTimeout`, three pause the grant `reader-misbehaved`;
//  (3) `stillWritable` AGAIN, synchronously, after the plan answers and before the seat — a grant
//      stopped meanwhile answers as a read's `endedMeanwhile` does, and nothing is applied (S8);
//  (4) the reader's LIVE entries on this target < `ACCESS_UNDO_MAX_ENTRIES`, and — the accessor's
//      row cap pre-checked conservatively (D-Q8: the live entries' bytes + one full entry must fit
//      `ACCESS_UNDO_MAX_ROW_BYTES`) — else `ACCESS_WRITE_REFUSED` "too many changes are waiting to
//      be undone" (S9); a live entry is never evicted;
//  (5) the seat: `db.driver.brokeredWrite(target, { plans: [plan], caps, expectChanges: [plan.
//      previewChanges], requireUndo: true, capture: true })` — the facts again on the live handle,
//      `BEGIN IMMEDIATE`, the capture, the statement, the drift halt, the cells walked, `COMMIT`.
//      The caps are `STRICT_CAPS`, shared by the plan and the apply: `maxUndoBytes` is the entry
//      cap LESS a reserve for the entry's host-written seats around `steps` (Gate-5 SEC-1), so a
//      write whose rows would fill the entry past the schema's cap is refused `too-large` at the
//      dry run — before any live handle is touched — and the journal's own parse can never be
//      what refuses it after a commit;
//  (6) after the commit, in this order: the journal entry (`putAccessUndo` — the accessor's refusal
//      or throw after a commit is the one residual, named: the line then carries no `undoId`; the
//      schema's own refusal is unreachable by construction and warned, never silent) → the
//      `wrote` line on the TARGET's history at once (`via`, `authority`, `changes`, `undoId`,
//      `tables: [table]`, the statement as the history keeps it — walked whole, cut at 200; a
//      storage throw here is the second named residual) → the read caches of every grant on the
//      target cleared → the doorbells (`data-changed { table }` to the target's live frame,
//      `access-source-changed { grantId }` to every OTHER live reader — never the writer) → the
//      answer `{ ok, op: 'write', changes }` and nothing else (DS16: no undo id on the wire).
// The frame's refusals (`wireRefusal`), every one in the reader's words from copy.ts and none naming a source fact (DS19):
// a parse, column, facts, value or cap refusal → `ACCESS_WRITE_REFUSED` with its rule's token
// (E1-Q1); `busy` and a strict `drifted` → `ACCESS_BUSY` (retryable, no count — S15); the plan's
// `not-granted` → `ACCESS_NOT_GRANTED`; `drift` → the read's `sourceChanged` after the grant is
// paused `source-changed`; a SQL failure → `ACCESS_QUERY_FAILED` without the engine's message (a
// constraint's name is the source's). A statement whose verb names no table is not one plain
// INSERT, UPDATE or DELETE — the SERVICE refuses it `statement` before the verdict is asked (Gate-5
// ENG-2), so every request here carries the `table` the policy judged.
//
// OWN WRITES — `applyOwnWrite` (TASK-20261010-host-broker PR-4; contract v2 D-PR4-3/4/5/11; ADR-0076
// §9): a change to an app's OWN data on one of two authorities the user gave — an APPROVAL of one
// change (the chat card, a result page) or a schedule's standing authority over its own app's data
// (`authority: 'task'`, the armed walk). One engine for both, in this order, every step observable:
//  (1) `db.driver.inTransaction(app)` FIRST — the app mid-change is `busy` and its transaction is left
//      exactly as it was (D-PR4-5);
//  (1′) the BUCKET RULE (Gate 5, A1) — the entry this change would journal must belong in the bucket
//      named (`ownUndoBelongsIn`: an approval in `approval`, a schedule's change in its own task's
//      bucket, never `approval`), else nothing is made: `cannot-undo` for a schedule, `failed` for an
//      approval. Decided before any seat, so the put after a commit can never be what refuses it;
//  (2) ROOM in the bucket BEFORE the seat — a schedule's bucket (`ownUndo:<appId>:<taskId>`) that
//      cannot take one more full entry answers `full` and nothing applies; the approval bucket
//      always has room (its oldest live entry gives way on the put — the user was there for each);
//  (3) `stillArmed()` — the authority re-read from the FILE after the last await, immediately before
//      the seat (S7): false is `stopped`;
//  (4) ONE seat call, the CAPTURE variant (`{ own, capture: true, caps, expectChanges, requireUndo,
//      admit }`, D-PR4-4): `caps.maxChanges` bounds the whole call (`Infinity` for an approval),
//      `expectChanges` are the fresh dry-run counts, and `admit` is the bucket rule ∧
//      `ownUndoEntrySchema.safeParse` of the EXACT entry this engine will write — asked inside the
//      transaction, before `COMMIT`, so a
//      change whose rows the journal could not hold (`snug_kv`, a long column name, > 200 rows a
//      step, a credential-shaped cell, > 64 KiB) is decided before it lands. A schedule REQUIRES the
//      undo: a no rolls back `cannot-undo`, and so does a batch the capture cannot plan (a function,
//      arithmetic, a conflict clause, no WHERE, a credential-named column). An approval does not: a
//      no commits `undoable: false`, a batch it cannot plan re-runs WHOLE through the bare `{ own }`
//      seat (never a mixed batch, never one transaction shared by the two), and one previewed over
//      `ACCESS_WRITE_MAX_ROWS` rows asks for the bare seat up front — never refused for its size;
//  (5) after the commit, in one synchronous run: the entry put in its bucket (`authority`, `via`, the
//      run and the task for a schedule's — ROWS, never SQL), the caller's `onCommitted` (the walk
//      writes its claim row there, so the entry and the row that names it land in ONE tick, F20),
//      the namespace's read caches cleared, `data-changed { table }` to the app's own frame and
//      `access-source-changed` to EVERY live reader of its data (D-PR4-5) — never a history line:
//      an own write names no other app, so `authority: 'task'` appears on no line (D-PR4-2). Once the
//      seat answered ok NOTHING turns the outcome into a refusal (Gate 5, A5 — PR-3's post-commit
//      posture): the caller's record, the caches and the doorbells are each caught and warned, so a
//      committed, journaled change is never reported as "nothing was changed".
// The named residual: a put refused AFTER the commit (a schedule's bucket filled by a write that
// raced it past the room check) leaves the change applied and `undoable: false` — said, never lost.
//
// THE APPROVAL — `applyApprovedWrite` (D-PR4-6; `executeApprovedWrite` is its thin caller): the DML
// class guard (`nonDataStatementReason`, R-B1), then `inTransaction` (the dry run below is an export,
// and an export discards the app's open transaction — so it is asked first, and a busy app is
// `failed` with the sentence that names it, before anything is exported), then the dry run through
// `scratchRun` for the previewed-count drift halt (F-Sm1, unchanged), then the own-write engine
// under the approval bucket. The outcome keeps PR-2's three shapes and gains `undoable` and, when
// the rows were captured, `undoId`. An approval applies to the app's own table whatever its shape —
// the strict rules decide what ANOTHER app may do to a table, never what the user may approve on
// their own data; only its undo is subject to the shapes an undo can rebuild.
//
// OWN UNDO — `undoOwnWrite` (D-PR4-19): the live entry of the named bucket (an unknown, undone or
// expired id is `gone`), then the undo's ONE core shared with strict mode below — the live schema
// re-validated, the steps reversed through the seat's `{ undo }` — then the entry marked, the
// caches cleared and the same doorbells as the write, each caught and warned once the rows are back
// (A5): an undo that landed answers done. No history line, no access revision: an own change was
// never on the history.
//
// UNDO — `undoBrokeredWrite` (the USER's act from the target's history, `via: 'user'`): the live
// entry (an unknown, undone or expired id is `gone`) → every step's table and columns re-validated
// against the live `table_xinfo` through the driver's read seat — the table exists, every named
// column exists, none is generated — a mismatch is `gone` and the entry is marked undone (S3;
// D-Q10: `markAccessUndone(target, id, at)`, three arguments — a done and a failed undo both stop
// being live) → the seat with the steps in REVERSE order (`{ undo }`: the apply re-validates the
// shape, BUILDS every inverse from the structure with every value a bound parameter, runs the
// belt over each, and rolls the WHOLE undo back unless every inverse put back exactly one row —
// S18) → `markAccessUndone` → the `undone` line (`via: 'user'`, `changes` summed over the steps,
// `tables`) → the caches cleared → `data-changed` to the target and `access-source-changed` to
// EVERY live reader, the one whose write was reversed included (S19) → `{ ok: true }`. A refusal
// is `{ ok: false, reason, message }` with the reason's token — `busy` · `changed` (the guard
// mismatch, nothing changed) · `gone` · `failed` (a SQL error: a rowid reused since, D-Q19) — and
// `ACCESS_SHEET.undoFailed`'s sentence for it (E1-Q2). An undo is never journaled. EVERY outcome
// bumps the access revision (Gate-5 ENG-4): a done undo wrote a line, a `gone` marked the entry,
// and the sheet re-reads on the other three too — it never bumps on its own.
//
// ONE STRICT CORE, TWO DOORS (TASK-20261010-host-broker PR-5; contract v2 D-PR5-12; F5): strict mode's
// body is `brokeredWriteCore(db, req, { mode, expectChanges? })` — the frame's `write` and the chat's
// two verbs (`chatWrite.ts`) share it. `plan` stops after (2) and answers the plan's count and table
// (the seat is never reached); `apply` runs every step, and with `expectChanges` — the count the user
// saw on the chat's card — a fresh plan that differs is `drifted` BEFORE the room check and the seat.
// Its refusals are tokens (`BrokeredCoreRefusal`), every named effect (the timeout strike, the
// drift's pause, the expiry mark) performed INSIDE the core; the frame maps them through
// `wireRefusal`, so the wire bytes are exactly what they were before the extraction.
//
// `clearSourceReadCaches(db, target)` drops the cached bytes of every grant whose source is the
// target — the refresh engine calls it after a result too (D-PR3-17 (9)).
//
// LOAD ORDER (grants.ts's rule): nothing here calls another access module at the top level. No
// string here spells the engine's internal words (copy.ts's vocabulary scan reads this file).

import {
  ACCESS_ERROR_CODES,
  ACCESS_LOG_SQL_MAX_CHARS,
  ACCESS_TIMEOUT_STRIKES,
  ACCESS_UNDO_MAX_BYTES,
  ACCESS_UNDO_MAX_ENTRIES,
  ACCESS_UNDO_MAX_ROW_BYTES,
  ACCESS_UNDO_TTL_MS,
  ACCESS_WRITE_MAX_ROWS,
  APPROVAL_WRITE_AUTHORITY,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessUndoEntrySchema,
  findRecordCredential,
  utf8ByteLength,
  type AccessLogEntry,
  type AccessLogVia,
  type AccessWriteAuthority,
  ownUndoEntrySchema,
  type OwnUndoVia,
  type OwnWriteAuthority,
  type ScheduleHeldReason,
} from '@snugprotocol/protocol';
import {
  OWN_UNDO_APPROVAL_BUCKET,
  dmlTargetTable,
  nonDataStatementReason,
  ownUndoBelongsIn,
  type BrokeredCaps,
  type BrokeredWriteResult,
  type ColumnFact,
  type OwnStatement,
  type ScopedReadStatement,
  type UndoStep,
  type UserDb,
} from '@snugprotocol/db';
import type { AccessHandlerResult } from '@snugprotocol/runner';

import type { ExecuteApprovedWriteOutcome, PendingWriteProposal } from '../agent/dataTools.js';
import { ACCESS_APP_MESSAGES, ACCESS_SHEET, OWN_UNDO, appMidChange, type UndoFailureReason, type WriteRefusalRule } from './copy.js';
import { ringDataChanged, ringSourceChanged } from './doorbell.js';
import { isExpired } from './grantFacts.js';
import { accessDeps, bumpAccessRevision, findAccessGrant, grantsForApp, iso, markExpiredOnce, noteTimeout, readerNameOf, suspendAccess, type FoundAccessGrant } from './grants.js';
import { SourceTooLarge, readScopeOf, sourceBytesOf } from './materialise.js';
import { ownsGrant, stillWritable, type AccessCaller } from './policy.js';
import { clearScopedReadCache, scopedPlanWrite, type PlanOutcome } from './scopedRead.js';

// ---------------------------------------------------------------------------------------- shapes

/** One strict-mode write as the service hands it over (D-PR3-15). */
export interface BrokeredWriteRequest {
  targetAppId: string;
  statement: ScopedReadStatement;
  /** The table the statement's verb names — read once by the service (`dmlTargetTable`) and judged by the policy's rule 7 (ENG-2). */
  table: string;
  authority: AccessWriteAuthority;
  via: AccessLogVia;
  /** The grant the policy admitted — re-checked here at the dequeue and after the plan. */
  grant: FoundAccessGrant;
  caller: AccessCaller;
}

/** What the user's undo answers (E1-Q2): done, or the reason's token with its sentence. */
export type UndoOutcome = { ok: true } | { ok: false; reason: UndoFailureReason; message: string };

/**
 * Why the strict core did not plan or apply (D-PR5-12; TC-Q9) — a token per answer the frame tells
 * apart, each with its effect already performed. `drifted` carries the count the statement made when
 * it moved (the fresh plan's, or the seat's); a driver failure keeps its `retryable`.
 */
export type BrokeredCoreRefusal =
  | { ok: false; reason: 'busy' | 'not-granted' | 'expired' | 'paused' | 'revoked' | 'source-changed' | 'waiting' | 'timeout' | 'unavailable' | 'source-too-large' }
  | { ok: false; reason: 'drifted'; current?: number }
  | { ok: false; reason: 'refused'; rule: WriteRefusalRule }
  | { ok: false; reason: 'failed'; retryable?: true };

/** What the strict core answers: the plan alone, the change made (with the undo it can be put back by), or the refusal. */
export type BrokeredCoreAnswer =
  | { ok: true; phase: 'plan'; changes: number; table: string }
  | { ok: true; phase: 'applied'; changes: number; undoable: boolean; undoId?: string }
  | BrokeredCoreRefusal;

/** `plan` stops before the seat; `apply` with `expectChanges` halts when the fresh plan's count is not the one the user saw. */
export interface BrokeredCoreOptions {
  mode: 'plan' | 'apply';
  expectChanges?: number;
}

/**
 * One OWN write as its two callers hand it over (TASK-20261010-host-broker PR-4, D-PR4-3/4/11): the
 * user's approval (`bucket: 'approval'`, `requireUndo: false`, `maxChanges: Infinity`) or an armed
 * schedule's walk (`bucket` = its task id, `requireUndo: true`, `maxChanges` = its rows per run,
 * `stillArmed` asked immediately before the seat). The statements are the app's own, with the
 * fresh dry-run counts as `expectChanges`.
 */
export interface OwnWriteInput {
  appId: string;
  /** `approval`, or the armed schedule's task id — the `ownUndo:<appId>:<bucket>` row the entry goes to. */
  bucket: string;
  statements: readonly string[];
  /** Positional bound values per statement. */
  params: readonly (readonly unknown[])[];
  expectChanges: readonly number[];
  /** Over the WHOLE call (`Infinity` for an approval). */
  maxChanges: number;
  /** A schedule never makes a change it cannot put back; an approval commits uncaptured instead. */
  requireUndo: boolean;
  authority: OwnWriteAuthority;
  via: OwnUndoVia;
  runId?: string;
  taskId?: string;
  /** The authority re-read FRESH after the last await, immediately before the seat — false is `stopped`. */
  stillArmed?: () => boolean;
  /**
   * Called synchronously after the commit, the entry already in its bucket and before any doorbell —
   * so the caller's own record of the change (the walk's claim row) lands in the SAME tick as the
   * undo entry it names (F20).
   */
  onCommitted?: (outcome: Extract<OwnWriteOutcome, { ok: true }>) => void;
}

/** Why an own write was not made — the held reasons the walk records, less `over-limit` (the walk's own budget, decided before this is called). */
export type OwnWriteRefusal = Exclude<ScheduleHeldReason, 'over-limit'>;

/** What an own write answers: the counts made and, when the rows were captured, the entry to undo them by. */
export type OwnWriteOutcome =
  | { ok: true; changes: number[]; undoId?: string; undoable: boolean }
  /** `current` on `changed`: the counts the statements made, through the one that moved — the approval's `drifted` answer carries them. */
  | { ok: false; reason: OwnWriteRefusal; message?: string; current?: number[] };

// --------------------------------------------------------------------------------------- answers

const C = ACCESS_ERROR_CODES;
const M = ACCESS_APP_MESSAGES;

/**
 * The entry's host-written seats around `steps` (two uuids, two instants, authority, via,
 * readerAppId ≤ 64, readerName ≤ 80 chars UTF-8, the keys) — the apply measures the steps, the
 * schema the whole entry (Gate-5 SEC-1), so the steps' cap is the entry's less this reserve.
 */
const ACCESS_UNDO_ENTRY_RESERVE_BYTES = 1024;

/** The caps every strict write runs under — the protocol's (D-PR3-15 (5), E1-Q12), the undo bytes less the entry's reserve (SEC-1). The plan and the apply share them, so the dry run refuses `too-large` before any live handle is touched. */
const STRICT_CAPS: BrokeredCaps = { maxChanges: ACCESS_WRITE_MAX_ROWS, maxUndoBytes: ACCESS_UNDO_MAX_BYTES - ACCESS_UNDO_ENTRY_RESERVE_BYTES };

/** A refusal as the wire carries it — the handler result's failure shape. */
export type WireRefusal = Extract<AccessHandlerResult, { ok: false }>;

const refuse = (code: string, message: string, retryable: boolean): WireRefusal => ({ ok: false, code, message, retryable });
/** `ACCESS_WRITE_REFUSED` with the rule's sentence — the service's spelling too, for the statement that names no table (ENG-2). */
export const writeRefused = (rule: WriteRefusalRule): WireRefusal => refuse(C.ACCESS_WRITE_REFUSED, M.writeRefused(rule), false);
const writeNotGranted = (): WireRefusal => refuse(C.ACCESS_NOT_GRANTED, M.writeNotGranted, false);
const busy = (): WireRefusal => refuse(C.ACCESS_BUSY, M.busy, true);
/** A failure of the engine or the seat: the read's sentence, never the engine's message (a constraint's name is the source's). */
const queryFailed = (message: string = M.queryFailed, retryable = false): WireRefusal => refuse(C.ACCESS_QUERY_FAILED, message, retryable);

const now = (): number => accessDeps().now();
const sum = (counts: readonly number[]): number => counts.reduce((total, count) => total + count, 0);

/** The instance a host-issued read on a namespace carries — never an app's own. */
const BROKER_INSTANCE = 'host-write-broker';
let seq = 0;

// --------------------------------------------------------------------------------- the history

/** The statement as the history keeps it: walked WHOLE first (a hit omits the seat), then cut — a read's line and a `wrote` line alike. */
export function loggedSql(sql: string): string | undefined {
  if (findRecordCredential({ sql }) !== undefined) return undefined;
  return sql.slice(0, ACCESS_LOG_SQL_MAX_CHARS);
}

/** Append a history line; a refused `sql` seat is dropped and the line tried again. Throws when the history refuses the line itself. */
export function appendLine(db: UserDb, sourceAppId: string, entry: AccessLogEntry): void {
  try {
    db.appendAccessLog(sourceAppId, entry);
  } catch (err) {
    if (entry.sql === undefined) throw err;
    const { sql: _withheld, ...rest } = entry;
    db.appendAccessLog(sourceAppId, rest);
  }
}

// ------------------------------------------------------------------------------- the live schema

/**
 * The live columns of one table on a namespace — `table_xinfo` through the driver's own read seat,
 * never an export (an export reopens the connection and discards the app's open transaction, which
 * the seat must still see as `busy`). `undefined` when the table is not there or the handle cannot
 * answer. A virtual table's hidden columns are left out, as the facts leave them out.
 */
async function liveColumnsOf(db: UserDb, appId: string, table: string): Promise<ColumnFact[] | undefined> {
  const answer = await db.driver.handle(appId, {
    v: PROTOCOL_VERSION,
    type: FRAME_TYPES.dbRequest,
    requestId: `broker-${++seq}`,
    instanceId: BROKER_INSTANCE,
    op: 'exec',
    sql: 'SELECT name, hidden FROM pragma_table_xinfo(?)',
    params: [table],
  });
  if (!answer.ok) return undefined;
  const columns = (answer.rows ?? []).filter((row) => Number(row[1]) !== 1).map((row) => ({ name: String(row[0]), generated: Number(row[1]) >= 2 }));
  return columns.length === 0 ? undefined : columns;
}

// ------------------------------------------------------------------------------------ the caches

/** Drop the cached bytes (and dump) of every grant whose source is the target — the data they copied is stale. */
export function clearSourceReadCaches(db: UserDb, targetAppId: string): void {
  for (const row of grantsForApp(db, targetAppId, now()).readBy) clearScopedReadCache(row.grant.id);
}

// ------------------------------------------------------------------------------------ strict mode

/**
 * The grant ended, or lost the table's write seat, while the write waited or planned: a stop or a
 * pause wins (the read's `endedMeanwhile`), an expiry is marked once, and a scope renewed in place
 * without the table's `write` answers rule 7's token.
 */
function endedWrite(db: UserDb, caller: AccessCaller, grantId: string, at: number): BrokeredCoreRefusal {
  const found = findAccessGrant(db, grantId);
  const current = found !== undefined && ownsGrant(caller, found) ? found : undefined;
  if (current !== undefined && current.grant.status === 'active') {
    if (!isExpired(current.grant, at)) return { ok: false, reason: 'not-granted' };
    markExpiredOnce(db, current.grant, at);
    return { ok: false, reason: 'expired' };
  }
  return { ok: false, reason: current?.grant.status === 'suspended' ? 'paused' : 'revoked' };
}

/** A plan that did not answer a plan (D-PR3-15) — every effect a read performs at the same seat, performed here. */
async function refusePlan(db: UserDb, input: BrokeredWriteRequest, outcome: Exclude<PlanOutcome, { ok: true }>, at: number): Promise<BrokeredCoreRefusal> {
  const grantId = input.grant.grant.id;
  switch (outcome.reason) {
    case 'ended':
      return endedWrite(db, input.caller, grantId, at);
    case 'unavailable':
      return { ok: false, reason: 'unavailable' };
    case 'timeout':
      if (noteTimeout(db, grantId) >= ACCESS_TIMEOUT_STRIKES) await suspendAccess(db, grantId, 'reader-misbehaved', iso(at));
      return { ok: false, reason: 'timeout' };
    case 'refused':
      return { ok: false, reason: 'refused', rule: outcome.rule };
    case 'not-granted':
      return { ok: false, reason: 'not-granted' };
    case 'too-many':
      return { ok: false, reason: 'refused', rule: 'too-many' };
    case 'too-large':
      return { ok: false, reason: 'refused', rule: 'too-large' };
    case 'unsafe':
      return { ok: false, reason: 'refused', rule: 'value' };
    case 'drift':
      await suspendAccess(db, grantId, 'source-changed', iso(at));
      return { ok: false, reason: 'source-changed' };
    case 'copy-failed':
    case 'failed':
      return { ok: false, reason: 'failed' };
  }
}

/** The seat's refusal as a token: an open transaction and a count that drifted stay apart here — the frame hears both as "try again" (S15). */
function refuseApply(applied: Exclude<BrokeredWriteResult, { ok: true }>): BrokeredCoreRefusal {
  if (!('reason' in applied)) return applied.retryable ? { ok: false, reason: 'failed', retryable: true } : { ok: false, reason: 'failed' };
  switch (applied.reason) {
    case 'busy':
      return { ok: false, reason: 'busy' };
    case 'drifted': {
      const moved = applied.current?.at(-1);
      return { ok: false, reason: 'drifted', ...(moved !== undefined ? { current: moved } : {}) };
    }
    case 'refused':
      return { ok: false, reason: 'refused', rule: applied.rule };
    case 'too-many':
      return { ok: false, reason: 'refused', rule: 'too-many' };
    case 'too-large':
      return { ok: false, reason: 'refused', rule: 'too-large' };
    case 'unsafe':
      return { ok: false, reason: 'refused', rule: 'value' };
    case 'cannot-undo': // own mode's alone — a strict write requires its undo and refuses by cell instead
    case 'failed':
      return { ok: false, reason: 'failed' };
  }
}

/**
 * A core refusal as the FRAME hears it (D-PR5-12, F5) — byte for byte what strict mode answered
 * before the core was extracted: a token per sentence, a busy target and a drifted count both
 * `ACCESS_BUSY`, never a source fact (DS19).
 */
export function wireRefusal(refusal: BrokeredCoreRefusal): WireRefusal {
  switch (refusal.reason) {
    case 'busy':
    case 'drifted':
      return busy();
    case 'not-granted':
      return writeNotGranted();
    case 'expired':
      return refuse(C.ACCESS_EXPIRED, M.expired, false);
    case 'paused':
      return refuse(C.ACCESS_REVOKED, M.paused, false);
    case 'revoked':
      return refuse(C.ACCESS_REVOKED, M.revoked, false);
    case 'source-changed':
      return refuse(C.ACCESS_REVOKED, M.sourceChanged, false);
    case 'refused':
      return writeRefused(refusal.rule);
    case 'waiting':
      return writeRefused('waiting');
    case 'timeout':
      return queryFailed(M.tookTooLong);
    case 'unavailable':
      return queryFailed(M.noWorker);
    case 'source-too-large':
      return queryFailed(M.tooLarge);
    case 'failed':
      return queryFailed(M.queryFailed, refusal.retryable === true);
  }
}

/** The journal entry after a commit (D-PR3-7) — its id, or nothing when the accessor refused or threw (the named residual: the line carries no `undoId`). */
function journal(db: UserDb, input: BrokeredWriteRequest, at: number, steps: readonly UndoStep[]): string | undefined {
  const entry = accessUndoEntrySchema.safeParse({
    id: crypto.randomUUID(),
    at: iso(at),
    expiresAt: iso(at + ACCESS_UNDO_TTL_MS),
    authority: input.authority,
    via: input.via,
    grantId: input.grant.grant.id,
    readerAppId: input.caller.appId,
    readerName: readerNameOf(db, input.caller.appId),
    steps,
  });
  if (!entry.success) {
    // The steps were measured against `STRICT_CAPS.maxUndoBytes` and every cell walked at the apply; the seats around them fit the reserve (SEC-1).
    console.warn('access: the undo entry failed its own schema — unreachable by construction; the change is applied and the line carries no undo', entry.error.message);
    return undefined;
  }
  try {
    return db.putAccessUndo(input.targetAppId, entry.data) === 'ok' ? entry.data.id : undefined;
  } catch {
    return undefined;
  }
}

/** The reader's room in the target's journal (D-PR3-15 (4), D-Q8): under the live-entry cap, and the row cap pre-checked conservatively. */
function journalHasRoom(db: UserDb, targetAppId: string, readerAppId: string): boolean {
  const live = db.listAccessUndo(targetAppId);
  if (live.filter((entry) => entry.readerAppId === readerAppId).length >= ACCESS_UNDO_MAX_ENTRIES) return false;
  return utf8ByteLength(JSON.stringify(live)) + ACCESS_UNDO_MAX_BYTES <= ACCESS_UNDO_MAX_ROW_BYTES;
}

/**
 * Strict mode's ONE body (D-PR5-12): one plain statement of another app's table, planned afresh —
 * and, in `apply` mode, applied through the seat, journaled, logged and rung — see the header. Never
 * reached without the policy's write verdict; every refusal's effect is performed here.
 */
export async function brokeredWriteCore(db: UserDb, input: BrokeredWriteRequest, options: BrokeredCoreOptions): Promise<BrokeredCoreAnswer> {
  const { grant } = input.grant;
  const { table } = input;
  // FIRST — the driver's record, before any queue or export (D-FIX-1): the plan's fresh export
  // discards the target's open transaction, so only a read of the record can answer busy for it.
  if (await db.driver.inTransaction(input.targetAppId)) return { ok: false, reason: 'busy' };
  const find = (id: string): FoundAccessGrant | undefined => findAccessGrant(db, id);
  const writable = (): boolean => stillWritable(find, input.caller, grant.id, table, now()) !== undefined;

  let planned: PlanOutcome;
  try {
    planned = await scopedPlanWrite({
      grantId: grant.id,
      bytes: sourceBytesOf(db, input.targetAppId),
      scope: readScopeOf(grant),
      statement: input.statement,
      caps: STRICT_CAPS,
      // (1) Re-checked when the plan job DEQUEUES: a stop that landed while it waited ends it before any export (S8).
      stillLive: writable,
    });
  } catch (err) {
    return { ok: false, reason: err instanceof SourceTooLarge ? 'source-too-large' : 'failed' };
  }
  const at = now();
  if (!planned.ok) return refusePlan(db, input, planned, at);
  const { plan } = planned;
  if (options.mode === 'plan') return { ok: true, phase: 'plan', changes: plan.previewChanges, table: plan.table };
  // (3) The plan took time: a stop, a pause or an expiry that landed meanwhile wins — nothing is applied (S8).
  if (!writable()) return endedWrite(db, input.caller, grant.id, at);
  // (3′) The count the user saw on the card (D-PR5-12): a fresh plan that moved halts before the room check and the seat.
  if (options.expectChanges !== undefined && plan.previewChanges !== options.expectChanges) return { ok: false, reason: 'drifted', current: plan.previewChanges };
  // (4) The reader's room in the target's journal — a live entry is never evicted (S9).
  if (!journalHasRoom(db, input.targetAppId, input.caller.appId)) return { ok: false, reason: 'waiting' };
  // (5) The seat.
  const applied = await db.driver.brokeredWrite(input.targetAppId, { plans: [plan], caps: STRICT_CAPS, expectChanges: [plan.previewChanges], requireUndo: true, capture: true });
  if (!applied.ok) return refuseApply(applied);
  // (6) After the commit: the entry, the line, the caches, the doorbells, the answer.
  const committedAt = now();
  const changes = sum(applied.changes);
  const undoId = applied.undoable ? journal(db, input, committedAt, applied.steps) : undefined;
  const sql = loggedSql(input.statement.sql);
  try {
    appendLine(db, input.targetAppId, {
      at: iso(committedAt),
      kind: 'wrote',
      grantId: grant.id,
      readerAppId: input.caller.appId,
      readerName: readerNameOf(db, input.caller.appId),
      via: input.via,
      authority: input.authority,
      changes,
      ...(undoId !== undefined ? { undoId } : {}),
      tables: [plan.table],
      ...(sql !== undefined ? { sql } : {}),
    });
  } catch {
    // The named residual (S19): the rows changed and the history could not keep the line — the answer stays true to the data.
  }
  bumpAccessRevision();
  clearSourceReadCaches(db, input.targetAppId);
  ringDataChanged(input.targetAppId, plan.table);
  ringSourceChanged(db, input.targetAppId, { except: input.caller.appId });
  return { ok: true, phase: 'applied', changes, undoable: undoId !== undefined, ...(undoId !== undefined ? { undoId } : {}) };
}

/** The frame's `write` (D-PR3-15): the core in `apply` mode, answered on the wire — `{ ok, op: 'write', changes }` and nothing else (DS16: no undo id). */
export async function brokeredWrite(db: UserDb, input: BrokeredWriteRequest): Promise<AccessHandlerResult> {
  const answer = await brokeredWriteCore(db, input, { mode: 'apply' });
  if (!answer.ok) return wireRefusal(answer);
  return { ok: true, op: 'write', changes: answer.changes };
}

// --------------------------------------------------------------------------------------- own writes

/** The busy sentence an own write answers with: the app by its name, so the user knows what to wait for. */
const midChange = (db: UserDb, appId: string): string => appMidChange(readerNameOf(db, appId));

/** The caps an own write captures under: the call's own bound on the rows, and the steps' bytes as strict mode's — the entry's cap less its reserve (SEC-1). */
const ownCaps = (maxChanges: number): BrokeredCaps => ({ maxChanges, maxUndoBytes: STRICT_CAPS.maxUndoBytes });

/** The seat's refusal as an own write's reason — the walk's held reasons (D-PR4-11). */
function ownRefusal(applied: Exclude<BrokeredWriteResult, { ok: true }>, requireUndo: boolean): Extract<OwnWriteOutcome, { ok: false }> {
  if (!('reason' in applied)) return { ok: false, reason: 'failed', message: applied.message };
  switch (applied.reason) {
    case 'busy':
      return { ok: false, reason: 'busy' };
    case 'drifted':
      return { ok: false, reason: 'changed', ...(applied.current !== undefined ? { current: applied.current } : {}) };
    // Past `maxChanges` at the seat: the dry run fitted the counts under it, so the data moved since.
    case 'too-many':
      return { ok: false, reason: 'changed' };
    case 'refused':
      return requireUndo ? { ok: false, reason: 'cannot-undo', message: applied.message } : { ok: false, reason: 'failed', message: applied.message };
    case 'cannot-undo':
    case 'too-large':
    case 'unsafe':
      return { ok: false, reason: 'cannot-undo', message: applied.message };
    case 'failed':
      return { ok: false, reason: 'failed', message: applied.message };
  }
}

/**
 * The own-write engine after the transaction read — see OWN WRITES in the header, (2)–(5). The
 * approval reaches it after its own `inTransaction` and dry run; `applyOwnWrite` after the read alone.
 */
async function seatOwnWrite(db: UserDb, input: OwnWriteInput): Promise<OwnWriteOutcome> {
  const { appId, bucket, requireUndo } = input;
  // (1′) FIRST — the bucket rule (A1): a change whose undo would land outside its own bucket is never made.
  const belongs = ownUndoBelongsIn(bucket, input);
  if (!belongs) return { ok: false, reason: requireUndo ? 'cannot-undo' : 'failed' };
  const own: OwnStatement[] = input.statements.map((sql, index) => ({ sql, params: input.params[index] ?? [] }));
  const bare = { own, expectChanges: [...input.expectChanges] };
  // (2) Room BEFORE the seat: a schedule never makes a change it has nowhere to keep the undo of.
  const room = db.ownUndoRoom(appId, bucket);
  if (!room && requireUndo) return { ok: false, reason: 'full' };
  // An approval is never refused for its size or its room: over the row cap, or with nowhere to keep it, the bare seat.
  const uncaptured = !requireUndo && (!room || sum(input.expectChanges) > ACCESS_WRITE_MAX_ROWS);
  const at = now();
  const seats = {
    id: crypto.randomUUID(),
    at: iso(at),
    expiresAt: iso(at + ACCESS_UNDO_TTL_MS),
    authority: input.authority,
    via: input.via,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
  };
  /** The entry around the captured steps — a candidate until the journal's own schema says otherwise. */
  const entry = (steps: readonly UndoStep[]): unknown => ({ ...seats, steps: [...steps] });
  // The EXACT entry the put below writes, judged by the bucket rule and the journal's own schema inside the transaction (D-PR4-4, A1).
  const admit = (steps: readonly UndoStep[]): boolean => belongs && ownUndoEntrySchema.safeParse(entry(steps)).success;
  // (3) The authority re-read after the last await — nothing is awaited between it and the seat.
  if (input.stillArmed !== undefined && !input.stillArmed()) return { ok: false, reason: 'stopped' };
  // (4) The seat.
  let applied = await db.driver.brokeredWrite(appId, uncaptured ? bare : { own, capture: true, caps: ownCaps(input.maxChanges), expectChanges: bare.expectChanges, requireUndo, admit });
  if (!applied.ok && !uncaptured && !requireUndo && 'reason' in applied && applied.reason === 'refused') {
    // The capture could not plan the batch: an approval runs it WHOLE on the bare seat — never a mixed batch.
    if (input.stillArmed !== undefined && !input.stillArmed()) return { ok: false, reason: 'stopped' };
    applied = await db.driver.brokeredWrite(appId, bare);
  }
  if (!applied.ok) return ownRefusal(applied, requireUndo);
  // (5) After the commit, in one synchronous run: the entry, the caller's record, the caches, the doorbells —
  // and from here on nothing turns the outcome into a refusal (A5): each is caught and warned on its own.
  const undoId = applied.undoable ? journalOwn(db, appId, bucket, entry(applied.steps)) : undefined;
  const outcome: Extract<OwnWriteOutcome, { ok: true }> = { ok: true, changes: applied.changes, undoable: undoId !== undefined, ...(undoId !== undefined ? { undoId } : {}) };
  afterCommit('the caller’s record', () => input.onCommitted?.(outcome));
  afterCommit('the read caches', () => clearSourceReadCaches(db, appId));
  afterCommit('data-changed', () => {
    for (const table of new Set(input.statements.map((sql) => dmlTargetTable(sql)))) ringDataChanged(appId, table);
  });
  afterCommit('access-source-changed', () => ringSourceChanged(db, appId));
  return outcome;
}

/** One effect after an own write or undo landed (A5): a throw is warned, never turned into a refusal of what already happened. */
function afterCommit(what: string, effect: () => void): void {
  try {
    effect();
  } catch (err) {
    console.warn(`own write: ${what} failed after the commit — the change stands`, err);
  }
}

/** The entry put in its bucket after a commit — its id, or nothing when the bucket refused or threw (the named residual). */
function journalOwn(db: UserDb, appId: string, bucket: string, candidate: unknown): string | undefined {
  const entry = ownUndoEntrySchema.safeParse(candidate);
  // `admit` parsed this very entry before the COMMIT — a refusal here is unreachable, and never a reason to throw after one.
  if (!entry.success) return undefined;
  try {
    return db.putOwnUndo(appId, bucket, entry.data) === 'ok' ? entry.data.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one own-write engine (PR-4, D-PR4-3/4/5/11) — see OWN WRITES in the header. Never throws:
 * every outcome is data, and nothing commits unless the authority still held at the seat.
 */
export async function applyOwnWrite(db: UserDb, input: OwnWriteInput): Promise<OwnWriteOutcome> {
  try {
    // (1) FIRST — the driver's record: an app mid-change is left exactly as it was (D-PR4-5).
    if (await db.driver.inTransaction(input.appId)) return { ok: false, reason: 'busy', message: midChange(db, input.appId) };
    return await seatOwnWrite(db, input);
  } catch (err) {
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

const failed = (message: string): ExecuteApprovedWriteOutcome => ({ ok: false, reason: 'failed', message });

/**
 * The user's approval of a change to the app's OWN data — see THE APPROVAL in the header. Never
 * throws: every outcome is one of PR-2's three shapes, an applied one saying whether it can be
 * undone. `via` is the door the user approved it at (D-PR4-6): the chat card or a result page.
 */
export async function applyApprovedWrite(db: UserDb, proposal: PendingWriteProposal, options: { via: 'chat' | 'user' }): Promise<ExecuteApprovedWriteOutcome> {
  // The class guard again, at the gate that touches data (R-B1): a DDL here means the proposal was changed after approval.
  const outOfClass = proposal.statements.map((sql) => nonDataStatementReason(sql)).find((reason) => reason !== undefined);
  if (outOfClass !== undefined) return failed(outOfClass);
  const entries = proposal.statements.map((sql, index) => ({ sql, params: proposal.params[index] ?? [] }));
  try {
    // FIRST after the guard — the driver's record (D-PR4-5): the dry run is an export, which would discard the app's open transaction.
    if (await db.driver.inTransaction(proposal.appId)) return failed(midChange(db, proposal.appId));
    // The DRY RUN on a scratch copy (F-Sm1): the counts must still be the ones the user approved.
    const dryRun = await db.scratchRun(proposal.appId, entries);
    const failure = dryRun.statements.find((statement) => statement.error !== undefined);
    if (failure !== undefined) return failed(failure.error ?? 'unknown error');
    const current = dryRun.statements.map((statement) => statement.changes ?? 0);
    if (current.length !== proposal.previewed.length || current.some((count, index) => count !== proposal.previewed[index])) {
      return { ok: false, reason: 'drifted', previewed: proposal.previewed, current };
    }
    // ALL OR NOTHING (R-M4) through the own-write engine: the approved counts are the drift halt at the
    // seat too — never a number the user did not approve (AC-F2-4) — and never refused for its size.
    const made = await seatOwnWrite(db, {
      appId: proposal.appId,
      bucket: OWN_UNDO_APPROVAL_BUCKET,
      statements: proposal.statements,
      params: entries.map((entry) => entry.params),
      expectChanges: proposal.previewed,
      maxChanges: Number.POSITIVE_INFINITY,
      requireUndo: false,
      authority: APPROVAL_WRITE_AUTHORITY,
      via: options.via,
    });
    if (made.ok) return { ok: true, executed: made.changes, undoable: made.undoable, ...(made.undoId !== undefined ? { undoId: made.undoId } : {}) };
    switch (made.reason) {
      case 'changed':
        return { ok: false, reason: 'drifted', previewed: proposal.previewed, current: made.current ?? [] };
      case 'busy':
        return failed(midChange(db, proposal.appId));
      default:
        return failed(made.message ?? made.reason);
    }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The user's undo of one own change (PR-4, D-PR4-19) — see OWN UNDO in the header. Never throws;
 * the failures are `ACCESS_SHEET.undoFailed`'s, through `OWN_UNDO.failed` (v2.1 Q19).
 */
export async function undoOwnWrite(db: UserDb, appId: string, bucket: string, undoId: string, _options: { via: 'user' }): Promise<UndoOutcome> {
  const fail = (reason: UndoFailureReason): UndoOutcome => ({ ok: false, reason, message: OWN_UNDO.failed(reason, readerNameOf(db, appId)) });
  try {
    const listing = bucket === OWN_UNDO_APPROVAL_BUCKET ? { bucket: OWN_UNDO_APPROVAL_BUCKET } : { taskId: bucket };
    const entry = db.listOwnUndo(appId, listing).find((candidate) => candidate.id === undoId);
    if (entry === undefined) return fail('gone');
    const retire = (): void => db.markOwnUndone(appId, bucket, undoId, iso(now()));
    const reversed = await reverseEntry(db, appId, entry.steps, retire);
    if (!reversed.ok) return fail(reversed.reason);
    // The rows are back: nothing after this turns the undo into a failure (A5).
    afterCommit('marking the undo done', retire);
    afterCommit('the read caches', () => clearSourceReadCaches(db, appId));
    afterCommit('data-changed', () => {
      for (const table of new Set(entry.steps.map((step) => step.table))) ringDataChanged(appId, table);
    });
    afterCommit('access-source-changed', () => ringSourceChanged(db, appId));
    return { ok: true };
  } catch {
    return fail('failed');
  }
}

// ------------------------------------------------------------------------------------------- undo

/**
 * The undo's ONE core, strict and own alike: every step's table and columns re-validated against the
 * live schema (S3) — a mismatch can never be undone, so the entry is retired and the answer is
 * `gone` — then the seat's `{ undo }` with the steps in REVERSE order (S18), and its refusal as the
 * user hears it. A done undo's retirement is the caller's, beside what it writes after.
 */
async function reverseEntry(db: UserDb, appId: string, steps: readonly UndoStep[], retire: () => void): Promise<{ ok: true; changes: number } | { ok: false; reason: UndoFailureReason }> {
  for (const step of steps) {
    const columns = await liveColumnsOf(db, appId, step.table);
    const present = columns !== undefined && step.columns.every((name) => columns.some((column) => column.name.toLowerCase() === name.toLowerCase() && !column.generated));
    if (!present) {
      retire();
      return { ok: false, reason: 'gone' };
    }
  }
  const applied = await db.driver.brokeredWrite(appId, { undo: [...steps].reverse() });
  if (applied.ok) return { ok: true, changes: sum(applied.changes) };
  if (!('reason' in applied)) return { ok: false, reason: 'failed' };
  switch (applied.reason) {
    case 'busy':
      return { ok: false, reason: 'busy' };
    case 'drifted':
      return { ok: false, reason: 'changed' };
    case 'refused':
      retire();
      return { ok: false, reason: 'gone' };
    case 'too-many':
    case 'too-large':
    case 'unsafe':
    case 'cannot-undo':
    case 'failed':
      return { ok: false, reason: 'failed' };
  }
}

/**
 * The user's undo of one journaled change (D-PR3-15; §24.5 MUST 23) — see the header. Never
 * throws: every outcome is data, and nothing changes unless every row still holds what the write
 * left. Every outcome bumps the access revision (ENG-4) — the sheet re-reads, never bumps.
 */
export async function undoBrokeredWrite(db: UserDb, targetAppId: string, undoId: string, options: { via: 'user' }): Promise<UndoOutcome> {
  try {
    return await performUndo(db, targetAppId, undoId, options);
  } finally {
    bumpAccessRevision();
  }
}

async function performUndo(db: UserDb, targetAppId: string, undoId: string, options: { via: 'user' }): Promise<UndoOutcome> {
  const sourceName = readerNameOf(db, targetAppId);
  const fail = (reason: UndoFailureReason): UndoOutcome => ({ ok: false, reason, message: ACCESS_SHEET.undoFailed(reason, sourceName) });
  const entry = db.listAccessUndo(targetAppId).find((candidate) => candidate.id === undoId);
  if (entry === undefined) return fail('gone');
  const reversed = await reverseEntry(db, targetAppId, entry.steps, () => db.markAccessUndone(targetAppId, undoId, iso(now())));
  if (!reversed.ok) return fail(reversed.reason);
  const at = iso(now());
  db.markAccessUndone(targetAppId, undoId, at);
  const tables = [...new Set(entry.steps.map((step) => step.table))];
  try {
    db.appendAccessLog(targetAppId, {
      at,
      kind: 'undone',
      grantId: entry.grantId,
      readerAppId: entry.readerAppId,
      readerName: db.getApp(entry.readerAppId)?.displayName ?? entry.readerName,
      via: options.via,
      changes: reversed.changes,
      tables,
    });
  } catch {
    // The rows are back; a history with no room for the line is never a reason to leave them changed.
  }
  clearSourceReadCaches(db, targetAppId);
  ringDataChanged(targetAppId, tables.length === 1 ? tables[0] : undefined);
  ringSourceChanged(db, targetAppId);
  return { ok: true };
}
