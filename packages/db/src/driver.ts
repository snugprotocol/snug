// The per-app database driver: sql.js (WASM SQLite) with one database per HOST-assigned
// namespace, kv ops stored in a `snug_kv` table inside the same file (one file = whole
// app state), debounced write-back persistence, and 5 MiB artifact / 8 MiB db-frame caps.
//
// Contract: implements the runner's DbDriver seam — `handle` NEVER throws across the
// boundary; every failure is an ok:false DbDriverResult (errors-as-data, docs/standards).
//
// TWO HOST-SIDE SEATS SINCE TASK-20261010-host-broker PR-3 (contract v2 D-PR3-11 / D-PR3-20):
//
//  - THE WRITE SIGNAL. `onNamespaceWrite` (an option) and `subscribeWrites` (a listener set
//    the driver keeps) hear every write a FRAME lands on a namespace — raised in `handle()`
//    only: an `exec` that answered ok, is row-modifying by kind and changed > 0 rows (the
//    table from `dmlTargetTable`, the count from `sqlite3_changes()`), a frame's `kvSet`, an
//    `import` — and a brokered write below. Never from a read, a DDL statement, a statement
//    that changed nothing, `markDirty`, or the HOST's own `kvSet`/`kvGet` seat (the scheduler's
//    `snug:schedule:<runId>` handshake rings nothing — F9/S14). The access engine's doorbell
//    is built on it; an event carries ids and a count, never a row (AC24).
//  - THE BROKERED WRITE. `brokeredWrite(namespace, input)` is the ONLY way onto a namespace's
//    handle for another app's write: it runs `applyBrokeredBatch` SYNCHRONOUSLY on the cached
//    `Database` (no frame request interleaves — every `handle` awaits the same open and runs
//    on the same thread), marks the namespace dirty, rings `kind: 'brokered'`, and answers
//    errors as data like `handle`. The driver keeps a per-namespace TRANSACTION record from
//    the verbs `runExec` ran successfully (`BEGIN`/`SAVEPOINT` open a frame; `COMMIT`/`END`/
//    `ROLLBACK` close every frame; `RELEASE` closes down to its savepoint, `ROLLBACK TO`
//    keeps it) and answers `busy` (retryable) from it BEFORE touching the handle; the apply's
//    own `BEGIN IMMEDIATE` is the belt (F4/S4). The record is CLEARED whenever the connection
//    is reopened — sql.js's `export()` frees every statement, closes and reopens the
//    connection, discarding an open transaction (`persist`, the `export` frame, an `import`)
//    — and on a `COMMIT`/`END`/`ROLLBACK` that fails "no transaction is active" (E1-Q8), so a
//    stale frame can never strand a namespace as busy. `inTransaction(namespace)` READS that
//    record for the engine (code-fix D-FIX-1): the plan's own fresh export reopens the
//    connection and discards the app's open transaction with the record, so a `busy` the seat
//    would have answered is gone by the time the seat is reached — the engine asks BEFORE the
//    export, and this read never touches a handle and never opens a namespace.
import initSqlJs from 'sql.js';
import type { BindParams, Database, SqlJsStatic } from 'sql.js';
import { LIMITS, SCHEDULE_APP_INPUT_MAX_BYTES, utf8ByteLength, type DbRequestFrame } from '@snugprotocol/protocol';
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { BUSY_REFUSAL, applyBrokeredBatch, dmlTargetTable, type BrokeredApplyInput, type BrokeredApplyResult } from './brokered-write.js';
import { DB_ERROR_CODES } from './errors.js';
import { namespaceToFileName } from './namespace.js';
import { detectPersistenceBackend, type PersistenceBackend } from './persistence.js';
import { errorMessage } from './sqlite-helpers.js';
import { KV_TABLE_DDL, forbiddenStatementReason, isRowModifyingStatement, isSqlTailEmpty, normalizeCell, stripSqlComments } from './statement-rules.js';

// The statement-text rules moved to the leaf `statement-rules.ts` (PR-3, see its header); the
// driver re-exports them verbatim so its public surface — and every importer — is unchanged.
export { KV_TABLE_DDL, forbiddenStatementReason, isRowModifyingStatement, isSqlTailEmpty, nonDataStatementReason, normalizeCell, stripSqlComments } from './statement-rules.js';

/**
 * Mirrors the runner's DbDriverResult/DbDriver structurally (no runtime dependency on
 * @snugprotocol/runner; assignability is locked by a type-level test). Success fields
 * map 1:1 onto the TOP-LEVEL fields of a `snug:db-response` frame.
 */
