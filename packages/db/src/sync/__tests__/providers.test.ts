// Child-4 AC1 (TASK-20260803-sync-origins): the SyncProvider contract, exercised
// against BOTH shipped providers (hub origin, Dropbox) through injected fetch fakes —
// no real network. Each fake models its real server's revision semantics (etag +
// if-match for the hub, rev + update-mode for Dropbox) so the contract tests prove
// conflict detection end to end, not just happy paths.
import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_ERROR_CODES,
  SyncProviderError,
  type SyncProvider,
} from '../provider.js';
import { createHubOriginProvider } from '../hub-origin.js';
import {
  buildDropboxAuthUrl,
  createDropboxProvider,
  DROPBOX_DEFAULT_PATH,
  exchangeDropboxCode,
} from '../dropbox.js';

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

interface FakeOrigin {
  provider: SyncProvider;
  /** Sets origin content directly (simulating another device); returns the new revision. */
  seed(bytes: Uint8Array): string;
  revision(): string | undefined;
  bytes(): Uint8Array | undefined;
  requests: RecordedRequest[];
}

// .slice() pins the type to Uint8Array<ArrayBuffer> — Response bodies reject shared views
const payload = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text).slice();

const headersOf = (init: RequestInit): Record<string, string> =>
  (init.headers ?? {}) as Record<string, string>;

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ------------------------------------------------------------------ hub origin fake

function fakeHubOrigin(csrfToken?: string): FakeOrigin {
  let stored: Uint8Array | undefined;
  let rev = 0;
  const revision = (): string | undefined => (stored === undefined ? undefined : `"r${rev}"`);
  const requests: RecordedRequest[] = [];

  const fetchFake = (url: string, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url, init });
    if (!url.endsWith('/userdb')) return Promise.resolve(new Response(null, { status: 404 }));
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      if (stored === undefined) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(stored.slice(), { status: 200, headers: { etag: revision() as string } }));
    }
    if (method === 'PUT') {
      const headers = headersOf(init);
      const conflict = (): Response =>
        new Response(null, { status: 412, headers: revision() !== undefined ? { etag: revision() as string } : {} });
      if (headers['if-none-match'] === '*' && stored !== undefined) return Promise.resolve(conflict());
      if (headers['if-match'] !== undefined && headers['if-match'] !== revision()) return Promise.resolve(conflict());
      stored = new Uint8Array(init.body as Uint8Array);
      rev += 1;
      return Promise.resolve(new Response(null, { status: 204, headers: { etag: revision() as string } }));
    }
    return Promise.resolve(new Response(null, { status: 405 }));
  };

  return {
    provider: createHubOriginProvider({
      baseUrl: 'https://hub.test/api',
      fetch: fetchFake,
      ...(csrfToken !== undefined ? { csrfToken } : {}),
    }),
    seed(next) {
      stored = next.slice();
      rev += 1;
      return revision() as string;
    },
    revision,
    bytes: () => stored,
    requests,
  };
}

// --------------------------------------------------------------------- dropbox fake

const DROPBOX_TOKEN = 'tok-dropbox-1';

