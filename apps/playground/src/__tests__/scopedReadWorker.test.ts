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

// =========================================================================================
// TASK-20261010-host-broker PR-2 (contract v2 D-PR2-6, F10) — the DUMP job.
//
// `scopedDump({ grantId, bytes, scope, caps, stillLive?, timeoutMs? })` rides the SAME queue, the
// same worker and the same per-grant bytes cache as a read; the worker answers a
// `{ id, kind: 'dump', bytes, scope, caps }` job with the real `scopedScratchDump` (checked FIRST —
// a job without `statement` would otherwise be IGNORED by the read guard: silence, the clock, the
// worker retired), and a dump job that fails its guard is answered `failed` FOR ITS ID, never
// silence. The dump RESULT is cached per grant AND caps for ACCESS_SCOPED_CACHE_MS, and cleared
// with the bytes. A dump has its own clock (the caller's `timeoutMs` — ACCESS_MATERIALISE_TIMEOUT_MS
// from the service), never the read's.
//
// RED UNTIL D2b: the rows reach `scopedDump` and `access/limits.ts` through dynamic imports, so the
// rows above keep running. `bytes` is taken to be the read's thunk (contract v2 names the field, not
// its type — reported as a question).
// =========================================================================================

interface DumpCaps { maxRows: number; maxBytes: number; maxTotalBytes: number }
type DumpOutcome =
  | { ok: true; tables: Array<{ name: string; columns: string[]; types: string[]; rows: unknown[][]; truncated?: boolean; totalRows?: number }> }
  | { ok: false; reason: string; message: string };
interface DumpInput {
  grantId: string;
  bytes: () => Promise<Uint8Array>;
  scope: typeof SCOPE;
  caps: DumpCaps;
  stillLive?: () => boolean;
  timeoutMs?: number;
}

const DUMP_CAPS: DumpCaps = { maxRows: 5_000, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 };
const LIMITS_MODULE = '../access/limits.js';

async function scopedDumpFn(): Promise<(input: DumpInput) => Promise<DumpOutcome>> {
  const mod = (await import('../access/scopedRead.js')) as unknown as { scopedDump?: (input: DumpInput) => Promise<DumpOutcome> };
  if (typeof mod.scopedDump !== 'function') throw new Error('scopedRead.ts does not export scopedDump yet (PR-2 D2b)');
  return mod.scopedDump;
}

async function limits(): Promise<{ ACCESS_MATERIALISE_TIMEOUT_MS: number }> {
  return (await import(/* @vite-ignore */ LIMITS_MODULE)) as { ACCESS_MATERIALISE_TIMEOUT_MS: number };
}

const dumpJobsOf = (recorder: Recorder) => recorder.posted.filter((entry) => typeof entry.msg === 'object' && entry.msg !== null && (entry.msg as { kind?: unknown }).kind === 'dump');
const readJobsOf = (recorder: Recorder) => jobsOf(recorder).filter((entry) => (entry.msg as { kind?: unknown }).kind !== 'dump');

describe('PR-2 the dump job — the real scopedScratchDump through the inline responder', () => {
  it('answers the granted table’s recorded columns, declared types and rows; the job is posted as kind dump with the bytes TRANSFERRED as a copy', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const held = sourceBytes.slice();
    const outcome = await scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(held), scope: SCOPE, caps: DUMP_CAPS });
    expect(outcome).toMatchObject({ ok: true, tables: [{ name: 'transactions', columns: ['id', 'amount'], types: ['INTEGER', 'INTEGER'] }] });
    expect(outcome.ok ? [...outcome.tables[0]!.rows].sort((a, b) => Number(a[0]) - Number(b[0])) : []).toEqual([
      [1, 450],
      [2, 500],
    ]);
    expect(JSON.stringify(outcome)).not.toMatch(/accounts|9000/);
    const [job] = dumpJobsOf(recorder);
    expect(job?.msg).toMatchObject({ kind: 'dump', scope: SCOPE, caps: DUMP_CAPS });
    expect('statement' in (job?.msg as object)).toBe(false);
    const posted = (job?.msg as { bytes: Uint8Array }).bytes;
    expect(posted).not.toBe(held);
    expect(job?.transfer).toEqual([posted.buffer]);
    expect(recorder.created).toBe(1);
  });

  it('a dump and a read share ONE worker and ONE queue; a read job (no kind) is answered exactly as before', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const [dumped, read1] = await Promise.all([scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(sourceBytes), scope: SCOPE, caps: DUMP_CAPS }), read('g2', 'SELECT count(*) AS n FROM transactions')]);
    expect(dumped).toMatchObject({ ok: true });
    expect(read1).toEqual({ ok: true, columns: ['n'], rows: [[2]] });
    expect(recorder.created).toBe(1);
    expect(initsOf(recorder)).toHaveLength(1);
  });
});

