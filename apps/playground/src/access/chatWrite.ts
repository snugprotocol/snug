// access/chatWrite.ts — the chat's change to ANOTHER app's table: the plan behind its card, and
// the apply the user's *apply to Ledger* reaches (TASK-20261010-host-broker PR-5; ADR-0076 §5;
// contract v2 D-PR5-11, D-PR5-12 and its v2.1 answers TC-Q4, TC-Q8, TC-Q9; F5, F6, S9, S17).
//
// OUTSIDE THE KIT GRAPH (D-PR5-12, SC13). Its ONLY importers are `agent/laneTools.ts` (which binds
// the seat's `planWrite`) and `agent/accessWriteCard.ts` (which exports `approveCrossAppWrite`) —
// both swapped out of the kit, so no kit byte reaches these verbs (pinned by `kitDeadLanes.test.ts`).
//
// Both verbs run over ONE strict core extracted from the Write Broker (`brokeredWriteCore`): the
// plan never reaches the driver's seat (`planChatWrite`), and the apply re-plans at approve time
// and halts on drift BEFORE the room check and the seat (`writeChatApproved`). The frame's `write`
// keeps its wire bytes.
//
// THE POLICY FIRST, as the service's `write` asks it: the statement's table read off its verb, then
// the chat caller's `write` verdict (rules 1–3, the chat always present, the WhatsApp fact, the named
// table's `write`). A refused verdict performs no effect and writes no line (E1-Q3) — the core's own
// re-checks (the dequeue, after the plan) perform theirs, as a frame's write does.
//
// THE APPROVAL IS THE CARD'S, re-checked against the access AS IT IS NOW (`writeChatApproved`):
// the same id AND the same `grantedAt` (a renewal keeps the id — S9), the same source, a statement
// whose verb still names the card's table, a count of at least one row — `ok` ⇒ applied;
// `undoable`/`undoId` when its journal entry was written (S17), and a change of no rows has none —
// then the verdict, then the core with the count the user saw. Every outcome carries `why`,
// D-PR5-12's table, which is all the card words; `message` is the sentence an app would hear for
// the same refusal (never shown on the card). An access no longer found is `gone` only when its
// SOURCE app is gone; otherwise it ENDED — a "while it's open" access goes with its reader's view
// and with a reload, and one of another generation was the view before's (Gate-5 G5-16 ii-2): the
// card says to allow it again, never that Ledger is gone.
//
// THE PLAN answers the `grantedAt` of the access it was planned under (G5-16 ii-7, SB-8): the card
// binds to THAT instant, never to the access as it is after the plan's awaits.

import { ACCESS_ERROR_CODES, APPROVAL_WRITE_AUTHORITY } from '@snugprotocol/protocol';
import { dmlTargetTable, type UserDb } from '@snugprotocol/db';
import type { AccessHandlerResult } from '@snugprotocol/runner';

import type { ExecuteApprovedWriteOutcome } from '../agent/dataTools.js';
import { ACCESS_APP_MESSAGES } from './copy.js';
import { accessDeps, findAccessGrant, type FoundAccessGrant } from './grants.js';
import { authorise, ownsGrant, type AccessCaller } from './policy.js';
import { policyContextFor } from './service.js';
import { brokeredWriteCore, wireRefusal, writeRefused, type BrokeredCoreRefusal } from './writeBroker.js';

/** Why an approved cross-app change did not apply — D-PR5-12's why table; the card words each (`DATA_WRITE_CARD.crossFailed`). */
export const ACCESS_WRITE_FAILED_WHYS = ['busy', 'drifted', 'ended', 'not-allowed', 'refused', 'waiting', 'gone', 'failed'] as const;
export type AccessWriteFailedWhy = (typeof ACCESS_WRITE_FAILED_WHYS)[number];

/** The one door these verbs serve. */
export type ChatAccessCaller = Extract<AccessCaller, { kind: 'chat' }>;

/** A refusal in the frame's shape — its message is `ACCESS_APP_MESSAGES`' words. */
export type ChatWriteRefusal = Extract<AccessHandlerResult, { ok: false }>;

/** What the plan of one statement comes to: how many rows of which of the source's tables it would change, under the access allowed at `grantedAt` — or why not. */
export type ChatWritePlan = { ok: true; changes: number; table: string; grantedAt: string } | ChatWriteRefusal;

/** The card's target, re-checked at approve time: the live access under the same id AND `grantedAt` (a renewal keeps the id — S9). */
export interface ChatWriteApprovedInput {
  grantId: string;
  grantedAt: string;
  sourceAppId: string;
  /** The source's own table the card names — the statement's DML target must be it. */
  table: string;
  /** The source-named statement the card shows. */
  sql: string;
  /** The count the card showed — a fresh plan that differs is `drifted` before anything is seated. */
  expectChanges: number;
}

/** The own card's outcome shape, with the why of a refusal. `ok` ⇒ applied; `undoable`/`undoId` when its journal entry was written (S17). */
export type ChatWriteApprovedOutcome = ExecuteApprovedWriteOutcome & { why?: AccessWriteFailedWhy };

const C = ACCESS_ERROR_CODES;
const M = ACCESS_APP_MESSAGES;

/** SQLite's names compare without case, ASCII only. */
const sameName = (a: string, b: string): boolean => a.replace(/[A-Z]/g, (ch) => ch.toLowerCase()) === b.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

