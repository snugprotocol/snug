// Corrupt-file honesty at desktop boot (TASK-20260812 P3 item 7, db-chain concern).
// `openUserDb` REJECTING (a magic-less/torn file makes the desktop file backend's
// `load` throw — deliberately distinct from the quarantining status:'corrupt' path)
// must never leave the user staring at a silent skeleton or, worse, a fresh DB. The
// boot surfaces a 'load-failed' status; the App renders a plain screen — the file was
// NOT overwritten, the path is named — with a working "try again".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The exact error shape the production file backend throws for torn bytes. */
const TORN_FILE_MESSAGE =
  'stored file "Snug/user.sqlite" is 12 magic-less bytes — not a complete SQLite database or sync sidecar; ' +
  'refusing to treat corruption as a fresh start';

interface Harness {
  userdb: typeof import('../state/userdb.js');
  App: typeof import('../App.js')['App'];
  failures: { count: number };
}

/**
 * A platform whose file backend rejects on load — until `heal()` flips it to genuine
 * absence (the user restored or removed the broken file, then hit try again).
 */
async function fresh(behavior: { healed: boolean }): Promise<Harness> {
  vi.resetModules();
  // bootUserDb runs the REAL openUserDb; give sql.js a node-resolvable wasm. The
  // factory must not import test/state modules (they transitively import the module
  // being mocked — a deadlock), so it resolves the asset itself.
  vi.doMock('../run/wasm.js', async () => {
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    return { locateWasm: () => nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') };
  });
  const failures = { count: 0 };
  const platform: SnugPlatform = {
    kind: 'desktop',
    userdbBackend: {
      kind: 'file',
      load: () => {
        if (behavior.healed) return Promise.resolve(undefined);
        failures.count += 1;
        return Promise.reject(new Error(TORN_FILE_MESSAGE));
      },
      save: () => Promise.resolve(),
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(platform);
  const userdb = await import('../state/userdb.js');
  const app = await import('../App.js');
  return { userdb, App: app.App, failures };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.doUnmock('../run/wasm.js');
  vi.restoreAllMocks();
});

describe('bootUserDb — a rejecting backend surfaces load-failed, never a silent fresh DB', () => {
  it('sets status load-failed with the backend message and the extracted file path', async () => {
    const { userdb } = await fresh({ healed: false });
    void userdb.bootUserDb();
    await vi.waitFor(() => {
      expect(userdb.userDbStatusStore.get().state).toBe('load-failed');
    });
    const status = userdb.userDbStatusStore.get();
    if (status.state !== 'load-failed') throw new Error('unreachable');
    expect(status.message).toContain('refusing to treat corruption as a fresh start');
    expect(status.path).toBe('Snug/user.sqlite');
  });

  it('retryUserDbBoot re-attempts the open and recovers once the file is readable again', async () => {
    const behavior = { healed: false };
    const { userdb } = await fresh(behavior);
    void userdb.bootUserDb();
    await vi.waitFor(() => {
      expect(userdb.userDbStatusStore.get().state).toBe('load-failed');
    });

    behavior.healed = true;
    userdb.retryUserDbBoot();
    await vi.waitFor(() => {
      expect(userdb.userDbStatusStore.get().state).toBe('ready');
    });
  });
});

describe('the App screen for a load failure', () => {
  it('plain words: could not be read, NOT overwritten, the path, and a try-again button', async () => {
    const behavior = { healed: false };
    const harness = await fresh(behavior);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <harness.App />
        </MemoryRouter>,
      );
    });
    await vi.waitFor(() => {
      expect(harness.userdb.userDbStatusStore.get().state).toBe('load-failed');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    const text = container?.textContent ?? '';
    expect(text).toMatch(/couldn(’|')t be read/i);
    expect(text).toMatch(/has not been overwritten/i);
    expect(text).toContain('Snug/user.sqlite');

    const retry = [...(container?.querySelectorAll('button') ?? [])].find((b) =>
      /try again/i.test(b.textContent ?? ''),
    );
    expect(retry, 'a try-again affordance must exist').toBeDefined();

    behavior.healed = true;
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(harness.userdb.userDbStatusStore.get().state).toBe('ready');
    });
  });
});
