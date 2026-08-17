// net.ts — the playground half of AL-03's envelope net capability. Wires the
// connected-fetch executor (@snugprotocol/auth) to the page-wide user DB and exposes a
// NetHandler the runner routes net-request frames to. The runner never sees a credential
// value (R4); the executor injects and scrubs.
//
// The confirm gate is the session-remember gate (keyed app/host/method, in-memory,
// invalidated on approve/reapprove/revoke — R3). Its UI is a single pending-confirm
// store the confirm dialog observes: the gate parks a request, the dialog renders it,
// and resolveNetConfirm(decision) completes the promise. One confirm at a time (v1).

import {
  createConnectedFetch,
  createSessionConfirmGate,
  createStandingApprovalGate,
  UserDbCredentialStore,
  type ConnectedFetchDeps,
  type NetConfirmDecision,
  type NetConfirmRequest,
  type StandingApprovalStore,
  type StandingGrant,
} from '@snugprotocol/auth';
import type { NetHandler, NetHandlerResult } from '@snugprotocol/runner';
import type { NetRequestFrame } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { getUserDb } from './userdb.js';
import { createStore } from './store.js';
import { getPlatform } from '../platform/platform.js';

/**
 * THE single platform fetch seam (TASK-20260812, P0 amendment 5): the default transport
 * for BOTH connected-fetch call paths — the RunView net handler and the wizard's
 * `executeConnectionTestRequest` probe — because both assemble their deps through
 * `connectedFetchDepsFor` below. Desktop's native fetch rides in here and NOWHERE else;
 * with no platform set this is byte-for-byte today's page fetch (AC10). Resolved per
 * call, not at module load, so the seam can never capture a stale platform.
 */
function platformDefaultFetch(input: string, init?: RequestInit): Promise<Response> {
  const fetchImpl = getPlatform().fetchImpl;
  return fetchImpl !== undefined ? fetchImpl(input, init) : globalThis.fetch(input, init);
}

/** A confirm awaiting the user's decision (mutating net call). The dialog observes this. */
export interface PendingNetConfirm {
  request: NetConfirmRequest;
  resolve(decision: NetConfirmDecision): void;
  /**
   * WHERE this confirm renders (TASK-20260815-inline-cards). `'chat'` means a chat-lane
   * card owns it and the modal dialog must NOT double-render it; absent means the modal
   * (app-runtime requests, and any caller that never tagged). The tag is set by the
   * PARKING path from a WeakMap keyed on the executor's own request object — the same
   * reference-identity trick the abort-deny uses, so no field matching, no ambiguity.
   */
  origin?: 'chat';
}

const confirmOrigins = new WeakMap<NetConfirmRequest, 'chat'>();

/** Tag the NEXT parked confirm for `request` as chat-rendered. Call BEFORE the gate. */
export function tagConfirmOrigin(request: NetConfirmRequest, origin: 'chat'): void {
  confirmOrigins.set(request, origin);
}

/**
 * How many chat-card confirm surfaces are currently MOUNTED (Gate-5 B MAJOR-2). The
 * chat card only exists while ChatLog is on screen — RunView renders it per rail tab —
 * so keying the modal's silence on origin ALONE left a parked chat confirm with no
 * surface at all (and, because only the queue head renders, everything behind it
 * invisible too). The modal now yields to the card only while a card surface is
 * actually mounted; otherwise it renders every confirm, chat-origin included.
 */
export const chatConfirmSurfaceStore = createStore<number>(0);

/** Mount/unmount registration for the chat confirm card surface. */
export function registerChatConfirmSurface(): () => void {
  chatConfirmSurfaceStore.set(chatConfirmSurfaceStore.get() + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatConfirmSurfaceStore.set(Math.max(0, chatConfirmSurfaceStore.get() - 1));
  };
}

/** null when no confirm is open. The confirm dialog renders exactly this — the QUEUE HEAD. */
export const netConfirmStore = createStore<PendingNetConfirm | null>(null);

/**
 * Parked confirms are a FIFO QUEUE (TASK-20260815 AC11, plan-review F4). The store used
 * to be a single unconditionally-set slot, so a second concurrent confirm OVERWROTE the
 * first and orphaned its resolver — that executor call awaited forever. With the chat
 * rail beside a running app, "the app auto-POSTs while the user's provider_write is
 * mid-confirm" is ordinary usage, not a race: the dialog renders the head, resolution
 * shifts the queue, and every parked promise settles.
 */
