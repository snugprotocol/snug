// access/writeBroker.ts — the engine half of the Write Broker: one app's bounded, journaled,
// undoable write onto another app's table, and the app's own approved write through the same
// seat (TASK-20261010-host-broker PR-3; ADR-0076 §4–§5; contract v2 D-PR3-7 the journal holds rows
// never SQL · D-PR3-8 one broker, two modes · D-PR3-11 the driver seat · D-PR3-12 five refusals ·
// D-PR3-15 the engine half · D-PR3-20 (c) the broker's doorbells · D-PR3-25 the vocabulary; v2.1
// notes E1-Q1/Q2/Q9/Q12, D-Q8/Q10/Q19/Q20; spec 1.2 §24.5 MUSTs 18–24).
//
// STRICT MODE — `brokeredWrite` (another app's data, authority `permission` from a frame's `write`
// the policy admitted). The order is the contract's and every step of it is observable:
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
//      `BEGIN IMMEDIATE`, the capture, the statement, the drift halt, the cells walked, `COMMIT`;
//  (6) after the commit, in this order: the journal entry (`putAccessUndo` — the seat's refusal or
//      throw after a commit is the one residual, named: the line then carries no `undoId`) → the
//      `wrote` line on the TARGET's history at once (`via`, `authority`, `changes`, `undoId`,
//      `tables: [table]`, the statement as the history keeps it — walked whole, cut at 200; a
//      storage throw here is the second named residual) → the read caches of every grant on the
//      target cleared → the doorbells (`data-changed { table }` to the target's live frame,
//      `access-source-changed { grantId }` to every OTHER live reader — never the writer) → the
//      answer `{ ok, op: 'write', changes }` and nothing else (DS16: no undo id on the wire).
// The refusals, every one in the reader's words from copy.ts and none naming a source fact (DS19):
// a parse, column, facts, value or cap refusal → `ACCESS_WRITE_REFUSED` with its rule's token
// (E1-Q1); `busy` and a strict `drifted` → `ACCESS_BUSY` (retryable, no count — S15); the plan's
// `not-granted` → `ACCESS_NOT_GRANTED`; `drift` → the read's `sourceChanged` after the grant is
// paused `source-changed`; a SQL failure → `ACCESS_QUERY_FAILED` without the engine's message (a
// constraint's name is the source's). A statement whose verb names no table is not one plain
// INSERT, UPDATE or DELETE — refused `statement` before any queue (the policy left rule 7 to this
// module for it; see policy.ts).
//
// OWN MODE — `applyApprovedWrite` (the app's OWN data the user approved on a card, D-PR3-8):
// the DML class only (`nonDataStatementReason`, today's guard), the dry run through `scratchRun`
// for the previewed-count drift halt (F-Sm1, unchanged), then the SAME seat with `requireUndo:
// false, capture: false, expectChanges: proposal.previewed` — atomic and counted, NO journal, NO
// history line, NO undo id — and `data-changed { table }` to the app's own live frame after the
// commit, so the open app re-reads what its chat changed. The outcome keeps PR-2's three shapes;
// `executeApprovedWrite` is a thin caller. The seat's apply reads each plan's `op`, `table`, its
// GRANTED columns and the SET / INSERT lists (D-Q1) before the transaction even when nothing is
// captured, so own mode builds those from the live `table_xinfo` and the statement's own text —
// the SET columns before each `=`, the INSERT list, or every non-generated column when the
// statement lists none — reading no value and never parsing the rest; a statement the text
// cannot shape is answered `failed`, and nothing is applied (D-IE1-3).
//
// UNDO — `undoBrokeredWrite` (the USER's act from the target's history, `via: 'user'`): the live
// entry (an unknown, undone or expired id is `gone`) → every step's table and columns re-validated
// against the live `table_xinfo` through the driver's read seat — the table exists, every named
// column exists, none is generated — a mismatch is `gone` and the entry is marked undone-failed
// (S3; D-Q10) → the seat with the steps in REVERSE order (`{ undo }`: the apply re-validates the
// shape, BUILDS every inverse from the structure with every value a bound parameter, runs the
// belt over each, and rolls the WHOLE undo back unless every inverse put back exactly one row —
// S18) → `markAccessUndone` → the `undone` line (`via: 'user'`, `changes` summed over the steps,
// `tables`) → the caches cleared → `data-changed` to the target and `access-source-changed` to
// EVERY live reader, the one whose write was reversed included (S19) → `{ ok: true }`. A refusal
// is `{ ok: false, reason, message }` with the reason's token — `busy` · `changed` (the guard
// mismatch, nothing changed) · `gone` · `failed` (a SQL error: a rowid reused since, D-Q19) — and
// `ACCESS_SHEET.undoFailed`'s sentence for it (E1-Q2). An undo is never journaled.
//
// `clearSourceReadCaches(db, target)` drops the cached bytes of every grant whose source is the
// target — the refresh engine calls it after a result too (D-PR3-17 (9)).
//
// LOAD ORDER (grants.ts's rule): nothing here calls another access module at the top level. No
// string here spells the engine's internal words (copy.ts's vocabulary scan reads this file).

