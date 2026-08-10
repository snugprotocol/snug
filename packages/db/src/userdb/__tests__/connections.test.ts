// TASK-20260810-p0-contracts (Dynamic Auth v2, P0) AC10–AC18: the `snug_connections`
// storage accessors — the ONLY writers of the v4 connection surface. These are the
// STORAGE half of the requirement/grant split (parent plan §1/§3): a `declared` row is
// a credential-free REQUIREMENT, an `approved` row is a GRANT carrying the frozen host
// ceiling, and a `revoked` row is a TOMBSTONE that survives so the wizard can show the
// user "you revoked this before".
//
// Written RED-FIRST at Gate 3 against the v4 surface that does not exist yet. Style and
// posture follow the shipped v3 siblings (auth-specs.test.ts for accessor/import shape,
// auth-custody.test.ts for BYTE-PROBES over API asserts): where a claim is "the value is
// GONE", this file probes for the value, never for the absence of a key.
//
// CUTOVER (task file §Cutover rule, fold B1): P0 is ADDITIVE. Nothing here touches the
// v3 `snug_auth_specs` surface — the v3 tests keep shipping green alongside these.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { USERDB_FILE } from '@snugprotocol/protocol';
import {
  AUTH_MAX_SLOTS_PER_APP,
  CONNECTION_STATUS,
  USERDB_CONNECTIONS_TABLE,
  connectionRequirementSchema,
  deriveConnectionAllowedHosts,
} from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import {
  authConnectionCredentialSecretKey,
  authConnectionStateSecretKey,
} from '../auth-secrets.js';
import {
  ConnectionRevokedError,
  ConnectionSlotCapExceeded,
  ConnectionWriteRuleViolation,
  USERDB_ERROR_CODES,
  UserDbError,
  openUserDb,
  type ConnectionAdmissionGate,
  type UserDb,
} from '../userdb.js';

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
const SLOT = 'coinbase';

/**
 * The parent plan's motivating requirement (§Why: "Coinbase needs key + secret +
 * passphrase"). Three fields, a signed header template, a registration walkthrough, and
 * the EXCHANGE host — `api.exchange.coinbase.com`, not the retail `api.coinbase.com`
 * (flagged during the P0 design stage: the wrong host freezes a ceiling that refuses
 * every real request and presents as an auth bug).
 */
const coinbaseRequirement = {
  slot: SLOT,
  provider: { name: 'Coinbase Exchange', docsUrl: 'https://docs.cdp.coinbase.com/exchange' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API Key', type: 'text', required: true },
    { key: 'api_secret', label: 'API Secret', type: 'secret', required: true },
    { key: 'passphrase', label: 'Passphrase', type: 'secret', required: true },
  ],
  registration: {
    consoleUrl: 'https://exchange.coinbase.com/profile/api',
    instructions: ['Open your Coinbase Exchange profile', 'Create an API key', 'Copy the key, secret and passphrase'],
  },
  request: {
    headerTemplate: {
      'CB-ACCESS-KEY': '{{api_key}}',
      'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
      'CB-ACCESS-SIGN': '{{hmac_sha256_b64(api_secret, request.body)}}',
    },
  },
  declaredApiHosts: ['api.exchange.coinbase.com'],
} as const;

/** A second provider in a second slot — R6's "Dropbox + OneDrive in one app" shape. */
const bearerRequirement = {
  slot: 'github',
  provider: { name: 'GitHub' },
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'Personal Access Token', type: 'secret', required: true }],
  declaredApiHosts: ['api.github.com'],
} as const;

/** Real credential-shaped values — never `'x'`. A wipe test that probes for `'x'` proves nothing. */
const REAL_API_KEY = 'ck-live-9f3a7c21b4e05d68a1f2c3b4d5e6f708';
const REAL_API_SECRET = 'AbCdEf0123456789+/aBcDeF9876543210ZmNoPqRsTuVwXyZ01234567==';
const REAL_PASSPHRASE = 'correct-horse-battery-staple-4417';

const requirementWith = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...coinbaseRequirement,
  ...patch,
});

/** Raw byte probe (auth-custody.test.ts pattern): does `haystack` contain `needle`'s UTF-8 bytes? */
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

/** Doctor exported user-DB bytes through raw sql.js (auth-specs.test.ts pattern). */
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

/** Read one raw `snug_connections` row as a column→value record — the column-level truth. */
function rawConnectionRow(db: UserDb, appId: string, slot: string): Record<string, unknown> {
  const row = db.getConnection(appId, slot);
  if (row === undefined) throw new Error(`no connection row for ${appId}/${slot}`);
  return row as unknown as Record<string, unknown>;
}

// -------------------------------------------------- AC10: putDeclaredConnection rules