describe('PR-2 the dump job — the worker’s guard order (F10: never silence)', () => {
  it('a dump job that fails its guard is answered failed FOR ITS ID — bytes not bytes, caps without maxTotalBytes, a scope that is not a record', async () => {
    const respond = createScopedReadResponder();
    await respond({ init: { wasmUrl: locateWasm() } });
    const bad: Array<Record<string, unknown>> = [
      { id: 7, kind: 'dump', bytes: 'not bytes', scope: SCOPE, caps: DUMP_CAPS },
      { id: 8, kind: 'dump', bytes: sourceBytes.slice(), scope: SCOPE, caps: { maxRows: 10, maxBytes: 10 } },
      { id: 9, kind: 'dump', bytes: sourceBytes.slice(), scope: 'transactions', caps: DUMP_CAPS },
      { id: 10, kind: 'dump', bytes: sourceBytes.slice(), scope: SCOPE },
    ];
    for (const message of bad) {
      const answer = await respond(message);
      expect(answer, JSON.stringify(message.id)).toMatchObject({ id: message.id, result: { ok: false, reason: 'failed' } });
    }
  });

  it('a well-formed dump job is answered with the dump; a read job WITHOUT kind is still answered as a read', async () => {
    const respond = createScopedReadResponder();
    await respond({ init: { wasmUrl: locateWasm() } });
    expect(await respond({ id: 1, kind: 'dump', bytes: sourceBytes.slice(), scope: SCOPE, caps: DUMP_CAPS })).toMatchObject({
      id: 1,
      result: { ok: true, tables: [{ name: 'transactions', columns: ['id', 'amount'] }] },
    });
    expect(await respond({ id: 2, bytes: sourceBytes.slice(), scope: SCOPE, statement: { sql: 'SELECT count(*) FROM transactions' }, caps: CAPS })).toEqual({
      id: 2,
      result: { ok: true, columns: ['count(*)'], rows: [[2]] },
    });
  });
});

describe('PR-2 the dump RESULT cache — per grant AND caps, cleared with the bytes', () => {
  it('within the window a grant’s dump is answered from the cache (no job, no fetch); another grant, other caps, or the window’s end are misses', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    let fetches = 0;
    const bytes = () => {
      fetches += 1;
      return Promise.resolve(sourceBytes);
    };
    const dump = (grantId: string, caps: DumpCaps = DUMP_CAPS) => scopedDump({ grantId, bytes, scope: SCOPE, caps });
    const first = await dump('g1');
    expect(await dump('g1')).toEqual(first);
    expect(dumpJobsOf(recorder)).toHaveLength(1);
    expect(fetches).toBe(1);
    await dump('g2');
    expect(dumpJobsOf(recorder), 'grants never share an entry').toHaveLength(2);
    await dump('g1', { ...DUMP_CAPS, maxTotalBytes: 1024 });
    expect(dumpJobsOf(recorder), 'a different maxTotalBytes is a miss').toHaveLength(3);
    clock.now += ACCESS_SCOPED_CACHE_MS;
    await dump('g1');
    expect(dumpJobsOf(recorder), 'past the window').toHaveLength(4);
  });

  it('clearScopedReadCache(grantId) drops that grant’s dump with its bytes; clearScopedReadCache() drops every one', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const dump = (grantId: string) => scopedDump({ grantId, bytes: () => Promise.resolve(sourceBytes), scope: SCOPE, caps: DUMP_CAPS });
    await dump('g1');
    await dump('g2');
    clearScopedReadCache('g1');
    await dump('g1');
    await dump('g2');
    expect(dumpJobsOf(recorder)).toHaveLength(3);
    clearScopedReadCache();
    await dump('g2');
    expect(dumpJobsOf(recorder)).toHaveLength(4);
  });

  it('resetScopedReadForTests drops the dump cache too', async () => {
    const scopedDump = await scopedDumpFn();
    let recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    await scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(sourceBytes), scope: SCOPE, caps: DUMP_CAPS });
    resetScopedReadForTests();
    recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    await scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(sourceBytes), scope: SCOPE, caps: DUMP_CAPS });
    expect(dumpJobsOf(recorder)).toHaveLength(1);
  });

  it('a cached dump never answers a READ: a read of the same grant still runs its statement in the worker', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    await scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(sourceBytes), scope: SCOPE, caps: DUMP_CAPS });
    expect(await read('g1', 'SELECT max(amount) AS m FROM transactions')).toEqual({ ok: true, columns: ['m'], rows: [[500]] });
    expect(readJobsOf(recorder)).toHaveLength(1);
  });
});