import {
  ACCESS_ERROR_CODES,
  ACCESS_LOG_SQL_MAX_CHARS,
  ACCESS_SOURCE_MAX_BYTES,
  ACCESS_TIMEOUT_STRIKES,
  ACCESS_UNDO_MAX_BYTES,
  ACCESS_UNDO_MAX_ENTRIES,
  ACCESS_UNDO_MAX_ROW_BYTES,
  ACCESS_UNDO_TTL_MS,
  ACCESS_WRITE_MAX_ROWS,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessUndoEntrySchema,
  findRecordCredential,
  utf8ByteLength,
  type AccessLogEntry,
  type AccessLogVia,
  type AccessWriteAuthority,
} from '@snugprotocol/protocol';
import { dmlTargetTable, nonDataStatementReason, type BrokeredCaps, type BrokeredOp, type BrokeredPlan, type BrokeredWriteResult, type ColumnFact, type ScopedReadStatement, type UndoStep, type UserDb } from '@snugprotocol/db';
import type { AccessHandlerResult } from '@snugprotocol/runner';

import type { ExecuteApprovedWriteOutcome, PendingWriteProposal } from '../agent/dataTools.js';
import { ACCESS_APP_MESSAGES, ACCESS_SHEET, type UndoFailureReason, type WriteRefusalRule } from './copy.js';
import { ringDataChanged, ringSourceChanged } from './doorbell.js';
import { isExpired } from './grantFacts.js';
import { accessDeps, bumpAccessRevision, findAccessGrant, grantsForApp, markExpiredOnce, noteTimeout, suspendAccess, type FoundAccessGrant } from './grants.js';
import { readScopeOf } from './materialise.js';
import { ownsGrant, stillWritable, type AccessCaller } from './policy.js';
import { clearScopedReadCache, scopedPlanWrite, type PlanOutcome } from './scopedRead.js';

// ---------------------------------------------------------------------------------------- shapes

/** One strict-mode write as the service hands it over (D-PR3-15). */
export interface BrokeredWriteRequest {
  targetAppId: string;
  statement: ScopedReadStatement;
  authority: AccessWriteAuthority;
  via: AccessLogVia;
  /** The grant the policy admitted — re-checked here at the dequeue and after the plan. */
  grant: FoundAccessGrant;
  caller: AccessCaller;
}

/** What the user's undo answers (E1-Q2): done, or the reason's token with its sentence. */
export type UndoOutcome = { ok: true } | { ok: false; reason: UndoFailureReason; message: string };

// --------------------------------------------------------------------------------------- answers

const C = ACCESS_ERROR_CODES;
const M = ACCESS_APP_MESSAGES;

/** The caps every strict write runs under — the protocol's (D-PR3-15 (5), E1-Q12). */
const STRICT_CAPS: BrokeredCaps = { maxChanges: ACCESS_WRITE_MAX_ROWS, maxUndoBytes: ACCESS_UNDO_MAX_BYTES };

const refuse = (code: string, message: string, retryable: boolean): AccessHandlerResult => ({ ok: false, code, message, retryable });
const writeRefused = (rule: WriteRefusalRule): AccessHandlerResult => refuse(C.ACCESS_WRITE_REFUSED, M.writeRefused(rule), false);
const writeNotGranted = (): AccessHandlerResult => refuse(C.ACCESS_NOT_GRANTED, M.writeNotGranted, false);
const busy = (): AccessHandlerResult => refuse(C.ACCESS_BUSY, M.busy, true);
/** A failure of the engine or the seat: the read's sentence, never the engine's message (a constraint's name is the source's). */
const queryFailed = (message: string = M.queryFailed, retryable = false): AccessHandlerResult => refuse(C.ACCESS_QUERY_FAILED, message, retryable);

