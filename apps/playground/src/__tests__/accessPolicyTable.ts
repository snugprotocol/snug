// accessPolicyTable.ts — THE characterisation table of the access policy and the world both of its
// drivers stand in (TASK-20261010-host-broker PR-2: AC9 amended; contract v2 "Characterisation";
// D-PR2-1 one verdict, D-PR2-2 three callers, D-PR2-3 session grants per door, D-PR2-4 attendance
// per door, D-PR2-14 `ask`).
//
// ONE TABLE, TWO DRIVERS. Every cell is (caller × grant × act) → the expected verdict
// `{ code, message, retryable, effect }` (or ok, with the posture the read is logged under), written
// BY HAND below — never computed from the rules, so the table can disagree with an implementation:
//   - accessHandlerTable.test.ts drives the FRAME cells through the REAL `createAccessHandlerFor`
//     (`driveHandlerCell`, here) — GREEN on today's main: the proof that the table is right;
//   - accessPolicy.test.ts drives EVERY cell through `authorise` — red until `access/policy.ts`.
//
// THE WORLD IS SHARED, SO THE TWO DRIVERS SEE THE SAME STATE. `setupWorld` builds Budget (the reader),
// Ledger (the source — `transactions` with a credential column) and Pantry (another source, so an ask
// always has someone to offer). `makeGrant` creates ONE grant fixture, then `enterCaller` composes
// what that caller implies — and composition is behaviour, not scaffolding: a visible frame (or a
// chat whose reader's view is OPEN) exists only once the run view composed its handler, which binds
// an UNBOUND session grant to that generation and drops a session grant of any other (grants.ts
// `noteReaderGeneration`). So the unbound fixture stays unbound exactly for the callers that compose
// nothing — the hidden frame, the chat beside a CLOSED app, the schedule — and the D-PR2-3 cell that
// matters (a closed app's chat × the default grant made from host chrome) reads `notGranted`.
// accessPolicy.test.ts pins the pure `ownsGrant` rule on a hand-built unbound grant beside it.
//
// THE ACTS. `read` (with `SELECT 1` and with `DELETE …`), `materialise`, `list`, `release`, `ask`.
// Today's handler has no `materialise`: its frame cell is `list`'s ADMISSION — the grant is in the
// frame's `list` iff `authorise(materialise)` admits it (the contract: "`list` → ok; the service
// filters rows with `authorise(materialise)` per row and applies no effect — today's `list`
// admission exactly"). The policy names an effect per RULE (rules 3–5), whatever the act; only the
// service decides to perform it (`read` only) — so the handler driver checks a `materialise` cell
// performed NOTHING, and a `read` cell performed exactly the named effect.
//
// ONE SEAT WHERE THE ANSWER IS NOT THE VERDICT: `release` of an already-stopped grant — the policy
// admits the owner (`found && ownsGrant`), then the service's own body (`releaseAccess`) answers
// not-granted because there is nothing left to give back. Such a cell carries `{ verdict, answer }`.
//
// THE ONE NAMED INVERT (D-PR2-4 rule 4, "D30 as a rule"): {frame during a delegated run} × {session g0,
// also while I'm away} — today's handler ADMITS it (the frame owns the generation; `unattended` is
// ticked), the policy refuses: a session grant is never read without someone present. The handler
// driver SKIPS those cells with that reason; the policy driver asserts the refusal.
//
// Mute, decline and rate stay the handler's ladder (pinned by accessHandler.test.ts), not this table.
//
// PR-3 (contract v2 D-PR3-13, the wire): THE SECOND TABLE (`TABLE_V2`, below the first) — the three
// new acts `write {grantId, table}` · `refresh {grantId}` · `discover` over the SAME eight callers ×
// the ten grants, plus three new grant fixtures (a persisted grant with `write` on ONE of two tables ·
// a persisted grant with `refresh`, also while I'm away · a session g0 grant with `write`). Written
// by hand like the first: write = rules 1–3 as read, 4′ attendance REQUIRED for every caller
// (ACCESS_UNATTENDED, retryable — the hidden frame, a present:false frame, the schedule), rule 5,
// then the named table's `write` (else ACCESS_NOT_GRANTED `writeNotGranted`); refresh = rules 1–5
// as read (rule 4 is READ's: a grant allowed *also while I'm away* passes with nobody present), then
// `grant.refresh` (else `refreshNotGranted`); discover = the ask presence rule. Effects stay NAMED
// by the rule (A-Q1) and are performed on a `read` only — so the handler driver checks a v2 cell
// performed NOTHING. An admitted refresh, driven through the handler, meets the refresh engine's
// first gate in this world (no scheduler state row was ever made — D-PR3-17 (1)): it answers
// ACCESS_REFRESH_FAILED `refreshOff`, a cell whose answer is not the verdict. The first table and
// its drivers are untouched; the v2 cells are red until the policy gains the acts (policy driver)
// and the handler maps the ops (handler driver).

import { expect } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { AccessHandler, AccessHandlerResult } from '@snugprotocol/runner';
import { ACCESS_ERROR_CODES, FRAME_TYPES, PROTOCOL_VERSION, SIDECAR_SYMBOLIC_HOST, type AccessRequestFrame } from '@snugprotocol/protocol';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { NO_ACCESS_ASKS_KEY, collectSources, pendingAccessStore } from '../access/consent.js';
import { ACCESS_APP_MESSAGES } from '../access/copy.js';
import {
  __setAccessDepsForTests,
  createGrantFromDecision,
  findAccessGrant,
  type CreateGrantInput,
  readerGeneration,
  resetAccessSession,
  revokeAccess,
  suspendAccess,
  type FoundAccessGrant,
} from '../access/grants.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import { startUserAsk } from '../access/userAsk.js';
import { beginDelegatedRun, clearTouchedGeneration, delegatedRunFor, endDelegatedRun } from '../schedule/runPlacement.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

// =========================================================================================
// The dimensions
// =========================================================================================

export const CALLER_KEYS = [
  'frame-g0',
  'frame-g0-delegated',
  'frame-g1',
  'frame-hidden',
  'chat-g0',
  'chat-none',
  'chat-g0-delegated',
  'schedule',
] as const;
export type CallerKey = (typeof CALLER_KEYS)[number];

export const CALLER_LABELS: Record<CallerKey, string> = {
  'frame-g0': 'frame visible g0, present',
  'frame-g0-delegated': 'frame visible g0 during a delegated run (present false)',
  'frame-g1': 'frame visible g1',
  'frame-hidden': 'frame hidden',
  'chat-g0': 'chat, liveGeneration 0',
  'chat-none': 'chat, no live generation (the app is closed)',
  'chat-g0-delegated': 'chat, liveGeneration 0, during a delegated run',
  schedule: 'schedule',
};

