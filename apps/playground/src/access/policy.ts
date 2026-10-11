// access/policy.ts — ONE policy, one verdict: who may do what with a grant, at every door
// (TASK-20261010-host-broker PR-2 AC9; ADR-0076 §1–§3; contract v2 D-PR2-1 one verdict whose
// effects are NAMED here and PERFORMED by the service · D-PR2-2 three callers, no `user` caller ·
// D-PR2-3 session grants per door · D-PR2-4 attendance per door · D-PR2-14 `ask`; PR-3 D-PR3-13
// the three acts — `write`, `refresh`, `discover` — and `stillWritable`; v2.1 notes E1-Q3/Q4/Q5).
//
// `authorise(ctx, caller, act)` answers the verdict the service acts on, for the three callers a
// read can come from — the app's FRAME (visible at a generation, or hidden), the CHAT beside the
// app (the user's own brain) and a SCHEDULE's step — and the eight acts. It is PURE: it reads only
// the context it is handed (`find`, `sourceRestricted`, `now` — the service binds the engine's
// finder, the WhatsApp check and its clock) and changes nothing. A refusal may NAME one effect —
// `refused-line` · `mark-expired` · `suspend-source-restricted` — which `service.ts` performs
// exactly where the handler performed it before PR-2 (on a `read` only, never on a `list`, a
// `materialise`, a `write`, a `refresh` or a `discover` — E1-Q3); so the rules are written once
// and the file is touched in one place.
//
// THE RULES, in the handler's `query` order (`read` and `materialise`; `materialise` skips rule 6):
//  1. found and OWNED (`ownsGrant`) — else not-granted, no effect, no grant carried: another app's
//     grant, an unknown id and an unbound session grant are byte-identical, and nothing says which;
//  2. stopped → revoked; paused → source-changed or paused — never retryable;
//  3. expired by the clock → expired, naming `mark-expired`;
//  4. attendance per door — a frame: `present` (read per op by the handler: the visible frame with
//     no delegated run in flight); the chat: always (the user typed — it does NOT read the run
//     state, rows reach the user's brain, never the frame); the schedule: never, *run now*
//     included. With nobody present a SESSION grant is never read whatever *also while I'm away*
//     says (D30 as a rule — the one deliberate invert of the pre-PR-2 handler, which admitted that
//     cell), and a persisted one only when ticked. A frame's refusal names `refused-line`; a chat's
//     or a schedule's skip is silent;
//  5. the source holds a WhatsApp fact → paused, naming `suspend-source-restricted`;
//  6. (`read` only) one read-only SELECT — else the query is refused.
//
// THE THREE ACTS OF PR-3 (D-PR3-13):
//  - `write { grantId, table }`: rules 1–3 as `read`; rule 4′ — attendance REQUIRED for every
//    caller, whatever the grant's *also while I'm away* says (a frame must be `present`, the chat
//    always is, a schedule never) → `ACCESS_UNATTENDED`, retryable, no effect, no line (E1-Q4);
//    rule 5 as `read`; rule 7 — the named table carries `write`, else `ACCESS_NOT_GRANTED` with
//    `writeNotGranted` ("this access is read-only for that table"). The table is what the
//    statement names, as the service reads it off the verb; a statement that names none (not one
//    plain INSERT, UPDATE or DELETE) has nothing for rule 7 to judge — the verdict admits, and the
//    Write Broker refuses the STATEMENT by name before any work (D-IE1-1).
//  - `refresh { grantId }`: rules 1–5 LITERALLY as `read` (rule 4 admits a persisted away grant
//    with nobody present, never a session grant; a frame's refusal names `refused-line` — still
//    performed only on a read, E1-Q5), then the grant's `refresh` seat, else `ACCESS_NOT_GRANTED`
//    with `refreshNotGranted`.
//  - `discover`: the `ask`'s presence rule and nothing more (a hidden or delegated-window frame
//    is refused before any gather — E1-Q10).
//
// OWNERSHIP (`ownsGrant`). A persisted grant is its reader's at every door. A session grant
// ("while it's open") belongs to the GENERATION it is bound to, and a caller owns it only when its
// own generation is DEFINED and equal: the visible frame of that generation, or the chat while the
// reader's view is open at it in this tab. The hidden frame and the schedule have none, so does
// the chat beside a closed app, and a session grant made from host chrome while the app was
// closed is bound to no generation yet — `undefined === undefined` admits NOBODY; the next frame
// that composes binds it (grants.ts `noteReaderGeneration`), and then that frame and the chat at
// its generation own it.
//
// `ask` is the frame's presence decision only — the ladder, the gather and the park stay in the
// handler (D-PR2-14); a chat caller is admitted (unreachable in PR-2, pinned for PR-3). `list` is
// admitted here and filtered row by row by the service through `materialise`. `release` needs the
// owner and nothing more; the service's own body may still answer not-granted for a grant already
// stopped (nothing left to give back).
//
// THE TYPE CARRIES THE FACT (Gate-5 M-1): an act that names a grant — `read`, `materialise`,
// `release`, `write`, `refresh` — is answered `Admitted | Refusal`, and `Admitted` always carries
// the grant, so the service never has to guard a can't-happen absence. `stillReadable` (M-2) is
// the ONE spelling of "still this caller's, active and unexpired" — the re-check the service and
// the loop ask after time has passed (a read dequeues, a dump answers, a line is about to be
// written); `stillWritable` is that spelling ∧ the named table's `write` — asked when a plan job
// dequeues and again, synchronously, after the plan answers and before the seat (D-PR3-15, S8).
//
// PURITY, PINNED. The module imports the protocol, the leaf `grantFacts.ts`, `copy.ts`, and
// grants.ts for TYPES only (accessPolicy.test.ts reads the import lines) — so it loads anywhere
// without reaching the engine, its stores or the host registry. No string here spells the engine's
// internal words (copy.ts's vocabulary scan reads type literals too).

