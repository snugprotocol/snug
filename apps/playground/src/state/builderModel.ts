// builderModel.ts — the BUILD PAGE's model pick for a thread with no app yet
// (TASK-20260821 AC12).
//
// The run header's selector pins a model to an APP; a fresh build thread has no app to
// pin to until the first artifact installs. This store carries that pick in the
// meantime: SESSION-SCOPED on purpose (never persisted — there is no durable identity
// to hang it on; the thread id is per-tab), routing the build turns via useBuilderChat's
// agent memo, and TRANSFERRED to the new app as its pin the moment the install act
// mints an id — after which the ordinary per-app row is the one source of truth and
// this store clears.

import { setAppPin } from './appModel.js';
import type { ByokProvider } from './mode.js';
import { createStore, useStore } from './store.js';

export interface BuilderPick {
  provider: ByokProvider;
  model: string;
}

export const builderPickStore = createStore<BuilderPick | undefined>(undefined);

export function setBuilderPick(pick: BuilderPick | undefined): void {
  builderPickStore.set(pick);
}

export function useBuilderPick(): BuilderPick | undefined {
  return useStore(builderPickStore);
}

/**
 * The transfer: the freshly-installed app inherits the build thread's pick as ITS pin,
 * and the session store clears — from here the app row owns the choice. A no-op when
 * nothing was picked (the common case), so every install path may call it blindly.
 */
export function applyBuilderPickToApp(appId: string): void {
  const pick = builderPickStore.get();
  if (pick === undefined) return;
  setAppPin(appId, pick);
  builderPickStore.set(undefined);
}
