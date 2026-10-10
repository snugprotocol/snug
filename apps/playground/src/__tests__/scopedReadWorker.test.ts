// scopedReadWorker.test.ts — the scoped read's host side and its Worker (TASK-20261010-cross-app-
// access AC12; ADR-0075 §6; D10 — a security blocker of the plan review: sql.js has no interrupt,
// so an app-authored read runs in a dedicated Worker with its OWN sql.js under a wall clock).
//
// The Worker is injected as a `WorkerLike` (vitest has no Worker): the INLINE one runs the real
// worker module's responder — `scopedScratchRead` on node sql.js — so a success here is the
// worker's own code path; the SILENT one never answers (the wall clock); the THROWING one fails
// (a wasm abort). Rows pinned: success and one init per worker; the bytes posted as a transferred
// COPY so the cache is never detached; the timeout terminates the worker and the next read gets a
// FRESH one (mutation: skip the terminate → red); the 10 s per-grant bytes cache; the no-Worker
// refusal; a thrown worker → `failed` and a fresh worker; an entry past the window is EVICTED by
// the next read of any grant (a stale copy — up to 16 MiB — is never held for the session).
// W6 fix lane: an idle entry's own timer evicts it (mutation: no timer → the idle row reds); a
// queued read re-checks its grant when it dequeues (mutation: skip `stillLive` → the queued row
// reds); an engine that fails to start retires its worker (mutation: settle without retiring →
// the engine row reds).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { ACCESS_MAX_RESULT_BYTES, ACCESS_MAX_ROWS, ACCESS_QUERY_TIMEOUT_MS, ACCESS_SCOPED_CACHE_MS } from '@snugprotocol/protocol';

import {
  __scopedReadCachedGrantsForTests,
  canConstructWorker,
  clearScopedReadCache,
  configureScopedRead,
  resetScopedReadForTests,
  scopedRead,
  type WorkerLike,
} from '../access/scopedRead.js';
import { createScopedReadResponder, loadEngine } from '../access/scopedRead.worker.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

const CAPS = { maxRows: ACCESS_MAX_ROWS, maxBytes: ACCESS_MAX_RESULT_BYTES };
const SCOPE = { tables: [{ name: 'transactions', columns: ['id', 'amount'] }] };

let sourceBytes: Uint8Array;

/** A source app's live runtime bytes, made the way the engine meets them: through the user db. */
beforeAll(async () => {
  const db = await installTestUserDb();
  const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)']);
  for (const sql of ['INSERT INTO transactions (amount) VALUES (450), (500)', "INSERT INTO accounts VALUES ('main', 9000)"]) {
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: sql.slice(0, 20), instanceId: 'seed', op: 'exec', sql });
  }
  sourceBytes = await db.exportAppRuntime(ledger);
});

interface Recorder {
  created: number;
  terminated: number;
  posted: Array<{ msg: unknown; transfer?: Transferable[] }>;
}

/** A WorkerLike that runs the real worker module's responder inline, answering asynchronously like a Worker. */
function inlineWorkers(recorder: Recorder): () => WorkerLike {
  return () => {
    recorder.created += 1;
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg, transfer) {
        recorder.posted.push({ msg, transfer });
        void respond(msg).then((answer) => {
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        });
      },
      terminate() {
        recorder.terminated += 1;
      },
    };
    return worker;
  };
}

/** A WorkerLike that never answers — an unbounded `WITH RECURSIVE`, as far as the host can tell. */
function silentWorkers(recorder: Recorder): () => WorkerLike {
  return () => {
    recorder.created += 1;
    return {
      onmessage: null,
      onerror: null,
      postMessage(msg, transfer) {
        recorder.posted.push({ msg, transfer });
      },
      terminate() {
        recorder.terminated += 1;
      },
    };
  };
}

/** A WorkerLike whose job throws (a wasm abort surfaces as the worker's error event). */
function throwingWorkers(recorder: Recorder): () => WorkerLike {
  return () => {
    recorder.created += 1;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg, transfer) {
        recorder.posted.push({ msg, transfer });
        if (typeof msg === 'object' && msg !== null && 'id' in msg) setTimeout(() => worker.onerror?.(new Error('RuntimeError: abort')), 0);
      },
      terminate() {
        recorder.terminated += 1;
      },
    };
    return worker;
  };
}

