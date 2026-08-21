// appModel.test.ts — TASK-20260817-per-app-model-selector, the resolution rule.
// MIGRATED for TASK-20260821 multi-provider BYOK (every claim kept, none lost):
//
// `resolveModelForApp` is the ONE place the precedence rule lives:
//
//     per-app pick  →  the per-PROVIDER default (byok) / `modelStore` (local, subscription)
//                   →  undefined
//
// The tail matters: `undefined` is not a bug, it is the contract. The adapters apply
// their own `*_DEFAULT_MODEL` when `options.model` is absent (anthropic.ts:101,
// openai.ts:60), so resolving to `undefined` means "let the provider decide" — exactly
// what an empty Settings model field has always meant. Resolving to a hardcoded id here
// instead would silently take that decision away from the adapter layer.
//
// AC3 — unset means INHERITED, and inheritance is LIVE: an app that was never picked-for
//        follows a later change to the Settings default. This is the owner's decision 3,
//        and it is the reason the per-app value is stored as an absence rather than as a
//        copy of the default at first open.
// AC5 — a pick is per-app: picking for A leaves B and the global default alone.
// AC11 — a stored id that is not in the current provider's catalog still resolves. A
//        user who switches providers, or a catalog that gets pruned, must not lose the
//        app or have its pick silently dropped.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  appModelStore,
  appProviderStore,
  hydrateAppModels,
  resolveModelForApp,
  setAppModel,
} from '../state/appModel.js';
import { modeStore, modelStore, providerModelsStore, providerStore, providerChoiceStore, byokKeyPresenceStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const APP_A = 'app-a';
const APP_B = 'app-b';

beforeEach(() => {
  appModelStore.set({});
  appProviderStore.set({});
  modeStore.set('byok');
  providerStore.set('anthropic');
  providerChoiceStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: true, openai: false });
  providerModelsStore.set({});
  modelStore.set(undefined);
});

describe('resolveModelForApp — precedence (AC3)', () => {
  it('falls through to undefined when neither a pick nor a Settings default exists', () => {
    // NOT a hardcoded provider default: the adapters own that decision.
    expect(resolveModelForApp(APP_A)).toBeUndefined();
  });

  it('inherits the default of the provider the app resolves to (byok)', () => {
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    expect(resolveModelForApp(APP_A)).toBe('claude-sonnet-5');
  });

  it('inherits the global `model` setting in LOCAL mode — an Ollama pick is not per-provider', () => {
    modeStore.set('local');
    modelStore.set('llama3.2');
    expect(resolveModelForApp(APP_A)).toBe('llama3.2');
  });

  it('keeps inheriting LIVE — a later change to the default reaches an un-picked app', () => {
    providerModelsStore.set({ anthropic: 'claude-sonnet-5', openai: 'gpt-4o-mini' });
    expect(resolveModelForApp(APP_A)).toBe('claude-sonnet-5');

    // The owner's decision: an app that was never picked-for FOLLOWS the default — the
    // per-provider model change AND a default-provider change both reach it.
    providerModelsStore.set({ anthropic: 'claude-opus-5', openai: 'gpt-4o-mini' });
    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
    providerStore.set('openai');
    expect(resolveModelForApp(APP_A)).toBe('gpt-4o-mini');
  });

  it('prefers the app’s own pick over the Settings default', async () => {
    const db = await installTestUserDb();
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
    // The defaults are untouched by a per-app pick.
    expect(providerModelsStore.get().anthropic).toBe('claude-sonnet-5');
    expect(db.getSetting('providerModel:anthropic')).toBeUndefined();
    expect(db.getSetting('model')).toBeUndefined();
  });

  it('returns to inheriting when a pick is cleared', async () => {
    await installTestUserDb();
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    setAppModel(APP_A, 'claude-opus-5');
    await flush();
    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');

    setAppModel(APP_A, undefined);
    await flush();
    expect(resolveModelForApp(APP_A)).toBe('claude-sonnet-5');
  });

  it('resolves the Settings default when no app id is in scope', () => {
    // The inferrer lane and any non-app-scoped turn call this with no id; it must not
    // throw and must not invent a per-app value.
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    expect(resolveModelForApp(undefined)).toBe('claude-sonnet-5');
  });
});

describe('resolveModelForApp — per-app isolation (AC5)', () => {
  it('picks for one app without touching another', async () => {
    await installTestUserDb();
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
    expect(resolveModelForApp(APP_B)).toBe('claude-sonnet-5');
  });

  it('lets two apps hold different pinned models at once', async () => {
    await installTestUserDb();
    setAppModel(APP_A, 'claude-opus-5');
    setAppModel(APP_B, 'gpt-4o');
    await flush();

    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
    expect(resolveModelForApp(APP_B)).toBe('gpt-4o');
  });
});

describe('per-app model persistence + hydration (AC4)', () => {
  it('survives a reload — fresh stores over the same DB bytes resolve the pick', async () => {
    const db = await installTestUserDb();
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    // Simulate a reload: the DB bytes are the only thing that carries over, so the
    // in-memory store is cleared before re-hydrating. Asserting after `hydrateAppModels`
    // (rather than reading the store we just wrote) is what proves the write LANDED in
    // the file rather than only in memory.
    appModelStore.set({});
    expect(resolveModelForApp(APP_A)).toBeUndefined();

    hydrateAppModels(db);
    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
  });

  it('hydrates every app’s pick, not just the first', async () => {
    const db = await installTestUserDb();
    setAppModel(APP_A, 'claude-opus-5');
    setAppModel(APP_B, 'gpt-4o');
    await flush();

    appModelStore.set({});
    hydrateAppModels(db);
    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
    expect(resolveModelForApp(APP_B)).toBe('gpt-4o');
  });

  it('does not read the global `model` key as an app pick', async () => {
    // `snug_settings` is a shared namespace: a hydrate that scanned it loosely could
    // read `model`, `mode` or `provider` as if they were app ids.
    const db = await installTestUserDb();
    db.setSetting('model', 'claude-sonnet-5');
    db.setSetting('provider', 'anthropic');

    appModelStore.set({});
    hydrateAppModels(db);
    expect(appModelStore.get()).toEqual({});
  });

  it('clears the stored row when a pick is cleared, rather than storing an empty string', async () => {
    const db = await installTestUserDb();
    setAppModel(APP_A, 'claude-opus-5');
    await flush();
    setAppModel(APP_A, undefined);
    await flush();

    appModelStore.set({});
    hydrateAppModels(db);
    // An empty-string row would hydrate back as a falsy "pick" and could mask the
    // inherited default depending on the reader — so absence must mean absence.
    expect(resolveModelForApp(APP_A)).toBeUndefined();
  });
});

describe('unknown or stale stored models (AC11)', () => {
  it('still resolves a stored model that is not in any catalog', async () => {
    await installTestUserDb();
    // e.g. the user switched providers, or a future catalog pruned this id.
    setAppModel(APP_A, 'some-retired-model-id');
    await flush();
    expect(resolveModelForApp(APP_A)).toBe('some-retired-model-id');
  });

  it('does not fall back to the Settings default for an unrecognized stored model', async () => {
    await installTestUserDb();
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    setAppModel(APP_A, 'some-retired-model-id');
    await flush();
    // Silently substituting the default here would send the app's turns to a model the
    // user did not choose, with nothing on screen saying so.
    expect(resolveModelForApp(APP_A)).toBe('some-retired-model-id');
  });
});
