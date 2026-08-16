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
//  - FIELD-SET drift (the owner's old api_key/api_secret/passphrase Coinbase rows, and
//    since TASK-20260815 the EC-era api_key/private_key pair): the registry's current
//    shape is STAGED, the diff screen disclosed, and approval routes into the
//    credential half for re-entry — and secrets for DROPPED fields are deleted at
//    re-approval, BEFORE the promotion lands (ADR-0030 §5 — a deliberate inversion of
//    the earlier "old secrets stay in storage" posture; a dead secret has no reader).
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
  authConnectionStateSecretKey,
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
  reapproveFromDiff,
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

const CDP_REQUEST = { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, ed25519_private_key)}}' } };
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

/** A real Ed25519 key so the migrated signing template can actually mint in the probe. */
let ED25519_PRIVATE_KEY_PEM = '';
/** A real EC P-256 key — the LEGACY credential the EC-era drift rows carry (ADR-0030). */
let EC_PRIVATE_KEY_PEM = '';
beforeAll(async () => {
  const toPem = (der: ArrayBuffer): string => {
    const body = Buffer.from(der).toString('base64');
    return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
  };
  // The lib types resolve this overload to a bare CryptoKey — Ed25519 is a keypair
  // algorithm, so the double cast is a types gap, not a runtime one.
  const edPair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  ED25519_PRIVATE_KEY_PEM = toPem(await webcrypto.subtle.exportKey('pkcs8', edPair.privateKey));
  const ecPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  EC_PRIVATE_KEY_PEM = toPem(await webcrypto.subtle.exportKey('pkcs8', ecPair.privateKey));
});

let db: UserDb;

/**
 * Mint a PRE-EXISTING approved row in an old registry shape, then reopen the same file
 * under the production admission gate and install it as THE page user db.
 */
async function installDbWithLegacyRow(
  requirement: Record<string, unknown>,
  opts: { secrets?: Record<string, string>; provenance?: string; slot?: string } = {},
): Promise<UserDb> {
  const slot = opts.slot ?? SLOT;
  resetUserDbForTests();
  resetLibraryForTests();
  const backend = createMemoryBackend();
  const older = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (older.status !== 'ok') throw new Error(`older-hub open failed: ${older.status}`);
  older.userDb.installApp({ appId: APP, displayName: 'Drift App', html: '<p>drift</p>' });
  older.userDb.putDeclaredConnection(APP, slot, requirement, (opts.provenance ?? 'starter') as never);
  older.userDb.approveConnection(APP, slot);
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
        [authConnectionCredentialSecretKey(APP, SLOT, 'ed25519_private_key')]: ED25519_PRIVATE_KEY_PEM,
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
    expect(after.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'ed25519_private_key']);
    // Approval SURVIVES — a host-identical seat refresh forces no re-approval.
    expect(after.status).toBe('approved');
    expect(after.pendingRequirement).toBeUndefined();
    expect(after.allowedHosts).toEqual(before.allowedHosts);
    // No re-crediting: the stored secrets are byte-identical.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe(KEY_NAME);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'ed25519_private_key'))).toBe(
      ED25519_PRIVATE_KEY_PEM,
    );
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
    expect(row.pendingRequirement?.fields?.map((field) => field.key)).toEqual(['api_key', 'ed25519_private_key']);
    expect(row.pendingRequirement?.request).toEqual(CDP_REQUEST);
    expect(row.pendingRequirement?.testRequest).toEqual(CDP_TEST_REQUEST);
    // The disclosure renders: the field change is what the user must see before any
    // re-credential ask (the diff screen names both directions).
    expect(container?.querySelector('[data-testid="reapproval-diff"]')).not.toBeNull();
    expect(container?.textContent).toContain('Ed25519 private key (secret)');
  });

  it('approving the diff routes into the CREDENTIAL HALF (register → credentials), never "done" — dropped-field secrets are DELETED at re-approval (ADR-0030 §5)', async () => {
    await mintOldTripleRow();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    await click(/approve these changes/i);
    await settle();

    // The promoted requirement is the CDP shape…
    const row = db.getConnection(APP, SLOT)!;
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'ed25519_private_key']);
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
    expect(
      container?.querySelector('input[data-field-key="ed25519_private_key"]'),
      're-entry asks for the NEW fields',
    ).not.toBeNull();

    // Secrets for DROPPED fields are deleted — the ADR-0030 §5 posture inversion of
    // the earlier "old secrets stay in storage" pin: a dead secret has no reader and
    // is pure C5 weight. A key that survives BOTH shapes (`api_key`) keeps its value:
    // deletion is keyed on dropped DECLARED keys, never a blanket wipe.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'passphrase'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe('old-hmac-key');
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 AC4 — the EC-era pair (the ES256-era registry shape) re-prompts
// ---------------------------------------------------------------------------

