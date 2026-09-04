// sharedAdmissionWiring.test.ts — TASK-20260904 AC7 (the SHIPPING gate, finding 8).
//
// `packages/db`'s own tests prove `installAppFromBundle` calls the injected gate on the
// `shared` channel; they cannot prove the borrow ban reaches the write, because
// `defaultAdmissionGate` is Guard 1 only and the borrow ban lives in packages/auth. The
// composition root (`state/userdb.ts`) injects `admitConnectionRequirement` — and
// `userdbTestHelper` wires that SAME production gate (its header says so) — so this
// test installs a BORROWING bundle through it and asserts the slot is refused at
// `putDeclaredConnection`, while a bare borrower is admitted WITH the registry's seats.
// Lesson 2026-08-20: a test that builds its own wiring proves nothing about the product's.

import { APP_BUNDLE_FORMAT, appBundleSchema } from '@snugprotocol/protocol';
import { installAppFromBundle } from '@snugprotocol/db';
import { WELL_KNOWN_PROVIDERS_REGISTRY } from '@snugprotocol/auth';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UserDb } from '@snugprotocol/db';

import { installTestUserDb } from './userdbTestHelper.js';

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
});

function bundle(connections: unknown[]) {
  return appBundleSchema.parse({
    format: APP_BUNDLE_FORMAT,
    lineage: '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b',
    sharedAt: '2026-09-04T01:00:00.000Z',
    app: { displayName: 'Borrower', usesDb: false },
    html: '<html>b</html>',
    connections,
  });
}

describe('a shared bundle through the production admission gate', () => {
  it('(N) a borrower that AUTHORS a credential prompt for a registry provider is refused at the write — the app still installs', async () => {
    const result = await installAppFromBundle(
      db,
      bundle([
        {
          slot: 'spotify',
          provider: { name: 'Spotify' },
          kind: 'api_key',
          fields: [{ key: 'password', label: 'Paste your Spotify password', type: 'secret' }],
          declaredApiHosts: ['evil.example'],
        },
      ]),
      { bundleId: 'a'.repeat(64) },
    );
    expect(result.status).toBe('installed');
    expect(result.refusedSlots.map((r) => r.slot)).toEqual(['spotify']);
    expect(result.refusedSlots[0]?.reason).toMatch(/spotify/i);
    expect(db.listConnections(result.appId)).toEqual([]);
    expect(JSON.stringify(db.listConnections(result.appId))).not.toContain('evil.example');
  });

  it('a BARE borrower is admitted with the registry’s pinned hosts substituted — the attacker host never persists', async () => {
    const spotify = WELL_KNOWN_PROVIDERS_REGISTRY['spotify'];
    const result = await installAppFromBundle(
      db,
      bundle([{ slot: 'spotify', provider: { name: 'Spotify' }, kind: spotify?.kind ?? 'oauth2_auth_code', declaredApiHosts: ['evil.example'] }]),
      { bundleId: 'b'.repeat(64) },
    );
    expect(result.refusedSlots).toEqual([]);
    const row = db.getConnection(result.appId, 'spotify');
    expect(row?.provenance).toBe('shared');
    expect(row?.status).toBe('declared');
    expect(row?.requirement.declaredApiHosts).not.toContain('evil.example');
    expect(row?.requirement.declaredApiHosts).toEqual(spotify?.apiHosts);
  });
});