import { ACCESS_ERROR_CODES, isReadOnlySelect } from '@snugprotocol/protocol';

import { ACCESS_APP_MESSAGES } from './copy.js';
import { isExpired, type AnyAccessGrant } from './grantFacts.js';
import type { FoundAccessGrant } from './grants.js';

/** Who is reading: the app's frame (generation absent = the hidden frame), the chat beside it, or a schedule's step. */
export type AccessCaller =
  | { kind: 'frame'; appId: string; generation?: number; present: boolean }
  | { kind: 'chat'; appId: string; threadId: string; liveGeneration?: number }
  | { kind: 'schedule'; appId: string; taskId: string; runId: string };

export type AccessAct =
  | { kind: 'ask' }
  | { kind: 'read'; grantId: string; sql: string }
  | { kind: 'materialise'; grantId: string }
  | { kind: 'list' }
  | { kind: 'release'; grantId: string }
  /** PR-3: one statement on `table` (as the statement names it; absent when the text names none — the broker refuses that statement). */
  | { kind: 'write'; grantId: string; table?: string }
  | { kind: 'refresh'; grantId: string }
  | { kind: 'discover' };

/** What the policy reads — the service binds the engine's finder, the WhatsApp check and its clock. */
export interface PolicyContext {
  now: number;
  find(grantId: string): FoundAccessGrant | undefined;
  sourceRestricted(sourceAppId: string): boolean;
}

/** The one thing a refusal may ask the service to do — performed on a `read` only, where the handler did it. */
export type PolicyEffect = 'refused-line' | 'mark-expired' | 'suspend-source-restricted';

export interface Refusal {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  effect?: PolicyEffect;
  /** The grant the effect applies to — absent at rule 1, where nothing may be said about it. */
  grant?: FoundAccessGrant;
}

/** An act on a named grant, admitted: the grant is always carried. */
export interface Admitted {
  ok: true;
  grant: FoundAccessGrant;
  attended: boolean;
}

export type Verdict = { ok: true; grant?: FoundAccessGrant; attended: boolean } | Refusal;

type ReadAct = Extract<AccessAct, { kind: 'read' | 'materialise' }>;
/** The acts that name a grant — their admission carries it. */
type GrantAct = Extract<AccessAct, { grantId: string }>;

const C = ACCESS_ERROR_CODES;
const M = ACCESS_APP_MESSAGES;

