// `.snug` open-file routing (TASK-20260812 W2b item 5; Decision 8, P0 amendment 12).
// UNTRUSTED-INPUT TESTS FIRST: the (bytes, path) pair arrives from OS argv / open
// events, so flag-shaped strings, URL-shaped strings, wrong extensions, and magic-less
// bytes must all be inert — no confirm dialog, no import, no side effect. Only an
// sqlite-magic user file reaches the confirm, and only a confirmed one reaches
// importUserFile (which arms the F15 endpoint re-confirmation).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  openFile: typeof import('../platform/openFile.js');
  sync: typeof import('../state/sync.js');
  mode: typeof import('../state/mode.js');
  helper: typeof import('./userdbTestHelper.js');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const openFile = await import('../platform/openFile.js');
  const sync = await import('../state/sync.js');
  const mode = await import('../state/mode.js');
  return { db, openFile, sync, mode, helper };
}

/** Real sqlite bytes carrying one app, produced through the production export path. */
async function exportedUserFileBytes(harness: Harness): Promise<Uint8Array> {
  harness.db.installApp({ displayName: 'Ported App', html: '<html>ported</html>' });
  const blob = await harness.sync.exportUserFile(false);
  return new Uint8Array(await blob.arrayBuffer());
}

describe('handleOpenedUserFile — untrusted input is inert (amendment 12)', () => {
  it('flag-shaped path: no confirm, no import, even with valid sqlite bytes', async () => {
    const harness = await fresh();
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();
    const confirm = vi.fn(() => Promise.resolve(true));

    await harness.openFile.handleOpenedUserFile(bytes, '--import=/tmp/x.snug', confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(target.listApps()).toHaveLength(0);
  });

  it('URL-shaped path: no confirm, no import, even with a .snug suffix', async () => {
    const harness = await fresh();
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();
    const confirm = vi.fn(() => Promise.resolve(true));

    await harness.openFile.handleOpenedUserFile(bytes, 'https://evil.example/steal.snug', confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(target.listApps()).toHaveLength(0);
  });

  it('non-.snug/.sqlite extension: inert', async () => {
    const harness = await fresh();
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();
    const confirm = vi.fn(() => Promise.resolve(true));

    await harness.openFile.handleOpenedUserFile(bytes, '/Users/g/notes.txt', confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(target.listApps()).toHaveLength(0);
  });

  it('magic-less bytes never reach the confirm dialog', async () => {
    const harness = await fresh();
    const confirm = vi.fn(() => Promise.resolve(true));

    await harness.openFile.handleOpenedUserFile(
      new TextEncoder().encode('not a database at all'),
      '/Users/g/backup.snug',
      confirm,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(harness.db.listApps()).toHaveLength(0);
    expect(harness.mode.endpointsNeedConfirmStore.get()).toBe(false);
  });

  it('declined confirm: no import, F15 stays unarmed', async () => {
    const harness = await fresh();
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();
    const confirm = vi.fn(() => Promise.resolve(false));

    await harness.openFile.handleOpenedUserFile(bytes, '/Users/g/backup.snug', confirm);

    expect(confirm).toHaveBeenCalledWith({ path: '/Users/g/backup.snug', needsRestore: false });
    expect(target.listApps()).toHaveLength(0);
    expect(harness.mode.endpointsNeedConfirmStore.get()).toBe(false);
  });
});

describe('handleOpenedUserFile — the confirmed happy path', () => {
  it('imports the file through importUserFile and ARMS F15 (endpoints need re-confirmation)', async () => {
    const harness = await fresh();
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();
    harness.mode.endpointsNeedConfirmStore.set(false);

    await harness.openFile.handleOpenedUserFile(bytes, '/Users/g/backup.snug', () => Promise.resolve(true));

    expect(target.listApps().map((a) => a.displayName)).toEqual(['Ported App']);
    expect(
      harness.mode.endpointsNeedConfirmStore.get(),
      'imported bytes are executable config — F15 must arm',
    ).toBe(true);
  });

  it('accepts the web-named .sqlite extension too', async () => {
    const harness = await fresh();
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();

    await harness.openFile.handleOpenedUserFile(bytes, '/Users/g/snug-user.sqlite', () => Promise.resolve(true));

    expect(target.listApps()).toHaveLength(1);
  });
});

describe('registerPlatformOpenFile — the App boot wiring (W2b item 5)', () => {
  it('routes platform open events through the gates into the parked confirm, then imports on accept', async () => {
    let captured: ((bytes: Uint8Array, path: string) => void) | undefined;
    const platform: SnugPlatform = {
      kind: 'desktop',
      onOpenSnugFile: (cb) => {
        captured = cb;
      },
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    };
    const harness = await fresh(platform);
    const bytes = await exportedUserFileBytes(harness);
    const target = await harness.helper.installTestUserDb();

    harness.openFile.registerPlatformOpenFile();
    expect(captured, 'registration must hand the platform a callback').toBeDefined();

    captured!(bytes, '/Users/g/backup.snug');
    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileConfirmStore.get()?.path).toBe('/Users/g/backup.snug');
    });
    expect(target.listApps(), 'nothing imports before the user decides').toHaveLength(0);

    harness.openFile.resolveOpenUserFileConfirm(true);
    await vi.waitFor(() => {
      expect(target.listApps()).toHaveLength(1);
    });
    expect(harness.openFile.openUserFileConfirmStore.get()).toBeNull();
  });

  it('is a no-op on web: no onOpenSnugFile seam, nothing registered', async () => {
    const harness = await fresh();
    expect(() => harness.openFile.registerPlatformOpenFile()).not.toThrow();
    expect(harness.openFile.openUserFileConfirmStore.get()).toBeNull();
  });
});

describe('OpenUserFileConfirmDialog — the plain-language replace prompt', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  async function mountDialog(harness: Harness): Promise<void> {
    const app = await import('../App.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<app.OpenUserFileConfirmDialog />);
    });
  }

  function clickButton(name: RegExp): void {
    const target = [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? ''));
    if (target === undefined) throw new Error(`no button matching ${String(name)}`);
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('renders nothing while no open is pending', async () => {
    const harness = await fresh();
    await mountDialog(harness);
    expect(container?.textContent).toBe('');
  });

  it('names the file, warns about the overwrite, and resolves the user decision', async () => {
    const harness = await fresh();
    const resolve = vi.fn();
    await mountDialog(harness);
    act(() => {
      harness.openFile.openUserFileConfirmStore.set({ path: '/Users/g/backup.snug', needsRestore: false, resolve });
    });

    const text = container?.textContent ?? '';
    expect(text).toContain('/Users/g/backup.snug');
    expect(text).toContain('overwritten');

    clickButton(/replace/i);
    expect(resolve).toHaveBeenCalledWith(true);
    expect(harness.openFile.openUserFileConfirmStore.get()).toBeNull();
  });

  it('the keep-my-data choice resolves false', async () => {
    const harness = await fresh();
    const resolve = vi.fn();
    await mountDialog(harness);
    act(() => {
      harness.openFile.openUserFileConfirmStore.set({ path: '/Users/g/backup.snug', needsRestore: false, resolve });
    });

    clickButton(/keep/i);
    expect(resolve).toHaveBeenCalledWith(false);
    expect(harness.openFile.openUserFileConfirmStore.get()).toBeNull();
  });
});