const confirmQueue: PendingNetConfirm[] = [];

function advanceConfirmQueue(): void {
  netConfirmStore.set(confirmQueue[0] ?? null);
}

/** The session-remember gate — its `invalidate` is called by the Connections actions. */
const confirmGate = createSessionConfirmGate(
  (request) =>
    new Promise<NetConfirmDecision>((resolve) => {
      const origin = confirmOrigins.get(request);
      const entry: PendingNetConfirm = {
        request,
        resolve: (decision) => {
          const index = confirmQueue.indexOf(entry);
          if (index === -1) return; // already resolved (double-click guard) or reset
          confirmQueue.splice(index, 1);
          advanceConfirmQueue();
          resolve(decision);
        },
        ...(origin !== undefined ? { origin } : {}),
      };
      confirmQueue.push(entry);
      if (confirmQueue.length === 1) advanceConfirmQueue();
    }),
);

/** The confirm dialog calls this with the user's decision. */
export function resolveNetConfirm(decision: NetConfirmDecision): void {
  netConfirmStore.get()?.resolve(decision);
}

/**
 * Deny ONE parked confirm, identified by its `request` object — REFERENCE equality
 * (TASK-20260815 Gate-5 MAJOR-1). `createSessionConfirmGate` passes the executor's
 * request object through to the prompt unchanged, so a caller that observed its own
 * `confirm(request)` call can later deny exactly that entry — head OR tail — without
 * touching a sibling confirm that happens to share appId/host/method. Field matching
 * could never make that distinction; the object identity can. Returns false when the
 * entry is gone (already resolved) — deny-after-decide is a no-op, never an error.
 */
export function denyParkedConfirmByRequest(request: NetConfirmRequest): boolean {
  const entry = confirmQueue.find((parked) => parked.request === request);
  if (entry === undefined) return false;
  entry.resolve({ granted: false });
  return true;
}

/**
 * AUTH-SHAPED FAILURE (TASK-20260812-desktop-auth-awareness AC5; ADR-0022 §4). The
 * executor's deps seat reports `(slot, status, detail?)` when the FINAL delivered
 * result of a request it injected credentials into is a 401/403 — the app-visible
 * result stays untouched (`ok:true`, status as-is). THIS layer adds the `appId` it
 * already holds (the host-assigned netAppId, never anything the app claimed — the
 * pinned literal `onAuthShapedFailure(appId, slot, status)` names this playground
 * altitude) and the RunView banner renders the repair CTA from here.
 *
 * One failure at a time (v1), like the confirm store: the banner is a doorbell, not a
 * ledger — a second failure overwrites the first, and repairing the connection is what
 * stops the ringing. Carries appId/slot/status plus, since TASK-20260815 AC4, an
 * OPTIONAL `detail`: a short, scrubbed, plain-text extract of the provider's own error
 * reason, produced by the executor from the DELIVERED (gate-10-scrubbed, size-capped)
 * body — never a credential, never a URL, never raw response bytes. It exists because
 * the banner's guess copy misdiagnosed the Spotify scope-less 403; the provider's own
 * sentence ("Insufficient client scope") is the one-look diagnosis.
 */
export interface AuthShapedFailure {
  appId: string;
  slot: string;
  status: number;
  detail?: string;
}

/** null when no credentialed 401/403 is waiting on the user. The RunView banner renders this. */
export const authShapedFailureStore = createStore<AuthShapedFailure | null>(null);

/** The banner's dismiss (and its successful-open) landing point. */
export function dismissAuthShapedFailure(): void {
  authShapedFailureStore.set(null);
}

/**
 * THE STANDING APPROVAL GATE (ADR-0033), wrapping the session gate rather than replacing it.
 *
 * Composition is the design, not a convenience: this gate is the ONLY caller of the session
 * gate, so "the standing grant is consulted first, and anything outside its frozen scope
 * falls through to the ordinary confirm" is structural rather than a convention a later edit
 * could invert. The session gate's own key and its deliberate memory-only property are
 * untouched — see `standing-approval.ts` and blocker B2 for why widening it was rejected.
 *
 * The store is in-memory for v1, which is a REAL limitation and is stated rather than
 * papered over: an armed thread does not survive a page reload. ADR-0033 §2 wants the grant
 * persisted with the connection; that lands with the settings-card disclosure, and until it
 * does, a reload is a disarm — the safe direction to fail.
 */
