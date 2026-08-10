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
  AUTH_MAX_SLOTS_PER_APP,
  AUTH_SPEC_STATUS,
  CONNECTION_PROVENANCES,
  CONNECTION_STATUS,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  USERDB_CONNECTIONS_TABLE,
  USERDB_DDL,
  USERDB_FILE,
  USERDB_INDEX_DDL,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
  appDataToken,
  appRestTableName,
  authSpecSchema,
  canonicalRequirementHash,
  connectionRequirementSchema,
  deriveAuthAllowedHosts,
  deriveConnectionAllowedHosts,
  hostSetEquals,
  isAuthSpecUnknownKeysOnlyFailure,
  isValidAppObjectName,
  type AppSchemaJson,
  type AppSchemaObject,
  type AuthSpec,
  type AuthSpecStatus,
  type ConnectionProvenance,
  type ConnectionRequirement,
  type ConnectionStatus,
  type DbRequestFrame,
} from '@snugprotocol/protocol';
import { authAppSecretPrefix, authConnectionSlotPrefix, isLegacyAppSecretKey } from './auth-secrets.js';
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
  /** An auth spec failed strict validation at the write boundary (ingest fail-closed). */
  INVALID_AUTH_SPEC: 'USERDB_INVALID_AUTH_SPEC',
  /** An ordinary auth-spec update tried to change the frozen derived host union (plan D5). */
  HOST_FREEZE: 'USERDB_HOST_FREEZE',
  /** A connection requirement failed strict validation at the write boundary (AC10). */
  INVALID_CONNECTION_REQUIREMENT: 'USERDB_INVALID_CONNECTION_REQUIREMENT',
  /** An accessor was called against a connection row whose status forbids that write (AC10/AC12). */
  CONNECTION_WRITE_RULE: 'USERDB_CONNECTION_WRITE_RULE',
  /** A write was aimed at a REVOKED row; reconnect is an explicit wizard act (AC10). */
  CONNECTION_REVOKED: 'USERDB_CONNECTION_REVOKED',
  /** The app already holds `AUTH_MAX_SLOTS_PER_APP` declared slots (AC11, fold S-M1). */
  CONNECTION_SLOT_CAP: 'USERDB_CONNECTION_SLOT_CAP',
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

/**
 * Thrown when an ordinary `putAuthSpec` would change the DERIVED HOST UNION of an
 * approved row (plan D5/N2 — any change, not just the `allowed_hosts` column: the
 * accessor recomputes the union over the incoming spec's endpoints incl. refreshUrl
 * plus declared/registry API hosts). Widening happens only via `reapproveAuthSpec()`.
 */
export class HostFreezeViolation extends UserDbError {
  constructor(
    readonly frozenHosts: readonly string[],
    readonly attemptedHosts: readonly string[],
  ) {
    super(
      USERDB_ERROR_CODES.HOST_FREEZE,
      `auth spec update would change the frozen host union [${frozenHosts.join(', ')}] → [${attemptedHosts.join(', ')}]; use reapproveAuthSpec`,
    );
    this.name = 'HostFreezeViolation';
  }
}

/**
 * Thrown when a connection accessor is aimed at a row whose STATUS forbids that write —
 * `putDeclaredConnection` against an `approved` row (a changed requirement must stage
 * through `stagePendingRequirement`, parent §3), or `stagePendingRequirement` against a
 * row that is not `approved` (a `declared` row is simply replaced).
 *
 * Named separately from `ConnectionRevokedError` because the two carry different
 * REMEDIES, and the wizard renders them differently: this one means "use the other
 * accessor", while a tombstone means "ask the user to reconnect, and show them the date".
 * A single generic error would force the UI to string-match the message to tell them
 * apart.
 */
export class ConnectionWriteRuleViolation extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly status: ConnectionStatus,
    remedy: string,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_WRITE_RULE,
      `connection "${appId}/${slot}" is ${status}; ${remedy}`,
    );
    this.name = 'ConnectionWriteRuleViolation';
  }
}

/**
 * Thrown when any write is aimed at a REVOKED row. Revocation is deliberately terminal
 * for the automatic channels: the row survives as a TOMBSTONE so the wizard can tell the
 * user "you revoked this on <date>" instead of silently re-offering a clean-looking
 * connection, and only an explicit reconnect act may move it forward.
 */
export class ConnectionRevokedError extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly revokedAt: string | undefined,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_REVOKED,
      `connection "${appId}/${slot}" was revoked${revokedAt !== undefined ? ` on ${revokedAt}` : ''}; reconnecting is an explicit user act, not an automatic re-declaration`,
    );
    this.name = 'ConnectionRevokedError';
  }
}

/**
 * Thrown when an app already holds `AUTH_MAX_SLOTS_PER_APP` rows and a NEW slot is
 * declared (fold S-M1). `guardAddedBytes` bounds bytes per write, not row count, so
 * without this a hostile or broken build emits unbounded declared rows.
 *
 * Two boundary rules are load-bearing and are pinned by tests rather than left to
 * reading: REPLACING an existing slot never counts (otherwise the legitimate R3
 * re-inference path breaks exactly at the cap), and REVOKED tombstones DO count (they
 * are precisely what a flooding attacker leaves behind, and the revoke path keeps the
 * row by design).
 */
export class ConnectionSlotCapExceeded extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly cap: number,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_SLOT_CAP,
      `app "${appId}" already declares ${cap} connection slots (AUTH_MAX_SLOTS_PER_APP); refusing to add "${slot}"`,
    );
    this.name = 'ConnectionSlotCapExceeded';
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

