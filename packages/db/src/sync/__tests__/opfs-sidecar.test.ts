// Umbrella-review Blocker-1 regression (TASK-20260803-portable-hub): the sync
// sidecar must survive the PRODUCTION OPFS backend, whose A/B-slot recovery only
// returns bytes whose first-bytes declare completeness. A bare-JSON sidecar read
// back as never-complete, which killed the content-hash gate across sessions:
// every reload re-pushed and every pristine reconcile screamed divergence.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOpfs } from '../../__tests__/opfsFake.js';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, createOpfsBackend, type PersistenceBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../../userdb/userdb.js';
import { createSyncLoop, type SyncEvent } from '../loop.js';
import { loadSidecar, saveSidecar } from '../sidecar.js';
import type { SyncProvider, SyncPushResult } from '../provider.js';

function fakeOrigin() {
  let stored: { bytes: Uint8Array; revision: string } | undefined;
  let rev = 0;
  const push = vi.fn((bytes: Uint8Array, baseRevision: string | undefined): Promise<SyncPushResult> => {
    if (stored !== undefined && baseRevision !== stored.revision) {
      return Promise.resolve({ ok: false, conflict: true, remoteRevision: stored.revision });
    }
    rev += 1;
    stored = { bytes: bytes.slice(), revision: `r${rev}` };
    return Promise.resolve({ ok: true, revision: stored.revision });
  });
  const provider: SyncProvider = {
    info: () => ({ kind: 'fake', secretsAllowed: false }),
    pull: () =>
      Promise.resolve(stored === undefined ? undefined : { bytes: stored.bytes.slice(), revision: stored.revision }),
    push,
  };
  return { provider, push };
}

let sidecarBackend: PersistenceBackend;
let db: UserDb;

beforeEach(async () => {
  const opfs = fakeOpfs();
  vi.stubGlobal('navigator', { storage: opfs.storage });
  sidecarBackend = createOpfsBackend();
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

describe('sidecar on the production OPFS backend', () => {
  it('round-trips through the A/B-slot completeness check', async () => {
    await saveSidecar(sidecarBackend, 'user.sqlite', { lastPushedRevision: 'r7', lastPushedHash: 'abc' });
    const state = await loadSidecar(sidecarBackend, 'user.sqlite');
    expect(state).toEqual({ lastPushedRevision: 'r7', lastPushedHash: 'abc' });
  });

  it('the content-hash gate survives a "new session": pristine reconcile is silent, no re-push', async () => {
    const origin = fakeOrigin();
    db.setSetting('mode', 'byok');
    const events: SyncEvent[] = [];

    const first = createSyncLoop({ userDb: db, provider: origin.provider, backend: sidecarBackend, onEvent: (e) => events.push(e) });
    await first.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(1);

    // Fresh loop instance over the same sidecar backend — a reload/new login session.
    const second = createSyncLoop({ userDb: db, provider: origin.provider, backend: sidecarBackend, onEvent: (e) => events.push(e) });
    await second.reconcileOnStart();
    expect(events.filter((e) => e.kind === 'divergence')).toHaveLength(0);
    expect(origin.push).toHaveBeenCalledTimes(1); // nothing changed → nothing pushed

    await second.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(1); // hash gate holds across sessions
    await db.close();
  });
});
