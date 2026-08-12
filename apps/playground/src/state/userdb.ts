// userdb.ts — the page-wide user database (ADR-0007): opened once, shared by every
// view, injected into the runner as the db driver. Corruption NEVER fails open (F6):
// the UI surfaces 'corrupt' and recovery is an explicit user action (recoverFresh, or
// restore-from-origin once sync ships). Tests inject a memory-backed instance.

import {
  openUserDb,
  type ConnectionAdmissionGate,
  type OpenUserDbResult,
  type UserDb,
} from '@snugprotocol/db';
import { admitConnectionRequirement, type AdmissionChannel } from '@snugprotocol/auth';
import { getPlatform } from '../platform/platform.js';
import { locateWasm } from '../run/wasm.js';
import { createStore, useStore } from './store.js';

/**
 * THE COMPOSITION ROOT for connection admission (review MAJOR-2).
 *
 * `packages/db` owns the rule that nothing persists unadmitted, but it cannot reach the
 * well-known-provider registry: `@snugprotocol/auth` already depends on
 * `@snugprotocol/db`, so a direct call would close an import cycle. This app depends on
 * BOTH, which makes it the one place the full gate can be assembled — packages/db's
 * built-in default enforces the registry-free half (AC5's userLayer channel rule) until
 * this wiring runs, so the seam is a strengthening, never an on/off switch.
 *
 * The `channel` reaching admission is the row's PERSISTED provenance, handed over by the
 * accessor itself, so the channel a requirement is judged on and the channel recorded
 * beside it are the same value by construction.
 */
const admissionGate: ConnectionAdmissionGate = (requirement, context) =>
  admitConnectionRequirement(requirement, { channel: context.channel as AdmissionChannel });

export type UserDbStatus =
  | { state: 'opening' }
  | { state: 'ready' }
  | { state: 'corrupt'; quarantinedFile: string; message: string }
  | { state: 'unsupported'; foundVersion: number; message: string }
  /**
   * `openUserDb` REJECTED (TASK-20260812 P3 item 7) — the desktop file backend's
   * `load` throws for magic-less/torn bytes, deliberately distinct from the
   * quarantining status:'corrupt' path. The file on disk was NOT touched; the UI
   * must say so plainly and offer a retry, never open a silent fresh DB.
   */
  | { state: 'load-failed'; message: string; path?: string };

export const userDbStatusStore = createStore<UserDbStatus>({ state: 'opening' });

let resolveReady: ((db: UserDb) => void) | undefined;
let readyPromise: Promise<UserDb> | undefined;
let opened = false;
let corruptResult: Extract<OpenUserDbResult, { status: 'corrupt' }> | undefined;

function ensureReadyPromise(): Promise<UserDb> {
  readyPromise ??= new Promise<UserDb>((resolve) => {
    resolveReady = resolve;
  });
  return readyPromise;
}

function attemptOpen(): void {
  // Desktop installs its file backend through the platform seam (Decision 7); web
  // passes nothing and keeps the package's OPFS detection byte-for-byte (AC10).
  const backend = getPlatform().userdbBackend;
  void openUserDb({ locateWasm, admissionGate, ...(backend !== undefined ? { backend } : {}) })
    .then((result) => {
      if (result.status === 'ok') {
        userDbStatusStore.set({ state: 'ready' });
        resolveReady?.(result.userDb);
      } else if (result.status === 'corrupt') {
        corruptResult = result;
        userDbStatusStore.set({ state: 'corrupt', quarantinedFile: result.quarantinedFile, message: result.message });
      } else {
        userDbStatusStore.set({ state: 'unsupported', foundVersion: result.foundVersion, message: result.message });
      }
    })
    .catch((err: unknown) => {
      // A REJECTION (not a typed result): the file backend refused torn/magic-less
      // bytes. Fail loud and honest — the file was not overwritten, and only an
      // explicit retry attempts the open again.
      const message = err instanceof Error ? err.message : String(err);
      const path = /stored file "([^"]+)"/.exec(message)?.[1];
      userDbStatusStore.set({ state: 'load-failed', message, ...(path !== undefined ? { path } : {}) });
    });
}

/** Kick off the one-time open. Safe to call repeatedly; only the first call opens. */
export function bootUserDb(): Promise<UserDb> {
  const ready = ensureReadyPromise();
  if (opened) return ready;
  opened = true;
  attemptOpen();
  return ready;
}

/**
 * Explicit user action from the load-failed screen ("try again"): re-attempt the SAME
 * open — same backend, same guards. The pending `getUserDb()` promise is preserved so
 * every waiter resolves the moment an attempt finally succeeds.
 */
export function retryUserDbBoot(): void {
  if (userDbStatusStore.get().state !== 'load-failed') return;
  userDbStatusStore.set({ state: 'opening' });
  attemptOpen();
}

/** Resolves when the user DB is usable. Never resolves while status is corrupt/unsupported. */
export function getUserDb(): Promise<UserDb> {
  return bootUserDb();
}

/** Explicit recovery decision (F6): start fresh; the quarantined copy stays on disk. */
export async function recoverFresh(): Promise<UserDb> {
  if (corruptResult === undefined) throw new Error('recoverFresh: user DB is not in the corrupt state');
  const fresh = await corruptResult.openFresh();
  corruptResult = undefined;
  userDbStatusStore.set({ state: 'ready' });
  resolveReady?.(fresh);
  return fresh;
}

export function useUserDbStatus(): UserDbStatus {
  return useStore(userDbStatusStore);
}

/** Test seam: install a pre-opened (memory-backed) instance and mark ready. */
export function setUserDbForTests(db: UserDb): void {
  opened = true;
  corruptResult = undefined;
  ensureReadyPromise();
  userDbStatusStore.set({ state: 'ready' });
  resolveReady?.(db);
}

/** Test seam: reset module state between tests. */
export function resetUserDbForTests(): void {
  opened = false;
  corruptResult = undefined;
  readyPromise = undefined;
  resolveReady = undefined;
  userDbStatusStore.set({ state: 'opening' });
}
