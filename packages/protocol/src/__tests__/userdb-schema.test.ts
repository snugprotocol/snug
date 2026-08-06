// Child-1 (TASK-20260803-userdb-v2): the portable user-DB layout is spec surface —
// these tests lock the DDL constants the way schemas-stable locks the wire schemas.
// Changing anything here is a spec v0.x change and flows through SPEC_SYNC.
//
// v2 (ADR-0010): per-app data becomes real namespaced tables (`app_<token>__<name>`)
// plus a schema registry; the token function and naming rule are NORMATIVE — two hubs
// must derive identical rest-table names to open the same file.
import { describe, expect, it } from 'vitest';
import {
  APP_KV_TABLE,
  APP_OBJECT_NAME_RULE,
  APP_RESERVED_PREFIXES,
  appDataToken,
  appRestTableName,
  isValidAppObjectName,
  STANDARD_APP_DOC_SLUGS,
  USERDB_DDL,
  USERDB_FILE,
  USERDB_INDEX_DDL,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
} from '../userdb-schema.js';

describe('userdb schema constants (spec surface)', () => {
  it('declares schema version 3 (AL-02: snug_auth_specs — internal draft, excluded from the AL-13 spec push)', () => {
    expect(USERDB_SCHEMA_VERSION).toBe(3);
  });

  it('caps the whole user DB at 64 MiB and retains at least 5 versions per app', () => {
    expect(USERDB_LIMITS.MAX_USERDB_BYTES).toBe(64 * 1024 * 1024);
    expect(USERDB_LIMITS.VERSIONS_RETAINED).toBeGreaterThanOrEqual(5);
  });

  it('lives in a distinct OPFS directory that can never collide with per-app files (F13)', () => {
    expect(USERDB_OPFS_DIR).toBe('snug-userdb');
    expect(USERDB_OPFS_DIR).not.toBe('snug-db');
    expect(USERDB_FILE).toBe('user.sqlite');
  });

  it('declares the complete hub-namespace table set, all snug_-prefixed (dynamic app_* rest tables are deliberately NOT enumerated here)', () => {
    expect(Object.values(USERDB_TABLES).sort()).toEqual(
      [
        'snug_meta',
        'snug_profile',
        'snug_settings',
        'snug_secrets',
        'snug_apps',
        'snug_app_versions',
        'snug_app_schemas',
        'snug_app_migrations',
        'snug_app_docs',
        'snug_chat_threads',
        'snug_chat_messages',
        'snug_sync',
        'snug_auth_specs',
      ].sort(),
    );
    for (const table of Object.values(USERDB_TABLES)) {
      expect(table.startsWith('snug_')).toBe(true);
    }
    // v2 removed the blob table — per-app data is native tables now (ADR-0010).
    expect(Object.values(USERDB_TABLES)).not.toContain('snug_app_data');
  });

  it('ships one CREATE TABLE IF NOT EXISTS statement per table (indexes live in USERDB_INDEX_DDL)', () => {
    expect(USERDB_DDL).toHaveLength(Object.values(USERDB_TABLES).length);
    for (const table of Object.values(USERDB_TABLES)) {
      expect(
        USERDB_DDL.some((ddl) => ddl.replace(/\s+/g, ' ').startsWith(`CREATE TABLE IF NOT EXISTS ${table} `)),
      ).toBe(true);
    }
  });

  it('ships the install-source dedup index as a partial unique index', () => {
    expect(USERDB_INDEX_DDL.length).toBeGreaterThanOrEqual(1);
    for (const ddl of USERDB_INDEX_DDL) {
      expect(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS /.test(ddl.replace(/\s+/g, ' '))).toBe(true);
    }
    const dedup = USERDB_INDEX_DDL.find((ddl) => ddl.includes('idx_snug_apps_install_source'));
    expect(dedup).toBeDefined();
    expect(dedup!.replace(/\s+/g, ' ')).toContain('UNIQUE INDEX');
    expect(dedup!.replace(/\s+/g, ' ')).toContain('WHERE install_source IS NOT NULL');
  });

  it('v3 table snug_auth_specs holds ONLY approval-stable spec metadata (plan D5/N3 — no token, no connection, no flow columns)', () => {
    const specs = USERDB_DDL.find((d) => d.includes('snug_auth_specs '))!.replace(/\s+/g, ' ');
    expect(specs).toContain('app_id TEXT PRIMARY KEY');
    expect(specs).toContain('spec_json TEXT NOT NULL');
    expect(specs).toContain('status TEXT NOT NULL');
    expect(specs).toContain('allowed_hosts TEXT NOT NULL');
    expect(specs).toContain('approved_at TEXT');
    // Dynamic state NEVER lives here: connection state → auth:<appId>:_connection secret,
    // flow state → in-memory / auth:_flow:<flowId> secret (a refresh must not dirty the
    // synced table nor change default-export bytes).
    for (const forbidden of ['token', 'refresh', 'expires', 'verifier', 'flow', 'session', 'last_error']) {
      expect(specs.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('v2 columns are present in the DDL (install_source, pinned, meta)', () => {
    const apps = USERDB_DDL.find((d) => d.includes('snug_apps '))!.replace(/\s+/g, ' ');
    expect(apps).toContain('install_source TEXT');
    const versions = USERDB_DDL.find((d) => d.includes('snug_app_versions '))!.replace(/\s+/g, ' ');
    expect(versions).toContain('pinned INTEGER NOT NULL DEFAULT 0');
    const messages = USERDB_DDL.find((d) => d.includes('snug_chat_messages '))!.replace(/\s+/g, ' ');
    expect(messages).toContain('pinned INTEGER NOT NULL DEFAULT 0');
    expect(messages).toContain('meta TEXT');
  });
});

describe('appDataToken — total, injective, spec-normative (review F1)', () => {
  it('maps UUID-shaped namespaces to 32 lowercase hex chars, dashes stripped', () => {
    expect(appDataToken('A7F3B2C1-0D4E-4F5A-8B6C-9D0E1F2A3B4C')).toBe('a7f3b2c10d4e4f5a8b6c9d0e1f2a3b4c');
    expect(appDataToken('a7f3b2c1-0d4e-4f5a-8b6c-9d0e1f2a3b4c')).toBe('a7f3b2c10d4e4f5a8b6c9d0e1f2a3b4c');
    expect(appDataToken('a7f3b2c1-0d4e-4f5a-8b6c-9d0e1f2a3b4c')).toHaveLength(32);
  });

  it('maps every other namespace to x + utf8-hex (total function; x is outside the hex alphabet so ranges cannot collide)', () => {
    expect(appDataToken('starter--chess')).toBe('x' + Buffer.from('starter--chess', 'utf8').toString('hex'));
    expect(appDataToken('')).toBe('x');
    expect(appDataToken('täble')).toBe('x' + Buffer.from('täble', 'utf8').toString('hex'));
    expect(appDataToken('starter--chess')[0]).toBe('x');
  });

  it('is injective across the two ranges (distinct namespaces never share a token)', () => {
    const samples = ['app-1', 'app-2', 'starter--chess', 'starter--flying-pig', '', 'a', 'A',
      'a7f3b2c1-0d4e-4f5a-8b6c-9d0e1f2a3b4c', 'a7f3b2c10d4e4f5a8b6c9d0e1f2a3b4c'];
    const tokens = samples.map(appDataToken);
    expect(new Set(tokens).size).toBe(samples.length);
  });

  it('appRestTableName composes prefix, token, and validated name', () => {
    expect(appRestTableName('deadbeef', 'trades')).toBe('app_deadbeef__trades');
    expect(appRestTableName(appDataToken('starter--chess'), APP_KV_TABLE)).toBe(
      `app_${appDataToken('starter--chess')}__snug_kv`,
    );
  });
});

describe('app object naming rule + reserved prefixes (review F2/F3 gate inputs)', () => {
  it('accepts ordinary table names (case allowed for v1 compat)', () => {
    for (const name of ['trades', 'Habits', 't', 't_1', 'equities_2024', 'A'.repeat(41)]) {
      expect(isValidAppObjectName(name), name).toBe(true);
    }
  });

  it('rejects names that could not be safely interpolated or that forge namespaces', () => {
    for (const name of [
      '', '1trades', 'app_deadbeef__trades', 'APP_x', 'snug_secrets', 'SNUG_kv', 'sqlite_master',
      'a'.repeat(42), 'robert"; DROP TABLE snug_secrets;--', 'has space', 'has-dash', 'has.dot',
    ]) {
      expect(isValidAppObjectName(name), name).toBe(false);
    }
  });

  it('exempts exactly the driver-internal kv table', () => {
    expect(APP_KV_TABLE).toBe('snug_kv');
    expect(isValidAppObjectName('snug_kv')).toBe(true);
    expect(isValidAppObjectName('snug_kv2')).toBe(false);
  });

  it('pins the reserved prefixes and the name regex as constants', () => {
    expect([...APP_RESERVED_PREFIXES].sort()).toEqual(['app_', 'snug_', 'sqlite_'].sort());
    expect(APP_OBJECT_NAME_RULE.source).toBe('^[A-Za-z][A-Za-z0-9_]{0,40}$');
  });
});

describe('standard doc slugs (shape normative, values advisory)', () => {
  it('pins the advisory slug list', () => {
    expect([...STANDARD_APP_DOC_SLUGS]).toEqual(['vision', 'requirements', 'plan', 'lessons', 'memory', 'next-tasks']);
  });
});

describe('DDL snapshots (spec surface — changes flow through SPEC_SYNC)', () => {
  it('locks the table DDL byte-for-byte', () => {
    expect(USERDB_DDL.join(';\n')).toMatchSnapshot();
  });

  it('locks the index DDL byte-for-byte', () => {
    expect(USERDB_INDEX_DDL.join(';\n')).toMatchSnapshot();
  });
});
