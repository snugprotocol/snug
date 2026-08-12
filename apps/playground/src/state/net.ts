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
  UserDbCredentialStore,
  type ConnectedFetchDeps,
  type NetConfirmDecision,
  type NetConfirmRequest,
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
}

/** null when no confirm is open. The confirm dialog renders exactly this. */
export const netConfirmStore = createStore<PendingNetConfirm | null>(null);

/** The session-remember gate — its `invalidate` is called by the Connections actions. */
const confirmGate = createSessionConfirmGate(
  (request) =>
    new Promise<NetConfirmDecision>((resolve) => {
      netConfirmStore.set({
        request,
        resolve: (decision) => {
          netConfirmStore.set(null);
          resolve(decision);
        },
      });
    }),
);

/** The confirm dialog calls this with the user's decision. */
export function resolveNetConfirm(decision: NetConfirmDecision): void {
  netConfirmStore.get()?.resolve(decision);
}

/** Drop remembered session grants for an app — called on approve/reapprove/revoke (R3). */
export function invalidateNetGrants(appId: string): void {
  confirmGate.invalidate(appId);
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
    confirmGate,
    // Decision 6 (TASK-20260812): the LAN rung keys on the platform capability — desktop
    // widens `http://` to explicitly-approved private-range IP literals; the browser
    // profile passes NO seat at all, so the executor's default (https-only) is untouched.
    ...(getPlatform().capabilities.lanHttpPrivate ? { transportPolicy: { allowHttpForPrivateHosts: true } } : {}),
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
      const executor = createConnectedFetch(connectedFetchDepsFor(db, fetchImpl));
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

/** TEST-ONLY: close any open confirm and reset remembered grants. */
export function __resetNetStateForTests(): void {
  netConfirmStore.set(null);
  // A fresh gate is not needed — invalidate-all isn't a public op; grants are per-app and
  // tests use distinct app ids. Clearing the open confirm is enough between tests.
}
