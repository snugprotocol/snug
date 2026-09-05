// hostSettings.test.tsx — TASK-20260905-host-kit P3 / AC4 / AC5 / AC9: the Settings view
// and the file paths under the HOST platform, each with its web positive twin.
//
// D15: no brain section (mode segment, BYOK rows, local URL, default model/provider), no
// account section, no endpoint-confirm card (the file's endpoints are not this host's
// business). Capability truth: no connections section, no sync-origin picker (nothing to
// sync to from inside an artifact), and no "include secrets" export checkbox where no
// credential can be used (C1) — the same rule strips `snug_secrets` from an imported
// file BEFORE the store adopts it. The hero copy never instructs a hidden control.
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend, openUserDb, type UserDb } from '@snugprotocol/db';
import { createRequire } from 'node:module';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

function hostPlatform(): SnugPlatform {
  return {
    kind: 'host',
    binding: 'artifact',
    brain: { kind: 'demo' },
    capabilities: {
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
    },
  };
}

interface Graph {
  db: UserDb;
  platform: typeof import('../platform/platform.js');
  mode: typeof import('../state/mode.js');
  sync: typeof import('../state/sync.js');
  SettingsView: typeof import('../views/SettingsView.js')['SettingsView'];
  App: typeof import('../App.js')['App'];
}

async function fresh(platform?: SnugPlatform): Promise<Graph> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  const sync = await import('../state/sync.js');
  return {
    db,
    platform: platformModule,
    mode,
    sync,
    SettingsView: (await import('../views/SettingsView.js')).SettingsView,
    App: (await import('../App.js')).App,
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function render(node: ReactElement, initialEntries: string[] = ['/settings']): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={initialEntries}>{node}</MemoryRouter>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

const byTestId = (id: string): HTMLElement | null => (container?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null) ?? null;
const section = (label: string): HTMLElement | null => byTestId(`settings-section-${label}`);
const buttonByText = (re: RegExp): HTMLButtonElement | undefined =>
  ([...(container?.querySelectorAll('button') ?? [])] as HTMLButtonElement[]).find((b) => re.test(b.textContent ?? ''));
const includeSecretsBox = (): HTMLInputElement | undefined =>
  ([...(container?.querySelectorAll('label.check-label') ?? [])] as HTMLElement[])
    .find((l) => /include secrets/.test(l.textContent ?? ''))
    ?.querySelector('input[type="checkbox"]') ?? undefined;

describe('Settings under the host platform (D15 + capability truth)', () => {
  it('host: brain, account and connections sections are gone; your file, feedback, appearance, about stay', async () => {
    const g = await fresh(hostPlatform());
    await render(<g.SettingsView />);
    expect(section('brain')).toBeNull();
    expect(section('account')).toBeNull();
    expect(section('connections')).toBeNull();
    expect(section('your-file')).not.toBeNull();
    expect(section('feedback')).not.toBeNull();
    expect(section('appearance')).not.toBeNull();
    expect(section('about')).not.toBeNull();
  });

  it('host: no endpoint-confirm card even when the file arrived needing one', async () => {
    const g = await fresh(hostPlatform());
    g.mode.endpointsNeedConfirmStore.set(true);
    await render(<g.SettingsView />);
    expect(buttonByText(/these settings are mine/)).toBeUndefined();
  });

  it('host: no sync-origin picker and no "include secrets" checkbox; the hero instructs no hidden control', async () => {
    const g = await fresh(hostPlatform());
    await render(<g.SettingsView />);
    expect(container?.querySelector('#origin-label')).toBeNull();
    expect(includeSecretsBox()).toBeUndefined();
    expect(container?.querySelector('.settings-hero-sub')?.textContent).toBe('your file, your apps — everything lives with you.');
  });

  it('host: the "your file" card names the storage the probe found working (AC2) — memory here', async () => {
    const g = await fresh({ ...hostPlatform(), userdbBackend: createMemoryBackend() });
    await render(<g.SettingsView />);
    expect(section('your-file')?.textContent).toContain('this copy of your file lives in memory only');
  });

  it('web (positive twin): the "your file" card carries no storage sentence', async () => {
    const g = await fresh();
    await render(<g.SettingsView />);
    expect(section('your-file')?.textContent).not.toContain('this copy of your file lives');
  });

  it('web (positive twin): every hidden surface renders — sections, the armed confirm card, the origin picker, the checkbox, the web hero', async () => {
    const g = await fresh();
    g.mode.endpointsNeedConfirmStore.set(true);
    await render(<g.SettingsView />);
    expect(section('brain')).not.toBeNull();
    expect(section('account')).not.toBeNull();
    expect(section('connections')).not.toBeNull();
    expect(buttonByText(/these settings are mine/)).toBeDefined();
    expect(container?.querySelector('#origin-label')).not.toBeNull();
    expect(includeSecretsBox()).toBeDefined();
    expect(container?.querySelector('.settings-hero-sub')?.textContent).toBe(
      'your brain, your file, your connections — everything lives with you.',
    );
  });
});

describe('initSync under the host platform (no origin can be reached from inside an artifact)', () => {
  it("host: a file configured for dropbox boots with sync OFF and origin 'none'", async () => {
    const g = await fresh(hostPlatform());
    g.db.setSyncConfig('origin', { kind: 'dropbox' });
    await g.sync.initSync();
    expect(g.sync.syncStatusStore.get()).toMatchObject({ origin: 'none', state: 'off' });
  });

  it('web (positive twin): the configured origin is honoured', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline test')));
    const g = await fresh();
    g.db.setSyncConfig('origin', { kind: 'dropbox' });
    await g.sync.initSync();
    expect(g.sync.syncStatusStore.get().origin).toBe('dropbox');
  });
});