describe('AC10 — putDeclaredConnection write rules (parent §3: the builder/install channel may only touch `declared`)', () => {
  it('creates a `declared` row and REPLACES cleanly on an existing `declared` row (the legitimate R3 re-infer path)', async () => {
    const db = await open(backend);
    const created = db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    expect(created.status).toBe(CONNECTION_STATUS.declared);
    expect(created.provenance).toBe('inference');
    expect(created.approvedAt).toBeUndefined();
    expect(created.revokedAt).toBeUndefined();

    // A re-inference that changes the requirement replaces the row in place — same PK,
    // no second row (R6 keys on (app_id, slot), so a replace must not fan out).
    const replaced = db.putDeclaredConnection(
      APP,
      SLOT,
      requirementWith({ declaredApiHosts: ['api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com'] }),
      'user_docs',
    );
    expect(replaced.status).toBe(CONNECTION_STATUS.declared);
    expect(replaced.provenance).toBe('user_docs');
    expect(db.listConnections(APP)).toHaveLength(1);
    await db.close();
  });

  it('THROWS a named error on an `approved` row — a changed requirement must go through stagePendingRequirement', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    expect(approved.status).toBe(CONNECTION_STATUS.approved);

    expect(() =>
      db.putDeclaredConnection(APP, SLOT, requirementWith({ declaredApiHosts: ['evil.example.com'] }), 'inference'),
    ).toThrowError(ConnectionWriteRuleViolation);

    // ADR-0016 clause 5 refined: the grant is untouched — status, hosts, approval stamp.
    const after = rawConnectionRow(db, APP, SLOT);
    expect(after.status).toBe(CONNECTION_STATUS.approved);
    expect(after.approvedAt).toBe(approved.approvedAt);
    expect(after.allowedHosts).toEqual(approved.allowedHosts);
    expect(after.allowedHosts).not.toContain('evil.example.com');
    await db.close();
  });

  it('THROWS a named error on a `revoked` row — reconnect is an explicit wizard act that shows the tombstone', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    const revoked = db.revokeConnection(APP, SLOT);
    expect(revoked.status).toBe(CONNECTION_STATUS.revoked);

    expect(() => db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference')).toThrowError(
      ConnectionRevokedError,
    );
    // The tombstone survives the refused write — that is the whole point of keeping the row.
    const after = rawConnectionRow(db, APP, SLOT);
    expect(after.status).toBe(CONNECTION_STATUS.revoked);
    expect(after.revokedAt).toBe(revoked.revokedAt);
    await db.close();
  });

  it('validates the requirement strictly at the write boundary (ingest fail-closed) and writes NOTHING on failure', async () => {
    const db = await open(backend);
    // Typed, code-asserted (v3 sibling posture) — a bare `.toThrowError()` here would be
    // satisfied by any accidental TypeError and prove nothing about the write boundary.
    const codeOf = (call: () => unknown): string | undefined => {
      try {
        call();
        return undefined;
      } catch (err) {
        return err instanceof UserDbError ? err.code : `not-a-UserDbError: ${String(err)}`;
      }
    };
    expect(codeOf(() => db.putDeclaredConnection(APP, SLOT, { kind: 'api_key' }, 'inference'))).toBe(
      USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT,
    );
    expect(
      codeOf(() =>
        db.putDeclaredConnection(APP, SLOT, requirementWith({ futureField: 'from a newer hub' }), 'inference'),
      ),
    ).toBe(USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT);
    // An unknown provenance is equally a write-boundary failure, not a silent coercion.
    expect(codeOf(() => db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'llm_guess' as never))).toBe(
      USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT,
    );
    expect(db.getConnection(APP, SLOT)).toBeUndefined();
    await db.close();
  });
});

// ------------------------------------------------------- AC11: AUTH_MAX_SLOTS_PER_APP

describe('AC11 — AUTH_MAX_SLOTS_PER_APP (fold S-M1: guardAddedBytes caps bytes per write, not ROW COUNT)', () => {
  it('admits exactly N slots and throws a named error on the N+1th', async () => {
    const db = await open(backend);
    expect(AUTH_MAX_SLOTS_PER_APP).toBe(8);

    for (let i = 0; i < AUTH_MAX_SLOTS_PER_APP; i++) {
      const slot = `provider-${i}`;
      db.putDeclaredConnection(APP, slot, requirementWith({ slot }), 'inference');
    }
    expect(db.listConnections(APP)).toHaveLength(AUTH_MAX_SLOTS_PER_APP);

    expect(() =>
      db.putDeclaredConnection(APP, 'one-too-many', requirementWith({ slot: 'one-too-many' }), 'inference'),
    ).toThrowError(ConnectionSlotCapExceeded);
    // Nothing partial landed: the cap is a pre-write gate, not a post-write cleanup.
    expect(db.listConnections(APP)).toHaveLength(AUTH_MAX_SLOTS_PER_APP);
    expect(db.getConnection(APP, 'one-too-many')).toBeUndefined();
    await db.close();
  });

  it('a REPLACE of an existing slot does not count against the cap (the boundary R3 re-infer must survive)', async () => {
    const db = await open(backend);
    for (let i = 0; i < AUTH_MAX_SLOTS_PER_APP; i++) {
      const slot = `provider-${i}`;
      db.putDeclaredConnection(APP, slot, requirementWith({ slot }), 'inference');
    }
    // At the cap, re-inferring an EXISTING slot is legitimate and must not be refused.
    const replaced = db.putDeclaredConnection(
      APP,
      'provider-0',
      requirementWith({ slot: 'provider-0', scopes: ['read'] }),
      'inference',
    );
    expect(replaced.status).toBe(CONNECTION_STATUS.declared);
    expect(db.listConnections(APP)).toHaveLength(AUTH_MAX_SLOTS_PER_APP);
    await db.close();
  });

  it('the cap is PER APP — a second app gets its own full budget', async () => {
    const db = await open(backend);
    for (let i = 0; i < AUTH_MAX_SLOTS_PER_APP; i++) {
      const slot = `provider-${i}`;
      db.putDeclaredConnection(APP, slot, requirementWith({ slot }), 'inference');
    }
    const other = db.putDeclaredConnection('second-app', SLOT, coinbaseRequirement, 'starter');
    expect(other.status).toBe(CONNECTION_STATUS.declared);
    await db.close();
  });

  it('REVOKED tombstones COUNT toward the cap — they are exactly what a flooding attacker leaves behind', async () => {
    const db = await open(backend);
    for (let i = 0; i < AUTH_MAX_SLOTS_PER_APP; i++) {
      const slot = `provider-${i}`;
      db.putDeclaredConnection(APP, slot, requirementWith({ slot }), 'inference');
      db.approveConnection(APP, slot);
      db.revokeConnection(APP, slot);
    }
    // Assert the SETUP landed before asserting the throw. Without this the `toThrowError`
    // below is satisfied by any setup TypeError, so the test would pass vacuously against
    // an unimplemented accessor — a false green that survives the whole feature missing.
    expect(db.listConnections(APP)).toHaveLength(AUTH_MAX_SLOTS_PER_APP);
    expect(db.listConnections(APP).every((row) => row.status === CONNECTION_STATUS.revoked)).toBe(true);

    expect(() =>
      db.putDeclaredConnection(APP, 'after-the-purge', requirementWith({ slot: 'after-the-purge' }), 'inference'),
    ).toThrowError(ConnectionSlotCapExceeded);
    await db.close();
  });
});