export type DbDriverResult =
  | { ok: true; rows?: unknown[][]; columns?: string[]; value?: unknown; bytesBase64?: string }
  | { ok: false; code: string; message: string; retryable: boolean };

/** `PersistenceKind` as surfaced to embedders: every real kind as itself, `memory` as `'none'`. */
export type DbPersistence = 'opfs' | 'idb' | 'file' | 'window-storage' | 'artifact-html' | 'none';

/** A failure the driver recovered from on its own — surfaced so embedders can log/notify. */
export interface DbRecoverableErrorEvent {
  namespace: string;
  kind: 'corrupt-persisted-bytes';
  message: string;
}

/**
 * A write a namespace took (D-PR3-20 a): which kind of seat landed it, the table when the
 * statement text says it plainly (`dmlTargetTable`; absent for a kv write, an import, or a
 * batch over several tables) and the rows it changed (an `exec` always carries the count —
 * D-Q16; a brokered write the batch's sum). Never a row, a value or a key.
 */
export interface NamespaceWriteEvent {
  namespace: string;
  kind: 'exec' | 'kv' | 'import' | 'brokered';
  table?: string;
  changes?: number;
}

/**
 * What `brokeredWrite` applies: the Worker's plans, the app's own approved statements (own mode,
 * D-PR3-8) — bare, or captured for an undo (PR-4, D-PR4-4: `{ own, capture: true, … }`, forwarded
 * as is) — or an undo's structured steps (D-Q2 — the same union the apply takes).
 */
export type BrokeredWriteInput = BrokeredApplyInput;

/**
 * What `brokeredWrite` answers: the apply's own outcome with `retryable` on a refusal (`busy`
 * is the one retryable reason — the app's transaction will end), or the driver's own typed
 * failure (closed, the engine failed to initialise, an apply that threw).
 */
export type BrokeredWriteResult =
  | Extract<BrokeredApplyResult, { ok: true }>
  | ({ ok: false; retryable: boolean } & Extract<BrokeredApplyResult, { ok: false }>)
  | { ok: false; code: string; message: string; retryable: boolean };

export interface CreateDbDriverOptions {
  /** Injected persistence backend (tests, embedders). Default: auto-detect OPFS → IndexedDB → memory. */
  backend?: PersistenceBackend;
  /**
   * Locator for the sql.js wasm asset. Default: sql.js's own resolution, which loads
   * `sql-wasm.wasm` from next to the sql.js script — bundlers ship the asset alongside,
   * no CDN involved. Inject in environments where that fails: vitest/node should point at
   * `node_modules/sql.js/dist/sql-wasm.wasm`; bundlers with hashed asset names should
   * return the bundler-resolved URL (e.g. `import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'`).
   */
  locateWasm?: (file: string) => string;
  /**
   * The sql.js engine AS BYTES (TASK-20260905-host-kit P4). When present it REPLACES the
   * locator — `initSqlJs` receives `{ wasmBinary }` and no `locateFile`, so the engine is
   * instantiated from memory and no request for `sql-wasm.wasm` is ever made. This is
   * how the host kit boots inside an artifact viewer whose `connect-src 'self'` blocks
   * every wasm fetch (a `data:` URL through the locator would still be fetched, and
   * blocked). Note sql.js memoizes its FIRST initialisation per page: the caller that
   * boots first (the user-db open, in the playground) must be the one carrying the bytes.
   */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Write-back debounce after a mutation, in ms. flush() forces pending writes. */
  persistDebounceMs?: number;
  /**
   * Invoked once per occurrence when the driver recovers from a failure by itself —
   * currently: persisted bytes for a namespace were corrupt/unreadable and the driver
   * failed open with a fresh database (the alternative would brick the namespace).
   */
  onRecoverableError?: (event: DbRecoverableErrorEvent) => void;
  /**
   * The write signal (D-PR3-20 a): invoked once per write a frame or the broker lands on a
   * namespace — see the header for exactly which seats ring and which never do. Best-effort
   * like `subscribeWrites`: a listener that throws never fails the write that already landed.
   */
  onNamespaceWrite?: (event: NamespaceWriteEvent) => void;
}

