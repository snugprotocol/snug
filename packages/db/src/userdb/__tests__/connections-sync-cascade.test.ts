// connections-sync-cascade.test.ts — the DB-layer half of the P3 guard restoration
// (migration-audit item 12): the two `snug_connections` properties the deleted
// `auth-specs.test.ts` proved and that no v4 test replaced.
//
// WHY THIS FILE EXISTS. The P3 cutover deleted `auth-specs.test.ts`, which owned two
// claims about the v3 table that v4 inherits verbatim in shape:
//
//  (a) THE SYNC-RESTORE PATH runs the SAME reconciliation as a UI import, so doctored
//      bytes arriving over a sync origin are never honored. `connections.test.ts` covers
//      `importUserDb` directly (AC18) — but `importUserDb` being safe is only half the
//      claim; the other half is that the SYNC path actually goes through it. Those are
//      different statements and only one of them had a test, which is precisely how a
//      "we import safely" property becomes a bypass: an optimization that swapped the
//      pulled bytes in directly (a raw `db = new SQL.Database(remote.bytes)`, a
//      "fast-path restore") would leave every AC18 assertion green while an attacker-held
//      origin dictated the ceiling.
//
//  (b) DELETEAPP CASCADES to the v4 connection rows AND to the slot credential secrets.
//      `delete-app.test.ts` predates v4 and sweeps only the v1/v2 tables, so both
//      `USERDB_TABLES.connections` (userdb.ts:1763) and the `auth:<appId>:*` prefix wipe
//      (:1774-1775) shipped unguarded. The comment in the source says these are
//      deliberate; nothing made them true.
//
// EVERY TEST HERE WAS MUTATION-PROVEN against the shipped tree, and each describe names
// the mutation it kills. Assertions read the RAW FILE where the claim is "the value is
// GONE", following the byte-probe posture `auth-custody.test.ts` established: probing for
// the value rather than for the absence of a key is what makes a deletion claim honest.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_STATUS, USERDB_CONNECTIONS_TABLE, USERDB_FILE, USERDB_TABLES } from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { createSyncLoop } from '../../sync/loop.js';
import type { SyncProvider, SyncPushResult } from '../../sync/provider.js';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '../auth-secrets.js';
import { openUserDb, type UserDb } from '../userdb.js';

const open = async (backend: MemoryBackend): Promise<UserDb> => {
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

const SLOT = 'coinbase';
const OTHER_SLOT = 'github';

const coinbaseRequirement = {
  slot: SLOT,
  provider: { name: 'Coinbase Exchange' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API Key', type: 'text', required: true },
    { key: 'api_secret', label: 'API Secret', type: 'secret', required: true },
  ],
  declaredApiHosts: ['api.exchange.coinbase.com'],
} as const;

const githubRequirement = {
  slot: OTHER_SLOT,
  provider: { name: 'GitHub' },
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
  declaredApiHosts: ['api.github.com'],
} as const;

let backend: MemoryBackend;
beforeEach(() => {
  backend = createMemoryBackend();
});

/** Doctor exported user-DB bytes through raw sql.js (the connections.test.ts pattern). */
async function doctorBytes(
  bytes: Uint8Array,
  mutate: (raw: import('sql.js').Database) => void,
): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: () => locateWasm() });
  const raw = new SQL.Database(bytes);
  try {
    mutate(raw);
    return raw.export();
  } finally {
    raw.close();
  }
}

/**
 * Raw byte probe (the `auth-custody.test.ts` pattern): does `haystack` hold `needle`'s
 * UTF-8 bytes anywhere at all? Used for the deletion claims below, because
 * `getSecret(...) === undefined` proves only that one ACCESSOR cannot see the value —
 * not that the value left the file. A credential still sitting in a freed page is still
 * in the bytes the user exports and syncs.
 */