const newRecorder = (): Recorder => ({ created: 0, terminated: 0, posted: [] });
const jobsOf = (recorder: Recorder) => recorder.posted.filter((entry) => typeof entry.msg === 'object' && entry.msg !== null && 'id' in entry.msg);
const initsOf = (recorder: Recorder) => recorder.posted.filter((entry) => typeof entry.msg === 'object' && entry.msg !== null && 'init' in entry.msg);

let clock: { now: number };

beforeEach(() => {
  resetScopedReadForTests();
  clock = { now: 1_000_000 };
});

afterEach(() => {
  resetScopedReadForTests();
  vi.unstubAllGlobals();
});

const read = (grantId: string, sql: string, bytes: () => Promise<Uint8Array> = () => Promise.resolve(sourceBytes)) =>
  scopedRead({ grantId, bytes, scope: SCOPE, statement: { sql }, caps: CAPS });

describe('the inline worker — the real responder on its own sql.js', () => {
  it('answers the scoped read; ONE worker, initialised ONCE with the engine source, serves consecutive reads', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await read('g1', 'SELECT amount FROM transactions ORDER BY amount')).toEqual({ ok: true, columns: ['amount'], rows: [[450], [500]] });
    expect(await read('g1', 'SELECT count(*) AS n FROM transactions')).toEqual({ ok: true, columns: ['n'], rows: [[2]] });
    expect(recorder.created).toBe(1);
    expect(initsOf(recorder).map((entry) => entry.msg)).toEqual([{ init: { wasmUrl: locateWasm() } }]);
  });

  it('a table outside the grant is ABSENT in the copy — the engine’s own answer, passed through', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const outcome = await read('g1', 'SELECT * FROM accounts');
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect(outcome.ok ? '' : outcome.message).toContain('no such table');
  });

  it('drift and refusals pass through as the engine reports them', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await read('g1', 'DELETE FROM transactions')).toMatchObject({ ok: false, reason: 'refused' });
    const drifted = await scopedRead({
      grantId: 'g2',
      bytes: () => Promise.resolve(sourceBytes),
      scope: { tables: [{ name: 'transactions', columns: ['id', 'amount', 'note'] }] },
      statement: { sql: 'SELECT 1' },
      caps: CAPS,
    });
    expect(drifted).toMatchObject({ ok: false, reason: 'drift', drift: { added: [], removed: ['transactions.note'] } });
  });

  it('posts the bytes as a TRANSFERRED COPY — the cached bytes are never detached, so the next read from the cache still works', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const held = sourceBytes.slice();
    await read('g1', 'SELECT 1', () => Promise.resolve(held));
    const [job] = jobsOf(recorder);
    const posted = (job?.msg as { bytes: Uint8Array }).bytes;
    expect(posted).not.toBe(held);
    expect(job?.transfer).toEqual([posted.buffer]);
    expect(await read('g1', 'SELECT count(*) FROM transactions', () => Promise.reject(new Error('the cache should answer')))).toMatchObject({ ok: true, rows: [[2]] });
  });
});

describe('the wall clock — terminate, then a fresh worker', () => {
  it('a read that never answers is cut at the timeout: { reason: timeout }, the worker TERMINATED, and the next read builds a fresh one and re-initialises it', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: silentWorkers(recorder), wasm: { wasmUrl: locateWasm() }, timeoutMs: 25, now: () => clock.now });
    const started = Date.now();
    expect(await read('g1', 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r')).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(ACCESS_QUERY_TIMEOUT_MS);
    expect(recorder.terminated).toBe(1);
    expect(recorder.created).toBe(1);

    expect(await read('g1', 'SELECT 1')).toMatchObject({ ok: false, reason: 'timeout' });
    expect(recorder.created, 'a terminated worker is never reused').toBe(2);
    expect(recorder.terminated).toBe(2);
    expect(initsOf(recorder)).toHaveLength(2);
  });

  it('the production default is the protocol’s 2 s bound', () => {
    expect(ACCESS_QUERY_TIMEOUT_MS).toBe(2000);
  });

  it('a thrown worker (a wasm abort) answers failed, is terminated, and is replaced on the next read', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: throwingWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await read('g1', 'SELECT 1')).toMatchObject({ ok: false, reason: 'failed' });
    expect(recorder.terminated).toBe(1);
    await read('g1', 'SELECT 1');
    expect(recorder.created).toBe(2);
  });

  it('reads are serialised: a second read waits for the first and gets its own full clock', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const [first, second] = await Promise.all([read('g1', 'SELECT 1 AS a'), read('g2', 'SELECT 2 AS b')]);
    expect(first).toEqual({ ok: true, columns: ['a'], rows: [[1]] });
    expect(second).toEqual({ ok: true, columns: ['b'], rows: [[2]] });
  });
});

