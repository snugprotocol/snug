// access/scopedRead.ts — the host side of a scoped read (TASK-20261010-cross-app-access AC12;
// ADR-0075 §6; D10): ONE lazy Worker per page that owns its own sql.js, a wall clock on every
// read, and a short per-grant cache of the source's bytes.
//
// THE WALL CLOCK. sql.js has no interrupt, so the only bound on an app-authored read is the
// thread it runs on: after `ACCESS_QUERY_TIMEOUT_MS` the worker is TERMINATED and forgotten —
// the next read builds a fresh one (and re-sends the engine). The page never waits on the read;
// the read answers `{ ok: false, reason: 'timeout' }`. A worker that errors (a wasm abort) is
// treated the same way and answers `failed`. Reads are SERIALISED through the one worker, and
// each read's clock starts when it is posted, so a slow read never eats another's budget.
//
// THE CACHE. The source's live bytes (`exportAppRuntime`, the caller's thunk) are kept per
// GRANT for `ACCESS_SCOPED_CACHE_MS`, so a reader paging through results does not export the
// source per page. Each entry carries its own eviction timer for that window, and every read
// also first EVICTS the entries past the window (any grant's) — so a stale copy, up to 16 MiB
// each, is never held for the rest of the session, read again or not (W6 finding 6). The worker
// gets a COPY, transferred — the cached buffer is never detached.
//
// A QUEUED READ IS RE-CHECKED when it dequeues (`stillLive`, the caller's grant check): a read
// that waited behind others while its grant was stopped or paused answers `ended` before any
// export, slice or worker work (W6 finding 7).
//
// AN ENGINE THAT WILL NOT START (a failed wasm fetch) is not memoised: the worker answers the job
// `engineFailed`, the host retires it like a worker error, and the next read builds a fresh worker
// and sends the engine source again (W6 finding 5).
// Every scoping step (drops, withheld columns, `query_only`) runs in the worker on that copy.
//
// NO WORKER. Where no Worker can be constructed, a read answers `unavailable` without fetching
// anything (the handler says "this host cannot run cross-app reads"); the host kit's boot probe
// uses `canConstructWorker` to turn the capability off instead (ADR-0072 §4).
//
// THE ENGINE SOURCE the worker is started with: the platform's bytes when the shell carries them
// (the host kit — `connect-src 'self'` blocks a wasm fetch there), else the playground's asset as
// an ABSOLUTE URL (a blob worker has no base to resolve a relative one against).
//
// Tests inject a `WorkerLike` factory, the engine source, the clock and the timeout through
// `configureScopedRead`; production builds the worker from Vite's `?worker&inline` import so the
// single-file kit carries it inline (a Blob URL at runtime).

import { ACCESS_QUERY_TIMEOUT_MS, ACCESS_SCOPED_CACHE_MS } from '@snugprotocol/protocol';
import type { ScopedReadCaps, ScopedReadResult, ScopedReadScope, ScopedReadStatement } from '@snugprotocol/db';

import { sqlJsEngineOptions } from '../run/sqlJsEngine.js';

/** The slice of a Worker the host uses — injectable, because vitest has none. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** The engine source a worker is started with — bytes, or an absolute URL. */
export interface ScopedReadEngineSource {
  wasmBinary?: Uint8Array;
  wasmUrl?: string;
}

/** host → worker, once per worker. */
export interface ScopedReadInit {
  init: ScopedReadEngineSource;
}

/** host → worker, one per read; `bytes` is a transferred copy. */
export interface ScopedReadJob {
  id: number;
  bytes: Uint8Array;
  scope: ScopedReadScope;
  statement: ScopedReadStatement;
  caps: ScopedReadCaps;
}

/** worker → host. `engineFailed`: the worker's engine could not start — the host retires that worker. */
export interface ScopedReadAnswer {
  id: number;
  result: ScopedReadResult;
  engineFailed?: true;
}

/** The engine's outcome, or the host side's own three: the wall clock fired, no Worker exists here, or the grant ended while the read was queued. */
export type ScopedReadOutcome = ScopedReadResult | { ok: false; reason: 'timeout' | 'unavailable' | 'ended'; message: string };

