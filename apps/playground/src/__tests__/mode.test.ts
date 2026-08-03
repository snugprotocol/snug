// Settings + secrets rules after the portable-hub evolution (child-2 AC5, F14):
// mode/provider/model live in the user DB's snug_settings; BYOK keys live in
// snug_secrets ONLY — never localStorage, never sessionStorage (both storage
// negatives pinned here), never any request to the hub (pinned in builderStream).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  confirmEndpoints,
  endpointsNeedConfirmStore,
  getByokKey,
  hydrateSettings,
  localUrlStore,
  markEndpointsNeedConfirm,
  modeStore,
  modelStore,
  providerStore,
  setByokKey,
  setMode,
  setModel,
  setProvider,
} from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('settings write-through + hydration', () => {
  beforeEach(() => {
    modeStore.set('byok');
    providerStore.set('mock');
    modelStore.set(undefined);
    endpointsNeedConfirmStore.set(false);
  });

  it('persists mode/provider/model into the user DB and hydrates them back', async () => {
    const db = await installTestUserDb();
    setMode('local');
    setProvider('anthropic');
    setModel('claude-sonnet-5');
    await flush();
    expect(db.getSetting('mode')).toBe('local');
    expect(db.getSetting('provider')).toBe('anthropic');
    expect(db.getSetting('model')).toBe('claude-sonnet-5');

    // fresh stores → hydrate restores them
    modeStore.set('byok');
    providerStore.set('mock');
    modelStore.set(undefined);
    hydrateSettings(db);
    expect(modeStore.get()).toBe('local');
    expect(providerStore.get()).toBe('anthropic');
    expect(modelStore.get()).toBe('claude-sonnet-5');
    expect(localUrlStore.get()).toContain('11434'); // default survives absence
  });

  it('F15: the confirm flag round-trips and re-arms only on explicit confirm', async () => {
    const db = await installTestUserDb();
    markEndpointsNeedConfirm();
    await flush();
    expect(db.getSetting('needsEndpointConfirm')).toBe(true);
    expect(endpointsNeedConfirmStore.get()).toBe(true);
    confirmEndpoints();
    await flush();
    expect(db.getSetting('needsEndpointConfirm')).toBe(false);
    expect(endpointsNeedConfirmStore.get()).toBe(false);
  });
});

describe('byok key storage (AC5/F14 negatives)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('stores the key in snug_secrets and NEVER in localStorage or sessionStorage', async () => {
    const db = await installTestUserDb();
    await setByokKey('anthropic', 'sk-ant-test-123');
    expect(db.getSecret('byok:anthropic')).toBe('sk-ant-test-123');
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i) as string;
      expect(localStorage.getItem(name)).not.toContain('sk-ant-test-123');
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const name = sessionStorage.key(i) as string;
      expect(sessionStorage.getItem(name)).not.toContain('sk-ant-test-123');
    }
  });

  it('round-trips through getByokKey, trims, and keeps providers separate', async () => {
    await installTestUserDb();
    await setByokKey('anthropic', '  sk-a  ');
    await setByokKey('openai', 'sk-o');
    expect(await getByokKey('anthropic')).toBe('sk-a');
    expect(await getByokKey('openai')).toBe('sk-o');
  });

  it('clears the key when set to empty', async () => {
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-a');
    await setByokKey('anthropic', '   ');
    expect(await getByokKey('anthropic')).toBeUndefined();
  });
});