describe('the per-grant bytes cache', () => {
  it('within 10 s a grant’s bytes are fetched once; after 10 s they are fetched again; grants never share an entry', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const fetches: string[] = [];
    const bytesFor = (grantId: string) => () => {
      fetches.push(grantId);
      return Promise.resolve(sourceBytes);
    };
    await read('g1', 'SELECT 1', bytesFor('g1'));
    clock.now += ACCESS_SCOPED_CACHE_MS - 1;
    await read('g1', 'SELECT 1', bytesFor('g1'));
    expect(fetches).toEqual(['g1']);
    await read('g2', 'SELECT 1', bytesFor('g2'));
    expect(fetches).toEqual(['g1', 'g2']);
    clock.now += 1;
    await read('g1', 'SELECT 1', bytesFor('g1'));
    expect(fetches).toEqual(['g1', 'g2', 'g1']);
  });

  it('clearScopedReadCache(grantId) drops one entry; clearScopedReadCache() drops every entry', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const fetches: string[] = [];
    const bytesFor = (grantId: string) => () => {
      fetches.push(grantId);
      return Promise.resolve(sourceBytes);
    };
    await read('g1', 'SELECT 1', bytesFor('g1'));
    await read('g2', 'SELECT 1', bytesFor('g2'));
    clearScopedReadCache('g1');
    await read('g1', 'SELECT 1', bytesFor('g1'));
    await read('g2', 'SELECT 1', bytesFor('g2'));
    expect(fetches).toEqual(['g1', 'g2', 'g1']);
    clearScopedReadCache();
    await read('g2', 'SELECT 1', bytesFor('g2'));
    expect(fetches).toEqual(['g1', 'g2', 'g1', 'g2']);
  });

  it('an entry past the window is EVICTED by the next read of ANY grant — stale copies are not held for the session', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    await read('g1', 'SELECT 1');
    await read('g2', 'SELECT 1');
    expect(__scopedReadCachedGrantsForTests()).toEqual(['g1', 'g2']);
    clock.now += ACCESS_SCOPED_CACHE_MS - 1;
    await read('g3', 'SELECT 1');
    expect(__scopedReadCachedGrantsForTests(), 'still inside the window').toEqual(['g1', 'g2', 'g3']);
    clock.now += 1;
    await read('g3', 'SELECT 1'); // g3's own entry is 1 ms old — it stays; g1 and g2 are exactly at the window
    expect(__scopedReadCachedGrantsForTests()).toEqual(['g3']);
  });

  it('a bytes fetch that fails rejects the read (the caller names it) and caches nothing', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    await expect(read('g1', 'SELECT 1', () => Promise.reject(new Error('too big')))).rejects.toThrow('too big');
    expect(await read('g1', 'SELECT 1')).toMatchObject({ ok: true });
    expect(jobsOf(recorder)).toHaveLength(1);
  });
});