// ----------------------------------------------------- AC12: stagePendingRequirement

describe('AC12 — stagePendingRequirement writes ONLY pending_requirement_json (fold B2)', () => {
  it('leaves requirement_json, allowed_hosts, status, approved_at AND the credential slice provably untouched', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), REAL_API_KEY);
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'), REAL_API_SECRET);
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'passphrase'), REAL_PASSPHRASE);

    // The edit pipeline's changed requirement: a WIDER host set. If staging leaked into
    // the live columns this would silently widen the frozen ceiling — the exact failure
    // the pending column exists to prevent.
    const widened = requirementWith({
      declaredApiHosts: ['api.exchange.coinbase.com', 'exfil.example.com'],
    });
    const staged = db.stagePendingRequirement(APP, SLOT, widened);

    // The pending seat holds the new requirement...
    expect(staged.pendingRequirement).toEqual(connectionRequirementSchema.parse(widened));
    // ...and the "needs re-approval" pill is DERIVED, never a fourth status.
    expect(staged.status).toBe(CONNECTION_STATUS.approved);

    // Every live column is byte-for-byte what approval froze.
    expect(staged.requirement).toEqual(approved.requirement);
    expect(staged.allowedHosts).toEqual(approved.allowedHosts);
    expect(staged.allowedHosts).not.toContain('exfil.example.com');
    expect(staged.approvedAt).toBe(approved.approvedAt);
    expect(staged.requirementVersion).toBe(approved.requirementVersion);

    // And the credential slice is untouched — staging is a metadata write, full stop.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe(REAL_API_KEY);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'))).toBe(REAL_API_SECRET);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'passphrase'))).toBe(REAL_PASSPHRASE);
    await db.close();
  });

  it('column-level proof: only `pending_requirement_json` and `updated_at` differ in the raw row', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);

    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const dumpRow = async (): Promise<Record<string, unknown>> => {
      const bytes = await db.exportUserDb();
      const opened = new SQL.Database(bytes);
      try {
        const result = opened.exec(
          `SELECT * FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = '${APP}' AND slot = '${SLOT}'`,
        )[0];
        const columns = result?.columns ?? [];
        const values = result?.values[0] ?? [];
        return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
      } finally {
        opened.close();
      }
    };

    const before = await dumpRow();
    db.stagePendingRequirement(APP, SLOT, requirementWith({ scopes: ['read'] }));
    const after = await dumpRow();

    const changed = Object.keys(before).filter((column) => before[column] !== after[column]);
    expect(changed.sort()).toEqual(['pending_requirement_json', 'updated_at']);
    await db.close();
  });

  it('refuses to stage against a row that is not `approved` (declared rows replace; revoked rows reconnect)', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    expect(() => db.stagePendingRequirement(APP, SLOT, requirementWith({ scopes: ['read'] }))).toThrowError(
      ConnectionWriteRuleViolation,
    );
    await db.close();
  });
});

// ------------------------------------------------------------ AC13: revokeConnection

describe('AC13 — revokeConnection keeps the row, stamps the tombstone, wipes the credential slice', () => {
  it('wipes `auth:<appId>:<slot>:*` — probed by VALUE, not by key absence', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.putDeclaredConnection(APP, 'github', bearerRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    db.approveConnection(APP, 'github');

    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), REAL_API_KEY);
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'), REAL_API_SECRET);
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'passphrase'), REAL_PASSPHRASE);
    db.setSecret(authConnectionStateSecretKey(APP, SLOT), '{"status":"connected"}');
    // The SIBLING slot's credential must survive: the wipe is slot-scoped, not app-scoped.
    const siblingToken = 'ghp_SiblingSlotMustSurvive0000000000000000';
    db.setSecret(authConnectionCredentialSecretKey(APP, 'github', 'token'), siblingToken);

    const revoked = db.revokeConnection(APP, SLOT);

    // 1. The row SURVIVES with a tombstone (closes the revoke-reversal finding).
    expect(revoked.status).toBe(CONNECTION_STATUS.revoked);
    expect(revoked.revokedAt).toBeDefined();
    expect(db.getConnection(APP, SLOT)).toBeDefined();
    // The requirement stays readable so the wizard can render "you revoked this before".
    expect(revoked.requirement).toEqual(connectionRequirementSchema.parse(coinbaseRequirement));

    // 2. The credential slice is GONE — asserted on the real VALUES, then on the file bytes.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'passphrase'))).toBeUndefined();
    expect(db.getSecret(authConnectionStateSecretKey(APP, SLOT))).toBeUndefined();
    expect(db.listSecretKeys().filter((k) => k.startsWith(`auth:${APP}:${SLOT}:`))).toEqual([]);

    // 3. The sibling slot is untouched.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'github', 'token'))).toBe(siblingToken);

    // 4. Byte-probe the full export (opt-in, so snug_secrets travels): no residue.
    const bytes = await db.exportUserDb({ includeSecrets: true });
    expect(bytesContain(bytes, REAL_API_KEY)).toBe(false);
    expect(bytesContain(bytes, REAL_API_SECRET)).toBe(false);
    expect(bytesContain(bytes, REAL_PASSPHRASE)).toBe(false);
    expect(bytesContain(bytes, siblingToken)).toBe(true); // the probe CAN go red (mutation self-check)
    await db.close();
  });
});

// --------------------------------------------------------- AC14: reapproveConnection

