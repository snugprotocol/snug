/**
 * Portable User Database Format — spec v0.2 surface (ADR-0007, TASK-20260803-portable-hub).
 *
 * One SQLite file per user holds everything the user owns: app code + versions, per-app
 * data (blob-embedded standalone SQLite databases), chat threads, settings, secrets,
 * profile, and sync-origin config. Hubs that speak Snug agree on THIS layout — that is
 * what makes the file portable across hub providers. Like every constant in this
 * package, changes flow through SPEC_SYNC and the spec changelog; the DDL is locked by
 * a snapshot test the way the wire schemas are locked by schemas-stable.
 *
 * Layout invariants:
 * - Hub-namespace tables are `snug_`-prefixed; apps NEVER see them (the runner db bridge
 *   only reaches blob-embedded app databases via `snug_app_data`).
 * - Per-app isolation is physical-in-logical: each app's data is a complete standalone
 *   SQLite database stored as one BLOB row — no shared tables, no SQL rewriting.
 * - `snug_secrets` is stripped from hub-origin sync pushes and default exports
 *   (ADR-0008); it exists in the local runtime copy and opt-in full exports only.
 * - Schema version rides in `PRAGMA user_version`; migrations are forward-only.
 */

/** Version written to `PRAGMA user_version`; bump with a migration + spec changelog entry. */
export const USERDB_SCHEMA_VERSION = 1 as const;

/** Size/retention limits for the user DB (spec-normative, rule R6 family). */
export const USERDB_LIMITS = {
  /** Whole-file cap — also the hub `PUT /userdb` body limit and per-user quota unit. */
  MAX_USERDB_BYTES: 64 * 1024 * 1024,
  /** Minimum app versions a conforming hub retains per app (pruning keeps the newest N). */
  VERSIONS_RETAINED: 5,
} as const;

/**
 * OPFS directory + file name for the runtime copy. Deliberately distinct from the
 * per-app store directory (`snug-db`) so the user DB can never collide with
 * `namespaceToFileName` output (plan F13).
 */
export const USERDB_OPFS_DIR = 'snug-userdb';
export const USERDB_FILE = 'user.sqlite';

/** Hub-namespace table names. */
export const USERDB_TABLES = {
  meta: 'snug_meta',
  profile: 'snug_profile',
  settings: 'snug_settings',
  secrets: 'snug_secrets',
  apps: 'snug_apps',
  appVersions: 'snug_app_versions',
  chatThreads: 'snug_chat_threads',
  chatMessages: 'snug_chat_messages',
  appData: 'snug_app_data',
  sync: 'snug_sync',
} as const;

export type UserDbTable = (typeof USERDB_TABLES)[keyof typeof USERDB_TABLES];

/**
 * Normative DDL, one statement per table, `IF NOT EXISTS` so migration replay is
 * idempotent. Key/value tables store JSON-encoded values except `snug_secrets`
 * (opaque strings). Timestamps are ISO-8601 UTC strings.
 */
export const USERDB_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.meta} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.profile} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.settings} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.secrets} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.apps} (
    app_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT,
    icon_emoji TEXT,
    icon_color TEXT,
    uses_db INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appVersions} (
    app_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    html TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.chatThreads} (
    thread_id TEXT PRIMARY KEY,
    app_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.chatMessages} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appData} (
    namespace TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.sync} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
