// access/accessHandler.ts — the runner's access seam for ONE composed frame
// (TASK-20261010-cross-app-access AC11–AC13; ADR-0075 §1–§9; D5, D6, D7, D10, D14, D19, D23;
// TASK-20261010-host-broker PR-2: the frame is one CALLER of the Access Service, ADR-0076 §1–§3).
//
// `createAccessHandlerFor(appId, frame)` is composed by the run view (`{ attended: true,
// generation }`) and the scheduler's hidden frame (`{ attended: false }`) for an OWNED app.
// `appId` is the HOST-assigned library id — the runner's `accessAppId`, the `dbNamespace`
// discipline — and the generation is the host's frame generation of the VISIBLE view. Every limit
// and every session grant keys on those two; the app-rolled `instanceId` identifies no one (a
// re-announce changes it at will). A call under any other `accessAppId` is answered exactly like
// an unknown grant.
//
// THE FRAME IS A CALLER (PR-2). The rules of who may read what live in `policy.ts` and the body of
// a read in `service.ts` — one engine the frame, the chat beside the app and a schedule's step all
// read through. This module builds the frame's `AccessCaller` PER OP — `{ kind: 'frame', appId,
// generation (the visible frame's; the hidden frame has none), present }` — and hands `query`,
// `list` and `release` to the service. A SESSION GRANT ("while it's open") belongs to the visible
// frame of its generation and to nothing else: the hidden frame has no generation and never reads,
// lists or releases one — not even one ticked *also while I'm away* — so it is answered like any
// grant that is not its own (`ownsGrant`, policy rule 1).
//
// THE DOOR CLOSES FOR A DELEGATED RUN'S WINDOW (TASK-20261010-host-broker PR-1; ADR-0077 §3;
// contract v2 D-PR1-8). A run the user did not start may execute on the VISIBLE frame
// (`schedule/runPlacement.ts`); while one is in flight for this app the attended handler takes
// the hidden frame's posture, read PER OP as `present`: `request` is told `ACCESS_UNATTENDED` (a
// timer-fired run must not park a consent sheet — a stronger authority than a POST), `query`
// admits only a persisted grant allowed *also while I'm away* (a session grant is this frame's but
// not readable with nobody present, whatever its tick — policy rule 4, D30 as a rule; a `refused`
// line with `attended: false`), and a `read` line says `attended: false`. After the run the door
// reopens; the app's genuine ask is the ordinary strip, which needs the user's act anyway. `list`
// filters on the same presence as `query` admits (Gate-5 F-10) — it never advertises a grant a
// query would refuse during the run; `release` keeps the frame's own posture (nothing is read or
// asked through it).
//
// THE OPS.
//  - `request` STAYS HERE (D-PR2-14): the presence decision is the policy's `ask` verdict — a
//    hidden frame, or a visible one during a delegated run, is told `ACCESS_UNATTENDED` (nobody to
//    ask; nothing recorded, no window spent); then the shared ladder (`state/appAsk.ts` via
//    consent.ts — the window per app, the mutes, the declines by semantic hash, one pending per
//    generation); then the candidates — none → `ACCESS_NO_SOURCES` (nothing recorded, no strip).
//    The gathering is an await: if the frame the ask came from ended meanwhile (its view closed, a
//    newer generation was composed, a session reset), the ask parks NOTHING and is answered *not
//    now* — a dead frame's ask must never block the next frame of the same id. Else ONE pending is
//    parked for the strip and the answer is HELD until the user's act resolves it.
//  - `query` → `accessService().read(caller, …)`: the per-app minute FIRST — every query op
//    counts, a refused one or an unknown id too, so no frame can write history lines faster than
//    the limit; then the verdict (owned, active, not expired — expiry derived; marked once — usable
//    while away if nobody is present, else a `refused` line, at most ONE per access per
//    `ACCESS_LOG_COALESCE_MS`; the source free of a WhatsApp fact at THIS moment, else it pauses
//    `source-restricted`; ONE read-only SELECT), the read in the Worker under its wall clock, the
//    cells MASKED, the `read` line on the source BEFORE the rows leave, and the counters.
//  - `list` → `accessService().list(caller)`: this reader's live grants as views (a hidden frame:
//    the ones usable while away).
//  - `release` → `accessService().release(caller, grantId)`: the reader gives back its own grant.
//
// App-facing messages are `copy.ts`'s `ACCESS_APP_MESSAGES` — never a fact about another app the
// reader was not granted. Errors are data; anything unexpected answers `HOST_ERROR`.

