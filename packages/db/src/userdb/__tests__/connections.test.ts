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