const refusal = (code: string, message: string, retryable: boolean, carried: { effect?: PolicyEffect; grant?: FoundAccessGrant } = {}): Refusal => ({
  ok: false,
  code,
  message,
  retryable,
  ...carried,
});

/** One spelling, nothing carried: an unknown id, another app's grant and an unbound session grant must not be told apart. */
const notGranted = (): Refusal => refusal(C.ACCESS_NOT_GRANTED, M.notGranted, false);

/** Is someone there for this caller: a frame when present, the chat always (the user typed), the schedule never. */
export function attendedFor(caller: AccessCaller): boolean {
  switch (caller.kind) {
    case 'frame':
      return caller.present;
    case 'chat':
      return true;
    case 'schedule':
      return false;
  }
}

/** The generation this caller may own a session grant at — none for the hidden frame, a closed app's chat, and the schedule. */
export function callerGeneration(caller: AccessCaller): number | undefined {
  switch (caller.kind) {
    case 'frame':
      return caller.generation;
    case 'chat':
      return caller.liveGeneration;
    case 'schedule':
      return undefined;
  }
}

/** D-PR2-3: the reader's own grant; a session grant only at a DEFINED generation equal to the caller's own. */
export function ownsGrant(caller: AccessCaller, found: FoundAccessGrant): boolean {
  if (found.grant.readerAppId !== caller.appId) return false;
  if (!found.session) return true;
  const callerGen = callerGeneration(caller);
  return callerGen !== undefined && found.generation !== undefined && found.generation === callerGen;
}

/** Rule 7's fact: the grant's scope names `table` (identifiers compare without case, as SQLite does) with its write seat set. */
function tableWritable(grant: AnyAccessGrant, table: string): boolean {
  const lower = table.toLowerCase();
  return grant.scope.tables.some((entry) => entry.name.toLowerCase() === lower && entry.write === true);
}

/**
 * The grant as it is NOW, when it is still this caller's, active and unexpired — else nothing.
 * The one re-check for time that passed: asked when a read dequeues, when a dump answers, and
 * before a line is written (the service's post-outcome status check keeps its own, narrower rule).
 */
export function stillReadable(find: PolicyContext['find'], caller: AccessCaller, grantId: string, now: number): FoundAccessGrant | undefined {
  const found = find(grantId);
  return found !== undefined && ownsGrant(caller, found) && found.grant.status === 'active' && !isExpired(found.grant, now) ? found : undefined;
}

/** D-PR3-13: `stillReadable` ∧ the named table's `write` — the Write Broker's re-check at the plan job's dequeue and after the plan answers. */
export function stillWritable(find: PolicyContext['find'], caller: AccessCaller, grantId: string, table: string, now: number): FoundAccessGrant | undefined {
  const found = stillReadable(find, caller, grantId, now);
  return found !== undefined && tableWritable(found.grant, table) ? found : undefined;
}

/** Rules 1–3, the same for every act that uses a grant: owned, not ended, not expired. */
function usable(ctx: PolicyContext, caller: AccessCaller, grantId: string): { ok: true; found: FoundAccessGrant } | Refusal {
  // 1. Owned — else nothing is said about what was found, or whether anything was.
  const found = ctx.find(grantId);
  if (found === undefined || !ownsGrant(caller, found)) return notGranted();
  const { grant } = found;
  // 2. Status.
  if (grant.status === 'revoked') return refusal(C.ACCESS_REVOKED, M.revoked, false, { grant: found });
  if (grant.status === 'suspended') {
    return refusal(C.ACCESS_REVOKED, grant.suspendedReason === 'source-changed' ? M.sourceChanged : M.paused, false, { grant: found });
  }
  // 3. Expiry — derived, marked once by the service.
  if (isExpired(grant, ctx.now)) return refusal(C.ACCESS_EXPIRED, M.expired, false, { effect: 'mark-expired', grant: found });
  return { ok: true, found };
}

/** Rule 4 as a READ has it: a session grant needs someone present whatever `unattended` says; a persisted one only when not ticked. */
function readAttendance(caller: AccessCaller, found: FoundAccessGrant, attended: boolean): Refusal | undefined {
  if (attended || (!found.session && found.grant.unattended)) return undefined;
  return refusal(C.ACCESS_NOT_GRANTED, M.notGranted, false, caller.kind === 'frame' ? { effect: 'refused-line', grant: found } : { grant: found });
}