const standingGrants: StandingGrant[] = [];
const standingStore: StandingApprovalStore = {
  list: () => standingGrants,
  save: (grant) => {
    const index = standingGrants.findIndex((row) => row.appId === grant.appId && row.slot === grant.slot);
    if (index >= 0) standingGrants[index] = grant;
    else standingGrants.push(grant);
  },
  clear: (appId) => {
    for (let i = standingGrants.length - 1; i >= 0; i -= 1) {
      if (standingGrants[i]?.appId === appId) standingGrants.splice(i, 1);
    }
  },
};

const standingGate = createStandingApprovalGate({
  store: standingStore,
  inner: confirmGate,
  now: () => Date.now(),
});

/** Arm auto-reply for one thread. The app calls this from an explicit user gesture. */
export function armStandingApproval(grant: StandingGrant): void {
  standingGate.arm(grant);
}

/** The kill switch (ADR-0033 §2) — immediate, and the next send is simply not armed. */
export function disarmStandingApproval(appId: string): void {
  standingGate.disarm(appId);
}

/** What is armed, so the UI can disclose it. An approval the user cannot see is not one. */
export function armedStandingApproval(appId: string): StandingGrant | undefined {
  return standingGate.armedFor(appId);
}

/**
 * Drop remembered session grants for an app — called on approve/reapprove/revoke (R3).
 *
 * Clears the STANDING grant too. A standing approval that outlived a connection change would
 * be an approval for a connection the user just changed — the same reasoning that makes the
 * session gate invalidate here, applied to a grant that is longer-lived and therefore worse
 * to leave behind.
 */
export function invalidateNetGrants(appId: string): void {
  confirmGate.invalidate(appId);
  standingGate.invalidate(appId);
}

/**
 * The executor deps for ONE app, assembled from the page user DB.
 *
 * EXPORTED so the wizard's Q7 probe uses the SAME assembly as the app runtime — the same
 * confirm gate instance (so a probe cannot bypass a confirm the app would face, and a
 * remembered grant means the same thing on both surfaces), the same credential store, the
 * same unfiltered reader. Building a second deps object in the wizard would be building a
 * second network path with its own gate configuration: the exact "small dedicated fetch"
 * that `executeConnectionTestRequest` was written to avoid.
 */
export function connectedFetchDepsFor(
  db: UserDb,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = platformDefaultFetch,
  /**
   * The executor's auth-shaped failure seat (ADR-0022 §4), threaded ONLY by the app
   * runtime path (`createNetHandlerFor`, which knows the appId to add). The wizard's
   * probe path deliberately passes nothing here — probe outcomes render in the wizard
   * and `executeConnectionTestRequest` strips the seat besides (belt and braces; the
   * negative test drives both).
   */
  onAuthShapedFailure?: (slot: string, status: number, detail?: string) => void,
): ConnectedFetchDeps {
  return {
    credentialStore: new UserDbCredentialStore(db),
    /**
     * EVERY row is handed over, unfiltered. Selection IS the routing decision and the
     * executor is the seat accountable for it — a reader that pre-picked a row would hide
     * the two-match ambiguity (NET_AMBIGUOUS_CONNECTION) inside this accessor, where no
     * executor-altitude test could observe it. The narrowing here is about ENTITLEMENT,
     * not convenience: only the seats the executor may read are passed.
     */
    connectionReader: {
      listConnections: (appId) =>
        db.listConnections(appId).map((row) => ({
          appId: row.appId,
          slot: row.slot,
          requirement: row.requirement,
          status: row.status,
          allowedHosts: row.allowedHosts,
          // Carried so the executor's refusal to bind a staged edit stays EXPLICIT
          // (folds B2/S-m2) rather than being invisible through omission.
          ...(row.pendingRequirement !== undefined ? { pendingRequirement: row.pendingRequirement } : {}),
          imported: row.imported,
        })),
    },
    fetchImpl,
    // The STANDING gate, not the session gate directly (ADR-0033). It consults the armed
    // grant first and delegates everything outside that frozen scope to `confirmGate`, so
    // the ordinary confirm still runs for every request the user has not armed — including
    // the wizard's probe, which carries no slot and therefore can never match a grant.
    confirmGate: standingGate,
    // Decision 6 (TASK-20260812): the LAN rung keys on the platform capability — desktop
    // widens `http://` to explicitly-approved private-range IP literals; the browser
    // profile passes NO seat at all, so the executor's default (https-only) is untouched.
    ...(getPlatform().capabilities.lanHttpPrivate ? { transportPolicy: { allowHttpForPrivateHosts: true } } : {}),
    /**
     * The PINNED-TLS LAN transport (ADR-0023 D3; P0 amendment 6), threaded from
     * the platform exactly where `fetchImpl` and `transportPolicy` are, and for
     * the same reason: this is the ONE deps assembly both connected-fetch call
     * paths share, so the app runtime and the wizard probe can never end up
     * with different transports for the same connection.
     *
     * SPREAD, so a web platform contributes no `lanFetch` KEY at all rather than
     * an explicit `undefined`. The distinction is real: it keeps the web deps
     * object byte-identical to today (AC10), and it means an audit of the
     * assembly sees a browser that has never heard of certificate pinning
     * rather than one that declined it.
     *
     * Not defaulted, and deliberately not paired with a fallback: the executor
     * treats absence as a named refusal (`only the desktop app can reach it`),
     * because sending a bridge request through the public-root transport fails
     * opaquely at best and succeeds against the wrong device at worst.
     */
    ...(getPlatform().lanFetch !== undefined ? { lanFetch: getPlatform().lanFetch } : {}),
    ...(onAuthShapedFailure !== undefined ? { onAuthShapedFailure } : {}),
  };
}