describe('AC14 — reapproveConnection promotes pending → current, re-freezes hosts, clears pending', () => {
  it('is the ONLY widening path: pending becomes current, the union is recomputed, approved_at is re-stamped', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const first = db.approveConnection(APP, SLOT);
    expect(first.allowedHosts).toEqual(['api.exchange.coinbase.com']);

    const widened = requirementWith({
      declaredApiHosts: ['api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com'],
    });
    db.stagePendingRequirement(APP, SLOT, widened);
    await new Promise((resolve) => setTimeout(resolve, 5)); // approved_at must MOVE

    const reapproved = db.reapproveConnection(APP, SLOT);
    expect(reapproved.status).toBe(CONNECTION_STATUS.approved);
    expect(reapproved.requirement).toEqual(connectionRequirementSchema.parse(widened));
    expect(reapproved.pendingRequirement).toBeUndefined(); // pending CLEARED
    expect(reapproved.allowedHosts).toEqual(
      deriveConnectionAllowedHosts(connectionRequirementSchema.parse(widened)),
    );
    expect(reapproved.allowedHosts).toContain('ws-feed.exchange.coinbase.com');
    expect(reapproved.approvedAt).not.toBe(first.approvedAt);
    await db.close();
  });

  it('promotion bumps requirement_version (fold T-mn3: a promotion IS a persisted replacement)', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    db.stagePendingRequirement(APP, SLOT, requirementWith({ scopes: ['read'] }));
    const reapproved = db.reapproveConnection(APP, SLOT);
    expect(reapproved.requirementVersion).toBe(approved.requirementVersion + 1);
    await db.close();
  });
});

// ------------------ review MAJOR-2: admission must be ON the persist path, not beside it
//
// AC5's userLayer channel guard lived in `admitConnectionRequirement` (packages/auth) and
// had NO production caller: a repo-wide grep found only its definition and its re-export.
// Meanwhile `putDeclaredConnection` persisted requirements without consulting it at all,
// so an `inference`-provenance requirement carrying an attacker-authored `userLayer` was
// stored, and its endpoint hosts were unioned into the FROZEN host ceiling at approval.
// AC5's own tests passed because they called the guard directly — the property held on
// the function, never on the only path that persists.
//
// DEPENDENCY DIRECTION (reported rather than assumed): `@snugprotocol/auth` ALREADY
// depends on `@snugprotocol/db`, so calling admission from inside packages/db would close
// an import cycle. The enforcement therefore sits at an INJECTED SEAM: packages/db owns
// the "nothing persists unadmitted" rule and calls whatever gate it was opened with,
// while packages/auth — which owns the registry — supplies the gate. The rule is
// fail-closed by construction: `admitConnectionRequirement` is the default, and the seam
// exists so the gate can be swapped, never so it can be omitted.

describe('review MAJOR-2 — the persist path REFUSES a requirement admission rejects', () => {
  /** A userLayer aimed at an attacker's endpoints — AC5's exact motivating shape. */
  const attackerUserLayer = {
    kind: 'oauth2_auth_code',
    provider: { name: 'Coinbase Exchange' },
    endpoints: {
      authorizeUrl: 'https://evil.example/authorize',
      tokenUrl: 'https://evil.example/token',
    },
    pkce: true,
    clientCreds: [
      { key: 'client_id', label: 'Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', type: 'secret' },
    ],
    declaredApiHosts: ['api.exchange.coinbase.com'],
  } as const;

  const codeOf = (call: () => unknown): string | undefined => {
    try {
      call();
      return undefined;
    } catch (err) {
      return err instanceof UserDbError ? err.code : `not-a-UserDbError: ${String(err)}`;
    }
  };

  it('putDeclaredConnection THROWS on an inference-channel userLayer and persists NOTHING (negative)', async () => {
    const db = await open(backend);
    expect(
      codeOf(() =>
        db.putDeclaredConnection(APP, SLOT, requirementWith({ userLayer: attackerUserLayer }), 'inference'),
      ),
    ).toBe(USERDB_ERROR_CODES.CONNECTION_NOT_ADMITTED);
    // The whole point: the row never reaches storage, so no later approval can union
    // evil.example into the frozen ceiling.
    expect(db.getConnection(APP, SLOT)).toBeUndefined();
    await db.close();
  });

  it('stagePendingRequirement THROWS on an inference-channel userLayer too (negative)', async () => {
    // The staging path persists just as durably as the declare path — a pending row is
    // what `reapproveConnection` promotes — so leaving it unadmitted would reopen the
    // hole one accessor over.
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    expect(
      codeOf(() => db.stagePendingRequirement(APP, SLOT, requirementWith({ userLayer: attackerUserLayer }))),
    ).toBe(USERDB_ERROR_CODES.CONNECTION_NOT_ADMITTED);
    expect(db.getConnection(APP, SLOT)?.pendingRequirement).toBeUndefined();
    await db.close();
  });

  it('admits the SAME requirement on the `registry` provenance — the guard is about CHANNEL, not content', async () => {
    // The complement that keeps this a channel guard rather than a userLayer ban: the
    // identical seat is legitimate when the registry synthesized it.
    const db = await open(backend);
    const row = db.putDeclaredConnection(APP, SLOT, requirementWith({ userLayer: attackerUserLayer }), 'registry');
    expect(row.status).toBe(CONNECTION_STATUS.declared);
    await db.close();
  });

  it('persists the SUBSTITUTED requirement on a borrow hit, not the declared one', async () => {
    // Admission does not only reject — on a registry-borrow hit it SUBSTITUTES the
    // registry's pinned hosts. Persisting the pre-substitution value would store
    // evil.example and then freeze it into the ceiling at approval, which is the same
    // harm arriving through the other half of the guard.
    //
    // This exercises the INJECTED gate, because the registry-borrow half is the half
    // packages/db structurally cannot implement (the provider table lives in
    // packages/auth, which already depends on this package). The stand-in below is the
    // same substitution contract the real gate implements; the production wiring lives in
    // apps/playground/src/state/userdb.ts, which depends on both packages.
    const substitutingGate: ConnectionAdmissionGate = (requirement, context) => {
      const record = requirement as Record<string, unknown>;
      const name = (record['provider'] as { name?: string } | undefined)?.name;
      if (context.channel !== 'registry' && name === 'Spotify') {
        return {
          ok: true,
          requirement: {
            ...record,
            declaredApiHosts: ['api.spotify.com'],
            endpoints: {
              authorizeUrl: 'https://accounts.spotify.com/authorize',
              tokenUrl: 'https://accounts.spotify.com/api/token',
            },
          },
          issues: [],
        };
      }
      return { ok: true, requirement, issues: [] };
    };
    const opened = await openUserDb({
      backend,
      locateWasm,
      persistDebounceMs: 1,
      admissionGate: substitutingGate,
    });
    if (opened.status !== 'ok') throw new Error('expected ok open');
    const db = opened.userDb;
    const row = db.putDeclaredConnection(
      APP,
      'spotify',
      {
        slot: 'spotify',
        provider: { name: 'Spotify' },
        kind: 'oauth2_auth_code',
        endpoints: { authorizeUrl: 'https://evil.example/a', tokenUrl: 'https://evil.example/t' },
        pkce: true,
        fields: [
          { key: 'client_id', label: 'Client ID', type: 'text' },
          { key: 'client_secret', label: 'Client Secret', type: 'secret' },
        ],
        declaredApiHosts: ['evil.example'],
      },
      'inference',
    );
    const stored = JSON.stringify(row.requirement);
    expect(stored).not.toMatch(/evil\.example/);
    expect(row.requirement.declaredApiHosts).toEqual(['api.spotify.com']);
    // And the ceiling derived from it inherits the substitution rather than the claim.
    expect(JSON.stringify(row.allowedHosts)).not.toMatch(/evil\.example/);
    await db.close();
  });

  it('is wired by DEFAULT — an ordinary openUserDb call already enforces it', async () => {
    // The finding was precisely that a correct guard sat unreachable. If enforcement
    // depended on the caller remembering to pass a gate, this fix would reproduce the
    // finding at a different seam, so the default is what this pins.
    const fresh = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (fresh.status !== 'ok') throw new Error('expected ok open');
    expect(
      codeOf(() =>
        fresh.userDb.putDeclaredConnection(APP, SLOT, requirementWith({ userLayer: attackerUserLayer }), 'inference'),
      ),
    ).toBe(USERDB_ERROR_CODES.CONNECTION_NOT_ADMITTED);
    await fresh.userDb.close();
  });
});

