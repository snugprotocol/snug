// The per-USER database (ADR-0007 + ADR-0010): one sql.js handle over one file holding
// hub tables (apps, versions, schema registry, docs, chat, settings, secrets, profile,
// sync config) plus per-app data as REAL namespaced tables (`app_<token>__<name>`).
// One shared handle + one write-back pipeline serve both the typed CRUD API and the
// runner-facing DbDriver (F7 — two independent writers of one file are forbidden by
// construction). The driver face COMPOSES the existing per-app driver with a
// MATERIALIZER PersistenceBackend: at run, an app's objects are replayed into the app's
// own database (natural names — physical isolation preserved); at rest, table rows live
// under `app_<token>__<name>` and the registry carries the runtime sqlite_master DDL
// VERBATIM. DDL bodies are never string-rewritten; at-rest names come from SQLite's own
// ALTER TABLE … RENAME under legacy_alter_table (a pure name swap). Objects with names
// outside the normative rule fail the write-back CLOSED (previous rest state retained,
// surfaced via onAppPersistError) — nothing is ever built from an unvalidated name.
//
// Unlike the per-app driver (errors-as-data at the frame boundary), the typed CRUD API
// throws UserDbError — it is an in-process API, mirroring useAppDB's throwing contract.
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import {
  APP_KV_TABLE,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  USERDB_DDL,
  USERDB_FILE,
  USERDB_INDEX_DDL,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
  appDataToken,
  appRestTableName,
  isValidAppObjectName,
  type AppSchemaJson,
  type AppSchemaObject,
  type DbRequestFrame,
} from '@snugprotocol/protocol';
import { KV_TABLE_DDL, createDbDriver, type DbPersistence, type SnugDbDriver } from '../driver.js';
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
  /** An app runtime object name violates the normative naming rule (write-back refused). */
  INVALID_NAME: 'USERDB_INVALID_NAME',
  /** applyAppDdl failed; the app runtime was restored to its pre-batch snapshot. */
  DDL_FAILED: 'USERDB_DDL_FAILED',
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

/** A write-back failure the service recovered from by keeping the previous rest state. */
export interface AppPersistErrorEvent {
  namespace: string;
  code: string;
  message: string;
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
  /** Dedup identity for marketplace/starter installs (`starter:<folder>`); absent for built apps. */
  installSource?: string;
}

export interface AppVersionMeta {
  version: number;
  note?: string;
  createdAt: string;
  htmlBytes: number;
  /** Pinned versions (the factory version) are never pruned. */
  pinned: boolean;
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
  /** Pinned messages (the bootstrap turn) survive any pruning for the life of the app. */
  pinned: boolean;
  /** Structured sidecar: artifact card refs, wire text — JSON, shape owned by the client. */
  meta?: unknown;
}

export interface AppDocRecord {
  slug: string;
  title?: string;
  content: string;
  updatedAt: string;
}

export interface AppMigrationRecord {
  seq: number;
  ddl: string;
  appliedAt: string;
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
  /** When present, install is find-or-create on this identity (unique at the DB level). */
  installSource?: string;
}

export interface UserDb {
  readonly persistence: DbPersistence;
  /** Runner-facing DbDriver over materialized per-app databases (inject into SnugAppFrame). */
  readonly driver: SnugDbDriver;

  installApp(input: InstallAppInput): AppRecord;
  saveAppVersion(appId: string, html: string, note?: string): AppVersionMeta;
  /** Patch display metadata (announce overlay, usesDb observation) — versions untouched. */
  updateAppMeta(
    appId: string,
    patch: Partial<Pick<AppRecord, 'displayName' | 'description' | 'iconEmoji' | 'iconColor' | 'usesDb'>>,
  ): void;
  listApps(): AppRecord[];
  /**
   * Delete an installed app and cascade to every referencing row in one transaction:
   * its `app_<token>__*` data tables, schema, migrations, docs, versions, threads and
   * their chat messages, then the app row. IGNORES `pinned` — the factory version and
   * bootstrap message go too. Throws NOT_FOUND for an unknown app; rolls back whole on
   * any failure. Marks dirty and flushes, so the delete reaches the exported bytes.
   */
  deleteApp(appId: string): Promise<void>;
  getApp(appId: string): AppRecord | undefined;
  getAppByInstallSource(source: string): AppRecord | undefined;
  getAppHtml(appId: string, version?: number): string | undefined;
  listAppVersions(appId: string): AppVersionMeta[];
  revertApp(appId: string, toVersion: number): AppVersionMeta;
  /** Copy-forward to the pinned factory version (the never-pruned v1 of build/install). */
  resetToFactory(appId: string): AppVersionMeta;

