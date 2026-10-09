// platform/signals.ts — what a host tells the UI AFTER boot (TASK-20261003, ADR-0072 §3).
//
// The platform is set once, before React boots, so nothing on it can be swapped later — yet
// a host learns things late: the runner's brain probe answers after the page is up, an agent
// hands an app in while the hub is open, a measured prompt cap changes what the builder may
// send. Until this module those facts were announced with DOM `CustomEvent`s that nothing
// listened to (found 2026-10-03), so the chip kept its boot label and a handed-in app did not
// appear until a reload.
//
// These are counters, not payloads: a bump says "re-read your source of truth" (the platform's
// getters, the library), never "here is the new value". One source of truth per fact stays the
// rule (ADR-0059 rule 2 — no parallel UI state).

import { createStore } from '../state/store.js';
import { useStore } from '../state/store.js';

/** Bumped when what `getPlatform().brain` / `.brainSwitch` would answer has changed. */
export const brainRevisionStore = createStore(0);
/** Bumped when the user's library changed underneath the UI (an agent hand-in landed). */
export const libraryRevisionStore = createStore(0);
/**
 * Bumped when the schedules or their runs changed underneath the UI (TASK-20261009 C7,
 * ADR-0074 §5): a sync pull landed rows, a reconcile wrote candidates, a run finished. The
 * engine re-reads the file on it; so does every view that lists schedules or results.
 */
export const scheduleRevisionStore = createStore(0);

export function bumpBrainRevision(): void {
  brainRevisionStore.set(brainRevisionStore.get() + 1);
}

export function bumpLibraryRevision(): void {
  libraryRevisionStore.set(libraryRevisionStore.get() + 1);
}

export function bumpScheduleRevision(): void {
  scheduleRevisionStore.set(scheduleRevisionStore.get() + 1);
}

export function useBrainRevision(): number {
  return useStore(brainRevisionStore);
}

export function useLibraryRevision(): number {
  return useStore(libraryRevisionStore);
}

export function useScheduleRevision(): number {
  return useStore(scheduleRevisionStore);
}