/** Rule 5: the source's WhatsApp fact, at this moment. */
function restricted(ctx: PolicyContext, found: FoundAccessGrant): Refusal | undefined {
  return ctx.sourceRestricted(found.grant.sourceAppId) ? refusal(C.ACCESS_REVOKED, M.paused, false, { effect: 'suspend-source-restricted', grant: found }) : undefined;
}

function authoriseRead(ctx: PolicyContext, caller: AccessCaller, act: ReadAct, attended: boolean): Admitted | Refusal {
  const live = usable(ctx, caller, act.grantId);
  if (!live.ok) return live;
  const { found } = live;
  // 4. Attendance, as a read has it.
  const away = readAttendance(caller, found, attended);
  if (away !== undefined) return away;
  // 5. The source's WhatsApp fact.
  const paused = restricted(ctx, found);
  if (paused !== undefined) return paused;
  // 6. One read-only SELECT.
  if (act.kind === 'read' && !isReadOnlySelect(act.sql)) return refusal(C.ACCESS_QUERY_REFUSED, M.queryRefused, false, { grant: found });
  return { ok: true, grant: found, attended };
}

/** PR-3 (D-PR3-13): rules 1–3, then 4′ (someone present, whatever the grant says), 5, and 7 (the named table's `write`). */
function authoriseWrite(ctx: PolicyContext, caller: AccessCaller, act: Extract<AccessAct, { kind: 'write' }>, attended: boolean): Admitted | Refusal {
  const live = usable(ctx, caller, act.grantId);
  if (!live.ok) return live;
  const { found } = live;
  // 4′. Attendance REQUIRED for every caller in PR-3: no effect, no line, retryable (E1-Q4).
  if (!attended) return refusal(C.ACCESS_UNATTENDED, M.unattended, true, { grant: found });
  // 5. The source's WhatsApp fact.
  const paused = restricted(ctx, found);
  if (paused !== undefined) return paused;
  // 7. The named table carries `write` (a statement that names no table is the broker's to refuse — see the header).
  if (act.table !== undefined && !tableWritable(found.grant, act.table)) return refusal(C.ACCESS_NOT_GRANTED, M.writeNotGranted, false, { grant: found });
  return { ok: true, grant: found, attended };
}

/** PR-3 (D-PR3-13, E1-Q5): rules 1–5 literally as a read, then the grant's `refresh` seat. */
function authoriseRefresh(ctx: PolicyContext, caller: AccessCaller, act: Extract<AccessAct, { kind: 'refresh' }>, attended: boolean): Admitted | Refusal {
  const live = usable(ctx, caller, act.grantId);
  if (!live.ok) return live;
  const { found } = live;
  const away = readAttendance(caller, found, attended);
  if (away !== undefined) return away;
  const paused = restricted(ctx, found);
  if (paused !== undefined) return paused;
  if (found.grant.refresh !== true) return refusal(C.ACCESS_NOT_GRANTED, M.refreshNotGranted, false, { grant: found });
  return { ok: true, grant: found, attended };
}

/** The verdict for one act by one caller — pure: it names an effect, the service performs it. */
export function authorise(ctx: PolicyContext, caller: AccessCaller, act: GrantAct): Admitted | Refusal;
export function authorise(ctx: PolicyContext, caller: AccessCaller, act: AccessAct): Verdict;
export function authorise(ctx: PolicyContext, caller: AccessCaller, act: AccessAct): Verdict {
  const attended = attendedFor(caller);
  switch (act.kind) {
    case 'ask':
    case 'discover':
      return attended ? { ok: true, attended } : refusal(C.ACCESS_UNATTENDED, M.unattended, true);
    case 'list':
      return { ok: true, attended };
    case 'release': {
      const found = ctx.find(act.grantId);
      return found !== undefined && ownsGrant(caller, found) ? { ok: true, grant: found, attended } : notGranted();
    }
    case 'read':
    case 'materialise':
      return authoriseRead(ctx, caller, act, attended);
    case 'write':
      return authoriseWrite(ctx, caller, act, attended);
    case 'refresh':
      return authoriseRefresh(ctx, caller, act, attended);
  }
}
