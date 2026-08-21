// mode.ts — execution mode + provider/model settings, backed by the USER DB (ADR-0007/0008).
//
// Modes: 'byok' (browser-direct frontier API, user's key), 'local' (browser-direct
// OpenAI-compatible localhost endpoint), 'subscription' (hub server /invoke — the one
// opt-in server path). Serverless-first: the default is byok+mock so the whole flow
// works with zero backend and zero keys.
//
// SECURITY (AC5, F14): BYOK keys live in the user DB's snug_secrets table ONLY — never
// localStorage, never sessionStorage, never a cookie, never any request to the hub
// (secrets are stripped from hub-origin sync pushes and default exports). This is a
// deliberate, documented weakening vs v1's dies-with-the-tab sessionStorage key,
// accepted for portability; unit tests pin the browser-storage negatives.
//
// F15: endpoint/provider settings arriving via import or first pull are executable
// config — transports refuse byok/local turns until the user re-confirms them.

import { LOCAL_DEFAULT_BASE_URL } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';

import { getPlatform } from '../platform/platform.js';
// NOTE: appModel.ts imports `modelStore` from THIS module, so this is a cycle. It is
// safe because neither side touches the other at module-evaluation time — the imports
// are only dereferenced inside functions (`hydrateAppModels` here,
// `resolveModelForApp` there), by which point both modules are fully initialized.
import { hydrateAppModels } from './appModel.js';
import { ollamaStore } from './ollama.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

export type PlaygroundMode = 'subscription' | 'byok' | 'local';
export type ByokProvider = 'mock' | 'anthropic' | 'openai';

/** snug_secrets key prefix for BYOK keys: `byok:anthropic`, `byok:openai`. */
export const SECRET_KEY_PREFIX = 'byok:';

const SETTING_MODE = 'mode';
const SETTING_PROVIDER = 'provider';
const SETTING_MODEL = 'model';
const SETTING_LOCAL_URL = 'localUrl';
const SETTING_NEEDS_CONFIRM = 'needsEndpointConfirm';
/**
 * TASK-20260821 (AC9): the user's EXPLICIT default-provider pick. Absence means the
 * default DERIVES from key presence (anthropic > openai > demo brain). The legacy
 * `provider` row is kept as a synced twin so an old build opening a roaming file still
 * reads a sensible active provider; it is adopted into this row once at hydrate and
 * never deleted.
 */
const SETTING_PROVIDER_CHOICE = 'providerChoice';
/** `providerModel:<provider>` — the default model for ONE keyed provider (AC8/AC11). */
const providerModelSettingKey = (provider: KeyedProvider): string => `providerModel:${provider}`;

/** The two providers a BYOK key can exist for — `mock` is the demo brain and has none. */
export type KeyedProvider = 'anthropic' | 'openai';
export const KEYED_PROVIDERS: readonly KeyedProvider[] = ['anthropic', 'openai'];

export const modeStore = createStore<PlaygroundMode>('byok');
/**
 * True after hydration coerced a stored 'subscription' mode on a platform without the
 * capability (TASK-20260812 P3 item 2). The ACTIVE mode moved; the STORED setting did
 * not — a re-export carries the user's original choice. Session-local: dismissing the
 * note never writes anything.
 */
export const modeCoercedStore = createStore<boolean>(false);
/**
 * The RESOLVED default provider (TASK-20260821): explicit choice → derived from key
 * presence. Kept as the same store every consumer has always read — transport, wizard,
 * inspector — so the multi-key rework changes what feeds it, never who reads it.
 */
export const providerStore = createStore<ByokProvider>('mock');
/** The explicit pick behind the resolution, or undefined when the default is derived. */
export const providerChoiceStore = createStore<ByokProvider | undefined>(undefined);
/**
 * Which providers have a saved key — SYNCHRONOUS, because a `<select>` deciding which
 * groups to render cannot await `getByokKey`. Hydrated with settings, updated by
 * `setByokKey`.
 */
export const byokKeyPresenceStore = createStore<Record<KeyedProvider, boolean>>({
  anthropic: false,
  openai: false,
});
/** Per-provider default models. Absent = the adapter's own default, live. */
export const providerModelsStore = createStore<Partial<Record<KeyedProvider, string>>>({});
export const modelStore = createStore<string | undefined>(undefined);
export const localUrlStore = createStore<string>(LOCAL_DEFAULT_BASE_URL);
export const endpointsNeedConfirmStore = createStore<boolean>(false);

const isMode = (v: unknown): v is PlaygroundMode => v === 'subscription' || v === 'byok' || v === 'local';

/**
 * Modes the current platform offers (TASK-20260812 Decision 10): the desktop shell is
 * BYOK/local only — subscription is a capability the platform declares, never a flag
 * the picker could re-enable.
 */