describe('AC4 — an EC-era api_key/private_key row refuses re-admission, stages, re-prompts, and drops the orphan', () => {
  /** The exact shape the ES256-era registry persisted (ADR-0022 §5, superseded). */
  const ecEraShape = (): Record<string, unknown> => ({
    slot: SLOT,
    provider: { name: 'Coinbase' },
    kind: 'api_key',
    fields: [
      { key: 'api_key', label: 'API key name (organizations/…/apiKeys/…)', type: 'text' },
      { key: 'private_key', label: 'EC private key (PEM)', type: 'secret' },
    ],
    request: { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, private_key)}}' } },
    testRequest: CDP_TEST_REQUEST,
    declaredApiHosts: ['api.coinbase.com'],
  });

  const KEY_NAME = 'organizations/test-org/apiKeys/ec-era-key';

  async function mintEcEraRow(): Promise<void> {
    db = await installDbWithLegacyRow(ecEraShape(), {
      secrets: {
        [authConnectionCredentialSecretKey(APP, SLOT, 'api_key')]: KEY_NAME,
        [authConnectionCredentialSecretKey(APP, SLOT, 'private_key')]: EC_PRIVATE_KEY_PEM,
      },
    });
  }

  it('wizard open STAGES the Ed25519 shape — the field-key rename is what makes the row heal at all', async () => {
    await mintEcEraRow();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    const row = db.getConnection(APP, SLOT)!;
    expect(row.requirement.fields?.map((field) => field.key), 'live grant untouched until approval').toEqual([
      'api_key',
      'private_key',
    ]);
    expect(row.status).toBe('approved');
    expect(row.pendingRequirement?.fields?.map((field) => field.key)).toEqual(['api_key', 'ed25519_private_key']);
    expect(row.pendingRequirement?.request).toEqual(CDP_REQUEST);
    expect(container?.querySelector('[data-testid="reapproval-diff"]')).not.toBeNull();
    expect(container?.textContent).toContain('Ed25519 private key (secret)');
  });

  it('approval walks the credential half and DELETES the orphaned EC secret; the key name survives', async () => {
    await mintEcEraRow();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await renderSheet();

    await click(/approve these changes/i);
    await settle();

    const row = db.getConnection(APP, SLOT)!;
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'ed25519_private_key']);
    expect(connectionWizardStepStore.get(), 'never done — no secret backs the new shape yet').toBe('register');

    // The orphaned EC private key is GONE (ADR-0030 §5); `api_key` is declared by both
    // generations, so the non-secret key name survives for the re-paste screen.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'private_key'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe(KEY_NAME);
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
      ['ed25519_private_key', ED25519_PRIVATE_KEY_PEM],
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
    // THE BUDGET AND THE TEST'S OWN TIMEOUT MUST AGREE — P4 correction (2026-08-13).
    // P3 raised this `vi.waitFor` to 10s to cure an intermittent failure, but vitest's
    // per-test timeout here is the 5000ms DEFAULT (playground's vitest.config.ts sets no
    // `testTimeout`). A 10s inner budget inside a 5s outer one is unreachable: the test is
    // killed at 5004ms with vitest's own "Test timed out in 5000ms" while `waitFor` is
    // still patiently waiting, so the raise could never have taken effect. Measured on the
    // committed tree, this file still failed 3 runs in 12 (25%) — the P3 fix addressed a
    // misdiagnosis (a "slow mint"), not the actual mechanism.
    //
    // Both numbers are now explicit and the INNER budget is strictly smaller than the
    // OUTER one, so a real hang is reported by THIS assertion — naming the missing probe
    // outcome — instead of by an anonymous suite-level timeout that says nothing about
    // what failed. Measured cost when it passes: the whole 10-test file runs in ~160ms in
    // isolation and ~500ms under the full suite, so 8s is ~16x headroom over the worst
    // observed pass, and the 15s test timeout leaves room for the wait to report first.
    // If this ever times out, the mint is truly broken or hung — a real failure worth
    // seeing, and now one that arrives with a message.
    await vi.waitFor(
      async () => {
        await settle();
        if (container!.querySelector('[data-testid="connection-test-result"]') === null) {
          throw new Error('probe outcome not rendered yet');
        }
      },
      { timeout: 8_000, interval: 25 },
    );

    expect(container!.textContent).toMatch(/rejected these credentials/i);
    // C1: neither the key name nor the PEM leaks into the DOM through the result line.
    expect(container!.innerHTML).not.toContain('BEGIN PRIVATE KEY');
    // The OUTER budget, stated beside the inner one so the two can never drift apart
    // again. It must EXCEED the `vi.waitFor` above, or the wait is unreachable and this
    // test dies anonymously at the default 5s (the P3 defect corrected here).
  }, 15_000);
});