export interface ScopedReadInput {
  grantId: string;
  /** The source's live bytes — called only on a cache miss; a rejection rejects the read. */
  bytes: () => Promise<Uint8Array>;
  scope: ScopedReadScope;
  statement: ScopedReadStatement;
  caps: ScopedReadCaps;
  /** Whether the grant may still be read — asked when the read DEQUEUES; false answers `ended` with nothing fetched or posted. */
  stillLive?: () => boolean;
}

interface Config {
  createWorker?: () => WorkerLike;
  wasm?: ScopedReadEngineSource;
  now: () => number;
  timeoutMs: number;
}

/** sql.js's own name for its engine asset — what a locator is asked for. */
const WASM_FILE = 'sql-wasm.wasm';

const defaultConfig = (): Config => ({ now: Date.now, timeoutMs: ACCESS_QUERY_TIMEOUT_MS });
let config: Config = defaultConfig();

/** The live worker, and whether the engine source was sent to it. */
let live: { worker: WorkerLike; initialised: boolean } | undefined;
/** Reads run one at a time through the one worker. */
let queue: Promise<unknown> = Promise.resolve();
let nextJobId = 1;
const cache = new Map<string, { bytes: Uint8Array; at: number; timer: ReturnType<typeof setTimeout> }>();

/** Tests (and nothing else) inject the worker, the engine source, the clock and the timeout. */
export function configureScopedRead(opts: { createWorker?: () => WorkerLike; wasm?: ScopedReadEngineSource; now?: () => number; timeoutMs?: number }): void {
  config = {
    ...config,
    ...('createWorker' in opts ? { createWorker: opts.createWorker } : {}),
    ...('wasm' in opts ? { wasm: opts.wasm } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

/**
 * Whether a blob Worker constructs here — a real construction, terminated at once (a CSP
 * `worker-src` refusal or an embedder that strips Workers answers false). The host kit's boot
 * probe uses this same check to compose `access: false`.
 */
export function canConstructWorker(): boolean {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  let url: string | undefined;
  try {
    url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    const probe = new Worker(url);
    probe.terminate();
    return true;
  } catch {
    return false;
  } finally {
    if (url !== undefined) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // a revoke that fails leaks one empty blob URL — never a reason to refuse the probe
      }
    }
  }
}

/** Drop one cache entry and its eviction timer. */
function evict(grantId: string): void {
  const entry = cache.get(grantId);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  cache.delete(grantId);
}

/** Drop one grant's cached bytes, or every grant's (revoke, suspend and the session reset call this). */
export function clearScopedReadCache(grantId?: string): void {
  if (grantId === undefined) for (const id of [...cache.keys()]) evict(id);
  else evict(grantId);
}

/** Terminate the worker, clear the cache and the configuration. */
export function resetScopedReadForTests(): void {
  retire();
  clearScopedReadCache();
  queue = Promise.resolve();
  config = defaultConfig();
}

function retire(): void {
  const current = live;
  live = undefined;
  if (current === undefined) return;
  current.worker.onmessage = null;
  current.worker.onerror = null;
  try {
    current.worker.terminate();
  } catch {
    // already gone
  }
}

/** The production worker: Vite inlines the module (`?worker&inline`) so the single-file kit carries it. */
async function productionWorker(): Promise<WorkerLike | undefined> {
  if (typeof Worker === 'undefined') return undefined;
  try {
    const { default: ScopedReadWorker } = await import('./scopedRead.worker.ts?worker&inline');
    const worker = new ScopedReadWorker();
    const like: WorkerLike = {
      postMessage: (msg, transfer) => worker.postMessage(msg, transfer ?? []),
      terminate: () => worker.terminate(),
      onmessage: null,
      onerror: null,
    };
    worker.onmessage = (event) => like.onmessage?.({ data: event.data });
    worker.onerror = (event) => like.onerror?.(event);
    return like;
  } catch {
    return undefined;
  }
}

function engineSource(): ScopedReadEngineSource {
  if (config.wasm !== undefined) return config.wasm;
  const options = sqlJsEngineOptions();
  if (options.wasmBinary !== undefined) {
    return { wasmBinary: options.wasmBinary instanceof Uint8Array ? options.wasmBinary : new Uint8Array(options.wasmBinary) };
  }
  // A blob worker has no base URL of its own: resolve the asset against this page.
  return { wasmUrl: new URL(options.locateWasm?.(WASM_FILE) ?? WASM_FILE, globalThis.location?.href).href };
}

async function acquireWorker(): Promise<WorkerLike | undefined> {
  if (live === undefined) {
    let worker: WorkerLike | undefined;
    try {
      worker = config.createWorker !== undefined ? config.createWorker() : await productionWorker();
    } catch {
      worker = undefined;
    }
    if (worker === undefined) return undefined;
    live = { worker, initialised: false };
  }
  if (!live.initialised) {
    live.worker.postMessage({ init: engineSource() } satisfies ScopedReadInit);
    live.initialised = true;
  }
  return live.worker;
}

const workerAvailable = (): boolean => config.createWorker !== undefined || typeof Worker !== 'undefined';

/** Drop every entry no read may use any more — the window is the entry's whole life. */
function evictStale(now: number): void {
  for (const [grantId, entry] of [...cache]) if (now - entry.at >= ACCESS_SCOPED_CACHE_MS) evict(grantId);
}

/** The entry's own end: evicted after the window whether or not another read comes (never keeps a process alive). */
function evictionTimer(grantId: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    if (cache.get(grantId)?.timer === timer) cache.delete(grantId);
  }, ACCESS_SCOPED_CACHE_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Test seam: the grants whose bytes are cached, in insertion order. */
export function __scopedReadCachedGrantsForTests(): string[] {
  return [...cache.keys()];
}

async function sourceBytes(input: ScopedReadInput): Promise<Uint8Array> {
  const now = config.now();
  evictStale(now);
  const hit = cache.get(input.grantId);
  if (hit !== undefined) return hit.bytes;
  const bytes = await input.bytes();
  evict(input.grantId);
  cache.set(input.grantId, { bytes, at: now, timer: evictionTimer(input.grantId) });
  return bytes;
}

/** Post one job and wait for its answer, the wall clock, or the worker's error — whichever comes first. */
function runOnWorker(worker: WorkerLike, job: Omit<ScopedReadJob, 'id'>): Promise<ScopedReadOutcome> {
  const id = nextJobId++;
  return new Promise<ScopedReadOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ScopedReadOutcome, retireWorker: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      if (retireWorker) retire();
      else {
        worker.onmessage = null;
        worker.onerror = null;
      }
      resolve(outcome);
    };
    const clock = setTimeout(() => settle({ ok: false, reason: 'timeout', message: 'the read outran its time' }, true), config.timeoutMs);
    worker.onmessage = (event) => {
      const answer = event.data as Partial<ScopedReadAnswer> | null;
      if (answer === null || typeof answer !== 'object' || answer.id !== id || answer.result === undefined) return;
      // An engine that could not start is retired like a worker error: the next read starts afresh.
      settle(answer.result, answer.engineFailed === true);
    };
    worker.onerror = () => settle({ ok: false, reason: 'failed', message: 'the read engine stopped' }, true);
    try {
      worker.postMessage({ id, ...job } satisfies ScopedReadJob, [job.bytes.buffer as ArrayBuffer]);
    } catch (err) {
      settle({ ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) }, true);
    }
  });
}

/**
 * One scoped read. Serialised behind any read in flight; `unavailable` (nothing fetched) where no
 * Worker exists; the source's bytes from the per-grant cache or the caller's thunk (a rejection
 * rejects this call — the caller names it); a transferred COPY to the worker; the wall clock.
 */
export function scopedRead(input: ScopedReadInput): Promise<ScopedReadOutcome> {
  const run = async (): Promise<ScopedReadOutcome> => {
    if (input.stillLive !== undefined && !input.stillLive()) return { ok: false, reason: 'ended', message: 'the access ended while the read waited' };
    if (!workerAvailable()) return { ok: false, reason: 'unavailable', message: 'no worker' };
    const bytes = await sourceBytes(input);
    const worker = await acquireWorker();
    if (worker === undefined) return { ok: false, reason: 'unavailable', message: 'no worker' };
    return runOnWorker(worker, { bytes: bytes.slice(), scope: input.scope, statement: input.statement, caps: input.caps });
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