function fakeDropboxOrigin(): FakeOrigin {
  let stored: Uint8Array | undefined;
  let rev = 0;
  const revision = (): string | undefined => (stored === undefined ? undefined : `rev-${rev}`);
  const requests: RecordedRequest[] = [];

  const notFound = (): Response =>
    json({ error_summary: 'path/not_found/..', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409);
  const conflict = (): Response =>
    json({ error_summary: 'path/conflict/file/..', error: { '.tag': 'path', reason: { '.tag': 'conflict' } } }, 409);

  const fetchFake = (url: string, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url, init });
    const headers = headersOf(init);
    if (headers.authorization !== `Bearer ${DROPBOX_TOKEN}`) {
      return Promise.resolve(json({ error_summary: 'invalid_access_token/' }, 401));
    }
    if (url === 'https://content.dropboxapi.com/2/files/download') {
      if (stored === undefined) return Promise.resolve(notFound());
      return Promise.resolve(
        new Response(stored.slice(), {
          status: 200,
          headers: { 'dropbox-api-result': JSON.stringify({ rev: revision(), size: stored.byteLength }) },
        }),
      );
    }
    if (url === 'https://content.dropboxapi.com/2/files/upload') {
      const arg = JSON.parse(headers['dropbox-api-arg'] ?? '{}') as {
        mode?: string | { '.tag': string; update?: string };
      };
      const mode = arg.mode;
      if (mode === 'add' && stored !== undefined) return Promise.resolve(conflict());
      if (typeof mode === 'object' && mode['.tag'] === 'update' && mode.update !== revision()) {
        return Promise.resolve(conflict());
      }
      stored = new Uint8Array(init.body as Uint8Array);
      rev += 1;
      return Promise.resolve(json({ rev: revision() }, 200));
    }
    if (url === 'https://api.dropboxapi.com/2/files/get_metadata') {
      if (stored === undefined) return Promise.resolve(notFound());
      return Promise.resolve(json({ '.tag': 'file', rev: revision() }, 200));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  return {
    provider: createDropboxProvider({ getToken: () => DROPBOX_TOKEN, fetch: fetchFake }),
    seed(next) {
      stored = next.slice();
      rev += 1;
      return revision() as string;
    },
    revision,
    bytes: () => stored,
    requests,
  };
}

// ------------------------------------------------------------- shared contract suite

const cases = [
  { name: 'hub', make: (): FakeOrigin => fakeHubOrigin(), info: { kind: 'hub', secretsAllowed: false } },
  { name: 'dropbox', make: (): FakeOrigin => fakeDropboxOrigin(), info: { kind: 'dropbox', secretsAllowed: true } },
] as const;

describe.each(cases)('SyncProvider contract: $name (AC1)', ({ make, info }) => {
  it('reports its origin kind and secrets posture', () => {
    expect(make().provider.info()).toEqual(info);
  });

  it('pull() resolves undefined for an empty origin', async () => {
    expect(await make().provider.pull()).toBeUndefined();
  });

  it('first push (no baseRevision) provisions the origin; pull round-trips bytes and revision', async () => {
    const origin = make();
    const bytes = payload('image-1');
    const pushed = await origin.provider.push(bytes, undefined);
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    const pulled = await origin.provider.pull();
    expect(pulled).toBeDefined();
    expect(pulled?.revision).toBe(pushed.revision);
    expect(Array.from(pulled?.bytes ?? [])).toEqual(Array.from(bytes));
  });

  it('push with the current baseRevision advances the revision', async () => {
    const origin = make();
    const first = await origin.provider.push(payload('image-1'), undefined);
    if (!first.ok) throw new Error('first push failed');
    const second = await origin.provider.push(payload('image-2'), first.revision);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.revision).not.toBe(first.revision);
  });

  it('push with a stale baseRevision reports a conflict with the remote revision and never overwrites', async () => {
    const origin = make();
    const first = await origin.provider.push(payload('image-1'), undefined);
    if (!first.ok) throw new Error('first push failed');
    const second = await origin.provider.push(payload('image-2'), first.revision);
    if (!second.ok) throw new Error('second push failed');
    const stale = await origin.provider.push(payload('intruder'), first.revision);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.conflict).toBe(true);
    expect(stale.remoteRevision).toBe(second.revision);
    expect(new TextDecoder().decode(origin.bytes())).toBe('image-2');
  });

  it('push to an empty origin with no baseRevision but a pre-seeded origin conflicts (never clobbers)', async () => {
    const origin = make();
    const seededRevision = origin.seed(payload('seeded-elsewhere'));
    const result = await origin.provider.push(payload('local'), undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.remoteRevision).toBe(seededRevision);
    expect(new TextDecoder().decode(origin.bytes())).toBe('seeded-elsewhere');
  });
});

// ------------------------------------------------------------------- hub specifics

