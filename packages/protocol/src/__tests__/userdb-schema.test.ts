// Child-1 AC2 (TASK-20260803-userdb-core): the portable user-DB layout is spec surface —
// these tests lock the DDL constants the way schemas-stable locks the wire schemas.
// Changing anything here is a spec v0.x change and flows through SPEC_SYNC.
import { describe, expect, it } from 'vitest';
import {
  USERDB_DDL,
  USERDB_FILE,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
} from '../userdb-schema.js';

describe('userdb schema constants (spec surface)', () => {
  it('declares schema version 1', () => {
    expect(USERDB_SCHEMA_VERSION).toBe(1);
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

  it('declares the complete hub-namespace table set, all snug_-prefixed', () => {
    expect(Object.values(USERDB_TABLES).sort()).toEqual(
      [
        'snug_meta',
        'snug_profile',
        'snug_settings',
        'snug_secrets',
        'snug_apps',
        'snug_app_versions',
        'snug_chat_threads',
        'snug_chat_messages',
        'snug_app_data',
        'snug_sync',
      ].sort(),
    );
    for (const table of Object.values(USERDB_TABLES)) {
      expect(table.startsWith('snug_')).toBe(true);
    }
  });

  it('ships one CREATE TABLE IF NOT EXISTS statement per table', () => {
    expect(USERDB_DDL).toHaveLength(Object.values(USERDB_TABLES).length);
    for (const table of Object.values(USERDB_TABLES)) {
      expect(
        USERDB_DDL.some((ddl) => ddl.replace(/\s+/g, ' ').startsWith(`CREATE TABLE IF NOT EXISTS ${table} `)),
      ).toBe(true);
    }
  });

  it('locks the DDL byte-for-byte (spec snapshot — changes flow through SPEC_SYNC)', () => {
    expect(USERDB_DDL.join(';\n')).toMatchSnapshot();
  });
});