// ------------------------------- review MINOR: the PK slot and the requirement's slot
//
// `putDeclaredConnection(app, 'realslot', {...slot:'otherslot'...})` used to succeed,
// writing `row.slot='realslot'` beside `row.requirement.slot='otherslot'`. That split is
// not cosmetic: the canonical hash (and therefore `requirement_version`) and the REVIEW
// SCREEN are both computed over the requirement JSON, while the primary key, the
// credential key prefix (`auth:<appId>:<slot>:*`) and the revoke/wipe path all key off
// the COLUMN. So the row the user reviews and the row the runtime serves disagree about
// which slot they are — and a wipe aimed at one leaves the other's secrets in place.

describe('review MINOR — the requirement\'s own `slot` must agree with the slot it is written to', () => {
  const codeOf = (call: () => unknown): string | undefined => {
    try {
      call();
      return undefined;
    } catch (err) {
      return err instanceof UserDbError ? err.code : `not-a-UserDbError: ${String(err)}`;
    }
  };

  it('putDeclaredConnection THROWS a named error on a foreign slot, and writes NOTHING (negative)', async () => {
    const db = await open(backend);
    expect(
      codeOf(() => db.putDeclaredConnection(APP, 'realslot', requirementWith({ slot: 'otherslot' }), 'inference')),
    ).toBe(USERDB_ERROR_CODES.CONNECTION_SLOT_MISMATCH);
    // Fail-closed, like every other write-boundary refusal in this file.
    expect(db.getConnection(APP, 'realslot')).toBeUndefined();
    await db.close();
  });

  it('stagePendingRequirement THROWS on a foreign slot and leaves the grant untouched (negative)', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    expect(codeOf(() => db.stagePendingRequirement(APP, SLOT, requirementWith({ slot: 'otherslot' })))).toBe(
      USERDB_ERROR_CODES.CONNECTION_SLOT_MISMATCH,
    );
    const after = rawConnectionRow(db, APP, SLOT);
    expect(after['pendingRequirement']).toBeUndefined();
    expect(after['allowedHosts']).toEqual(approved.allowedHosts);
    await db.close();
  });

  it('reapproveConnection refuses to promote a PENDING row carrying a foreign slot (negative)', async () => {
    // The pending column is the one seat a foreign slot could still reach after the two
    // guards above: a row written by an older hub, or one that arrived through an import,
    // can hold a pending requirement no current accessor validated. Promotion is where it
    // would become the served grant, so promotion re-checks rather than trusting storage.
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    db.stagePendingRequirement(APP, SLOT, requirementWith({ scopes: ['read'] }));

    await db.close();

    // Doctor the pending column directly (AC17's backend-doctoring pattern) — the two
    // guards above now refuse to CREATE this state, so forging it in storage is the only
    // honest way to reach the promotion guard.
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const raw = new SQL.Database(backend.files.get(USERDB_FILE));
    raw.run(`UPDATE ${USERDB_CONNECTIONS_TABLE} SET pending_requirement_json = ? WHERE app_id = ? AND slot = ?`, [
      JSON.stringify({ ...coinbaseRequirement, slot: 'otherslot' }),
      APP,
      SLOT,
    ]);
    await backend.save(USERDB_FILE, raw.export());
    raw.close();

    const reopened = await open(backend);
    expect(codeOf(() => reopened.reapproveConnection(APP, SLOT))).toBe(
      USERDB_ERROR_CODES.CONNECTION_SLOT_MISMATCH,
    );
    // The grant the user actually approved is still the one being served.
    expect(reopened.getConnection(APP, SLOT)?.allowedHosts).toEqual(approved.allowedHosts);
    await reopened.close();
  });
});

// ------------------------ review MAJOR-3: approveConnection vs. a staged pending edit
//
// The probe: put → approve → stagePendingRequirement(evil.example) → approveConnection
// left `status='approved'` with the pending requirement STILL PRESENT and `allowed_hosts`
// unchanged. Two harms compound. The derived "needs re-approval" pill reads TRUE on a row
// the user just approved, so the UI nags about an edit the user believes they just
// handled; and a later `reapproveConnection` promotes that never-re-reviewed requirement
// on the strength of an approval that was never about it.