/** The callers today's handler can be: the run view's frame and the scheduler's hidden frame. */
export const FRAME_CALLERS: readonly CallerKey[] = ['frame-g0', 'frame-g0-delegated', 'frame-g1', 'frame-hidden'];

export const GRANT_KEYS = [
  'persisted',
  'persisted-away',
  'revoked',
  'suspended-source-changed',
  'suspended-imported',
  'expired',
  'session-g0',
  'session-g0-away',
  'session-unbound',
  'source-restricted',
] as const;
/** PR-3: the three new grant fixtures (the second table's extra rows). */
export const GRANT_KEYS_PR3 = ['persisted-write', 'persisted-refresh', 'session-g0-write'] as const;
/** The table's grants, plus the order-row variant (`ORDER_CELLS`), plus PR-3's three fixtures. */
export type GrantKey = (typeof GRANT_KEYS)[number] | 'source-restricted-attended-only' | (typeof GRANT_KEYS_PR3)[number];

export const GRANT_LABELS: Record<GrantKey, string> = {
  persisted: 'persisted active (for a day)',
  'persisted-away': 'persisted active, also while I’m away',
  revoked: 'persisted, stopped',
  'suspended-source-changed': 'persisted, paused source-changed',
  'suspended-imported': 'persisted, paused imported',
  expired: 'persisted, expired by the clock',
  'session-g0': 'session g0',
  'session-g0-away': 'session g0, also while I’m away',
  'session-unbound': 'session UNBOUND (made from host chrome with the app closed)',
  'source-restricted': 'persisted also-away; the source holds a WhatsApp fact',
  'source-restricted-attended-only': 'persisted (not away); the source holds a WhatsApp fact',
  'persisted-write': 'persisted (for a day), can change transactions — accounts read-only',
  'persisted-refresh': 'persisted, also while I’m away, may ask for new data',
  'session-g0-write': 'session g0, can change transactions',
};

export const ACT_KEYS = ['read-select', 'read-delete', 'materialise', 'list', 'release', 'ask'] as const;
export type ActKey = (typeof ACT_KEYS)[number];

export const READ_SQL: Record<'read-select' | 'read-delete', string> = {
  'read-select': 'SELECT 1',
  'read-delete': 'DELETE FROM transactions',
};

// =========================================================================================
// The expectations — every sentence from copy.ts's ACCESS_APP_MESSAGES
// =========================================================================================

export type PolicyEffectName = 'refused-line' | 'mark-expired' | 'suspend-source-restricted';

export type Expected =
  | { ok: true; attended?: boolean }
  | { ok: false; code: string; message: string; retryable: boolean; effect?: PolicyEffectName };

/** A cell whose outward answer is decided by the service's own body after the verdict. */
export interface Diverging {
  verdict: Expected;
  answer: Expected;
  why: string;
}
type Entry = Expected | Diverging;

const C = ACCESS_ERROR_CODES;
const M = ACCESS_APP_MESSAGES;
const refusal = (code: string, message: string, retryable: boolean, effect?: PolicyEffectName): Expected => ({
  ok: false,
  code,
  message,
  retryable,
  ...(effect !== undefined ? { effect } : {}),
});

/** Admitted, someone present (the `read` line says `attended: true`). */
const OK_HERE: Expected = { ok: true, attended: true };
/** Admitted with no one present (the `read` line says `attended: false`). */
const OK_AWAY: Expected = { ok: true, attended: false };
/** Admitted (`list`, `release`, `ask` — no read, no posture to log). */
const OK: Expected = { ok: true };
const NOT_GRANTED = refusal(C.ACCESS_NOT_GRANTED, M.notGranted, false);
const NOT_GRANTED_LINE = refusal(C.ACCESS_NOT_GRANTED, M.notGranted, false, 'refused-line');
const REVOKED = refusal(C.ACCESS_REVOKED, M.revoked, false);
const PAUSED = refusal(C.ACCESS_REVOKED, M.paused, false);
const SOURCE_CHANGED = refusal(C.ACCESS_REVOKED, M.sourceChanged, false);
const EXPIRED = refusal(C.ACCESS_EXPIRED, M.expired, false, 'mark-expired');
const RESTRICTED = refusal(C.ACCESS_REVOKED, M.paused, false, 'suspend-source-restricted');
const QUERY_REFUSED = refusal(C.ACCESS_QUERY_REFUSED, M.queryRefused, false);
const UNATTENDED = refusal(C.ACCESS_UNATTENDED, M.unattended, true);
const RELEASE_STOPPED: Diverging = {
  verdict: OK,
  answer: NOT_GRANTED,
  why: 'the owner is admitted; releaseAccess answers not-granted for a grant already stopped (nothing left to give back)',
};

type Row = readonly [readSelect: Entry, readDelete: Entry, materialise: Entry, list: Entry, release: Entry, ask: Entry];

/**
 * THE TABLE, by hand. Columns: read `SELECT 1` · read `DELETE …` · materialise · list · release · ask.
 * Rules (contract v2, in order): 1 owned · 2 status · 3 expiry · 4 attendance · 5 WhatsApp fact ·
 * 6 (read only) one read-only SELECT. `ask`: a frame with nobody present or a schedule → unattended.
 */