class SourceTooLarge extends Error {}

const iso = (at: number): string => new Date(at).toISOString();
const now = (): number => accessDeps().now();
const readerName = (db: UserDb, appId: string): string => db.getApp(appId)?.displayName ?? appId;
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
 * without the table's `write` answers rule 7's sentence.
 */
function endedWrite(db: UserDb, caller: AccessCaller, grantId: string, at: number): AccessHandlerResult {
  const found = findAccessGrant(db, grantId);
  const current = found !== undefined && ownsGrant(caller, found) ? found : undefined;
  if (current !== undefined && current.grant.status === 'active') {
    if (!isExpired(current.grant, at)) return writeNotGranted();
    markExpiredOnce(db, current.grant, at);
    return refuse(C.ACCESS_EXPIRED, M.expired, false);
  }
  return refuse(C.ACCESS_REVOKED, current?.grant.status === 'suspended' ? M.paused : M.revoked, false);
}

/** A plan that did not answer a plan, as the reader hears it (D-PR3-15) — every effect a read performs at the same seat, performed. */
async function refusePlan(db: UserDb, input: BrokeredWriteRequest, outcome: Exclude<PlanOutcome, { ok: true }>, at: number): Promise<AccessHandlerResult> {
  const grantId = input.grant.grant.id;
  switch (outcome.reason) {
    case 'ended':
      return endedWrite(db, input.caller, grantId, at);
    case 'unavailable':
      return queryFailed(M.noWorker);
    case 'timeout':
      if (noteTimeout(db, grantId) >= ACCESS_TIMEOUT_STRIKES) await suspendAccess(db, grantId, 'reader-misbehaved', iso(at));
      return queryFailed(M.tookTooLong);
    case 'refused':
      return writeRefused(outcome.rule);
    case 'not-granted':
      return writeNotGranted();
    case 'too-many':
      return writeRefused('too-many');
    case 'too-large':
      return writeRefused('too-large');
    case 'unsafe':
      return writeRefused('value');
    case 'drift':
      await suspendAccess(db, grantId, 'source-changed', iso(at));
      return refuse(C.ACCESS_REVOKED, M.sourceChanged, false);
    case 'copy-failed':
    case 'failed':
      return queryFailed();
  }
}

/** The seat's refusal as the reader hears it: the app's open transaction and a count that drifted are both "try again" (S15). */
function refuseApply(applied: Exclude<BrokeredWriteResult, { ok: true }>): AccessHandlerResult {
  if (!('reason' in applied)) return queryFailed(M.queryFailed, applied.retryable);
  switch (applied.reason) {
    case 'busy':
    case 'drifted':
      return busy();
    case 'refused':
      return writeRefused(applied.rule);
    case 'too-many':
      return writeRefused('too-many');
    case 'too-large':
      return writeRefused('too-large');
    case 'unsafe':
      return writeRefused('value');
    case 'failed':
      return queryFailed();
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
    readerName: readerName(db, input.caller.appId),
    steps,
  });
  if (!entry.success) return undefined;
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

/** Strict mode: one plain statement of another app's table, planned afresh, applied through the seat, journaled, logged, rung — see the header. */
export async function brokeredWrite(db: UserDb, input: BrokeredWriteRequest): Promise<AccessHandlerResult> {
  const { grant } = input.grant;
  const table = dmlTargetTable(input.statement.sql);
  if (table === undefined) return writeRefused('statement');
  const find = (id: string): FoundAccessGrant | undefined => findAccessGrant(db, id);
  const writable = (): boolean => stillWritable(find, input.caller, grant.id, table, now()) !== undefined;

  let planned: PlanOutcome;
  try {
    planned = await scopedPlanWrite({
      grantId: grant.id,
      bytes: async () => {
        const bytes = await db.exportAppRuntime(input.targetAppId);
        if (bytes.byteLength > ACCESS_SOURCE_MAX_BYTES) throw new SourceTooLarge();
        return bytes;
      },
      scope: readScopeOf(grant),
      statement: input.statement,
      caps: STRICT_CAPS,
      // (1) Re-checked when the plan job DEQUEUES: a stop that landed while it waited ends it before any export (S8).
      stillLive: writable,
    });
  } catch (err) {
    return err instanceof SourceTooLarge ? queryFailed(M.tooLarge) : queryFailed();
  }
  const at = now();
  if (!planned.ok) return refusePlan(db, input, planned, at);
  // (3) The plan took time: a stop, a pause or an expiry that landed meanwhile wins — nothing is applied (S8).
  if (!writable()) return endedWrite(db, input.caller, grant.id, at);
  // (4) The reader's room in the target's journal — a live entry is never evicted (S9).
  if (!journalHasRoom(db, input.targetAppId, input.caller.appId)) return writeRefused('waiting');
  // (5) The seat.
  const { plan } = planned;
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
      readerName: readerName(db, input.caller.appId),
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
  return { ok: true, op: 'write', changes };
}

