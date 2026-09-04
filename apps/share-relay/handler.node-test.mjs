// handler.node-test.mjs — the relay contract (TASK-20260904 AC21, ADR-0064), run with
// node:test against an in-memory store. Node builtins only.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_ALLOWED_ORIGINS, ID_RULE, MAX_BODY_BYTES, handleRequest, parseAllowedOrigins } from './handler.mjs';

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts) {
      objects.set(key, { bytes: new Uint8Array(value).slice(), customMetadata: opts?.customMetadata ?? {} });
    },
    async get(key) {
      const o = objects.get(key);
      if (o === undefined) return null;
      return { arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength), customMetadata: o.customMetadata };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const ORIGIN = 'https://playground.snugprotocol.org';
const base = 'https://share.snugprotocol.org';

function env(store, extra = {}) {
  return { BUNDLES: store, ...extra };
}

async function upload(store, bytes, origin = ORIGIN, seams = {}) {
  const request = new Request(`${base}/v1/bundles`, {
    method: 'POST',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', ...(origin !== null ? { Origin: origin } : {}) },
  });
  return handleRequest(request, env(store), seams);
}

test('POST stores ciphertext and answers id + expiresAt + revokeToken; the token is stored only as a hash', async () => {
  const store = memoryStore();
  const fixed = new Date('2026-09-04T00:00:00.000Z');
  const res = await upload(store, new Uint8Array([1, 2, 3]), ORIGIN, { now: () => fixed });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.id, ID_RULE);
  assert.equal(body.expiresAt, '2026-10-04T00:00:00.000Z');
  assert.match(body.revokeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const stored = store.objects.get(`b/${body.id}`);
  assert.deepEqual([...stored.bytes], [1, 2, 3]);
  assert.equal(stored.customMetadata.expiresAt, body.expiresAt);
  assert.notEqual(stored.customMetadata.revokeHash, body.revokeToken);
  assert.match(stored.customMetadata.revokeHash, /^[0-9a-f]{64}$/);
});

test('GET returns the bytes until expiry, then 404 — read-time enforcement, not the janitor', async () => {
  const store = memoryStore();
  const uploadedAt = new Date('2026-09-04T00:00:00.000Z');
  const { id } = await (await upload(store, new Uint8Array([9, 9]), ORIGIN, { now: () => uploadedAt })).json();
  const fresh = await handleRequest(new Request(`${base}/v1/bundles/${id}`), env(store), { now: () => new Date('2026-09-20T00:00:00Z') });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(fresh.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(fresh.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await fresh.arrayBuffer())], [9, 9]);
  const stale = await handleRequest(new Request(`${base}/v1/bundles/${id}`), env(store), { now: () => new Date('2026-10-05T00:00:00Z') });
  assert.equal(stale.status, 404);
});

test('size cap: a body over MAX_BODY_BYTES is 413 (declared or actual); an empty body is 400', async () => {
  const store = memoryStore();
  const big = new Uint8Array(MAX_BODY_BYTES + 1);
  assert.equal((await upload(store, big)).status, 413);
  const declared = new Request(`${base}/v1/bundles`, { method: 'POST', body: new Uint8Array(1), headers: { Origin: ORIGIN, 'Content-Length': String(MAX_BODY_BYTES + 1) } });
  assert.equal((await handleRequest(declared, env(store))).status, 413);
  assert.equal((await upload(store, new Uint8Array(0))).status, 400);
  assert.equal(store.objects.size, 0);
});

test('id grammar: anything but 22 base64url chars is 404, including path tricks', async () => {
  const store = memoryStore();
  for (const bad of ['x', 'a'.repeat(21), 'a'.repeat(23), '../b/x', 'a'.repeat(22) + '/', '%2e%2e']) {
    const res = await handleRequest(new Request(`${base}/v1/bundles/${bad}`), env(store));
    assert.equal(res.status, 404, bad);
  }
});

test('DELETE revokes with the minted token only; a wrong or missing token is 404 (no existence oracle)', async () => {
  const store = memoryStore();
  const { id, revokeToken } = await (await upload(store, new Uint8Array([1]))).json();
  const wrong = await handleRequest(new Request(`${base}/v1/bundles/${id}`, { method: 'DELETE', headers: { Origin: ORIGIN, Authorization: `Bearer ${'A'.repeat(43)}` } }), env(store));
  assert.equal(wrong.status, 404);
  assert.equal(store.objects.size, 1);
  const missing = await handleRequest(new Request(`${base}/v1/bundles/${id}`, { method: 'DELETE', headers: { Origin: ORIGIN } }), env(store));
  assert.equal(missing.status, 404);
  const right = await handleRequest(new Request(`${base}/v1/bundles/${id}`, { method: 'DELETE', headers: { Origin: ORIGIN, Authorization: `Bearer ${revokeToken}` } }), env(store));
  assert.equal(right.status, 204);
  assert.equal(store.objects.size, 0);
  const gone = await handleRequest(new Request(`${base}/v1/bundles/${id}`), env(store));
  assert.equal(gone.status, 404);
});

test('CORS: allowlisted origins get headers and preflight; a foreign browser origin cannot write; reads need no origin', async () => {
  const store = memoryStore();
  const preflight = await handleRequest(new Request(`${base}/v1/bundles`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env(store));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');
  const foreignPreflight = await handleRequest(new Request(`${base}/v1/bundles`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env(store));
  assert.equal(foreignPreflight.status, 404);
  assert.equal((await upload(store, new Uint8Array([1]), 'https://evil.example')).status, 403);
  assert.equal(store.objects.size, 0);
  const { id } = await (await upload(store, new Uint8Array([1]), null)).json(); // a native client, no Origin
  const read = await handleRequest(new Request(`${base}/v1/bundles/${id}`), env(store));
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('Access-Control-Allow-Origin'), null);
  const foreignDelete = await handleRequest(new Request(`${base}/v1/bundles/${id}`, { method: 'DELETE', headers: { Origin: 'https://evil.example', Authorization: 'Bearer x' } }), env(store));
  assert.equal(foreignDelete.status, 403);
  assert.deepEqual(parseAllowedOrigins(undefined), DEFAULT_ALLOWED_ORIGINS);
  assert.deepEqual(parseAllowedOrigins(' https://a.example , tauri://localhost '), ['https://a.example', 'tauri://localhost']);
});

test('everything else is a bodiless 404 — no listing, no banner', async () => {
  const store = memoryStore();
  for (const path of ['/', '/v1', '/v1/bundles/', '/v2/bundles', '/robots.txt', '/v1/bundles/a/b']) {
    const res = await handleRequest(new Request(`${base}${path}`), env(store));
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), '', path);
  }
  const put = await handleRequest(new Request(`${base}/v1/bundles/${'a'.repeat(22)}`, { method: 'PUT', body: 'x' }), env(store));
  assert.equal(put.status, 404);
});

test('TTL_DAYS is honoured from the environment', async () => {
  const store = memoryStore();
  const fixed = new Date('2026-09-04T00:00:00.000Z');
  const request = new Request(`${base}/v1/bundles`, { method: 'POST', body: new Uint8Array([1]), headers: { Origin: ORIGIN } });
  const res = await handleRequest(request, env(store, { TTL_DAYS: '7' }), { now: () => fixed });
  assert.equal((await res.json()).expiresAt, '2026-09-11T00:00:00.000Z');
});
