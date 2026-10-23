// chatgptModes.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L4 (AC1, AC8, AC11; plan §4
// row 1; §11 L4-10, L4-13; ADR-0078 §1, §6).
//
// The mode plumbing of the third way to think, `PlaygroundMode = 'chatgpt'`:
//   - `availableModes()` offers it ONLY where the platform carries the custody seat
//     (`SnugPlatform.chatgptPlan`), in the order byok · local · chatgpt · subscription — a web
//     build, the host kit or a seatless desktop offering it is the AC1 negative;
//   - a stored `mode: 'chatgpt'` is recognised (`isMode`) and round-trips through the file;
//   - the legacy `model` row is NOT adopted into a keyed provider's default for a chatgpt file
//     (only byok files adopt — an Ollama or plan id must never reach a frontier adapter);
//   - the settings rows `providerModel:chatgpt` (through `isModelId` — C5: a bad id writes
//     NOTHING, on the setter and on hydrate), `providerEffort:chatgpt`, `chatgptNoticeShown`
//     and their accessors;
//   - Settings' "where the agent runs" segment: three buttons on the seat platform with the
//     label `my ChatGPT plan` (`MODE_LABELS.chatgpt`, compile-forced at L4), two on web+desktop
//     without it.
// The coercion of a stored chatgpt mode on a seatless platform is pinned in modeCoercion.test.tsx.
//
// Fresh module graph per test (the modeCoercion / desktopSettingsView harness).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import { chatgptDesktopPlatform, settle } from './chatgptPlanTestHelper.js';
import { hostPlatform } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  db: UserDb;
  mode: typeof import('../state/mode.js');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  return { db, mode };
}

const desktopWithoutSeat = (): SnugPlatform => ({
  kind: 'desktop',
  capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

describe('availableModes() — the seat IS the capability (AC1, L4-10)', () => {
  it('the desktop WITH the seat offers byok, local and chatgpt — in that order', async () => {
    const { mode } = await fresh(chatgptDesktopPlatform());
    expect(mode.availableModes()).toEqual(['byok', 'local', 'chatgpt']);
  });

  it('a desktop WITHOUT the seat offers byok and local only', async () => {
    const { mode } = await fresh(desktopWithoutSeat());
    expect(mode.availableModes()).toEqual(['byok', 'local']);
  });

  it('the web default (no platform set) never offers chatgpt', async () => {
    const { mode } = await fresh();
    expect(mode.availableModes()).toEqual(['byok', 'local', 'subscription']);
    expect(mode.availableModes()).not.toContain('chatgpt');
  });

  it('the host kit never offers chatgpt', async () => {
    const { mode } = await fresh(hostPlatform());
    expect(mode.availableModes()).not.toContain('chatgpt');
  });

  it('a platform carrying BOTH capabilities lists subscription last: byok, local, chatgpt, subscription', async () => {
    const { mode } = await fresh(chatgptDesktopPlatform({ capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: true } }));
    expect(mode.availableModes()).toEqual(['byok', 'local', 'chatgpt', 'subscription']);
  });
});

describe('the chatgpt mode round-trips through the file (isMode, L4-10)', () => {
  it('setMode("chatgpt") writes the row; a fresh hydrate restores it with no coercion', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    mode.setMode('chatgpt');
    await settle();
    expect(db.getSetting('mode')).toBe('chatgpt');

    mode.modeStore.set('byok');
    mode.hydrateSettings(db);
    expect(mode.modeStore.get()).toBe('chatgpt');
    expect(mode.modeCoercedStore.get()).toBe(false);
  });

  it('a chatgpt file’s legacy `model` row is NOT adopted into a keyed provider’s default (only byok files adopt)', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    db.setSetting('mode', 'chatgpt');
    db.setSetting('model', 'gpt-6.1-sol');
    db.setSecret('byok:anthropic', 'sk-ant-api03-test-0123456789abcdefghij');

    mode.hydrateSettings(db);
    await settle();

    expect(db.getSetting('providerModel:anthropic')).toBeUndefined();
    expect(mode.providerModelsStore.get()).toEqual({});
  });
});

