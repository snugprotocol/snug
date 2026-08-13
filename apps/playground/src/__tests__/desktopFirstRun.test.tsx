// Desktop first-run welcome (TASK-20260812 P3 item 1): a one-screen, zero-jargon
// choice shown exactly once — when the shell is desktop and no mode has ever been
// chosen. "Use your computer's AI" is enabled only when the Ollama probe found
// models (count shown); its disabled state points at ollama.com in plain words.
// Skipping persists, choosing persists, and the web hub never sees any of it.
//
// Platform is set-once, so every case takes a fresh module registry and imports the
// view + stores dynamically from that generation (the W2a/W2b pattern).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  db: UserDb;
  firstRun: typeof import('../desktop/firstRun.js');
  mode: typeof import('../state/mode.js');
  ollama: typeof import('../state/ollama.js');
  HubView: typeof import('../views/HubView.js')['HubView'];
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const firstRun = await import('../desktop/firstRun.js');
  const mode = await import('../state/mode.js');
  const ollama = await import('../state/ollama.js');
  const hub = await import('../views/HubView.js');
  return { db, firstRun, mode, ollama, HubView: hub.HubView };
}

function desktopPlatform(overrides: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...overrides,
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function renderHub(harness: Harness): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <harness.HubView />
      </MemoryRouter>,
    );
  });
  await settle();
}

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

async function click(name: RegExp): Promise<void> {
  const target = button(name);
  if (target === undefined) throw new Error(`no button matching ${String(name)}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('desktop first-run welcome (P3 item 1)', () => {
  it('shows the welcome on desktop when no mode was ever chosen — with the pinned sentence', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2', 'qwen3:4b'] }) }),
    );
    await harness.ollama.refreshOllama();
    await harness.firstRun.initDesktopFirstRun();
    await renderHub(harness);

    const welcome = container?.querySelector('[data-testid="desktop-welcome"]');
    expect(welcome, 'the hub must show the welcome takeover').not.toBeNull();
    expect(container?.textContent).toContain(
      'Snug runs on your computer. Your data stays in one file that belongs to you.',
    );
    // The regular hub shelf is NOT competing with the welcome — one idea per screen.
    expect(container?.querySelector('[data-testid="starter-tile"]')).toBeNull();
  });

  it('with Ollama models found, the local choice is enabled and shows the model count; choosing persists', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2', 'qwen3:4b'] }) }),
    );
    await harness.ollama.refreshOllama();
    await harness.firstRun.initDesktopFirstRun();
    await renderHub(harness);

    const local = button(/use your computer/i);
    expect(local).toBeDefined();
    expect(local!.disabled).toBe(false);
    expect(container?.textContent).toMatch(/2 models/);

    await click(/use your computer/i);
    await flush();

    expect(harness.mode.modeStore.get()).toBe('local');
    expect(harness.db.getSetting('mode')).toBe('local');
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
    // The welcome is gone and the hub is back.
    expect(container?.querySelector('[data-testid="desktop-welcome"]')).toBeNull();
    // Never shown again: a fresh init sees the persisted decision.
    await harness.firstRun.initDesktopFirstRun();
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
  });

  it('without Ollama, the local choice is disabled and links to ollama.com in plain words', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: false, models: [] }) }),
    );
    await harness.ollama.refreshOllama();
    await harness.firstRun.initDesktopFirstRun();
    await renderHub(harness);

    const local = button(/use your computer/i);
    expect(local).toBeDefined();
    expect(local!.disabled).toBe(true);
    expect(container?.textContent).toContain('Install Ollama (free) to run AI without an account');
    const link = container?.querySelector<HTMLAnchorElement>('[data-testid="welcome-ollama-link"]');
    expect(link?.href).toContain('ollama.com');
  });

  it('the service-key choice sets byok, persists, and stops the welcome for good', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: false, models: [] }) }),
    );
    await harness.ollama.refreshOllama();
    await harness.firstRun.initDesktopFirstRun();
    await renderHub(harness);

    await click(/use an ai service key/i);
    await flush();

    expect(harness.mode.modeStore.get()).toBe('byok');
    expect(harness.db.getSetting('mode')).toBe('byok');
    await harness.firstRun.initDesktopFirstRun();
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
  });

  it("skipping (\"I'll look around first\") hides the welcome, persists, and leaves no mode chosen", async () => {
    const harness = await fresh(desktopPlatform());
    await harness.firstRun.initDesktopFirstRun();
    await renderHub(harness);

    await click(/look around first/i);
    await flush();

    expect(container?.querySelector('[data-testid="desktop-welcome"]')).toBeNull();
    expect(harness.db.getSetting('mode'), 'skipping must not choose a mode').toBeUndefined();
    await harness.firstRun.initDesktopFirstRun();
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
  });

  it('a file that already carries a mode never sees the welcome', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'byok');
    await harness.firstRun.initDesktopFirstRun();
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
  });

  it('web: initDesktopFirstRun is a no-op and the hub renders as today (AC10)', async () => {
    const harness = await fresh();
    await harness.firstRun.initDesktopFirstRun();
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
    await renderHub(harness);
    expect(container?.querySelector('[data-testid="desktop-welcome"]')).toBeNull();
    expect(container?.textContent).toContain('your apps');
  });

  it('no jargon on the happy path: BYOK/LLM/endpoint never reach the screen', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2'] }) }),
    );
    await harness.ollama.refreshOllama();
    await harness.firstRun.initDesktopFirstRun();
    await renderHub(harness);

    const text = container?.textContent ?? '';
    expect(text).not.toMatch(/BYOK/i);
    expect(text).not.toMatch(/\bLLM\b/i);
    expect(text).not.toMatch(/endpoint/i);
  });
});