describe('review MAJOR-3 — approveConnection must not leave a staged pending edit dangling', () => {
  it('CLEARS the staged pending requirement, so the row it approved is the row it serves', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    db.stagePendingRequirement(APP, SLOT, requirementWith({ declaredApiHosts: ['evil.example'] }));

    const reapproved = db.approveConnection(APP, SLOT);
    expect(reapproved.status).toBe(CONNECTION_STATUS.approved);
    // The staged edit is GONE — not promoted, not retained.
    expect(reapproved.pendingRequirement).toBeUndefined();
    // And it was never allowed to touch the ceiling on the way out.
    expect(reapproved.allowedHosts).toEqual(['api.exchange.coinbase.com']);
    expect(reapproved.allowedHosts).not.toContain('evil.example');
    await db.close();
  });

  it('DISCARDS rather than promotes: the staged requirement never becomes the current one (negative)', async () => {
    // The load-bearing negative. A "fix" that cleared the column by PROMOTING the edit
    // would satisfy the assertion above while silently granting the widening the user
    // never reviewed — the exact outcome MAJOR-3 is about.
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    db.stagePendingRequirement(APP, SLOT, requirementWith({ declaredApiHosts: ['evil.example'] }));

    const reapproved = db.approveConnection(APP, SLOT);
    expect(reapproved.requirement).toEqual(connectionRequirementSchema.parse(coinbaseRequirement));
    expect(JSON.stringify(reapproved.requirement)).not.toMatch(/evil\.example/);
    // A discarded edit is not a persisted replacement, so the version must not move.
    expect(reapproved.requirementVersion).toBe(1);

    // THE ASSERTION THAT ACTUALLY BINDS. `approveConnection` never rewrites
    // `requirement_json`, so the three checks above would all still pass if the accessor
    // derived its ceiling from the PENDING requirement — the row would keep the honest
    // requirement while serving the widened host set, which is the harm wearing a
    // disguise. `allowed_hosts` is the column the runtime enforces, so the discard has to
    // be proven THERE, against the raw persisted value rather than a derived helper.
    const raw = rawConnectionRow(db, APP, SLOT);
    expect(raw['allowedHosts']).toEqual(['api.exchange.coinbase.com']);
    expect(JSON.stringify(raw['allowedHosts'])).not.toMatch(/evil\.example/);
    await db.close();
  });

  it('leaves reapproveConnection as the ONLY path that promotes a staged edit', async () => {
    // The complement: the user who genuinely wants the widening still has a way to get it.
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    const widened = requirementWith({
      declaredApiHosts: ['api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com'],
    });
    db.stagePendingRequirement(APP, SLOT, widened);
    const promoted = db.reapproveConnection(APP, SLOT);
    expect(promoted.allowedHosts).toContain('ws-feed.exchange.coinbase.com');
    expect(promoted.pendingRequirement).toBeUndefined();
    await db.close();
  });
});

// ------------------------------------------------------------ AC15: requirement_version

describe('AC15 — requirement_version bumps ONLY when the canonical hash differs (fold T-mn3)', () => {
  it('an identical re-put is a NO-OP for the version (the deterministic edit-pipeline backstop)', async () => {
    const db = await open(backend);
    const created = db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    expect(created.requirementVersion).toBe(1);

    const identical = db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    expect(identical.requirementVersion).toBe(1);
    await db.close();
  });

  it('KEY ORDER is not a change — the hash is CANONICAL, not JSON.stringify of the caller object', async () => {
    // The edit pipeline re-emits requirements from an LLM; key order is not stable there.
    // A stringify-based hash would bump the version on every rebuild and, worse, would
    // break host-union byte-identity across the import reconciliation (see AC18).
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const reordered = {
      declaredApiHosts: coinbaseRequirement.declaredApiHosts,
      request: coinbaseRequirement.request,
      registration: coinbaseRequirement.registration,
      fields: coinbaseRequirement.fields,
      kind: coinbaseRequirement.kind,
      provider: coinbaseRequirement.provider,
      slot: coinbaseRequirement.slot,
    };
    expect(db.putDeclaredConnection(APP, SLOT, reordered, 'inference').requirementVersion).toBe(1);
    await db.close();
  });

  it('a genuinely changed requirement bumps exactly once per differing replacement', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const changed = db.putDeclaredConnection(APP, SLOT, requirementWith({ scopes: ['read'] }), 'inference');
    expect(changed.requirementVersion).toBe(2);
    const changedAgain = db.putDeclaredConnection(
      APP,
      SLOT,
      requirementWith({ scopes: ['read', 'trade'] }),
      'inference',
    );
    expect(changedAgain.requirementVersion).toBe(3);
    // ...and settling back to an identical body does NOT bump again.
    expect(
      db.putDeclaredConnection(APP, SLOT, requirementWith({ scopes: ['read', 'trade'] }), 'inference')
        .requirementVersion,
    ).toBe(3);
    await db.close();
  });
});

// ------------------------------------------------------- AC16: legacy slice wipe

