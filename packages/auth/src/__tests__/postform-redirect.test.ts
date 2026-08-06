// AL-03 amendment B2 — the sibling credential path ships the same redirect posture as
// the net path: `oauth-service.postForm` uses redirect:'manual' and a 30x from a
// token/refresh/revoke endpoint is a TYPED error, never followed. Before this fix a
// compromised/misconfigured token endpoint could 302 the credential-bearing POST body
// toward an attacker host and the platform would follow it.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Oauth2AuthCodeSpec } from '@snugprotocol/protocol';
import { UserDbCredentialStore } from '../credential-store.js';
import { OAuthService, SnugAuthError } from '../oauth-service.js';

const APP = 'app-redirect';

const spec: Oauth2AuthCodeSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'RedirectingProvider' },
  endpoints: {
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    refreshUrl: 'https://auth.example.com/token',
  },
  clientCreds: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
  declaredApiHosts: ['api.example.com'],
};

const ALLOWED = ['auth.example.com', 'api.example.com'];

function memoryQuartet(): {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
} {
  const map = new Map<string, string>();
  return {
    getSecret: (key) => map.get(key),
    setSecret: (key, value) => void map.set(key, value),
    deleteSecret: (key) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

describe('B2 — postForm redirect posture', () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }>;
  let store: UserDbCredentialStore;
  let service: OAuthService;

  beforeEach(async () => {
    calls = [];
    const quartet = memoryQuartet();
    store = new UserDbCredentialStore(quartet);
    await store.setCredential(APP, 'client_id', 'client-1');
    await store.setCredential(APP, 'refresh_token', 'refresh-1');
    await store.setCredential(APP, 'access_token', 'stale');
    await store.setConnectionState(APP, { status: 'connected', obtainedAt: 0, expiresIn: 1 });
    service = new OAuthService({
      store,
      redirectUriProvider: { redirectUri: () => 'https://hub.example.com/callback' },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } });
      },
    });
  });

  it('a 302 from the refresh endpoint is a typed error and the Location is NEVER fetched', async () => {
    await expect(service.refresh({ appId: APP, spec, allowedHosts: ALLOWED })).rejects.toMatchObject({
      name: 'SnugAuthError',
      code: 'redirect_blocked',
    });
    expect(calls).toHaveLength(1); // no follow-up request to the redirect target
    expect(calls[0]!.url).toBe('https://auth.example.com/token');
  });

  it('every credential-bearing POST goes out with redirect:manual', async () => {
    await service.refresh({ appId: APP, spec, allowedHosts: ALLOWED }).catch(() => undefined);
    expect(calls[0]!.init?.redirect).toBe('manual');
  });

  it('an opaqueredirect response (browser manual-redirect shape) is equally blocked', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response;
    const svc = new OAuthService({
      store,
      redirectUriProvider: { redirectUri: () => 'https://hub.example.com/callback' },
      fetch: async () => opaque,
    });
    await expect(svc.refresh({ appId: APP, spec, allowedHosts: ALLOWED })).rejects.toMatchObject({ code: 'redirect_blocked' });
  });

  it('redirect_blocked passes through untranslated (not wrapped as refresh_failed)', async () => {
    try {
      await service.refresh({ appId: APP, spec, allowedHosts: ALLOWED });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SnugAuthError);
      expect((err as SnugAuthError).code).toBe('redirect_blocked');
    }
  });
});