describe('the ChatGPT-plan settings rows and their accessors (AC8, AC11, L4-10)', () => {
  it('setChatgptModel writes providerModel:chatgpt and the store; hydrate restores it', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    mode.setChatgptModel('gpt-6.1-sol');
    await settle();
    expect(mode.chatgptModelStore.get()).toBe('gpt-6.1-sol');
    expect(db.getSetting('providerModel:chatgpt')).toBe('gpt-6.1-sol');

    mode.chatgptModelStore.set(undefined);
    mode.hydrateSettings(db);
    expect(mode.chatgptModelStore.get()).toBe('gpt-6.1-sol');
  });

  for (const bad of ['bad id', '../etc', '', 'gpt\n6', '-leading-dash']) {
    it(`setChatgptModel(${JSON.stringify(bad)}) is refused at the settings boundary (isModelId, C5) — no store change, no row`, async () => {
      const { db, mode } = await fresh(chatgptDesktopPlatform());
      mode.setChatgptModel('gpt-6.1-sol');
      await settle();
      mode.setChatgptModel(bad);
      await settle();
      expect(mode.chatgptModelStore.get()).toBe('gpt-6.1-sol');
      expect(db.getSetting('providerModel:chatgpt')).toBe('gpt-6.1-sol');
    });
  }

  it('a row from a foreign file that fails isModelId is not hydrated into the store (C5 at the boundary the file crosses)', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    db.setSetting('providerModel:chatgpt', 'bad id; rm -rf');
    mode.hydrateSettings(db);
    expect(mode.chatgptModelStore.get()).toBeUndefined();
  });

  it('setChatgptEffort writes providerEffort:chatgpt and the store; hydrate restores it', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    mode.setChatgptEffort('high');
    await settle();
    expect(mode.chatgptEffortStore.get()).toBe('high');
    expect(db.getSetting('providerEffort:chatgpt')).toBe('high');

    mode.chatgptEffortStore.set(undefined);
    mode.hydrateSettings(db);
    expect(mode.chatgptEffortStore.get()).toBe('high');
  });

  it('the rows are their own family — a chatgpt default never lands in a keyed provider’s row or the global model row', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    mode.setChatgptModel('gpt-6.1-sol');
    mode.setChatgptEffort('high');
    await settle();
    expect(db.getSetting('model')).toBeUndefined();
    expect(db.getSetting('providerModel:openai')).toBeUndefined();
    expect(db.getSetting('providerModel:anthropic')).toBeUndefined();
    expect(mode.modelStore.get()).toBeUndefined();
    expect(mode.providerModelsStore.get()).toEqual({});
  });

  it('chatgptNoticeShown: false on a fresh file; markChatgptNoticeShown writes the row; a file carrying it reads true (AC11)', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    expect(await mode.chatgptNoticeShown()).toBe(false);
    await mode.markChatgptNoticeShown();
    await settle();
    expect(db.getSetting('chatgptNoticeShown')).toBe(true);
    expect(await mode.chatgptNoticeShown()).toBe(true);
  });

  it('chatgptNoticeShown follows the FILE: a hydrated file with the row set reads true', async () => {
    const { db, mode } = await fresh(chatgptDesktopPlatform());
    db.setSetting('chatgptNoticeShown', true);
    mode.hydrateSettings(db);
    expect(await mode.chatgptNoticeShown()).toBe(true);
  });
});

describe('Settings — "where the agent runs" offers the plan only where the seat is (AC1; MODE_LABELS, L4-13)', () => {
  async function renderSettings(platform?: SnugPlatform): Promise<HTMLButtonElement[]> {
    await fresh(platform);
    const { SettingsView } = await import('../views/SettingsView.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <SettingsView />
        </MemoryRouter>,
      );
    });
    const group = container.querySelector('[aria-labelledby="mode-label"]');
    return [...(group?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
  }

  it('the seat desktop shows three buttons, the third labelled "my ChatGPT plan"', async () => {
    const labels = (await renderSettings(chatgptDesktopPlatform())).map((b) => b.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[2]).toBe('my ChatGPT plan');
  });

  it('a seatless desktop shows two, and no ChatGPT button', async () => {
    const labels = (await renderSettings(desktopWithoutSeat())).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(2);
    expect(labels.some((l) => l.includes('ChatGPT'))).toBe(false);
  });

  it('the web build shows no ChatGPT button', async () => {
    const labels = (await renderSettings()).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('ChatGPT'))).toBe(false);
  });
});
