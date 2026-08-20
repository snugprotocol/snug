// Platform persistence-backend seam (TASK-20260812 W2b; Decision 7). The desktop
// shell stores the user file at ~/Snug through ONE backend, and BOTH consumers must
// share it: the userdb open (`bootUserDb`) and the sync loop's push-state sidecar
// (`startLoop`'s `createSyncLoop({ backend })`). A platform backend that reached only
// one of the two would split the A/B-slot safe-write story across stores.
//
// The platform is set-once/set-before-first-read, so every case takes a fresh module
// registry (the platform.test.ts pattern) and imports its consumers dynamically.
import { createRequire } from 'node:module';

import type { PersistenceBackend } from '@snugprotocol/db';
import { describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

const require = createRequire(import.meta.url);
const nodeLocateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

interface RecordingBackend {
  backend: PersistenceBackend;
  calls: string[];
}

/** Memory-backed 'file'-kind backend that records every load/save with its file name. */
function recordingBackend(): RecordingBackend {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  return {
    calls,
    backend: {
      kind: 'file',
      load: (file) => {
        calls.push(`load:${file}`);
        return Promise.resolve(files.get(file));
      },
      save: (file, bytes) => {
        calls.push(`save:${file}`);
        files.set(file, bytes);
        return Promise.resolve();
      },
    },
  };
}

function desktopPlatform(
  backend: PersistenceBackend,
  capabilities: SnugPlatform['capabilities'] = { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
): SnugPlatform {
  return { kind: 'desktop', userdbBackend: backend, capabilities };
}

describe('platform userdb backend — bootUserDb (W2b item 1)', () => {
  it('opens the user DB through the platform backend when one is set', async () => {
    vi.resetModules();
    const recording = recordingBackend();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform(desktopPlatform(recording.backend));
    // bootUserDb hardcodes the bundler wasm locator; swap in the node one for jsdom.
    vi.doMock('../run/wasm.js', () => ({ locateWasm: nodeLocateWasm }));

    const userdb = await import('../state/userdb.js');
    await userdb.bootUserDb();

    expect(recording.calls, 'the userdb open must read through the platform backend').toContain('load:user.snug');
    // ADR-0042: when the canonical file is absent the open ALSO probes the pre-rename
    // name through the same backend, which is what carries an upgrading user's data
    // forward instead of silently handing them an empty database.
    expect(recording.calls, 'the legacy name must be probed through the backend too').toContain('load:user.sqlite');
    expect(userdb.userDbStatusStore.get()).toEqual({ state: 'ready' });
    vi.doUnmock('../run/wasm.js');
  });
});

describe('platform userdb backend — the sync sidecar (W2b item 1)', () => {
  it('the sync loop reads AND writes its sidecar through the same platform backend', async () => {
    vi.resetModules();
    const recording = recordingBackend();
    const platformModule = await import('../platform/platform.js');
    // hubSyncOrigin stays true in this fake: the seam under test is the BACKEND
    // threading, and the hub provider is the one with an easily-faked fetch surface.
    platformModule.setPlatform(
      desktopPlatform(recording.backend, { subscriptionMode: false, hubSyncOrigin: true, lanHttpPrivate: true }),
    );
    const helper = await import('./userdbTestHelper.js');
    await helper.installTestUserDb();
    const sync = await import('../state/sync.js');

    document.cookie = 'snug_csrf=csrf-for-tests';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/userdb' && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(new Response(null, { status: 404 })); // origin empty → push follows
      }
      if (url === '/userdb' && init?.method === 'PUT') {
        return Promise.resolve(new Response('', { status: 200, headers: { etag: 'rev-1' } }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    await sync.setSyncOrigin('hub');

    expect(recording.calls, 'sidecar read must hit the platform backend').toContain('load:user.snug.sync.json');
    expect(recording.calls, 'sidecar write must hit the platform backend').toContain('save:user.snug.sync.json');
    vi.restoreAllMocks();
  });
});

describe('hub sync origin refused on desktop (W2b item 2; P0 amendment 13)', () => {
  it('an imported config with kind:hub surfaces an honest unavailable state and never builds a loop', async () => {
    vi.resetModules();
    const recording = recordingBackend();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform(desktopPlatform(recording.backend));
    const helper = await import('./userdbTestHelper.js');
    const db = await helper.installTestUserDb();
    const sync = await import('../state/sync.js');

    const pageFetch = vi.spyOn(globalThis, 'fetch');
    db.setSyncConfig('origin', { kind: 'hub' });
    await sync.initSync();

    const status = sync.syncStatusStore.get();
    expect(status.origin).toBe('hub');
    expect(status.state).toBe('error');
    expect(status.detail).toContain('not available in the desktop app');
    expect(pageFetch, 'no loop may be built against an unavailable origin').not.toHaveBeenCalled();
    pageFetch.mockRestore();
  });

  it('web default: initSync with a hub config still starts the loop (AC10)', async () => {
    vi.resetModules();
    const helper = await import('./userdbTestHelper.js');
    const db = await helper.installTestUserDb();
    const sync = await import('../state/sync.js');

    document.cookie = 'snug_csrf=csrf-for-tests';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/userdb' && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url === '/userdb' && init?.method === 'PUT') {
        return Promise.resolve(new Response('', { status: 200, headers: { etag: 'rev-1' } }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    db.setSyncConfig('origin', { kind: 'hub' });
    await sync.initSync();

    expect(sync.syncStatusStore.get()).toEqual({ origin: 'hub', state: 'idle', detail: undefined });
    vi.restoreAllMocks();
  });
});
