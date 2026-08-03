// Child-4 ACs 2,3,4,6 (TASK-20260803-sync-origins): the sync loop over a real UserDb —
// secrets never leave through a hub push, pull-merge preserves local secrets, stale
// baseRevision surfaces divergence (LWW only on explicit action), the content-hash gate
// suppresses no-change pushes, the sidecar lives outside the image, and session-start
// reconcile pushes up over an empty origin (F1). Fake in-memory provider — the provider
// contract itself is proven in providers.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../../userdb/userdb.js';
import { createSyncLoop, type SyncEvent } from '../loop.js';
import { loadSidecar, saveSidecar, sidecarFileFor } from '../sidecar.js';
import type { SyncProvider, SyncPushResult } from '../provider.js';

const SIDECAR_FILE = `${USERDB_FILE}.sync.json`;
const PLANTED_SECRET = 'sk-planted-super-secret-value';

// Captured before any vi.useFakeTimers so it always schedules on the REAL event loop:
// a sync tick's chain crosses real async hops (crypto.subtle.digest), which fake-timer
// advancement alone does not drain.
const realSetTimeout = globalThis.setTimeout;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
};

interface FakeOrigin {
  provider: SyncProvider;
  push: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  /** Sets origin content directly (simulating another device); returns the new revision. */
  seed(bytes: Uint8Array): string;
  stored(): { bytes: Uint8Array; revision: string } | undefined;
}

function fakeOrigin(opts: { secretsAllowed?: boolean } = {}): FakeOrigin {
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
  const pull = vi.fn(() =>
    Promise.resolve(stored === undefined ? undefined : { bytes: stored.bytes.slice(), revision: stored.revision }),
  );
  return {
    provider: {
      info: () => ({ kind: 'fake', secretsAllowed: opts.secretsAllowed === true }),
      pull,
      push,
    },
    push,
    pull,
    seed(bytes) {
      rev += 1;
      stored = { bytes: bytes.slice(), revision: `r${rev}` };
      return stored.revision;
    },
    stored: () => stored,
  };
}

/** Export bytes of a throwaway user DB shaped by `build` — the "other device" image. */
async function remoteImage(build: (db: UserDb) => void): Promise<Uint8Array> {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('scratch open failed');
  build(result.userDb);
  const bytes = await result.userDb.exportUserDb();
  await result.userDb.close();
  return bytes;
}

let backend: MemoryBackend;
let db: UserDb;
let events: SyncEvent[];

