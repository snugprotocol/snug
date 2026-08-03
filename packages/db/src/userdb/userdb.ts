// The per-USER database (ADR-0007): one sql.js handle over one file holding hub tables
// (apps, versions, chat, settings, secrets, profile, sync config) plus blob-embedded
// per-app databases. One shared handle + one write-back pipeline serve both the typed
// CRUD API and the runner-facing DbDriver (F7 — two independent writers of one file are
// forbidden by construction). The driver face COMPOSES the existing per-app driver with
// a blob PersistenceBackend, so every exec/kv guardrail is inherited, not re-implemented.
//
// Unlike the per-app driver (errors-as-data at the frame boundary), the typed CRUD API
// throws UserDbError — it is an in-process API, mirroring useAppDB's throwing contract.
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import {
  USERDB_DDL,
  USERDB_FILE,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
} from '@snugprotocol/protocol';
import { createDbDriver, type DbPersistence, type SnugDbDriver } from '../driver.js';
import { namespaceToFileName } from '../namespace.js';
import { detectPersistenceBackend, type PersistenceBackend } from '../persistence.js';

export const USERDB_ERROR_CODES = {
  /** The whole-file cap (MAX_USERDB_BYTES or the injected override) would be exceeded. */
  TOO_LARGE: 'USERDB_TOO_LARGE',
  /** Import payload is not an openable Snug user DB (magic/open-check/version failed). */
  BAD_IMPORT: 'USERDB_BAD_IMPORT',
  /** The referenced app/version/thread does not exist. */
  NOT_FOUND: 'USERDB_NOT_FOUND',
  /** The UserDb was closed. */
  CLOSED: 'USERDB_CLOSED',
} as const;

export type UserDbErrorCode = (typeof USERDB_ERROR_CODES)[keyof typeof USERDB_ERROR_CODES];

export class UserDbError extends Error {
  constructor(
    readonly code: UserDbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserDbError';
  }
}

export interface AppRecord {
  appId: string;
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  usesDb: boolean;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppVersionMeta {
  version: number;
  note?: string;
  createdAt: string;
  htmlBytes: number;
}

export interface ChatThread {
  threadId: string;
  appId?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface InstallAppInput {
  appId?: string;
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  usesDb?: boolean;
  html: string;
  note?: string;
}

export interface UserDb {
  readonly persistence: DbPersistence;
  /** Runner-facing DbDriver over blob-embedded app databases (inject into SnugAppFrame). */
  readonly driver: SnugDbDriver;

  installApp(input: InstallAppInput): AppRecord;
  saveAppVersion(appId: string, html: string, note?: string): AppVersionMeta;
  /** Patch display metadata (announce overlay, usesDb observation) — versions untouched. */
  updateAppMeta(
    appId: string,
    patch: Partial<Pick<AppRecord, 'displayName' | 'description' | 'iconEmoji' | 'iconColor' | 'usesDb'>>,
  ): void;
  listApps(): AppRecord[];
  getApp(appId: string): AppRecord | undefined;
  getAppHtml(appId: string, version?: number): string | undefined;
  listAppVersions(appId: string): AppVersionMeta[];
  revertApp(appId: string, toVersion: number): AppVersionMeta;

  upsertThread(threadId: string, opts?: { appId?: string; title?: string }): void;
  appendChatMessage(threadId: string, role: ChatMessage['role'], content: string): ChatMessage;
  listThreads(): ChatThread[];
  listChatMessages(threadId: string): ChatMessage[];

  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  getProfileField(key: string): unknown;
  setProfileField(key: string, value: unknown): void;
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
  getSyncConfig(key: string): unknown;
  setSyncConfig(key: string, value: unknown): void;

  /** Standalone `.sqlite` bytes of one app's data namespace (flushes the driver first). */
  deriveAppExport(namespace: string): Promise<Uint8Array | undefined>;
  /** Whole-file export. Default strips `snug_secrets` and VACUUMs so freed pages leak nothing. */
  exportUserDb(opts?: { includeSecrets?: boolean }): Promise<Uint8Array>;
  /** Full replace with validated user-DB bytes (older schemas are migrated forward). */
  importUserDb(bytes: Uint8Array): Promise<void>;

