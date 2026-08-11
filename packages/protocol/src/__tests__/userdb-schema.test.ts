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
  // TASK-20260810-p0-contracts AC20: v4 adds `snug_connections` (Dynamic Auth v2, requirement/
  // grant split). Version 3's assertion is REPLACED, not duplicated — `PRAGMA user_version` is a
  // single scalar and `migrate()` stamps it unconditionally (userdb.ts:498), so a test asserting
  // two versions at once would be asserting an impossible file.
  // TASK-20260810-p3-wizard: v5 DROPS `snug_auth_specs`. Again REPLACED rather than
  // duplicated, for the same reason — one scalar, one true answer.
  // TASK-20260811 P0.3: v6 adds `snug_app_versions.runtime_contract_json` (ADR-0018) —
  // ADDITIVE, an `addColumnIfMissing` on an EXISTING table (unlike v3/v4's new-table
  // replays, which is why this migration cannot be a bare DDL replay).
  it('declares schema version 6 (runtime contracts on app versions)', () => {
    expect(USERDB_SCHEMA_VERSION).toBe(6);
  });

  it('stores the runtime contract ON THE VERSION ROW — version-linked by construction (ADR-0018)', () => {
    // The contract lives on `snug_app_versions`, not on `snug_apps` and not in a docs
    // slug: revert must restore the contract that shipped with the reverted HTML, and a
    // free-text doc is neither version-linked nor bounded.
    const versionsDdl = USERDB_DDL.find((ddl) => ddl.includes(`CREATE TABLE IF NOT EXISTS ${USERDB_TABLES.appVersions}`));
    expect(versionsDdl).toBeDefined();
    expect(versionsDdl).toContain('runtime_contract_json TEXT');
    // Nullable: an app without a contract is the NORMAL legacy/LLM-optional case, never an
    // error state (AC-F1-4).
    expect(versionsDdl).not.toMatch(/runtime_contract_json TEXT NOT NULL/);
  });

  it('adds NO new table at v6 — USERDB_TABLES is untouched, so the self-heal guard is unaffected', () => {
    expect(Object.values(USERDB_TABLES)).not.toContain('snug_runtime_contracts');
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
        // v3's table stays listed: P0 is ADDITIVE (fold B1). `snug_auth_specs` has live
        // consumers across packages/db, packages/auth, and the playground, and its deletion is
        // a NAMED EXIT ITEM of P3 — removing it here would make "every phase ends green" false.
        'snug_auth_specs',
        // v4 (Dynamic Auth v2): slot-keyed connections, PRIMARY KEY (app_id, slot) — R6.
        'snug_connections',
      ].sort(),
    );
    for (const table of Object.values(USERDB_TABLES)) {
      expect(table.startsWith('snug_')).toBe(true);
    }
    // v2 removed the blob table — per-app data is native tables now (ADR-0010).
    expect(Object.values(USERDB_TABLES)).not.toContain('snug_app_data');
  });

  it('ships one CREATE TABLE IF NOT EXISTS statement per LIVE table (indexes live in USERDB_INDEX_DDL)', () => {
    // `authSpecs` keeps its NAME in USERDB_TABLES so the v5 migration can name what it
    // drops, but it has no DDL — creating it would resurrect the surface v5 removes on
    // every self-heal replay. So the DDL set is the table set MINUS that one name.
    const liveTables = Object.values(USERDB_TABLES).filter((table) => table !== USERDB_TABLES.authSpecs);
    expect(USERDB_DDL).toHaveLength(liveTables.length);
    for (const table of liveTables) {
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

  /**
   * P3 (fold B1's named exit): the v3 table is GONE at v5, and its absence is asserted
   * rather than assumed. A `CREATE TABLE IF NOT EXISTS` left behind here would be replayed
   * by the self-heal guard on every open, quietly rebuilding the second grant surface the
   * migration exists to remove — so this is the test that keeps the deletion deleted.
   *
   * The COLUMN-PURITY claim the old v3 test carried (no token/flow/session columns in the
   * synced grant table) is not dropped: it is asserted on `snug_connections` immediately
   * below, which is now the only grant table there is.
   */
  it('v3 table snug_auth_specs has NO DDL — it was dropped at v5 and must never be re-created', () => {
    expect(USERDB_DDL.some((ddl) => ddl.includes('snug_auth_specs'))).toBe(false);
  });

  it('v4 table snug_connections is slot-keyed and carries the requirement/grant split (parent plan §3)', () => {
    const conns = USERDB_DDL.find((d) => d.includes('snug_connections '))!.replace(/\s+/g, ' ');
    // R6: one row per (app, slot) — the v3 shape made one-connection-per-app STRUCTURAL by
    // putting app_id alone on the PK. Lifting that is the whole point of the composite key.
    expect(conns).toContain('PRIMARY KEY (app_id, slot)');
    expect(conns).toContain('app_id TEXT NOT NULL');
    expect(conns).toContain('slot TEXT NOT NULL');
    // The requirement half — what the app NEEDS. Written at authoring moments only.
    expect(conns).toContain('requirement_json TEXT NOT NULL');
    expect(conns).toContain('requirement_version INTEGER NOT NULL');
    expect(conns).toContain('provenance TEXT NOT NULL');
    expect(conns).toContain('confidence REAL');
    // The grant half — what the user ALLOWED. Written only on explicit approval.
    expect(conns).toContain('status TEXT NOT NULL');
    expect(conns).toContain('allowed_hosts TEXT NOT NULL');
    expect(conns).toContain('approved_at TEXT');
    // Fold B2: an edit's changed requirement for an APPROVED row STAGES here; the grant keeps
    // serving requirement_json + its old frozen hosts until re-approval. "needs re-approval" is
    // DERIVED (status='approved' AND pending_requirement_json IS NOT NULL), never a 4th status.
    expect(conns).toContain('pending_requirement_json TEXT');
    // Fold T-M5: `imported` is a COLUMN — the strictObject requirement schema has no seat for
    // an envelope flag, so a JSON-embedded flag would be a strict-parse rejection.
    expect(conns).toContain('imported INTEGER NOT NULL DEFAULT 0');
    // TOMBSTONE: the row survives revoke, which is what closes the revoke-reversal finding.
    expect(conns).toContain('revoked_at TEXT');
    expect(conns).toContain('created_at TEXT NOT NULL');
    expect(conns).toContain('updated_at TEXT NOT NULL');

    // COLUMN PURITY (plan D5/N3), inherited from the deleted v3 assertion and now stated
    // on the only grant table there is. Dynamic state NEVER lives here: connection state
    // goes to the `auth:<appId>:<slot>:_connection` secret and flow state to memory /
    // `auth:_flow:<flowId>`. The reason is not tidiness — this table is SYNCED under a
    // content-hash gate, so a token refresh that touched it would dirty the synced surface
    // and change default-export bytes on every silent background rotation.
    //
    // `revoked_at` is excluded from the scan: it is a GRANT fact (the user's own act,
    // stable until they reconnect), not dynamic state, and it legitimately contains the
    // substring the loop would otherwise trip on.
    const scanned = conns.replace(/revoked_at/g, '');
    for (const forbidden of ['token', 'refresh', 'expires', 'verifier', 'flow', 'session', 'last_error']) {
      expect(scanned.toLowerCase(), `snug_connections must not carry a ${forbidden} column`).not.toContain(forbidden);
    }
  });

  it('v4 table snug_connections holds NO credential or dynamic-connection state (ADR-0014 custody, unchanged)', () => {
    const conns = USERDB_DDL.find((d) => d.includes('snug_connections '))!.replace(/\s+/g, ' ');
    // Same posture as the v3 table, restated because the table is new: credential VALUES live
    // at `auth:<appId>:<slot>:<fieldKey>` and connection state at `auth:<appId>:<slot>:_connection`
    // in snug_secrets. A token refresh must not dirty this synced table (content-hash gate) nor
    // change default-export bytes.
    for (const forbidden of ['token', 'secret', 'refresh', 'expires', 'verifier', 'flow', 'session', 'password']) {
      expect(conns.toLowerCase(), forbidden).not.toContain(forbidden);
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