export function availableModes(): PlaygroundMode[] {
  return getPlatform().capabilities.subscriptionMode ? ['byok', 'local', 'subscription'] : ['byok', 'local'];
}
const isProvider = (v: unknown): v is ByokProvider => v === 'mock' || v === 'anthropic' || v === 'openai';
const isKeyedProvider = (v: unknown): v is KeyedProvider => v === 'anthropic' || v === 'openai';

/**
 * THE default-provider resolution (TASK-20260821 AC9), in one place:
 *
 *   explicit choice (honored UNCONDITIONALLY — the UI only offers keyed providers, and
 *   silently re-routing a stale choice to a different provider would send the user's
 *   data somewhere they did not pick)  →  anthropic if its key exists  →  openai if its
 *   key exists  →  the demo brain.
 */
export function resolveDefaultProvider(): ByokProvider {
  const choice = providerChoiceStore.get();
  if (choice !== undefined) return choice;
  const keys = byokKeyPresenceStore.get();
  if (keys.anthropic) return 'anthropic';
  if (keys.openai) return 'openai';
  return 'mock';
}

/** Re-derive `providerStore` after anything that feeds the resolution changed. */
function refreshResolvedProvider(): void {
  providerStore.set(resolveDefaultProvider());
}

/** Load settings from an opened user DB into the stores (boot, and after import/pull). */
export function hydrateSettings(db: UserDb): void {
  const mode = db.getSetting(SETTING_MODE);
  if (isMode(mode)) {
    if (mode === 'subscription' && !getPlatform().capabilities.subscriptionMode) {
      // W2b coercion: a file carrying the web's subscription mode must not dead-end
      // here. The ACTIVE mode becomes the best this platform offers — local when the
      // Ollama probe found a running install, byok otherwise — and the stored setting
      // is deliberately NOT rewritten: modeStore.set, never setMode. The note store
      // makes the divergence visible instead of silent.
      const ollama = ollamaStore.get();
      modeStore.set(ollama !== 'unknown' && ollama.running ? 'local' : 'byok');
      modeCoercedStore.set(true);
    } else {
      modeStore.set(mode);
    }
  }
  // Key presence BEFORE the provider resolution — the derivation reads it.
  byokKeyPresenceStore.set({
    anthropic: db.getSecret(`${SECRET_KEY_PREFIX}anthropic`) !== undefined,
    openai: db.getSecret(`${SECRET_KEY_PREFIX}openai`) !== undefined,
  });
  // The explicit choice; a legacy file's `provider` row ADOPTS FORWARD into it once
  // (review finding 6): that row was written only by a user act under the old UI, and
  // without adoption the derivation would silently flip an openai-choosing user to
  // anthropic the day this code ships. Write-once, never deleting the legacy row —
  // an old build opening this roaming file still reads it.
  const storedChoice = db.getSetting(SETTING_PROVIDER_CHOICE);
  const legacyProvider = db.getSetting(SETTING_PROVIDER);
  if (isProvider(storedChoice)) {
    providerChoiceStore.set(storedChoice);
  } else if (isProvider(legacyProvider)) {
    providerChoiceStore.set(legacyProvider);
    db.setSetting(SETTING_PROVIDER_CHOICE, legacyProvider);
  } else {
    providerChoiceStore.set(undefined);
  }
  const model = db.getSetting(SETTING_MODEL);
  modelStore.set(typeof model === 'string' && model !== '' ? model : undefined);
  // Per-provider default models, with the legacy byok `model` row adopted into the
  // resolved provider's row once (AC11). LOCAL files are excluded on purpose: their
  // `model` row names an Ollama model, and adopting it would hand `llama3.2` to a
  // frontier adapter the first time the user tries byok.
  const providerModels: Partial<Record<KeyedProvider, string>> = {};
  for (const keyed of KEYED_PROVIDERS) {
    const stored = db.getSetting(providerModelSettingKey(keyed));
    if (typeof stored === 'string' && stored !== '') providerModels[keyed] = stored;
  }
  refreshResolvedProvider();
  const resolved = providerStore.get();
  const storedMode = db.getSetting(SETTING_MODE);
  if (
    // Absent mode row = byok, the default this store boots with.
    (storedMode === 'byok' || storedMode === undefined) &&
    isKeyedProvider(resolved) &&
    providerModels[resolved] === undefined &&
    typeof model === 'string' &&
    model !== ''
  ) {
    providerModels[resolved] = model;
    db.setSetting(providerModelSettingKey(resolved), model);
  }
  providerModelsStore.set(providerModels);
  const localUrl = db.getSetting(SETTING_LOCAL_URL);
  localUrlStore.set(typeof localUrl === 'string' && localUrl !== '' ? localUrl : LOCAL_DEFAULT_BASE_URL);
  endpointsNeedConfirmStore.set(db.getSetting(SETTING_NEEDS_CONFIRM) === true);
  // Per-app model picks ride the same hydration path as the global settings above, so a
  // boot, an import and a first sync pull all restore them (TASK-20260817). They are NOT
  // gated by the F15 `needsEndpointConfirm` flag: that gate exists for executable
  // ENDPOINT config arriving in foreign bytes, and a model id names a model AT an
  // endpoint the user has already confirmed (ADR-0036 D3).
  hydrateAppModels(db);
}

