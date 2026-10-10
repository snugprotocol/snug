// The open-url confirm seat (ADR-0038 D5, TASK-20260818 Phase C).
//
// An app can REQUEST that the host open an https URL; this store parks exactly one
// pending request for the dialog to render, and the dialog's buttons resolve it. The
// runner already enforces single-pending per instance — the store's null-or-one shape
// is the same fact at the UI altitude, so a second request can never stack a second
// dialog.
//
// THE GESTURE RULE lives in the DIALOG, not here: 'opened' may only be resolved from a
// click handler that has ALREADY opened the window synchronously (popup-blocker
// escape), which is why this module exposes no "open" function — there is nothing an
// effect or a timer could call.
//
// THE SEAT CLOSES DURING A DELEGATED RUN (TASK-20261010-host-broker PR-1; ADR-0077 §3; Gate-5
// F-1). While a run the user did not start is in flight on the open app, `open` answers
// `'declined'` at once and parks nothing — hidden-frame parity: a hidden frame composes no
// open-url seat at all, and a timer-fired handler must not be able to put a "open this URL?"
// dialog in front of the user as if they had clicked for it. The run is read PER CALL from
// `schedule/runPlacement.ts`, a leaf (`state/store.ts`, `state/appHosts.ts`, `schedule/copy.ts`),
// so the import is cycle-safe.

import { delegatedRunFor } from '../schedule/runPlacement.js';
import { createStore } from './store.js';

export interface PendingOpenUrl {
  /** The HOST-assigned app id (display only — provenance for the dialog copy). */
  appId: string;
  url: string;
  resolve: (outcome: 'opened' | 'declined') => void;
}

export const openUrlConfirmStore = createStore<PendingOpenUrl | null>(null);

/**
 * The RunView-bound handler factory (mirrors `createNetHandlerFor`'s shape): the id is
 * HOST-assigned at bind time, never app-claimed. Starters never get one — the
 * capability flag stays false on the read-only route.
 */
export function createOpenUrlHandlerFor(appId: string): { open(url: string): Promise<'opened' | 'declined'> } {
  return {
    open(url: string): Promise<'opened' | 'declined'> {
      // A delegated run owns the app right now: the seat is closed, as it is on a hidden frame.
      if (delegatedRunFor(appId) !== undefined) return Promise.resolve('declined');
      return new Promise((resolve) => {
        // Belt to the runner's single-pending brace: a stale parked entry (its frame
        // already answered `refused`) is declined rather than leaked.
        const stale = openUrlConfirmStore.get();
        if (stale !== null) stale.resolve('declined');
        openUrlConfirmStore.set({ appId, url, resolve });
      });
    },
  };
}

/** The dialog's ONE exit: clears the store first so a re-render cannot double-resolve. */
export function resolveOpenUrlConfirm(outcome: 'opened' | 'declined'): void {
  const pending = openUrlConfirmStore.get();
  openUrlConfirmStore.set(null);
  pending?.resolve(outcome);
}