/** The chat's write verdict for `table` — the policy's, read with the engine's finder and clock; nothing performed. */
function writeVerdict(db: UserDb, caller: ChatAccessCaller, grantId: string, table: string): { ok: true; found: FoundAccessGrant } | ChatWriteRefusal {
  const verdict = authorise(policyContextFor(db, accessDeps().now()), caller, { kind: 'write', grantId, table });
  return verdict.ok ? { ok: true, found: verdict.grant } : { ok: false, code: verdict.code, message: verdict.message, retryable: verdict.retryable };
}

/** The core's request for the chat's door: the approval's authority, the chat's `via` (D-PR5-12). */
const requestFor = (found: FoundAccessGrant, caller: ChatAccessCaller, sql: string, table: string) => ({
  targetAppId: found.grant.sourceAppId,
  statement: { sql },
  table,
  authority: APPROVAL_WRITE_AUTHORITY,
  via: 'chat' as const,
  grant: found,
  caller,
});

/** Plan one statement on a table the chat may change — the dry run on a fresh copy; never the driver's seat. */
export async function planChatWrite(db: UserDb, caller: ChatAccessCaller, input: { grantId: string; sql: string }): Promise<ChatWritePlan> {
  try {
    const table = dmlTargetTable(input.sql);
    if (table === undefined) return writeRefused('statement');
    const verdict = writeVerdict(db, caller, input.grantId, table);
    if (!verdict.ok) return verdict;
    const answer = await brokeredWriteCore(db, requestFor(verdict.found, caller, input.sql, table), { mode: 'plan' });
    return answer.ok ? { ok: true, changes: answer.changes, table: answer.table, grantedAt: verdict.found.grant.grantedAt } : wireRefusal(answer);
  } catch {
    return { ok: false, code: C.ACCESS_QUERY_FAILED, message: M.queryFailed, retryable: false };
  }
}

/** D-PR5-12's why table, for a core refusal. */
function whyOf(refusal: BrokeredCoreRefusal): AccessWriteFailedWhy {
  switch (refusal.reason) {
    case 'busy':
      return 'busy';
    case 'drifted':
      return 'drifted';
    case 'expired':
    case 'paused':
    case 'revoked':
    case 'source-changed':
      return 'ended';
    case 'not-granted':
      return 'not-allowed';
    case 'refused':
      return 'refused';
    case 'waiting':
      return 'waiting';
    case 'timeout':
    case 'unavailable':
    case 'source-too-large':
    case 'failed':
      return 'failed';
  }
}

/** The policy's refusal as a why: a stop, a pause or an expiry ended the access; a table it may not change is not allowed. */
function whyOfVerdict(refusal: ChatWriteRefusal): AccessWriteFailedWhy {
  switch (refusal.code) {
    case C.ACCESS_REVOKED:
    case C.ACCESS_EXPIRED:
      return 'ended';
    case C.ACCESS_NOT_GRANTED:
      return 'not-allowed';
    default:
      return 'failed';
  }
}

const failedWith = (why: AccessWriteFailedWhy, message: string): ChatWriteApprovedOutcome => ({ ok: false, reason: 'failed', message, why });

/** Apply the change the user approved on its card (`authority: 'approval'`, `via: 'chat'`). Never throws. */
export async function writeChatApproved(db: UserDb, caller: ChatAccessCaller, input: ChatWriteApprovedInput): Promise<ChatWriteApprovedOutcome> {
  try {
    // The card's access as it is NOW: still there and the caller's, the same instant it was allowed at, the same source.
    // Not found, it is gone only with its source; a session access of another view ended with that view (ii-2).
    const found = findAccessGrant(db, input.grantId);
    if (found === undefined) return db.getApp(input.sourceAppId) === undefined ? failedWith('gone', M.notGranted) : failedWith('ended', M.revoked);
    if (!ownsGrant(caller, found)) return found.session && found.grant.readerAppId === caller.appId ? failedWith('ended', M.revoked) : failedWith('gone', M.notGranted);
    if (found.grant.grantedAt !== input.grantedAt) return failedWith('ended', M.revoked);
    if (found.grant.sourceAppId !== input.sourceAppId) return failedWith('gone', M.notGranted);
    // The statement still changes the card's table — the one the user read on it.
    const target = dmlTargetTable(input.sql);
    if (target === undefined || !sameName(target, input.table)) return failedWith('gone', M.notGranted);
    // `ok` ⇒ applied; `undoable`/`undoId` when its journal entry was written (S17). A change of no rows has nothing to put back.
    if (!Number.isSafeInteger(input.expectChanges) || input.expectChanges < 1) return failedWith('refused', M.writeRefused('statement'));
    const verdict = writeVerdict(db, caller, input.grantId, target);
    if (!verdict.ok) return failedWith(whyOfVerdict(verdict), verdict.message);
    const answer = await brokeredWriteCore(db, requestFor(verdict.found, caller, input.sql, target), { mode: 'apply', expectChanges: input.expectChanges });
    if (answer.ok) return { ok: true, executed: [answer.changes], undoable: answer.undoId !== undefined, ...(answer.undoId !== undefined ? { undoId: answer.undoId } : {}) };
    if (answer.reason === 'drifted') return { ok: false, reason: 'drifted', previewed: [input.expectChanges], current: answer.current !== undefined ? [answer.current] : [], why: 'drifted' };
    return failedWith(whyOf(answer), wireRefusal(answer).message);
  } catch {
    return failedWith('failed', M.queryFailed);
  }
}