  flush(): Promise<void>;
  close(): Promise<void>;
}

export type OpenUserDbResult =
  | { status: 'ok'; userDb: UserDb }
  | {
      status: 'corrupt';
      quarantinedFile: string;
      message: string;
      /** Explicit caller decision (F6): start over with an empty DB, quarantine retained. */
      openFresh(): Promise<UserDb>;
    }
  | { status: 'unsupported'; foundVersion: number; message: string };

export interface OpenUserDbOptions {
  backend?: PersistenceBackend;
  locateWasm?: (file: string) => string;
  persistDebounceMs?: number;
  /** Whole-file cap; defaults to the spec constant. Tests shrink it. */
  maxBytes?: number;
  /** Versions retained per app; defaults to the spec constant. */
  versionsRetained?: number;
  file?: string;
}

const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function readUserVersion(db: Database): number {
  const result = db.exec('PRAGMA user_version');
  const value = result[0]?.values[0]?.[0];
  return typeof value === 'number' ? value : 0;
}

/** Forward-only migrations; index N migrates FROM version N. v0 → v1 applies the full DDL. */
const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
  },
];

function migrate(db: Database): void {
  const found = readUserVersion(db);
  for (let v = found; v < USERDB_SCHEMA_VERSION; v++) {
    MIGRATIONS[v]?.(db);
  }
  db.run(`PRAGMA user_version = ${USERDB_SCHEMA_VERSION}`);
}

interface LifecycleTarget {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  visibilityState?: string;
}

export async function openUserDb(options: OpenUserDbOptions = {}): Promise<OpenUserDbResult> {
  // Default backend lives in the user DB's OWN directory (F13) — never the per-app store.
  const backend = options.backend ?? detectPersistenceBackend(USERDB_OPFS_DIR);
  const file = options.file ?? USERDB_FILE;
  const config = options.locateWasm !== undefined ? { locateFile: (f: string) => options.locateWasm!(f) } : undefined;
  const SQL = await initSqlJs(config);

  const stored = await backend.load(file);
  if (stored !== undefined) {
    let candidate: Database | undefined;
    try {
      candidate = new SQL.Database(stored);
      candidate.exec('SELECT count(*) FROM sqlite_master'); // open-check: corrupt bytes fail here
    } catch (err) {
      candidate?.close();
      // F6: the user DB never fails open — quarantine and make recovery an explicit choice.
      const quarantinedFile = `${file}.corrupt.bak`;
      await backend.save(quarantinedFile, stored);
      return {
        status: 'corrupt',
        quarantinedFile,
        message: `user DB bytes were unreadable and were quarantined to "${quarantinedFile}": ${errorMessage(err)}`,
        openFresh: () => Promise.resolve(construct(SQL, new SQL.Database(), backend, file, options)),
      };
    }
    const foundVersion = readUserVersion(candidate);
    if (foundVersion > USERDB_SCHEMA_VERSION) {
      candidate.close();
      return {
        status: 'unsupported',
        foundVersion,
        message: `user DB is schema v${foundVersion}; this hub supports up to v${USERDB_SCHEMA_VERSION} — upgrade the hub, do not overwrite the file`,
      };
    }
    return { status: 'ok', userDb: construct(SQL, candidate, backend, file, options) };
  }

  return { status: 'ok', userDb: construct(SQL, new SQL.Database(), backend, file, options) };
}