export interface CreateNetHandlerOptions {
  /** Injectable for tests + the e2e stub; defaults to the browser's fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Host-side observer of net-error OUTCOMES (AL-04 AC9): the Run view surfaces a
   * connect/re-approve CTA for auth-repairable codes. Receives the CODE only —
   * the wizard mapping is code-keyed, never a message substring (N1).
   */
  onNetError?: (appId: string, code: string) => void;
}

/**
 * Build a NetHandler for the runner. `netAppId` is host-assigned by SnugAppFrame (never
 * app-claimed); the executor reads the frozen ceiling + credentials for that app from
 * the page user DB per use.
 */
export function createNetHandlerFor(options: CreateNetHandlerOptions = {}): NetHandler {
  // Defaults to the SAME platform-sourced seam `connectedFetchDepsFor` uses — the two
  // call paths must never disagree about which transport carries a connected request.
  const fetchImpl = options.fetchImpl ?? platformDefaultFetch;
  return {
    async handle(netAppId: string, request: NetRequestFrame): Promise<NetHandlerResult> {
      const db = await getUserDb();
      // THE v4 READER (P3, fold B1's named exit) is assembled by `connectedFetchDepsFor`,
      // shared with the wizard's Q7 probe so both surfaces route through ONE configured
      // executor rather than two that could drift apart on gates.
      const executor = createConnectedFetch(
        connectedFetchDepsFor(db, fetchImpl, (slot, status, detail) =>
          // The executor reports (slot, status, detail?); the appId is OUR argument —
          // the host-assigned binding this handler was invoked with. Adding it here
          // (not inside the executor) means a wiring bug can never report a foreign
          // app's identity (the deps-level adaptation journaled in the task file).
          authShapedFailureStore.set({ appId: netAppId, slot, status, ...(detail !== undefined ? { detail } : {}) }),
        ),
      );
      // The runner already validated the frame shape (strict schema); pass the app-facing
      // request fields straight through — the executor re-validates and enforces D3.
      const result = await executor.execute(netAppId, {
        url: request.url,
        method: request.method,
        ...(request.headers !== undefined ? { headers: request.headers } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
      if (!result.ok) options.onNetError?.(netAppId, result.code);
      return result.ok
        ? {
            ok: true,
            status: result.status,
            headers: result.headers,
            body: result.body,
            ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
          }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };
}

/** TEST-ONLY: close any open confirm (the WHOLE queue) and reset failure state. */
export function __resetNetStateForTests(): void {
  confirmQueue.length = 0;
  netConfirmStore.set(null);
  authShapedFailureStore.set(null);
  // A fresh gate is not needed — invalidate-all isn't a public op; grants are per-app and
  // tests use distinct app ids. Clearing the parked queue is enough between tests.
}
