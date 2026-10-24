// mode.ts — execution mode + provider/model settings, backed by the USER DB (ADR-0007/0008).
//
// Modes: 'byok' (browser-direct frontier API, user's key), 'local' (browser-direct
// OpenAI-compatible localhost endpoint), 'subscription' (hub server /invoke — the one
// opt-in server path), 'chatgpt' (the user's own ChatGPT plan through a signed-in session
// the desktop shell keeps outside this file — TASK-20261023-siwc-chatgpt-plan, ADR-0078; offered
// only where the platform carries the custody seat). Serverless-first: the default is byok+mock
// so the whole flow works with zero backend and zero keys.
//
// SECURITY (AC5, F14): BYOK keys live in the user DB's snug_secrets table ONLY — never
// localStorage, never sessionStorage, never a cookie, never any request to the hub
// (secrets are stripped from hub-origin sync pushes and default exports). This is a
// deliberate, documented weakening vs v1's dies-with-the-tab sessionStorage key,
// accepted for portability; unit tests pin the browser-storage negatives.
//
// F15: endpoint/provider settings arriving via import or first pull are executable
// config — transports refuse byok/local turns until the user re-confirms them.

import { LOCAL_DEFAULT_BASE_URL, isModelId } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';

import { allows, getPlatform } from '../platform/platform.js';
// NOTE: appModel.ts imports `modelStore` from THIS module, so this is a cycle. It is
// safe because neither side touches the other at module-evaluation time — the imports
// are only dereferenced inside functions (`hydrateAppModels` here,
// `resolveModelForApp` there), by which point both modules are fully initialized.
import { hydrateAppModels } from './appModel.js';
import { ollamaStore } from './ollama.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

export type PlaygroundMode = 'subscription' | 'byok' | 'local' | 'chatgpt';
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
/**
 * `providerModel:<provider>` — the default model for ONE keyed provider (AC8/AC11), and since
 * TASK-20261023-siwc-chatgpt-plan the ChatGPT plan's default too (`providerModel:chatgpt`): one key
 * family for "the default model of a brain", so a roaming file carries them all the same way.
 */
const providerModelSettingKey = (provider: KeyedProvider | 'chatgpt'): string => `providerModel:${provider}`;
/**
 * `providerEffort:chatgpt` — the ChatGPT plan's thinking level, in OpenAI's own vocabulary (D6). Only
 * the plan has one today: BYOK and local send no level, the host brain's tier is a platform seat.
 */
const SETTING_CHATGPT_EFFORT = 'providerEffort:chatgpt';
/** Set once the first "You're using your ChatGPT plan" notice has been shown on this file (AC11). */
const SETTING_CHATGPT_NOTICE_SHOWN = 'chatgptNoticeShown';

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
 * WHICH stored mode the coercion moved away from (TASK-20261023-siwc-chatgpt-plan, plan §12 L5-2):
 * the note branches its sentence on it — a file asking for the hub is told one thing, a file asking
 * for a ChatGPT plan this computer cannot sign in to another. Set in both coercion branches, cleared
 * with the note; `modeCoercedStore` stays the boolean the note shows on.
 */
export const coercedFromModeStore = createStore<PlaygroundMode | undefined>(undefined);
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
/**
 * The ChatGPT plan's default model and thinking level — its own rows, never the keyed providers'
 * and never the global `model` row (that one names an Ollama or hub model; handing it to the plan
 * would send `llama3.2` to OpenAI). Absent = the first model of the account's list / no level.
 */
export const chatgptModelStore = createStore<string | undefined>(undefined);
export const chatgptEffortStore = createStore<string | undefined>(undefined);
/**
 * Whether this FILE has shown the one-time "You're using your ChatGPT plan" notice (AC11) —
 * hydrated from the row, so the notice reads it synchronously the moment a sign-in completes and
 * follows the file (an import or a sync pull rehydrates it), never the machine.
 */
export const chatgptNoticeShownStore = createStore<boolean>(false);

