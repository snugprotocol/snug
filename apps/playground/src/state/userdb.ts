// userdb.ts — the page-wide user database (ADR-0007): opened once, shared by every
// view, injected into the runner as the db driver. Corruption NEVER fails open (F6):
// the UI surfaces 'corrupt' and recovery is an explicit user action (recoverFresh, or
// restore-from-origin once sync ships). Tests inject a memory-backed instance.

import { openUserDb, type OpenUserDbResult, type UserDb } from '@snugprotocol/db';
import { locateWasm } from '../run/wasm.js';
import { createStore, useStore } from './store.js';

export type UserDbStatus =
  | { state: 'opening' }
  | { state: 'ready' }
  | { state: 'corrupt'; quarantinedFile: string; message: string }
  | { state: 'unsupported'; foundVersion: number; message: string };

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

/** Kick off the one-time open. Safe to call repeatedly; only the first call opens. */
export function bootUserDb(): Promise<UserDb> {
  const ready = ensureReadyPromise();
  if (opened) return ready;
  opened = true;
  void openUserDb({ locateWasm }).then((result) => {
    if (result.status === 'ok') {
      userDbStatusStore.set({ state: 'ready' });
      resolveReady?.(result.userDb);
    } else if (result.status === 'corrupt') {
      corruptResult = result;
      userDbStatusStore.set({ state: 'corrupt', quarantinedFile: result.quarantinedFile, message: result.message });
    } else {
      userDbStatusStore.set({ state: 'unsupported', foundVersion: result.foundVersion, message: result.message });
    }
  });
  return ready;
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