/** Boot hook: hydrate once the user DB opens. */
export async function initSettings(): Promise<void> {
  hydrateSettings(await getUserDb());
}

function writeSetting(key: string, value: unknown): void {
  void getUserDb().then((db) => db.setSetting(key, value));
}

export function setMode(mode: PlaygroundMode): void {
  modeStore.set(mode);
  writeSetting(SETTING_MODE, mode);
}

/**
 * The user's EXPLICIT default-provider pick (TASK-20260821 AC9). Writes the choice row
 * AND the legacy `provider` row (the synced twin an old build reads), then re-resolves.
 */
export function setProvider(provider: ByokProvider): void {
  providerChoiceStore.set(provider);
  writeSetting(SETTING_PROVIDER_CHOICE, provider);
  writeSetting(SETTING_PROVIDER, provider);
  refreshResolvedProvider();
}

/** The default model for one keyed provider; clearing deletes the row (absence = adapter default). */
export function setProviderModel(provider: KeyedProvider, model: string | undefined): void {
  const trimmed = model?.trim();
  const cleared = trimmed === undefined || trimmed === '';
  const next = { ...providerModelsStore.get() };
  if (cleared) delete next[provider];
  else next[provider] = trimmed;
  providerModelsStore.set(next);
  void getUserDb().then((db) => {
    if (cleared) db.deleteSetting(providerModelSettingKey(provider));
    else db.setSetting(providerModelSettingKey(provider), trimmed);
  });
}

export function setModel(model: string): void {
  const trimmed = model.trim();
  modelStore.set(trimmed === '' ? undefined : trimmed);
  writeSetting(SETTING_MODEL, trimmed);
}

export function setLocalUrl(url: string): void {
  const trimmed = url.trim();
  localUrlStore.set(trimmed === '' ? LOCAL_DEFAULT_BASE_URL : trimmed);
  writeSetting(SETTING_LOCAL_URL, trimmed);
}

/** Store (or clear, on empty input) the BYOK key for one provider — snug_secrets only. */
export async function setByokKey(provider: ByokProvider, key: string): Promise<void> {
  const db = await getUserDb();
  const trimmed = key.trim();
  if (trimmed === '') {
    db.deleteSecret(`${SECRET_KEY_PREFIX}${provider}`);
  } else {
    db.setSecret(`${SECRET_KEY_PREFIX}${provider}`, trimmed);
  }
  // Presence feeds the default-provider derivation (AC9) — update it and re-resolve,
  // so adding the first key flips the demo brain to a real provider without a reload.
  if (provider === 'anthropic' || provider === 'openai') {
    byokKeyPresenceStore.set({ ...byokKeyPresenceStore.get(), [provider]: trimmed !== '' });
    refreshResolvedProvider();
  }
}

export async function getByokKey(provider: ByokProvider): Promise<string | undefined> {
  const db = await getUserDb();
  return db.getSecret(`${SECRET_KEY_PREFIX}${provider}`);
}

/** F15: called when foreign bytes become the local DB (import, first pull). */
export function markEndpointsNeedConfirm(): void {
  endpointsNeedConfirmStore.set(true);
  writeSetting(SETTING_NEEDS_CONFIRM, true);
}

/** F15: the explicit user re-confirmation that re-arms byok/local transports. */
export function confirmEndpoints(): void {
  endpointsNeedConfirmStore.set(false);
  writeSetting(SETTING_NEEDS_CONFIRM, false);
}

export function useMode(): PlaygroundMode {
  return useStore(modeStore);
}

export function useProvider(): ByokProvider {
  return useStore(providerStore);
}

export function useProviderChoice(): ByokProvider | undefined {
  return useStore(providerChoiceStore);
}

export function useByokKeyPresence(): Record<KeyedProvider, boolean> {
  return useStore(byokKeyPresenceStore);
}

export function useProviderModels(): Partial<Record<KeyedProvider, string>> {
  return useStore(providerModelsStore);
}

export function useModel(): string | undefined {
  return useStore(modelStore);
}

export function useLocalUrl(): string {
  return useStore(localUrlStore);
}

export function useEndpointsNeedConfirm(): boolean {
  return useStore(endpointsNeedConfirmStore);
}

/** Session-local: the divergence remains in the file, so nothing is written. */
export function dismissModeCoercionNote(): void {
  modeCoercedStore.set(false);
}

export function useModeCoerced(): boolean {
  return useStore(modeCoercedStore);
}
