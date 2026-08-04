/**
 * Portable User Database Format — spec v0.2 surface (ADR-0007, ADR-0010).
 *
 * One SQLite file per user holds everything the user owns: app code + versions, per-app
 * data as REAL namespaced tables (`app_<token>__<name>`), a per-app schema registry,
 * per-app knowledge docs, chat threads, settings, secrets, profile, and sync-origin
 * config. Hubs that speak Snug agree on THIS layout — that is what makes the file
 * portable across hub providers. Like every constant in this package, changes flow
 * through SPEC_SYNC and the spec changelog; the DDL is locked by snapshot tests the way
 * the wire schemas are locked by schemas-stable.
 *
 * Layout invariants (v2, ADR-0010):
 * - Hub-namespace tables are `snug_`-prefixed; apps NEVER see them. Dynamic per-app rest
 *   tables use the reserved `app_` prefix and are deliberately NOT enumerated in
 *   USERDB_TABLES.
 * - Per-app isolation is physical AT RUNTIME: an app's objects are materialized into the
 *   app's own database (natural names) and its SQL executes there. At rest, each table's
 *   rows live under `app_<token>__<name>`; the registry (`snug_app_schemas`) carries the
 *   app's `sqlite_master` DDL VERBATIM — DDL bodies are never string-rewritten.
 * - `appDataToken` and the object-naming rule below are NORMATIVE: two conforming hubs
 *   must derive identical rest-table names to open the same file.
 * - `snug_secrets` is stripped from hub-origin sync pushes and default exports
 *   (ADR-0008); it exists in the local runtime copy and opt-in full exports only.
 * - Schema version rides in `PRAGMA user_version`; migrations are forward-only. The
 *   v1→v2 migration is structural only (pre-launch blob data abandoned).
 */

/** Version written to `PRAGMA user_version`; bump with a migration + spec changelog entry. */
export const USERDB_SCHEMA_VERSION = 2 as const;

/** Size/retention limits for the user DB (spec-normative, rule R6 family). */
export const USERDB_LIMITS = {
  /** Whole-file cap — also the hub `PUT /userdb` body limit and per-user quota unit. */
  MAX_USERDB_BYTES: 64 * 1024 * 1024,
  /** Minimum UNPINNED app versions a conforming hub retains per app; the factory version is pinned and never pruned. */
  VERSIONS_RETAINED: 5,
} as const;

/**
 * OPFS directory + file name for the runtime copy. Deliberately distinct from the
 * per-app store directory (`snug-db`) so the user DB can never collide with
 * `namespaceToFileName` output (plan F13).
 */
export const USERDB_OPFS_DIR = 'snug-userdb';
export const USERDB_FILE = 'user.sqlite';

/** Hub-namespace table names. Dynamic `app_<token>__*` rest tables are NOT listed here. */
export const USERDB_TABLES = {
  meta: 'snug_meta',
  profile: 'snug_profile',
  settings: 'snug_settings',
  secrets: 'snug_secrets',
  apps: 'snug_apps',
  appVersions: 'snug_app_versions',
  appSchemas: 'snug_app_schemas',
  appMigrations: 'snug_app_migrations',
  appDocs: 'snug_app_docs',
  chatThreads: 'snug_chat_threads',
  chatMessages: 'snug_chat_messages',
  sync: 'snug_sync',
} as const;

export type UserDbTable = (typeof USERDB_TABLES)[keyof typeof USERDB_TABLES];

// ---------------------------------------------------------------- app-data namespace

/**
 * NORMATIVE object-naming rule for app-created tables/indexes/triggers/views. Names
 * outside this rule (or under a reserved prefix) fail the write-back closed — they are
 * never interpolated into hub-side SQL. Uppercase is allowed for v1-app compatibility
 * (SQLite identifiers are case-insensitive).
 */
export const APP_OBJECT_NAME_RULE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** Reserved prefixes (checked case-insensitively). `app_` blocks forging another app's rest name. */
export const APP_RESERVED_PREFIXES = ['snug_', 'sqlite_', 'app_'] as const;

/** The single reserved-prefix exemption: the driver-internal kv table inside every app runtime. */
export const APP_KV_TABLE = 'snug_kv';

export function isValidAppObjectName(name: string): boolean {
  if (name === APP_KV_TABLE) return true;
  if (!APP_OBJECT_NAME_RULE.test(name)) return false;
  const lower = name.toLowerCase();
  return !APP_RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function utf8Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * NORMATIVE token function (review F1): total over all host-assigned namespaces and
 * injective — UUID-shaped namespaces map to 32 lowercase hex chars (dashes stripped);
 * everything else maps to `'x' + hex(utf8(namespace))`. `x` sits outside the hex
 * alphabet, so the two ranges cannot collide.
 */
export function appDataToken(namespace: string): string {
  if (UUID_SHAPE.test(namespace)) return namespace.toLowerCase().replace(/-/g, '');
  return `x${utf8Hex(namespace)}`;
}

export const APP_REST_PREFIX = 'app_';
export const APP_REST_SEPARATOR = '__';

/** Rest-table name for one app object: `app_<token>__<name>`. Callers validate `name` first. */
export function appRestTableName(token: string, name: string): string {
  return `${APP_REST_PREFIX}${token}${APP_REST_SEPARATOR}${name}`;
}

/** One registry entry: an app runtime object exactly as sqlite_master records it. */
export interface AppSchemaObject {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  /** The runtime `sqlite_master.sql` text, VERBATIM (natural names — never rewritten). */
  ddl: string;
}

/** `snug_app_schemas.schema_json` shape: all objects in creation order. */
export interface AppSchemaJson {
  objects: AppSchemaObject[];
  /** AUTOINCREMENT continuity: sqlite_sequence values per table at last write-back. */
  sequences?: Record<string, number>;
}

/** Advisory standard slugs for `snug_app_docs`; the table shape is normative, the values are not. */
export const STANDARD_APP_DOC_SLUGS = ['vision', 'requirements', 'plan', 'lessons', 'memory', 'next-tasks'] as const;

// ------------------------------------------------------------------------------- DDL

/**
 * Normative table DDL, one statement per table, `IF NOT EXISTS` so migration replay is
 * idempotent. Key/value tables store JSON-encoded values except `snug_secrets`
 * (opaque strings). Timestamps are ISO-8601 UTC strings. Columns added by the v1→v2
 * migration sit LAST so migrated and fresh files agree on column order.
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
    updated_at TEXT NOT NULL,
    install_source TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appVersions} (
    app_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    html TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appSchemas} (
    app_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    schema_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appMigrations} (
    app_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ddl TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (app_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appDocs} (
    app_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (app_id, slug)
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
    created_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    meta TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.sync} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** Normative index DDL, separate from tables so the one-CREATE-per-table invariant holds. */
export const USERDB_INDEX_DDL: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_snug_apps_install_source
    ON ${USERDB_TABLES.apps} (install_source) WHERE install_source IS NOT NULL`,
];
