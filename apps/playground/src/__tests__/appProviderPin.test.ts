// appProviderPin.test.ts — TASK-20260821-ui-polish AC10 (state half).
//
// A pin is a PIN: any model pick stores BOTH rows (`appModel:` + `appProvider:`), so the
// pick survives a later default-provider change intact instead of stranding a foreign
// model id on the new provider. Only inheriting is an absence — the clear deletes both.
//
// A provider pin is honored even when its key is gone (the honest choice: silently
// re-routing an app's data to a provider the user did not pick for it is worse than a
// visible keyless failure); `appPinMissingKey` is what the selector renders instead.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  appModelStore,
  appPinMissingKey,
  appProviderStore,
  hydrateAppModels,
  resolveModelForApp,
  resolveProviderForApp,
  setAppPin,
} from '../state/appModel.js';
import {
  byokKeyPresenceStore,
  modeStore,
  modelStore,
  providerChoiceStore,
  providerModelsStore,
  providerStore,
} from '../state/mode.js';
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
  byokKeyPresenceStore.set({ anthropic: true, openai: true });
  providerModelsStore.set({});
  modelStore.set(undefined);
});

describe('resolveProviderForApp (AC10)', () => {
  it('follows the resolved default when no pin exists — live', () => {
    expect(resolveProviderForApp(APP_A)).toBe('anthropic');
    providerStore.set('openai');
    expect(resolveProviderForApp(APP_A)).toBe('openai');
  });

  it('a cross-provider pin wins over the default, per app', async () => {
    await installTestUserDb();
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();

    expect(resolveProviderForApp(APP_A)).toBe('openai');
    expect(resolveModelForApp(APP_A)).toBe('gpt-4o-mini');
    // The sibling keeps following the default.
    expect(resolveProviderForApp(APP_B)).toBe('anthropic');
  });

  it('a SAME-provider pick still stores the provider row — the default changing must not re-route it', async () => {
    await installTestUserDb();
    setAppPin(APP_A, { provider: 'anthropic', model: 'claude-opus-5' });
    await flush();

    providerStore.set('openai'); // the default moves
    expect(resolveProviderForApp(APP_A)).toBe('anthropic');
    expect(resolveModelForApp(APP_A)).toBe('claude-opus-5');
  });

  it('clearing the pin deletes BOTH rows and the app inherits again', async () => {
    const db = await installTestUserDb();
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    setAppPin(APP_A, undefined);
    await flush();

    expect(resolveProviderForApp(APP_A)).toBe('anthropic');
    expect(db.getSetting(`appModel:${APP_A}`)).toBeUndefined();
    expect(db.getSetting(`appProvider:${APP_A}`)).toBeUndefined();
  });

  it('both rows survive a reload through hydration', async () => {
    const db = await installTestUserDb();
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();

    appModelStore.set({});
    appProviderStore.set({});
    hydrateAppModels(db);

    expect(resolveProviderForApp(APP_A)).toBe('openai');
    expect(resolveModelForApp(APP_A)).toBe('gpt-4o-mini');
  });
});

describe('a pin whose key is gone (honesty over re-routing)', () => {
  it('is still honored by resolution, and appPinMissingKey says so', async () => {
    await installTestUserDb();
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    byokKeyPresenceStore.set({ anthropic: true, openai: false });

    expect(resolveProviderForApp(APP_A)).toBe('openai');
    expect(appPinMissingKey(APP_A)).toBe(true);
    expect(appPinMissingKey(APP_B)).toBe(false);
  });
});

describe('the per-provider default reached through the app’s OWN provider (AC9 tail)', () => {
  it('an un-pinned app under an openai default inherits openai’s default model', () => {
    providerStore.set('openai');
    providerModelsStore.set({ anthropic: 'claude-opus-5', openai: 'gpt-4o-mini' });
    expect(resolveModelForApp(APP_A)).toBe('gpt-4o-mini');
  });

  it('a provider-pinned app WITHOUT a model pin inherits THAT provider’s default model', async () => {
    // Not reachable through the selector today (a pick always writes both rows), but the
    // resolution must stay coherent if the model row is ever cleared alone.
    await installTestUserDb();
    appProviderStore.set({ [APP_A]: 'openai' });
    providerModelsStore.set({ anthropic: 'claude-opus-5', openai: 'gpt-4o-mini' });
    expect(resolveModelForApp(APP_A)).toBe('gpt-4o-mini');
  });
});