// W6 finding 6 — an idle entry ends on its own timer: no further read is needed to evict it.
describe('the per-grant bytes cache — eviction without another read', () => {
  it('an idle grant’s bytes are gone after the window without another read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const recorder = newRecorder();
      configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
      expect(await read('g1', 'SELECT 1')).toMatchObject({ ok: true });
      expect(__scopedReadCachedGrantsForTests()).toEqual(['g1']);
      vi.advanceTimersByTime(ACCESS_SCOPED_CACHE_MS - 1);
      expect(__scopedReadCachedGrantsForTests(), 'inside the window').toEqual(['g1']);
      vi.advanceTimersByTime(1);
      expect(__scopedReadCachedGrantsForTests()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// W6 finding 7 — a read is re-checked against its grant when it DEQUEUES.
describe('a queued read whose grant ended meanwhile', () => {
  it('after the stop, the queued jobs for that grant never reach the worker — nothing fetched, no worker rebuilt', async () => {
    const recorder = newRecorder();
    configureScopedRead({ createWorker: silentWorkers(recorder), wasm: { wasmUrl: locateWasm() }, timeoutMs: 300, now: () => clock.now });
    let live = true;
    let fetches = 0;
    const bytes = () => {
      fetches += 1;
      return Promise.resolve(sourceBytes);
    };
    const job = (sql: string) => scopedRead({ grantId: 'g1', bytes, scope: SCOPE, statement: { sql }, caps: CAPS, stillLive: () => live });
    const first = job('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r');
    const queued = [job('SELECT 1'), job('SELECT 2'), job('SELECT 3')];
    await vi.waitFor(() => expect(jobsOf(recorder)).toHaveLength(1));
    live = false; // the grant is suspended while the first read runs
    expect(await first).toMatchObject({ ok: false, reason: 'timeout' });
    for (const outcome of await Promise.all(queued)) expect(outcome).toMatchObject({ ok: false, reason: 'ended' });
    expect(jobsOf(recorder)).toHaveLength(1);
    expect(recorder.created, 'no worker was rebuilt for a read that cannot run').toBe(1);
    expect(fetches).toBe(1);
  });
});

// W6 finding 5 — a worker whose engine failed to start is retired, and the next read starts afresh.
describe('an engine that fails to start', () => {
  it('an engine that fails to load is retried on the next read: the worker is retired and a fresh one is sent the engine again', async () => {
    let loads = 0;
    const recorder = newRecorder();
    configureScopedRead({
      createWorker: () => {
        recorder.created += 1;
        // The first start fails (an aborted wasm fetch); every later one is the real engine.
        const respond = createScopedReadResponder((init) => (++loads === 1 ? Promise.reject(new Error('sql-wasm.wasm: fetch failed')) : loadEngine(init)));
        const worker: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage(msg, transfer) {
            recorder.posted.push({ msg, transfer });
            void respond(msg).then((answer) => {
              if (answer !== undefined) worker.onmessage?.({ data: answer });
            });
          },
          terminate() {
            recorder.terminated += 1;
          },
        };
        return worker;
      },
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
    });
    const failed = await read('g1', 'SELECT 1');
    expect(failed).toMatchObject({ ok: false, reason: 'failed' });
    expect(recorder.terminated, 'the worker whose engine never started is retired').toBe(1);
    expect(await read('g1', 'SELECT amount FROM transactions ORDER BY amount')).toEqual({ ok: true, columns: ['amount'], rows: [[450], [500]] });
    expect(recorder.created).toBe(2);
    expect(initsOf(recorder)).toHaveLength(2);
    expect(await read('g2', 'SELECT 1 AS n')).toEqual({ ok: true, columns: ['n'], rows: [[1]] });
    expect(recorder.created, 'a started engine is kept').toBe(2);
  });

  it('the responder does not memoise a failed start: a second init on the same worker tries again', async () => {
    let loads = 0;
    const respond = createScopedReadResponder(async () => {
      loads += 1;
      throw new Error('fetch failed');
    });
    await respond({ init: { wasmUrl: 'x' } });
    const answer = await respond({ id: 1, bytes: new Uint8Array(), scope: SCOPE, statement: { sql: 'SELECT 1' }, caps: CAPS });
    expect(answer).toMatchObject({ id: 1, engineFailed: true, result: { ok: false, reason: 'failed' } });
    await respond({ init: { wasmUrl: 'x' } });
    await respond({ id: 2, bytes: new Uint8Array(), scope: SCOPE, statement: { sql: 'SELECT 1' }, caps: CAPS });
    expect(loads).toBe(2);
  });
});

describe('no Worker — the honest refusal', () => {
  it('where no Worker can be constructed the read answers unavailable, and nothing is fetched', async () => {
    vi.stubGlobal('Worker', undefined);
    configureScopedRead({ wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    let fetched = false;
    const outcome = await read('g1', 'SELECT 1', () => {
      fetched = true;
      return Promise.resolve(sourceBytes);
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(fetched).toBe(false);
  });

  it('canConstructWorker probes a blob Worker: false without one, false when construction throws, true when it constructs (and the probe is terminated)', () => {
    vi.stubGlobal('Worker', undefined);
    expect(canConstructWorker()).toBe(false);

    const revoked: string[] = [];
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:probe', revokeObjectURL: (url: string) => revoked.push(url) }));
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('SecurityError');
        }
      },
    );
    expect(canConstructWorker()).toBe(false);

    let terminated = 0;
    vi.stubGlobal(
      'Worker',
      class {
        terminate(): void {
          terminated += 1;
        }
      },
    );
    expect(canConstructWorker()).toBe(true);
    expect(terminated).toBe(1);
    expect(revoked).toContain('blob:probe');
  });
});
