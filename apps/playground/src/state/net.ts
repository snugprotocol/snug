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
  type NetConfirmDecision,
  type NetConfirmRequest,
  type NetSpecReader,
} from '@snugprotocol/auth';
import type { NetHandler, NetHandlerResult } from '@snugprotocol/runner';
import type { NetRequestFrame } from '@snugprotocol/protocol';

import { getUserDb } from './userdb.js';
import { createStore } from './store.js';

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
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async handle(netAppId: string, request: NetRequestFrame): Promise<NetHandlerResult> {
      const db = await getUserDb();
      const specReader: NetSpecReader = {
        getAuthSpec: (appId) => {
          const row = db.getAuthSpec(appId);
          return row === undefined ? undefined : { spec: row.spec, status: row.status, allowedHosts: row.allowedHosts };
        },
      };
      const executor = createConnectedFetch({
        credentialStore: new UserDbCredentialStore(db),
        specReader,
        fetchImpl,
        confirmGate,
      });
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
