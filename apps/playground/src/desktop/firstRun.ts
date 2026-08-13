// firstRun.ts — the desktop first-run latch (TASK-20260812 P3 item 1).
//
// The welcome shows exactly when three things are true at boot: the platform is the
// desktop shell, the user file has never had a mode chosen, and the welcome was never
// explicitly dismissed. Both exits persist INTO THE USER FILE (not localStorage —
// the file is the identity, and a reinstalled app must not re-welcome a veteran file):
// choosing a mode persists `mode` via setMode, skipping persists the dismissal.
// On web this module is inert: the store stays false and nothing is read or written.

import { getPlatform } from '../platform/platform.js';
import { createStore, useStore, type Store } from '../state/store.js';
import { getUserDb } from '../state/userdb.js';

/** Settings key for the explicit "I'll look around first" dismissal. */
const SETTING_WELCOME_DONE = 'desktopWelcomeDone';

export const desktopFirstRunStore: Store<boolean> = createStore<boolean>(false);

/** Boot hook (App effect, after settings hydrate). No-op on web. */
export async function initDesktopFirstRun(): Promise<void> {
  if (getPlatform().kind !== 'desktop') return;
  const db = await getUserDb();
  const modeChosen = db.getSetting('mode') !== undefined;
  const dismissed = db.getSetting(SETTING_WELCOME_DONE) === true;
  desktopFirstRunStore.set(!modeChosen && !dismissed);
}

/** Any exit from the welcome — a mode choice or the skip — lands here. */
export function completeDesktopFirstRun(): void {
  desktopFirstRunStore.set(false);
  void getUserDb().then((db) => db.setSetting(SETTING_WELCOME_DONE, true));
}

export function useDesktopFirstRun(): boolean {
  return useStore(desktopFirstRunStore);
}
