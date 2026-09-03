// buildThread.ts — which thread the build page is showing (TASK-20260903, ADR-0062).
//
// Per tab, best-effort: the id is mirrored into sessionStorage under the same key the
// builder has always used, so an existing tab keeps its thread across this change and a
// reload lands on the same conversation. The sidebar's selection and "+ new" write here;
// the hub's create bar mints a FRESH thread here (D2) — before this, an idea typed on
// "your apps" continued whatever thread the tab held, and silently became an EDIT of the
// app that thread was pinned to.

import { createStore, useStore } from './store.js';

export const BUILD_THREAD_KEY = 'snug:thread';

export function mintThreadId(): string {
  return `thr-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function readInitial(): string {
  try {
    const existing = sessionStorage.getItem(BUILD_THREAD_KEY);
    if (existing !== null && existing !== '') return existing;
  } catch {
    /* storage unavailable — a minted id serves this page load */
  }
  const minted = mintThreadId();
  try {
    sessionStorage.setItem(BUILD_THREAD_KEY, minted);
  } catch {
    /* per-tab continuity is best-effort */
  }
  return minted;
}

export const activeBuildThreadStore = createStore<string>(readInitial());

export function useActiveBuildThread(): string {
  return useStore(activeBuildThreadStore);
}

export function setActiveBuildThread(threadId: string): void {
  try {
    sessionStorage.setItem(BUILD_THREAD_KEY, threadId);
  } catch {
    /* per-tab continuity is best-effort */
  }
  activeBuildThreadStore.set(threadId);
}

/** Mint a fresh thread and make it the build page's thread. Returns the id. */
export function mintBuildThread(): string {
  const minted = mintThreadId();
  setActiveBuildThread(minted);
  return minted;
}
