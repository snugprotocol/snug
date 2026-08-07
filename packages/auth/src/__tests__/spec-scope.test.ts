// AL-04 AC12/B1: `requireApprovedSpecScope` — the typed wall between proposals and
// tokens. Every SpecScope-bearing OAuthService call the wizard makes is built through
// this helper and no other way: it reads the `snug_auth_specs` row, THROWS
// SnugAuthError('spec_not_approved') unless status === 'approved', and returns the
// ROW's frozen host union — never a proposal-derived union (mutation M14). Basis:
// SpecScope.allowedHosts is caller-supplied (oauth-service.ts) and nothing else
// enforces the doc comment "the FROZEN host ceiling from the snug_auth_specs row".
import { describe, expect, it } from 'vitest';
import { deriveAuthAllowedHosts, type AuthSpec, type AuthSpecStatus } from '@snugprotocol/protocol';
import { SnugAuthError } from '../oauth-service.js';
import { requireApprovedSpecScope } from '../spec-scope.js';
import type { NetSpecReader, NetSpecRow } from '../connected-fetch.js';

const spec: AuthSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
  },
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
};

function readerWith(row: NetSpecRow | undefined): NetSpecReader {
  return { getAuthSpec: () => row };
}

async function expectSpecNotApproved(reader: NetSpecReader): Promise<void> {
  const attempt = requireApprovedSpecScope(reader, 'app-1');
  await expect(attempt).rejects.toBeInstanceOf(SnugAuthError);
  await expect(attempt).rejects.toMatchObject({ code: 'spec_not_approved' });
}

describe('AC12 — requireApprovedSpecScope throws unless the row is approved (B1)', () => {
  it('throws spec_not_approved when no row exists', async () => {
    await expectSpecNotApproved(readerWith(undefined));
  });

  for (const status of ['unapproved', 'imported_unapproved'] as AuthSpecStatus[]) {
    it(`throws spec_not_approved on a '${status}' row — credentials stay unreachable`, async () => {
      await expectSpecNotApproved(readerWith({ spec, status, allowedHosts: ['api.spotify.com'] }));
    });
  }

  it('returns the SpecScope for an approved row', async () => {
    const frozen = ['accounts.spotify.com', 'api.spotify.com'];
    const scope = await requireApprovedSpecScope(
      readerWith({ spec, status: 'approved', allowedHosts: frozen }),
      'app-1',
    );
    expect(scope.appId).toBe('app-1');
    expect(scope.spec).toBe(spec);
    expect(scope.allowedHosts).toEqual(frozen);
  });

  it("returns the ROW's frozen union, never a spec-derived union (M14)", async () => {
    // A frozen ceiling narrower than what the spec would derive today: the ROW wins.
    // (Re-deriving from the spec would silently widen the ceiling past what the user
    // approved — the exact poisoned-tokenUrl trap AC12 exists to close.)
    const narrowFrozen = ['api.spotify.com'];
    expect(deriveAuthAllowedHosts(spec)).not.toEqual(narrowFrozen);
    const scope = await requireApprovedSpecScope(
      readerWith({ spec, status: 'approved', allowedHosts: narrowFrozen }),
      'app-1',
    );
    expect(scope.allowedHosts).toEqual(narrowFrozen);
    expect(scope.allowedHosts).not.toEqual(deriveAuthAllowedHosts(spec));
  });

  it('supports async readers (the UserDb-backed reader is awaited)', async () => {
    const reader: NetSpecReader = {
      getAuthSpec: () => Promise.resolve({ spec, status: 'approved' as const, allowedHosts: ['api.spotify.com'] }),
    };
    const scope = await requireApprovedSpecScope(reader, 'app-2');
    expect(scope.appId).toBe('app-2');
  });
});
