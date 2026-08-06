// AL-02 (TASK-20260805-auth-core) AC3: the snug_auth_specs accessor — the ONLY writer
// of that table — with the host-freeze invariant enforced at the db write boundary
// (plan D5), the v2→v3 migration, and the DELTA-AWARE import reconciliation pass
// inside importUserDb (N1: approval survives byte-identical re-import; new/changed
// rows demote to imported_unapproved; unknown-keys-only failures demote-and-preserve;
// unusable rows are dropped + surfaced; doctored widened hosts are never honored).
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SPEC_STATUS, USERDB_FILE, deriveAuthAllowedHosts, authSpecSchema } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { createSyncLoop } from '../../sync/loop.js';
import type { SyncProvider } from '../../sync/provider.js';
import { HostFreezeViolation, USERDB_ERROR_CODES, UserDbError, openUserDb, type UserDb } from '../userdb.js';

const open = async (backend: MemoryBackend): Promise<UserDb> => {
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

let backend: MemoryBackend;
beforeEach(() => {
  backend = createMemoryBackend();
});

const APP = 'a7f3b2c1-0d4e-4f5a-8b6c-9d0e1f2a3b4c';

const oauthSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    refreshUrl: 'https://refresh.spotify.example/api/token',
  },
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
} as const;

const bearerSpec = {
  kind: 'bearer_token',
  provider: { name: 'GitHub' },
  fields: [{ key: 'token', label: 'PAT', type: 'secret' }],
  declaredApiHosts: ['api.github.com'],
} as const;

// ------------------------------------------------------------------ accessors

describe('AC3 — snug_auth_specs accessor', () => {
  it('putAuthSpec validates strictly (ingest fail-closed) and creates an unapproved row', async () => {
    const db = await open(backend);
    const row = db.putAuthSpec(APP, oauthSpec);
    expect(row.status).toBe(AUTH_SPEC_STATUS.unapproved);
    expect(row.approvedAt).toBeUndefined();
    expect(db.getAuthSpec(APP)?.appId).toBe(APP);
    await db.close();
  });

  it('putAuthSpec rejects an invalid spec with a typed error (nothing written)', async () => {
    const db = await open(backend);
    expect(() => db.putAuthSpec(APP, { kind: 'api_key', provider: {} })).toThrowError(UserDbError);
    try {
      db.putAuthSpec(APP, { ...bearerSpec, futureField: 'x' });
      expect.unreachable('unknown keys must fail the direct-write boundary');
    } catch (err) {
      expect((err as UserDbError).code).toBe(USERDB_ERROR_CODES.INVALID_AUTH_SPEC);
    }
    expect(db.getAuthSpec(APP)).toBeUndefined();
    await db.close();
  });

  it('approveAuthSpec freezes the COMPLETE derived host union (incl. refreshUrl host) and returns it for display', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    const approved = db.approveAuthSpec(APP);
    expect(approved.status).toBe(AUTH_SPEC_STATUS.approved);
    expect(approved.approvedAt).toBeDefined();
    // Display completeness (D2): the accessor hands back the FULL frozen list.
    expect(approved.allowedHosts).toEqual([
      'accounts.spotify.com',
      'api.spotify.com',
      'refresh.spotify.example',
    ]);
    await db.close();
  });

  it('listAuthSpecs + deleteAuthSpec round-trip', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.putAuthSpec('second-app', bearerSpec);
    expect(db.listAuthSpecs().map((r) => r.appId).sort()).toEqual([APP, 'second-app'].sort());
    db.deleteAuthSpec('second-app');
    expect(db.getAuthSpec('second-app')).toBeUndefined();
    await db.close();
  });
});

// ---------------------------------------------------------------- host freeze