describe('hub origin provider specifics', () => {
  it('PUTs octet-stream with credentials, if-none-match:* on first push and if-match after', async () => {
    const origin = fakeHubOrigin('csrf-123');
    const first = await origin.provider.push(payload('a'), undefined);
    if (!first.ok) throw new Error('push failed');
    await origin.provider.push(payload('b'), first.revision);
    const puts = origin.requests.filter((r) => r.init.method === 'PUT');
    expect(puts).toHaveLength(2);
    const firstHeaders = headersOf(puts[0]!.init);
    const secondHeaders = headersOf(puts[1]!.init);
    expect(puts[0]!.url).toBe('https://hub.test/api/userdb');
    expect(puts[0]!.init.credentials).toBe('include');
    expect(firstHeaders['content-type']).toBe('application/octet-stream');
    expect(firstHeaders['if-none-match']).toBe('*');
    expect(firstHeaders['if-match']).toBeUndefined();
    expect(firstHeaders['x-snug-csrf']).toBe('csrf-123');
    expect(secondHeaders['if-match']).toBe(first.revision);
    expect(secondHeaders['if-none-match']).toBeUndefined();
  });

  it('GETs with credentials and reads the etag header as the revision', async () => {
    const origin = fakeHubOrigin();
    const revision = origin.seed(payload('a'));
    const pulled = await origin.provider.pull();
    expect(pulled?.revision).toBe(revision);
    const get = origin.requests.find((r) => (r.init.method ?? 'GET') === 'GET');
    expect(get?.init.credentials).toBe('include');
  });

  it('treats a 200 with an empty body as an empty origin', async () => {
    const provider = createHubOriginProvider({
      baseUrl: 'https://hub.test/api',
      fetch: () => Promise.resolve(new Response(new Uint8Array(0), { status: 200, headers: { etag: '"r0"' } })),
    });
    expect(await provider.pull()).toBeUndefined();
  });

  it('reads the conflict revision from the response body when there is no etag header', async () => {
    const provider = createHubOriginProvider({
      baseUrl: 'https://hub.test/api',
      fetch: () => Promise.resolve(json({ revision: '"r9"' }, 409)),
    });
    const result = await provider.push(payload('x'), '"r1"');
    expect(result).toEqual({ ok: false, conflict: true, remoteRevision: '"r9"' });
  });

  it('surfaces a missing etag on a successful pull as a typed BAD_RESPONSE error', async () => {
    const provider = createHubOriginProvider({
      baseUrl: 'https://hub.test/api',
      fetch: () => Promise.resolve(new Response(payload('bytes'), { status: 200 })),
    });
    await expect(provider.pull()).rejects.toMatchObject({
      name: 'SyncProviderError',
      code: SYNC_ERROR_CODES.BAD_RESPONSE,
    });
  });

  it('wraps fetch rejections in a typed NETWORK error and 401s in a typed AUTH error', async () => {
    const offline = createHubOriginProvider({
      baseUrl: 'https://hub.test/api',
      fetch: () => Promise.reject(new Error('offline')),
    });
    await expect(offline.pull()).rejects.toMatchObject({ code: SYNC_ERROR_CODES.NETWORK });
    const expired = createHubOriginProvider({
      baseUrl: 'https://hub.test/api',
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
    });
    await expect(expired.pull()).rejects.toMatchObject({ code: SYNC_ERROR_CODES.AUTH });
    await expect(expired.push(payload('x'), undefined)).rejects.toBeInstanceOf(SyncProviderError);
  });
});

// ----------------------------------------------------------------- dropbox specifics

