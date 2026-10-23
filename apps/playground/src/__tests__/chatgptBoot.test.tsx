/**
 * chatgptBoot.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L4 (plan §4 row 5; §11 L4-6,
 * L4-11; Gate-2 finding F9).
 *
 * THE BOOT ORDER. The scheduler's launch catch-up runs whatever was due while the app was
 * closed; on a chatgpt file its gate reads the keeper, and a keeper whose first store read has
 * not answered is `'unknown'` — WAIT, never "signed out". So every composition root that starts
 * the scheduler builds the keeper and awaits its first read FIRST: App.tsx's boot chain (between
 * the settings hydrate and `initScheduler()`), the recover-fresh chain and
 * `restoreUserDbFromBytes`. Mutation each row catches: `initScheduler()` called before the read
 * answers (a catch-up refusing a valid session), or the keeper never booted at all.
 *
 * The `schedulerBoot.test.tsx` pattern: the REAL App mounted, `../schedule/scheduler.js`
 * replaced by a spy, ONE module graph; `../state/chatgptPlan.js` partially mocked so the boot
 * and the first-read gate are controlled here (`bootChatgptPlan` records; `chatgptPlanReady`
 * — and the boot's own promise — answer one deferred the test resolves). Either way of waiting
 * (awaiting the boot, or `chatgptPlanReady()`) satisfies the rows; never awaiting does not.
 *
 * RED until `state/chatgptPlan.ts` exists and the three chains await it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend, openUserDb } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';

import { setPlatform } from '../platform/platform.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

vi.setConfig({ testTimeout: 20_000 });

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Gate {
  promise: Promise<void>;
  resolve(): void;
}

const h = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const order: string[] = [];
  const newGate = (): Gate => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r)).then(() => void order.push('chatgptPlanReady'));
    return { promise, resolve };
  };
  return {
    order,
    newGate,
    gate: newGate(),
    initSchedulerSpy: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    bootSpy: vi.fn(),
    recoverFreshMode: { stub: false },
    nodeLocateWasm: (): string => require.resolve('sql.js/dist/sql-wasm.wasm'),
  };
});

vi.mock('../schedule/scheduler.js', () => ({
  initScheduler: (...args: unknown[]) => {
    h.order.push('initScheduler');
    return h.initSchedulerSpy(...(args as []));
  },
  useScheduler: () => ({ ready: false, leader: undefined, tasks: [], runsByTask: {}, state: undefined, pending: 0, unseen: 0, running: undefined, queued: 0 }),
}));

vi.mock('../state/chatgptPlan.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/chatgptPlan.js')>();
  return {
    ...original,
    bootChatgptPlan: (...args: unknown[]) => {
      h.order.push('bootChatgptPlan');
      h.bootSpy(...args);
      return h.gate.promise;
    },
    chatgptPlanReady: () => h.gate.promise,
  };
});

vi.mock('../state/mode.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/mode.js')>();
  return {
    ...original,
    initSettings: async () => {
      await original.initSettings();
      h.order.push('initSettings');
    },
  };
});

vi.mock('../state/userdb.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/userdb.js')>();
  return {
    ...original,
    recoverFresh: async () => {
      if (!h.recoverFreshMode.stub) return original.recoverFresh();
      h.order.push('recoverFresh');
      return original.getUserDb();
    },
  };
});

vi.mock('../run/wasm.js', () => ({ locateWasm: h.nodeLocateWasm }));

const backend = createMemoryBackend();
setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false }, userdbBackend: backend });

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  localStorage.clear();
  h.initSchedulerSpy.mockClear();
  h.bootSpy.mockClear();
  h.order.length = 0;
  h.recoverFreshMode.stub = false;
  h.gate = h.newGate();
});

afterEach(() => {
  h.gate.resolve(); // never leave a chain parked across tests
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

/** Let every chain that is not parked on the gate run to wherever it parks. */
async function drain(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('the boot chain (App.tsx) — the keeper’s first read answers before the scheduler starts (L4-6)', () => {
  it('boots the keeper once and holds initScheduler until the first read answers', async () => {
    await installTestUserDb();
    await mountApp();
    await vi.waitFor(() => expect(h.order).toContain('initSettings'));
    await drain();
    expect(h.bootSpy).toHaveBeenCalledTimes(1);
    expect(h.initSchedulerSpy, 'a catch-up must not start while the keeper is unknown').not.toHaveBeenCalled();

    await act(async () => {
      h.gate.resolve();
    });
    await vi.waitFor(() => expect(h.initSchedulerSpy).toHaveBeenCalledTimes(1));
    expect(h.order.indexOf('initSettings')).toBeLessThan(h.order.indexOf('initScheduler'));
    expect(h.order.indexOf('chatgptPlanReady')).toBeLessThan(h.order.indexOf('initScheduler'));
  });

  it('the recover-fresh chain waits for the keeper too before re-initing the scheduler', async () => {
    h.recoverFreshMode.stub = true;
    await installTestUserDb();
    const userdb = await import('../state/userdb.js');
    const el = await mountApp();
    await act(async () => {
      h.gate.resolve();
    });
    await vi.waitFor(() => expect(h.initSchedulerSpy).toHaveBeenCalledTimes(1));

    h.gate = h.newGate(); // the keeper's answer is pending again for this chain
    await act(async () => {
      userdb.userDbStatusStore.set({ state: 'corrupt', quarantinedFile: 'snug.corrupt-1.sqlite', message: 'unreadable' });
    });
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('start fresh'));
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
    await drain();
    expect(h.initSchedulerSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      h.gate.resolve();
    });
    await vi.waitFor(() => expect(h.initSchedulerSpy).toHaveBeenCalledTimes(2));
    const recovered = h.order.indexOf('recoverFresh');
    expect(h.order.slice(recovered).indexOf('chatgptPlanReady')).toBeLessThan(h.order.slice(recovered).lastIndexOf('initScheduler'));
  });
});

describe('restoreUserDbFromBytes — the restored file’s scheduler waits for the keeper too (L4-6)', () => {
  const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0');

  async function goodBackupBytes(): Promise<Uint8Array> {
    const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (result.status !== 'ok') throw new Error(`fixture open failed: ${result.status}`);
    result.userDb.installApp({ displayName: 'Rescued App', html: '<html>backup</html>' });
    return result.userDb.exportUserDb({ includeSecrets: false });
  }

  function torn(): Uint8Array {
    const bytes = new Uint8Array(200);
    bytes.set(SQLITE_MAGIC);
    bytes.fill(0xff, SQLITE_MAGIC.length);
    return bytes;
  }

  it('calls initScheduler only after the keeper’s first read answered', async () => {
    const userdb = await import('../state/userdb.js');
    userdb.resetUserDbForTests();
    await backend.save(USERDB_FILE, torn());
    void userdb.bootUserDb();
    await vi.waitFor(() => expect(userdb.userDbStatusStore.get().state).not.toBe('opening'), 15_000);
    expect(userdb.userDbNeedsRestore()).toBe(true);

    const restoring = userdb.restoreUserDbFromBytes(await goodBackupBytes());
    await drain();
    expect(h.initSchedulerSpy).not.toHaveBeenCalled();
    h.gate.resolve();
    await restoring;
    await vi.waitFor(() => expect(h.initSchedulerSpy).toHaveBeenCalledTimes(1));
    expect(h.order.indexOf('chatgptPlanReady')).toBeLessThan(h.order.indexOf('initScheduler'));
  });
});
