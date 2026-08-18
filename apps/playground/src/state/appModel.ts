// appModel.ts — the per-app model choice (TASK-20260817, ADR-0036).
//
// The global `model` setting (mode.ts) is ONE value applied to every app in every lane.
// Apps differ in what they need — a data-heavy analysis app wants a frontier model, a
// small utility wants something cheap and fast — so each app may PIN its own, and every
// app-scoped LLM call for that app routes there.
//
// The precedence rule lives in exactly one function, `resolveModelForApp`:
//
//     the app's pick  →  the Settings default  →  undefined
//
// The tail is deliberate. `undefined` means "let the provider decide": the adapters
// apply their own `ANTHROPIC_DEFAULT_MODEL` / `OPENAI_DEFAULT_MODEL` when `options.model`
// is absent, which is what an empty Settings model field has always meant. Substituting
// a hardcoded id here would move that decision out of the adapter layer and silently
// change behavior for every existing user who left the field blank.
//
// INHERITANCE IS AN ABSENCE, NOT A COPY (owner decision, AC3). An app that has never
// been picked-for stores no row, so a later change to the Settings default reaches it.
// The alternative — copying the default into each app on first open — would freeze every
// app at whatever the default happened to be the first time it was opened, and the user
// would have no way to tell a pinned app from an inherited one.
//
// Storage is a namespaced key in the existing `snug_settings` KV, keyed by the shared
// `appModelSettingKey` contract in packages/db (ADR-0036 D2): no schema bump, no
// migration. Its one price is that `deleteApp`'s cascade must know the key — it does
// (step 3c), and `app-model-setting.test.ts` mutation-checks that it still does.

import type { UserDb } from '@snugprotocol/db';

import { modelStore } from './mode.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

/** `{ [appId]: modelId }` for apps that have PINNED a model. Inheriting apps are absent. */
export const appModelStore = createStore<Record<string, string>>({});

/**
 * Load every stored pick from an opened user DB. Called from `hydrateSettings` so a
 * boot, an import and a first sync pull all rehydrate through the same path — the picks
 * travel with the portable file exactly as `mode`/`provider`/`model` do.
 */
export function hydrateAppModels(db: UserDb): void {
  appModelStore.set(db.listAppModels());
}

/**
 * Pin `appId` to `model`, or clear the pin with `undefined` so the app inherits again.
 *
 * The store is updated synchronously and the DB write is fired async, matching the
 * write-through shape `setModel`/`setProvider` already use: the selector must reflect
 * the click immediately, and a persistence failure must not leave the UI wedged.
 */
export function setAppModel(appId: string, model: string | undefined): void {
  const trimmed = model?.trim();
  const next = { ...appModelStore.get() };
  if (trimmed === undefined || trimmed === '') delete next[appId];
  else next[appId] = trimmed;
  appModelStore.set(next);
  void getUserDb().then((db) => db.setAppModel(appId, trimmed));
}

/**
 * THE resolution. Every app-scoped lane calls this instead of reading `modelStore`
 * directly, so the precedence rule cannot fork across the four call sites.
 *
 * `appId` is optional because not every LLM turn belongs to an app (a fresh build thread
 * before an app exists, a non-app-scoped inference): those resolve to the Settings
 * default, which is the pre-existing behavior byte-for-byte.
 *
 * MUST be called per send, never captured at construction — RunView memoizes its
 * transport, so a value read once would freeze the app on the model it had when the view
 * mounted, and a mid-session switch would appear to do nothing until a reload.
 */
export function resolveModelForApp(appId?: string): string | undefined {
  if (appId !== undefined) {
    const pinned = appModelStore.get()[appId];
    if (pinned !== undefined && pinned !== '') return pinned;
  }
  return modelStore.get();
}

/** The app's OWN pick, or `undefined` when it inherits — for rendering the selector. */
export function useAppModel(appId: string): string | undefined {
  return useStore(appModelStore)[appId];
}