export interface SnugDbDriver {
  handle(namespace: string, request: DbRequestFrame): Promise<DbDriverResult>;
  /** Which persistence tier backs this driver; 'none' means state dies with the page. */
  readonly persistence: DbPersistence;
  /** Cancels debounce timers and writes everything dirty now (tests/teardown). */
  flush(): Promise<void>;
  /**
   * Forget one namespace: cancel its debounce, DISCARD pending writes, and close its
   * handle. Deliberately does NOT persist — this exists for app deletion, where the
   * cached runtime copy would otherwise be written back and resurrect the app. The
   * namespace re-opens from scratch if used again.
   */
  evict(namespace: string): Promise<void>;
  /** flush + close all sql.js handles. The driver is unusable afterwards. */
  close(): Promise<void>;
  /**
   * HOST-side kv (TASK-20261009-scheduling-framework A3, ADR-0074 §3): the same `snug_kv`
   * table the app's own `kvGet`/`kvSet` frames reach, written by the HOST into the app's
   * namespace — the scheduler's `snug:schedule:<runId>` handshake. `null` (or `undefined`)
   * CLEARS the key, so the app's next `kvGet` answers no value at all (absent, never a stored
   * null); a value is capped at `HOST_KV_VALUE_MAX_BYTES` of serialised UTF-8 — the
   * handshake's own cap — and refused `DB_TOO_LARGE` above it. Errors are data here as at
   * `handle`: this seat never throws.
   */
  kvSet(namespace: string, key: string, value: unknown): Promise<DbDriverResult>;
  /** The host-side read of one key in an app's namespace: `{ ok: true }` with no `value` when absent. */
  kvGet(namespace: string, key: string): Promise<DbDriverResult>;
  /**
   * Another app's write onto this namespace (TASK-20261010-host-broker PR-3, D-PR3-11): the
   * Worker's plans applied atomically and SYNCHRONOUSLY on the handle by `applyBrokeredBatch`
   * — or an undo's steps reversed through the same seat. `busy` (retryable) when the app holds
   * an open transaction, answered from the driver's own record before the handle is touched;
   * every other refusal as the apply words it; the driver's typed failure when the seat itself
   * cannot run. Marks the namespace dirty and rings `kind: 'brokered'` after a commit. This
   * seat never throws.
   */
  brokeredWrite(namespace: string, input: BrokeredWriteInput): Promise<BrokeredWriteResult>;
  /**
   * Whether the app holds a transaction open on this namespace — the driver's own record, READ
   * (TASK-20261010-host-broker PR-3 code-fix D-FIX-1). The engine asks BEFORE a plan's fresh
   * export: sql.js's `export()` closes and reopens the connection and discards the app's open
   * transaction, so a `busy` the seat would have answered is gone by the time the seat is
   * reached. This read never touches a handle and never opens a namespace — one never opened,
   * and the closed driver, answer false. Never throws.
   */
  inTransaction(namespace: string): Promise<boolean>;
  /** Hear every write signal (D-PR3-20 a) — what `onNamespaceWrite` hears. Answers the unsubscribe. */
  subscribeWrites(listener: (event: NamespaceWriteEvent) => void): () => void;
}

/**
 * The host-side kv value cap: the scheduler's app input rides the kv handshake inside the
 * payload `{ taskId, runId, input }`, so the cap is the input's own (`SCHEDULE_APP_INPUT_MAX_BYTES`,
 * the task schema's) plus 256 bytes for the two ids (≤ 64 characters each) and the keys around
 * them — a value the task admitted always lands, and nothing meaningfully larger can be planted
 * through this seat (Gate-5 PR-B S6).
 */
export const HOST_KV_VALUE_MAX_BYTES = SCHEDULE_APP_INPUT_MAX_BYTES + 256;

/** The frame schema's bounds on a kv key, mirrored for the host side. */
const KV_KEY_MAX_CHARS = 256;

/** The two engine-source options, shared by both `initSqlJs` sites (`createDbDriver`, `openUserDb`). */
export interface SqlJsEngineOptions {
  locateWasm?: (file: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
}

/**
 * The ONE rule turning engine-source options into sql.js's init config, used by BOTH
 * `initSqlJs` sites so they can never disagree (the userdb open and its inner per-app
 * driver — a caller that forwarded one option and not the other would boot two ways).
 * Bytes win and REPLACE the locator: Emscripten still computes the asset path when both
 * are given, and in the artifact viewer that path is a blocked fetch waiting to happen.
 * Neither option → `undefined`, sql.js's own resolution, byte-identical to before.
 */
export function sqlJsInitConfig(options: SqlJsEngineOptions): Parameters<typeof initSqlJs>[0] {
  if (options.wasmBinary !== undefined) return { wasmBinary: toArrayBuffer(options.wasmBinary) };
  if (options.locateWasm !== undefined) {
    const locate = options.locateWasm;
    return { locateFile: (file: string) => locate(file) };
  }
  return undefined;
}

/** Emscripten wants an ArrayBuffer; a view over a larger buffer is copied to exactly its bytes. */
function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof Uint8Array) {
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    return (exact ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
  }
  return bytes;
}