function construct(
  SQL: SqlJsStatic,
  initial: Database,
  backend: PersistenceBackend,
  file: string,
  options: OpenUserDbOptions,
): UserDb {
  let db = initial;
  const debounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  const maxBytes = options.maxBytes ?? USERDB_LIMITS.MAX_USERDB_BYTES;
  const retained = options.versionsRetained ?? USERDB_LIMITS.VERSIONS_RETAINED;
  let closed = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  migrate(db);
  seedMeta();

  // ------------------------------------------------------------- write-back pipeline

  function persist(): Promise<void> {
    const run = saving.then(async () => {
      if (!dirty || closed) return;
      dirty = false;
      const bytes = db.export();
      try {
        await backend.save(file, bytes);
      } catch {
        dirty = true; // persistence failure must not take down the service; retried on next flush/mutation
      }
    });
    saving = run.catch(() => undefined);
    return run;
  }

  function markDirty(): void {
    dirty = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void persist();
    }, debounceMs);
  }

  async function persistNow(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await persist();
  }

  const onPageHide = (): void => {
    void persistNow();
  };
  const onVisibilityChange = (): void => {
    if ((globalThis as { document?: LifecycleTarget }).document?.visibilityState === 'hidden') void persistNow();
  };
  const lifecycleWindow = (globalThis as { window?: LifecycleTarget }).window;
  const lifecycleDocument = (globalThis as { document?: LifecycleTarget }).document;
  lifecycleWindow?.addEventListener?.('pagehide', onPageHide);
  lifecycleDocument?.addEventListener?.('visibilitychange', onVisibilityChange);

  // --------------------------------------------------------------------- sql helpers

  function assertOpen(): void {
    if (closed) throw new UserDbError(USERDB_ERROR_CODES.CLOSED, 'user DB is closed');
  }

  function run(sql: string, params?: unknown[]): void {
    db.run(sql, (params ?? []) as never);
    markDirty();
  }

  function select(sql: string, params?: unknown[]): unknown[][] {
    const statement = db.prepare(sql);
    try {
      if (params !== undefined && params.length > 0) statement.bind(params as never);
      const rows: unknown[][] = [];
      while (statement.step()) rows.push(statement.get() as unknown[]);
      return rows;
    } finally {
      statement.free();
    }
  }

  function now(): string {
    return new Date().toISOString();
  }

  function seedMeta(): void {
    const seeded = select(`SELECT value FROM ${USERDB_TABLES.meta} WHERE key = 'db_id'`);
    if (seeded.length === 0) {
      run(`INSERT INTO ${USERDB_TABLES.meta} (key, value) VALUES ('db_id', ?), ('created_at', ?)`, [
        crypto.randomUUID(),
        now(),
      ]);
    }
  }

  /** Approximate current size without a full export: page_count × page_size. */
  function currentBytes(): number {
    const pages = select('PRAGMA page_count')[0]?.[0];
    const pageSize = select('PRAGMA page_size')[0]?.[0];
    return (typeof pages === 'number' ? pages : 0) * (typeof pageSize === 'number' ? pageSize : 0);
  }

  function guardAddedBytes(added: number, what: string): void {
    if (currentBytes() + added > maxBytes) {
      throw new UserDbError(
        USERDB_ERROR_CODES.TOO_LARGE,
        `${what} would push the user DB past the ${maxBytes}-byte cap`,
      );
    }
  }

  // ------------------------------------------------- kv tables (settings/profile/…)

  function kvGet(table: string, key: string): unknown {
    assertOpen();
    const rows = select(`SELECT value FROM ${table} WHERE key = ?`, [key]);
    const raw = rows[0]?.[0];
    return raw === undefined ? undefined : (JSON.parse(String(raw)) as unknown);
  }

  function kvSet(table: string, key: string, value: unknown): void {
    assertOpen();
    guardAddedBytes(JSON.stringify(value ?? null).length + key.length, `setting "${key}"`);
    run(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`, [key, JSON.stringify(value ?? null)]);
  }

  // ------------------------------------------ driver face: blob PersistenceBackend

  // The per-app driver computes file names via namespaceToFileName; those file names are
  // the `namespace` column keys in snug_app_data. Composing createDbDriver over this
  // backend inherits every exec/kv/export/import guardrail from the tested driver.
  const blobBackend: PersistenceBackend = {
    kind: backend.kind,
    load: (blobFile) => {
      const rows = select(`SELECT bytes FROM ${USERDB_TABLES.appData} WHERE namespace = ?`, [blobFile]);
      const raw = rows[0]?.[0];
      return Promise.resolve(raw instanceof Uint8Array ? raw : undefined);
    },
    save: (blobFile, bytes) => {
      guardAddedBytes(bytes.byteLength, `app data for "${blobFile}"`);
      run(`INSERT OR REPLACE INTO ${USERDB_TABLES.appData} (namespace, bytes, updated_at) VALUES (?, ?, ?)`, [
        blobFile,
        bytes,
        now(),
      ]);
      return Promise.resolve();
    },
  };

  const makeInnerDriver = (): SnugDbDriver =>
    createDbDriver({
      backend: blobBackend,
      ...(options.locateWasm !== undefined ? { locateWasm: options.locateWasm } : {}),
      persistDebounceMs: debounceMs,
    });

  let inner = makeInnerDriver();

  /** Stable facade so `userDb.driver` survives importUserDb swapping the inner driver. */
  const driver: SnugDbDriver = {
    handle: (namespace, request) => inner.handle(namespace, request),
    get persistence() {
      return inner.persistence;
    },
    flush: () => inner.flush(),
    close: () => inner.close(),
  };

  // ------------------------------------------------------------------------- apps

  const toAppRecord = (row: unknown[]): AppRecord => ({
    appId: String(row[0]),
    displayName: String(row[1]),
    ...(row[2] !== null && row[2] !== undefined ? { description: String(row[2]) } : {}),
    ...(row[3] !== null && row[3] !== undefined ? { iconEmoji: String(row[3]) } : {}),
    ...(row[4] !== null && row[4] !== undefined ? { iconColor: String(row[4]) } : {}),
    usesDb: row[5] === 1,
    currentVersion: Number(row[6]),
    createdAt: String(row[7]),
    updatedAt: String(row[8]),
  });

  const APP_COLUMNS =
    'app_id, display_name, description, icon_emoji, icon_color, uses_db, current_version, created_at, updated_at';

  function getApp(appId: string): AppRecord | undefined {
    assertOpen();
    const rows = select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
    const row = rows[0];
    return row === undefined ? undefined : toAppRecord(row);
  }

  function insertVersion(appId: string, version: number, html: string, note: string | undefined): AppVersionMeta {
    const createdAt = now();
    run(`INSERT INTO ${USERDB_TABLES.appVersions} (app_id, version, html, note, created_at) VALUES (?, ?, ?, ?, ?)`, [
      appId,
      version,
      html,
      note ?? null,
      createdAt,
    ]);
    run(`DELETE FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version <= ?`, [appId, version - retained]);
    return { version, ...(note !== undefined ? { note } : {}), createdAt, htmlBytes: html.length };
  }

  return {
    get persistence(): DbPersistence {
      return backend.kind === 'memory' ? 'none' : backend.kind;
    },
    driver,

    installApp(input) {
      assertOpen();
      guardAddedBytes(input.html.length, `installing "${input.displayName}"`);
      const appId = input.appId ?? crypto.randomUUID();
      const timestamp = now();
      run(
        `INSERT INTO ${USERDB_TABLES.apps} (${APP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          appId,
          input.displayName,
          input.description ?? null,
          input.iconEmoji ?? null,
          input.iconColor ?? null,
          input.usesDb === true ? 1 : 0,
          1,
          timestamp,
          timestamp,
        ],
      );
      insertVersion(appId, 1, input.html, input.note);
      return getApp(appId) as AppRecord;
    },

    saveAppVersion(appId, html, note) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      guardAddedBytes(html.length, `new version of "${appId}"`);
      const version = app.currentVersion + 1;
      const meta = insertVersion(appId, version, html, note);
      run(`UPDATE ${USERDB_TABLES.apps} SET current_version = ?, updated_at = ? WHERE app_id = ?`, [
        version,
        now(),
        appId,
      ]);
      return meta;
    },

    updateAppMeta(appId, patch) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      const merged = { ...app, ...patch };
      run(
        `UPDATE ${USERDB_TABLES.apps}
         SET display_name = ?, description = ?, icon_emoji = ?, icon_color = ?, uses_db = ?, updated_at = ?
         WHERE app_id = ?`,
        [
          merged.displayName,
          merged.description ?? null,
          merged.iconEmoji ?? null,
          merged.iconColor ?? null,
          merged.usesDb === true ? 1 : 0,
          now(),
          appId,
        ],
      );
    },

    listApps() {
      assertOpen();
      return select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} ORDER BY updated_at DESC, app_id`).map(
        toAppRecord,
      );
    },

    getApp,

    getAppHtml(appId, version) {
      assertOpen();
      const target = version ?? getApp(appId)?.currentVersion;
      if (target === undefined) return undefined;
      const rows = select(`SELECT html FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version = ?`, [
        appId,
        target,
      ]);
      const html = rows[0]?.[0];
      return html === undefined ? undefined : String(html);
    },

    listAppVersions(appId) {
      assertOpen();
      return select(
        `SELECT version, note, created_at, length(html) FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? ORDER BY version DESC`,
        [appId],
      ).map((row) => ({
        version: Number(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { note: String(row[1]) } : {}),
        createdAt: String(row[2]),
        htmlBytes: Number(row[3]),
      }));
    },

    revertApp(appId, toVersion) {
      assertOpen();
      const html = this.getAppHtml(appId, toVersion);
      if (html === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" has no version ${toVersion}`);
      }
      return this.saveAppVersion(appId, html, `revert to v${toVersion}`);
    },

    // ------------------------------------------------------------------------ chat

    upsertThread(threadId, opts = {}) {
      assertOpen();
      const timestamp = now();
      run(
        `INSERT INTO ${USERDB_TABLES.chatThreads} (thread_id, app_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           app_id = COALESCE(excluded.app_id, app_id),
           title = COALESCE(excluded.title, title),
           updated_at = excluded.updated_at`,
        [threadId, opts.appId ?? null, opts.title ?? null, timestamp, timestamp],
      );
    },

    appendChatMessage(threadId, role, content) {
      assertOpen();
      guardAddedBytes(content.length, 'chat message');
      this.upsertThread(threadId);
      const createdAt = now();
      run(`INSERT INTO ${USERDB_TABLES.chatMessages} (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)`, [
        threadId,
        role,
        content,
        createdAt,
      ]);
      const id = select('SELECT last_insert_rowid()')[0]?.[0];
      return { id: Number(id), threadId, role, content, createdAt };
    },

    listThreads() {
      assertOpen();
      return select(
        `SELECT thread_id, app_id, title, created_at, updated_at FROM ${USERDB_TABLES.chatThreads} ORDER BY updated_at DESC`,
      ).map((row) => ({
        threadId: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { appId: String(row[1]) } : {}),
        ...(row[2] !== null && row[2] !== undefined ? { title: String(row[2]) } : {}),
        createdAt: String(row[3]),
        updatedAt: String(row[4]),
      }));
    },

    listChatMessages(threadId) {
      assertOpen();
      return select(
        `SELECT id, role, content, created_at FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? ORDER BY id`,
        [threadId],
      ).map((row) => ({
        id: Number(row[0]),
        threadId,
        role: String(row[1]) as ChatMessage['role'],
        content: String(row[2]),
        createdAt: String(row[3]),
      }));
    },

    // ----------------------------------------------------- settings/profile/secrets

    getSetting: (key) => kvGet(USERDB_TABLES.settings, key),
    setSetting: (key, value) => kvSet(USERDB_TABLES.settings, key, value),
    getProfileField: (key) => kvGet(USERDB_TABLES.profile, key),
    setProfileField: (key, value) => kvSet(USERDB_TABLES.profile, key, value),

    getSecret(key) {
      assertOpen();
      const rows = select(`SELECT value FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [key]);
      const raw = rows[0]?.[0];
      return raw === undefined ? undefined : String(raw);
    },
    setSecret(key, value) {
      assertOpen();
      run(`INSERT OR REPLACE INTO ${USERDB_TABLES.secrets} (key, value) VALUES (?, ?)`, [key, value]);
    },
    deleteSecret(key) {
      assertOpen();
      run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [key]);
    },
    listSecretKeys() {
      assertOpen();
      return select(`SELECT key FROM ${USERDB_TABLES.secrets} ORDER BY key`).map((row) => String(row[0]));
    },

    getSyncConfig: (key) => kvGet(USERDB_TABLES.sync, key),
    setSyncConfig: (key, value) => kvSet(USERDB_TABLES.sync, key, value),

    // --------------------------------------------------------------- export/import

    async deriveAppExport(namespace) {
      assertOpen();
      await inner.flush();
      const blobFile = namespaceToFileName(namespace);
      const rows = select(`SELECT bytes FROM ${USERDB_TABLES.appData} WHERE namespace = ?`, [blobFile]);
      const raw = rows[0]?.[0];
      return raw instanceof Uint8Array ? raw.slice() : undefined;
    },

    async exportUserDb(opts = {}) {
      assertOpen();
      await inner.flush();
      const bytes = db.export();
      if (opts.includeSecrets === true) {
        if (bytes.byteLength > maxBytes) {
          throw new UserDbError(USERDB_ERROR_CODES.TOO_LARGE, `export is ${bytes.byteLength} bytes — cap is ${maxBytes}`);
        }
        return bytes;
      }
      // Strip on a throwaway copy; VACUUM so deleted secret rows leave no bytes in free pages.
      const temp = new SQL.Database(bytes);
      try {
        temp.run(`DELETE FROM ${USERDB_TABLES.secrets}`);
        temp.run('VACUUM');
        const stripped = temp.export();
        if (stripped.byteLength > maxBytes) {
          throw new UserDbError(
            USERDB_ERROR_CODES.TOO_LARGE,
            `export is ${stripped.byteLength} bytes — cap is ${maxBytes}`,
          );
        }
        return stripped;
      } finally {
        temp.close();
      }
    },

    async importUserDb(bytes) {
      assertOpen();
      if (bytes.byteLength > maxBytes) {
        throw new UserDbError(USERDB_ERROR_CODES.TOO_LARGE, `import is ${bytes.byteLength} bytes — cap is ${maxBytes}`);
      }
      if (!hasSqliteMagic(bytes)) {
        throw new UserDbError(USERDB_ERROR_CODES.BAD_IMPORT, 'not a SQLite database (missing magic header)');
      }
      let next: Database | undefined;
      try {
        next = new SQL.Database(bytes);
        next.exec('SELECT count(*) FROM sqlite_master');
      } catch (err) {
        next?.close();
        throw new UserDbError(USERDB_ERROR_CODES.BAD_IMPORT, `not an openable SQLite database: ${errorMessage(err)}`);
      }
      const foundVersion = readUserVersion(next);
      if (foundVersion > USERDB_SCHEMA_VERSION) {
        next.close();
        throw new UserDbError(
          USERDB_ERROR_CODES.BAD_IMPORT,
          `user DB is schema v${foundVersion}; this hub supports up to v${USERDB_SCHEMA_VERSION}`,
        );
      }
      migrate(next);
      // Close the inner driver FIRST: its cached app databases came from the old handle.
      // Its close-flush writes into the old handle, which is discarded right after.
      await inner.close();
      db.close();
      db = next;
      inner = makeInnerDriver();
      markDirty();
    },

    async flush() {
      await inner.flush();
      await persistNow();
    },

    async close() {
      if (closed) return;
      lifecycleWindow?.removeEventListener?.('pagehide', onPageHide);
      lifecycleDocument?.removeEventListener?.('visibilitychange', onVisibilityChange);
      await inner.close();
      await persistNow();
      closed = true;
      db.close();
    },
  };
}