/**
 * The mode names a person sees — the Settings segment (L4-13) and the selectors' "pinned for
 * <mode> — not used here" line (ADR-0078 §6) say the same word for the same mode.
 */
export const MODE_LABELS: Record<PlaygroundMode, string> = {
  byok: 'bring your own key',
  local: 'local model',
  subscription: 'hub subscription',
  chatgpt: 'my ChatGPT plan',
};

const isMode = (v: unknown): v is PlaygroundMode => v === 'subscription' || v === 'byok' || v === 'local' || v === 'chatgpt';

/** Whether this platform can hold a ChatGPT-plan session at all — the seat's presence IS the capability (AC1, D10). ONE definition; the keeper reads it too. */
/**
 * A FUNCTION DECLARATION on purpose (hoisted): `state/chatgptPlan.ts` imports this and sits in an
 * import cycle with this module (mode → appModel → chatgptPlan → mode). A `const` arrow here threw
 * "Cannot access 'hasChatgptSeat' before initialization" when the graph was entered from
 * `webllm.ts` on CI (TASK-20261023-siwc-chatgpt-plan, Gate 6, run 40110518422); a declaration is
 * initialised before any module body runs, so the cycle's entry order no longer matters.
 */
export function hasChatgptSeat(): boolean {
  return getPlatform().chatgptPlan !== undefined;
}

/**
 * The shape a thinking level must have to be stored or sent (Gate 5 ST12 / A3): OpenAI's levels are
 * short lowercase words (`low`, `medium`, `high`, `ultra`); a row from a foreign file or a crafted
 * value that is not one is refused at this boundary, never carried into a request body.
 */
const CHATGPT_EFFORT_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

export const isChatgptEffort = (value: unknown): value is string => typeof value === 'string' && CHATGPT_EFFORT_SHAPE.test(value);

/**
 * Modes the current platform offers (TASK-20260812 Decision 10): subscription is a capability the
 * platform declares, never a flag the picker could re-enable; the ChatGPT plan is offered only where
 * the shell carries the custody seat (the desktop — never web, the hosted build or the host kit).
 * Order: byok, local, chatgpt, subscription.
 */