describe('dropbox provider specifics', () => {
  it('uploads to the default path with mode add on first push and mode update after', async () => {
    const origin = fakeDropboxOrigin();
    const first = await origin.provider.push(payload('a'), undefined);
    if (!first.ok) throw new Error('push failed');
    await origin.provider.push(payload('b'), first.revision);
    const uploads = origin.requests.filter((r) => r.url.endsWith('/files/upload'));
    expect(uploads).toHaveLength(2);
    const firstArg = JSON.parse(headersOf(uploads[0]!.init)['dropbox-api-arg'] ?? '{}') as Record<string, unknown>;
    const secondArg = JSON.parse(headersOf(uploads[1]!.init)['dropbox-api-arg'] ?? '{}') as Record<string, unknown>;
    expect(DROPBOX_DEFAULT_PATH).toBe('/snug/user.sqlite');
    expect(firstArg.path).toBe(DROPBOX_DEFAULT_PATH);
    expect(firstArg.mode).toBe('add');
    expect(secondArg.mode).toEqual({ '.tag': 'update', update: first.revision });
    expect(headersOf(uploads[0]!.init)['content-type']).toBe('application/octet-stream');
  });

  it('sends the bearer token from getToken and fails closed with AUTH when there is none', async () => {
    const origin = fakeDropboxOrigin();
    await origin.provider.push(payload('a'), undefined);
    expect(headersOf(origin.requests[0]!.init).authorization).toBe(`Bearer ${DROPBOX_TOKEN}`);

    const calls: string[] = [];
    const tokenless = createDropboxProvider({
      getToken: () => undefined,
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve(new Response(null, { status: 500 }));
      },
    });
    await expect(tokenless.pull()).rejects.toMatchObject({ code: SYNC_ERROR_CODES.AUTH });
    expect(calls).toHaveLength(0); // fails before any network call
  });

  it('resolves the remote revision of a conflict via files/get_metadata', async () => {
    const origin = fakeDropboxOrigin();
    const seeded = origin.seed(payload('remote'));
    const result = await origin.provider.push(payload('local'), 'rev-stale');
    expect(result).toEqual({ ok: false, conflict: true, remoteRevision: seeded });
    expect(origin.requests.some((r) => r.url.endsWith('/files/get_metadata'))).toBe(true);
  });

  it('honors a custom path', async () => {
    let seen: string | undefined;
    const provider = createDropboxProvider({
      getToken: () => DROPBOX_TOKEN,
      path: '/custom/db.sqlite',
      fetch: (_url, init) => {
        seen = (JSON.parse(headersOf(init ?? {})['dropbox-api-arg'] ?? '{}') as { path?: string }).path;
        return Promise.resolve(json({ rev: 'rev-1' }, 200));
      },
    });
    await provider.push(payload('a'), undefined);
    expect(seen).toBe('/custom/db.sqlite');
  });
});

// --------------------------------------------------------------------- dropbox PKCE

describe('dropbox PKCE helpers (public client — no client secret anywhere)', () => {
  it('buildDropboxAuthUrl targets the authorize endpoint with S256 PKCE params', () => {
    const url = new URL(
      buildDropboxAuthUrl({
        clientId: 'app-key-1',
        redirectUri: 'https://hub.test/oauth/dropbox',
        codeChallenge: 'challenge-abc',
      }),
    );
    expect(url.origin).toBe('https://www.dropbox.com');
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('app-key-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://hub.test/oauth/dropbox');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.search.includes('client_secret')).toBe(false);
  });

  it('exchangeDropboxCode posts the verifier as form data and maps the token response', async () => {
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 14400, token_type: 'bearer' }, 200),
      ),
    );
    const result = await exchangeDropboxCode({
      clientId: 'app-key-1',
      redirectUri: 'https://hub.test/oauth/dropbox',
      code: 'auth-code-1',
      codeVerifier: 'verifier-xyz',
      fetch: fetchSpy,
    });
    expect(result).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 14400, tokenType: 'bearer' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.dropboxapi.com/oauth2/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('client_id')).toBe('app-key-1');
    expect(body.get('redirect_uri')).toBe('https://hub.test/oauth/dropbox');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('client_secret')).toBeNull();
  });

  it('surfaces a failed exchange as a typed AUTH error', async () => {
    await expect(
      exchangeDropboxCode({
        clientId: 'app-key-1',
        redirectUri: 'https://hub.test/oauth/dropbox',
        code: 'bad-code',
        codeVerifier: 'verifier-xyz',
        fetch: () => Promise.resolve(json({ error: 'invalid_grant' }, 400)),
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR_CODES.AUTH });
  });
});
