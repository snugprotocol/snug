// Child-4 ACs 2,3,4,6 (TASK-20260803-sync-origins): the sync loop over a real UserDb —
// secrets never leave through a hub push, pull-merge preserves local secrets, stale
// baseRevision surfaces divergence (LWW only on explicit action), the content-hash gate
// suppresses no-change pushes, the sidecar lives outside the image, and session-start
// reconcile pushes up over an empty origin (F1). Fake in-memory provider — the provider
// contract itself is proven in providers.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USERDB_FILE, accessGrantSchema, accessLogEntrySchema, type AccessGrant, type AccessLogEntry } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { encryptContainer, generateRecoveryKey } from '../../crypto/container.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../../userdb/userdb.js';
// SYNC_UNANCHORED_HASH: TASK-20261010-host-broker PR-5 (D-PR5-8) — undefined until the loop exports it.
import { SYNC_UNANCHORED_HASH, createSyncLoop, type SyncEvent, type SyncableUserDb } from '../loop.js';
import { loadSidecar, saveSidecar, sha256Hex, sidecarFileFor } from '../sidecar.js';
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

  // TASK-20260804-hub-polish AC21: a provider may report a conflict it cannot name a
  // revision for (hub 412 with no etag and no body revision = "the origin row is gone").
  // The loop must still surface divergence — reaching the resolver, not the error state.
  it('surfaces divergence when the provider reports a conflict with no remote revision (AC21)', async () => {
    const origin = fakeOrigin();
    origin.push.mockResolvedValue({ ok: false, conflict: true });
    db.setSetting('who', 'local');
    await makeLoop(origin).syncNow();
    expect(eventKinds()).toEqual(['divergence']); // divergence, NOT error
    const divergence = events[0] as { kind: string; remoteRevision?: string };
    // The key is absent, not merely undefined — consumers branch on "is the origin named?"
    expect(Object.hasOwn(divergence, 'remoteRevision')).toBe(false);
  });

  // TASK-20260804-hub-polish AC23 (ADR-0009 doctrine): a conflict is NEVER auto-retried
  // and NEVER auto-merged. One push attempt in, one divergence event out — and the next
  // tick must not sneak a second write in either.
  it('never auto-retries a conflict: exactly one push, no import, no second write (AC23)', async () => {
    const origin = fakeOrigin();
    const remoteRevision = origin.seed(await remoteImage((remote) => remote.setSetting('who', 'remote')));
    db.setSetting('who', 'local');
    const loop = makeLoop(origin);
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ kind: 'divergence', remoteRevision });
    // A second tick may re-attempt the SAME conditional push (the hash still differs), but
    // it must never retry with the remote revision — i.e. never turn a conflict into a
    // silent overwrite. Every attempt carries the same (unanchored) baseRevision.
    await loop.syncNow();
    const baseRevisions = origin.push.mock.calls.map((call) => call[1]);
    expect(baseRevisions.every((rev) => rev !== remoteRevision)).toBe(true);
    expect(origin.stored()?.revision).toBe(remoteRevision); // origin never overwritten
    expect(db.getSetting('who')).toBe('local'); // no auto-merge into local either
    expect(eventKinds().filter((k) => k === 'pushed')).toHaveLength(0);
  });

  it('never auto-retries a revision-less conflict either — no silent second PUT (AC23)', async () => {
    const origin = fakeOrigin();
    // Models the hub's "If-Match sent, origin row gone" 412: a conflict with no revision.
    origin.push.mockResolvedValue({ ok: false, conflict: true });
    db.setSetting('who', 'local');
    const loop = makeLoop(origin);
    await loop.syncNow();
    expect(origin.push).toHaveBeenCalledTimes(1);
    expect(eventKinds()).toEqual(['divergence']);
    expect(origin.push.mock.calls[0]?.[1]).toBeUndefined(); // the sidecar's revision, unretried
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

// =================================================================================================
// TASK-20261010-host-broker PR-5 (contract v2 D-PR5-8; AC37's loop half) — two devices, one origin.
// ADR-0009 stays "a divergence the user resolves, not a merge" for DATA; amended by 0076: the ACCESS
// HISTORY is carried both ways and a STOP WINS across a sync.
//  - `pullMerge` (reconcile's pull and *use the origin copy*) passes `carryHistorySince:
//    known.lastSyncAt ?? null` and reads `report?.history` tolerantly; when `carried > 0 ||
//    restopped > 0` it anchors `(remote.revision, SYNC_UNANCHORED_HASH)` — a sentinel no sha256 hex
//    can equal — so the NEXT tick pushes the merged history up;
//  - `pushLocal` (*keep this device's copy*) calls `carryFromImage(remote.bytes, {since})` before it
//    computes its payload, so the origin's lines and revocations ride the push;
//  - a stub whose import answers `undefined` keeps today's anchor; a pristine pull with nothing to
//    carry is byte-identical; a sealed image `carryFromImage` cannot open carries nothing and blocks
//    nothing.
// =================================================================================================

const LEDGER = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';
const BUDGET = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const GRANTED_AT = '2026-10-10T08:00:00.000Z';
const SHA256_HEX = /^[0-9a-f]{64}$/;

const theGrant: AccessGrant = accessGrantSchema.parse({
  id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
  readerAppId: BUDGET,
  sourceAppId: LEDGER,
  scope: { tables: [{ name: 'transactions', columns: ['amount', 'category'] }] },
  access: 'read',
  purpose: 'to show spending by category',
  duration: { kind: 'always' },
  unattended: false,
  status: 'active',
  provenance: 'app',
  readerVersion: 1,
  grantedAt: GRANTED_AT,
  updatedAt: GRANTED_AT,
});

/** An instant `minutes` after now — newer than any `lastSyncAt` a sync in this test anchored. */
const later = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

const readLine = (at: string, sql: string): AccessLogEntry =>
  accessLogEntrySchema.parse({ at, kind: 'read', grantId: theGrant.id, readerAppId: BUDGET, readerName: 'Budget', sql, rows: 1 });

/** Both apps, the grant and its granted line — what both devices hold after the first sync. */
function seedAccess(target: UserDb): void {
  target.installApp({ appId: LEDGER, displayName: 'Ledger', html: '<html>ledger</html>' });
  target.installApp({ appId: BUDGET, displayName: 'Budget', html: '<html>budget</html>' });
  target.putAccessGrant(theGrant);
  target.appendAccessLog(LEDGER, accessLogEntrySchema.parse({ at: GRANTED_AT, kind: 'granted', grantId: theGrant.id, readerAppId: BUDGET, readerName: 'Budget' }));
}

const sqlsOf = (target: UserDb): string[] => target.listAccessLog(LEDGER).flatMap((entry) => (entry.sql === undefined ? [] : [entry.sql]));

/** The origin's current image, opened in a scratch db through a TRUSTED import (no carry): what the origin really holds. */
async function originImage(origin: FakeOrigin): Promise<UserDb> {
  const bytes = origin.stored()?.bytes;
  if (bytes === undefined) throw new Error('origin empty');
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('scratch open failed');
  await result.userDb.importUserDb(bytes, { trustedOrigin: true });
  return result.userDb;
}

interface Device {
  db: UserDb;
  backend: MemoryBackend;
  loop: ReturnType<typeof createSyncLoop>;
}

const devices: Device[] = [];
afterEach(async () => {
  for (const device of devices.splice(0)) await device.db.close();
});

/** Device B: its own file and sidecar, the same origin. */
async function deviceB(origin: FakeOrigin): Promise<Device> {
  const deviceBackend = createMemoryBackend();
  const result = await openUserDb({ backend: deviceBackend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  const device = { db: result.userDb, backend: deviceBackend, loop: createSyncLoop({ userDb: result.userDb, provider: origin.provider, backend: deviceBackend }) };
  devices.push(device);
  return device;
}

/** A (the suite's `db`) seeds and pushes r1; B takes the origin copy. Both now hold the same image. */
async function twoDevices(): Promise<{ origin: FakeOrigin; loopA: ReturnType<typeof makeLoop>; b: Device }> {
  const origin = fakeOrigin();
  const loopA = makeLoop(origin);
  seedAccess(db);
  await loopA.syncNow();
  const b = await deviceB(origin);
  await b.loop.applyRemote();
  expect(b.db.getAccessGrant(theGrant.id)).toEqual(theGrant);
  return { origin, loopA, b };
}

describe('PR-5 — the sentinel anchor (D-PR5-8)', () => {
  it('D-PR5-8 SYNC_UNANCHORED_HASH is exported and is no sha256 hex', () => {
    expect(typeof SYNC_UNANCHORED_HASH).toBe('string');
    expect(SHA256_HEX.test(SYNC_UNANCHORED_HASH)).toBe(false);
  });

  it('D-PR5-8 SYNC_UNANCHORED_HASH is exported from the package index', async () => {
    const index = (await import('../../index.js')) as Record<string, unknown>;
    expect(index.SYNC_UNANCHORED_HASH).toBe(SYNC_UNANCHORED_HASH);
    expect(typeof index.SYNC_UNANCHORED_HASH).toBe('string');
  });

  it('D-PR5-8 pullMerge passes carryHistorySince = the sidecar\'s lastSyncAt (null on a device that never synced)', async () => {
    const origin = fakeOrigin();
    seedAccess(db);
    const loopA = makeLoop(origin);
    await loopA.syncNow();
    const anchoredAt = (await loadSidecar(backend, USERDB_FILE)).lastSyncAt;
    expect(anchoredAt).toBeDefined();

    const seen: unknown[] = [];
    const spy: SyncableUserDb = {
      exportUserDb: (opts) => db.exportUserDb(opts),
      importUserDb: async (bytes, options) => {
        seen.push(options);
        return db.importUserDb(bytes, options as Parameters<UserDb['importUserDb']>[1]);
      },
      listSecretKeys: () => db.listSecretKeys(),
      getSecret: (key) => db.getSecret(key),
      setSecret: (key, value) => db.setSecret(key, value),
      carryFromImage: (bytes: Uint8Array, opts: { since: string | null }) => db.carryFromImage(bytes, opts),
    } as SyncableUserDb;
    await createSyncLoop({ userDb: spy, provider: origin.provider, backend }).applyRemote();
    expect(seen).toEqual([{ trustedOrigin: true, carryHistorySince: anchoredAt }]);

    const fresh = createMemoryBackend();
    seen.length = 0;
    await createSyncLoop({ userDb: spy, provider: origin.provider, backend: fresh }).applyRemote();
    expect(seen).toEqual([{ trustedOrigin: true, carryHistorySince: null }]);
  });

  it('D-PR5-8 a pull that CARRIED anchors the sentinel — the next tick pushes the merged history up', async () => {
    const { origin, loopA, b } = await twoDevices();
    db.appendAccessLog(LEDGER, readLine(later(1), 'SELECT a'));
    b.db.appendAccessLog(LEDGER, readLine(later(2), 'SELECT b'));
    await b.loop.syncNow(); // r2
    await loopA.syncNow(); // A diverged
    expect(eventKinds()).toContain('divergence');

    await loopA.applyRemote();

    expect((await loadSidecar(backend, USERDB_FILE)).lastPushedHash).toBe(SYNC_UNANCHORED_HASH);
    const pushes = origin.push.mock.calls.length;
    await loopA.syncNow();
    expect(origin.push.mock.calls.length).toBe(pushes + 1);
    expect(eventKinds().at(-1)).toBe('pushed');
  });

  it('D-PR5-8 a pull that only RE-STOPPED a grant anchors the sentinel too', async () => {
    const { origin, loopA, b } = await twoDevices();
    const stoppedAt = later(1);
    const stopped = { ...theGrant, status: 'revoked' as const, revokedAt: stoppedAt, updatedAt: stoppedAt };
    db.putAccessGrant(stopped); // no history line: only the tombstone can move
    b.db.setSetting('who', 'B');
    await b.loop.syncNow(); // r2 still carries the grant active
    await loopA.syncNow(); // divergence

    await loopA.applyRemote();

    expect(db.getAccessGrant(theGrant.id)).toEqual(stopped);
    expect((await loadSidecar(backend, USERDB_FILE)).lastPushedHash).toBe(SYNC_UNANCHORED_HASH);
    await loopA.syncNow();
    const image = await originImage(origin);
    expect(image.getAccessGrant(theGrant.id)).toEqual(stopped);
    await image.close();
  });

  it('D-PR5-8 a PRISTINE pull with nothing to carry is today\'s pull — the real hash anchors and the history rows are the origin\'s', async () => {
    const { origin, loopA, b } = await twoDevices();
    b.db.setSetting('who', 'B'); // a change with no access line
    await b.loop.syncNow();

    await loopA.reconcileOnStart(); // A unchanged since its push → pull-merge

    const sidecar = await loadSidecar(backend, USERDB_FILE);
    expect(sidecar.lastPushedHash).not.toBe(SYNC_UNANCHORED_HASH);
    expect(sidecar.lastPushedHash).toBe(await sha256Hex(await db.exportUserDb()));
    expect(db.getSetting(`accessLog:${LEDGER}`)).toEqual(b.db.getSetting(`accessLog:${LEDGER}`));
    const pushes = origin.push.mock.calls.length;
    await loopA.syncNow();
    expect(origin.push.mock.calls.length).toBe(pushes); // nothing to push
  });

  it('D-PR5-8 a stub whose import answers undefined keeps today\'s anchor (the report is read tolerantly)', async () => {
    const { origin, b } = await twoDevices();
    db.appendAccessLog(LEDGER, readLine(later(1), 'SELECT a'));
    b.db.appendAccessLog(LEDGER, readLine(later(2), 'SELECT b'));
    await b.loop.syncNow();
    const stub: SyncableUserDb = {
      exportUserDb: (opts) => db.exportUserDb(opts),
      importUserDb: async (bytes, options) => {
        await db.importUserDb(bytes, options as Parameters<UserDb['importUserDb']>[1]);
        return undefined;
      },
      listSecretKeys: () => db.listSecretKeys(),
      getSecret: (key) => db.getSecret(key),
      setSecret: (key, value) => db.setSecret(key, value),
      carryFromImage: async () => ({ carried: 0, restopped: 0 }),
    } as SyncableUserDb;

    await createSyncLoop({ userDb: stub, provider: origin.provider, backend }).applyRemote();

    const sidecar = await loadSidecar(backend, USERDB_FILE);
    expect(SHA256_HEX.test(sidecar.lastPushedHash ?? '')).toBe(true);
    expect(sidecar.lastPushedHash).toBe(await sha256Hex(await db.exportUserDb()));
  });
});

describe('PR-5 — two-device walks: the history survives either resolution (D-PR5-8, AC37)', () => {
  it('D-PR5-8 *use the origin copy* keeps BOTH devices\' lines — here, at the origin, and on B after its next pull', async () => {
    const { origin, loopA, b } = await twoDevices();
    db.appendAccessLog(LEDGER, readLine(later(1), 'SELECT a'));
    b.db.appendAccessLog(LEDGER, readLine(later(2), 'SELECT b'));
    await b.loop.syncNow();
    await loopA.syncNow();
    expect(eventKinds()).toContain('divergence');

    await loopA.applyRemote();
    expect(sqlsOf(db).sort()).toEqual(['SELECT a', 'SELECT b']);

    await loopA.syncNow(); // the sentinel: the merged history goes up
    const image = await originImage(origin);
    expect(sqlsOf(image).sort()).toEqual(['SELECT a', 'SELECT b']);
    await image.close();

    await b.loop.reconcileOnStart(); // B unchanged since its push → pulls the merged image
    expect(sqlsOf(b.db).sort()).toEqual(['SELECT a', 'SELECT b']);
  });

  it('D-PR5-8 *keep this device\'s copy* keeps the ORIGIN\'s lines — carryFromImage before the push', async () => {
    const { origin, loopA, b } = await twoDevices();
    db.appendAccessLog(LEDGER, readLine(later(1), 'SELECT a'));
    db.setSetting('who', 'A');
    b.db.appendAccessLog(LEDGER, readLine(later(2), 'SELECT b'));
    b.db.setSetting('who', 'B');
    await b.loop.syncNow();
    await loopA.syncNow();
    expect(eventKinds()).toContain('divergence');

    await loopA.pushLocal();

    expect(eventKinds().at(-1)).toBe('pushed');
    expect(db.getSetting('who')).toBe('A'); // this device's data won …
    expect(sqlsOf(db).sort()).toEqual(['SELECT a', 'SELECT b']); // … and the origin's history came along
    const image = await originImage(origin);
    expect(image.getSetting('who')).toBe('A');
    expect(sqlsOf(image).sort()).toEqual(['SELECT a', 'SELECT b']);
    await image.close();
  });

  it('D-PR5-8 B stops → A keeps its copy → after both devices\' next sync BOTH hold the grant revoked', async () => {
    const { origin, loopA, b } = await twoDevices();
    const stoppedAt = later(1);
    const stopped = { ...theGrant, status: 'revoked' as const, revokedAt: stoppedAt, updatedAt: stoppedAt };
    b.db.putAccessGrant(stopped);
    b.db.appendAccessLog(LEDGER, accessLogEntrySchema.parse({ at: stoppedAt, kind: 'revoked', grantId: theGrant.id, readerAppId: BUDGET, readerName: 'Budget', via: 'user' }));
    await b.loop.syncNow();
    db.setSetting('who', 'A'); // A moved too — with the grant still active here
    await loopA.syncNow();
    expect(eventKinds()).toContain('divergence');

    await loopA.pushLocal(); // keep this device's copy

    expect(db.getAccessGrant(theGrant.id)).toEqual(stopped); // the origin's stop won here
    expect(db.listAccessLog(LEDGER).map((entry) => entry.kind)).toContain('revoked');

    await loopA.syncNow();
    await b.loop.reconcileOnStart();

    expect(b.db.getAccessGrant(theGrant.id)?.status).toBe('revoked');
    expect(db.getAccessGrant(theGrant.id)?.status).toBe('revoked');
    const image = await originImage(origin);
    expect(image.getAccessGrant(theGrant.id)?.status).toBe('revoked');
    await image.close();
  });

  it('D-PR5-8 guard: a SEALED origin image carryFromImage cannot open blocks nothing — *keep this device\'s copy* still pushes', async () => {
    const origin = fakeOrigin();
    const sealed = await encryptContainer(await remoteImage((remote) => remote.setSetting('who', 'remote')), { passphrase: 'another device\'s', recoveryKey: generateRecoveryKey() });
    origin.seed(sealed);
    seedAccess(db);
    db.setSetting('who', 'local');

    await makeLoop(origin).pushLocal();

    expect(eventKinds()).toEqual(['pushed']);
    expect(await remoteImageRoundTrip(origin)).toBe('local');
    expect(db.getAccessGrant(theGrant.id)).toEqual(theGrant);
  });
});