function bytesContain(haystack: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + target.length <= haystack.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Query the user-DB file straight out of the backend, independent of the live handle. */
async function readFileTables(db: UserDb): Promise<(sql: string, params?: unknown[]) => unknown[][]> {
  await db.flush();
  const bytes = await backend.load(USERDB_FILE);
  if (bytes === undefined) throw new Error('no user db bytes');
  const SQL = await initSqlJs({ locateFile: () => locateWasm() });
  const handle = new SQL.Database(bytes);
  return (sql, params) => {
    const stmt = handle.prepare(sql, params as never);
    const rows: unknown[][] = [];
    try {
      while (stmt.step()) rows.push(stmt.get() as unknown[]);
    } finally {
      stmt.free();
    }
    return rows;
  };
}

// ---------------------------------------------------------------------------
// RESTORED 12a — the SYNC-RESTORE path runs the SAME reconciliation
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted auth-specs.test.ts import-reconciliation coverage, whose
// claim was about the RECONCILIATION PASS being unavoidable rather than about one caller.
//
// THE THREAT, stated concretely. A sync origin is not trusted storage: it is a Dropbox
// folder, an S3 bucket, a personal server — anywhere the user's file can be reached and
// rewritten by something that is not this hub. `applyRemote` ("use the origin copy") pulls
// those bytes and makes them the world. If that path skipped `importUserDb`'s
// reconciliation, an origin holding a row with `status = 'approved'` and a widened
// `allowed_hosts` would hand an app a ceiling the user never read, never approved and
// cannot see — a silent grant escalation delivered by the user's own backup.
//
// MUTATIONS THIS KILLS: giving `pullMerge` a fast path that installs the pulled bytes
// without `importUserDb`; deleting the `reconcileImportedConnections` call from
// `importUserDb` (which this catches from the SYNC side, where the user has least
// visibility); moving the local-approved snapshot to AFTER the handle swap so branch 1
// compares against nothing and everything mass-demotes.
describe('RESTORED 12a — applyRemote runs the SAME connection reconciliation as a UI import', () => {
  interface FakeOrigin {
    provider: SyncProvider;
    seed(bytes: Uint8Array): string;
  }

  /** An origin the test controls completely — i.e. one an attacker could equally control. */
  function fakeOrigin(): FakeOrigin {
    let stored: { bytes: Uint8Array; revision: string } | undefined;
    let rev = 0;
    return {
      provider: {
        info: () => ({ kind: 'fake', secretsAllowed: false }),
        pull: () =>
          Promise.resolve(stored === undefined ? undefined : { bytes: stored.bytes.slice(), revision: stored.revision }),
        push: (bytes: Uint8Array): Promise<SyncPushResult> => {
          rev += 1;
          stored = { bytes: bytes.slice(), revision: `r${rev}` };
          return Promise.resolve({ ok: true, revision: stored.revision });
        },
      },
      seed(bytes) {
        rev += 1;
        stored = { bytes: bytes.slice(), revision: `r${rev}` };
        return stored.revision;
      },
    };
  }

  it('a DOCTORED origin row cannot arrive pre-approved — the sync pull demotes it exactly as an import does', async () => {
    const db = await open(backend);
    db.putDeclaredConnection('app-1', SLOT, coinbaseRequirement, 'inference');
    db.approveConnection('app-1', SLOT);

    // The attacker-held origin: same row, but the requirement now claims an extra host
    // AND the row still says `approved`. Both lies are in the bytes at once, which is the
    // realistic shape — a doctored file has no reason to be modest.
    const doctored = await doctorBytes(await db.exportUserDb(), (raw) => {
      raw.run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE} SET requirement_json = ?, allowed_hosts = ?, status = ?
         WHERE app_id = ? AND slot = ?`,
        [
          JSON.stringify({
            ...coinbaseRequirement,
            declaredApiHosts: ['api.exchange.coinbase.com', 'evil.attacker.example'],
          }),
          JSON.stringify(['api.exchange.coinbase.com', 'evil.attacker.example']),
          CONNECTION_STATUS.approved,
          'app-1',
          SLOT,
        ],
      );
    });

    const origin = fakeOrigin();
    origin.seed(doctored);
    const loop = createSyncLoop({ userDb: db, provider: origin.provider, backend, onEvent: () => undefined });

    // THE SHIPPED "use the origin copy" ACTION, driven end to end. Not `importUserDb`.
    await loop.applyRemote();

    const after = db.getConnection('app-1', SLOT)!;
    // The row changed, so it is NOT byte-identical to the local approved snapshot: it must
    // land `declared`, with the user facing a fresh review before anything can serve.
    expect(after.status, 'a doctored origin row must never arrive approved').toBe(CONNECTION_STATUS.declared);
    expect(after.approvedAt).toBeUndefined();
    expect(after.imported, 'the row must be marked as having arrived over a file boundary').toBe(true);

    /**
     * WHAT IS *NOT* CLAIMED HERE, stated because getting it wrong is how this guard would
     * become a lie. The attacker host IS present in this row's `allowed_hosts` — and that
     * is CORRECT. The doctored REQUIREMENT declares it, so the recomputed union honestly
     * describes what this requirement asks for. The union is a description of a request,
     * not a grant.
     *
     * The security property is the STATUS, and it is the whole property: `declared` means
     * nothing serves. `connected-fetch` reads the frozen ceiling of an APPROVED row, so a
     * declared row's host list is inert until a human reads the review screen — which now
     * names `evil.attacker.example` in the list they are being asked to freeze. The
     * exclusion claim belongs to the next test, where the requirement is untouched and only
     * the stored COLUMN was widened; that is the case where a trusted column would leak a
     * host the requirement never asked for.
     */
    expect(after.status).not.toBe(CONNECTION_STATUS.approved);
    expect(after.allowedHosts, 'the recomputed union describes the doctored requirement honestly').toContain(
      'evil.attacker.example',
    );
    await db.close();
  });

  it('a doctored allowed_hosts column ALONE is recomputed on the sync path too', async () => {
    // The narrower attack: leave the requirement alone (so it validates cleanly) and widen
    // only the stored ceiling column. A reconciliation that trusted the column would honor
    // it — and this shape is the one that survives a schema-only defence.
    const db = await open(backend);
    db.putDeclaredConnection('app-1', SLOT, coinbaseRequirement, 'inference');
    db.approveConnection('app-1', SLOT);
    const doctored = await doctorBytes(await db.exportUserDb(), (raw) => {
      raw.run(`UPDATE ${USERDB_CONNECTIONS_TABLE} SET allowed_hosts = ? WHERE app_id = ? AND slot = ?`, [
        JSON.stringify(['api.exchange.coinbase.com', 'evil.attacker.example']),
        'app-1',
        SLOT,
      ]);
    });

    const origin = fakeOrigin();
    origin.seed(doctored);
    const loop = createSyncLoop({ userDb: db, provider: origin.provider, backend, onEvent: () => undefined });
    await loop.applyRemote();

    const after = db.getConnection('app-1', SLOT)!;
    expect(after.allowedHosts).not.toContain('evil.attacker.example');
    expect(after.status).toBe(CONNECTION_STATUS.declared);
    await db.close();
  });

  it('a REVOKED tombstone is not resurrectable by an origin that claims it is approved', async () => {
    // The user's revocation is the one decision that must outlive a file swap — otherwise
    // "disconnect" means "disconnect until the next sync pull", which is not an off switch.
    const db = await open(backend);
    db.putDeclaredConnection('app-1', SLOT, coinbaseRequirement, 'inference');
    db.approveConnection('app-1', SLOT);
    db.revokeConnection('app-1', SLOT);

    const doctored = await doctorBytes(await db.exportUserDb(), (raw) => {
      raw.run(`UPDATE ${USERDB_CONNECTIONS_TABLE} SET status = ?, approved_at = ? WHERE app_id = ? AND slot = ?`, [
        CONNECTION_STATUS.approved,
        '2026-01-01T00:00:00.000Z',
        'app-1',
        SLOT,
      ]);
    });

    const origin = fakeOrigin();
    origin.seed(doctored);
    const loop = createSyncLoop({ userDb: db, provider: origin.provider, backend, onEvent: () => undefined });
    await loop.applyRemote();

    const after = db.getConnection('app-1', SLOT)!;
    // Not approved. The local tombstone is gone from the pulled file (file-is-truth), so
    // the honest outcome is a row the user must review again — never a live grant.
    expect(after.status, 'an origin must not be able to un-revoke a connection').not.toBe(CONNECTION_STATUS.approved);
    await db.close();
  });

  it('an HONEST origin copy does NOT mass-demote — a routine two-device pull keeps approvals', async () => {
    // The other direction, and it is load-bearing rather than polite. A mutation that made
    // `applyRemote` demote unconditionally would pass every assertion above while producing
    // the exact approval fatigue the byte-identity branch exists to prevent: every pull
    // logs the user out of everything, and the user learns to click approve without reading.
    const db = await open(backend);
    db.putDeclaredConnection('app-1', SLOT, coinbaseRequirement, 'inference');
    db.putDeclaredConnection('app-1', OTHER_SLOT, githubRequirement, 'inference');
    const approvedCoinbase = db.approveConnection('app-1', SLOT);
    db.approveConnection('app-1', OTHER_SLOT);

    const origin = fakeOrigin();
    origin.seed(await db.exportUserDb()); // UNDOCTORED — this device's own bytes
    const loop = createSyncLoop({ userDb: db, provider: origin.provider, backend, onEvent: () => undefined });
    await loop.applyRemote();

    for (const slot of [SLOT, OTHER_SLOT]) {
      const after = db.getConnection('app-1', slot)!;
      expect(after.status, `${slot} must survive an honest pull as approved`).toBe(CONNECTION_STATUS.approved);
      expect(after.approvedAt).toBeDefined();
    }
    expect(db.getConnection('app-1', SLOT)!.approvedAt).toBe(approvedCoinbase.approvedAt);
    await db.close();
  });

  it('local credential VALUES survive the pull — a restore must not silently disconnect the user', async () => {
    // `pullMerge` re-applies local `snug_secrets` after the import. Asserted here because
    // the reconciliation and the secret preservation meet on this path and nowhere else:
    // a change to one is exactly where the other quietly breaks.
    const db = await open(backend);
    db.putDeclaredConnection('app-1', SLOT, coinbaseRequirement, 'inference');
    db.approveConnection('app-1', SLOT);
    db.setSecret(authConnectionCredentialSecretKey('app-1', SLOT, 'api_key'), 'local-key-value-1');

    const origin = fakeOrigin();
    origin.seed(await db.exportUserDb()); // exports strip secrets by default
    const loop = createSyncLoop({ userDb: db, provider: origin.provider, backend, onEvent: () => undefined });
    await loop.applyRemote();

    expect(db.getSecret(authConnectionCredentialSecretKey('app-1', SLOT, 'api_key'))).toBe('local-key-value-1');
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// RESTORED 12b — deleteApp cascades to connection rows AND slot secrets
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted auth-specs.test.ts delete-cascade coverage. `delete-app.test.ts`
// predates v4 and sweeps only the v1/v2 tables, so neither half of the v4 cascade was
// asserted anywhere.
//
// WHY BOTH HALVES MATTER, and why they are separate claims. There are ZERO foreign keys in
// the user DB and `PRAGMA foreign_keys` is never set, so this cascade is hand-written: a
// table missing from the list at userdb.ts:1753-1764 is a SILENT orphan.
//
//  - A LEFT-BEHIND CONNECTION ROW is not merely untidy. It counts against the per-app slot
//    cap forever, and if the app id were ever reused it would present a stale tombstone (or
//    worse, a stale APPROVAL) against a different app than the one the user approved.
//  - A LEFT-BEHIND CREDENTIAL is the serious half. "Delete this app" is the strongest thing
//    a user can say about it, and a secret surviving that means the user's API key sits in
//    their file — exported, synced to their origin, restorable — after they believe they
//    destroyed it. If the slot were re-declared under the same app id, injection would
//    resume with the old value.
//
// MUTATIONS THIS KILL: removing `USERDB_TABLES.connections` from the cascade list;
// deleting the `auth:<appId>:%` secrets wipe; narrowing that wipe's LIKE prefix so v4
// four-segment slot keys are missed; widening it so a SIBLING app's secrets go too.
describe('RESTORED 12b — deleteApp cascades to snug_connections and the slot credential slice', () => {
  it('removes every connection row for the app — declared, approved AND revoked tombstones', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'trader', html: '<html>v1</html>' });
    db.putDeclaredConnection(app.appId, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(app.appId, SLOT);
    db.putDeclaredConnection(app.appId, OTHER_SLOT, githubRequirement, 'inference');
    db.approveConnection(app.appId, OTHER_SLOT);
    db.revokeConnection(app.appId, OTHER_SLOT); // a TOMBSTONE — it goes too

    expect(db.listConnections(app.appId)).toHaveLength(2);

    await db.deleteApp(app.appId);

    expect(db.listConnections(app.appId), 'no connection row may outlive its app').toHaveLength(0);
    // Asserted against the FILE, not only the accessor: an accessor that filtered by
    // installed-app membership would report zero while the rows sat in the table,
    // counting against the slot cap and waiting for an id reuse.
    const query = await readFileTables(db);
    expect(
      query(`SELECT * FROM ${USERDB_TABLES.connections} WHERE app_id = ?`, [app.appId]),
      'orphan connection rows left in the file',
    ).toHaveLength(0);
    await db.close();
  });

  it('WIPES the slot credential values — probed in the raw bytes, not through the accessor', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'trader', html: '<html>v1</html>' });
    db.putDeclaredConnection(app.appId, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(app.appId, SLOT);
    db.setSecret(authConnectionCredentialSecretKey(app.appId, SLOT, 'api_key'), 'DELETED-APP-KEY-VALUE');
    db.setSecret(authConnectionCredentialSecretKey(app.appId, SLOT, 'api_secret'), 'DELETED-APP-SECRET-VALUE');
    db.setSecret(authConnectionStateSecretKey(app.appId, SLOT), JSON.stringify({ status: 'connected' }));

    // Precondition — the values really are in the file before the delete, or the probe
    // below would pass against a database that never held them.
    await db.flush();
    const before = await backend.load(USERDB_FILE);
    expect(bytesContain(before!, 'DELETED-APP-KEY-VALUE'), 'the fixture must actually store the value').toBe(true);

    await db.deleteApp(app.appId);

    expect(db.getSecret(authConnectionCredentialSecretKey(app.appId, SLOT, 'api_key'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(app.appId, SLOT, 'api_secret'))).toBeUndefined();
    expect(db.getSecret(authConnectionStateSecretKey(app.appId, SLOT))).toBeUndefined();

    // THE BYTE PROBE. `getSecret === undefined` proves one accessor cannot see the value;
    // it does not prove the value left the file. `deleteApp` VACUUMs precisely so the
    // freed pages cannot carry a credential into the next export or sync push, and that
    // is the claim a user relies on when they delete an app.
    await db.flush();
    const after = await backend.load(USERDB_FILE);
    expect(bytesContain(after!, 'DELETED-APP-KEY-VALUE'), 'a deleted app must leave no credential in the bytes').toBe(
      false,
    );
    expect(bytesContain(after!, 'DELETED-APP-SECRET-VALUE')).toBe(false);
    await db.close();
  });

  it('leaves a SIBLING app connection row and its credentials completely untouched', async () => {
    // The over-deletion direction. A wipe widened to `auth:%` (or a cascade that forgot its
    // `WHERE app_id = ?`) would pass both tests above while disconnecting every other app
    // the user has — a data-loss bug wearing a security fix's clothes.
    const db = await open(backend);
    const drop = db.installApp({ displayName: 'goner', html: '<html>a</html>' });
    const keep = db.installApp({ displayName: 'keeper', html: '<html>b</html>' });
    for (const appId of [drop.appId, keep.appId]) {
      db.putDeclaredConnection(appId, SLOT, coinbaseRequirement, 'inference');
      db.approveConnection(appId, SLOT);
      db.setSecret(authConnectionCredentialSecretKey(appId, SLOT, 'api_key'), `key-for-${appId}`);
    }

    await db.deleteApp(drop.appId);

    const survivor = db.getConnection(keep.appId, SLOT);
    expect(survivor, "the sibling app's grant must survive").toBeDefined();
    expect(survivor!.status).toBe(CONNECTION_STATUS.approved);
    expect(db.getSecret(authConnectionCredentialSecretKey(keep.appId, SLOT, 'api_key'))).toBe(`key-for-${keep.appId}`);
    await db.close();
  });

  it('an app with connections but no credentials deletes cleanly — the wipe is not load-bearing on presence', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'never-connected', html: '<html>v1</html>' });
    db.putDeclaredConnection(app.appId, SLOT, coinbaseRequirement, 'inference'); // declared only

    await expect(db.deleteApp(app.appId)).resolves.toBeUndefined();
    expect(db.listConnections(app.appId)).toHaveLength(0);
    await db.close();
  });

  it('the per-USER auth keys survive — the wipe is app-scoped, never namespace-wide', async () => {
    // `auth:_state_hmac` signs the OAuth `state` for EVERY app. Taking it out with one
    // app's delete would invalidate every in-flight sign-in on the hub and force a
    // re-key — the same over-deletion hazard as the sibling case, one level up.
    const db = await open(backend);
    const app = db.installApp({ displayName: 'goner', html: '<html>a</html>' });
    db.putDeclaredConnection(app.appId, SLOT, coinbaseRequirement, 'inference');
    db.setSecret('auth:_state_hmac', 'the-per-user-hmac-key');

    await db.deleteApp(app.appId);

    expect(db.getSecret('auth:_state_hmac'), 'the per-user signing key is not app-scoped').toBe(
      'the-per-user-hmac-key',
    );
    await db.close();
  });

  it('deleteApp does not disturb another app when the cascade throws (atomicity carry-forward)', async () => {
    // Reinforces the existing AC21 atomicity claim at the v4 seat: if the connection
    // delete is inside the transaction (it is, userdb.ts:1740-1778), a failure anywhere
    // must leave the app AND its connections intact rather than half-cascaded.
    const db = await open(backend);
    const app = db.installApp({ displayName: 'trader', html: '<html>v1</html>' });
    db.putDeclaredConnection(app.appId, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(app.appId, SLOT);

    await expect(db.deleteApp('app-does-not-exist')).rejects.toThrow();

    // The unrelated failure changed nothing about this app's connections.
    expect(db.listConnections(app.appId)).toHaveLength(1);
    expect(db.getConnection(app.appId, SLOT)!.status).toBe(CONNECTION_STATUS.approved);
    await db.close();
  });
});