// --------------------------------------------------------------------------------------- own mode

const failed = (message: string): ExecuteApprovedWriteOutcome => ({ ok: false, reason: 'failed', message });

const stripComments = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();

/** The verb's op of a comment-stripped statement — the class guard admits only these three verbs, so the text always says. */
function opOf(sql: string): BrokeredOp | undefined {
  const verb = /^(INSERT|UPDATE|DELETE)\b/i.exec(sql)?.[1]?.toUpperCase();
  switch (verb) {
    case 'INSERT':
      return 'insert';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return undefined;
  }
}

/** One identifier as the statement spells it — bare, "quoted", `quoted` or [bracketed] — unquoted; `undefined` for anything else. */
function identifierOf(text: string): string | undefined {
  const trimmed = text.trim();
  const quoted = /^"((?:[^"]|"")*)"$/.exec(trimmed);
  if (quoted !== null) return quoted[1]!.replace(/""/g, '"');
  const ticked = /^`((?:[^`]|``)*)`$/.exec(trimmed);
  if (ticked !== null) return ticked[1]!.replace(/``/g, '`');
  const bracketed = /^\[([^\]]*)\]$/.exec(trimmed);
  if (bracketed !== null) return bracketed[1];
  return /^[A-Za-z_][\w$]*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Walk `text` outside its quoted spans ('…', "…", `…`, […] — a doubled quote stays inside), handing
 * `visit` each unquoted character with the parenthesis depth BEFORE it; `visit` answers true to stop
 * there. The index stopped at, or -1 when the walk ran out. Reads structure only, never a value.
 */
function scanUnquoted(text: string, visit: (index: number, char: string, depth: number) => boolean): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== undefined) {
      if (char !== quote) continue;
      if (quote !== ']' && text[index + 1] === quote) index += 1;
      else quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') {
      quote = ']';
      continue;
    }
    if (visit(index, char, depth)) return index;
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
  }
  return -1;
}

/** `text` split at its top-level commas, each part trimmed. */
function topLevelTerms(text: string): string[] {
  const terms: string[] = [];
  let start = 0;
  scanUnquoted(text, (index, char, depth) => {
    if (char === ',' && depth === 0) {
      terms.push(text.slice(start, index).trim());
      start = index + 1;
    }
    return false;
  });
  terms.push(text.slice(start).trim());
  return terms;
}

/** Where the first top-level keyword of `keywords` begins in `text`, or the text's end. */
function clauseEnd(text: string, keywords: readonly string[]): number {
  const upper = text.toUpperCase();
  const at = scanUnquoted(
    text,
    (index, char, depth) =>
      depth === 0 &&
      /[A-Za-z]/.test(char) &&
      (index === 0 || !/[\w$]/.test(text[index - 1]!)) &&
      keywords.some((keyword) => upper.startsWith(keyword, index) && !/[\w$]/.test(text[index + keyword.length] ?? ' ')),
  );
  return at === -1 ? text.length : at;
}

/** The index of the parenthesis that closes the one `text` opens with, or -1. */
const closingParen = (text: string): number => scanUnquoted(text, (_index, char, depth) => char === ')' && depth === 1);

const IDENTIFIER = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]*\\]|[A-Za-z_][\\w$]*)';
/** SQLite's qualified-table-name tail after the table: an alias and an index hint, each optional. */
const TABLE_TAIL = `(?:\\s+AS\\s+${IDENTIFIER})?(?:\\s+(?:NOT\\s+INDEXED|INDEXED\\s+BY\\s+${IDENTIFIER}))?`;

