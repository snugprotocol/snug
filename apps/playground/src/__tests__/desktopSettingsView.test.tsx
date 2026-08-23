// Desktop Settings surface (TASK-20260812 W2b items 2/3/4/6). Component tests for
// what the platform seam changes in SettingsView: the mode picker loses the
// subscription option (Decision 10), the sync-origin group loses the hub origin
// (amendment 13) and an imported hub config reads as honestly unavailable, the local
// mode gets Ollama detection (model select + not-found hint), and the export button
// names the desktop file `.snug` through the native save seam (Decision 8).
//
// Platform is set-once, so every case takes a fresh module registry and imports the
// view + stores dynamically from that generation.
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

const SQLITE_MAGIC = 'SQLite format 3';

interface Harness {
  db: UserDb;
  mode: typeof import('../state/mode.js');
  sync: typeof import('../state/sync.js');
  ollama: typeof import('../state/ollama.js');
  SettingsView: typeof import('../views/SettingsView.js')['SettingsView'];
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  const sync = await import('../state/sync.js');
  const ollama = await import('../state/ollama.js');
  const view = await import('../views/SettingsView.js');
  return { db, mode, sync, ollama, SettingsView: view.SettingsView };
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
  vi.restoreAllMocks();
});

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    // Router wrapper since TASK-20260821: the Settings "app" section may render a
    // <Link> (a desktop platform without the appUpdates seat takes the web branch),
    // and Link outside a router is a crash, not a warning.
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

function buttons(): HTMLButtonElement[] {
  return [...(container?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
}

function buttonByText(name: RegExp): HTMLButtonElement | undefined {
  return buttons().find((b) => name.test(b.textContent ?? ''));
}

describe('mode picker — subscription capability (W2b item 3, Decision 10)', () => {
  it('desktop: the subscription option is absent; byok and local remain', async () => {
    const { SettingsView } = await fresh(desktopPlatform());
    await render(<SettingsView />);

    expect(buttonByText(/hub subscription/)).toBeUndefined();
    expect(buttonByText(/bring your own key/)).toBeDefined();
    expect(buttonByText(/local model/)).toBeDefined();
  });

  it('web: all three modes stay offered (AC10)', async () => {
    const { SettingsView } = await fresh();
    await render(<SettingsView />);

    expect(buttonByText(/hub subscription/)).toBeDefined();
  });
});

describe('sync origins — hub capability (W2b item 2, amendment 13)', () => {
  it('desktop: the hub origin button is not offered; device-only and dropbox remain', async () => {
    const { SettingsView } = await fresh(desktopPlatform());
    await render(<SettingsView />);

    expect(buttonByText(/this hub/)).toBeUndefined();
    expect(buttonByText(/this device only/)).toBeDefined();
    expect(buttonByText(/dropbox/)).toBeDefined();
  });

  it('desktop: an imported hub config surfaces the honest unavailable copy', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSyncConfig('origin', { kind: 'hub' });
    await harness.sync.initSync();
    await render(<harness.SettingsView />);

    expect(container?.textContent).toContain('not available in the desktop app');
  });

  it('flag-on web: the hub origin stays offered (AC10, migrated — ADR-0052 §5 hides it by default)', async () => {
    const { SettingsView } = await fresh({
      kind: 'web',
      capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, hubAuth: true },
    });
    await render(<SettingsView />);

    expect(buttonByText(/this hub/)).toBeDefined();
  });

  it('default web: the hub origin is NOT offered — sign-in is flag-hidden, so hub sync would be a dead 401', async () => {
    const { SettingsView } = await fresh();
    await render(<SettingsView />);

    expect(buttonByText(/this hub/)).toBeUndefined();
  });
});

describe('local mode — Ollama detection (W2b item 4, AC3)', () => {
  it('detected models render as a select, and picking one persists it', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2', 'qwen3:4b'] }) }),
    );
    await harness.ollama.refreshOllama();
    harness.mode.setMode('local');
    await render(<harness.SettingsView />);

    const select = container?.querySelector<HTMLSelectElement>('select#model-select');
    expect(select, 'detected models must render a picker').toBeTruthy();
    const optionValues = [...(select?.options ?? [])].map((o) => o.value);
    expect(optionValues).toContain('llama3.2');
    expect(optionValues).toContain('qwen3:4b');

    await act(async () => {
      select!.value = 'qwen3:4b';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(harness.mode.modelStore.get()).toBe('qwen3:4b');
  });

  it('the other… choice keeps the free-text input reachable', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2'] }) }),
    );
    await harness.ollama.refreshOllama();
    harness.mode.setMode('local');
    await render(<harness.SettingsView />);

    const select = container?.querySelector<HTMLSelectElement>('select#model-select');
    expect(select).toBeTruthy();
    expect(container?.querySelector('input#model-id')).toBeNull();

    const otherValue = [...(select?.options ?? [])].map((o) => o.value).find((v) => v.includes('other'));
    expect(otherValue, 'an other… escape hatch must exist').toBeDefined();
    await act(async () => {
      select!.value = otherValue!;
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container?.querySelector('input#model-id'), 'free text remains the fallback').toBeTruthy();
  });

  it('Ollama not detected on desktop: plain-language install hint, no select', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: false, models: [] }) }),
    );
    await harness.ollama.refreshOllama();
    harness.mode.setMode('local');
    await render(<harness.SettingsView />);

    expect(container?.textContent).toContain('Ollama not found — install it from ollama.com or paste an endpoint');
    expect(container?.querySelector('select#model-select')).toBeNull();
  });

  it('Ollama running with ZERO models: keep free text, add the pull hint (P3 item 3)', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: [] }) }),
    );
    await harness.ollama.refreshOllama();
    harness.mode.setMode('local');
    await render(<harness.SettingsView />);

    expect(container?.textContent).toContain('Ollama is installed but has no models yet');
    expect(container?.textContent).toContain('ollama pull llama3.2');
    // Free-text stays: no select to render, the input keeps working.
    expect(container?.querySelector('select#model-select')).toBeNull();
    expect(container?.querySelector('input#model-id')).toBeTruthy();
    // The not-found copy must NOT show — Ollama IS installed.
    expect(container?.textContent).not.toContain('Ollama not found');
  });

  it('web: no probe ran, the free-text model input stays exactly as today (AC10)', async () => {
    const harness = await fresh();
    harness.mode.setMode('local');
    await render(<harness.SettingsView />);

    expect(container?.querySelector('select#model-select')).toBeNull();
    expect(container?.querySelector('input#model-id')).toBeTruthy();
    expect(container?.textContent).not.toContain('Ollama not found');
  });
});

describe('export — desktop names the file .snug through the native save seam (W2b item 6)', () => {
  it('the export button hands snug-user.snug (sqlite bytes) to platform.saveFile', async () => {
    const saved: Array<{ bytes: Uint8Array; name: string }> = [];
    const harness = await fresh(
      desktopPlatform({
        saveFile: (bytes, suggestedName) => {
          saved.push({ bytes, name: suggestedName });
          return Promise.resolve();
        },
      }),
    );
    await render(<harness.SettingsView />);

    const exportButton = buttonByText(/export snug file/);
    expect(exportButton).toBeDefined();
    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]!.name).toBe('snug-user.snug');
    const head = new TextDecoder('latin1').decode(saved[0]!.bytes.slice(0, SQLITE_MAGIC.length));
    expect(head, 'same sqlite bytes, same magic — only the name changes').toBe(SQLITE_MAGIC);
  });
});
