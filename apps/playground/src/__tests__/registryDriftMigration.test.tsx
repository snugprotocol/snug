// registryDriftMigration.test.tsx — TASK-20260812-desktop-auth-awareness P3-host,
// P0 amendment 3 (BLOCKER seat-migration-gap; ADR-0022 consequences).
//
// THE GAP: rows are admitted ONCE and the executor reads only the persisted spec, so a
// registry that starts pinning request/testRequest fixes nothing for a row minted under
// the OLD registry — the owner's existing installs would stay broken forever. The wizard
// open (and the AC5 banner CTA, which opens the same wizard) is the migration seam:
//
//  - REGISTRY-SEAT drift (field set UNCHANGED, pinned seats absent from the row): re-run
//    the requirement through registry substitution and RE-PERSIST — no re-crediting
//    (stored secrets stay valid), approval survives (status never leaves `approved`).
//  - FIELD-SET drift (the owner's old api_key/api_secret/passphrase Coinbase rows): the
//    registry's current shape is STAGED, the diff screen disclosed, and approval routes
//    into the credential half for re-entry — old secrets for dropped fields stay in
//    storage untouched (but unused; journaled in the task file).
//
// FIXTURE HONESTY: the old-shape approved rows are minted through a db opened with the
// PERMISSIVE default admission gate — exactly what "an older hub admitted this row under
// the old registry" means — then reopened with the production gate for the test run.
// Current admission REFUSES the old shapes (that is the drift), so no gated accessor can
// mint them; this is the class of row the codebase already acknowledges ("a row written
// by an older hub … no current accessor validated").
//
// C1 — secrets in this file are test values; the assertions pin that migration never
// reads, moves, or deletes a stored secret.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import {
  authConnectionCredentialSecretKey,
  createMemoryBackend,
  openUserDb,
  type ConnectionAdmissionGate,
  type UserDb,
} from '@snugprotocol/db';
import {
  admitConnectionRequirement,
  requirementFromRegistryEntry,
  WELL_KNOWN_PROVIDERS_REGISTRY,
  type AdmissionChannel,
} from '@snugprotocol/auth';

import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import {
  __resetConnectionWizardForTests,
  connectionWizardStepStore,
  migrateConnectionRegistryDrift,
  openConnectionWizard,
  testConnection,
} from '../state/connectionWizard.js';
import { resetLibraryForTests } from '../state/library.js';
import { resetUserDbForTests, setUserDbForTests } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-drift';
const SLOT = 'coinbase';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

/** Byte-for-byte the production gate (same as userdbTestHelper). */
const productionGate: ConnectionAdmissionGate = (requirement, context) =>
  admitConnectionRequirement(requirement, { channel: context.channel as AdmissionChannel });

const entry = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;

const CDP_REQUEST = { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, private_key)}}' } };
const CDP_TEST_REQUEST = { method: 'GET', pathAndQuery: '/api/v3/brokerage/accounts' };

/** The registry's CURRENT full shape — what a fresh admission would persist today. */
const currentShape = (): Record<string, unknown> =>
  requirementFromRegistryEntry(entry, 'Coinbase', SLOT) as unknown as Record<string, unknown>;

/**
 * SEAT drift: the CDP field pair (byte-identical to the registry) but WITHOUT the
 * pinned request/testRequest — a row admitted in the window where the registry named
 * the fields but had no request seats to pin.
 */
const seatlessShape = (): Record<string, unknown> => {
  const shape = currentShape();
  delete shape['request'];
  delete shape['testRequest'];
  return shape;
};

/** FIELD-SET drift: the owner's real old rows — the retail-HMAC triple (inline per AC6). */
const oldTripleShape = (): Record<string, unknown> => ({
  slot: SLOT,
  provider: { name: 'Coinbase' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API key', type: 'secret' },
    { key: 'api_secret', label: 'API secret', type: 'secret' },
    { key: 'passphrase', label: 'Passphrase', type: 'secret' },
  ],
  declaredApiHosts: ['api.coinbase.com'],
});

/** A real P-256 key so the migrated signing template can actually mint in the probe. */
let EC_PRIVATE_KEY_PEM = '';
beforeAll(async () => {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  EC_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
});

let db: UserDb;

/**
 * Mint a PRE-EXISTING approved row in an old registry shape, then reopen the same file
 * under the production admission gate and install it as THE page user db.
 */