/** Headroom for the db-response envelope fields when checking payloads against the frame class. */
const FRAME_OVERHEAD_BYTES = 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);

interface NamespaceState {
  db: Database;
  file: string;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  saving: Promise<void>;
  /**
   * The transaction frames an app's own verbs opened on this handle (D-PR3-11): `''` for a
   * `BEGIN`, a savepoint's name otherwise, innermost last. Non-empty means mid-transaction.
   */
  transaction: string[];
}

/** SQLite's answer to a `COMMIT`/`END`/`ROLLBACK` outside a transaction — the truth about the handle. */
const NO_TRANSACTION_ACTIVE = /no transaction is active/i;

/** A savepoint name as SQLite reads it: quoted in any of its four ways or bare; compared case-insensitively. */
const SAVEPOINT_NAME = /^(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|`((?:[^`]|``)*)`|\[([^\]]*)\]|([A-Za-z_][\w$]*))/;

function savepointName(text: string): string | undefined {
  const match = SAVEPOINT_NAME.exec(text.trim());
  if (match === null) return undefined;
  const name = match[1]?.replace(/""/g, '"') ?? match[2]?.replace(/''/g, "'") ?? match[3]?.replace(/``/g, '`') ?? match[4] ?? match[5];
  return name?.toLowerCase();
}

/**
 * The transaction frames after `sql` RAN SUCCESSFULLY, from its verb alone (E1-Q8):
 * `BEGIN` opens the one frame (it cannot succeed inside a transaction); `SAVEPOINT x` opens a
 * frame named `x`; `RELEASE x` closes down to and including the innermost `x` — the outermost
 * savepoint's release commits; `ROLLBACK TO x` closes down to but keeps `x`; a bare `ROLLBACK`,
 * `COMMIT` or `END` closes every frame. Any other statement leaves the record as it is.
 */
function transactionAfter(frames: readonly string[], sql: string): string[] {
  const cleaned = stripSqlComments(sql).trim();
  if (/^BEGIN\b/i.test(cleaned)) return [''];
  if (/^(COMMIT|END)\b/i.test(cleaned)) return [];
  const savepoint = /^SAVEPOINT\s+([\s\S]*)$/i.exec(cleaned);
  if (savepoint !== null) {
    const name = savepointName(savepoint[1] ?? '');
    return name === undefined ? [...frames] : [...frames, name];
  }
  const release = /^RELEASE\s+(?:SAVEPOINT\s+)?([\s\S]*)$/i.exec(cleaned);
  if (release !== null) {
    const name = savepointName(release[1] ?? '');
    const index = name === undefined ? -1 : frames.lastIndexOf(name);
    return index === -1 ? [...frames] : frames.slice(0, index);
  }
  if (/^ROLLBACK\b/i.test(cleaned)) {
    const to = /\bTO\s+(?:SAVEPOINT\s+)?([\s\S]*)$/i.exec(cleaned);
    if (to === null) return [];
    const name = savepointName(to[1] ?? '');
    const index = name === undefined ? -1 : frames.lastIndexOf(name);
    return index === -1 ? [...frames] : frames.slice(0, index + 1);
  }
  return [...frames];
}

/** Whether `sql` is one of the verbs that END a transaction — the ones whose "no transaction is active" failure clears the record. */
function endsTransaction(sql: string): boolean {
  const cleaned = stripSqlComments(sql).trim();
  return /^(COMMIT|END|ROLLBACK)\b/i.test(cleaned);
}

/** The one table a batch names — every plan, step or own statement (`dmlTargetTable`) the same one — else `undefined`. */
function batchTable(input: BrokeredWriteInput): string | undefined {
  const tables: ReadonlyArray<string | undefined> =
    'plans' in input ? input.plans.map((plan) => plan.table) : 'own' in input ? input.own.map((statement) => dmlTargetTable(statement.sql)) : input.undo.map((step) => step.table);
  const first = tables[0];
  if (first === undefined) return undefined;
  return tables.every((table) => table !== undefined && table.toLowerCase() === first.toLowerCase()) ? first : undefined;
}

const fail = (code: string, message: string, retryable: boolean): DbDriverResult => ({
  ok: false,
  code,
  message,
  retryable,
});

