/**
 * schedulerBoot.test.tsx — TASK-20261009-scheduling-framework E1 (ADR-0074 §5): the scheduler
 * boots from the SHIPPING composition roots, on the `appUpdate.test.tsx` pattern.
 *
 * `initScheduler()` is idempotent and quiet — an unwired boot is indistinguishable from a
 * wired one that found nothing due — so the WIRES carry their own tests: the real `App` is
 * mounted with `../schedule/scheduler.js` replaced by a spy, and the three chains that must
 * call it are driven one by one — the boot effect (after settings hydrate), the recover-fresh
 * chain (the corrupt banner's button) and `restoreUserDbFromBytes` (the torn-file rescue,
 * driven through the REAL boot open over a memory backend).
 *
 * MUTATION TWINS (run during development, each red as predicted): drop the `initScheduler()`
 * line from App.tsx's boot chain ⇒ the first test reds (zero calls); drop it from the
 * recover-fresh chain ⇒ the second reds (one call, not two); drop it from
 * `restoreUserDbFromBytes` ⇒ the third reds.
 *
 * ONE MODULE GRAPH, NO `vi.resetModules()`. Vitest keeps a MOCKED module's instance across a
 * registry reset (the `mock:` cache entries are skipped), so a partially-mocked
 * `state/userdb.js` would keep reading the platform instance it was first bound to while a
 * fresh App read another. The platform is therefore set ONCE, before any test, with the
 * memory backend the restore tests write into; `getPlatform` locks on first read, so that
 * call sits before anything renders or opens.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend, openUserDb } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';

import { setPlatform } from '../platform/platform.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

// These mount the REAL App (the 2026-08-26 db-load flake class): the budget is the fix, not a retry.
vi.setConfig({ testTimeout: 20_000 });

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { initSchedulerSpy, order, recoverFreshMode, nodeLocateWasm } = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    initSchedulerSpy: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    /** The acts in the order they fired — the wire must come AFTER settings hydrate. */
    order: [] as string[],
    recoverFreshMode: { stub: false },
    /** The node locator for the real boot open (the browser `?url` asset does not resolve here). */
    nodeLocateWasm: (): string => require.resolve('sql.js/dist/sql-wasm.wasm'),
  };
});

// The spy IS the scheduler module: nothing of the engine (or the executors it composes) loads here.
// `useScheduler` is the one READ the mounted tree makes at render (the header's running chip
// and nav item, the hub section) — it answers the engine's initial view, so those surfaces
// render their nothing; the acts are referenced on click only and need no stub.
vi.mock('../schedule/scheduler.js', () => ({
  initScheduler: (...args: unknown[]) => {
    order.push('initScheduler');
    return initSchedulerSpy(...(args as []));
  },
  useScheduler: () => ({ ready: false, leader: undefined, tasks: [], runsByTask: {}, state: undefined, pending: 0, unseen: 0, running: undefined, queued: 0 }),
}));

vi.mock('../state/mode.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/mode.js')>();
  return {
    ...original,
    initSettings: async () => {
      await original.initSettings();
      order.push('initSettings');
    },
  };
});

// `recoverFresh` needs a REAL corrupt open to exist; the chain under test is App.tsx's, so the
// act itself is stubbed (flag-controlled) while everything else in the module stays real —
// `restoreUserDbFromBytes` among it, which the third test drives for real.
vi.mock('../state/userdb.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/userdb.js')>();
  return {
    ...original,
    recoverFresh: async () => {
      if (!recoverFreshMode.stub) return original.recoverFresh();
      order.push('recoverFresh');
      return original.getUserDb();
    },
  };
});

vi.mock('../run/wasm.js', () => ({ locateWasm: nodeLocateWasm }));

/** The one backend of this file: the restore tests write a torn file and a backup into it. */
const backend = createMemoryBackend();
setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false }, userdbBackend: backend });

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  localStorage.clear();
  initSchedulerSpy.mockClear();
  order.length = 0;
  recoverFreshMode.stub = false;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mountApp(): Promise<HTMLDivElement> {
  const { App } = await import('../App.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('the boot chain (App.tsx) — the scheduler is wired from the shipping composition root', () => {
  it('mounting App calls initScheduler exactly once, after settings hydrate', async () => {
    await installTestUserDb();
    await mountApp();
    await vi.waitFor(() => expect(initSchedulerSpy).toHaveBeenCalledTimes(1));
    expect(order.indexOf('initSettings')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('initSettings')).toBeLessThan(order.indexOf('initScheduler'));
    expect(initSchedulerSpy).toHaveBeenCalledWith(); // the page's own deps — no overrides from the shell
  });

  it('the recover-fresh chain re-inits the scheduler after settings, app meta and sync', async () => {
    recoverFreshMode.stub = true;
    await installTestUserDb();
    const userdb = await import('../state/userdb.js');
    const el = await mountApp();
    await vi.waitFor(() => expect(initSchedulerSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      userdb.userDbStatusStore.set({ state: 'corrupt', quarantinedFile: 'snug.corrupt-1.sqlite', message: 'unreadable' });
    });
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('start fresh'));
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
    await vi.waitFor(() => expect(initSchedulerSpy).toHaveBeenCalledTimes(2));
    const recovered = order.indexOf('recoverFresh');
    expect(recovered).toBeGreaterThanOrEqual(0);
    expect(order.slice(recovered)).toEqual(['recoverFresh', 'initSettings', 'initScheduler']);
  });
});

describe('restoreUserDbFromBytes (state/userdb.ts) — the restored file gets its scheduler', () => {
  const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0');

  /** Real, openable user-file bytes produced through the production export path. */
  async function goodBackupBytes(): Promise<Uint8Array> {
    const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (result.status !== 'ok') throw new Error(`fixture open failed: ${result.status}`);
    result.userDb.installApp({ displayName: 'Rescued App', html: '<html>backup</html>' });
    return result.userDb.exportUserDb({ includeSecrets: false });
  }

  /** Bytes that pass the magic gate but cannot be opened — the torn file the user is rescuing from. */
  function torn(): Uint8Array {
    const bytes = new Uint8Array(200);
    bytes.set(SQLITE_MAGIC);
    bytes.fill(0xff, SQLITE_MAGIC.length);
    return bytes;
  }

  /** Drive the REAL boot open over the backend's current bytes and wait for it to leave 'opening'. */
  async function bootTorn(userdb: typeof import('../state/userdb.js')): Promise<void> {
    userdb.resetUserDbForTests();
    await backend.save(USERDB_FILE, torn());
    void userdb.bootUserDb();
    await vi.waitFor(() => expect(userdb.userDbStatusStore.get().state).not.toBe('opening'), 15_000);
    expect(userdb.userDbNeedsRestore()).toBe(true);
  }

  it('calls initScheduler once the restored file opened — and not before', async () => {
    const userdb = await import('../state/userdb.js');
    await bootTorn(userdb);
    expect(initSchedulerSpy).not.toHaveBeenCalled();

    await userdb.restoreUserDbFromBytes(await goodBackupBytes());
    expect(userdb.userDbStatusStore.get().state).toBe('ready');
    expect(initSchedulerSpy).toHaveBeenCalledTimes(1);
    const db = await userdb.getUserDb();
    expect(db.listApps().map((a) => a.displayName)).toContain('Rescued App');
  });

  it('a restore that fails calls nothing', async () => {
    const userdb = await import('../state/userdb.js');
    await bootTorn(userdb);
    await expect(userdb.restoreUserDbFromBytes(torn())).rejects.toThrow(/still could not be opened/);
    expect(initSchedulerSpy).not.toHaveBeenCalled();
  });
});
