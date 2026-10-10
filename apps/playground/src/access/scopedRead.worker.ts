// access/scopedRead.worker.ts — the Worker that runs ONE scoped read (TASK-20261010-cross-app-
// access AC12; ADR-0075 §6; D10 — a security blocker of the plan review).
//
// WHY A WORKER WITH ITS OWN ENGINE. sql.js exposes no interrupt (probed: `Database.prototype`
// has none), so an app-authored `WITH RECURSIVE` that never ends would hang the page — every
// shell, every app — if it ran on the main thread. Here it runs on a dedicated thread that owns
// a SEPARATE sql.js instance: the host's wall clock (`scopedRead.ts`) terminates the thread when
// the read outruns it, and a wasm abort dies with this instance, never with the live user db.
//
// THE MESSAGES. Once, `{ init: { wasmBinary } | { wasmUrl } }` — the engine source the host
// hands over (the host kit's bytes, or the playground's absolute asset URL: this worker never
// imports a `?url` asset, so the playground's "wasm is never inlined" rule holds and the kit's
// engine rides as bytes). Then any number of `{ id, bytes, scope, statement, caps }` (the bytes
// transferred), each answered `{ id, result }` with the PURE `scopedScratchRead`'s outcome: the
// drops, the withheld columns, `query_only`, the drift check, the two statement guards and the
// caps all live there, in one tested function.
//
// The responder is exported so the unit suites run THIS code path inline (vitest has no
// Worker); the message listener is installed only inside a real worker scope.

// @ts-expect-error -- the playground carries sql.js but not its typings (only @snugprotocol/db does); typed below through the db's own signature.
import untypedInitSqlJs from 'sql.js';
import { scopedScratchRead, type ScopedReadResult } from '@snugprotocol/db';

import type { ScopedReadAnswer, ScopedReadInit, ScopedReadJob } from './scopedRead.js';

/** The engine `scopedScratchRead` runs on — its type, as the db package declares it. */
type SqlJsStatic = Parameters<typeof scopedScratchRead>[0];
const initSqlJs = untypedInitSqlJs as (config?: { locateFile?: (file: string) => string; wasmBinary?: ArrayBuffer }) => Promise<SqlJsStatic>;

/** How the engine is started from what the host sent — swappable only so a suite can count it. */
export type EngineLoader = (init: ScopedReadInit['init']) => Promise<SqlJsStatic>;

const loadEngine: EngineLoader = (init) =>
  init.wasmBinary !== undefined
    ? initSqlJs({ wasmBinary: exactBuffer(init.wasmBinary) })
    : initSqlJs({ locateFile: () => init.wasmUrl ?? '' });

/** Emscripten wants an ArrayBuffer of exactly the engine's bytes (a view may sit on a larger one). */
const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isInit(message: unknown): message is ScopedReadInit {
  return isRecord(message) && isRecord(message.init);
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

/**
 * One worker's state machine: `init` starts the engine (once — a second `init` is ignored),
 * a job is answered with the pure read's outcome, anything else is ignored. Never throws: an
 * engine that will not start, or a read that throws, answers `failed` for that job.
 */
export function createScopedReadResponder(load: EngineLoader = loadEngine): (message: unknown) => Promise<ScopedReadAnswer | undefined> {
  let engine: Promise<SqlJsStatic> | undefined;
  return async (message) => {
    if (isInit(message)) {
      engine ??= load(message.init);
      return undefined;
    }
    if (!isJob(message)) return undefined;
    if (engine === undefined) return { id: message.id, result: failed('the read engine was not started') };
    try {
      const SQL = await engine;
      return { id: message.id, result: scopedScratchRead(SQL, message.bytes, message.scope, message.statement, message.caps) };
    } catch (err) {
      return { id: message.id, result: failed(err instanceof Error ? err.message : String(err)) };
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
