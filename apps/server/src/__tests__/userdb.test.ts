// AC3/AC4 (hub-sso): /userdb fail-closed surface — 401 unauthenticated (both verbs),
// CSRF double-submit on PUT, CORS fail-closed negative, revision preconditions
// (If-Match / If-None-Match: *), quota 413, SQLite magic-byte 400, and the F19 GET
// headers (octet-stream + nosniff + no-store + etag). Sessions are minted directly
// with the signing helper — no OIDC needed here.

import { USERDB_LIMITS } from '@snugprotocol/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, signPayload } from '../auth/session.js';
import { createUserDbStore } from '../stores/userdbs.js';
import { createUserStore } from '../stores/users.js';
import { authTestConfig, buildTestApp, testConfig, TEST_SESSION_SECRET } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const SQLITE_MAGIC = 'SQLite format 3\0';
const CSRF_TOKEN = 'csrf-token-for-tests';

function sqliteBytes(size = 512): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.write(SQLITE_MAGIC, 0, 'latin1');
  return bytes;
}

function sessionValue(userId: string): string {
  return signPayload({ userId, exp: Date.now() + 60_000 }, TEST_SESSION_SECRET);
}

function authedHeaders(userId = 'user-1', extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${sessionValue(userId)}; ${CSRF_COOKIE}=${CSRF_TOKEN}`,
    [CSRF_HEADER]: CSRF_TOKEN,
    'content-type': 'application/octet-stream',
    ...extra,
  };
}

async function putFirst(appInstance: FastifyInstance, userId = 'user-1', bytes: Buffer = sqliteBytes()) {
  return appInstance.inject({
    method: 'PUT',
    url: '/userdb',
    headers: authedHeaders(userId, { 'if-none-match': '*' }),
    payload: bytes,
  });
}

describe('/userdb authentication (AC3)', () => {
  it('returns 401 for both verbs without a session cookie', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const get = await app.inject({ method: 'GET', url: '/userdb' });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*' },
      payload: sqliteBytes(),
    });
    expect(put.statusCode).toBe(401);
  });

  it('returns 401 for an expired or tampered session', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const expired = signPayload({ userId: 'user-1', exp: Date.now() - 1000 }, TEST_SESSION_SECRET);
    const expiredResponse = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { cookie: `${SESSION_COOKIE}=${expired}` },
    });
    expect(expiredResponse.statusCode).toBe(401);

    const good = sessionValue('user-1');
    const tampered = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const tamperedResponse = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { cookie: `${SESSION_COOKIE}=${tampered}` },
    });
    expect(tamperedResponse.statusCode).toBe(401);
  });

  it('refuses a PUT without the CSRF header, and with a mismatched one (403)', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const headers = authedHeaders('user-1', { 'if-none-match': '*' });
    delete headers[CSRF_HEADER];
    const missing = await app.inject({ method: 'PUT', url: '/userdb', headers, payload: sqliteBytes() });
    expect(missing.statusCode).toBe(403);

    const mismatched = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-none-match': '*', [CSRF_HEADER]: 'not-the-cookie-value' }),
      payload: sqliteBytes(),
    });
    expect(mismatched.statusCode).toBe(403);
  });

  it('CORS fail-closed: a disallowed origin gets no ACAO header; the allowlisted one does, with credentials', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const evil = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { origin: 'http://evil.example', cookie: `${SESSION_COOKIE}=${sessionValue('u')}` },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { origin: 'http://localhost:5173', cookie: `${SESSION_COOKIE}=${sessionValue('u')}` },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/userdb',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': CSRF_HEADER,
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('/userdb revisions and preconditions (AC3)', () => {
  it('requires If-None-Match: * for the first write (bare PUT → 428)', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const bare = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders(),
      payload: sqliteBytes(),
    });
    expect(bare.statusCode).toBe(428);

    const first = await putFirst(app);
    expect(first.statusCode).toBe(204);
    expect(first.headers.etag).toMatch(/^r1-/);
  });

  it('refuses If-None-Match: * once a DB exists (412 + current etag)', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const first = await putFirst(app);
    const again = await putFirst(app);
    expect(again.statusCode).toBe(412);
    expect(again.headers.etag).toBe(first.headers.etag);
  });

  it('accepts a matching If-Match and rejects a stale one with 412 + current etag', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const first = await putFirst(app);
    const rev1 = first.headers.etag as string;

    const second = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-match': rev1 }),
      payload: sqliteBytes(1024),
    });
    expect(second.statusCode).toBe(204);
    const rev2 = second.headers.etag as string;
    expect(rev2).toMatch(/^r2-/);
    expect(rev2).not.toBe(rev1);

    const stale = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-match': rev1 }),
      payload: sqliteBytes(),
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.headers.etag).toBe(rev2);
  });

  it('accepts a quoted If-Match etag (HTTP-style)', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const first = await putFirst(app);
    const quoted = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-match': `"${first.headers.etag as string}"` }),
      payload: sqliteBytes(),
    });
    expect(quoted.statusCode).toBe(204);
  });
});

describe('/userdb body validation (AC3)', () => {
  it('rejects a body without the SQLite magic bytes (400)', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const response = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-none-match': '*' }),
      payload: Buffer.from('<html>not a database</html>'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-octet-stream content type (415)', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const response = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-none-match': '*', 'content-type': 'application/json' }),
      payload: { not: 'a database' },
    });
    expect(response.statusCode).toBe(415);
  });

  it('enforces the per-user quota (413) at the store boundary', async () => {
    const maxBytes = 1024;
    app = await buildTestApp({
      config: authTestConfig(),
      userDbStore: createUserDbStore(':memory:', { maxBytes }),
    });
    const over = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-none-match': '*' }),
      payload: sqliteBytes(maxBytes + 1),
    });
    expect(over.statusCode).toBe(413);

    const atCap = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-none-match': '*' }),
      payload: sqliteBytes(maxBytes),
    });
    expect(atCap.statusCode).toBe(204);
  });

  it('route-scoped body limit rejects a payload beyond the cap headroom (413, fastify layer)', async () => {
    const maxBytes = 1024;
    app = await buildTestApp({
      config: authTestConfig(),
      userDbStore: createUserDbStore(':memory:', { maxBytes }),
    });
    // Far beyond bodyLimit (maxBytes + headroom) — the parser aborts before the store.
    const response = await app.inject({
      method: 'PUT',
      url: '/userdb',
      headers: authedHeaders('user-1', { 'if-none-match': '*' }),
      payload: sqliteBytes(maxBytes + 128 * 1024),
    });
    expect(response.statusCode).toBe(413);
  });
});

describe('GET /userdb (AC4, F19)', () => {
  it('404s when no DB has been pushed yet', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const response = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { cookie: `${SESSION_COOKIE}=${sessionValue('user-1')}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('serves the exact bytes with octet-stream + nosniff + no-store + etag', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    const bytes = sqliteBytes(2048);
    bytes.write('marker', 100, 'latin1');
    const put = await putFirst(app, 'user-1', bytes);
    expect(put.statusCode).toBe(204);

    const response = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { cookie: `${SESSION_COOKIE}=${sessionValue('user-1')}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.etag).toBe(put.headers.etag);
    expect(Buffer.compare(response.rawPayload, bytes)).toBe(0);
  });

  it('keeps user DBs isolated per user', async () => {
    app = await buildTestApp({ config: authTestConfig() });
    await putFirst(app, 'user-a');
    const other = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { cookie: `${SESSION_COOKIE}=${sessionValue('user-b')}` },
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('auth-disabled mode (byte-for-byte v1 behavior)', () => {
  it('registers neither /userdb nor /auth/* when auth is off', async () => {
    app = await buildTestApp({ config: testConfig() });
    expect((await app.inject({ method: 'GET', url: '/userdb' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/userdb', payload: 'x' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/login' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(404);
  });
});

describe('userdbs store', () => {
  it('defaults the quota to the protocol constant', () => {
    const store = createUserDbStore(':memory:');
    expect(store.maxBytes).toBe(USERDB_LIMITS.MAX_USERDB_BYTES);
    store.close();
  });

  it('mints monotonically increasing revisions per user', () => {
    const store = createUserDbStore(':memory:', { maxBytes: 4096 });
    const first = store.put('u', sqliteBytes(), undefined);
    if (!first.ok) throw new Error('first put failed');
    expect(first.revision).toMatch(/^r1-/);
    const second = store.put('u', sqliteBytes(), first.revision);
    if (!second.ok) throw new Error('second put failed');
    expect(second.revision).toMatch(/^r2-/);
    expect(second.revision).not.toBe(first.revision);
    // Another user starts back at r1 — counters are per user.
    const other = store.put('v', sqliteBytes(), undefined);
    if (!other.ok) throw new Error('other put failed');
    expect(other.revision).toMatch(/^r1-/);
    store.close();
  });

  it('reports the current revision on a mismatch', () => {
    const store = createUserDbStore(':memory:', { maxBytes: 4096 });
    const first = store.put('u', sqliteBytes(), undefined);
    if (!first.ok) throw new Error('put failed');
    const stale = store.put('u', sqliteBytes(), 'r0-stale');
    expect(stale).toMatchObject({ ok: false, code: 'REVISION_MISMATCH', current: first.revision });
    const firstAgain = store.put('u', sqliteBytes(), undefined);
    expect(firstAgain).toMatchObject({ ok: false, code: 'REVISION_MISMATCH', current: first.revision });
    store.close();
  });
});

describe('users store', () => {
  it('upserts by google sub: stable id, refreshed profile fields', () => {
    const store = createUserStore(':memory:');
    const created = store.upsertByGoogleSub({ googleSub: 'sub-1', email: 'a@example.com', name: 'A' });
    const updated = store.upsertByGoogleSub({ googleSub: 'sub-1', email: 'b@example.com', name: 'B' });
    expect(updated.id).toBe(created.id);
    expect(updated.email).toBe('b@example.com');
    expect(updated.name).toBe('B');
    expect(store.get(created.id)?.email).toBe('b@example.com');
    const other = store.upsertByGoogleSub({ googleSub: 'sub-2', email: 'c@example.com', name: 'C' });
    expect(other.id).not.toBe(created.id);
    store.close();
  });
});
