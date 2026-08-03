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

export const modeStore = createStore<PlaygroundMode>('byok');
export const providerStore = createStore<ByokProvider>('mock');
export const modelStore = createStore<string | undefined>(undefined);
export const localUrlStore = createStore<string>(LOCAL_DEFAULT_BASE_URL);
export const endpointsNeedConfirmStore = createStore<boolean>(false);

const isMode = (v: unknown): v is PlaygroundMode => v === 'subscription' || v === 'byok' || v === 'local';
const isProvider = (v: unknown): v is ByokProvider => v === 'mock' || v === 'anthropic' || v === 'openai';

/** Load settings from an opened user DB into the stores (boot, and after import/pull). */
export function hydrateSettings(db: UserDb): void {
  const mode = db.getSetting(SETTING_MODE);
  if (isMode(mode)) modeStore.set(mode);
  const provider = db.getSetting(SETTING_PROVIDER);
  if (isProvider(provider)) providerStore.set(provider);
  const model = db.getSetting(SETTING_MODEL);
  modelStore.set(typeof model === 'string' && model !== '' ? model : undefined);
  const localUrl = db.getSetting(SETTING_LOCAL_URL);
  localUrlStore.set(typeof localUrl === 'string' && localUrl !== '' ? localUrl : LOCAL_DEFAULT_BASE_URL);
  endpointsNeedConfirmStore.set(db.getSetting(SETTING_NEEDS_CONFIRM) === true);
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

export function setProvider(provider: ByokProvider): void {
  providerStore.set(provider);
  writeSetting(SETTING_PROVIDER, provider);
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
    return;
  }
  db.setSecret(`${SECRET_KEY_PREFIX}${provider}`, trimmed);
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

export function useModel(): string | undefined {
  return useStore(modelStore);
}

export function useLocalUrl(): string {
  return useStore(localUrlStore);
}

export function useEndpointsNeedConfirm(): boolean {
  return useStore(endpointsNeedConfirmStore);
}
