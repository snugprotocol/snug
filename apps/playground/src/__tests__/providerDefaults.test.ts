// providerDefaults.test.ts — TASK-20260821-ui-polish AC8/AC9/AC11 (state half).
//
// BYOK grows from "one active provider" to "keys for BOTH providers, a default provider,
// and a default model PER provider". The rules under test:
//
//   RESOLUTION (AC9): an explicit user choice wins unconditionally (`providerChoice`
//   row; `setProvider` writes it). With NO choice, the default DERIVES from key
//   presence: anthropic if its key exists, else openai if its key exists, else the demo
//   brain. `providerStore` carries the RESOLVED value so every downstream consumer
//   (transport, wizard, inspector) keeps reading the store it always read.
//
//   ADOPTION (AC11, review finding 6): a legacy file's `provider` row was written only
//   by a user act under the old UI, so it adopts forward into `providerChoice` once;
//   the legacy `model` row adopts into `providerModel:<resolved>` once (byok files
//   only — in local mode that row names an Ollama model). Neither legacy row is ever
//   deleted: a roaming file opened by an old build still reads them.
//
//   PER-PROVIDER DEFAULT MODELS: `providerModel:anthropic` / `providerModel:openai`
//   rows, absent = the adapter's own default (the meaning an empty model field has
//   always had).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  byokKeyPresenceStore,
  hydrateSettings,
  modeStore,
  modelStore,
  providerChoiceStore,
  providerModelsStore,
  providerStore,
  resolveDefaultProvider,
  setByokKey,
  setProvider,
  setProviderModel,
  endpointsNeedConfirmStore,
} from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  modeStore.set('byok');
  providerStore.set('mock');
  providerChoiceStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  providerModelsStore.set({});
  modelStore.set(undefined);
  endpointsNeedConfirmStore.set(false);
});

describe('the derived default provider (AC9)', () => {
  it('is the demo brain with no keys, and follows key presence: anthropic > openai', async () => {
    await installTestUserDb();
    expect(resolveDefaultProvider()).toBe('mock');

    await setByokKey('openai', 'sk-openai');
    expect(resolveDefaultProvider()).toBe('openai');

    // Anthropic outranks openai the moment its key lands (owner rule).
    await setByokKey('anthropic', 'sk-ant');
    expect(resolveDefaultProvider()).toBe('anthropic');
    // …and the RESOLVED store follows, so every consumer sees it without a reload.
    expect(providerStore.get()).toBe('anthropic');
  });

  it('a deleted key re-derives the default', async () => {
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-ant');
    await setByokKey('openai', 'sk-openai');
    expect(providerStore.get()).toBe('anthropic');

    await setByokKey('anthropic', ''); // clearing deletes the secret
    expect(resolveDefaultProvider()).toBe('openai');
    expect(providerStore.get()).toBe('openai');
  });

  it('an explicit choice overrides the derivation and persists across hydration', async () => {
    const db = await installTestUserDb();
    await setByokKey('anthropic', 'sk-ant');
    await setByokKey('openai', 'sk-openai');
    setProvider('openai'); // the explicit act — anthropic would win derived
    await flush();

    expect(providerStore.get()).toBe('openai');
    expect(db.getSetting('providerChoice')).toBe('openai');
    // The legacy row is kept in sync so an old build opening this file agrees.
    expect(db.getSetting('provider')).toBe('openai');

    // A fresh hydration (boot, import, pull) restores the choice.
    providerStore.set('mock');
    providerChoiceStore.set(undefined);
    hydrateSettings(db);
    expect(providerStore.get()).toBe('openai');
  });
});

describe('legacy adoption on hydrate (AC11, review finding 6)', () => {
  it('adopts a legacy `provider` row as the explicit choice — once, without deleting it', async () => {
    const db = await installTestUserDb();
    // An OLD file: user picked openai under the old UI, keys for both saved.
    db.setSetting('provider', 'openai');
    db.setSecret('byok:anthropic', 'sk-ant');
    db.setSecret('byok:openai', 'sk-openai');

    hydrateSettings(db);

    // Without adoption the derivation would flip this user to anthropic silently.
    expect(providerStore.get()).toBe('openai');
    expect(db.getSetting('providerChoice')).toBe('openai');
    expect(db.getSetting('provider')).toBe('openai'); // never deleted
  });

  it('adopts a legacy byok `model` row into the resolved provider’s default-model row', async () => {
    const db = await installTestUserDb();
    db.setSetting('mode', 'byok');
    db.setSetting('provider', 'openai');
    db.setSetting('model', 'gpt-4o-mini');
    db.setSecret('byok:openai', 'sk-openai');

    hydrateSettings(db);

    expect(providerModelsStore.get().openai).toBe('gpt-4o-mini');
    expect(db.getSetting('providerModel:openai')).toBe('gpt-4o-mini');
    expect(db.getSetting('model')).toBe('gpt-4o-mini'); // legacy row survives
  });

  it('does NOT adopt the model row from a LOCAL-mode file — that row names an Ollama model', async () => {
    const db = await installTestUserDb();
    db.setSetting('mode', 'local');
    db.setSetting('model', 'llama3.2');
    db.setSecret('byok:anthropic', 'sk-ant');

    hydrateSettings(db);

    expect(db.getSetting('providerModel:anthropic')).toBeUndefined();
    // The global model store still hydrates — local mode keeps reading it.
    expect(modelStore.get()).toBe('llama3.2');
  });

  it('never overwrites an already-set providerModel row (idempotent adoption)', async () => {
    const db = await installTestUserDb();
    db.setSetting('mode', 'byok');
    db.setSetting('provider', 'anthropic');
    db.setSetting('model', 'claude-haiku-4-5');
    db.setSetting('providerModel:anthropic', 'claude-opus-5');
    db.setSecret('byok:anthropic', 'sk-ant');

    hydrateSettings(db);
    hydrateSettings(db); // twice — a boot and a pull

    expect(providerModelsStore.get().anthropic).toBe('claude-opus-5');
    expect(db.getSetting('providerModel:anthropic')).toBe('claude-opus-5');
  });
});

describe('per-provider default models', () => {
  it('round-trips through the settings rows and hydration, independently per provider', async () => {
    const db = await installTestUserDb();
    setProviderModel('anthropic', 'claude-opus-5');
    setProviderModel('openai', 'gpt-4o-mini');
    await flush();

    expect(db.getSetting('providerModel:anthropic')).toBe('claude-opus-5');
    expect(db.getSetting('providerModel:openai')).toBe('gpt-4o-mini');

    providerModelsStore.set({});
    hydrateSettings(db);
    expect(providerModelsStore.get()).toEqual({ anthropic: 'claude-opus-5', openai: 'gpt-4o-mini' });
  });

  it('clearing deletes the row — absence means the adapter default, live', async () => {
    const db = await installTestUserDb();
    setProviderModel('anthropic', 'claude-opus-5');
    await flush();
    setProviderModel('anthropic', undefined);
    await flush();
    expect(db.getSetting('providerModel:anthropic')).toBeUndefined();
    expect(providerModelsStore.get().anthropic).toBeUndefined();
  });

  it('key presence hydrates from the secrets table', async () => {
    const db = await installTestUserDb();
    db.setSecret('byok:openai', 'sk-openai');
    hydrateSettings(db);
    expect(byokKeyPresenceStore.get()).toEqual({ anthropic: false, openai: true });
  });
});