  /** The app's registered schema (verbatim natural DDL), or undefined when it has none. */
  getAppSchema(appId: string): AppSchemaJson | undefined;
  /**
   * Hub-side execution layer for LLM-proposed DDL: applies the statements to the app's
   * materialized runtime atomically (all-or-nothing via snapshot restore), then
   * persists + registers the schema and appends the audit trail.
   */
  applyAppDdl(appId: string, statements: string[]): Promise<AppSchemaJson>;
  listAppMigrations(appId: string): AppMigrationRecord[];

  putAppDoc(appId: string, slug: string, doc: { title?: string; content: string }): void;
  getAppDoc(appId: string, slug: string): AppDocRecord | undefined;
  listAppDocs(appId: string): AppDocRecord[];
  deleteAppDoc(appId: string, slug: string): void;

  upsertThread(threadId: string, opts?: { appId?: string; title?: string }): void;
  appendChatMessage(
    threadId: string,
    role: ChatMessage['role'],
    content: string,
    opts?: { pinned?: boolean; meta?: unknown },
  ): ChatMessage;
  /** Marks an already-stored message as bootstrap (review F9: the v1-artifact turn). */
  pinChatMessage(id: number): void;
  /** Deletes unpinned messages beyond the newest `keepUnpinned`; pinned rows always survive. */
  pruneChatMessages(threadId: string, keepUnpinned: number): void;
  listThreads(): ChatThread[];
  getThread(threadId: string): ChatThread | undefined;
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
  /** Unpinned versions retained per app; defaults to the spec constant. */
  versionsRetained?: number;
  file?: string;
  /** Surfaced when a write-back fails closed (name gate, cap) — previous rest state retained. */
  onAppPersistError?: (event: AppPersistErrorEvent) => void;
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

/** `"…"`-quote an identifier. Table names are rule-validated BEFORE quoting; column names may be arbitrary. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function hasColumn(db: Database, table: string, column: string): boolean {
  const info = db.exec(`PRAGMA table_info(${table})`);
  return (info[0]?.values ?? []).some((row) => String(row[1]) === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, decl: string): void {
  if (!hasColumn(db, table, column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Forward-only migrations; index N migrates FROM version N. v0 → current applies the full DDL. */
const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
  // v1 → v2 (ADR-0010): STRUCTURAL only — blob app data is abandoned (owner-approved,
  // pre-launch). New tables/columns/index land; the oldest surviving version per app is
  // stamped as the factory version so the pin invariant holds for migrated files.
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    addColumnIfMissing(db, USERDB_TABLES.apps, 'install_source', 'TEXT');
    addColumnIfMissing(db, USERDB_TABLES.appVersions, 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, USERDB_TABLES.chatMessages, 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, USERDB_TABLES.chatMessages, 'meta', 'TEXT');
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
    db.run('DROP TABLE IF EXISTS snug_app_data');
    db.run(
      `UPDATE ${USERDB_TABLES.appVersions} SET pinned = 1 WHERE (app_id, version) IN
       (SELECT app_id, MIN(version) FROM ${USERDB_TABLES.appVersions} GROUP BY app_id)`,
    );
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
      // sql.js silently treats empty/zeroed bytes as a fresh database — but for the
      // USER DB that means an interrupted write would silently erase everything.
      // Magic-less stored bytes are corruption, full stop (F6).
      if (!hasSqliteMagic(stored)) throw new Error('missing SQLite header (empty or truncated file)');
      candidate = new SQL.Database(stored);
      candidate.exec('SELECT count(*) FROM sqlite_master'); // open-check: corrupt bytes fail here
    } catch (err) {
      candidate?.close();
      // F6: the user DB never fails open — quarantine and make recovery an explicit
      // choice. Unique name per occurrence: repeat corruption must not overwrite the
      // previous forensic copy (umbrella review minor 6).
      const quarantinedFile = `${file}.corrupt-${Date.now().toString(36)}.bak`;
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

  function selectFrom(target: Database, sql: string, params?: unknown[]): unknown[][] {
    const statement = target.prepare(sql);
    try {
      if (params !== undefined && params.length > 0) statement.bind(params as never);
      const rows: unknown[][] = [];
      while (statement.step()) rows.push(statement.get() as unknown[]);
      return rows;
    } finally {
      statement.free();
    }
  }

  function select(sql: string, params?: unknown[]): unknown[][] {
    return selectFrom(db, sql, params);
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

  // ------------------------------------- driver face: materializer PersistenceBackend
  //
  // The per-app driver computes file names via namespaceToFileName; the wrapper below
  // records the namespace → token mapping BEFORE delegating so load/save can key rest
  // tables. Composing createDbDriver over this backend inherits every exec/kv/export/
  // import guardrail from the tested driver.

  interface NamespaceInfo {
    namespace: string;
    token: string;
  }

  const namespaceByFile = new Map<string, NamespaceInfo>();
  /** F6 sync-hash stability: identical runtime bytes → write-back is a no-op. */
  const lastSavedHash = new Map<string, string>();

  function noteNamespace(namespace: string): string {
    const blobFile = namespaceToFileName(namespace);
    if (!namespaceByFile.has(blobFile)) {
      namespaceByFile.set(blobFile, { namespace, token: appDataToken(namespace) });
    }
    return blobFile;
  }

  function bytesHash(bytes: Uint8Array): string {
    let hash = 5381;
    for (let i = 0; i < bytes.length; i++) {
      hash = ((hash << 5) + hash + bytes[i]!) | 0;
    }
    return `${bytes.length}:${(hash >>> 0).toString(16)}`;
  }

  function restTablesFor(token: string): string[] {
    return select(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ?`, [
      `app_${token}__*`,
    ]).map((row) => String(row[0]));
  }

  function readSchemaJson(token: string): AppSchemaJson | undefined {
    const raw = select(`SELECT schema_json FROM ${USERDB_TABLES.appSchemas} WHERE token = ?`, [token])[0]?.[0];
    return raw === undefined ? undefined : (JSON.parse(String(raw)) as AppSchemaJson);
  }

  /** Copy all rows between same-shaped tables in two databases (non-generated columns only). */
  function copyRows(from: Database, fromTable: string, to: Database, toTable: string): void {
    const columns = selectFrom(from, `PRAGMA table_xinfo(${quoteIdent(fromTable)})`)
      .filter((row) => Number(row[6]) === 0)
      .map((row) => String(row[1]));
    if (columns.length === 0) return;
    const columnList = columns.map(quoteIdent).join(', ');
    const read = from.prepare(`SELECT ${columnList} FROM ${quoteIdent(fromTable)}`);
    const write = to.prepare(
      `INSERT INTO ${quoteIdent(toTable)} (${columnList}) VALUES (${columns.map(() => '?').join(', ')})`,
    );
    try {
      while (read.step()) {
        write.run(read.get() as never);
      }
    } finally {
      read.free();
      write.free();
    }
  }

  function hasTable(target: Database, name: string): boolean {
    return (
      selectFrom(target, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).length > 0
    );
  }

  /** Build the app's runtime database (natural names) from rest tables + registry. */
  function materializeBytes(info: NamespaceInfo): Uint8Array | undefined {
    const schema = readSchemaJson(info.token);
    const restTables = restTablesFor(info.token);
    if (schema === undefined && restTables.length === 0) return undefined;
    const kvRest = appRestTableName(info.token, APP_KV_TABLE);
    const temp = new SQL.Database();
    try {
      const tableNames: string[] = [];
      if (restTables.includes(kvRest)) {
        temp.run(KV_TABLE_DDL);
        tableNames.push(APP_KV_TABLE);
      }
      for (const object of schema?.objects ?? []) {
        temp.run(object.ddl);
        if (object.type === 'table') tableNames.push(object.name);
      }
      for (const name of tableNames) {
        const rest = appRestTableName(info.token, name);
        if (restTables.includes(rest)) copyRows(db, rest, temp, name);
      }
      // AUTOINCREMENT continuity: exact counters from the registry beat max(id)
      // inference (deleted-max rows must never free their ids). sqlite_sequence has
      // NO unique constraint on name, so INSERT OR REPLACE would APPEND a duplicate
      // row and SQLite would read the lower one — UPDATE first, INSERT only when the
      // row does not exist yet (review B1).
      if (schema?.sequences !== undefined && hasTable(temp, 'sqlite_sequence')) {
        for (const [name, seq] of Object.entries(schema.sequences)) {
          temp.run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [seq, name]);
          if (temp.getRowsModified() === 0) {
            temp.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [name, seq]);
          }
        }
      }
      const bytes = temp.export();
      lastSavedHash.set(namespaceToFileName(info.namespace), bytesHash(bytes));
      return bytes;
    } finally {
      temp.close();
    }
  }

  /** Validate + snapshot the runtime's sqlite_master. Throws INVALID_NAME on gate failure. */
  function readRuntimeObjects(temp: Database): { objects: AppSchemaObject[]; tables: string[]; hasKv: boolean } {
    const rows = selectFrom(temp, `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`);
    const objects: AppSchemaObject[] = [];
    const tables: string[] = [];
    let hasKv = false;
    for (const row of rows) {
      const type = String(row[0]);
      const name = String(row[1]);
      const ddl = String(row[2]);
      if (name.toLowerCase().startsWith('sqlite_')) continue; // engine-internal (sqlite_sequence …)
      if (name === APP_KV_TABLE) {
        hasKv = true;
        tables.push(name);
        continue; // driver-internal — persisted but never registered
      }
      if (!isValidAppObjectName(name)) {
        throw new UserDbError(
          USERDB_ERROR_CODES.INVALID_NAME,
          `app object name ${JSON.stringify(name)} violates the naming rule — write-back refused, previous data retained`,
        );
      }
      if (type !== 'table' && type !== 'index' && type !== 'trigger' && type !== 'view') continue;
      if (type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(ddl.trim())) {
        throw new UserDbError(
          USERDB_ERROR_CODES.INVALID_NAME,
          `virtual tables are not portable — "${name}" cannot be persisted`,
        );
      }
      objects.push({ type, name, ddl });
      if (type === 'table') tables.push(name);
    }
    return { objects, tables, hasKv };
  }

  /**
   * Transactional write-back of one app runtime into rest tables + registry. Entirely
   * synchronous on the shared handle: outer persist/export can never observe a torn
   * state. Throws (after ROLLBACK) on gate or cap violations — previous state retained.
   */
  function writeBack(info: NamespaceInfo, temp: Database): void {
    const { objects, tables, hasKv } = readRuntimeObjects(temp);
    db.run('BEGIN IMMEDIATE');
    try {
      for (const rest of restTablesFor(info.token)) {
        db.run(`DROP TABLE IF EXISTS ${quoteIdent(rest)}`);
      }
      db.run('PRAGMA legacy_alter_table = ON');
      for (const name of tables) {
        const ddl = name === APP_KV_TABLE ? KV_TABLE_DDL : objects.find((o) => o.type === 'table' && o.name === name)!.ddl;
        db.run(ddl);
        db.run(`ALTER TABLE ${quoteIdent(name)} RENAME TO ${quoteIdent(appRestTableName(info.token, name))}`);
      }
      db.run('PRAGMA legacy_alter_table = OFF');
      for (const name of tables) {
        copyRows(temp, name, db, appRestTableName(info.token, name));
      }
      if (objects.length > 0) {
        const schemaJson: AppSchemaJson = { objects };
        if (hasTable(temp, 'sqlite_sequence')) {
          const sequences: Record<string, number> = {};
          for (const row of selectFrom(temp, 'SELECT name, seq FROM sqlite_sequence')) {
            if (tables.includes(String(row[0]))) sequences[String(row[0])] = Number(row[1]);
          }
          if (Object.keys(sequences).length > 0) schemaJson.sequences = sequences;
        }
        db.run(
          `INSERT OR REPLACE INTO ${USERDB_TABLES.appSchemas} (app_id, token, schema_json, updated_at) VALUES (?, ?, ?, ?)`,
          [info.namespace, info.token, JSON.stringify(schemaJson), now()],
        );
      } else {
        db.run(`DELETE FROM ${USERDB_TABLES.appSchemas} WHERE token = ?`, [info.token]);
      }
      if (tables.length > 0) {
        db.run(`UPDATE ${USERDB_TABLES.apps} SET uses_db = 1 WHERE app_id = ? AND uses_db = 0`, [info.namespace]);
      }
      if (currentBytes() > maxBytes) {
        throw new UserDbError(
          USERDB_ERROR_CODES.TOO_LARGE,
          `app data for "${info.namespace}" would push the user DB past the ${maxBytes}-byte cap`,
        );
      }
      db.run('COMMIT');
    } catch (err) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      try {
        db.run('PRAGMA legacy_alter_table = OFF');
      } catch {
        /* pragma restore is best-effort */
      }
      throw err;
    }
    markDirty();
  }

  const materializerBackend: PersistenceBackend = {
    kind: backend.kind,
    load: (blobFile) => {
      const info = namespaceByFile.get(blobFile);
      if (info === undefined) return Promise.resolve(undefined);
      return Promise.resolve(materializeBytes(info));
    },
    save: (blobFile, bytes) => {
      const info = namespaceByFile.get(blobFile);
      if (info === undefined) return Promise.resolve();
      const hash = bytesHash(bytes);
      if (lastSavedHash.get(blobFile) === hash) return Promise.resolve();
      let temp: Database | undefined;
      try {
        temp = new SQL.Database(bytes);
        writeBack(info, temp);
        lastSavedHash.set(blobFile, hash);
      } catch (err) {
        options.onAppPersistError?.({
          namespace: info.namespace,
          code: err instanceof UserDbError ? err.code : 'USERDB_PERSIST_FAILED',
          message: errorMessage(err),
        });
        throw err; // the driver keeps the namespace dirty; previous rest state is retained
      } finally {
        temp?.close();
      }
      return Promise.resolve();
    },
  };

  const makeInnerDriver = (): SnugDbDriver =>
    createDbDriver({
      backend: materializerBackend,
      ...(options.locateWasm !== undefined ? { locateWasm: options.locateWasm } : {}),
      persistDebounceMs: debounceMs,
    });

  let inner = makeInnerDriver();

  /**
   * Apps deleted in this session. A running iframe does NOT stop when its app is deleted,
   * and its next db frame used to re-register the namespace (noteNamespace) and re-create
   * the app's tables plus an ORPHANED snug_app_schemas row on the following write-back —
   * the app looked deleted in listApps() while its data quietly lived on in the file.
   * Deletion is terminal: frames for a dead app are refused rather than resurrecting it.
   */
  const deletedApps = new Set<string>();

  /** Stable facade so `userDb.driver` survives importUserDb swapping the inner driver. */
  const driver: SnugDbDriver = {
    handle: (namespace, request) => {
      if (deletedApps.has(namespace)) {
        return Promise.resolve({
          ok: false as const,
          code: USERDB_ERROR_CODES.NOT_FOUND,
          message: `app "${namespace}" was deleted`,
          retryable: false,
        });
      }
      noteNamespace(namespace);
      return inner.handle(namespace, request);
    },
    get persistence() {
      return inner.persistence;
    },
    flush: () => inner.flush(),
    evict: (namespace) => inner.evict(namespace),
    close: () => inner.close(),
  };

  /** Internal db-request frames for applyAppDdl's snapshot/exec/restore round trip. */
  let internalSeq = 0;
  const internalFrame = (fields: Record<string, unknown>): DbRequestFrame =>
    ({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbRequest,
      requestId: `userdb-internal-${++internalSeq}`,
      instanceId: 'userdb-internal',
      ...fields,
    }) as DbRequestFrame;

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
    ...(row[9] !== null && row[9] !== undefined ? { installSource: String(row[9]) } : {}),
  });

  const APP_COLUMNS =
    'app_id, display_name, description, icon_emoji, icon_color, uses_db, current_version, created_at, updated_at, install_source';

  function getApp(appId: string): AppRecord | undefined {
    assertOpen();
    const rows = select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
    const row = rows[0];
    return row === undefined ? undefined : toAppRecord(row);
  }

  function getAppByInstallSource(source: string): AppRecord | undefined {
    assertOpen();
    const rows = select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} WHERE install_source = ?`, [source]);
    const row = rows[0];
    return row === undefined ? undefined : toAppRecord(row);
  }

  function insertVersion(
    appId: string,
    version: number,
    html: string,
    note: string | undefined,
    pinned: boolean,
  ): AppVersionMeta {
    const createdAt = now();
    run(
      `INSERT INTO ${USERDB_TABLES.appVersions} (app_id, version, html, note, created_at, pinned) VALUES (?, ?, ?, ?, ?, ?)`,
      [appId, version, html, note ?? null, createdAt, pinned ? 1 : 0],
    );
    // Retention: the newest N unpinned versions plus every pinned (factory) version.
    run(`DELETE FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version <= ? AND pinned = 0`, [
      appId,
      version - retained,
    ]);
    return { version, ...(note !== undefined ? { note } : {}), createdAt, htmlBytes: html.length, pinned };
  }

  const userDb: UserDb = {
    get persistence(): DbPersistence {
      return backend.kind === 'memory' ? 'none' : backend.kind;
    },
    driver,

    installApp(input) {
      assertOpen();
      if (input.installSource !== undefined) {
        const existing = getAppByInstallSource(input.installSource);
        if (existing !== undefined) return existing; // find-or-open: never duplicate an install identity
      }
      guardAddedBytes(input.html.length, `installing "${input.displayName}"`);
      const appId = input.appId ?? crypto.randomUUID();
      const timestamp = now();
      try {
        run(`INSERT INTO ${USERDB_TABLES.apps} (${APP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          appId,
          input.displayName,
          input.description ?? null,
          input.iconEmoji ?? null,
          input.iconColor ?? null,
          input.usesDb === true ? 1 : 0,
          1,
          timestamp,
          timestamp,
          input.installSource ?? null,
        ]);
      } catch (err) {
        // Unique-index backstop: a racing install of the same source connects to the winner.
        if (input.installSource !== undefined) {
          const existing = getAppByInstallSource(input.installSource);
          if (existing !== undefined) return existing;
        }
        throw err;
      }
      insertVersion(appId, 1, input.html, input.note, true); // v1 = the pinned factory version
      return getApp(appId) as AppRecord;
    },

    saveAppVersion(appId, html, note) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      guardAddedBytes(html.length, `new version of "${appId}"`);
      const version = app.currentVersion + 1;
      const meta = insertVersion(appId, version, html, note, false);
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
    getAppByInstallSource,

    /**
     * Remove an installed app and everything that references it, in ONE transaction.
     *
     * There are NO foreign keys in the user DB and `PRAGMA foreign_keys` is never set,
     * so this cascade is entirely hand-written: every referencing table is named below.
     * A table missing from that list is a SILENT orphan — the delete-app tests sweep all
     * of them independently rather than trusting this list.
     *
     * Two things this deliberately does NOT do:
     *  - It does not honour `pinned`. The factory version and the bootstrap chat message
     *    are removed with everything else (owner-confirmed). That is exactly why the
     *    retention helpers (`pruneChatMessages`, version retention) are NOT reused here:
     *    both refuse pinned rows by design.
     *  - It does not persist the app's runtime copy on the way out. The materializer's
     *    `writeBack` rebuilds rest tables from the still-open runtime database on flush,
     *    so a normal close/flush would RESURRECT the app. The namespace is evicted (not
     *    flushed) and its cached mappings dropped before the transaction commits.
     */
    async deleteApp(appId) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      const token = appDataToken(appId);
      const blobFile = namespaceToFileName(appId);

      // Flush BEFORE evicting. `evict` discards the app's in-memory runtime without
      // persisting, so anything written since the last write-back would be gone — and if
      // the transaction below then rolls back, the app survives having SILENTLY lost its
      // most recent writes (ROLLBACK restores the rest tables, but that delta was never
      // in them). Flushing first puts the delta into the rest tables, where the rollback
      // covers it; the delete then drops those tables anyway on the success path.
      await inner.flush();

      // Then evict: the driver holds an open sql.js copy of this app's runtime, and its
      // write-back is the resurrection hazard. Both happen before BEGIN IMMEDIATE, so a
      // failure in either aborts with the app fully intact.
      await inner.evict(appId);

      db.run('BEGIN IMMEDIATE');
      try {
        // 1. The app's native data tables (app_<token>__*), read from sqlite_master.
        for (const rest of restTablesFor(token)) {
          db.run(`DROP TABLE IF EXISTS ${quoteIdent(rest)}`);
        }
        // 2. Chat messages first — they join through thread_id, so the threads they
        //    depend on must still be present to resolve them.
        db.run(
          `DELETE FROM ${USERDB_TABLES.chatMessages} WHERE thread_id IN (SELECT thread_id FROM ${USERDB_TABLES.chatThreads} WHERE app_id = ?)`,
          [appId],
        );
        // 3. Every remaining app_id-keyed table. Unconditional — `pinned` is ignored.
        for (const table of [
          USERDB_TABLES.chatThreads,
          USERDB_TABLES.appDocs,
          USERDB_TABLES.appVersions,
          USERDB_TABLES.appMigrations,
          USERDB_TABLES.appSchemas,
        ]) {
          db.run(`DELETE FROM ${table} WHERE app_id = ?`, [appId]);
        }
        // 4. The app row last, so a failure above leaves a consistent, still-installed app.
        db.run(`DELETE FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
        db.run('COMMIT');
      } catch (err) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* nothing to roll back */
        }
        throw err;
      }

      // Drop the materializer's caches for this namespace only AFTER the commit: while
      // the transaction could still roll back, these mappings must stay valid.
      // Second, independent guard against R1. Mutation-tested: the eviction above and
      // this invalidation each stop the resurrection ON THEIR OWN — the app data tables
      // only come back if BOTH are removed. Deliberately redundant, because they fail in
      // different directions: eviction drops the driver's cached runtime copy, while
      // this makes the materializer's `save` a no-op for a namespace it no longer knows.
      // Keep both.
      namespaceByFile.delete(blobFile);
      lastSavedHash.delete(blobFile);
      // Terminal: a still-running iframe's next frame must not re-register this namespace.
      deletedApps.add(appId);
      // Durability BEFORE the space reclaim: the delete is already committed in memory, so
      // it must reach the backend even if the VACUUM below fails. Ordering these the other
      // way round left a committed-but-unpersisted delete whenever VACUUM threw.
      markDirty();
      // VACUUM outside the transaction (SQLite forbids it inside one). Dropping the
      // rows only marks their pages free — the app's HTML, chat and docs would still sit
      // in the file, readable in the exported bytes. The same reasoning already applies
      // to stripped secrets in exportUserDb; here it must happen at the source so EVERY
      // export path benefits, including includeSecrets.
      // Best-effort: VACUUM allocates a full second copy of the database, so it is the one
      // statement here likely to fail under memory pressure — exactly the condition a large
      // delete creates. A failed space reclaim must never fail an already-committed delete;
      // the freed pages just get reused later instead.
      try {
        db.run('VACUUM');
      } catch {
        /* space reclaim is an optimization, not part of the delete's contract */
      }
      await persistNow();
    },

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
        `SELECT version, note, created_at, length(html), pinned FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? ORDER BY version DESC`,
        [appId],
      ).map((row) => ({
        version: Number(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { note: String(row[1]) } : {}),
        createdAt: String(row[2]),
        htmlBytes: Number(row[3]),
        pinned: row[4] === 1,
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

    resetToFactory(appId) {
      assertOpen();
      const factory = select(
        `SELECT MIN(version) FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND pinned = 1`,
        [appId],
      )[0]?.[0];
      if (typeof factory !== 'number') {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" has no pinned factory version`);
      }
      const html = this.getAppHtml(appId, factory);
      if (html === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `factory version ${factory} of "${appId}" is missing`);
      }
      return this.saveAppVersion(appId, html, `reset to factory (v${factory})`);
    },

    // ------------------------------------------------------------- schema registry

    getAppSchema(appId) {
      assertOpen();
      const raw = select(`SELECT schema_json FROM ${USERDB_TABLES.appSchemas} WHERE app_id = ?`, [appId])[0]?.[0];
      return raw === undefined ? undefined : (JSON.parse(String(raw)) as AppSchemaJson);
    },

    async applyAppDdl(appId, statements) {
      assertOpen();
      if (statements.length === 0) return this.getAppSchema(appId) ?? { objects: [] };
      const snapshot = await driver.handle(appId, internalFrame({ op: 'export' }));
      if (!snapshot.ok || snapshot.bytesBase64 === undefined) {
        const detail = snapshot.ok ? 'no bytes' : snapshot.message;
        throw new UserDbError(USERDB_ERROR_CODES.DDL_FAILED, `cannot snapshot app runtime: ${detail}`);
      }
      const restore = async (): Promise<void> => {
        await driver.handle(appId, internalFrame({ op: 'import', bytesBase64: snapshot.bytesBase64 }));
      };
      for (const [index, sql] of statements.entries()) {
        const result = await driver.handle(appId, internalFrame({ op: 'exec', sql }));
        if (!result.ok) {
          await restore();
          throw new UserDbError(
            USERDB_ERROR_CODES.DDL_FAILED,
            `statement ${index + 1} failed (runtime restored): ${result.message}`,
          );
        }
      }
      // Pre-validate the post-batch runtime with the same gate the write-back uses, so a
      // bad name surfaces HERE as a typed error instead of a background persist failure.
      const master = await driver.handle(
        appId,
        internalFrame({ op: 'exec', sql: 'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL' }),
      );
      if (master.ok && master.rows !== undefined) {
        for (const row of master.rows) {
          const name = String(row[1]);
          if (name.toLowerCase().startsWith('sqlite_') || name === APP_KV_TABLE) continue;
          if (!isValidAppObjectName(name)) {
            await restore();
            throw new UserDbError(
              USERDB_ERROR_CODES.INVALID_NAME,
              `proposed DDL creates ${JSON.stringify(name)}, which violates the naming rule (runtime restored)`,
            );
          }
          // Same gate the write-back applies (review O4) — surface it HERE as a typed error.
          if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row[2] ?? '').trim())) {
            await restore();
            throw new UserDbError(
              USERDB_ERROR_CODES.INVALID_NAME,
              `virtual tables are not portable — "${name}" cannot be persisted (runtime restored)`,
            );
          }
        }
      }
      await inner.flush(); // write-back registers the schema transactionally
      const nextSeq = Number(
        select(`SELECT COALESCE(MAX(seq), 0) FROM ${USERDB_TABLES.appMigrations} WHERE app_id = ?`, [appId])[0]?.[0] ?? 0,
      );
      const appliedAt = now();
      statements.forEach((sql, index) => {
        run(`INSERT INTO ${USERDB_TABLES.appMigrations} (app_id, seq, ddl, applied_at) VALUES (?, ?, ?, ?)`, [
          appId,
          nextSeq + index + 1,
          sql,
          appliedAt,
        ]);
      });
      return this.getAppSchema(appId) ?? { objects: [] };
    },

    listAppMigrations(appId) {
      assertOpen();
      return select(
        `SELECT seq, ddl, applied_at FROM ${USERDB_TABLES.appMigrations} WHERE app_id = ? ORDER BY seq`,
        [appId],
      ).map((row) => ({ seq: Number(row[0]), ddl: String(row[1]), appliedAt: String(row[2]) }));
    },

    // ------------------------------------------------------------------------ docs

    putAppDoc(appId, slug, doc) {
      assertOpen();
      guardAddedBytes(doc.content.length + (doc.title?.length ?? 0) + slug.length, `doc "${slug}"`);
      run(
        `INSERT INTO ${USERDB_TABLES.appDocs} (app_id, slug, title, content, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id, slug) DO UPDATE SET
           title = COALESCE(excluded.title, title),
           content = excluded.content,
           updated_at = excluded.updated_at`,
        [appId, slug, doc.title ?? null, doc.content, now()],
      );
    },

    getAppDoc(appId, slug) {
      assertOpen();
      const row = select(
        `SELECT slug, title, content, updated_at FROM ${USERDB_TABLES.appDocs} WHERE app_id = ? AND slug = ?`,
        [appId, slug],
      )[0];
      if (row === undefined) return undefined;
      return {
        slug: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { title: String(row[1]) } : {}),
        content: String(row[2]),
        updatedAt: String(row[3]),
      };
    },

    listAppDocs(appId) {
      assertOpen();
      return select(
        `SELECT slug, title, content, updated_at FROM ${USERDB_TABLES.appDocs} WHERE app_id = ? ORDER BY slug`,
        [appId],
      ).map((row) => ({
        slug: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { title: String(row[1]) } : {}),
        content: String(row[2]),
        updatedAt: String(row[3]),
      }));
    },

    deleteAppDoc(appId, slug) {
      assertOpen();
      run(`DELETE FROM ${USERDB_TABLES.appDocs} WHERE app_id = ? AND slug = ?`, [appId, slug]);
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

    appendChatMessage(threadId, role, content, opts = {}) {
      assertOpen();
      const metaJson = opts.meta === undefined ? null : JSON.stringify(opts.meta);
      guardAddedBytes(content.length + (metaJson?.length ?? 0), 'chat message');
      this.upsertThread(threadId);
      const createdAt = now();
      run(
        `INSERT INTO ${USERDB_TABLES.chatMessages} (thread_id, role, content, created_at, pinned, meta) VALUES (?, ?, ?, ?, ?, ?)`,
        [threadId, role, content, createdAt, opts.pinned === true ? 1 : 0, metaJson],
      );
      const id = select('SELECT last_insert_rowid()')[0]?.[0];
      return {
        id: Number(id),
        threadId,
        role,
        content,
        createdAt,
        pinned: opts.pinned === true,
        ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
      };
    },

    pinChatMessage(id) {
      assertOpen();
      run(`UPDATE ${USERDB_TABLES.chatMessages} SET pinned = 1 WHERE id = ?`, [id]);
    },

    pruneChatMessages(threadId, keepUnpinned) {
      assertOpen();
      run(
        `DELETE FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? AND pinned = 0 AND id NOT IN (
           SELECT id FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? AND pinned = 0 ORDER BY id DESC LIMIT ?)`,
        [threadId, threadId, keepUnpinned],
      );
    },

    getThread(threadId) {
      assertOpen();
      const row = select(
        `SELECT thread_id, app_id, title, created_at, updated_at FROM ${USERDB_TABLES.chatThreads} WHERE thread_id = ?`,
        [threadId],
      )[0];
      if (row === undefined) return undefined;
      return {
        threadId: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { appId: String(row[1]) } : {}),
        ...(row[2] !== null && row[2] !== undefined ? { title: String(row[2]) } : {}),
        createdAt: String(row[3]),
        updatedAt: String(row[4]),
      };
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
        `SELECT id, role, content, created_at, pinned, meta FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? ORDER BY id`,
        [threadId],
      ).map((row) => ({
        id: Number(row[0]),
        threadId,
        role: String(row[1]) as ChatMessage['role'],
        content: String(row[2]),
        createdAt: String(row[3]),
        pinned: row[4] === 1,
        ...(row[5] !== null && row[5] !== undefined ? { meta: JSON.parse(String(row[5])) as unknown } : {}),
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
      const blobFile = noteNamespace(namespace);
      await inner.flush();
      const info = namespaceByFile.get(blobFile);
      if (info === undefined) return undefined;
      return materializeBytes(info);
    },

    async exportUserDb(opts = {}) {
      assertOpen();
      await inner.flush();
      await persistNow();
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
      // Import replaces the WORLD, so every session cache keyed on the old handle is
      // reset as one family (the F1/R1 cache-coherence family — resetting only part of
      // it is how the restore-after-delete bug happened):
      lastSavedHash.clear(); // foreign bytes: every namespace must re-materialize
      namespaceByFile.clear(); // stale entries describe files of the discarded handle
      // Tombstones: an app the imported file CONTAINS is alive again (file-is-truth —
      // restoring a pre-delete backup must revive it). An app the file does NOT contain
      // stays tombstoned on purpose: dropping that guard would let a still-running
      // iframe of a deleted app write orphaned rest tables into the new file (R1).
      // Known limit (queued 2026-08-06 for the A10 threat model): a CRAFTED import can
      // occupy a deleted app's id and thereby drop its tombstone — unreachable by
      // accident with randomUUID ids; untrusted-import hardening owns this surface.
      for (const appId of [...deletedApps]) {
        const rows = select(`SELECT 1 FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
        if (rows.length > 0) deletedApps.delete(appId);
      }
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

  return userDb;
}