describe('AC3 — host-freeze at the db write boundary (plan D5)', () => {
  it('ordinary update rejects ANY change to the derived host union — endpoint host edit', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.approveAuthSpec(APP);
    const widened = {
      ...oauthSpec,
      endpoints: { ...oauthSpec.endpoints, tokenUrl: 'https://evil.example.com/token' },
    };
    expect(() => db.putAuthSpec(APP, widened)).toThrowError(HostFreezeViolation);
    // The approved row is untouched.
    const row = db.getAuthSpec(APP)!;
    expect(row.status).toBe(AUTH_SPEC_STATUS.approved);
    expect(row.allowedHosts).not.toContain('evil.example.com');
    await db.close();
  });

  it('ordinary update rejects a widened declaredApiHosts list (and a refreshUrl swap — N2)', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.approveAuthSpec(APP);
    expect(() =>
      db.putAuthSpec(APP, { ...oauthSpec, declaredApiHosts: ['api.spotify.com', 'exfil.example.com'] }),
    ).toThrowError(HostFreezeViolation);
    expect(() =>
      db.putAuthSpec(APP, {
        ...oauthSpec,
        endpoints: { ...oauthSpec.endpoints, refreshUrl: 'https://stealthy.example.com/refresh' },
      }),
    ).toThrowError(HostFreezeViolation);
    await db.close();
  });

  it('ordinary update of an approved row is allowed when the union is unchanged (scope edit)', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    const approved = db.approveAuthSpec(APP);
    const updated = db.putAuthSpec(APP, { ...oauthSpec, scopes: ['user-read-private'] });
    expect(updated.status).toBe(AUTH_SPEC_STATUS.approved);
    expect(updated.approvedAt).toBe(approved.approvedAt);
    expect(updated.allowedHosts).toEqual(approved.allowedHosts);
    await db.close();
  });

  it('widening happens ONLY via reapproveAuthSpec — new approved_at, full list re-displayed', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    const first = db.approveAuthSpec(APP);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const widened = { ...oauthSpec, declaredApiHosts: ['api.spotify.com', 'cdn.spotify.example'] };
    const reapproved = db.reapproveAuthSpec(APP, widened);
    expect(reapproved.status).toBe(AUTH_SPEC_STATUS.approved);
    expect(reapproved.approvedAt).not.toBe(first.approvedAt);
    expect(reapproved.allowedHosts).toContain('cdn.spotify.example');
    expect(reapproved.allowedHosts).toEqual(deriveAuthAllowedHosts(authSpecSchema.parse(widened)));
    await db.close();
  });
});

// ------------------------------------------------------------------ migration

describe('AC3 — v2→v3 migration', () => {
  it('migrates a v2 file forward, creating snug_auth_specs and preserving existing data', async () => {
    const db = await open(backend);
    db.installApp({ displayName: 'Chess', html: '<html>v1</html>' });
    await db.close();
    // Rewind the persisted file to v2: drop the v3 table, stamp user_version 2.
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const raw = new SQL.Database(backend.files.get(USERDB_FILE));
    raw.run('DROP TABLE snug_auth_specs');
    raw.run('PRAGMA user_version = 2');
    await backend.save(USERDB_FILE, raw.export());
    raw.close();

    const reopened = await open(backend);
    expect(reopened.listApps()).toHaveLength(1);
    reopened.putAuthSpec(APP, bearerSpec); // table exists again
    expect(reopened.getAuthSpec(APP)?.status).toBe(AUTH_SPEC_STATUS.unapproved);
    await reopened.close();
  });
});

// ------------------------------------------------------------- delete cascade

describe('AC3 — deleteApp cascades the auth surface', () => {
  it('removes the app auth spec row and every auth:<appId>:* secret', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Music', html: '<html></html>' });
    db.putAuthSpec(app.appId, oauthSpec);
    db.approveAuthSpec(app.appId);
    db.setSecret(`auth:${app.appId}:access_token`, 'tok');
    db.setSecret(`auth:${app.appId}:_connection`, '{"status":"connected"}');
    db.setSecret('auth:_state_hmac', 'keep-me');
    await db.deleteApp(app.appId);
    expect(db.getAuthSpec(app.appId)).toBeUndefined();
    expect(db.listSecretKeys().filter((k) => k.startsWith(`auth:${app.appId}:`))).toEqual([]);
    expect(db.getSecret('auth:_state_hmac')).toBe('keep-me'); // per-user key survives app deletion
    await db.close();
  });
});

// -------------------------------------------------------- import reconciliation

/** Doctor the exported user-DB bytes through raw sql.js. */
async function doctorBytes(bytes: Uint8Array, mutate: (raw: import('sql.js').Database) => void): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: () => locateWasm() });
  const raw = new SQL.Database(bytes);
  try {
    mutate(raw);
    return raw.export();
  } finally {
    raw.close();
  }
}