export function availableModes(): PlaygroundMode[] {
  const modes: PlaygroundMode[] = ['byok', 'local'];
  if (hasChatgptSeat()) modes.push('chatgpt');
  if (getPlatform().capabilities.subscriptionMode) modes.push('subscription');
  return modes;
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
    const unavailable = (mode === 'subscription' && !getPlatform().capabilities.subscriptionMode) || (mode === 'chatgpt' && !hasChatgptSeat());
    if (unavailable) {
      // W2b coercion: a file carrying a mode this platform cannot run — the web's subscription,
      // or a ChatGPT plan where no custody seat exists to sign in with — must not dead-end
      // here. The ACTIVE mode becomes the best this platform offers — local when the
      // Ollama probe found a running install, byok otherwise — and the stored setting
      // is deliberately NOT rewritten: modeStore.set, never setMode. The note store
      // makes the divergence visible instead of silent, and `coercedFromModeStore` says
      // which mode the file asked for so the note can name it.
      const ollama = ollamaStore.get();
      modeStore.set(ollama !== 'unknown' && ollama.running ? 'local' : 'byok');
      modeCoercedStore.set(true);
      coercedFromModeStore.set(mode);
    } else {
      modeStore.set(mode);
      // A hydrate that coerced nothing clears a note an earlier one left (Gate 5 G5-C14): a file
      // whose mode this platform runs is not "moved away from" any more — an import that replaced a
      // chatgpt file with a byok one must not keep saying the plan was set aside.
      modeCoercedStore.set(false);
      coercedFromModeStore.set(undefined);
    }
  } else {
    modeCoercedStore.set(false);
    coercedFromModeStore.set(undefined);
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
  // The plan's rows cross the file boundary here too: a model id from a foreign file passes the
  // same shape check the setter applies (C5), or it is dropped — never a store value the adapter
  // would then put in a request body.
  const chatgptModel = db.getSetting(providerModelSettingKey('chatgpt'));
  chatgptModelStore.set(isModelId(chatgptModel) ? chatgptModel : undefined);
  const chatgptEffort = db.getSetting(SETTING_CHATGPT_EFFORT);
  chatgptEffortStore.set(isChatgptEffort(chatgptEffort) ? chatgptEffort : undefined);
  chatgptNoticeShownStore.set(db.getSetting(SETTING_CHATGPT_NOTICE_SHOWN) === true);
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

/**
 * The ChatGPT plan's default model (AC8). `undefined` clears the row (the account list's first model
 * then answers); a string must pass `isModelId` or NOTHING changes — the settings boundary is where a
 * model id is checked (C5), so an empty or malformed id is refused here rather than carried into a
 * request body. Clearing is an explicit `undefined`, never `''`.
 */
export function setChatgptModel(model: string | undefined): void {
  if (model === undefined) {
    chatgptModelStore.set(undefined);
    void getUserDb().then((db) => db.deleteSetting(providerModelSettingKey('chatgpt')));
    return;
  }
  if (!isModelId(model)) return;
  chatgptModelStore.set(model);
  writeSetting(providerModelSettingKey('chatgpt'), model);
}

/**
 * The plan's thinking level for interactive turns (D6); `undefined` or empty clears the row — no level
 * is sent. A value that is not level-shaped (`isChatgptEffort`, Gate 5 ST12 / A3) changes NOTHING: the
 * settings boundary is where it is checked, like the model id.
 */
export function setChatgptEffort(effort: string | undefined): void {
  const trimmed = effort?.trim();
  if (trimmed === undefined || trimmed === '') {
    chatgptEffortStore.set(undefined);
    void getUserDb().then((db) => db.deleteSetting(SETTING_CHATGPT_EFFORT));
    return;
  }
  if (!isChatgptEffort(trimmed)) return;
  chatgptEffortStore.set(trimmed);
  writeSetting(SETTING_CHATGPT_EFFORT, trimmed);
}

/** Whether this FILE has shown the one-time plan notice (AC11) — the hydrated row, read synchronously. */
export function chatgptNoticeShown(): boolean {
  return chatgptNoticeShownStore.get();
}

/** The notice was shown: the store flips at once (the notice unmounts), the row follows (the file remembers). */
export function markChatgptNoticeShown(): Promise<void> {
  chatgptNoticeShownStore.set(true);
  return getUserDb().then((db) => db.setSetting(SETTING_CHATGPT_NOTICE_SHOWN, true));
}

export function useChatgptNoticeShown(): boolean {
  return useStore(chatgptNoticeShownStore);
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
/**
 * Whether the F15 endpoint-confirm gate is ARMED for this platform (TASK-20260905-host-kit
 * AC4, Gate-5 review 2026-09-05): the card that clears it lives in the brain section, so
 * where that section is hidden (`allows('brainSettings')` false — the host kit) the gate
 * must not fire, or one imported file would kill every builder and app turn forever with
 * no reachable "these settings are mine". The file's endpoints are not that host's business:
 * its brain is pinned (or the demo), and neither reads them. The store still carries the
 * file's flag (the file is portable) — this reader is what the two direct factories consult.
 */
export function endpointsNeedConfirm(): boolean {
  return allows('brainSettings') && endpointsNeedConfirmStore.get();
}

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

export function useChatgptModel(): string | undefined {
  return useStore(chatgptModelStore);
}

export function useChatgptEffort(): string | undefined {
  return useStore(chatgptEffortStore);
}

/** Session-local: the divergence remains in the file, so nothing is written. */
export function dismissModeCoercionNote(): void {
  modeCoercedStore.set(false);
  coercedFromModeStore.set(undefined);
}

export function useModeCoerced(): boolean {
  return useStore(modeCoercedStore);
}

export function useCoercedFromMode(): PlaygroundMode | undefined {
  return useStore(coercedFromModeStore);
}
