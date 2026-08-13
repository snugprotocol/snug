// registrySeatPersistence.test.ts — TASK-20260812-desktop-auth-awareness P3-registry,
// P0 amendment 1(c): the idempotence claims asserted on the PERSISTED shape, through
// the REAL double-admission path (pipeline pass + the db accessor's admissionGate).
//
// WHY HERE and not packages/auth: the auth suite proves `admitConnectionRequirement`
// is idempotent in isolation; lesson 2026-08-12 says an AC that stops at "admission ok"
// is a tautology whenever a later stage can still refuse or rewrite the value — so the
// binding assertion is on the ROW the production wiring persists. This suite runs the
// production `admissionGate` (userdbTestHelper wires it byte-for-byte), which is the
// SECOND admission pass — the exact pass that refused pass-1 substitutions in the
// shipped P5-blocker this amendment generalizes from.
//
// C1 — requirement shapes only; no credential value appears here.

import { beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { requirementFromRegistryEntry, WELL_KNOWN_PROVIDERS_REGISTRY } from '@snugprotocol/auth';

import { persistConnectionRequirement } from '../agent/connectionPipeline.js';
import { installTestUserDb } from './userdbTestHelper.js';

const CDP_REQUEST = { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, private_key)}}' } };
const CDP_TEST_REQUEST = { method: 'GET', pathAndQuery: '/api/v3/brokerage/accounts' };

/** The bare borrower shape starters actually ship — no prompt seats authored. */
const bareCoinbase = () => ({
  slot: 'coinbase',
  provider: { name: 'Coinbase' },
  kind: 'api_key',
  declaredApiHosts: ['api.coinbase.com'],
});

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
});

describe('amendment 1(c) — the substituted seats survive the PRODUCTION double-admission path', () => {
  it('a bare starter-channel requirement persists WITH request + testRequest (pipeline + db gate)', async () => {
    const outcome = await persistConnectionRequirement(db, {
      appId: 'app-seat-persist',
      requirement: bareCoinbase(),
      channel: 'starter',
    });
    expect(outcome.ok, outcome.ok === false ? `persist refused: ${outcome.reason}` : '').toBe(true);

    // THE PERSISTED SHAPE — the assertion the amendment binds. A green "admission ok"
    // with a seatless row here is exactly the tautology lesson 2026-08-12 warns about.
    const row = db.getConnection('app-seat-persist', 'coinbase');
    expect(row).toBeDefined();
    expect(row!.requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'private_key']);
    expect(row!.requirement.request, 'the pinned signing template must reach the row').toEqual(CDP_REQUEST);
    expect(row!.requirement.testRequest, 'the pinned probe must reach the row').toEqual(CDP_TEST_REQUEST);
    // And no credential was created by any of it (C1 sanity).
    expect(db.listSecretKeys().filter((key) => key.startsWith('auth:app-seat-persist:'))).toEqual([]);
  });

  for (const provenance of ['starter', 'inference'] as const) {
    it(`stagePendingRequirement of the registry-shaped requirement on a '${provenance}'-provenance row is ADMITTED`, () => {
      // The seat-drift migration path (ADR-0022 consequences): an EXISTING approved row
      // gets the registry's full current shape staged against it. The stage accessor
      // admits on the row's stored provenance — a borrowing channel — so the seats ride
      // ONLY through the byte-match exemption (amendment 1b). Without it this throws
      // ConnectionNotAdmitted, and the owner's existing installs stay broken forever.
      const appId = `app-stage-${provenance}`;
      db.putDeclaredConnection(appId, 'coinbase', bareCoinbase(), provenance);
      db.approveConnection(appId, 'coinbase');

      const entry = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
      const shaped = requirementFromRegistryEntry(entry, 'Coinbase', 'coinbase');
      const row = db.stagePendingRequirement(appId, 'coinbase', shaped);

      // Asserted on the PERSISTED pending shape, per the amendment's own wording.
      expect(row.pendingRequirement, 'the staged requirement must persist').toBeDefined();
      expect(row.pendingRequirement?.request).toEqual(CDP_REQUEST);
      expect(row.pendingRequirement?.testRequest).toEqual(CDP_TEST_REQUEST);
      expect(row.pendingRequirement?.fields?.map((field) => field.key)).toEqual(['api_key', 'private_key']);
      // The live grant is untouched while the edit waits (fold B2 — re-pinned here
      // because this test exists to prove the stage path OPENS, not that it widens).
      expect(row.status).toBe('approved');
    });
  }

  it('an authored NEAR-MISS staged against an approved row is still refused (the guard is not disabled)', () => {
    // The mutation-guard for the exemption: byte-match must not degrade into
    // any-template-goes. One byte off the pinned template is an authoring act.
    db.putDeclaredConnection('app-stage-tamper', 'coinbase', bareCoinbase(), 'starter');
    db.approveConnection('app-stage-tamper', 'coinbase');

    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
    const shaped = requirementFromRegistryEntry(entry, 'Coinbase', 'coinbase');
    (shaped.request as { headerTemplate: Record<string, string> }).headerTemplate['Authorization'] =
      'Bearer {{cdp_jwt(api_key, private_key)}} ';

    expect(() => db.stagePendingRequirement('app-stage-tamper', 'coinbase', shaped)).toThrow();
  });
});
