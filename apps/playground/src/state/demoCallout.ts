// demoCallout.ts — the first-contact demo-brain callout latch (TASK-20260826,
// ADR-0059 rule 1).
//
// The firstRun.ts pattern with its OWN key (latches never share exits — the
// protection-offer lesson): the callout is eligible until the user explicitly
// dismisses it or leaves through its settings door, and the dismissal persists
// INTO THE USER FILE, because the file is the identity — a reinstalled app must
// not re-welcome a veteran file. Unlike the desktop welcome this runs on web AND
// desktop: whether the callout actually RENDERS is the component's decision
// (demo brain active + this latch), so a file that switched to a real brain
// simply never sees it, latch armed or not.

import { createStore, useStore, type Store } from './store.js';
import { getUserDb } from './userdb.js';

/** Settings key for the explicit dismissal. Own key, never shared with a welcome. */
const SETTING_DISMISSED = 'demoCalloutDismissed';

/** True = the callout is still owed to this file (never dismissed). */
export const demoCalloutStore: Store<boolean> = createStore<boolean>(false);

/** Boot hook (App effect, after settings hydrate — it reads the user file). */
export async function initDemoCallout(): Promise<void> {
  const db = await getUserDb();
  demoCalloutStore.set(db.getSetting(SETTING_DISMISSED) !== true);
}

/** Any exit — the dismiss button or the settings door — lands here. */
export function dismissDemoCallout(): void {
  demoCalloutStore.set(false);
  void getUserDb().then((db) => db.setSetting(SETTING_DISMISSED, true));
}

export function useDemoCallout(): boolean {
  return useStore(demoCalloutStore);
}