export const TABLE: Record<CallerKey, Record<(typeof GRANT_KEYS)[number], Row>> = {
  // The visible frame at g0, someone there. Composing g0 binds the unbound session grant to g0.
  'frame-g0': {
    persisted: [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'persisted-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, OK],
    'session-g0': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'session-g0-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'session-unbound': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, OK],
  },
  // The same frame while a delegated run is in flight on it: nobody present (D-PR1-8); its refusals
  // at rule 4 write the `refused` line (a FRAME caller).
  'frame-g0-delegated': {
    persisted: [NOT_GRANTED_LINE, NOT_GRANTED_LINE, NOT_GRANTED_LINE, OK, OK, UNATTENDED],
    'persisted-away': [OK_AWAY, QUERY_REFUSED, OK_AWAY, OK, OK, UNATTENDED],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, UNATTENDED],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, UNATTENDED],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, UNATTENDED],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, UNATTENDED],
    'session-g0': [NOT_GRANTED_LINE, NOT_GRANTED_LINE, NOT_GRANTED_LINE, OK, OK, UNATTENDED],
    // THE ONE NAMED INVERT (see INVERT): today admitted, the policy refuses.
    'session-g0-away': [NOT_GRANTED_LINE, NOT_GRANTED_LINE, NOT_GRANTED_LINE, OK, OK, UNATTENDED],
    'session-unbound': [NOT_GRANTED_LINE, NOT_GRANTED_LINE, NOT_GRANTED_LINE, OK, OK, UNATTENDED],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, UNATTENDED],
  },
  // The visible frame at g1: composing g1 DROPS g0's session grants (they died with their frame) and
  // binds the unbound one to g1.
  'frame-g1': {
    persisted: [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'persisted-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, OK],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, OK],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, OK],
    'session-unbound': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, OK],
  },
  // The scheduler's hidden frame: no generation — owns no session grant (rule 1, silent); nobody
  // present — a persisted grant without *also while I'm away* is refused WITH the line.
  'frame-hidden': {
    persisted: [NOT_GRANTED_LINE, NOT_GRANTED_LINE, NOT_GRANTED_LINE, OK, OK, UNATTENDED],
    'persisted-away': [OK_AWAY, QUERY_REFUSED, OK_AWAY, OK, OK, UNATTENDED],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, UNATTENDED],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, UNATTENDED],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, UNATTENDED],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, UNATTENDED],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, UNATTENDED],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, UNATTENDED],
    'session-unbound': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, UNATTENDED],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, UNATTENDED],
  },
  // The chat beside the reader while its view is OPEN at g0 (liveGeneration 0): the user typed —
  // attended — so rule 4 never refuses; it owns g0's session grants (and the unbound one, bound by
  // the view's composition).
  'chat-g0': {
    persisted: [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'persisted-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, OK],
    'session-g0': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'session-g0-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'session-unbound': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, OK],
  },
  // The chat beside a CLOSED app (no live generation): attended, but it owns NO session grant — the
  // unbound one included (D-PR2-3: `undefined === undefined` admitted it; the shared blocker).
  'chat-none': {
    persisted: [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'persisted-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, OK],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, OK],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, OK],
    'session-unbound': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, OK],
  },
  // The chat beside the reader during a delegated run on its frame: the chat door does NOT read
  // `delegatedRunFor` (D-PR2-4, S11) — rows reach the user's brain, never the frame. Same as chat-g0.
  'chat-g0-delegated': {
    persisted: [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'persisted-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, OK],
    'session-g0': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'session-g0-away': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'session-unbound': [OK_HERE, QUERY_REFUSED, OK_HERE, OK, OK, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, OK],
  },
  // A scheduled question: never attended, whatever the trigger (D-PR2-4 (a)); owns no session grant;
  // its rule-4 refusals are SILENT (a schedule skip writes no line).
  schedule: {
    persisted: [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, OK, UNATTENDED],
    'persisted-away': [OK_AWAY, QUERY_REFUSED, OK_AWAY, OK, OK, UNATTENDED],
    revoked: [REVOKED, REVOKED, REVOKED, OK, RELEASE_STOPPED, UNATTENDED],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK, OK, UNATTENDED],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK, OK, UNATTENDED],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK, OK, UNATTENDED],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, UNATTENDED],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, UNATTENDED],
    'session-unbound': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK, NOT_GRANTED, UNATTENDED],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK, OK, UNATTENDED],
  },
};

/** The one named invert of the characterisation (contract v2; D-PR2-4 rule 4 — D30 as a rule). */
export const INVERT = {
  caller: 'frame-g0-delegated' as CallerKey,
  grant: 'session-g0-away' as GrantKey,
  acts: ['read-select', 'read-delete', 'materialise'] as readonly ActKey[],
  reason:
    'the ONE named invert (D-PR2-4 rule 4, D30 as a rule): a session grant is never read without someone present, whatever `unattended` says — today’s handler admits {frame during a delegated run} × {session g0, also while I’m away}; the policy refuses it',
};

export interface Cell {
  caller: CallerKey;
  grant: GrantKey;
  act: ActKey;
  /** What `authorise` answers. */
  verdict: Expected;
  /** What the frame is answered (equal to the verdict but where `why` says otherwise). */
  answer: Expected;
  why?: string;
  /** The named invert: the handler driver skips it, the policy driver asserts it. */
  invert: boolean;
  name: string;
}

const isDiverging = (entry: Entry): entry is Diverging => 'verdict' in entry;

/** The ordering rows beside the table: the rule order is today's `query` order (D-PR2-1). */
const ORDER_ROWS: ReadonlyArray<{ caller: CallerKey; grant: GrantKey; act: ActKey; entry: Entry; note: string }> = [
  // Rule 4 (attendance) precedes rule 5 (the WhatsApp fact): nobody present on a grant without
  // *also while I'm away* is refused before the source is even looked at — and nothing is suspended.
  { caller: 'frame-hidden', grant: 'source-restricted-attended-only', act: 'read-select', entry: NOT_GRANTED_LINE, note: 'rule 4 before rule 5' },
  { caller: 'frame-g0-delegated', grant: 'source-restricted-attended-only', act: 'read-select', entry: NOT_GRANTED_LINE, note: 'rule 4 before rule 5' },
  { caller: 'schedule', grant: 'source-restricted-attended-only', act: 'materialise', entry: NOT_GRANTED, note: 'rule 4 before rule 5, silent for a schedule' },
  // …and with someone present the fact pauses it.
  { caller: 'frame-g0', grant: 'source-restricted-attended-only', act: 'read-select', entry: RESTRICTED, note: 'rule 5 when present' },
  { caller: 'chat-none', grant: 'source-restricted-attended-only', act: 'materialise', entry: RESTRICTED, note: 'rule 5 for the chat' },
];

function cellOf(caller: CallerKey, grant: GrantKey, act: ActKey, entry: Entry, note?: string): Cell {
  const verdict = isDiverging(entry) ? entry.verdict : entry;
  const answer = isDiverging(entry) ? entry.answer : entry;
  const invert = caller === INVERT.caller && grant === INVERT.grant && INVERT.acts.includes(act);
  return {
    caller,
    grant,
    act,
    verdict,
    answer,
    ...(isDiverging(entry) ? { why: entry.why } : {}),
    invert,
    name: `${CALLER_LABELS[caller]} × ${GRANT_LABELS[grant]} × ${act}${note !== undefined ? ` (${note})` : ''} → ${describeExpected(verdict)}`,
  };
}

function describeExpected(expected: Expected): string {
  if (expected.ok) return expected.attended === undefined ? 'ok' : `ok (attended ${expected.attended})`;
  return `${expected.code} “${expected.message}”${expected.effect !== undefined ? ` + ${expected.effect}` : ''}`;
}

/** Every cell of the table, caller by caller, grant by grant, act by act. */
export function tableCells(): Cell[] {
  const cells: Cell[] = [];
  for (const caller of CALLER_KEYS) {
    for (const grant of GRANT_KEYS) {
      const row = TABLE[caller][grant];
      ACT_KEYS.forEach((act, index) => cells.push(cellOf(caller, grant, act, row[index]!)));
    }
  }
  return cells;
}

/** The ordering rows (rule 4 before rule 5), in the same cell shape. */
export function orderCells(): Cell[] {
  return ORDER_ROWS.map((row) => cellOf(row.caller, row.grant, row.act, row.entry, row.note));
}

// =========================================================================================
// The world
// =========================================================================================