/** One `snug_auth_specs` row (AL-02). Spec metadata ONLY — values live under `auth:` secrets. */
export interface AuthSpecRow {
  appId: string;
  /**
   * The stored spec. Validated strictly at every WRITE boundary; the single exception
   * is an imported row preserved under the unknown-keys-only rule (R2) — readable, but
   * `approveAuthSpec` re-validates and refuses it until a hub that understands it runs.
   */
  spec: AuthSpec;
  status: AuthSpecStatus;
  /**
   * `frozenAllowedHosts` for approved rows — the derived host union computed AT
   * approval (declared ∪ registry ∪ OAuth endpoint hosts incl. refreshUrl), displayed
   * in full to the user, then frozen. For unapproved rows: the current derived union
   * (a preview; injection is barred by `status` anyway). Sorted/unique/lowercase.
   */
  allowedHosts: string[];
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One `snug_connections` row (Dynamic Auth v2) — the REQUIREMENT/GRANT split in one
 * record. Credential VALUES never appear here; they live in `snug_secrets` under
 * `auth:<appId>:<slot>:<fieldKey>` (ADR-0014, byte-for-byte unchanged).
 */
export interface ConnectionRow {
  appId: string;
  slot: string;
  /** What the app NEEDS. Validated strictly at every write boundary. */
  requirement: ConnectionRequirement;
  /**
   * An edit's CHANGED requirement, staged while the grant keeps serving `requirement`
   * and its old frozen hosts (fold B2). Present + `status === 'approved'` is the
   * DERIVED "needs re-approval" state — never a fourth status.
   */
  pendingRequirement?: ConnectionRequirement;
  /** Bumped on every persisted replacement whose canonical hash differs (fold T-mn3). */
  requirementVersion: number;
  provenance: ConnectionProvenance;
  /** Display-only inference confidence; never read by a gating decision. */
  confidence?: number;
  status: ConnectionStatus;
  /**
   * The FROZEN host ceiling for `approved` rows — the union derived AT approval and
   * displayed in full to the user first. For `declared`/`revoked` rows it is the union
   * derived from the current requirement (a preview; injection is barred by `status`).
   */
  allowedHosts: string[];
  /** True for a row that arrived through `importUserDb` and was re-reviewed (fold T-M5). */
  imported: boolean;
  approvedAt?: string;
  /** Tombstone stamp. The row SURVIVES revocation so the wizard can show this date. */
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** What `importUserDb` surfaces about the auth reconciliation passes (plan D5/N1). */
export interface UserDbImportReport {
  /** Structurally unusable `snug_auth_specs` rows that were dropped, with reasons. */
  droppedAuthSpecs: Array<{ appId: string; reason: string }>;
  /** Structurally unusable `snug_connections` rows that were dropped, with reasons. */
  droppedConnections: Array<{ appId: string; slot: string; reason: string }>;
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

  /**
   * Create or ordinary-update an app's auth spec (validated strictly — fail closed).
   * New rows land `unapproved`. On an APPROVED row, any change to the derived host
   * union throws `HostFreezeViolation`; same-union edits keep the approval.
   */
  putAuthSpec(appId: string, spec: unknown): AuthSpecRow;
  /**
   * Freeze the derived host union into `allowed_hosts`, stamp `approved_at`, and
   * return the row — `allowedHosts` is the COMPLETE list the caller must display to
   * the user at approval (plan D2). Re-validates the stored spec strictly.
   */
  approveAuthSpec(appId: string): AuthSpecRow;
  /**
   * The ONLY widening path (plan D5): replace the spec (optional), recompute + freeze
   * the union, stamp a NEW `approved_at`. Caller re-displays the full host list.
   */
  reapproveAuthSpec(appId: string, spec?: unknown): AuthSpecRow;
  getAuthSpec(appId: string): AuthSpecRow | undefined;
  listAuthSpecs(): AuthSpecRow[];
  deleteAuthSpec(appId: string): void;

  // ------------------------------------------------- connections (Dynamic Auth v2)
  //
  // The ONLY writers of `snug_connections`. Each is the sole legal author of one
  // transition, so "which accessor may I call?" is answerable from `status` alone —
  // that is what makes the write rules enforceable rather than conventional.

