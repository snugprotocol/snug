// appModel.ts — the per-app model AND provider choice (TASK-20260817 ADR-0036 +
// TASK-20260821 multi-provider BYOK).
//
// Precedence, in exactly one place each:
//
//   resolveModelForApp:    the app's pick, when its family matches the mode (below) → the
//                          default for the provider the app resolves to (byok) / the plan's
//                          own `providerModel:chatgpt` row (chatgpt) / the global `model`
//                          setting (local, subscription) → undefined ("let the adapter decide").
//   resolveProviderForApp: the app's BYOK provider pin → the RESOLVED default provider.
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
//
// A PIN HAS A FAMILY (TASK-20261023-siwc-chatgpt-plan, ADR-0078 §6 — an amendment to ADR-0036/0046;
// plan §11 L4-4 as amended). The family is read from the provider row: `chatgpt` → the ChatGPT plan;
// `anthropic|openai|mock` → byok; NO provider row → unscoped (today's `setAppModel` shape for local
// pins, and every BYOK pin written before TASK-20260821 added the provider row). A pin routes only in
// a mode of its family: a chatgpt pin only in chatgpt mode, a provider pin only in byok, an unscoped
// pin in byok and local (today's behaviour, kept). So a `claude-…` pin is never sent to the plan, a
// `gpt-6…` plan pin is never sent to Anthropic — and a `gpt-4o` pin WITH a provider row no longer
// reaches Ollama (the cross-pin ADR-0078 §6 corrects). A pin from another family is ignored for
// routing and REPORTED by `appPinFamily`, so the selectors can say "pinned for <mode> — not used here"
// instead of hiding it. Subscription keeps today's mode-blind pin: the hub decides there.

import type { UserDb } from '@snugprotocol/db';

import {
  byokKeyPresenceStore,
  chatgptModelStore,
  modeStore,
  modelStore,
  providerModelsStore,
  providerStore,
  type ByokProvider,
  type PlaygroundMode,
} from './mode.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

/** What an `appProvider:<appId>` row may name: a BYOK provider, or the ChatGPT plan. */
export type PinProvider = ByokProvider | 'chatgpt';

/** The mode family a pin was made for — `local` is the UNSCOPED family (no provider row; see the header). */
export type PinFamily = 'byok' | 'local' | 'chatgpt';

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
export function setAppPin(appId: string, pick: { provider: PinProvider; model: string } | undefined): void {
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
 * The app's pinned provider when one is stored AND names something real — a BYOK provider or the
 * ChatGPT plan; `undefined` means "follows the default". A corrupted row reads as inheriting.
 */
export function appProviderPinFor(appId: string): PinProvider | undefined {
  const pinned = appProviderStore.get()[appId];
  return pinned === 'anthropic' || pinned === 'openai' || pinned === 'mock' || pinned === 'chatgpt' ? pinned : undefined;
}

/**
 * The pin as a BYOK seat may read it — a chatgpt pin is NOT one (its family is another mode's), so
 * it reads as inheriting here. The byok send paths and the key-missing mark consult this, never a
 * `'chatgpt'` string a provider adapter would be handed.
 */
export function byokProviderPinFor(appId: string): ByokProvider | undefined {
  const pinned = appProviderPinFor(appId);
  return pinned === 'chatgpt' ? undefined : pinned;
}

/** The family of the app's pin, or `undefined` when it has none — see the header for the rule. */
export function appPinFamily(appId: string): PinFamily | undefined {
  const model = appModelStore.get()[appId];
  if (model === undefined || model === '') return undefined;
  const provider = appProviderStore.get()[appId];
  if (provider === 'chatgpt') return 'chatgpt';
  if (provider === 'anthropic' || provider === 'openai' || provider === 'mock') return 'byok';
  return 'local';
}

/** Whether a pin of `family` routes in `mode` — the one statement of the rule in the header. */
function pinApplies(family: PinFamily, mode: PlaygroundMode): boolean {
  switch (mode) {
    case 'chatgpt':
      return family === 'chatgpt';
    case 'byok':
      return family === 'byok' || family === 'local';
    case 'local':
      return family === 'local';
    case 'subscription':
      return true;
  }
}

/** THE provider resolution for an app-scoped lane: byok pin → resolved default. */
export function resolveProviderForApp(appId?: string): ByokProvider {
  if (appId !== undefined) {
    const pinned = byokProviderPinFor(appId);
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
  const mode = modeStore.get();
  if (appId !== undefined) {
    const family = appPinFamily(appId);
    if (family !== undefined && pinApplies(family, mode)) return appModelStore.get()[appId];
  }
  // The plan's default is its own row — NEVER the global `model` row below, which names an Ollama
  // or hub model. Absence means the account list's first model (the adapter arm's fallback).
  if (mode === 'chatgpt') return chatgptModelStore.get();
  if (mode === 'byok') {
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
  const pinned = byokProviderPinFor(appId);
  if (pinned === undefined || pinned === 'mock') return false;
  return !byokKeyPresenceStore.get()[pinned];
}
