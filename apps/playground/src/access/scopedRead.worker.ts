// access/scopedRead.worker.ts — the Worker that runs ONE scoped read, or ONE scoped dump
// (TASK-20261010-cross-app-access AC12; ADR-0075 §6; D10 — a security blocker of the plan review;
// the dump: TASK-20261010-host-broker PR-2, contract v2 D-PR2-6, F10).
//
// WHY A WORKER WITH ITS OWN ENGINE. sql.js exposes no interrupt (probed: `Database.prototype`
// has none), so an app-authored `WITH RECURSIVE` that never ends would hang the page — every
// shell, every app — if it ran on the main thread. Here it runs on a dedicated thread that owns
// a SEPARATE sql.js instance: the host's wall clock (`scopedRead.ts`) terminates the thread when
// the job outruns it, and a wasm abort dies with this instance, never with the live user db.
//
// THE MESSAGES. Once, `{ init: { wasmBinary } | { wasmUrl } }` — the engine source the host
// hands over (the host kit's bytes, or the playground's absolute asset URL: this worker never
// imports a `?url` asset, so the playground's "wasm is never inlined" rule holds and the kit's
// engine rides as bytes). Then any number of jobs, each answered `{ id, result }`:
//   - `{ id, bytes, scope, statement, caps }` — a READ, answered with the PURE `scopedScratchRead`'s
//     outcome: the drops, the withheld columns, `query_only`, the drift check, the two statement
//     guards and the caps all live there, in one tested function;
//   - `{ id, kind: 'dump', bytes, scope, caps }` — a DUMP, answered with the PURE `scopedScratchDump`'s
//     outcome: the same copy, then only the recorded columns of each granted table under the caps.
// The dump's guard runs FIRST: a read guard keys on `statement`, and a dump carries none, so a dump
// checked second would be IGNORED — silence, the host's clock, the worker retired for nothing. A
// dump job that fails its own guard is answered `failed` for its id, never silence (F10).
//
// The responder is exported so the unit suites run THIS code path inline (vitest has no
// Worker); the message listener is installed only inside a real worker scope.

// @ts-expect-error -- the playground carries sql.js but not its typings (only @snugprotocol/db does); typed below through the db's own signature.
import untypedInitSqlJs from 'sql.js';
import { scopedScratchDump, scopedScratchRead, type ScopedReadResult } from '@snugprotocol/db';

import type { ScopedDumpJob, ScopedReadAnswer, ScopedReadInit, ScopedReadJob } from './scopedRead.js';

/** The engine `scopedScratchRead` runs on — its type, as the db package declares it. */
type SqlJsStatic = Parameters<typeof scopedScratchRead>[0];
const initSqlJs = untypedInitSqlJs as (config?: { locateFile?: (file: string) => string; wasmBinary?: ArrayBuffer }) => Promise<SqlJsStatic>;

/** How the engine is started from what the host sent — swappable only so a suite can count it. */
export type EngineLoader = (init: ScopedReadInit['init']) => Promise<SqlJsStatic>;

/** The engine as a real worker starts it — exported so a suite can wrap it (a first start that fails, then this). */
export const loadEngine: EngineLoader = (init) =>
  init.wasmBinary !== undefined
    ? initSqlJs({ wasmBinary: exactBuffer(init.wasmBinary) })
    : initSqlJs({ locateFile: () => init.wasmUrl ?? '' });

/** Emscripten wants an ArrayBuffer of exactly the engine's bytes (a view may sit on a larger one). */
const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isInit(message: unknown): message is ScopedReadInit {
  return isRecord(message) && isRecord(message.init);
}

/** A message that MEANS to be a dump job — answered for its id whether or not the rest of it holds up. */
function isDumpShaped(message: unknown): message is Record<string, unknown> & { id: number; kind: 'dump' } {
  return isRecord(message) && typeof message.id === 'number' && message.kind === 'dump';
}

function isDumpJob(message: unknown): message is ScopedDumpJob {
  return (
    isDumpShaped(message) &&
    message.bytes instanceof Uint8Array &&
    isRecord(message.scope) &&
    isRecord(message.caps) &&
    typeof message.caps.maxRows === 'number' &&
    typeof message.caps.maxBytes === 'number' &&
    typeof message.caps.maxTotalBytes === 'number'
  );
}

function isJob(message: unknown): message is ScopedReadJob {
  return (
    isRecord(message) &&
    typeof message.id === 'number' &&
    message.bytes instanceof Uint8Array &&
    isRecord(message.scope) &&
    isRecord(message.statement) &&
    isRecord(message.caps)
  );
}

const failed = (message: string): ScopedReadResult => ({ ok: false, reason: 'failed', message });

/** What a job answers when the engine could not start — the host retires this worker on it. */
export const ENGINE_FAILED_MESSAGE = 'the read engine could not start';

/** What a dump-shaped job answers when it is not a dump job. */
const MALFORMED_DUMP_MESSAGE = 'a dump job must carry bytes, the tables and three caps';

/**
 * One worker's state machine: `init` starts the engine (once — a second `init` is ignored while
 * it is starting or started), a job is answered with the pure read's or dump's outcome, anything
 * else is ignored. Never throws: a job that throws answers `failed` for that job; an engine that
 * will not start answers `failed` with `engineFailed: true` — and is NOT memoised, so the next
 * `init` tries again (the host retires the worker on that answer and re-sends `init` to a fresh one).
 */
export function createScopedReadResponder(load: EngineLoader = loadEngine): (message: unknown) => Promise<ScopedReadAnswer | undefined> {
  let engine: Promise<SqlJsStatic> | undefined;
  return async (message) => {
    if (isInit(message)) {
      if (engine === undefined) {
        const starting = load(message.init).catch((err: unknown) => {
          engine = undefined; // never memoise a failed start
          throw err;
        });
        starting.catch(() => undefined); // a start no job awaits is not an unhandled rejection
        engine = starting;
      }
      return undefined;
    }
    // The dump's guard FIRST (see the header): a dump-shaped job is always answered for its id.
    let job: ScopedDumpJob | ScopedReadJob;
    if (isDumpShaped(message)) {
      if (!isDumpJob(message)) return { id: message.id, result: failed(MALFORMED_DUMP_MESSAGE) };
      job = message;
    } else if (isJob(message)) {
      job = message;
    } else {
      return undefined;
    }
    if (engine === undefined) return { id: job.id, result: failed('the read engine was not started'), engineFailed: true };
    let SQL: SqlJsStatic;
    try {
      SQL = await engine;
    } catch {
      return { id: job.id, result: failed(ENGINE_FAILED_MESSAGE), engineFailed: true };
    }
    try {
      if ('kind' in job) return { id: job.id, result: scopedScratchDump(SQL, job.bytes, job.scope, job.caps) };
      return { id: job.id, result: scopedScratchRead(SQL, job.bytes, job.scope, job.statement, job.caps) };
    } catch (err) {
      return { id: job.id, result: failed(err instanceof Error ? err.message : String(err)) };
    }
  };
}

/** The slice of a dedicated worker's global scope this module touches (the playground compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as WorkerScope;
  const respond = createScopedReadResponder();
  scope.onmessage = (event) => {
    void respond(event.data).then((answer) => {
      if (answer !== undefined) scope.postMessage(answer);
    });
  };
}