beforeEach(async () => {
  backend = createMemoryBackend();
  events = [];
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

afterEach(async () => {
  vi.useRealTimers();
  await db.close();
});

const makeLoop = (origin: FakeOrigin, overrides: Record<string, unknown> = {}) =>
  createSyncLoop({
    userDb: db,
    provider: origin.provider,
    backend,
    onEvent: (event) => events.push(event),
    ...overrides,
  });

const eventKinds = (): string[] => events.map((e) => e.kind);

describe('sidecar (push-state outside the image, F5)', () => {
  it('derives <file>.sync.json and round-trips state', async () => {
    expect(sidecarFileFor(USERDB_FILE)).toBe(SIDECAR_FILE);
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual({});
    const state = { lastPushedRevision: 'r1', lastPushedHash: 'abc', lastSyncAt: '2026-08-03T00:00:00.000Z' };
    await saveSidecar(backend, USERDB_FILE, state);
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual(state);
    expect(backend.files.has(SIDECAR_FILE)).toBe(true);
  });

  it('treats corrupt or foreign sidecar bytes as empty state (fail-safe: never auto-pull)', async () => {
    await backend.save(SIDECAR_FILE, new TextEncoder().encode('not json'));
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual({});
    await backend.save(SIDECAR_FILE, new TextEncoder().encode('{"lastPushedRevision":42,"lastPushedHash":"ok"}'));
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual({ lastPushedHash: 'ok' });
  });

  it('saving the sidecar never dirties the user-DB image (export bytes stay identical)', async () => {
    db.setSetting('mode', 'byok');
    await db.flush();
    const imageBefore = backend.files.get(USERDB_FILE);
    const exportBefore = await db.exportUserDb();
    await saveSidecar(backend, USERDB_FILE, { lastPushedRevision: 'r1', lastPushedHash: 'h1' });
    await db.flush();
    expect(backend.files.get(USERDB_FILE)).toEqual(imageBefore);
    expect(await db.exportUserDb()).toEqual(exportBefore);
  });
});

describe('secrets posture (AC2)', () => {
  it('hub-style push payloads contain zero secret bytes even when includeSecrets is requested', async () => {
    db.setSecret('anthropicKey', PLANTED_SECRET);
    db.setSetting('mode', 'byok');
    const origin = fakeOrigin({ secretsAllowed: false });
    // includeSecrets is only honored when the provider allows secrets — hub never does.
    await makeLoop(origin, { includeSecrets: true }).syncNow();
    expect(origin.push).toHaveBeenCalledTimes(1);
    const pushed = origin.stored();
    expect(pushed).toBeDefined();
    expect(new TextDecoder('latin1').decode(pushed?.bytes).includes(PLANTED_SECRET)).toBe(false);
  });

  it('includeSecrets is honored for a secrets-allowed origin (explicit opt-in, personal storage)', async () => {
    db.setSecret('anthropicKey', PLANTED_SECRET);
    const origin = fakeOrigin({ secretsAllowed: true });
    await makeLoop(origin, { includeSecrets: true }).syncNow();
    expect(new TextDecoder('latin1').decode(origin.stored()?.bytes).includes(PLANTED_SECRET)).toBe(true);
  });

  it('local secrets survive a push → pull-merge round-trip (pull is a merge, never a swap)', async () => {
    db.setSecret('anthropicKey', PLANTED_SECRET);
    db.setSetting('who', 'local');
    const origin = fakeOrigin();
    const loop = makeLoop(origin);
    await loop.syncNow(); // origin now holds the stripped local image
    origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    await loop.applyRemote();
    expect(db.getSetting('who')).toBe('remote'); // remote image applied…
    expect(db.getSecret('anthropicKey')).toBe(PLANTED_SECRET); // …but local secrets won
  });
});

describe('divergence (AC3): surfaced, never auto-resolved', () => {
  it('a stale baseRevision push emits a divergence event and does not overwrite the origin', async () => {
    const origin = fakeOrigin();
    const remoteRevision = origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    db.setSetting('who', 'local');
    await makeLoop(origin).syncNow(); // sidecar has no lastPushedRevision → conflicts with the seeded origin
    expect(events).toContainEqual({ kind: 'divergence', remoteRevision });
    expect(origin.stored()?.revision).toBe(remoteRevision); // origin untouched
    expect(db.getSetting('who')).toBe('local'); // local untouched
  });

  it('explicit pushLocal() applies local-wins over the current remote revision', async () => {
    const origin = fakeOrigin();
    origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    db.setSetting('who', 'local');
    const loop = makeLoop(origin);
    await loop.syncNow();
    expect(eventKinds()).toContain('divergence');
    await loop.pushLocal();
    expect(eventKinds()).toContain('pushed');
    const pushCount = origin.push.mock.calls.length;
    // origin now holds the local image and the sidecar is anchored: nothing further to push
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(pushCount);
    const restored = await remoteImageRoundTrip(origin);
    expect(restored).toBe('local');
  });

  it('explicit applyRemote() applies remote-wins while keeping local secrets', async () => {
    const origin = fakeOrigin();
    origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    db.setSetting('who', 'local');
    db.setSecret('anthropicKey', PLANTED_SECRET);
    const loop = makeLoop(origin);
    await loop.syncNow();
    expect(eventKinds()).toContain('divergence');
    await loop.applyRemote();
    expect(db.getSetting('who')).toBe('remote');
    expect(db.getSecret('anthropicKey')).toBe(PLANTED_SECRET);
    // anchored on the pulled revision: an unchanged image does not push
    const pushCount = origin.push.mock.calls.length;
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(pushCount);
  });
});

/** Pulls the origin image into a scratch UserDb and reads back the `who` setting. */
async function remoteImageRoundTrip(origin: FakeOrigin): Promise<unknown> {
  const bytes = origin.stored()?.bytes;
  if (bytes === undefined) throw new Error('origin empty');
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('scratch open failed');
  await result.userDb.importUserDb(bytes);
  const who = result.userDb.getSetting('who');
  await result.userDb.close();
  return who;
}

describe('content-hash gate (AC4)', () => {
  it('two syncNow() calls with no changes push exactly once', async () => {
    db.setSetting('mode', 'byok');
    const origin = fakeOrigin();
    const loop = makeLoop(origin);
    await loop.syncNow();
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(1);
    db.setSetting('mode', 'local');
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(2);
  });

  it('interval ticks are hash-gated and stop() clears the timer', async () => {
    db.setSetting('mode', 'byok');
    const origin = fakeOrigin();
    const loop = makeLoop(origin, { intervalMs: 1000 });
    vi.useFakeTimers();
    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(origin.push).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); // unchanged content → gated
    await settle();
    expect(origin.push).toHaveBeenCalledTimes(1);
    db.setSetting('mode', 'local');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(origin.push).toHaveBeenCalledTimes(2);
    loop.stop();
    db.setSetting('mode', 'hub');
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(origin.push).toHaveBeenCalledTimes(2); // stopped: no further ticks
  });

  it('registers no pagehide/lifecycle listeners (no pagehide network push, ADR-0009)', () => {
    const registered: string[] = [];
    const target = {
      addEventListener: (type: string) => registered.push(type),
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', target);
    try {
      const loop = makeLoop(fakeOrigin());
      loop.start();
      loop.stop();
      expect(registered).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('reconcileOnStart (AC6, F1)', () => {
  it('pushes up when the origin is empty — an empty origin never clobbers local state', async () => {
    db.setSetting('who', 'local');
    const origin = fakeOrigin();
    await makeLoop(origin).reconcileOnStart();
    expect(origin.push).toHaveBeenCalledTimes(1);
    expect(eventKinds()).toContain('pushed');
    expect(origin.stored()).toBeDefined();
  });

  it('pushes up when local changed and the origin still sits at our last-pushed revision', async () => {
    db.setSetting('who', 'local');
    const origin = fakeOrigin();
    const loop = makeLoop(origin);
    await loop.syncNow();
    db.setSetting('who', 'local-2'); // e.g. changes flushed to OPFS after the last network push
    await loop.reconcileOnStart();
    expect(origin.push).toHaveBeenCalledTimes(2);
    expect(await remoteImageRoundTrip(origin)).toBe('local-2');
  });

  it('pull-merges when the origin is newer and local is unchanged since the last push', async () => {
    db.setSetting('who', 'local');
    db.setSecret('anthropicKey', PLANTED_SECRET);
    const origin = fakeOrigin();
    const loop = makeLoop(origin);
    await loop.syncNow();
    const remoteRevision = origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    await loop.reconcileOnStart();
    expect(db.getSetting('who')).toBe('remote');
    expect(db.getSecret('anthropicKey')).toBe(PLANTED_SECRET);
    expect(eventKinds()).toContain('pulled');
    // anchored on the pulled revision: no immediate push-back
    const pushCount = origin.push.mock.calls.length;
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(pushCount);
    expect(origin.stored()?.revision).toBe(remoteRevision);
  });

  it('surfaces divergence when BOTH sides changed — no pull, no push, no data movement', async () => {
    db.setSetting('who', 'local');
    const origin = fakeOrigin();
    const loop = makeLoop(origin);
    await loop.syncNow();
    const remoteRevision = origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    db.setSetting('who', 'local-2');
    await loop.reconcileOnStart();
    expect(events).toContainEqual({ kind: 'divergence', remoteRevision });
    expect(db.getSetting('who')).toBe('local-2'); // no import happened
    expect(origin.push).toHaveBeenCalledTimes(1); // no push happened
    expect(origin.stored()?.revision).toBe(remoteRevision);
  });
});