/** An UPDATE's SET columns, in SET order, from the text alone — `undefined` when the text cannot say. */
function setColumnsOf(sql: string): string[] | undefined {
  const head = new RegExp(`^UPDATE\\s+(?:OR\\s+[A-Za-z]+\\s+)?${IDENTIFIER}${TABLE_TAIL}\\s+SET\\s+`, 'i').exec(sql);
  if (head === null) return undefined;
  const rest = sql.slice(head[0].length);
  const clause = rest.slice(0, clauseEnd(rest, ['WHERE', 'FROM', 'RETURNING', 'ORDER', 'LIMIT']));
  const columns: string[] = [];
  for (const term of topLevelTerms(clause)) {
    const equals = scanUnquoted(term, (_index, char, depth) => char === '=' && depth === 0);
    const column = equals === -1 ? undefined : identifierOf(term.slice(0, equals));
    if (column === undefined) return undefined;
    columns.push(column);
  }
  return columns.length > 0 ? columns : undefined;
}

/** An INSERT's column list from the text alone — `undefined` when it lists none (every non-generated column, then), `null` when the text cannot say. */
function insertColumnsOf(sql: string): string[] | undefined | null {
  const head = new RegExp(`^INSERT\\s+(?:OR\\s+[A-Za-z]+\\s+)?INTO\\s+${IDENTIFIER}(?:\\s+AS\\s+${IDENTIFIER})?\\s*`, 'i').exec(sql);
  if (head === null) return null;
  const rest = sql.slice(head[0].length);
  if (!rest.startsWith('(')) return undefined;
  const close = closingParen(rest);
  if (close === -1) return null;
  const columns: string[] = [];
  for (const term of topLevelTerms(rest.slice(1, close))) {
    const column = identifierOf(term);
    if (column === undefined) return null;
    columns.push(column);
  }
  return columns.length > 0 ? columns : null;
}

/** One approved statement as the seat's plan (own mode, D-IE1-3): its op, its table, the live columns, the SET / INSERT list it names, the approved count. */
async function ownPlanOf(db: UserDb, appId: string, statement: { sql: string; params: unknown[] }, previewChanges: number): Promise<BrokeredPlan | string> {
  const sql = stripComments(statement.sql);
  const op = opOf(sql);
  const table = dmlTargetTable(sql);
  if (op === undefined || table === undefined) return 'the change could not be read';
  const live = await liveColumnsOf(db, appId, table);
  if (live === undefined) return `no such table: ${table}`;
  const base: BrokeredPlan = { sql: statement.sql, params: statement.params, op, table, columns: live.map((column) => column.name), previewChanges };
  switch (op) {
    case 'update': {
      const setColumns = setColumnsOf(sql);
      return setColumns === undefined ? 'the change could not be read' : { ...base, setColumns };
    }
    case 'insert': {
      const listed = insertColumnsOf(sql);
      if (listed === null) return 'the change could not be read';
      return { ...base, insertColumns: listed ?? live.filter((column) => !column.generated).map((column) => column.name) };
    }
    case 'delete':
      return base;
  }
}

/**
 * Own mode: the approved write of an app's OWN data — the class guard, the dry run's drift halt,
 * the seat with no capture and no journal, `data-changed` to the app's own frame — see the header.
 * Never throws: every outcome is one of PR-2's three.
 */