/** The brokered seat's own typed failure — the same shape `fail` answers a frame with. */
const seatFailure = (code: string, message: string, retryable: boolean): BrokeredWriteResult => ({ ok: false, code, message, retryable });

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** Minimal structural view of window/document so lifecycle hooks need no DOM lib in node. */
interface LifecycleTarget {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  visibilityState?: string;
}

/**
 * Debounce trade-off (documented on purpose): mutations are persisted `persistDebounceMs`
 * after the last write, so a hard crash inside that window can lose the most recent
 * writes. The driver narrows the window by auto-flushing on `pagehide` and on
 * `visibilitychange` → hidden (registered only when a window/document exists, removed by
 * close()); embedders should still await flush() on orderly teardown.
 */
export function createDbDriver(options: CreateDbDriverOptions = {}): SnugDbDriver {
  const backend = options.backend ?? detectPersistenceBackend();
  const debounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  const namespaces = new Map<string, Promise<NamespaceState>>();
  let sqlPromise: Promise<SqlJsStatic> | undefined;
  let closed = false;

  function loadSqlJs(): Promise<SqlJsStatic> {
    if (sqlPromise === undefined) {
      sqlPromise = initSqlJs(sqlJsInitConfig(options)).catch((err: unknown) => {
        sqlPromise = undefined; // transient init failures (network, wasm fetch) may be retried
        throw err;
      });
    }
    return sqlPromise;
  }

  async function doOpen(namespace: string): Promise<NamespaceState> {
    const SQL = await loadSqlJs();
    const file = namespaceToFileName(namespace);
    let db: Database | undefined;
    try {
      const bytes = await backend.load(file);
      if (bytes !== undefined) {
        db = new SQL.Database(bytes);
        db.exec('SELECT count(*) FROM sqlite_master'); // open-check: corrupt bytes fail here
      }
    } catch (err) {
      // Corrupt or unreadable persisted bytes: fail open with a fresh database rather
      // than bricking the namespace forever (the corrupt copy is overwritten on the
      // next persisted mutation) — but SURFACE it so embedders can log/notify.
      db?.close();
      db = undefined;
      options.onRecoverableError?.({
        namespace,
        kind: 'corrupt-persisted-bytes',
        message: `persisted bytes for "${namespace}" were unreadable — starting fresh: ${errorMessage(err)}`,
      });
    }
    db ??= new SQL.Database();
    return { db, file, dirty: false, timer: undefined, saving: Promise.resolve(), transaction: [] };
  }

  function openNamespace(namespace: string): Promise<NamespaceState> {
    let pending = namespaces.get(namespace);
    if (pending === undefined) {
      pending = doOpen(namespace).catch((err: unknown) => {
        namespaces.delete(namespace); // do not cache a failed open
        throw err;
      });
      namespaces.set(namespace, pending);
    }
    return pending;
  }

  function persist(state: NamespaceState): Promise<void> {
    const run = state.saving.then(async () => {
      if (!state.dirty || closed) return;
      state.dirty = false;
      const bytes = state.db.export();
      state.transaction = []; // export() closes and reopens the connection: an open transaction is gone with it
      try {
        await backend.save(state.file, bytes);
      } catch {
        state.dirty = true; // persistence failure must not take down the driver; retried on next flush/mutation
      }
    });
    state.saving = run.catch(() => undefined);
    return run;
  }

  /** Marked after every exec/kvSet/import; the debounce coalesces bursts into one write. */
  function markDirty(state: NamespaceState): void {
    state.dirty = true;
    if (state.timer !== undefined) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void persist(state);
    }, debounceMs);
  }

  function runExec(state: NamespaceState, sql: string, params: unknown[] | undefined): DbDriverResult {
    // Checked BEFORE preparing: the rejection must be the same typed error whether or
    // not the current engine happens to know the construct (e.g. load_extension).
    const forbidden = forbiddenStatementReason(sql);
    if (forbidden !== undefined) {
      return fail(DB_ERROR_CODES.FORBIDDEN_STATEMENT, `forbidden statement: ${forbidden}`, false);
    }
    let statement;
    try {
      const iterator = state.db.iterateStatements(sql);
      const first = iterator.next();
      if (first.done === true) return fail(DB_ERROR_CODES.SQL_ERROR, 'no SQL statement to execute', false);
      statement = first.value;
      if (!isSqlTailEmpty(iterator.getRemainingSQL())) {
        return fail(
          DB_ERROR_CODES.MULTI_STATEMENT,
          'exec accepts exactly one SQL statement — split multi-statement scripts into separate exec calls',
          false,
        );
      }
      if (params !== undefined && params.length > 0) {
        statement.bind(params.map((p) => (p === undefined ? null : p)) as BindParams);
      }
      const columns = statement.getColumnNames();
      const rows: unknown[][] = [];
      while (statement.step()) {
        rows.push((statement.get() as unknown[]).map(normalizeCell));
      }
      const payloadBytes = utf8ByteLength(JSON.stringify({ rows, columns }));
      if (payloadBytes > LIMITS.MAX_DB_FRAME_BYTES - FRAME_OVERHEAD_BYTES) {
        return fail(
          DB_ERROR_CODES.TOO_LARGE,
          `result is ${payloadBytes} bytes — too large for the ${LIMITS.MAX_DB_FRAME_BYTES}-byte db frame class; select less data`,
          false,
        );
      }
      markDirty(state); // any single statement may write; reads just refresh the debounce cheaply
      state.transaction = transactionAfter(state.transaction, sql);
      return { ok: true, rows, columns };
    } catch (err) {
      const message = errorMessage(err);
      // A COMMIT/END/ROLLBACK that finds no transaction tells the truth about the handle (E1-Q8).
      if (endsTransaction(sql) && NO_TRANSACTION_ACTIVE.test(message)) state.transaction = [];
      return fail(DB_ERROR_CODES.SQL_ERROR, message, false);
    } finally {
      statement?.free();
    }
  }

  const ensureKvTable = (db: Database): void => {
    db.run(KV_TABLE_DDL);
  };

  function runKvGet(state: NamespaceState, key: string): DbDriverResult {
    ensureKvTable(state.db);
    const statement = state.db.prepare('SELECT value FROM snug_kv WHERE key = ?');
    try {
      statement.bind([key]);
      if (!statement.step()) return { ok: true }; // absent key: no value field at all
      const raw = statement.get()[0];
      return { ok: true, value: JSON.parse(String(raw)) as unknown };
    } catch (err) {
      return fail(DB_ERROR_CODES.INTERNAL, `stored value for key "${key}" is unreadable: ${errorMessage(err)}`, false);
    } finally {
      statement.free();
    }
  }

  function runKvSet(state: NamespaceState, key: string, value: unknown): DbDriverResult {
    ensureKvTable(state.db);
    const json = JSON.stringify(value === undefined ? null : value);
    state.db.run('INSERT OR REPLACE INTO snug_kv (key, value) VALUES (?, ?)', [key, json]);
    markDirty(state);
    return { ok: true };
  }

  /** The host-side write (see `SnugDbDriver.kvSet`): a clear is a DELETE, a value is capped, the row is the app's own. */
  function runHostKvSet(state: NamespaceState, key: string, value: unknown): DbDriverResult {
    if (value === null || value === undefined) {
      ensureKvTable(state.db);
      state.db.run('DELETE FROM snug_kv WHERE key = ?', [key]);
      markDirty(state);
      return { ok: true };
    }
    const json = JSON.stringify(value);
    if (json === undefined) return fail(DB_ERROR_CODES.INTERNAL, 'the value cannot be serialised as JSON', false);
    const bytes = utf8ByteLength(json);
    if (bytes > HOST_KV_VALUE_MAX_BYTES) {
      return fail(DB_ERROR_CODES.TOO_LARGE, `value is ${bytes} bytes — the host-side kv cap is ${HOST_KV_VALUE_MAX_BYTES} bytes`, false);
    }
    return runKvSet(state, key, value);
  }

  /** The host-side entry shared by `kvSet`/`kvGet`: the closed check, the key bounds, the open, errors as data. */
  async function hostKv(namespace: string, key: string, op: (state: NamespaceState) => DbDriverResult): Promise<DbDriverResult> {
    if (closed) return fail(DB_ERROR_CODES.INTERNAL, 'db driver is closed', false);
    if (key.length === 0 || key.length > KV_KEY_MAX_CHARS) {
      return fail(DB_ERROR_CODES.INTERNAL, `kv key must be 1–${KV_KEY_MAX_CHARS} characters`, false);
    }
    let state: NamespaceState;
    try {
      state = await openNamespace(namespace);
    } catch (err) {
      return fail(DB_ERROR_CODES.INIT_FAILED, `db engine failed to initialize: ${errorMessage(err)}`, true);
    }
    try {
      return op(state);
    } catch (err) {
      return fail(DB_ERROR_CODES.INTERNAL, errorMessage(err), false);
    }
  }

  function runExport(state: NamespaceState): DbDriverResult {
    const bytes = state.db.export();
    state.transaction = []; // the reopened connection holds no transaction
    if (bytes.byteLength > LIMITS.MAX_ARTIFACT_BYTES) {
      return fail(
        DB_ERROR_CODES.TOO_LARGE,
        `database is ${bytes.byteLength} bytes — the export cap is ${LIMITS.MAX_ARTIFACT_BYTES} bytes (5 MiB)`,
        false,
      );
    }
    return { ok: true, bytesBase64: bytesToBase64(bytes) };
  }

  async function runImport(state: NamespaceState, bytesBase64: string): Promise<DbDriverResult> {
    const maxBase64Chars = Math.ceil(LIMITS.MAX_ARTIFACT_BYTES / 3) * 4 + 8;
    if (bytesBase64.length > maxBase64Chars) {
      return fail(DB_ERROR_CODES.TOO_LARGE, `import exceeds the ${LIMITS.MAX_ARTIFACT_BYTES}-byte (5 MiB) cap`, false);
    }
    const bytes = base64ToBytes(bytesBase64);
    if (bytes === undefined) return fail(DB_ERROR_CODES.BAD_IMPORT, 'bytesBase64 is not valid base64', false);
    if (bytes.byteLength > LIMITS.MAX_ARTIFACT_BYTES) {
      return fail(DB_ERROR_CODES.TOO_LARGE, `import is ${bytes.byteLength} bytes — the cap is ${LIMITS.MAX_ARTIFACT_BYTES} bytes (5 MiB)`, false);
    }
    if (!hasSqliteMagic(bytes)) {
      return fail(DB_ERROR_CODES.BAD_IMPORT, 'not a SQLite database (missing "SQLite format 3" header)', false);
    }
    const SQL = await loadSqlJs();
    let next: Database | undefined;
    try {
      next = new SQL.Database(bytes);
      next.exec('SELECT count(*) FROM sqlite_master'); // open-check before committing the swap
    } catch (err) {
      try {
        next?.close();
      } catch {
        /* the rejected candidate is discarded either way */
      }
      return fail(DB_ERROR_CODES.BAD_IMPORT, `not an openable SQLite database: ${errorMessage(err)}`, false);
    }
    state.db.close();
    state.db = next;
    state.transaction = []; // the handle the record described is gone
    markDirty(state);
    return { ok: true };
  }

  // The write signal (D-PR3-20 a): the option and the subscribed listeners hear the same
  // events, raised from `handle()` and `brokeredWrite` below — never from the run functions,
  // so the host's kv seat (which shares `runKvSet`) can never ring. Best-effort by design: the
  // write has landed, and a listener that throws must not turn it into a failure answer.
  const writeListeners = new Set<(event: NamespaceWriteEvent) => void>();
  function raiseWrite(event: NamespaceWriteEvent): void {
    for (const listener of [options.onNamespaceWrite, ...writeListeners]) {
      if (listener === undefined) continue;
      try {
        listener(event);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  async function flushAllNamespaces(): Promise<void> {
    const settled = await Promise.allSettled(namespaces.values());
    const states = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    await Promise.all(
      states.map((state) => {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        return persist(state);
      }),
    );
  }

  // Lifecycle auto-flush (Gate-5): the page going away or hidden is the last reliable
  // moment to persist the debounce window. Best-effort — storage writes are async and
  // pagehide gives no guarantees, so orderly teardown should still await flush().
  const onPageHide = (): void => {
    void flushAllNamespaces();
  };
  const onVisibilityChange = (): void => {
    if ((globalThis as { document?: LifecycleTarget }).document?.visibilityState === 'hidden') {
      void flushAllNamespaces();
    }
  };
  const lifecycleWindow = (globalThis as { window?: LifecycleTarget }).window;
  const lifecycleDocument = (globalThis as { document?: LifecycleTarget }).document;
  lifecycleWindow?.addEventListener?.('pagehide', onPageHide);
  lifecycleDocument?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    get persistence(): DbPersistence {
      return backend.kind === 'memory' ? 'none' : backend.kind;
    },

    async handle(namespace: string, request: DbRequestFrame): Promise<DbDriverResult> {
      if (closed) return fail(DB_ERROR_CODES.INTERNAL, 'db driver is closed', false);
      let state: NamespaceState;
      try {
        state = await openNamespace(namespace);
      } catch (err) {
        return fail(DB_ERROR_CODES.INIT_FAILED, `db engine failed to initialize: ${errorMessage(err)}`, true);
      }
      try {
        switch (request.op) {
          case 'exec': {
            const result = runExec(state, request.sql, request.params);
            if (result.ok && isRowModifyingStatement(request.sql)) {
              // `sqlite3_changes()` is the statement's own here: runExec stepped it to the end.
              const changes = state.db.getRowsModified();
              if (changes > 0) {
                const table = dmlTargetTable(request.sql);
                raiseWrite({ namespace, kind: 'exec', ...(table === undefined ? {} : { table }), changes });
              }
            }
            return result;
          }
          case 'kvGet':
            return runKvGet(state, request.key);
          case 'kvSet': {
            const result = runKvSet(state, request.key, request.value);
            if (result.ok) raiseWrite({ namespace, kind: 'kv' });
            return result;
          }
          case 'export':
            return runExport(state);
          case 'import': {
            const result = await runImport(state, request.bytesBase64);
            if (result.ok) raiseWrite({ namespace, kind: 'import' });
            return result;
          }
          default:
            return fail(
              DB_ERROR_CODES.INTERNAL,
              `unknown db op "${String((request as { op?: unknown }).op)}"`,
              false,
            );
        }
      } catch (err) {
        return fail(DB_ERROR_CODES.INTERNAL, errorMessage(err), false);
      }
    },

    flush(): Promise<void> {
      return flushAllNamespaces();
    },

    kvSet(namespace: string, key: string, value: unknown): Promise<DbDriverResult> {
      return hostKv(namespace, key, (state) => runHostKvSet(state, key, value));
    },

    kvGet(namespace: string, key: string): Promise<DbDriverResult> {
      return hostKv(namespace, key, (state) => runKvGet(state, key));
    },

    async brokeredWrite(namespace: string, input: BrokeredWriteInput): Promise<BrokeredWriteResult> {
      if (closed) return seatFailure(DB_ERROR_CODES.INTERNAL, 'db driver is closed', false);
      let state: NamespaceState;
      try {
        state = await openNamespace(namespace);
      } catch (err) {
        return seatFailure(DB_ERROR_CODES.INIT_FAILED, `db engine failed to initialize: ${errorMessage(err)}`, true);
      }
      // The record answers first — before the handle is touched — so the app's open
      // transaction is left exactly as it was (D-Q3); the apply's BEGIN IMMEDIATE is the belt.
      if (state.transaction.length > 0) return { ...BUSY_REFUSAL, retryable: true };
      let applied: BrokeredApplyResult;
      try {
        applied = applyBrokeredBatch(state.db, input);
      } catch (err) {
        return seatFailure(DB_ERROR_CODES.INTERNAL, errorMessage(err), false);
      }
      if (!applied.ok) return { ...applied, retryable: applied.reason === 'busy' };
      markDirty(state);
      const table = batchTable(input);
      raiseWrite({
        namespace,
        kind: 'brokered',
        ...(table === undefined ? {} : { table }),
        changes: applied.changes.reduce((sum, count) => sum + count, 0),
      });
      return applied;
    },

    async inTransaction(namespace: string): Promise<boolean> {
      if (closed) return false;
      const pending = namespaces.get(namespace);
      if (pending === undefined) return false; // never opened: nothing can be mid-transaction on it, and asking must not open it
      try {
        return (await pending).transaction.length > 0;
      } catch {
        return false; // a failed open cached nothing
      }
    },

    subscribeWrites(listener: (event: NamespaceWriteEvent) => void): () => void {
      writeListeners.add(listener);
      return () => {
        writeListeners.delete(listener);
      };
    },

    async evict(namespace: string): Promise<void> {
      const pending = namespaces.get(namespace);
      if (pending === undefined) return;
      // Drop the cache entry FIRST: a concurrent handle() must open a fresh state
      // rather than join the one being torn down.
      namespaces.delete(namespace);
      let state: NamespaceState;
      try {
        state = await pending;
      } catch {
        return; // a failed open cached nothing to close
      }
      // Cancel the debounce and DISCARD the dirty flag: evict exists for deletion, so
      // persisting here would write the very bytes the caller is removing.
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.dirty = false;
      // An in-flight save must land before the handle closes, or sql.js frees memory
      // out from under it.
      await state.saving.catch(() => undefined);
      state.db.close();
    },

    async close(): Promise<void> {
      if (closed) return;
      lifecycleWindow?.removeEventListener?.('pagehide', onPageHide);
      lifecycleDocument?.removeEventListener?.('visibilitychange', onVisibilityChange);
      await flushAllNamespaces();
      closed = true;
      const settled = await Promise.allSettled(namespaces.values());
      for (const s of settled) {
        if (s.status === 'fulfilled') s.value.db.close();
      }
      namespaces.clear();
    },
  };
}