  /**
   * Insert, or replace an existing **`declared`** row — the legitimate R3 re-inference
   * path. THROWS `ConnectionWriteRuleViolation` on an `approved` row (a changed
   * requirement stages through `stagePendingRequirement`) and `ConnectionRevokedError`
   * on a tombstone. Enforces `AUTH_MAX_SLOTS_PER_APP` for NEW slots only.
   */
  putDeclaredConnection(
    appId: string,
    slot: string,
    requirement: unknown,
    provenance: ConnectionProvenance,
    opts?: { confidence?: number },
  ): ConnectionRow;
  /**
   * Stage an edit's changed requirement against an APPROVED row (fold B2): writes
   * `pending_requirement_json` and NOTHING else, so the grant keeps serving the exact
   * requirement and frozen hosts the user approved. THROWS on any other status.
   */
  stagePendingRequirement(appId: string, slot: string, requirement: unknown): ConnectionRow;
  /**
   * Wizard-only: freeze the derived host union into `allowed_hosts`, stamp `approved_at`,
   * status → `approved`. `allowedHosts` on the returned row is the COMPLETE list the
   * caller must have displayed to the user. Re-validates the stored requirement.
   */
  approveConnection(appId: string, slot: string): ConnectionRow;
  /**
   * The ONLY widening path: promote `pending_requirement_json` → `requirement_json`,
   * re-freeze the union, clear pending, stamp a NEW `approved_at`. Bumps
   * `requirement_version` when the promoted requirement differs canonically.
   */
  reapproveConnection(appId: string, slot: string): ConnectionRow;
  /**
   * status → `revoked`, `revoked_at` stamped, **row KEPT** as a tombstone, and the
   * credential slice `auth:<appId>:<slot>:*` wiped (slot-scoped — a sibling slot's
   * credentials survive).
   */
  revokeConnection(appId: string, slot: string): ConnectionRow;
  getConnection(appId: string, slot: string): ConnectionRow | undefined;
  /** Every row for one app, or every row in the DB when `appId` is omitted. Slot-ordered. */
  listConnections(appId?: string): ConnectionRow[];

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
  /**
   * Full replace with validated user-DB bytes (older schemas are migrated forward).
   * Runs the delta-aware auth-spec reconciliation pass (plan D5/N1) — pull-merge,
   * applyRemote, recovery restore, and UI import all inherit it through here.
   */
  importUserDb(bytes: Uint8Array): Promise<UserDbImportReport>;

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
  // v2 → v3 (AL-02, internal draft): additive only — `snug_auth_specs` lands via the
  // idempotent CREATE IF NOT EXISTS replay. No data movement; credential values were
  // never stored anywhere else.
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
  // v3 → v4 (TASK-20260810, Dynamic Auth v2): additive only — `snug_connections` lands
  // via the same idempotent replay. A bare replay is CORRECT here for the same reason it
  // was at v3 and for no other: v4 adds a whole NEW table, and `CREATE TABLE IF NOT
  // EXISTS` cannot alter an existing one. The day a migration needs to change an existing
  // table's shape, this pattern silently does nothing while `migrate()` stamps the new
  // version anyway (`:498`) — which is exactly the "the persisted version lied" failure
  // the self-heal guard below exists to catch. Adding columns needs `addColumnIfMissing`,
  // as v1 → v2 did.
  //
  // NOT MIGRATED, deliberately: `snug_auth_specs` rows are left exactly where they are.
  // P0 is ADDITIVE (fold B1) — v3 keeps shipping alongside v4 until P3 rewires its last
  // consumer, so translating specs into connections here would give one connection two
  // live writers. What v4 DOES clean up on this path is the ORPHANED credential slice:
  // see `wipeLegacyAuthSlice`, which runs on open rather than in the migration because
  // the Q9 self-heal can also produce a first-v4 open (fold T-M4).
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
];

/**
 * The DDL-REPLAY SELF-HEALING GUARD (Q9, absorbed from next-steps `23266fc`).
 *
 * `migrate()` stamps `PRAGMA user_version` UNCONDITIONALLY, so the stamp is a claim
 * about which migrations RAN, never evidence that the tables they were supposed to
 * create actually exist. A file can therefore read as v4 with `snug_connections`
 * missing — from an interrupted write, a partially-restored backup, or a migration that
 * threw after the stamp — and the forward-only loop will run NOTHING, leaving the first
 * accessor call to fail with a raw SQLite "no such table" that looks like a code bug.
 *
 * So the expected table set is verified against `sqlite_master` and, on ANY miss, the
 * idempotent DDL is replayed before the stamp is trusted. This is a targeted CREATE, not
 * a re-seed: `CREATE TABLE IF NOT EXISTS` cannot touch a table that is present, so rows
 * in every surviving table are left exactly as they are.
 *
 * Returns TRUE when it healed, because a heal MUTATES the file and the caller must mark
 * the handle dirty — the same lesson as `migrate()`'s return value (review finding 1: a
 * mutation that never reaches disk leaves the file lying again on the next open).
 */
function healMissingTables(db: Database): boolean {
  const present = new Set(
    selectRows(db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => String(row[0])),
  );
  const missing = Object.values(USERDB_TABLES).filter((table) => !present.has(table));
  if (missing.length === 0) return false;
  for (const ddl of USERDB_DDL) db.run(ddl);
  for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  return true;
}

/**
 * The LEGACY-SLICE WIPE (fold T-M4) — run EXACTLY ONCE, on the open that advances a file
 * from v3 to v4, and never again.
 *
 * WHAT IT REMOVES. v3's `authCredentialSecretKey` builds `auth:<appId>:<field>` with NO
 * slot, so under v4's slot-keyed shape those rows hold REAL credential values that
 * nothing in v4 lists, reads, or wipes — the AL-03 lingering-values failure exactly.
 * They are orphaned, not merely stale, and orphaned credentials in a file that SYNCS are
 * the worst kind.
 *
 * WHY ONCE, AND NOT ON EVERY OPEN. This is the trap in an otherwise obvious cleanup.
 * `packages/auth/src/credential-store.ts` is a LIVE writer of exactly these keys and
 * keeps shipping through P0 under the additive cutover rule (fold B1) — it is not dead
 * code yet, it is the v3 path still serving connected apps. A wipe on every open would
 * therefore delete credentials that the still-shipping v3 path wrote moments earlier,
 * turning a one-time cleanup into a recurring self-inflicted disconnection. Gating on
 * "the migration actually advanced this file to v4" makes the wipe a true migration step
 * that a v3-era file passes through once; when P3 retires the v3 writers there will be
 * nothing left for it to find, and it can go.
 *
 * SCOPED BY SEGMENT COUNT (`isLegacyAppSecretKey`), never by prefix: a `LIKE
 * 'auth:<appId>:%'` delete would also take every live v4 `auth:<appId>:<slot>:*` key and
 * disconnect every connected app on the next hub start. Non-auth namespaces (`byok:*`)
 * and the app-agnostic auth keys (`auth:_state_hmac`, `auth:_flow:*`) are outside the
 * rule by construction.
 *
 * Returns the number of rows removed so the caller can mark dirty only when it mattered
 * — a clean file must not be re-persisted on every open.
 */
function wipeLegacyAuthSlice(db: Database): number {
  const keys = selectRows(db, `SELECT key FROM ${USERDB_TABLES.secrets}`)
    .map((row) => String(row[0]))
    .filter(isLegacyAppSecretKey);
  if (keys.length === 0) return 0;
  for (const key of keys) {
    db.run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [key]);
  }
  // Reclaim the pages, per the `deleteApp`/`exportUserDb` precedent: a DELETE only frees
  // the pages, so without this the orphaned credential bytes survive in the file and
  // travel in a secrets-bearing export — the wipe would remove the KEYS while leaving the
  // VALUES exactly where an attacker would look for them. Best-effort for the same reason
  // as every other reclaim here; the rows are unreachable from every query path either way.
  try {
    db.run('VACUUM');
  } catch {
    /* space reclaim is an optimization, not part of the wipe's contract */
  }
  return keys.length;
}

// ------------------------------------------------------- auth-spec reconciliation

/** Module-level row reader (used against the incoming import candidate too). */
function selectRows(target: Database, sql: string, params?: unknown[]): unknown[][] {
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

interface LocalApprovedAuthSpec {
  specJson: string;
  allowedHosts: string;
  approvedAt: string | null;
}

/**
 * The DELTA-AWARE import reconciliation pass (plan D5/N1), run on the incoming
 * database BEFORE it becomes live. For each imported `snug_auth_specs` row:
 *
 * - byte-identical `(app_id, spec_json, allowed_hosts)` to a locally-APPROVED
 *   pre-import row → local `status`/`approved_at` are RESTORED (identical rows carry
 *   zero attack surface; blanket demotion would nuke approvals on every routine
 *   two-device pull and train approval fatigue);
 * - any other row that validates strictly → `imported_unapproved`, `approved_at`
 *   cleared, and `allowed_hosts` REWRITTEN to the union derived from the spec — a
 *   doctored widened column is never honored;
 * - strict failure on unknown keys ONLY → demote-and-preserve (R2: an older hub must
 *   not destroy a newer hub's additive data; approval stays impossible here because
 *   `approveAuthSpec` re-validates);
 * - structurally unusable → dropped + surfaced in the import report.
 */
function reconcileImportedAuthSpecs(
  next: Database,
  localApproved: ReadonlyMap<string, LocalApprovedAuthSpec>,
): UserDbImportReport['droppedAuthSpecs'] {
  const dropped: UserDbImportReport['droppedAuthSpecs'] = [];
  const rows = selectRows(next, `SELECT app_id, spec_json, allowed_hosts FROM ${USERDB_TABLES.authSpecs}`);
  for (const row of rows) {
    const appId = String(row[0]);
    const specJson = String(row[1]);
    const allowedHostsJson = String(row[2]);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(specJson);
    } catch {
      dropped.push({ appId, reason: 'spec_json is not valid JSON' });
      next.run(`DELETE FROM ${USERDB_TABLES.authSpecs} WHERE app_id = ?`, [appId]);
      continue;
    }

    const validated = authSpecSchema.safeParse(parsedJson);
    if (validated.success) {
      const local = localApproved.get(appId);
      if (local !== undefined && local.specJson === specJson && local.allowedHosts === allowedHostsJson) {
        // Byte-identical to a locally-approved row: approval survives the import.
        next.run(`UPDATE ${USERDB_TABLES.authSpecs} SET status = ?, approved_at = ? WHERE app_id = ?`, [
          AUTH_SPEC_STATUS.approved,
          local.approvedAt,
          appId,
        ]);
        continue;
      }
      next.run(
        `UPDATE ${USERDB_TABLES.authSpecs} SET status = ?, approved_at = NULL, allowed_hosts = ? WHERE app_id = ?`,
        [AUTH_SPEC_STATUS.importedUnapproved, JSON.stringify(deriveAuthAllowedHosts(validated.data)), appId],
      );
      continue;
    }

    if (isAuthSpecUnknownKeysOnlyFailure(validated.error)) {
      // Additive fields from a newer hub: preserve the bytes, demote the trust.
      next.run(`UPDATE ${USERDB_TABLES.authSpecs} SET status = ?, approved_at = NULL WHERE app_id = ?`, [
        AUTH_SPEC_STATUS.importedUnapproved,
        appId,
      ]);
      continue;
    }

    dropped.push({ appId, reason: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ') });
    next.run(`DELETE FROM ${USERDB_TABLES.authSpecs} WHERE app_id = ?`, [appId]);
  }
  return dropped;
}

/** The identity a locally-approved connection is compared against during import. */
interface LocalApprovedConnection {
  requirementJson: string;
  allowedHosts: string;
  approvedAt: string | null;
  requirementVersion: number;
}

const connectionKey = (appId: string, slot: string): string => `${appId} ${slot}`;

/**
 * The DELTA-AWARE import reconciliation for `snug_connections` (fold T-M5), the v4
 * sibling of `reconcileImportedAuthSpecs` and run on the candidate BEFORE it goes live.
 * Per imported row:
 *
 * - BYTE-IDENTICAL `(requirement_json, allowed_hosts)` to a locally-APPROVED row →
 *   status/`approved_at` RESTORED. Identical rows carry zero attack surface, and blanket
 *   demotion would nuke every approval on each routine two-device pull and train exactly
 *   the approval fatigue that makes users click through the review that protects them.
 * - Anything else that validates → demoted to `declared`, `approved_at` cleared,
 *   `imported = 1`, and `allowed_hosts` REWRITTEN from the requirement. A doctored,
 *   widened host column is therefore never honored — the union is recomputed, never
 *   trusted, which is the property that makes the byte-identity test above safe to have.
 * - A REVOKED row stays revoked with its tombstone intact. It can never be promoted by
 *   an import: the whole point of keeping the row is that the user's revocation outlives
 *   a file swap.
 * - Structurally unusable → dropped and surfaced in the import report.
 *
 * `pending_requirement_json` is CLEARED on every demoted row (skew-window safety, fold
 * S-m2): the executor binds to the approved requirement, and a staged edit that survived
 * an import into a row the user has not re-approved would be a requirement nobody
 * reviewed sitting in the seat the next `reapproveConnection` promotes.
 *
 * HOST-UNION OUTPUT STABILITY IS LOAD-BEARING here, not cosmetic. Branch 1 compares the
 * STORED `allowed_hosts` JSON against the local row's, so if `deriveConnectionAllowedHosts`
 * ever emitted different bytes for an unchanged requirement (a different sort, different
 * normalization, different spacing) every approved row would miss branch 1 and mass-demote
 * on the first sync pull — which reads to the user as "the update logged me out of
 * everything". Both sides of that comparison are produced by the same function, and the
 * approval path stores exactly what it derives.
 */
function reconcileImportedConnections(
  next: Database,
  localApproved: ReadonlyMap<string, LocalApprovedConnection>,
): UserDbImportReport['droppedConnections'] {
  const dropped: UserDbImportReport['droppedConnections'] = [];
  const rows = selectRows(
    next,
    `SELECT app_id, slot, requirement_json, allowed_hosts, status FROM ${USERDB_CONNECTIONS_TABLE}`,
  );
  for (const row of rows) {
    const appId = String(row[0]);
    const slot = String(row[1]);
    const requirementJson = String(row[2]);
    const allowedHostsJson = String(row[3]);
    const status = String(row[4]);
    const drop = (reason: string): void => {
      dropped.push({ appId, slot, reason });
      next.run(`DELETE FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ? AND slot = ?`, [appId, slot]);
    };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requirementJson);
    } catch {
      drop('requirement_json is not valid JSON');
      continue;
    }

    const validated = connectionRequirementSchema.safeParse(parsedJson);
    if (!validated.success) {
      // No unknown-keys-only escape hatch here, unlike v3's R2 preserve rule: the
      // requirement schema is strict at every level BY DESIGN (a future seat must not
      // ride in unreviewed on a channel that predates it), so "preserve the bytes,
      // demote the trust" would mean storing a row no v4 accessor can re-validate or
      // approve. Dropping it and reporting the reason is the honest outcome.
      drop(validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; '));
      continue;
    }

    if (status === CONNECTION_STATUS.revoked) {
      // A tombstone survives the import unchanged. Deliberately BEFORE the byte-identity
      // branch: a revoked row is never a candidate for restoring an approval.
      continue;
    }

    const local = localApproved.get(connectionKey(appId, slot));
    if (local !== undefined && local.requirementJson === requirementJson && local.allowedHosts === allowedHostsJson) {
      next.run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET status = ?, approved_at = ?, requirement_version = ?, pending_requirement_json = NULL
         WHERE app_id = ? AND slot = ?`,
        [CONNECTION_STATUS.approved, local.approvedAt, local.requirementVersion, appId, slot],
      );
      continue;
    }

    next.run(
      `UPDATE ${USERDB_CONNECTIONS_TABLE}
       SET status = ?, approved_at = NULL, allowed_hosts = ?, imported = 1, pending_requirement_json = NULL
       WHERE app_id = ? AND slot = ?`,
      [
        CONNECTION_STATUS.declared,
        JSON.stringify(deriveConnectionAllowedHosts(validated.data)),
        appId,
        slot,
      ],
    );
  }
  return dropped;
}

/**
 * Forward-migrate to the current schema version.
 *
 * Reports the version it FOUND, not just whether it advanced, because two callers need
 * to know which boundaries were crossed rather than merely that something happened:
 * `advanced` still drives the mark-dirty rule (review finding 1: opening an existing v2
 * file and closing without any other write used to lose the migration on disk — the
 * persisted version lied until an unrelated write happened to flush it), while the
 * legacy-slice wipe fires only when `found < 4`, so a file already at v4 never has its
 * live credentials re-examined (see `wipeLegacyAuthSlice`).
 */
function migrate(db: Database): { found: number; advanced: boolean } {
  const found = readUserVersion(db);
  for (let v = found; v < USERDB_SCHEMA_VERSION; v++) {
    MIGRATIONS[v]?.(db);
  }
  db.run(`PRAGMA user_version = ${USERDB_SCHEMA_VERSION}`);
  return { found, advanced: found < USERDB_SCHEMA_VERSION };
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

  const migration = migrate(db);
  // Q9 self-heal, AFTER the migration and BEFORE anything trusts the schema: the
  // `user_version` stamp is unconditional, so a file can read as current with tables
  // missing. Verifying against sqlite_master is the only thing that makes the stamp
  // meaningful (see `healMissingTables`).
  const healed = healMissingTables(db);
  // The legacy-slice wipe is a MIGRATION STEP, gated on this open having actually
  // crossed v3 → v4 (fold T-M4). It deliberately does NOT run for a file already at v4:
  // the v3 credential writers are still shipping under the additive cutover rule, so a
  // wipe on every open would delete live credentials they had just written.
  const wiped = migration.found < USERDB_SCHEMA_VERSION ? wipeLegacyAuthSlice(db) : 0;
  seedMeta();
  // A migration, a heal, or a wipe each MUTATED the file: make it durable even if this
  // session never writes again (markDirty is hoisted; fresh files are marked dirty by
  // seedMeta's write anyway, and an untouched current-version file stays clean — no
  // spurious no-op saves).
  if (migration.advanced || healed || wiped > 0) markDirty();

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

  // --------------------------------------------------------- auth-spec helpers (AL-02)

  /** Strict ingest (plan D1): the write boundary fails closed on ANY invalid spec. */
  function parseAuthSpecStrict(spec: unknown): AuthSpec {
    const parsed = authSpecSchema.safeParse(spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new UserDbError(USERDB_ERROR_CODES.INVALID_AUTH_SPEC, `auth spec failed validation: ${issues}`);
    }
    return parsed.data;
  }

  function readAuthSpecRow(appId: string): AuthSpecRow | undefined {
    const row = select(
      `SELECT app_id, spec_json, status, allowed_hosts, approved_at, created_at, updated_at
       FROM ${USERDB_TABLES.authSpecs} WHERE app_id = ?`,
      [appId],
    )[0];
    if (row === undefined) return undefined;
    return {
      appId: String(row[0]),
      // JSON.parse, not zod: rows are validated at every write; the one deliberate
      // exception (preserved unknown-keys import rows, R2) must stay READABLE.
      spec: JSON.parse(String(row[1])) as AuthSpec,
      status: String(row[2]) as AuthSpecStatus,
      allowedHosts: JSON.parse(String(row[3])) as string[],
      ...(row[4] !== null && row[4] !== undefined ? { approvedAt: String(row[4]) } : {}),
      createdAt: String(row[5]),
      updatedAt: String(row[6]),
    };
  }

  // ------------------------------------------ connection helpers (Dynamic Auth v2)

  /**
   * Strict ingest at the write boundary, fail closed — the v4 sibling of
   * `parseAuthSpecStrict`. Every accessor parses BEFORE touching a row, so a rejected
   * requirement leaves the database byte-identical: there is no partial write to undo.
   */
  function parseConnectionRequirementStrict(requirement: unknown): ConnectionRequirement {
    const parsed = connectionRequirementSchema.safeParse(requirement);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new UserDbError(
        USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT,
        `connection requirement failed validation: ${issues}`,
      );
    }
    return parsed.data;
  }

  const CONNECTION_COLUMNS =
    'app_id, slot, requirement_json, requirement_version, provenance, confidence, status, pending_requirement_json, imported, allowed_hosts, approved_at, revoked_at, created_at, updated_at';

  const toConnectionRow = (row: unknown[]): ConnectionRow => ({
    appId: String(row[0]),
    slot: String(row[1]),
    // JSON.parse, not zod: every write validates, so re-parsing here would spend a
    // schema pass per read to re-prove a boundary invariant — and would make a row
    // written by a NEWER hub unreadable rather than merely unapprovable.
    requirement: JSON.parse(String(row[2])) as ConnectionRequirement,
    requirementVersion: Number(row[3]),
    provenance: String(row[4]) as ConnectionProvenance,
    ...(row[5] !== null && row[5] !== undefined ? { confidence: Number(row[5]) } : {}),
    status: String(row[6]) as ConnectionStatus,
    ...(row[7] !== null && row[7] !== undefined
      ? { pendingRequirement: JSON.parse(String(row[7])) as ConnectionRequirement }
      : {}),
    imported: row[8] === 1,
    allowedHosts: JSON.parse(String(row[9])) as string[],
    ...(row[10] !== null && row[10] !== undefined ? { approvedAt: String(row[10]) } : {}),
    ...(row[11] !== null && row[11] !== undefined ? { revokedAt: String(row[11]) } : {}),
    createdAt: String(row[12]),
    updatedAt: String(row[13]),
  });

  function readConnectionRow(appId: string, slot: string): ConnectionRow | undefined {
    const row = select(
      `SELECT ${CONNECTION_COLUMNS} FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ? AND slot = ?`,
      [appId, slot],
    )[0];
    return row === undefined ? undefined : toConnectionRow(row);
  }

  /** Read a row or throw NOT_FOUND — the shared preamble of every non-creating accessor. */
  function requireConnectionRow(appId: string, slot: string): ConnectionRow {
    const existing = readConnectionRow(appId, slot);
    if (existing === undefined) {
      throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `no connection "${appId}/${slot}"`);
    }
    return existing;
  }

  /**
   * Delete the credential slice for ONE slot (`auth:<appId>:<slot>:*`).
   *
   * Slot-scoped, and the scoping is the point: an app-wide `auth:<appId>:%` delete would
   * take a SIBLING slot's live credentials, so revoking Dropbox in a three-cloud app
   * would silently disconnect OneDrive too (R6's whole motivating shape).
   *
   * LIKE metacharacters in the prefix are escaped exactly as `deleteApp` does — the same
   * known limit applies (an appId or slot containing a literal colon could over-match),
   * and it is unreachable here for a second reason beyond randomUUID app ids:
   * `CONNECTION_SLOT_RULE` admits no colon.
   */
  function wipeConnectionSecrets(appId: string, slot: string): void {
    const prefix = authConnectionSlotPrefix(appId, slot).replace(/([!%_])/g, '!$1');
    run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key LIKE ? ESCAPE '!'`, [`${prefix}%`]);
    // RECLAIM THE PAGES, exactly as `deleteApp` does and for exactly the same reason:
    // a DELETE only marks the row's pages FREE, so the credential bytes stay in the file
    // and travel in `exportUserDb({ includeSecrets: true })` — a revoked API secret
    // readable in a synced image is the AL-03 lingering-values failure with extra steps.
    // Mutation-evidenced: the byte-probe in the AC13 test fails without this line while
    // every API-level assertion still passes, which is precisely how this class of bug
    // ships unnoticed.
    //
    // Best-effort for the same reason as `deleteApp`: VACUUM allocates a second copy of
    // the database, so it is the statement most likely to fail under memory pressure. A
    // failed reclaim must not fail an already-committed revocation — the row is gone from
    // every query path regardless, and the freed pages get reused later.
    try {
      db.run('VACUUM');
    } catch {
      /* space reclaim is an optimization, not part of the revoke's contract */
    }
  }

  /**
   * `requirement_version` for a persisted replacement (fold T-mn3): the SAME number when
   * the canonical hash matches, one higher when it differs.
   *
   * Canonical rather than literal comparison because the channels that produce
   * requirements do not emit stable key order — an LLM re-emits the same requirement
   * with keys shuffled every turn, and a `JSON.stringify` comparison would bump the
   * version on every rebuild. That is not merely noisy: P2's edit pipeline uses an
   * unchanged version as its "nothing to re-review" signal, so phantom bumps would
   * manufacture re-approval prompts for edits that changed nothing.
   */
  function nextRequirementVersion(previous: ConnectionRequirement, next: ConnectionRequirement, current: number): number {
    return canonicalRequirementHash(previous) === canonicalRequirementHash(next) ? current : current + 1;
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
          USERDB_TABLES.authSpecs,
          // v4: the app's connection rows go with it. Tombstones included — a `revoked`
          // row exists to tell the user about an app they still have; once the app is
          // gone there is nobody left to tell, and leaving it would resurrect a stale
          // tombstone against a reused id and count against the slot cap forever.
          USERDB_TABLES.connections,
        ]) {
          db.run(`DELETE FROM ${table} WHERE app_id = ?`, [appId]);
        }
        // 3b. The app's slice of the auth secrets namespace (`auth:<appId>:*` —
        //     credential values + connection state). The per-user `auth:_state_hmac`
        //     and `auth:_flow:*` keys are NOT app-keyed and survive.
        //     Known limit (review finding 3, cosmetic): an appId containing a literal
        //     colon would make this prefix over-match a sibling id sharing that prefix
        //     — unreachable with crypto.randomUUID() app ids; revisit only if app-id
        //     shapes ever widen.
        const prefix = authAppSecretPrefix(appId).replace(/([!%_])/g, '!$1');
        db.run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key LIKE ? ESCAPE '!'`, [`${prefix}%`]);
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

    // ------------------------------------------------------------- auth specs (AL-02)

    putAuthSpec(appId, spec) {
      assertOpen();
      const validated = parseAuthSpecStrict(spec);
      const union = deriveAuthAllowedHosts(validated);
      const unionJson = JSON.stringify(union);
      const specJson = JSON.stringify(validated);
      guardAddedBytes(specJson.length + unionJson.length, `auth spec for "${appId}"`);
      const existing = readAuthSpecRow(appId);
      const timestamp = now();
      if (existing === undefined) {
        run(
          `INSERT INTO ${USERDB_TABLES.authSpecs} (app_id, spec_json, status, allowed_hosts, approved_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          [appId, specJson, AUTH_SPEC_STATUS.unapproved, unionJson, timestamp, timestamp],
        );
        return readAuthSpecRow(appId)!;
      }
      if (existing.status === AUTH_SPEC_STATUS.approved) {
        // The freeze invariant (plan D5/N2): an ordinary update may not change the
        // DERIVED HOST UNION — recomputed here from the incoming spec, not read from
        // any caller-supplied column. Same-union edits keep the approval.
        if (!hostSetEquals(union, existing.allowedHosts)) {
          throw new HostFreezeViolation(existing.allowedHosts, union);
        }
        run(`UPDATE ${USERDB_TABLES.authSpecs} SET spec_json = ?, updated_at = ? WHERE app_id = ?`, [
          specJson,
          timestamp,
          appId,
        ]);
        return readAuthSpecRow(appId)!;
      }
      run(
        `UPDATE ${USERDB_TABLES.authSpecs} SET spec_json = ?, allowed_hosts = ?, updated_at = ? WHERE app_id = ?`,
        [specJson, unionJson, timestamp, appId],
      );
      return readAuthSpecRow(appId)!;
    },

    approveAuthSpec(appId) {
      assertOpen();
      const existing = readAuthSpecRow(appId);
      if (existing === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `no auth spec for "${appId}"`);
      }
      // Re-validate at the trust boundary: a preserved unknown-keys import row stays
      // unapprovable until a hub that understands it runs (R2 posture, fail closed).
      const validated = parseAuthSpecStrict(existing.spec);
      const union = deriveAuthAllowedHosts(validated);
      run(
        `UPDATE ${USERDB_TABLES.authSpecs} SET status = ?, allowed_hosts = ?, approved_at = ?, updated_at = ? WHERE app_id = ?`,
        [AUTH_SPEC_STATUS.approved, JSON.stringify(union), now(), now(), appId],
      );
      return readAuthSpecRow(appId)!;
    },

    reapproveAuthSpec(appId, spec) {
      assertOpen();
      const existing = readAuthSpecRow(appId);
      if (existing === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `no auth spec for "${appId}"`);
      }
      const validated = parseAuthSpecStrict(spec ?? existing.spec);
      const union = deriveAuthAllowedHosts(validated);
      run(
        `UPDATE ${USERDB_TABLES.authSpecs} SET spec_json = ?, status = ?, allowed_hosts = ?, approved_at = ?, updated_at = ? WHERE app_id = ?`,
        [JSON.stringify(validated), AUTH_SPEC_STATUS.approved, JSON.stringify(union), now(), now(), appId],
      );
      return readAuthSpecRow(appId)!;
    },

    getAuthSpec(appId) {
      assertOpen();
      return readAuthSpecRow(appId);
    },

    listAuthSpecs() {
      assertOpen();
      return select(`SELECT app_id FROM ${USERDB_TABLES.authSpecs} ORDER BY app_id`).map(
        (row) => readAuthSpecRow(String(row[0]))!,
      );
    },

    deleteAuthSpec(appId) {
      assertOpen();
      run(`DELETE FROM ${USERDB_TABLES.authSpecs} WHERE app_id = ?`, [appId]);
    },

    // --------------------------------------------------- connections (Dynamic Auth v2)

    putDeclaredConnection(appId, slot, requirement, provenance, opts = {}) {
      assertOpen();
      // Parse FIRST, before any row is read or written. Provenance is validated through
      // the same schema pass rather than trusted from the TypeScript signature: a
      // JavaScript caller (or a JSON round trip) can hand over `'llm_guess'` and the
      // compiler will never see it.
      const validated = parseConnectionRequirementStrict(requirement);
      if (!CONNECTION_PROVENANCES.includes(provenance)) {
        throw new UserDbError(
          USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT,
          `unknown connection provenance ${JSON.stringify(provenance)}`,
        );
      }
      const requirementJson = JSON.stringify(validated);
      const unionJson = JSON.stringify(deriveConnectionAllowedHosts(validated));
      guardAddedBytes(requirementJson.length + unionJson.length, `connection "${appId}/${slot}"`);

      const existing = readConnectionRow(appId, slot);
      const timestamp = now();
      if (existing === undefined) {
        // The row-count cap applies to NEW slots only (fold S-M1). Counting on the
        // replace path too would refuse the legitimate R3 re-inference of an existing
        // slot at exactly the cap — a build that is doing nothing wrong.
        const held = Number(
          select(`SELECT COUNT(*) FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ?`, [appId])[0]?.[0] ?? 0,
        );
        // Revoked tombstones are counted deliberately: they are exactly what a flooding
        // build leaves behind, and the revoke path keeps the row by design, so excluding
        // them would hand back an unbounded budget for the price of a revoke.
        if (held >= AUTH_MAX_SLOTS_PER_APP) {
          throw new ConnectionSlotCapExceeded(appId, slot, AUTH_MAX_SLOTS_PER_APP);
        }
        run(
          `INSERT INTO ${USERDB_CONNECTIONS_TABLE} (${CONNECTION_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, ?, ?)`,
          [
            appId,
            slot,
            requirementJson,
            1,
            provenance,
            opts.confidence ?? null,
            CONNECTION_STATUS.declared,
            unionJson,
            timestamp,
            timestamp,
          ],
        );
        return readConnectionRow(appId, slot)!;
      }

      // Status gates, checked in tombstone-first order so a revoked row reports the
      // remedy the user actually needs rather than "use stagePendingRequirement".
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      if (existing.status === CONNECTION_STATUS.approved) {
        throw new ConnectionWriteRuleViolation(
          appId,
          slot,
          existing.status,
          'a changed requirement must be staged with stagePendingRequirement and re-approved by the user',
        );
      }
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET requirement_json = ?, requirement_version = ?, provenance = ?, confidence = ?,
             allowed_hosts = ?, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [
          requirementJson,
          nextRequirementVersion(existing.requirement, validated, existing.requirementVersion),
          provenance,
          opts.confidence ?? null,
          unionJson,
          timestamp,
          appId,
          slot,
        ],
      );
      return readConnectionRow(appId, slot)!;
    },

    stagePendingRequirement(appId, slot, requirement) {
      assertOpen();
      const validated = parseConnectionRequirementStrict(requirement);
      const existing = requireConnectionRow(appId, slot);
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      if (existing.status !== CONNECTION_STATUS.approved) {
        throw new ConnectionWriteRuleViolation(
          appId,
          slot,
          existing.status,
          'only an approved row has a grant worth protecting; replace a declared row with putDeclaredConnection',
        );
      }
      const pendingJson = JSON.stringify(validated);
      guardAddedBytes(pendingJson.length, `pending requirement for "${appId}/${slot}"`);
      // ONLY the pending column moves. `allowed_hosts`, `requirement_json`, `status`,
      // `approved_at` and `requirement_version` are all left alone ON PURPOSE (fold B2):
      // the grant must keep serving EXACTLY what the user approved while the edit waits,
      // so an edit that widens the host set cannot widen the live ceiling by staging.
      // The version does not move either — a staged requirement is not yet persisted
      // INTO the grant; `reapproveConnection` bumps it at promotion.
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE} SET pending_requirement_json = ?, updated_at = ? WHERE app_id = ? AND slot = ?`,
        [pendingJson, now(), appId, slot],
      );
      return readConnectionRow(appId, slot)!;
    },

    approveConnection(appId, slot) {
      assertOpen();
      const existing = requireConnectionRow(appId, slot);
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      // Re-validate the STORED requirement at the trust boundary: a row written by a
      // newer hub, or one that arrived through an import, stays unapprovable until a hub
      // that understands it runs. Same fail-closed posture as `approveAuthSpec`.
      const validated = parseConnectionRequirementStrict(existing.requirement);
      const timestamp = now();
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET status = ?, allowed_hosts = ?, approved_at = ?, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [
          CONNECTION_STATUS.approved,
          // Derived here and stored verbatim. The import reconciliation compares these
          // exact bytes against a fresh derivation, so "what approval stored" and "what
          // derivation produces" must be the same function's output — never a
          // re-serialization of the column.
          JSON.stringify(deriveConnectionAllowedHosts(validated)),
          timestamp,
          timestamp,
          appId,
          slot,
        ],
      );
      return readConnectionRow(appId, slot)!;
    },

    reapproveConnection(appId, slot) {
      assertOpen();
      const existing = requireConnectionRow(appId, slot);
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      // Promote pending when there is one; re-approving without a staged edit is a
      // legitimate act too (the user re-confirming an unchanged grant), and it must not
      // bump the version — `nextRequirementVersion` handles both by comparison.
      const promoted = parseConnectionRequirementStrict(existing.pendingRequirement ?? existing.requirement);
      const requirementJson = JSON.stringify(promoted);
      const unionJson = JSON.stringify(deriveConnectionAllowedHosts(promoted));
      guardAddedBytes(requirementJson.length + unionJson.length, `re-approval of "${appId}/${slot}"`);
      const timestamp = now();
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET requirement_json = ?, requirement_version = ?, status = ?, allowed_hosts = ?,
             pending_requirement_json = NULL, approved_at = ?, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [
          requirementJson,
          nextRequirementVersion(existing.requirement, promoted, existing.requirementVersion),
          CONNECTION_STATUS.approved,
          unionJson,
          timestamp,
          timestamp,
          appId,
          slot,
        ],
      );
      return readConnectionRow(appId, slot)!;
    },

    revokeConnection(appId, slot) {
      assertOpen();
      const existing = requireConnectionRow(appId, slot);
      const timestamp = now();
      // The ROW SURVIVES. Revocation is not a delete: the tombstone is what lets the
      // wizard say "you revoked this on <date>" instead of silently re-offering a
      // clean-looking connection, and it is what makes `putDeclaredConnection` able to
      // refuse an automatic re-declaration. `requirement_json` stays readable for the
      // same reason — the wizard renders what was revoked.
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET status = ?, revoked_at = ?, approved_at = NULL, pending_requirement_json = NULL, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [CONNECTION_STATUS.revoked, existing.revokedAt ?? timestamp, timestamp, appId, slot],
      );
      // The VALUES go, and only this slot's. Metadata is a tombstone; credentials are
      // not — a revoked connection that kept working is the failure this closes.
      wipeConnectionSecrets(appId, slot);
      return readConnectionRow(appId, slot)!;
    },

    getConnection(appId, slot) {
      assertOpen();
      return readConnectionRow(appId, slot);
    },

    listConnections(appId) {
      assertOpen();
      const rows =
        appId === undefined
          ? select(`SELECT ${CONNECTION_COLUMNS} FROM ${USERDB_CONNECTIONS_TABLE} ORDER BY app_id, slot`)
          : select(`SELECT ${CONNECTION_COLUMNS} FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ? ORDER BY slot`, [
              appId,
            ]);
      return rows.map(toConnectionRow);
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
      const importMigration = migrate(next);
      // The candidate gets the SAME schema guarantees as an opened file: the version
      // stamp it arrived with is another hub's claim, so heal against sqlite_master
      // before reading its tables, and run the v3→v4 legacy wipe on a v3-era import for
      // the same reason it runs on a v3-era open (fold T-M4) — an imported file's
      // orphaned credential slice is no less orphaned for having arrived over sync.
      healMissingTables(next);
      if (importMigration.found < USERDB_SCHEMA_VERSION) wipeLegacyAuthSlice(next);
      // Auth reconciliation (plan D5/N1 + fold T-M5): snapshot the locally-APPROVED rows
      // from the still-open handle, then run the delta-aware passes on the candidate
      // BEFORE it becomes live. Every import path (pull-merge, applyRemote, recovery
      // restore, UI import) flows through here.
      const localApproved = new Map<string, LocalApprovedAuthSpec>();
      for (const row of select(
        `SELECT app_id, spec_json, allowed_hosts, approved_at FROM ${USERDB_TABLES.authSpecs} WHERE status = ?`,
        [AUTH_SPEC_STATUS.approved],
      )) {
        localApproved.set(String(row[0]), {
          specJson: String(row[1]),
          allowedHosts: String(row[2]),
          approvedAt: row[3] === null || row[3] === undefined ? null : String(row[3]),
        });
      }
      const localApprovedConnections = new Map<string, LocalApprovedConnection>();
      for (const row of select(
        `SELECT app_id, slot, requirement_json, allowed_hosts, approved_at, requirement_version
         FROM ${USERDB_CONNECTIONS_TABLE} WHERE status = ?`,
        [CONNECTION_STATUS.approved],
      )) {
        localApprovedConnections.set(connectionKey(String(row[0]), String(row[1])), {
          requirementJson: String(row[2]),
          allowedHosts: String(row[3]),
          approvedAt: row[4] === null || row[4] === undefined ? null : String(row[4]),
          requirementVersion: Number(row[5]),
        });
      }
      const report: UserDbImportReport = {
        droppedAuthSpecs: reconcileImportedAuthSpecs(next, localApproved),
        droppedConnections: reconcileImportedConnections(next, localApprovedConnections),
      };
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
      return report;
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