describe('AC3 — delta-aware import reconciliation (plan D5/N1, inside importUserDb)', () => {
  it('byte-identical re-import: approval SURVIVES (no approval fatigue on routine two-device pulls)', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    const approved = db.approveAuthSpec(APP);
    const bytes = await db.exportUserDb();
    await db.importUserDb(bytes);
    const after = db.getAuthSpec(APP)!;
    expect(after.status).toBe(AUTH_SPEC_STATUS.approved);
    expect(after.approvedAt).toBe(approved.approvedAt);
    await db.close();
  });

  it('a doctored allowed_hosts column is NEVER honored: row demotes and the union is recomputed from the spec', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.approveAuthSpec(APP);
    const bytes = await db.exportUserDb();
    const doctored = await doctorBytes(bytes, (raw) => {
      raw.run(`UPDATE snug_auth_specs SET allowed_hosts = ? WHERE app_id = ?`, [
        JSON.stringify(['accounts.spotify.com', 'api.spotify.com', 'refresh.spotify.example', 'evil.example.com']),
        APP,
      ]);
    });
    await db.importUserDb(doctored);
    const after = db.getAuthSpec(APP)!;
    expect(after.status).toBe(AUTH_SPEC_STATUS.importedUnapproved);
    expect(after.approvedAt).toBeUndefined();
    expect(after.allowedHosts).not.toContain('evil.example.com');
    await db.close();
  });

  it('a changed spec (widened declared hosts INSIDE the spec) demotes to imported_unapproved', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.approveAuthSpec(APP);
    const bytes = await db.exportUserDb();
    const widenedSpec = { ...oauthSpec, declaredApiHosts: ['api.spotify.com', 'evil.example.com'] };
    const doctored = await doctorBytes(bytes, (raw) => {
      raw.run(`UPDATE snug_auth_specs SET spec_json = ?, allowed_hosts = ? WHERE app_id = ?`, [
        JSON.stringify(widenedSpec),
        JSON.stringify(deriveAuthAllowedHosts(authSpecSchema.parse(widenedSpec))),
        APP,
      ]);
    });
    await db.importUserDb(doctored);
    expect(db.getAuthSpec(APP)!.status).toBe(AUTH_SPEC_STATUS.importedUnapproved);
    await db.close();
  });

  it('a NEW imported row (no local counterpart) lands as imported_unapproved', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.approveAuthSpec(APP);
    const bytes = await db.exportUserDb();
    await db.deleteAuthSpec(APP);
    await db.importUserDb(bytes);
    expect(db.getAuthSpec(APP)!.status).toBe(AUTH_SPEC_STATUS.importedUnapproved);
    await db.close();
  });

  it('unknown-keys-only rows are demoted AND preserved (R2 — an older hub must not destroy newer additive data)', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, bearerSpec);
    db.approveAuthSpec(APP);
    const bytes = await db.exportUserDb();
    const futureSpec = { ...bearerSpec, futureField: { from: 'a newer hub' } };
    const doctored = await doctorBytes(bytes, (raw) => {
      raw.run(`UPDATE snug_auth_specs SET spec_json = ? WHERE app_id = ?`, [JSON.stringify(futureSpec), APP]);
    });
    const report = await db.importUserDb(doctored);
    const after = db.getAuthSpec(APP)!;
    expect(after.status).toBe(AUTH_SPEC_STATUS.importedUnapproved);
    expect((after.spec as Record<string, unknown>).futureField).toEqual({ from: 'a newer hub' });
    expect(report.droppedAuthSpecs).toEqual([]);
    // An older hub cannot APPROVE what it cannot validate: strict ingest still guards.
    expect(() => db.approveAuthSpec(APP)).toThrowError(UserDbError);
    await db.close();
  });

  it('structurally unusable rows are dropped + surfaced in the import report', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, bearerSpec);
    const bytes = await db.exportUserDb();
    const doctored = await doctorBytes(bytes, (raw) => {
      raw.run(`UPDATE snug_auth_specs SET spec_json = ? WHERE app_id = ?`, ['{"kind":"api_key"}', APP]);
      raw.run(
        `INSERT INTO snug_auth_specs (app_id, spec_json, status, allowed_hosts, approved_at, created_at, updated_at)
         VALUES ('mangled', 'not json at all', 'approved', '[]', NULL, 't', 't')`,
      );
    });
    const report = await db.importUserDb(doctored);
    expect(db.getAuthSpec(APP)).toBeUndefined();
    expect(db.getAuthSpec('mangled')).toBeUndefined();
    expect(report.droppedAuthSpecs.map((d) => d.appId).sort()).toEqual([APP, 'mangled'].sort());
    await db.close();
  });

  it('sync-restore runs the SAME pass: applyRemote on doctored origin bytes never honors widened hosts', async () => {
    const db = await open(backend);
    db.putAuthSpec(APP, oauthSpec);
    db.approveAuthSpec(APP);
    const doctored = await doctorBytes(await db.exportUserDb(), (raw) => {
      raw.run(`UPDATE snug_auth_specs SET allowed_hosts = ? WHERE app_id = ?`, [
        JSON.stringify(['evil.example.com']),
        APP,
      ]);
    });
    const provider: SyncProvider = {
      info: () => ({ kind: 'dropbox', secretsAllowed: true }),
      pull: () => Promise.resolve({ bytes: doctored, revision: 'r1' }),
      push: () => Promise.resolve({ ok: true, revision: 'r2' }),
    };
    const loop = createSyncLoop({ userDb: db, provider, backend });
    await loop.applyRemote();
    const after = db.getAuthSpec(APP)!;
    expect(after.status).toBe(AUTH_SPEC_STATUS.importedUnapproved);
    expect(after.allowedHosts).not.toContain('evil.example.com');
    await db.close();
  });
});