describe('PR-2 the dump’s own clock, and the host side’s own outcomes', () => {
  it('a dump runs under ITS timeoutMs, not the read’s: not cut at ACCESS_QUERY_TIMEOUT_MS, cut at ACCESS_MATERIALISE_TIMEOUT_MS — the worker terminated', async () => {
    const scopedDump = await scopedDumpFn();
    const { ACCESS_MATERIALISE_TIMEOUT_MS } = await limits();
    expect(ACCESS_MATERIALISE_TIMEOUT_MS).toBe(5_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const recorder = newRecorder();
      configureScopedRead({ createWorker: silentWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
      let settled: DumpOutcome | undefined;
      void scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(sourceBytes), scope: SCOPE, caps: DUMP_CAPS, timeoutMs: ACCESS_MATERIALISE_TIMEOUT_MS }).then((outcome) => {
        settled = outcome;
      });
      await vi.waitFor(() => expect(dumpJobsOf(recorder)).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(ACCESS_QUERY_TIMEOUT_MS + 1);
      expect(settled, 'the read’s 2 s clock does not cut a dump').toBeUndefined();
      expect(recorder.terminated).toBe(0);
      await vi.advanceTimersByTimeAsync(ACCESS_MATERIALISE_TIMEOUT_MS);
      expect(settled).toMatchObject({ ok: false, reason: 'timeout' });
      expect(recorder.terminated).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dump whose grant ended while it was queued answers ended — nothing fetched, nothing posted', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    let fetched = false;
    const outcome = await scopedDump({
      grantId: 'g1',
      bytes: () => {
        fetched = true;
        return Promise.resolve(sourceBytes);
      },
      scope: SCOPE,
      caps: DUMP_CAPS,
      stillLive: () => false,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'ended' });
    expect(fetched).toBe(false);
    expect(dumpJobsOf(recorder)).toHaveLength(0);
  });

  it('where no Worker can be constructed a dump answers unavailable, and nothing is fetched', async () => {
    const scopedDump = await scopedDumpFn();
    vi.stubGlobal('Worker', undefined);
    configureScopedRead({ wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    let fetched = false;
    const outcome = await scopedDump({
      grantId: 'g1',
      bytes: () => {
        fetched = true;
        return Promise.resolve(sourceBytes);
      },
      scope: SCOPE,
      caps: DUMP_CAPS,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(fetched).toBe(false);
  });

  it('drift passes through as the engine reports it', async () => {
    const scopedDump = await scopedDumpFn();
    const recorder = newRecorder();
    configureScopedRead({ createWorker: inlineWorkers(recorder), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const outcome = await scopedDump({ grantId: 'g1', bytes: () => Promise.resolve(sourceBytes), scope: { tables: [{ name: 'transactions', columns: ['id', 'amount', 'note'] }] }, caps: DUMP_CAPS });
    expect(outcome).toMatchObject({ ok: false, reason: 'drift' });
  });
});