export async function applyApprovedWrite(db: UserDb, proposal: PendingWriteProposal): Promise<ExecuteApprovedWriteOutcome> {
  // The class guard again, at the gate that touches data (R-B1): a DDL here means the proposal was changed after approval.
  const outOfClass = proposal.statements.map((sql) => nonDataStatementReason(sql)).find((reason) => reason !== undefined);
  if (outOfClass !== undefined) return failed(outOfClass);
  const entries = proposal.statements.map((sql, index) => ({ sql, params: proposal.params[index] ?? [] }));
  try {
    // The DRY RUN on a scratch copy (F-Sm1): the counts must still be the ones the user approved.
    const dryRun = await db.scratchRun(proposal.appId, entries);
    const failure = dryRun.statements.find((statement) => statement.error !== undefined);
    if (failure !== undefined) return failed(failure.error ?? 'unknown error');
    const current = dryRun.statements.map((statement) => statement.changes ?? 0);
    if (current.length !== proposal.previewed.length || current.some((count, index) => count !== proposal.previewed[index])) {
      return { ok: false, reason: 'drifted', previewed: proposal.previewed, current };
    }
    const plans: BrokeredPlan[] = [];
    for (const [index, entry] of entries.entries()) {
      const plan = await ownPlanOf(db, proposal.appId, entry, proposal.previewed[index] ?? 0);
      if (typeof plan === 'string') return failed(plan);
      plans.push(plan);
    }
    // ALL OR NOTHING (R-M4), through the one seat: the previewed counts are the drift halt at the apply too.
    const applied = await db.driver.brokeredWrite(proposal.appId, {
      plans,
      caps: { maxChanges: Math.max(0, ...proposal.previewed), maxUndoBytes: ACCESS_UNDO_MAX_BYTES },
      expectChanges: proposal.previewed,
      requireUndo: false,
      capture: false,
    });
    if (!applied.ok) {
      if ('reason' in applied && applied.reason === 'drifted') return { ok: false, reason: 'drifted', previewed: applied.previewed ?? proposal.previewed, current: applied.current ?? [] };
      return failed(applied.message);
    }
    for (const table of new Set(plans.map((plan) => plan.table))) ringDataChanged(proposal.appId, table);
    // `executed` is the count the seat made — equal to the preview by the drift halt, never a number the user did not approve (AC-F2-4).
    return { ok: true, executed: applied.changes };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ------------------------------------------------------------------------------------------- undo

/** `markAccessUndone` with the contract's fourth seat (D-Q10): a failed undo is marked like a done one; the db ignores the flag. */
type MarkAccessUndone = (targetAppId: string, id: string, at: string, failed?: boolean) => void;

/**
 * The user's undo of one journaled change (D-PR3-15; §24.5 MUST 23) — see the header. Never
 * throws: every outcome is data, and nothing changes unless every row still holds what the write left.
 */
export async function undoBrokeredWrite(db: UserDb, targetAppId: string, undoId: string, options: { via: 'user' }): Promise<UndoOutcome> {
  const sourceName = db.getApp(targetAppId)?.displayName ?? targetAppId;
  const fail = (reason: UndoFailureReason): UndoOutcome => ({ ok: false, reason, message: ACCESS_SHEET.undoFailed(reason, sourceName) });
  const markUndone = db.markAccessUndone.bind(db) as MarkAccessUndone;
  const entry = db.listAccessUndo(targetAppId).find((candidate) => candidate.id === undoId);
  if (entry === undefined) return fail('gone');
  // The live schema (S3): every step's table and columns as `table_xinfo` has them now — a mismatch can no longer be undone.
  for (const step of entry.steps) {
    const columns = await liveColumnsOf(db, targetAppId, step.table);
    const present = columns !== undefined && step.columns.every((name) => columns.some((column) => column.name.toLowerCase() === name.toLowerCase() && !column.generated));
    if (!present) {
      markUndone(targetAppId, undoId, iso(now()), true);
      return fail('gone');
    }
  }
  const steps = [...entry.steps].reverse();
  const applied = await db.driver.brokeredWrite(targetAppId, { undo: steps, caps: STRICT_CAPS });
  if (!applied.ok) {
    if (!('reason' in applied)) return fail('failed');
    switch (applied.reason) {
      case 'busy':
        return fail('busy');
      case 'drifted':
        return fail('changed');
      case 'refused':
        markUndone(targetAppId, undoId, iso(now()), true);
        return fail('gone');
      case 'too-many':
      case 'too-large':
      case 'unsafe':
      case 'failed':
        return fail('failed');
    }
  }
  const at = iso(now());
  markUndone(targetAppId, undoId, at);
  const tables = [...new Set(entry.steps.map((step) => step.table))];
  try {
    db.appendAccessLog(targetAppId, {
      at,
      kind: 'undone',
      grantId: entry.grantId,
      readerAppId: entry.readerAppId,
      readerName: db.getApp(entry.readerAppId)?.displayName ?? entry.readerName,
      via: options.via,
      changes: sum(applied.changes),
      tables,
    });
  } catch {
    // The rows are back; a history with no room for the line is never a reason to leave them changed.
  }
  bumpAccessRevision();
  clearSourceReadCaches(db, targetAppId);
  ringDataChanged(targetAppId, tables.length === 1 ? tables[0] : undefined);
  ringSourceChanged(db, targetAppId);
  return { ok: true };
}