describe('AC16 — first v4 open wipes the LEGACY non-slot `auth:<appId>:<field>` slice (fold T-M4)', () => {
  it('removes real v3-era credential values while non-auth secrets survive', async () => {
    // The v3 key builder (`auth-secrets.ts:31`) writes `auth:<appId>:<field>` with NO
    // slot. Under v4's slot-keyed shape nothing lists, reads, or wipes those rows — they
    // are REAL credential values orphaned in the file (the AL-03 lingering-values
    // failure). The fixture therefore plants credential-SHAPED values, not placeholders.
    const db = await open(backend);
    db.setSecret(`auth:${APP}:api_key`, REAL_API_KEY);
    db.setSecret(`auth:${APP}:api_secret`, REAL_API_SECRET);
    db.setSecret(`auth:${APP}:_connection`, '{"status":"connected","obtained_at":1754870400000}');
    db.setSecret(`auth:second-app:access_token`, 'ya29.LEGACY-OAUTH-ACCESS-TOKEN-9f3a7c21b4e0');
    // Survivors: the app-agnostic per-user keys and the unrelated BYOK namespace.
    db.setSecret('auth:_state_hmac', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g');
    db.setSecret('auth:_flow:flow-123', '{"slot":"coinbase"}');
    const byokKey = 'sk-ant-api03-BYOK-MUST-SURVIVE-0000000000000000';
    db.setSecret('byok:anthropic', byokKey);
    await db.close();

    // Rewind the persisted file to v3 so the reopen is genuinely the FIRST v4 open.
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const rewound = new SQL.Database(backend.files.get(USERDB_FILE));
    rewound.run(`DROP TABLE IF EXISTS ${USERDB_CONNECTIONS_TABLE}`);
    rewound.run('PRAGMA user_version = 3');
    await backend.save(USERDB_FILE, rewound.export());
    rewound.close();

    const reopened = await open(backend);

    // The legacy slice is GONE — probed by value, then by key.
    expect(reopened.getSecret(`auth:${APP}:api_key`)).toBeUndefined();
    expect(reopened.getSecret(`auth:${APP}:api_secret`)).toBeUndefined();
    expect(reopened.getSecret(`auth:${APP}:_connection`)).toBeUndefined();
    expect(reopened.getSecret('auth:second-app:access_token')).toBeUndefined();

    // Non-auth secrets and the app-agnostic auth keys survive.
    expect(reopened.getSecret('byok:anthropic')).toBe(byokKey);
    expect(reopened.getSecret('auth:_state_hmac')).toBeDefined();
    expect(reopened.getSecret('auth:_flow:flow-123')).toBeDefined();

    // Byte-probe the full export: no orphaned credential values anywhere in the file.
    const bytes = await reopened.exportUserDb({ includeSecrets: true });
    expect(bytesContain(bytes, REAL_API_KEY)).toBe(false);
    expect(bytesContain(bytes, REAL_API_SECRET)).toBe(false);
    expect(bytesContain(bytes, byokKey)).toBe(true); // the probe CAN go red
    await reopened.close();
  });

  it('does NOT wipe the v4 slot-keyed slice — a second open must not eat live credentials', async () => {
    // The wipe rule is keyed on the LEGACY shape (`auth:<appId>:<field>`, no slot). A
    // naive prefix delete over `auth:<appId>:` would also take `auth:<appId>:<slot>:*`,
    // silently disconnecting every connected app on the next hub start.
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), REAL_API_KEY);
    await db.close();

    const reopened = await open(backend);
    expect(reopened.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe(REAL_API_KEY);
    await reopened.close();
  });

  it('is a ONE-TIME migration step: a v3-shaped credential written AT v4 survives every later open', async () => {
    // THE CUTOVER HAZARD, and the reason the wipe is gated on `found < 4` rather than run
    // unconditionally. `packages/auth/src/credential-store.ts` still WRITES non-slot keys
    // (`authCredentialSecretKey`) and keeps shipping through P0 under the additive rule
    // (fold B1) — it is the live v3 path serving connected apps, not dead code. A wipe on
    // every open would therefore delete credentials the v3 path had just written, turning
    // a one-time cleanup into a recurring self-inflicted disconnection that would present
    // as "the hub logs my connected apps out every time I restart it".
    //
    // Mutation-evidenced: dropping the `migration.found < USERDB_SCHEMA_VERSION` gate
    // leaves every other test in this file green, so this is the only thing standing
    // between that gate and a silent removal.
    const db = await open(backend); // fresh file — created AT v4, so no wipe ever runs
    const v3Token = 'ya29.V3-PATH-WROTE-THIS-AT-V4-4417';
    db.setSecret(`auth:${APP}:access_token`, v3Token);
    await db.close();

    const second = await open(backend);
    expect(second.getSecret(`auth:${APP}:access_token`)).toBe(v3Token);
    await second.close();

    // Still there on the third open — the gate is not merely "skip the very next open".
    const third = await open(backend);
    expect(third.getSecret(`auth:${APP}:access_token`)).toBe(v3Token);
    await third.close();
  });
});

// --------------------------------------------------------- AC17: self-healing guard

describe('AC17 — DDL-replay self-healing guard (Q9: `migrate()` stamps user_version UNCONDITIONALLY)', () => {
  it('a DB stamped v4 with `snug_connections` DROPPED gets the table back on open, other rows untouched', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Trader', html: '<html>v1</html>' });
    db.putAppDoc(app.appId, 'vision', { title: 'Vision', content: 'trade responsibly' });
    db.upsertThread('t1', { appId: app.appId, title: 'Connect Coinbase' });
    db.appendChatMessage('t1', 'user', 'connect coinbase please');
    db.setSetting('theme', 'dark');
    await db.close();

    // The failure Q9 exists to catch: `PRAGMA user_version` says v4, so `migrate()`'s
    // forward-only loop runs NOTHING, yet the table is absent. Without the guard the
    // first accessor call fails with a raw SQLite "no such table".
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const raw = new SQL.Database(backend.files.get(USERDB_FILE));
    raw.run(`DROP TABLE ${USERDB_CONNECTIONS_TABLE}`);
    expect(raw.exec('PRAGMA user_version')[0]?.values).toEqual([[4]]); // the version LIED
    await backend.save(USERDB_FILE, raw.export());
    raw.close();

    const healed = await open(backend);
    // 1. The table is back and usable.
    expect(healed.listConnections(app.appId)).toEqual([]);
    const restored = healed.putDeclaredConnection(app.appId, SLOT, coinbaseRequirement, 'inference');
    expect(restored.status).toBe(CONNECTION_STATUS.declared);
    // 2. Every OTHER table is untouched — the heal is a targeted CREATE, not a re-seed.
    expect(healed.listApps()).toHaveLength(1);
    expect(healed.getAppHtml(app.appId)).toBe('<html>v1</html>');
    expect(healed.getAppDoc(app.appId, 'vision')?.content).toBe('trade responsibly');
    expect(healed.listChatMessages('t1')).toHaveLength(1);
    expect(healed.getSetting('theme')).toBe('dark');
    await healed.close();
  });
});