async function installDbWithLegacyRow(
  requirement: Record<string, unknown>,
  opts: { secrets?: Record<string, string>; provenance?: string } = {},
): Promise<UserDb> {
  resetUserDbForTests();
  resetLibraryForTests();
  const backend = createMemoryBackend();
  const older = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (older.status !== 'ok') throw new Error(`older-hub open failed: ${older.status}`);
  older.userDb.installApp({ appId: APP, displayName: 'Drift App', html: '<p>drift</p>' });
  older.userDb.putDeclaredConnection(APP, SLOT, requirement, (opts.provenance ?? 'starter') as never);
  older.userDb.approveConnection(APP, SLOT);
  for (const [key, value] of Object.entries(opts.secrets ?? {})) older.userDb.setSecret(key, value);
  await older.userDb.close();

  const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1, admissionGate: productionGate });
  if (reopened.status !== 'ok') throw new Error(`gated reopen failed: ${reopened.status}`);
  setUserDbForTests(reopened.userDb);
  return reopened.userDb;
}

// ---------------------------------------------------------------------------
// Component harness (the wizard OPEN is the production migration seam)
// ---------------------------------------------------------------------------

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderSheet(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ConnectionWizardSheet />);
  });
  await settle();
  await settle();
}

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

async function click(name: RegExp): Promise<void> {
  const target = button(name);
  if (target === undefined) {
    throw new Error(`no button matching ${String(name)} — rendered: ${(container?.textContent ?? '').slice(0, 400)}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  __resetConnectionWizardForTests();
});

afterEach(async () => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  __resetConnectionWizardForTests();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// REGISTRY-SEAT drift — re-persist WITHOUT re-crediting (AC6 sub-test)
// ---------------------------------------------------------------------------

describe('amendment 3 — REGISTRY-SEAT drift: wizard open re-persists the pinned seats', () => {
  const KEY_NAME = 'organizations/test-org/apiKeys/test-key';

  async function mintSeatlessRow(): Promise<void> {
    db = await installDbWithLegacyRow(seatlessShape(), {
      secrets: {
        [authConnectionCredentialSecretKey(APP, SLOT, 'api_key')]: KEY_NAME,
        [authConnectionCredentialSecretKey(APP, SLOT, 'private_key')]: EC_PRIVATE_KEY_PEM,
      },
    });
  }

  it('a PRE-EXISTING approved seatless row gains request + testRequest on wizard open — secrets untouched, approval survives', async () => {
    await mintSeatlessRow();
    const before = db.getConnection(APP, SLOT)!;
    expect(before.requirement.request, 'fixture: the row must start seatless').toBeUndefined();
    expect(before.requirement.testRequest).toBeUndefined();
    expect(before.status).toBe('approved');

    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    const after = db.getConnection(APP, SLOT)!;
    expect(after.requirement.request, 'the pinned signing template must now be PERSISTED').toEqual(CDP_REQUEST);
    expect(after.requirement.testRequest, 'the pinned probe must now be PERSISTED').toEqual(CDP_TEST_REQUEST);
    expect(after.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'private_key']);
    // Approval SURVIVES — a host-identical seat refresh forces no re-approval.
    expect(after.status).toBe('approved');
    expect(after.pendingRequirement).toBeUndefined();
    expect(after.allowedHosts).toEqual(before.allowedHosts);
    // No re-crediting: the stored secrets are byte-identical.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe(KEY_NAME);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'private_key'))).toBe(EC_PRIVATE_KEY_PEM);
  });

  it('the probe path USES the migrated seats — testRequest aims the pinned endpoint and the JWT template signs it', async () => {
    await mintSeatlessRow();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    let seenUrl = '';
    let authHeader: string | undefined;
    const outcome = await testConnection(async (url, init) => {
      seenUrl = url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authHeader = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      return new Response('{"accounts":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    expect(outcome).toMatchObject({ ok: true, status: 200 });
    expect(seenUrl, 'the migrated testRequest is what the probe aims').toBe(
      'https://api.coinbase.com/api/v3/brokerage/accounts',
    );
    // The migrated request template minted a REAL three-segment JWT from the stored key.
    expect(authHeader).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(authHeader, 'never the seatless fallback').not.toContain('{{');
  });

  it('store-level: migrate returns repersisted once, then none (idempotent) — and bumps the requirement version', async () => {
    await mintSeatlessRow();
    const before = db.getConnection(APP, SLOT)!;

    expect(await migrateConnectionRegistryDrift(APP, SLOT)).toBe('repersisted');
    const after = db.getConnection(APP, SLOT)!;
    expect(after.requirement.request).toEqual(CDP_REQUEST);
    expect(after.status).toBe('approved');
    expect(after.requirementVersion).toBeGreaterThan(before.requirementVersion);

    expect(await migrateConnectionRegistryDrift(APP, SLOT), 'a second open finds no drift').toBe('none');
  });
});

// ---------------------------------------------------------------------------
// FIELD-SET drift — staged, disclosed, routed to re-credential
// ---------------------------------------------------------------------------

describe('amendment 3 — FIELD-SET drift: the old Coinbase triple routes to re-credential', () => {
  async function mintOldTripleRow(): Promise<void> {
    db = await installDbWithLegacyRow(oldTripleShape(), {
      secrets: {
        [authConnectionCredentialSecretKey(APP, SLOT, 'api_key')]: 'old-hmac-key',
        [authConnectionCredentialSecretKey(APP, SLOT, 'api_secret')]: 'old-hmac-secret',
        [authConnectionCredentialSecretKey(APP, SLOT, 'passphrase')]: 'old-passphrase',
      },
    });
  }

  it('wizard open STAGES the registry\'s current shape and shows the diff — the live grant is untouched until approval', async () => {
    await mintOldTripleRow();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    const row = db.getConnection(APP, SLOT)!;
    // The live requirement still serves EXACTLY what the user approved…
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'api_secret', 'passphrase']);
    expect(row.status).toBe('approved');
    // …while the registry's CURRENT shape (seats included) waits as the staged edit.
    expect(row.pendingRequirement?.fields?.map((field) => field.key)).toEqual(['api_key', 'private_key']);
    expect(row.pendingRequirement?.request).toEqual(CDP_REQUEST);
    expect(row.pendingRequirement?.testRequest).toEqual(CDP_TEST_REQUEST);
    // The disclosure renders: the field change is what the user must see before any
    // re-credential ask (the diff screen names both directions).
    expect(container?.querySelector('[data-testid="reapproval-diff"]')).not.toBeNull();
    expect(container?.textContent).toContain('EC private key (PEM)');
  });

  it('approving the diff routes into the CREDENTIAL HALF (register → credentials), never "done" — old secrets stay in storage', async () => {
    await mintOldTripleRow();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    await click(/approve these changes/i);
    await settle();

    // The promoted requirement is the CDP shape…
    const row = db.getConnection(APP, SLOT)!;
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'private_key']);
    expect(row.requirement.request).toEqual(CDP_REQUEST);
    expect(row.status).toBe('approved');
    expect(row.pendingRequirement).toBeUndefined();
    // …and the machine walks the credential half: a field-set change means the stored
    // secrets cannot back the new shape, so 'done' would claim a connection no secret
    // backs (the same rule the kind-rebind path already follows). Coinbase pins a
    // registration walkthrough, so the half starts at `register`.
    expect(connectionWizardStepStore.get()).toBe('register');
    await click(/got my credentials/i);
    expect(connectionWizardStepStore.get()).toBe('credentials');
    expect(container?.querySelector('input[data-field-key="private_key"]'), 're-entry asks for the NEW fields').not.toBeNull();

    // Old secrets for dropped fields: untouched in storage, unused by the new template.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'))).toBe('old-hmac-secret');
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'passphrase'))).toBe('old-passphrase');
  });
});

// ---------------------------------------------------------------------------
// Negatives — the migration never fires where it must not
// ---------------------------------------------------------------------------

describe('amendment 3 — negatives', () => {
  it('a row already in the registry\'s current shape: none, no writes', async () => {
    db = await installDbWithLegacyRow(currentShape());
    const before = db.getConnection(APP, SLOT)!;
    expect(await migrateConnectionRegistryDrift(APP, SLOT)).toBe('none');
    const after = db.getConnection(APP, SLOT)!;
    expect(after.requirementVersion).toBe(before.requirementVersion);
    expect(after.pendingRequirement).toBeUndefined();
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('a NON-registry provider row: none — drift is a registry concept', async () => {
    db = await installTestUserDb();
    db.installApp({ appId: APP, displayName: 'Drift App', html: '<p>drift</p>' });
    db.putDeclaredConnection(
      APP,
      'zephyr',
      {
        slot: 'zephyr',
        provider: { name: 'Zephyr Weather' },
        kind: 'bearer_token',
        fields: [{ key: 'token', label: 'API token', type: 'secret' }],
        declaredApiHosts: ['api.zephyr-weather.example'],
      },
      'inference',
    );
    db.approveConnection(APP, 'zephyr');
    expect(await migrateConnectionRegistryDrift(APP, 'zephyr')).toBe('none');
    expect(db.getConnection(APP, 'zephyr')!.pendingRequirement).toBeUndefined();
  });

  it('an app-staged pending edit is NEVER clobbered by migration', async () => {
    db = await installDbWithLegacyRow(seatlessShape());
    // The user's other pending business: the OAuth option, staged before the wizard
    // opened (byte-identical to the pinned option, so admission admits it).
    const oauthShape = requirementFromRegistryEntry(entry, 'Coinbase', SLOT, entry.authOptions![0]!);
    db.stagePendingRequirement(APP, SLOT, oauthShape);

    expect(await migrateConnectionRegistryDrift(APP, SLOT)).toBe('none');
    const row = db.getConnection(APP, SLOT)!;
    expect(row.pendingRequirement?.kind, 'the staged edit the app/user made survives').toBe('oauth2_auth_code');
  });

  it('an unapproved (declared) row: none — migration is for GRANTS, admission owns declarations', async () => {
    resetUserDbForTests();
    resetLibraryForTests();
    const backend = createMemoryBackend();
    const older = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (older.status !== 'ok') throw new Error('open failed');
    older.userDb.putDeclaredConnection(APP, SLOT, seatlessShape(), 'starter' as never);
    await older.userDb.close();
    const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1, admissionGate: productionGate });
    if (reopened.status !== 'ok') throw new Error('reopen failed');
    setUserDbForTests(reopened.userDb);
    db = reopened.userDb;

    expect(await migrateConnectionRegistryDrift(APP, SLOT)).toBe('none');
    expect(db.getConnection(APP, SLOT)!.requirement.request).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Item 2 — the Coinbase probe lights up on the PRODUCTION path
// ---------------------------------------------------------------------------

describe('the done screen probes a coinbase row (the registry now pins testRequest)', () => {
  it('walks the wizard to done, offers "test this connection", and translates a 401 honestly', async () => {
    // Production-gated from the start: a BARE starter borrow — admission substitutes the
    // full current shape, seats included (the registry lane's persistence pin, consumed
    // here by the component surface).
    db = await installTestUserDb();
    db.installApp({ appId: APP, displayName: 'Portfolio', html: '<p>cb</p>' });
    db.putDeclaredConnection(
      APP,
      SLOT,
      { slot: SLOT, provider: { name: 'Coinbase' }, kind: 'api_key', declaredApiHosts: ['api.coinbase.com'] },
      'starter',
    );

    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    await click(/approve this connection/i);
    // The registry pins a registration walkthrough → the register screen renders.
    await click(/got my credentials/i);

    for (const [key, value] of [
      ['api_key', 'organizations/test-org/apiKeys/test-key'],
      ['private_key', EC_PRIVATE_KEY_PEM],
    ] as const) {
      const input = container!.querySelector<HTMLInputElement>(`input[data-field-key="${key}"]`);
      expect(input, `the ${key} box must render`).not.toBeNull();
      await act(async () => {
        input!.value = value;
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await click(/save my credentials/i);
    expect(connectionWizardStepStore.get()).toBe('done');

    const probe = button(/test this connection/i);
    expect(probe, 'the probeable gate lights up for a coinbase row').toBeDefined();

    // The provider rejects the credentials: the DONE SCREEN translation renders — the
    // same vocabulary the wizard has always used, now reachable for a pinned provider.
    vi.stubGlobal('fetch', async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    await click(/test this connection/i);
    // The probe rides the REAL executor (JWT mint via WebCrypto is genuinely async) —
    // wait for the rendered outcome rather than a fixed number of microtasks.
    //
    // The budget is explicit and generous: a real SEC1→PKCS#8 import plus an ES256 sign
    // takes single-digit ms alone, but under the full suite (95 files sharing the box)
    // it intermittently exceeded vi.waitFor's 1000ms default — this test failed roughly
    // 1 run in 3 at suite scale while passing every time in isolation. The condition is
    // unchanged; only the patience is. If this ever times out at 10s, the mint is truly
    // broken (or hung), which is a real failure worth seeing.
    await act(async () => {
      await vi.waitFor(
        () => {
          if (container!.querySelector('[data-testid="connection-test-result"]') === null) {
            throw new Error('probe outcome not rendered yet');
          }
        },
        { timeout: 10_000, interval: 25 },
      );
    });

    expect(container!.textContent).toMatch(/rejected these credentials/i);
    // C1: neither the key name nor the PEM leaks into the DOM through the result line.
    expect(container!.innerHTML).not.toContain('BEGIN PRIVATE KEY');
  });
});