// ---------------------------------------------------------------------------
// TASK-20260815 AC5 + AC6 — the probe chain is TOTAL, and "connected" is earned
// ---------------------------------------------------------------------------

/** Walk a bare coinbase starter borrow to the done screen with real credentials. */
async function walkCoinbaseToDone(): Promise<void> {
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
  await click(/got my credentials/i);
  for (const [key, value] of [
    ['api_key', 'organizations/test-org/apiKeys/test-key'],
    ['ed25519_private_key', ED25519_PRIVATE_KEY_PEM],
  ] as const) {
    const input = container!.querySelector<HTMLInputElement>(`input[data-field-key="${key}"]`);
    await act(async () => {
      input!.value = value;
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await click(/save my credentials/i);
  expect(connectionWizardStepStore.get()).toBe('done');
}

async function waitForProbeResult(): Promise<void> {
  await vi.waitFor(
    async () => {
      await settle();
      if (container!.querySelector('[data-testid="connection-test-result"]') === null) {
        throw new Error('probe outcome not rendered yet');
      }
    },
    { timeout: 8_000, interval: 25 },
  );
}

describe('AC5 — an unexpected non-typed throw renders an honest line, never a blank result area', () => {
  it('store-level: testConnection is TOTAL — a non-Response fetch return becomes {ok:false} naming err.name only', async () => {
    await walkCoinbaseToDone();
    // A fetch that "succeeds" with something that is not a Response: the executor's
    // downstream property reads throw a NON-TYPED TypeError — the exact class of
    // failure that used to escape as an unhandled rejection and render nothing.
    const outcome = await testConnection(async () => undefined as unknown as Response);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/the test failed unexpectedly \(TypeError\)/);
      // err.name ONLY — never err.message: below the scrub seat a library message is
      // arbitrary text and no scrub candidates exist at this altitude (C5).
      expect(outcome.message).not.toMatch(/undefined|null|property|function/i);
    }
  });

  it('component-level: the failure line RENDERS — the blank-result seat is closed', async () => {
    await walkCoinbaseToDone();
    vi.stubGlobal('fetch', async () => ({}) as unknown as Response);
    await click(/test this connection/i);
    await waitForProbeResult();
    const result = container!.querySelector('[data-testid="connection-test-result"]')!;
    expect(result.getAttribute('data-ok')).toBe('false');
    expect(result.textContent).toMatch(/the test failed unexpectedly/);
    // The raw runtime error text (err.message) never reaches the DOM.
    expect(container!.innerHTML).not.toMatch(/is not a function|cannot read/i);
  }, 15_000);
});

describe('AC6 — the done screen claims "connected" only after a passing probe (probeable ∧ ¬LAN)', () => {
  it('before any probe: SAVED copy, no "is connected" claim; a passing probe flips it', async () => {
    await walkCoinbaseToDone();

    // Saved, not connected: the unverified claim was the second silent path the owner
    // hit — market data (public) renders in-app while the credentialed half is broken.
    expect(container!.textContent).toContain('credentials saved');
    expect(container!.textContent).not.toContain('is connected');

    vi.stubGlobal(
      'fetch',
      async () => new Response('{"accounts":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await click(/test this connection/i);
    await waitForProbeResult();

    expect(container!.querySelector('[data-testid="connection-test-result"]')!.getAttribute('data-ok')).toBe('true');
    expect(container!.textContent, 'a PASSING probe earns the connected claim').toContain('is connected');
  }, 15_000);

  it('a FAILING probe never flips the claim', async () => {
    await walkCoinbaseToDone();
    vi.stubGlobal('fetch', async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    await click(/test this connection/i);
    await waitForProbeResult();
    expect(container!.textContent).toContain('credentials saved');
    expect(container!.textContent).not.toContain('is connected');
  }, 15_000);

  it('a NON-probeable static row keeps the immediate connected copy (the gate is probeable ∧ ¬LAN)', async () => {
    // CoinGecko pins fields but deliberately NO testRequest — the honest-absence case
    // (nothing is invented to probe with). Its done screen keeps today's copy.
    db = await installTestUserDb();
    db.installApp({ appId: APP, displayName: 'Prices', html: '<p>cg</p>' });
    db.putDeclaredConnection(
      APP,
      'coingecko',
      { slot: 'coingecko', provider: { name: 'CoinGecko' }, kind: 'api_key', declaredApiHosts: ['api.coingecko.com'] },
      'starter',
    );
    openConnectionWizard({ appId: APP, slot: 'coingecko', source: 'settings' });
    await renderSheet();
    await click(/approve this connection/i);
    const row = db.getConnection(APP, 'coingecko')!;
    if (row.requirement.testRequest !== undefined) throw new Error('fixture drifted: coingecko now pins a probe');
    // Walk whatever credential half the registry pins for it, then assert the done copy.
    if (connectionWizardStepStore.get() === 'register') await click(/got my credentials/i);
    const inputs = [...container!.querySelectorAll<HTMLInputElement>('input[data-field-key]')];
    for (const input of inputs) {
      await act(async () => {
        input.value = 'cg-demo-key';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await click(/save my credentials/i);
    expect(connectionWizardStepStore.get()).toBe('done');
    expect(container!.textContent).toContain('is connected');
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 AC3 (ADR-0028 rule 3) — SCOPE drift: staged + re-consent, never silent
// ---------------------------------------------------------------------------
//
// RED-FIRST at Gate 3 against a drift migration whose detection gate reads only
// fieldSet/request/testRequest (a scope gain is neither, so today it returns 'none' and
// the owner's scope-less Spotify row never heals) and a reapproveFromDiff that promotes
// the requirement while the OLD scope-less token keeps serving (the plan-review
// blocker: providers do not widen a token on refresh, so re-consent that leaves the
// old mint alive is a lie about what the connection can do).

describe('ADR-0028 rule 3 — scope drift stages, re-approval re-consents, the old token cannot outlive it', () => {
  const SPOTIFY_SLOT = 'spotify';
  const spotifyEntry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
  const SPOTIFY_SCOPES = [...(spotifyEntry.scopes ?? [])];

  /** The pre-ADR-0028 persisted shape: exactly today's registry emission minus scopes. */
  const scopelessShape = (): Record<string, unknown> => {
    const shape = requirementFromRegistryEntry(spotifyEntry, 'Spotify', SPOTIFY_SLOT) as unknown as Record<
      string,
      unknown
    >;
    delete shape['scopes'];
    return shape;
  };

  const ACCESS_KEY = authConnectionCredentialSecretKey(APP, SPOTIFY_SLOT, 'access_token');
  const REFRESH_KEY = authConnectionCredentialSecretKey(APP, SPOTIFY_SLOT, 'refresh_token');
  const CLIENT_KEY = authConnectionCredentialSecretKey(APP, SPOTIFY_SLOT, 'client_id');
  const STATE_KEY = authConnectionStateSecretKey(APP, SPOTIFY_SLOT);

  async function mintScopelessConnectedRow(): Promise<void> {
    db = await installDbWithLegacyRow(scopelessShape(), {
      slot: SPOTIFY_SLOT,
      secrets: {
        [ACCESS_KEY]: 'legacy-access-token-1',
        [REFRESH_KEY]: 'legacy-refresh-token-1',
        [CLIENT_KEY]: 'legacy-client-id',
        [STATE_KEY]: JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }),
      },
    });
  }

  it("store-level: a scope gain is STAGED — never 'none', never a silent repersist — approval and secrets untouched at stage time", async () => {
    await mintScopelessConnectedRow();
    expect(SPOTIFY_SCOPES.length, 'fixture: the registry must pin scopes for this drift to exist').toBeGreaterThan(0);

    const outcome = await migrateConnectionRegistryDrift(APP, SPOTIFY_SLOT);
    expect(outcome).toBe('staged');

    const row = db.getConnection(APP, SPOTIFY_SLOT)!;
    expect(row.status, 'staging is disclosure, not a downgrade').toBe('approved');
    expect(row.requirement.scopes, 'the SERVED requirement is unchanged until the user approves').toBeUndefined();
    expect(row.pendingRequirement?.scopes).toEqual(SPOTIFY_SCOPES);
    // Nothing is invalidated by LOOKING: the user has decided nothing yet.
    expect(db.getSecret(ACCESS_KEY)).toBe('legacy-access-token-1');
    expect(db.getSecret(REFRESH_KEY)).toBe('legacy-refresh-token-1');
    expect(JSON.parse(db.getSecret(STATE_KEY)!).status).toBe('connected');

    expect(await migrateConnectionRegistryDrift(APP, SPOTIFY_SLOT), 'a staged edit is never clobbered').toBe('none');
  });

  it('approving the scope diff routes into the credential half AND invalidates the old mint (tokens gone, state pending, client id kept)', async () => {
    await mintScopelessConnectedRow();
    expect(await migrateConnectionRegistryDrift(APP, SPOTIFY_SLOT)).toBe('staged');

    openConnectionWizard({ appId: APP, slot: SPOTIFY_SLOT, source: 'settings', mode: 'reapprove' });
    const result = await reapproveFromDiff();
    expect(result).toEqual({ ok: true });

    // Routing: a scope change re-walks register → credentials → connect. 'done' would
    // claim a connection whose consent the user has not given.
    expect(connectionWizardStepStore.get()).toBe('register');

    const row = db.getConnection(APP, SPOTIFY_SLOT)!;
    expect(row.status).toBe('approved');
    expect(row.requirement.scopes, 'the promoted requirement carries the pinned scopes').toEqual(SPOTIFY_SCOPES);
    expect(row.pendingRequirement).toBeUndefined();

    // THE BLOCKER RULE: the scope-less mint cannot outlive the approval it predates.
    expect(db.getSecret(ACCESS_KEY), 'access token deleted with the consent it was minted under').toBeUndefined();
    expect(db.getSecret(REFRESH_KEY), 'refresh token cannot silently re-mint the old breadth').toBeUndefined();
    expect(JSON.parse(db.getSecret(STATE_KEY)!).status, 'the row is honestly non-serving').toBe('pending');
    // The client id is a public identifier the credentials screen re-collects; deleting
    // it buys nothing — but the TOKENS are the consent artifacts and must go.
    expect(db.getSecret(CLIENT_KEY)).toBe('legacy-client-id');
  });

  it('ABANDONMENT: approve → close the wizard before signing in → nothing serves the old token, and reopening offers the walk to sign-in', async () => {
    await mintScopelessConnectedRow();
    expect(await migrateConnectionRegistryDrift(APP, SPOTIFY_SLOT)).toBe('staged');
    openConnectionWizard({ appId: APP, slot: SPOTIFY_SLOT, source: 'settings', mode: 'reapprove' });
    await reapproveFromDiff();

    // The user walks away mid re-consent.
    __resetConnectionWizardForTests();

    // The persisted truth stands: no token, non-serving state — the executor's serving
    // path reads exactly these two, so "the old token keeps working" has no substrate.
    expect(db.getSecret(ACCESS_KEY)).toBeUndefined();
    expect(db.getSecret(REFRESH_KEY)).toBeUndefined();
    expect(JSON.parse(db.getSecret(STATE_KEY)!).status).toBe('pending');

    // Reopening is not a dead end: the wizard opens at review, the drift migration has
    // nothing left to say ('none' — requirement already matches the registry), and the
    // step machine's walk from review reaches the connect screen.
    expect(await migrateConnectionRegistryDrift(APP, SPOTIFY_SLOT)).toBe('none');
    expect(openConnectionWizard({ appId: APP, slot: SPOTIFY_SLOT, source: 'settings' })).toBe(true);
    expect(connectionWizardStepStore.get()).toBe('review');
  });

  it("NEGATIVE: seat-only drift (request/testRequest) still repersists silently — the coinbase path is unchanged by the scope rule", async () => {
    db = await installDbWithLegacyRow(seatlessShape(), {
      secrets: {
        [authConnectionCredentialSecretKey(APP, SLOT, 'api_key')]: 'organizations/test-org/apiKeys/test-key',
        [authConnectionCredentialSecretKey(APP, SLOT, 'private_key')]: EC_PRIVATE_KEY_PEM,
      },
    });
    expect(await migrateConnectionRegistryDrift(APP, SLOT)).toBe('repersisted');
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 AC5 (ADR-0029) — the anti-phishing NEGATIVE needs a legacy row
// ---------------------------------------------------------------------------
//
// Admission substitution REPLACES `registration` on every borrow hit, so a near-miss
// console URL under a registry brand cannot be minted through any gated accessor — but
// it CAN arrive in an imported user file (threat-delta R-4's channel), which is exactly
// the row this harness's permissive-then-gated mint models. The byte-match rule must
// hold against that row: one character off the pinned URL, no anchor.

describe('ADR-0029 — a near-miss console URL under the Spotify brand stays copy-only', () => {
  it('one character off the pinned URL renders NO anchor — copy-only, full address visible', async () => {
    const shape = requirementFromRegistryEntry(
      WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!,
      'Spotify',
      'spotify',
    ) as unknown as Record<string, unknown>;
    const NEAR_MISS = 'https://developer.spotify.com/dashboardd';
    (shape['registration'] as Record<string, unknown>)['consoleUrl'] = NEAR_MISS;
    db = await installDbWithLegacyRow(shape, { slot: 'spotify' });

    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();
    // No drift stages here (fields/seats/scopes all match the registry), so the row
    // keeps its near-miss registration — the wizard must simply refuse to link it.
    await click(/approve this connection/i);

    const consoleBox = container?.querySelector('[data-testid="register-console"]');
    expect(consoleBox, 'the register screen must render its console box').not.toBeNull();
    expect(consoleBox!.querySelector('a'), 'a near-miss URL must never become an anchor').toBeNull();
    expect(container?.textContent ?? '').toContain(NEAR_MISS);
    expect(button(/copy/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 Gate-5 review fixes — the scope rule's edges
// ---------------------------------------------------------------------------

describe('Gate-5 — scope drift edges: reorders, both OAuth kinds, invalidation ordering', () => {
  const spotifyEntry2 = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;

  it("a REORDERED-but-equal scope set is NOT drift — no staged diff whose every line reads unchanged, no token loss ('none')", async () => {
    // Consent breadth is a SET (RFC 6749); the diff screen renders set-membership. An
    // order-sensitive digest staged an approval with no visible delta, and approving it
    // destroyed a working connection's tokens (cross-file trace finding).
    const shape = requirementFromRegistryEntry(spotifyEntry2, 'Spotify', 'spotify') as unknown as Record<
      string,
      unknown
    >;
    shape['scopes'] = [...(shape['scopes'] as string[])].reverse();
    db = await installDbWithLegacyRow(shape, { slot: 'spotify' });
    expect(await migrateConnectionRegistryDrift(APP, 'spotify')).toBe('none');
  });

  it('token invalidation lands BEFORE the promotion — a mid-invalidation throw must leave the healing diff intact', async () => {
    // If reapproveConnection landed first and a delete then threw, the row would be
    // permanently promoted with the old tokens alive and the drift migration would
    // find requirement === registry forever ('none') — the unhealable state.
    const shape = requirementFromRegistryEntry(spotifyEntry2, 'Spotify', 'spotify') as unknown as Record<
      string,
      unknown
    >;
    delete shape['scopes'];
    db = await installDbWithLegacyRow(shape, {
      slot: 'spotify',
      secrets: {
        [authConnectionCredentialSecretKey(APP, 'spotify', 'access_token')]: 'legacy-access-token-1',
        [authConnectionStateSecretKey(APP, 'spotify')]: JSON.stringify({ status: 'connected', obtainedAt: 1, expiresIn: 3600 }),
      },
    });
    expect(await migrateConnectionRegistryDrift(APP, 'spotify')).toBe('staged');

    const deleteSpy = vi.spyOn(db, 'deleteSecret');
    const promoteSpy = vi.spyOn(db, 'reapproveConnection');
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings', mode: 'reapprove' });
    expect(await reapproveFromDiff()).toEqual({ ok: true });

    expect(deleteSpy).toHaveBeenCalled();
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    const firstDelete = Math.min(...deleteSpy.mock.invocationCallOrder);
    const promotion = promoteSpy.mock.invocationCallOrder[0]!;
    expect(firstDelete, 'invalidation must precede the promotion').toBeLessThan(promotion);
    deleteSpy.mockRestore();
    promoteSpy.mockRestore();
  });

  it("oauth2_client_creds is covered too — its mint is exactly as consent-bound ('the old mint cannot outlive the consent')", async () => {
    const ccRequirement: Record<string, unknown> = {
      slot: 'nimbus',
      provider: { name: 'Nimbus B2B' },
      kind: 'oauth2_client_creds',
      endpoints: { tokenUrl: 'https://auth.nimbus-b2b.example/oauth/token' },
      fields: [
        { key: 'client_id', label: 'Client ID', type: 'text' },
        { key: 'client_secret', label: 'Client Secret', type: 'secret' },
      ],
      declaredApiHosts: ['api.nimbus-b2b.example'],
      scopes: ['read:reports'],
    };
    const ACCESS = authConnectionCredentialSecretKey(APP, 'nimbus', 'access_token');
    const STATE = authConnectionStateSecretKey(APP, 'nimbus');
    db = await installDbWithLegacyRow(ccRequirement, {
      slot: 'nimbus',
      secrets: {
        [ACCESS]: 'cc-access-token-1',
        [STATE]: JSON.stringify({ status: 'connected', obtainedAt: 1, expiresIn: 3600 }),
      },
    });
    db.stagePendingRequirement(APP, 'nimbus', { ...ccRequirement, scopes: ['read:reports', 'write:reports'] });

    openConnectionWizard({ appId: APP, slot: 'nimbus', source: 'settings', mode: 'reapprove' });
    expect(await reapproveFromDiff()).toEqual({ ok: true });

    expect(db.getSecret(ACCESS), 'the old-scope client-creds token must not outlive the widened claim').toBeUndefined();
    expect(JSON.parse(db.getSecret(STATE)!).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 Gate-5 (ADR-0029) — the byte-match is against the ROW'S OWN FLOW
// ---------------------------------------------------------------------------

describe("ADR-0029 — a pinned URL belonging to a DIFFERENT flow of the same brand stays copy-only", () => {
  it("a bearer_token GitHub row carrying the OAuth option's console renders NO anchor", async () => {
    // Imported-file channel: substitution never re-ran, so the row pairs the PAT flow's
    // registration steps with the OAuth-apps console URL. Still a pinned page — not a
    // phishing hand-off — but a walkthrough whose one-tap link cannot be followed.
    const github = WELL_KNOWN_PROVIDERS_REGISTRY['github']!;
    const shape = requirementFromRegistryEntry(github, 'GitHub', 'github') as unknown as Record<string, unknown>;
    expect((shape['kind'] as string), 'fixture premise: the entry default is the PAT flow').toBe('bearer_token');
    (shape['registration'] as Record<string, unknown>)['consoleUrl'] = 'https://github.com/settings/developers';
    db = await installDbWithLegacyRow(shape, { slot: 'github' });

    openConnectionWizard({ appId: APP, slot: 'github', source: 'settings' });
    await renderSheet();
    await click(/approve this connection/i);

    const consoleBox = container?.querySelector('[data-testid="register-console"]');
    expect(consoleBox).not.toBeNull();
    expect(consoleBox!.querySelector('a'), "another flow's pinned URL must not become this flow's anchor").toBeNull();
    expect(container?.textContent ?? '').toContain('https://github.com/settings/developers');
  });
});
