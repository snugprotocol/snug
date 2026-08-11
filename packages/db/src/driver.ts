// The per-app database driver: sql.js (WASM SQLite) with one database per HOST-assigned
// namespace, kv ops stored in a `snug_kv` table inside the same file (one file = whole
// app state), debounced write-back persistence, and 5 MiB artifact / 8 MiB db-frame caps.
//
// Contract: implements the runner's DbDriver seam — `handle` NEVER throws across the
// boundary; every failure is an ok:false DbDriverResult (errors-as-data, docs/standards).
import initSqlJs from 'sql.js';
import type { BindParams, Database, SqlJsStatic } from 'sql.js';
import { LIMITS, type DbRequestFrame } from '@snugprotocol/protocol';
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { DB_ERROR_CODES } from './errors.js';
import { namespaceToFileName } from './namespace.js';
import { detectPersistenceBackend, type PersistenceBackend } from './persistence.js';

/**
 * Mirrors the runner's DbDriverResult/DbDriver structurally (no runtime dependency on
 * @snugprotocol/runner; assignability is locked by a type-level test). Success fields
 * map 1:1 onto the TOP-LEVEL fields of a `snug:db-response` frame.
 */
export type DbDriverResult =
  | { ok: true; rows?: unknown[][]; columns?: string[]; value?: unknown; bytesBase64?: string }
  | { ok: false; code: string; message: string; retryable: boolean };

export type DbPersistence = 'opfs' | 'idb' | 'none';

/** A failure the driver recovered from on its own — surfaced so embedders can log/notify. */
export interface DbRecoverableErrorEvent {
  namespace: string;
  kind: 'corrupt-persisted-bytes';
  message: string;
}

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
  /** Write-back debounce after a mutation, in ms. flush() forces pending writes. */
  persistDebounceMs?: number;
  /**
   * Invoked once per occurrence when the driver recovers from a failure by itself —
   * currently: persisted bytes for a namespace were corrupt/unreadable and the driver
   * failed open with a fresh database (the alternative would brick the namespace).
   */
  onRecoverableError?: (event: DbRecoverableErrorEvent) => void;
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
}

/** Exported for the userdb materializer: the kv table must be byte-identical on both sides. */
export const KV_TABLE_DDL = 'CREATE TABLE IF NOT EXISTS snug_kv (key TEXT PRIMARY KEY, value TEXT)';
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
}

const fail = (code: string, message: string, retryable: boolean): DbDriverResult => ({
  ok: false,
  code,
  message,
  retryable,
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** True when the SQL tail is only whitespace, semicolons, and comments — i.e. no second statement. */
/** Exported alongside `forbiddenStatementReason` so `scratchRun` shares the multi-statement rule. */
export function isSqlTailEmpty(tail: string): boolean {
  return (
    tail
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/[\s;]+/g, '').length === 0
  );
}

/** BLOB cells become plain number arrays so results stay JSON/structured-clone friendly. */
export const normalizeCell = (cell: unknown): unknown => (cell instanceof Uint8Array ? Array.from(cell) : cell);

/**
 * Statement classes closed on purpose (Gate-5): ATTACH (reach outside the namespace
 * file), PRAGMA writable_schema (silent schema corruption), load_extension() (native
 * code). Checked on the comment-stripped statement text; other PRAGMAs stay allowed.
 *
 * EXPORTED as of TASK-20260811 (D7): `scratchRun` runs LLM-authored SQL through the SAME
 * guards. One definition, not two — a second copy is a second thing to forget to update.
 *
 * The `writable_schema` match tolerates SQLite's alternate spellings (fold F-Sm3b,
 * pre-existing and verified bypassable): the identifier may be quoted (`"writable_schema"`,
 * `'writable_schema'`, `[writable_schema]`, backticks) and/or schema-qualified
 * (`main.writable_schema`), all of which SQLite honors and the original anchored pattern
 * missed. Matching the bare token anywhere after `PRAGMA` is the conservative reading: the
 * cost of a false positive is one refused pragma naming a reserved word, and the cost of a
 * false negative is silent schema corruption.
 */
export function forbiddenStatementReason(sql: string): string | undefined {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (/^ATTACH\b/i.test(cleaned)) return 'ATTACH is not allowed';
  if (/^PRAGMA\b/i.test(cleaned) && /\bwritable_schema\b/i.test(cleaned)) {
    return 'PRAGMA writable_schema is not allowed';
  }
  if (/\bload_extension\s*\(/i.test(cleaned)) return 'load_extension() is not allowed';
  return undefined;
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
      const config = options.locateWasm !== undefined ? { locateFile: (file: string) => options.locateWasm!(file) } : undefined;
      sqlPromise = initSqlJs(config).catch((err: unknown) => {
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
    return { db, file, dirty: false, timer: undefined, saving: Promise.resolve() };
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
      const payloadBytes = utf8Bytes(JSON.stringify({ rows, columns }));
      if (payloadBytes > LIMITS.MAX_DB_FRAME_BYTES - FRAME_OVERHEAD_BYTES) {
        return fail(
          DB_ERROR_CODES.TOO_LARGE,
          `result is ${payloadBytes} bytes — too large for the ${LIMITS.MAX_DB_FRAME_BYTES}-byte db frame class; select less data`,
          false,
        );
      }
      markDirty(state); // any single statement may write; reads just refresh the debounce cheaply
      return { ok: true, rows, columns };
    } catch (err) {
      return fail(DB_ERROR_CODES.SQL_ERROR, errorMessage(err), false);
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

  function runExport(state: NamespaceState): DbDriverResult {
    const bytes = state.db.export();
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
    markDirty(state);
    return { ok: true };
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
          case 'exec':
            return runExec(state, request.sql, request.params);
          case 'kvGet':
            return runKvGet(state, request.key);
          case 'kvSet':
            return runKvSet(state, request.key, request.value);
          case 'export':
            return runExport(state);
          case 'import':
            return await runImport(state, request.bytesBase64);
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
