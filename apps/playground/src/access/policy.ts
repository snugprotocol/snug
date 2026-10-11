// access/policy.ts — ONE policy, one verdict: who may do what with a grant, at every door
// (TASK-20261010-host-broker PR-2 AC9; ADR-0076 §1–§3; contract v2 D-PR2-1 one verdict whose
// effects are NAMED here and PERFORMED by the service · D-PR2-2 three callers, no `user` caller ·
// D-PR2-3 session grants per door · D-PR2-4 attendance per door · D-PR2-14 `ask`).
//
// `authorise(ctx, caller, act)` answers the verdict the service acts on, for the three callers a
// read can come from — the app's FRAME (visible at a generation, or hidden), the CHAT beside the
// app (the user's own brain) and a SCHEDULE's step — and the five acts. It is PURE: it reads only
// the context it is handed (`find`, `sourceRestricted`, `now` — the service binds the engine's
// finder, the WhatsApp check and its clock) and changes nothing. A refusal may NAME one effect —
// `refused-line` · `mark-expired` · `suspend-source-restricted` — which `service.ts` performs
// exactly where the handler performed it before PR-2 (on a `read` only, never on a `list` or a
// `materialise`); so the rules are written once and the file is touched in one place.
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
// PURITY, PINNED. The module imports the protocol, the leaf `grantFacts.ts`, `copy.ts`, and
// grants.ts for TYPES only (accessPolicy.test.ts reads the import lines) — so it loads anywhere
// without reaching the engine, its stores or the host registry. No string here spells the engine's
// internal words (copy.ts's vocabulary scan reads type literals too).

import { ACCESS_ERROR_CODES, isReadOnlySelect } from '@snugprotocol/protocol';

import { ACCESS_APP_MESSAGES } from './copy.js';
import { isExpired } from './grantFacts.js';
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
  | { kind: 'release'; grantId: string };

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

export type Verdict = { ok: true; grant?: FoundAccessGrant; attended: boolean } | Refusal;

type ReadAct = Extract<AccessAct, { kind: 'read' | 'materialise' }>;

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

function authoriseRead(ctx: PolicyContext, caller: AccessCaller, act: ReadAct, attended: boolean): Verdict {
  // 1. Owned — else nothing is said about what was found, or whether anything was.
  const found = ctx.find(act.grantId);
  if (found === undefined || !ownsGrant(caller, found)) return notGranted();
  const { grant } = found;
  // 2. Status.
  if (grant.status === 'revoked') return refusal(C.ACCESS_REVOKED, M.revoked, false, { grant: found });
  if (grant.status === 'suspended') {
    return refusal(C.ACCESS_REVOKED, grant.suspendedReason === 'source-changed' ? M.sourceChanged : M.paused, false, { grant: found });
  }
  // 3. Expiry — derived, marked once by the service.
  if (isExpired(grant, ctx.now)) return refusal(C.ACCESS_EXPIRED, M.expired, false, { effect: 'mark-expired', grant: found });
  // 4. Attendance: a session grant needs someone present whatever `unattended` says; a persisted one only when not ticked.
  if (!attended && (found.session || !grant.unattended)) {
    return refusal(C.ACCESS_NOT_GRANTED, M.notGranted, false, caller.kind === 'frame' ? { effect: 'refused-line', grant: found } : { grant: found });
  }
  // 5. The source's WhatsApp fact, at this moment.
  if (ctx.sourceRestricted(grant.sourceAppId)) return refusal(C.ACCESS_REVOKED, M.paused, false, { effect: 'suspend-source-restricted', grant: found });
  // 6. One read-only SELECT.
  if (act.kind === 'read' && !isReadOnlySelect(act.sql)) return refusal(C.ACCESS_QUERY_REFUSED, M.queryRefused, false, { grant: found });
  return { ok: true, grant: found, attended };
}

/** The verdict for one act by one caller — pure: it names an effect, the service performs it. */
export function authorise(ctx: PolicyContext, caller: AccessCaller, act: AccessAct): Verdict {
  const attended = attendedFor(caller);
  switch (act.kind) {
    case 'ask':
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
  }
}