import { ACCESS_ERROR_CODES, ERROR_CODES, accessRequestHash, type AccessRequestFrame } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import type { AccessHandler, AccessHandlerResult } from '@snugprotocol/runner';

// A leaf (`state/store.ts` and `state/appHosts.ts` only) — safe to import here.
import { delegatedRunFor } from '../schedule/runPlacement.js';
import { accessAskLadder, accessAsksOff, collectSources, dismissStaleAccessAsk, parkAccessRequest, type ConsentOutcome } from './consent.js';
import { ACCESS_APP_MESSAGES } from './copy.js';
import {
  accessDeps,
  armAccessListeners,
  findAccessGrant,
  grantView,
  noteReaderGeneration,
  readerFrameEnds,
  readerGeneration,
  type AnyAccessGrant,
  type FoundAccessGrant,
} from './grants.js';
import { authorise, ownsGrant, type AccessCaller, type Refusal } from './policy.js';
import { accessService, policyContextFor } from './service.js';

/** Who composed the handler: the visible view at its generation, or the hidden (scheduled) frame, which has none. */
export type AccessFrame = { attended: true; generation: number } | { attended: false };

type RequestOp = Extract<AccessRequestFrame, { op: 'request' }>;

const refuse = (code: string, message: string, retryable: boolean): AccessHandlerResult => ({ ok: false, code, message, retryable });

/** The verdict as the app hears it — the effect and the grant it carried stay on the host's side. */
const refused = (verdict: Refusal): AccessHandlerResult => refuse(verdict.code, verdict.message, verdict.retryable);

// One spelling per answer, so two refusals that must not be told apart are byte-identical.
const notGranted = (): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED, ACCESS_APP_MESSAGES.notGranted, false);
const notNow = (): AccessHandlerResult => refuse(ACCESS_ERROR_CODES.ACCESS_DECLINED, ACCESS_APP_MESSAGES.notNow, true);
const hostError = (): AccessHandlerResult => refuse(ERROR_CODES.HOST_ERROR, ACCESS_APP_MESSAGES.hostError, true);

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

  /** Is someone there to be asked RIGHT NOW: the visible frame, and no delegated run in flight for the app (D-PR1-8). */
  const present = (): boolean => attended && delegatedRunFor(appId) === undefined;

  /** The frame as the policy's caller, read PER OP: its generation (the hidden frame has none) and whether someone is there right now. */
  const caller = (): AccessCaller => ({ kind: 'frame', appId, ...(frame.attended ? { generation: frame.generation } : {}), present: present() });

  /** This reader's grant by id — a session grant only for the visible frame of its generation — else nothing (the caller answers not-granted). */
  function ownGrant(db: UserDb, grantId: string): FoundAccessGrant | undefined {
    const found = findAccessGrant(db, grantId);
    return found !== undefined && ownsGrant(caller(), found) ? found : undefined;
  }

  async function request(db: UserDb, frame: RequestOp): Promise<AccessHandlerResult> {
    const presence = authorise(policyContextFor(db, now()), caller(), { kind: 'ask' });
    if (!presence.ok) return refused(presence);
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

  return {
    async handle(accessAppId, frame) {
      if (accessAppId !== appId) return notGranted();
      try {
        switch (frame.op) {
          case 'request':
            return await request(await accessDeps().getDb(), frame);
          case 'query':
            return await accessService().read(caller(), { grantId: frame.grantId, sql: frame.sql, ...(frame.params !== undefined ? { params: frame.params } : {}) });
          case 'list':
            return await accessService().list(caller());
          case 'release':
            return await accessService().release(caller(), frame.grantId);
        }
      } catch {
        return hostError();
      }
    },
  };
}