describe('importUserFile under the host platform strips snug_secrets before adoption (AC9, C1)', () => {
  const SECRET = 'sk-ant-must-never-land-in-the-kit';

  async function donor(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error('donor open failed');
    opened.userDb.setSecret('byok:anthropic', SECRET);
    opened.userDb.setSetting('mode', 'local');
    const bytes = await opened.userDb.exportUserDb({ includeSecrets: true });
    await opened.userDb.close();
    return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  }

  it('host: an import arms nothing the kit cannot clear — endpointsNeedConfirm() stays false while the file’s flag is kept', async () => {
    const g = await fresh(hostPlatform());
    await g.sync.importUserFile(await donor());
    expect(g.mode.endpointsNeedConfirmStore.get()).toBe(true); // the portable file still carries it
    expect(g.mode.endpointsNeedConfirm()).toBe(false); // but no turn is gated where no card can clear it
  });

  it('web (positive twin): an import arms F15 and the reader says so', async () => {
    const g = await fresh();
    await g.sync.importUserFile(await donor());
    expect(g.mode.endpointsNeedConfirm()).toBe(true);
  });

  it('host: the imported file keeps its settings and loses every secret — a byte scan finds no trace', async () => {
    const g = await fresh(hostPlatform());
    await g.sync.importUserFile(await donor());
    expect(g.db.listSecretKeys()).toEqual([]);
    expect(g.db.getSetting('mode')).toBe('local');
    const adopted = await g.db.exportUserDb({ includeSecrets: true });
    expect(new TextDecoder('latin1').decode(adopted)).not.toContain(SECRET);
  });

  it('web (positive twin): the secret arrives with the file, as today', async () => {
    const g = await fresh();
    await g.sync.importUserFile(await donor());
    expect(g.db.getSecret('byok:anthropic')).toBe(SECRET);
  });
});

describe('the share-link route under the host platform (the relay is unreachable)', () => {
  it('host: /s/:id renders no shared-link view', async () => {
    const g = await fresh(hostPlatform());
    await render(<g.App />, ['/s/some-share-id']);
    expect(byTestId('shared-link-loading')).toBeNull();
    expect(byTestId('shared-link-failure')).toBeNull();
    // Never an empty main region: a pasted link lands on a named refusal.
    expect(byTestId('shared-link-unavailable')?.textContent).toContain('share links can’t open here');
  });

  it('web (positive twin): /s/:id mounts the shared-link view', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline test')));
    const g = await fresh();
    await render(<g.App />, ['/s/some-share-id']);
    expect(byTestId('shared-link-loading') ?? byTestId('shared-link-failure')).not.toBeNull();
  });
});