export const T0 = Date.parse('2026-10-10T09:00:00.000Z');
export const DAY = 86_400_000;

export interface World {
  db: UserDb;
  budget: string;
  ledger: string;
  pantry: string;
  clock: { now: number };
}

let current: World | undefined;
let leaving: Array<() => void> = [];
let seq = 0;

export function world(): World {
  if (current === undefined) throw new Error('setupWorld() first');
  return current;
}

/** The inline worker: the real worker module's responder on node sql.js. */
export function inlineWorkers(): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        void respond(msg).then((answer) => {
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        });
      },
      terminate() {},
    };
    return worker;
  };
}

async function seed(db: UserDb, appId: string, ddl: string[], inserts: string[]): Promise<void> {
  await db.applyAppDdl(appId, ddl);
  for (const sql of inserts) {
    await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${++seq}`, instanceId: 'seed', op: 'exec', sql });
  }
}

/** beforeEach: a fresh file, Budget reading, Ledger and Pantry holding data, the inline worker, a held clock. */
export async function setupWorld(): Promise<World> {
  resetAccessSession();
  resetScopedReadForTests();
  try {
    localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  } catch {
    // no storage here — the switch reads as off
  }
  const clock = { now: T0 };
  const db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  const budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  const ledger = db.installApp({ displayName: 'Ledger', iconEmoji: '📒', html: '<!doctype html><title>l</title>' }).appId;
  const pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seed(
    db,
    ledger,
    ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, api_key TEXT)'],
    ["INSERT INTO transactions (amount, category, api_key) VALUES (450, 'food', 'k-one'), (500, 'rent', 'k-two')"],
  );
  await seed(db, pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)'], ["INSERT INTO items VALUES ('rice', 2)"]);
  configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
  current = { db, budget, ledger, pantry, clock };
  leaving = [];
  return current;
}

/** afterEach: end any delegated run, drop the session state, the worker, the deps. */
export function teardownWorld(): void {
  for (const leave of leaving.splice(0)) {
    try {
      leave();
    } catch {
      // best effort
    }
  }
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  try {
    localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  } catch {
    // no storage here
  }
  current = undefined;
}

const iso = (at: number): string => new Date(at).toISOString();

/** A grant Budget reads from Ledger's `transactions`, made through THE writer behind the user's allow. */
async function grantFromLedger(over: { duration: 'session' | 'day' | 'week' | 'always'; unattended: boolean; generation?: number }): Promise<string> {
  const { db, budget, ledger, clock } = world();
  const ranked = await collectSources(db, budget);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger);
  if (source === undefined) throw new Error('Ledger was not offered');
  const grant = await createGrantFromDecision(db, {
    readerAppId: budget,
    source,
    tables: ['transactions'],
    duration: over.duration,
    unattended: over.unattended,
    purpose: 'to show spending by category',
    provenance: 'app',
    ...(over.generation !== undefined ? { generation: over.generation } : {}),
    now: clock.now,
  });
  return grant.id;
}

function plantWhatsAppFact(): void {
  const { db, ledger } = world();
  db.putDeclaredConnection(
    ledger,
    'whatsapp',
    { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2],
    'starter',
  );
}

/**
 * Make ONE grant fixture — BEFORE the caller enters (an unbound session grant must exist before any
 * handler composes). Answers the grant id.
 */
export async function makeGrant(key: GrantKey): Promise<string> {
  const { db, budget, ledger, clock } = world();
  switch (key) {
    case 'persisted':
      return grantFromLedger({ duration: 'day', unattended: false });
    case 'persisted-away':
      return grantFromLedger({ duration: 'always', unattended: true });
    case 'revoked': {
      const id = await grantFromLedger({ duration: 'day', unattended: false });
      await revokeAccess(id);
      return id;
    }
    case 'suspended-source-changed': {
      const id = await grantFromLedger({ duration: 'day', unattended: false });
      expect(await suspendAccess(db, id, 'source-changed', iso(clock.now))).toBe(true);
      return id;
    }
    case 'suspended-imported': {
      const id = await grantFromLedger({ duration: 'day', unattended: false });
      expect(await suspendAccess(db, id, 'imported', iso(clock.now))).toBe(true);
      return id;
    }
    case 'expired': {
      const id = await grantFromLedger({ duration: 'day', unattended: false });
      clock.now += DAY; // its `until` is now — expired by the clock, never stored
      return id;
    }
    case 'session-g0':
      return grantFromLedger({ duration: 'session', unattended: false, generation: 0 });
    case 'session-g0-away':
      return grantFromLedger({ duration: 'session', unattended: true, generation: 0 });
    case 'session-unbound': {
      // The default *while it's open* allowed from host chrome while Budget's view is NOT mounted:
      // the user's own ask (accessHandler.test.ts's "the user's own creation act"), allowed.
      expect(readerGeneration(budget), 'no view of the reader is open').toBeUndefined();
      await startUserAsk(budget);
      const pending = pendingAccessStore.get()[budget];
      if (pending === undefined) throw new Error('the user ask parked nothing');
      const outcome = await pending.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'session', unattended: false });
      if (outcome.kind !== 'allowed') throw new Error(`the allow answered ${outcome.kind}`);
      const found = findAccessGrant(db, outcome.grantId);
      expect(found, 'an UNBOUND session grant').toMatchObject({ session: true, generation: undefined });
      return outcome.grantId;
    }
    case 'source-restricted': {
      const id = await grantFromLedger({ duration: 'always', unattended: true });
      plantWhatsAppFact();
      return id;
    }
    case 'source-restricted-attended-only': {
      const id = await grantFromLedger({ duration: 'always', unattended: false });
      plantWhatsAppFact();
      return id;
    }
    case 'persisted-write':
      await ensureLedgerAccounts();
      return grantFromLedgerV2({
        duration: 'day',
        unattended: false,
        tables: [
          { name: 'transactions', withheld: [], write: true },
          { name: 'accounts', withheld: [], write: false },
        ],
      });
    case 'persisted-refresh':
      return grantFromLedgerV2({ duration: 'always', unattended: true, refresh: true, tables: [{ name: 'transactions', withheld: [], write: false }] });
    case 'session-g0-write':
      return grantFromLedgerV2({ duration: 'session', unattended: false, generation: 0, tables: [{ name: 'transactions', withheld: [], write: true }] });
  }
}

/**
 * PR-3 (D-PR3-23): one table of the v2 decision — `withheld` the unticked non-sensitive columns,
 * `write` the per-table toggle. A LOCAL structural type: the implementation lane's
 * `CreateGrantInput.tables` replaces it (the cast below goes with it at Gate 5).
 */
export interface DecisionTableV2 {
  name: string;
  withheld: string[];
  write: boolean;
}

/** PR-3: a v2 grant Budget holds on Ledger, made through THE writer behind the user's allow. */
async function grantFromLedgerV2(over: { duration: 'session' | 'day' | 'week' | 'always'; unattended: boolean; generation?: number; tables: DecisionTableV2[]; kv?: boolean; refresh?: boolean }): Promise<string> {
  const { db, budget, ledger, clock } = world();
  const ranked = await collectSources(db, budget);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger);
  if (source === undefined) throw new Error('Ledger was not offered');
  const input = {
    readerAppId: budget,
    source,
    tables: over.tables,
    duration: over.duration,
    unattended: over.unattended,
    ...(over.kv === true ? { kv: true } : {}),
    ...(over.refresh === true ? { refresh: true } : {}),
    purpose: 'to show spending by category',
    provenance: 'app' as const,
    ...(over.generation !== undefined ? { generation: over.generation } : {}),
    now: clock.now,
  };
  const grant = await createGrantFromDecision(db, input as unknown as CreateGrantInput);
  return grant.id;
}

/** PR-3: Ledger's second table — only the `persisted-write` fixture needs it (the first table's world is unchanged). */
async function ensureLedgerAccounts(): Promise<void> {
  const { db, ledger } = world();
  await seed(db, ledger, ['CREATE TABLE accounts (name TEXT, balance INTEGER)'], ["INSERT INTO accounts VALUES ('main', 9000)"]);
}

/** The caller as the contract types it (`AccessCaller`) — structural here, so this file never imports the policy. */
export type CallerShape =
  | { kind: 'frame'; appId: string; generation?: number; present: boolean }
  | { kind: 'chat'; appId: string; threadId: string; liveGeneration?: number }
  | { kind: 'schedule'; appId: string; taskId: string; runId: string };

export interface Entered {
  caller: CallerShape;
  /** The frame's handler (frame callers only). */
  handler?: AccessHandler;
}

function beginRun(): void {
  const { budget } = world();
  expect(beginDelegatedRun({ appId: budget, appName: 'Budget', runId: 'run-table', taskId: 'task-table', title: 'Morning sums', generation: 0 }).ok).toBe(true);
  leaving.push(() => {
    endDelegatedRun(budget, 'run-table');
    clearTouchedGeneration(budget, 0);
  });
}

/**
 * Enter as the caller: compose what it implies (the visible view's handler for a visible frame and
 * for a chat whose reader is OPEN; the hidden frame's handler; nothing for a closed app's chat or a
 * schedule), begin the delegated run where named, and build the caller from the LIVE state
 * (`present` = no delegated run for the app; `liveGeneration` = `readerGeneration(appId)`).
 */
export function enterCaller(key: CallerKey): Entered {
  const { budget } = world();
  const present = (): boolean => delegatedRunFor(budget) === undefined;
  switch (key) {
    case 'frame-g0':
    case 'frame-g0-delegated':
    case 'frame-g1': {
      const generation = key === 'frame-g1' ? 1 : 0;
      const handler = createAccessHandlerFor(budget, { attended: true, generation });
      if (key === 'frame-g0-delegated') beginRun();
      return { handler, caller: { kind: 'frame', appId: budget, generation, present: present() } };
    }
    case 'frame-hidden': {
      const handler = createAccessHandlerFor(budget, { attended: false });
      return { handler, caller: { kind: 'frame', appId: budget, present: false } };
    }
    case 'chat-g0':
    case 'chat-g0-delegated': {
      createAccessHandlerFor(budget, { attended: true, generation: 0 }); // the reader's view is open beside the chat
      if (key === 'chat-g0-delegated') beginRun();
      const liveGeneration = readerGeneration(budget);
      expect(liveGeneration).toBe(0);
      return { caller: { kind: 'chat', appId: budget, threadId: 'thread-table', ...(liveGeneration !== undefined ? { liveGeneration } : {}) } };
    }
    case 'chat-none': {
      expect(readerGeneration(budget), 'the app is closed').toBeUndefined();
      return { caller: { kind: 'chat', appId: budget, threadId: 'thread-table' } };
    }
    case 'schedule':
      return { caller: { kind: 'schedule', appId: budget, taskId: 'task-table', runId: 'run-table' } };
  }
}

/** Prepare one cell: the grant fixture, then the caller. */
export async function prepare(cell: Pick<Cell, 'caller' | 'grant'>): Promise<{ grantId: string } & Entered> {
  const grantId = await makeGrant(cell.grant);
  return { grantId, ...enterCaller(cell.caller) };
}

/** The `PolicyContext` the service binds (contract): the engine's own finder and the WhatsApp check, at the world's clock. */
export function policyContext(): { now: number; find(grantId: string): FoundAccessGrant | undefined; sourceRestricted(sourceAppId: string): boolean } {
  const { db, clock } = world();
  return {
    now: clock.now,
    find: (grantId) => findAccessGrant(db, grantId),
    sourceRestricted: (sourceAppId) => appHasSidecarFact(db, sourceAppId),
  };
}

/** What an effect would change: the source's history and the grant as the engine finds it. */
export function observe(grantId: string): { history: string; grant: string } {
  const { db, ledger } = world();
  return { history: JSON.stringify(db.listAccessLog(ledger)), grant: JSON.stringify(findAccessGrant(db, grantId) ?? null) };
}

/** The act as the contract types it (`AccessAct`). */
export function actOf(act: ActKey, grantId: string): { kind: 'ask' } | { kind: 'read'; grantId: string; sql: string } | { kind: 'materialise'; grantId: string } | { kind: 'list' } | { kind: 'release'; grantId: string } {
  switch (act) {
    case 'read-select':
    case 'read-delete':
      return { kind: 'read', grantId, sql: READ_SQL[act] };
    case 'materialise':
      return { kind: 'materialise', grantId };
    case 'list':
      return { kind: 'list' };
    case 'release':
      return { kind: 'release', grantId };
    case 'ask':
      return { kind: 'ask' };
  }
}

/** The verdict fields the table pins (a refusal may also carry the grant it found — not pinned). */
export function pickVerdict(verdict: Record<string, unknown>, expected: Expected): Record<string, unknown> {
  if (expected.ok) return expected.attended === undefined ? { ok: verdict.ok } : { ok: verdict.ok, attended: verdict.attended };
  return {
    ok: verdict.ok,
    code: verdict.code,
    message: verdict.message,
    retryable: verdict.retryable,
    ...(verdict.effect !== undefined ? { effect: verdict.effect } : {}),
  };
}

// =========================================================================================
// The handler driver — the frame cells through the REAL createAccessHandlerFor
// =========================================================================================

const base = () => ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `req-${++seq}`, instanceId: 'inst-table' }) as const;
const queryFrame = (grantId: string, sql: string): AccessRequestFrame => ({ ...base(), op: 'query', grantId, sql });
const listFrame = (): AccessRequestFrame => ({ ...base(), op: 'list' });
const releaseFrame = (grantId: string): AccessRequestFrame => ({ ...base(), op: 'release', grantId });
const askFrame = (): AccessRequestFrame => ({ ...base(), op: 'request', purpose: 'to show spending by category', hints: { tables: ['transactions'], words: ['spending'] } });

const asRefusal = (expected: Expected): AccessHandlerResult =>
  expected.ok ? ({ ok: true } as AccessHandlerResult) : { ok: false, code: expected.code, message: expected.message, retryable: expected.retryable };

/** The effect a READ performed, read back from the file and the engine — or none. */
function performedEffect(grantId: string, before: { history: string; grant: string }): PolicyEffectName | undefined {
  const { db, ledger } = world();
  const lines = db.listAccessLog(ledger).filter((entry) => entry.grantId === grantId);
  const priorLines = (JSON.parse(before.history) as Array<{ kind: string; grantId: string }>).filter((entry) => entry.grantId === grantId);
  const fresh = (kind: string) => lines.filter((entry) => entry.kind === kind).length > priorLines.filter((entry) => entry.kind === kind).length;
  const found = findAccessGrant(db, grantId);
  const priorGrant = JSON.parse(before.grant) as FoundAccessGrant | null;
  if (found?.grant.status === 'suspended' && found.grant.suspendedReason === 'source-restricted' && priorGrant?.grant.status !== 'suspended') return 'suspend-source-restricted';
  if (fresh('expired')) return 'mark-expired';
  if (fresh('refused')) {
    expect(lines.find((entry) => entry.kind === 'refused'), 'the refused line is written away').toMatchObject({ attended: false });
    return 'refused-line';
  }
  return undefined;
}

/** Drive ONE frame cell through today's handler and assert the table's answer and effect. */
export async function driveHandlerCell(cell: Cell): Promise<void> {
  const { budget, db, ledger } = world();
  const { grantId, handler } = await prepare(cell);
  if (handler === undefined) throw new Error(`${cell.caller} is not a frame caller`);
  const expected = cell.answer;
  const before = observe(grantId);

  switch (cell.act) {
    case 'read-select':
    case 'read-delete': {
      const answer = await handler.handle(budget, queryFrame(grantId, READ_SQL[cell.act]));
      if (expected.ok) {
        expect(answer).toMatchObject({ ok: true, op: 'query' });
        expect(db.listAccessLog(ledger)[0], 'the read is logged on the source with its posture').toMatchObject({ kind: 'read', grantId, attended: expected.attended });
      } else {
        expect(answer).toEqual(asRefusal(expected));
        expect(performedEffect(grantId, before), 'the effect the verdict names, performed once').toBe(expected.effect);
      }
      return;
    }
    case 'materialise': {
      // Today's admission of the row: in the frame's `list` iff admitted — and `list` performs NOTHING.
      const answer = await handler.handle(budget, listFrame());
      expect(answer).toMatchObject({ ok: true, op: 'list' });
      const listed = answer.ok && answer.op === 'list' ? answer.grants.map((view) => view.id) : [];
      expect(listed.includes(grantId), 'listed iff admitted').toBe(expected.ok);
      expect(observe(grantId), 'list writes nothing — no line, no status change').toEqual(before);
      return;
    }
    case 'list': {
      expect(await handler.handle(budget, listFrame())).toMatchObject({ ok: true, op: 'list' });
      expect(observe(grantId)).toEqual(before);
      return;
    }
    case 'release': {
      const answer = await handler.handle(budget, releaseFrame(grantId));
      expect(answer).toEqual(expected.ok ? { ok: true, op: 'release' } : asRefusal(expected));
      return;
    }
    case 'ask': {
      const answer = handler.handle(budget, askFrame());
      if (expected.ok) {
        // Presence passed: the ask went on to the ladder and parked the strip's pending.
        await expect.poll(() => pendingAccessStore.get()[budget], { timeout: 3000 }).toBeDefined();
        void pendingAccessStore.get()[budget]!.resolve({ kind: 'not-now' });
        const settled = await answer;
        expect(settled.ok ? 'ok' : settled.code).not.toBe(ACCESS_ERROR_CODES.ACCESS_UNATTENDED);
      } else {
        expect(await answer).toEqual(asRefusal(expected));
        expect(pendingAccessStore.get()[budget], 'nothing parked').toBeUndefined();
      }
      return;
    }
  }
}

// =========================================================================================
// PR-3 — THE SECOND TABLE: write · refresh · discover (contract v2 D-PR3-13)
// =========================================================================================

/**
 * The v2 act columns: `write` names transactions (the table the write fixtures tick), `write-readonly`
 * names accounts (ticked read-only in `persisted-write`, outside every other scope), `refresh`,
 * `discover`.
 */
export const ACT_KEYS_V2 = ['write', 'write-readonly', 'refresh', 'discover'] as const;
export type ActKeyV2 = (typeof ACT_KEYS_V2)[number];

/** Every grant of the second table: the first table's ten, then PR-3's three. */
export const GRANT_KEYS_V2 = [...GRANT_KEYS, ...GRANT_KEYS_PR3] as const;
export type GrantKeyV2 = (typeof GRANT_KEYS_V2)[number];

/** The statement each write column sends — one plain UPDATE of one row of its table. */
export const WRITE_SQL: Record<'write' | 'write-readonly', string> = {
  write: "UPDATE transactions SET category = 'groceries' WHERE id = 1",
  'write-readonly': "UPDATE accounts SET balance = 1 WHERE name = 'main'",
};
export const WRITE_TABLE: Record<'write' | 'write-readonly', string> = { write: 'transactions', 'write-readonly': 'accounts' };

/**
 * The PR-3 codes and sentences — LOCAL widenings until the implementation lanes export them
 * (I-W: the three codes; I-U: the sentences in copy.ts). Read at cell time, never retyped.
 */
type PR3Codes = typeof ACCESS_ERROR_CODES & Record<'ACCESS_WRITE_REFUSED' | 'ACCESS_BUSY' | 'ACCESS_REFRESH_FAILED', string>;
type PR3Messages = typeof ACCESS_APP_MESSAGES & Record<'writeNotGranted' | 'refreshNotGranted' | 'refreshOff' | 'refreshNoHandler' | 'busy', string>;
const C3 = ACCESS_ERROR_CODES as PR3Codes;
const M3 = ACCESS_APP_MESSAGES as PR3Messages;

/** A readable name per expectation — the v2 codes/sentences are undefined until they land, so a cell's title never prints them. */
const LABELS = new Map<Expected, string>();
const named = <T extends Expected>(expected: T, label: string): T => {
  LABELS.set(expected, label);
  return expected;
};
const labelOf = (expected: Expected): string => LABELS.get(expected) ?? describeExpected(expected);
named(OK_HERE, 'ok (attended true)');
named(OK_AWAY, 'ok (attended false)');
named(OK, 'ok');
named(NOT_GRANTED, 'ACCESS_NOT_GRANTED notGranted');
named(NOT_GRANTED_LINE, 'ACCESS_NOT_GRANTED notGranted + refused-line (named, not performed)');
named(REVOKED, 'ACCESS_REVOKED revoked');
named(PAUSED, 'ACCESS_REVOKED paused');
named(SOURCE_CHANGED, 'ACCESS_REVOKED sourceChanged');
named(EXPIRED, 'ACCESS_EXPIRED expired + mark-expired (named, not performed)');
named(RESTRICTED, 'ACCESS_REVOKED paused + suspend-source-restricted (named, not performed)');
named(UNATTENDED, 'ACCESS_UNATTENDED unattended (retryable)');

/** Admitted to change the named table — always with someone present (rule 4′). */
const WRITE_OK = named<Expected>({ ok: true, attended: true }, 'ok (attended true)');
/** Rule 7: the named table carries no `write` in this grant (or is outside its scope). */
const WRITE_NOT_GRANTED = named(refusal(C3.ACCESS_NOT_GRANTED, M3.writeNotGranted, false), 'ACCESS_NOT_GRANTED writeNotGranted');
/** After rules 1–5: the grant was not allowed to ask for new data. */
const REFRESH_NOT_GRANTED = named(refusal(C3.ACCESS_NOT_GRANTED, M3.refreshNotGranted, false), 'ACCESS_NOT_GRANTED refreshNotGranted');
/** The refresh engine's first gate in this world: no scheduler state row (D-PR3-17 (1)). */
const REFRESH_OFF = named(refusal(C3.ACCESS_REFRESH_FAILED, M3.refreshOff, false), 'ACCESS_REFRESH_FAILED refreshOff');
const REFRESH_GATE_WHY = 'admitted by the policy; the refresh engine’s first gate answers — this world never booted the scheduler, so no scheduler state row exists (D-PR3-17 (1))';
const REFRESH_HERE: Diverging = { verdict: OK_HERE, answer: REFRESH_OFF, why: REFRESH_GATE_WHY };
const REFRESH_AWAY: Diverging = { verdict: OK_AWAY, answer: REFRESH_OFF, why: REFRESH_GATE_WHY };

type RowV2 = readonly [write: Entry, writeReadonly: Entry, refresh: Entry, discover: Entry];

const U = UNATTENDED;
const WNG = WRITE_NOT_GRANTED;
const RNG = REFRESH_NOT_GRANTED;

/**
 * THE SECOND TABLE, by hand. Columns: write transactions · write accounts · refresh · discover.
 * write: 1 owned · 2 status · 3 expiry · 4′ someone present, whatever the grant says · 5 WhatsApp fact
 * · 7 the table's `write`. refresh: 1–5 exactly as read, then `refresh`. discover: the ask's presence.
 */
export const TABLE_V2: Record<CallerKey, Record<GrantKeyV2, RowV2>> = {
  // Someone present at g0: the write reaches rule 7; composing g0 binds the unbound session grant.
  'frame-g0': {
    persisted: [WNG, WNG, RNG, OK],
    'persisted-away': [WNG, WNG, RNG, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK],
    'session-g0': [WNG, WNG, RNG, OK],
    'session-g0-away': [WNG, WNG, RNG, OK],
    'session-unbound': [WNG, WNG, RNG, OK],
    // Rule 5 precedes rule 7: the fact pauses the access before its tables are looked at.
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK],
    'persisted-write': [WRITE_OK, WNG, RNG, OK],
    'persisted-refresh': [WNG, WNG, REFRESH_HERE, OK],
    'session-g0-write': [WRITE_OK, WNG, RNG, OK],
  },
  // A delegated run in flight: nobody present. Rule 4′ refuses EVERY write that reaches it — even a
  // grant allowed while away; a refresh follows read's rule 4 (away passes; a session grant never).
  'frame-g0-delegated': {
    persisted: [U, U, NOT_GRANTED_LINE, U],
    'persisted-away': [U, U, RNG, U],
    revoked: [REVOKED, REVOKED, REVOKED, U],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, U],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, U],
    expired: [EXPIRED, EXPIRED, EXPIRED, U],
    'session-g0': [U, U, NOT_GRANTED_LINE, U],
    'session-g0-away': [U, U, NOT_GRANTED_LINE, U],
    'session-unbound': [U, U, NOT_GRANTED_LINE, U],
    // Rule 4′ precedes rule 5 for a write; for a refresh read's rule 4 passes (away) and rule 5 pauses.
    'source-restricted': [U, U, RESTRICTED, U],
    'persisted-write': [U, U, NOT_GRANTED_LINE, U],
    'persisted-refresh': [U, U, REFRESH_AWAY, U],
    'session-g0-write': [U, U, NOT_GRANTED_LINE, U],
  },
  // g1: g0's session grants died with their frame (rule 1, silent); the unbound one binds to g1.
  'frame-g1': {
    persisted: [WNG, WNG, RNG, OK],
    'persisted-away': [WNG, WNG, RNG, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
    'session-unbound': [WNG, WNG, RNG, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK],
    'persisted-write': [WRITE_OK, WNG, RNG, OK],
    'persisted-refresh': [WNG, WNG, REFRESH_HERE, OK],
    'session-g0-write': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
  },
  // The hidden frame: no generation (owns no session grant), nobody present.
  'frame-hidden': {
    persisted: [U, U, NOT_GRANTED_LINE, U],
    'persisted-away': [U, U, RNG, U],
    revoked: [REVOKED, REVOKED, REVOKED, U],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, U],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, U],
    expired: [EXPIRED, EXPIRED, EXPIRED, U],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
    'session-unbound': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
    'source-restricted': [U, U, RESTRICTED, U],
    'persisted-write': [U, U, NOT_GRANTED_LINE, U],
    'persisted-refresh': [U, U, REFRESH_AWAY, U],
    'session-g0-write': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
  },
  // The chat beside the open reader (g0): the user typed — attended; owns g0's session grants.
  'chat-g0': {
    persisted: [WNG, WNG, RNG, OK],
    'persisted-away': [WNG, WNG, RNG, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK],
    'session-g0': [WNG, WNG, RNG, OK],
    'session-g0-away': [WNG, WNG, RNG, OK],
    'session-unbound': [WNG, WNG, RNG, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK],
    'persisted-write': [WRITE_OK, WNG, RNG, OK],
    'persisted-refresh': [WNG, WNG, REFRESH_HERE, OK],
    'session-g0-write': [WRITE_OK, WNG, RNG, OK],
  },
  // The chat beside a CLOSED app: attended, owns no session grant.
  'chat-none': {
    persisted: [WNG, WNG, RNG, OK],
    'persisted-away': [WNG, WNG, RNG, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
    'session-unbound': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK],
    'persisted-write': [WRITE_OK, WNG, RNG, OK],
    'persisted-refresh': [WNG, WNG, REFRESH_HERE, OK],
    'session-g0-write': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, OK],
  },
  // The chat during a delegated run on the reader's frame: the chat door never reads the run state (D-PR2-4).
  'chat-g0-delegated': {
    persisted: [WNG, WNG, RNG, OK],
    'persisted-away': [WNG, WNG, RNG, OK],
    revoked: [REVOKED, REVOKED, REVOKED, OK],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, OK],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, OK],
    expired: [EXPIRED, EXPIRED, EXPIRED, OK],
    'session-g0': [WNG, WNG, RNG, OK],
    'session-g0-away': [WNG, WNG, RNG, OK],
    'session-unbound': [WNG, WNG, RNG, OK],
    'source-restricted': [RESTRICTED, RESTRICTED, RESTRICTED, OK],
    'persisted-write': [WRITE_OK, WNG, RNG, OK],
    'persisted-refresh': [WNG, WNG, REFRESH_HERE, OK],
    'session-g0-write': [WRITE_OK, WNG, RNG, OK],
  },
  // A scheduled step: never present, owns no session grant; its read-rule-4 refusals are silent.
  schedule: {
    persisted: [U, U, NOT_GRANTED, U],
    'persisted-away': [U, U, RNG, U],
    revoked: [REVOKED, REVOKED, REVOKED, U],
    'suspended-source-changed': [SOURCE_CHANGED, SOURCE_CHANGED, SOURCE_CHANGED, U],
    'suspended-imported': [PAUSED, PAUSED, PAUSED, U],
    expired: [EXPIRED, EXPIRED, EXPIRED, U],
    'session-g0': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
    'session-g0-away': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
    'session-unbound': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
    'source-restricted': [U, U, RESTRICTED, U],
    'persisted-write': [U, U, NOT_GRANTED, U],
    'persisted-refresh': [U, U, REFRESH_AWAY, U],
    'session-g0-write': [NOT_GRANTED, NOT_GRANTED, NOT_GRANTED, U],
  },
};

export interface CellV2 {
  caller: CallerKey;
  grant: GrantKeyV2;
  act: ActKeyV2;
  verdict: Expected;
  answer: Expected;
  why?: string;
  name: string;
}

function cellOfV2(caller: CallerKey, grant: GrantKeyV2, act: ActKeyV2, entry: Entry): CellV2 {
  const verdict = isDiverging(entry) ? entry.verdict : entry;
  const answer = isDiverging(entry) ? entry.answer : entry;
  return {
    caller,
    grant,
    act,
    verdict,
    answer,
    ...(isDiverging(entry) ? { why: entry.why } : {}),
    name: `${CALLER_LABELS[caller]} × ${GRANT_LABELS[grant]} × ${act} → ${labelOf(verdict)}`,
  };
}

/** Every cell of the second table, caller by caller, grant by grant, act by act. */
export function tableCellsV2(): CellV2[] {
  const cells: CellV2[] = [];
  for (const caller of CALLER_KEYS) {
    for (const grant of GRANT_KEYS_V2) {
      const row = TABLE_V2[caller][grant];
      ACT_KEYS_V2.forEach((act, index) => cells.push(cellOfV2(caller, grant, act, row[index]!)));
    }
  }
  return cells;
}

/** The v2 act as the contract types it (D-PR3-13's `AccessAct` additions) — structural here. */
export function actOfV2(act: ActKeyV2, grantId: string): { kind: 'write'; grantId: string; table: string } | { kind: 'refresh'; grantId: string } | { kind: 'discover' } {
  switch (act) {
    case 'write':
    case 'write-readonly':
      return { kind: 'write', grantId, table: WRITE_TABLE[act] };
    case 'refresh':
      return { kind: 'refresh', grantId };
    case 'discover':
      return { kind: 'discover' };
  }
}

/** What a discover answers in this world: Ledger and Pantry hold tables — but a WhatsApp fact leaves Ledger out. */
export function discoverClassFor(grant: GrantKeyV2): 'one' | 'several' {
  return grant === 'source-restricted' ? 'one' : 'several';
}

// The three new frames, cast: the protocol's request union gains them in I-W.
const writeFrame = (grantId: string, sql: string): AccessRequestFrame => ({ ...base(), op: 'write', grantId, sql }) as unknown as AccessRequestFrame;
const refreshFrame = (grantId: string): AccessRequestFrame => ({ ...base(), op: 'refresh', grantId }) as unknown as AccessRequestFrame;
const discoverFrame = (): AccessRequestFrame => ({ ...base(), op: 'discover', hints: { tables: ['transactions'], words: ['spending'] } }) as unknown as AccessRequestFrame;

/**
 * Drive ONE frame cell of the second table through the REAL handler: the answer, and — A-Q1 — that
 * the act PERFORMED nothing a refusal names (no `refused`/`expired` line, no pause): a refused v2 act
 * leaves the source's history and the grant exactly as they were. An admitted write changes one row
 * and answers its count; an admitted discover answers the class and records nothing.
 */
export async function driveHandlerCellV2(cell: CellV2): Promise<void> {
  const { budget, db, ledger } = world();
  const { grantId, handler } = await prepare(cell);
  if (handler === undefined) throw new Error(`${cell.caller} is not a frame caller`);
  const expected = cell.answer;
  const before = observe(grantId);

  switch (cell.act) {
    case 'write':
    case 'write-readonly': {
      const answer = await handler.handle(budget, writeFrame(grantId, WRITE_SQL[cell.act]));
      if (expected.ok) {
        expect(answer, 'changes only — no undo id on the wire').toEqual({ ok: true, op: 'write', changes: 1 });
        expect(db.listAccessLog(ledger)[0], 'the write is on the source’s history').toMatchObject({ kind: 'wrote', grantId });
      } else {
        expect(answer).toEqual(asRefusal(expected));
        expect(observe(grantId), 'a refused write performs nothing — no line, no status change (A-Q1)').toEqual(before);
      }
      return;
    }
    case 'refresh': {
      const answer = await handler.handle(budget, refreshFrame(grantId));
      expect(answer).toEqual(asRefusal(expected));
      expect(observe(grantId), 'a refused refresh performs nothing (A-Q1); the engine’s gate runs nothing and writes no line').toEqual(before);
      return;
    }
    case 'discover': {
      const answer = await handler.handle(budget, discoverFrame());
      if (expected.ok) expect(answer).toEqual({ ok: true, op: 'discover', candidates: discoverClassFor(cell.grant) });
      else expect(answer).toEqual(asRefusal(expected));
      expect(observe(grantId), 'a discover records nothing').toEqual(before);
      expect(pendingAccessStore.get()[budget], 'nothing parked').toBeUndefined();
      return;
    }
  }
}