// ------------------------------------------------ AC18: importUserDb reconciliation

describe('AC18 — importUserDb reconciliation against snug_connections (fold T-M5)', () => {
  it('byte-identical re-import KEEPS the approval (no approval fatigue on routine two-device pulls)', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    const bytes = await db.exportUserDb();

    await db.importUserDb(bytes);

    const after = db.getConnection(APP, SLOT)!;
    expect(after.status).toBe(CONNECTION_STATUS.approved);
    expect(after.approvedAt).toBe(approved.approvedAt);
    expect(after.allowedHosts).toEqual(approved.allowedHosts);
    await db.close();
  });

  it('a doctored requirement DEMOTES to `declared` with imported = 1 and the union recomputed from the requirement', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    const doctored = await doctorBytes(await db.exportUserDb(), (raw) => {
      raw.run(`UPDATE ${USERDB_CONNECTIONS_TABLE} SET requirement_json = ? WHERE app_id = ? AND slot = ?`, [
        JSON.stringify(requirementWith({ declaredApiHosts: ['api.exchange.coinbase.com', 'evil.example.com'] })),
        APP,
        SLOT,
      ]);
    });

    await db.importUserDb(doctored);

    const after = db.getConnection(APP, SLOT)!;
    expect(after.status).toBe(CONNECTION_STATUS.declared);
    expect(after.approvedAt).toBeUndefined();
    expect(after.imported).toBe(true);
    await db.close();
  });

  it('a doctored allowed_hosts column is NEVER honored — the union is recomputed, never trusted', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    const doctored = await doctorBytes(await db.exportUserDb(), (raw) => {
      raw.run(`UPDATE ${USERDB_CONNECTIONS_TABLE} SET allowed_hosts = ? WHERE app_id = ? AND slot = ?`, [
        JSON.stringify(['api.exchange.coinbase.com', 'evil.example.com']),
        APP,
        SLOT,
      ]);
    });

    await db.importUserDb(doctored);

    const after = db.getConnection(APP, SLOT)!;
    expect(after.status).toBe(CONNECTION_STATUS.declared);
    expect(after.allowedHosts).not.toContain('evil.example.com');
    await db.close();
  });

  /**
   * THE TRAP THE PLAN DOES NOT NAME (task file §Session journal, cutover trap 1).
   *
   * `reconcileImportedAuthSpecs` branch 2 (`userdb.ts:464`) recomputes `allowed_hosts`
   * from the spec rather than trusting the imported column — a good security property
   * that makes HOST-UNION OUTPUT STABILITY load-bearing. Branch 1's byte-identity test
   * compares the STORED `allowed_hosts` JSON against the local approved row's. If v4's
   * derivation emits different bytes for an otherwise-unchanged connection (different
   * sort, different normalization, `[]` vs `["a"]` spacing), EVERY approved row misses
   * branch 1 and falls into branch 2 — mass-demoting the user's whole approval set on
   * the first sync pull after cutover. That reads to the user as "the update logged me
   * out of everything", and it is exactly the approval fatigue the branch exists to
   * prevent.
   */
  it('HOST-UNION STABILITY: an unchanged connection derives byte-identical allowed_hosts across the cutover', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.putDeclaredConnection(APP, 'github', bearerRequirement, 'inference');
    const approvedCoinbase = db.approveConnection(APP, SLOT);
    const approvedGithub = db.approveConnection(APP, 'github');

    // The bytes the column holds must equal the bytes a fresh derivation produces —
    // that equality IS branch 1's identity test, asserted directly rather than inferred.
    const parsed = connectionRequirementSchema.parse(coinbaseRequirement);
    expect(JSON.stringify(approvedCoinbase.allowedHosts)).toBe(
      JSON.stringify(deriveConnectionAllowedHosts(parsed)),
    );
    expect(JSON.stringify(approvedGithub.allowedHosts)).toBe(
      JSON.stringify(deriveConnectionAllowedHosts(connectionRequirementSchema.parse(bearerRequirement))),
    );

    // And the round trip proves it end-to-end: a full export/import of UNCHANGED rows
    // must not demote a single approval.
    const bytes = await db.exportUserDb();
    await db.importUserDb(bytes);
    for (const slot of [SLOT, 'github']) {
      const after = db.getConnection(APP, slot)!;
      expect(after.status).toBe(CONNECTION_STATUS.approved);
      expect(after.approvedAt).toBeDefined();
    }
    await db.close();
  });

  it('a REVOKED tombstone survives import and never silently returns as approved', async () => {
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    db.approveConnection(APP, SLOT);
    const revoked = db.revokeConnection(APP, SLOT);
    const bytes = await db.exportUserDb();

    await db.importUserDb(bytes);

    const after = db.getConnection(APP, SLOT)!;
    expect(after.status).toBe(CONNECTION_STATUS.revoked);
    expect(after.revokedAt).toBe(revoked.revokedAt);
    expect(after.approvedAt).toBeUndefined();
    await db.close();
  });

  it('a pending requirement never survives an import as if it were approved', async () => {
    // Skew-window safety (fold S-m2): the executor binds to the APPROVED requirement.
    // An import must not let a doctored file promote pending content into that seat.
    const db = await open(backend);
    db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'inference');
    const approved = db.approveConnection(APP, SLOT);
    db.stagePendingRequirement(APP, SLOT, requirementWith({ declaredApiHosts: ['evil.example.com'] }));
    const bytes = await db.exportUserDb();

    await db.importUserDb(bytes);

    const after = db.getConnection(APP, SLOT)!;
    expect(after.requirement).toEqual(approved.requirement);
    expect(after.allowedHosts).not.toContain('evil.example.com');
    await db.close();
  });
});
