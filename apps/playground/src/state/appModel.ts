// appModel.ts — the per-app model AND provider choice (TASK-20260817 ADR-0036 +
// TASK-20260821 multi-provider BYOK).
//
// Precedence, in exactly one place each:
//
//   resolveModelForApp:    the app's pick → the default for the provider the app
//                          resolves to (byok) / the global `model` setting (local,
//                          subscription) → undefined ("let the adapter decide").
//   resolveProviderForApp: the app's provider pin → the RESOLVED default provider.
//
// A PIN IS A PIN (plan review 2026-08-21, finding 10): picking any model in the
// selector stores BOTH rows — `appModel:<appId>` and `appProvider:<appId>` — because a
// model row without its provider would strand a foreign model id on whatever the
// default provider later becomes (an openai adapter handed `claude-*`). Only
// INHERITING is an absence: clearing back to "default" deletes both rows, and an
// un-pinned app follows every later change to the Settings default, live.
//
// A provider pin is honored UNCONDITIONALLY, like the explicit default choice: a pin
// whose key was deleted routes keyless (and fails visibly at the provider) rather than
// silently re-routing the app's data to a provider the user did not pick for it. The
// selector shows the missing-key state instead of hiding it.
//
// Storage is the namespaced-key pattern of ADR-0036 D2 (`app-settings-keys.ts` is the
// one key contract; `deleteApp` cascades both rows; `app-provider-setting.test.ts`
// mutation-checks the cascade).

import type { UserDb } from '@snugprotocol/db';

import { byokKeyPresenceStore, modeStore, modelStore, providerModelsStore, providerStore, type ByokProvider } from './mode.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

/** `{ [appId]: modelId }` for apps that have PINNED a model. Inheriting apps are absent. */
export const appModelStore = createStore<Record<string, string>>({});
/** `{ [appId]: provider }` for the same pins — written together with the model row. */
export const appProviderStore = createStore<Record<string, string>>({});

/**
 * Load every stored pick from an opened user DB. Called from `hydrateSettings` so a
 * boot, an import and a first sync pull all rehydrate through the same path — the picks
 * travel with the portable file exactly as `mode`/`provider`/`model` do.
 */
export function hydrateAppModels(db: UserDb): void {
  appModelStore.set(db.listAppModels());
  appProviderStore.set(db.listAppProviders());
}

/**
 * Pin `appId` to a provider+model, or clear the pin with `undefined` so the app
 * inherits again. Store updates are synchronous, DB writes async — the selector must
 * reflect the click immediately (the write-through shape `setModel` uses).
 */
export function setAppPin(appId: string, pick: { provider: ByokProvider; model: string } | undefined): void {
  const models = { ...appModelStore.get() };
  const providers = { ...appProviderStore.get() };
  const model = pick?.model.trim();
  if (pick === undefined || model === undefined || model === '') {
    delete models[appId];
    delete providers[appId];
  } else {
    models[appId] = model;
    providers[appId] = pick.provider;
  }
  appModelStore.set(models);
  appProviderStore.set(providers);
  void getUserDb().then((db) => {
    db.setAppModel(appId, pick === undefined ? undefined : model);
    db.setAppProvider(appId, pick?.provider);
  });
}

/**
 * LOCAL-mode pin: model only, no provider row — a local endpoint has no provider
 * concept, and writing one would make the pin claim a byok routing it never had.
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
 * The app's pinned provider when one is stored AND names a real catalog provider —
 * `undefined` means "follows the default". A corrupted row reads as inheriting.
 */
export function appProviderPinFor(appId: string): ByokProvider | undefined {
  const pinned = appProviderStore.get()[appId];
  return pinned === 'anthropic' || pinned === 'openai' || pinned === 'mock' ? pinned : undefined;
}

/** THE provider resolution for an app-scoped lane: pin → resolved default. */
export function resolveProviderForApp(appId?: string): ByokProvider {
  if (appId !== undefined) {
    const pinned = appProviderPinFor(appId);
    if (pinned !== undefined) return pinned;
  }
  return providerStore.get();
}

/**
 * THE model resolution. Every app-scoped lane calls this instead of reading the stores
 * directly, so the precedence rule cannot fork across the call sites.
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
  if (modeStore.get() === 'byok') {
    // The default for the provider this app RESOLVES to (TASK-20260821 AC9). The demo
    // brain names no model; absence means the adapter's own default, as it always has.
    const provider = resolveProviderForApp(appId);
    if (provider === 'anthropic' || provider === 'openai') return providerModelsStore.get()[provider];
    return undefined;
  }
  // Local and subscription keep the global `model` setting (review finding 9): an
  // Ollama pick or a subscription override is not a per-provider fact.
  return modelStore.get();
}

/** The app's OWN pick, or `undefined` when it inherits — for rendering the selector. */
export function useAppModel(appId: string): string | undefined {
  return useStore(appModelStore)[appId];
}

/** The app's OWN provider pin, or `undefined` when it follows the default. */
export function useAppProvider(appId: string): string | undefined {
  return useStore(appProviderStore)[appId];
}

/** Is the pinned provider's key gone? The selector renders this instead of hiding it. */
export function appPinMissingKey(appId: string): boolean {
  const pinned = appProviderPinFor(appId);
  if (pinned === undefined || pinned === 'mock') return false;
  return !byokKeyPresenceStore.get()[pinned];
}
