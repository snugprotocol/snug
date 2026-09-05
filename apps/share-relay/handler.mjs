// handler.mjs — the share relay's request handler (ADR-0064), pure over a STORE seam so
// it can be tested with an in-memory bucket and run unchanged on R2.
//
// WHAT THIS CANNOT DO is the design. The relay stores bytes the sharer's browser
// encrypted with a key that travels only in the link's URL fragment, so the relay can
// neither read a bundle nor substitute one (the recipient's AEAD tag fails). It holds
// no identity: ids are minted here from 128 random bits, the revoke token is 256 random
// bits handed back ONCE and stored only as a sha-256 so a leaked bucket cannot revoke,
// and nothing is written about who uploaded or fetched. Bodies are never logged.
//
// BOUNDS. One size cap (the bundle cap plus the AEAD overhead margin), a TTL the SHARER
// chooses from a closed set (`?expires=1d|7d|30d`, default a week; `TTL_DAYS` is the
// ceiling, and a choice above it is refused rather than clamped — `expiresAt` is stamped
// at upload and enforced at READ; a read that finds an expired object deletes it, and
// the bucket's lifecycle rule is the backstop, not the authority), an id grammar, and a
// CORS allowlist for
// the browser origins that may write; reads carry CORS headers only for those origins
// too, but are served to any caller with a valid id (the id is the recipient's proof).
//
// Everything that is not exactly one of the three routes is a 404 with no body: no
// listing, no version banner, nothing to enumerate.

/** The bundle cap (packages/protocol APP_BUNDLE_MAX_BYTES) + the AEAD overhead margin (nonce + tag + base64 slack). */
export const MAX_BODY_BYTES = 1024 * 1024 + 64 * 1024;
export const ID_RULE = /^[A-Za-z0-9_-]{22}$/;
export const TOKEN_RULE = /^[A-Za-z0-9_-]{43}$/;
/** The ceiling when `TTL_DAYS` is unset; the config pins the same number. */
export const DEFAULT_TTL_DAYS = 30;
/** The sharer's choices (TASK-20260904-share-link-ux AC1): a closed set, days each. */
export const EXPIRY_CHOICES = new Map([
  ['1d', 1],
  ['7d', 7],
  ['30d', 30],
]);
export const DEFAULT_EXPIRY = '7d';
export const DEFAULT_ALLOWED_ORIGINS = ['https://playground.snugprotocol.org', 'tauri://localhost', 'http://tauri.localhost'];

const KEY_PREFIX = 'b/';

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseAllowedOrigins(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_ALLOWED_ORIGINS;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function corsHeaders(origin, allowed) {
  if (origin === null || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Read at most `cap` bytes from the request; `null` when the body exceeds it. */
async function readCapped(request, cap) {
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * The upload's lifetime in days: the `expires` choice (exactly one, from the closed
 * set), defaulting to a week, never above the ceiling. `undefined` = refuse the upload.
 */
export function expiryDays(searchParams, ttlCeilingVar) {
  const ceiling = Number(ttlCeilingVar) > 0 ? Number(ttlCeilingVar) : DEFAULT_TTL_DAYS;
  const choices = searchParams.getAll('expires');
  if (choices.length > 1) return undefined;
  const choice = choices[0] ?? DEFAULT_EXPIRY;
  const days = EXPIRY_CHOICES.get(choice);
  if (days === undefined) return undefined;
  if (choices.length === 0) return Math.min(days, ceiling);
  return days > ceiling ? undefined : days;
}

function respond(status, body, headers) {
  return new Response(body ?? null, { status, headers: { ...NO_STORE, ...headers } });
}

function json(status, value, headers) {
  return respond(status, JSON.stringify(value), { 'Content-Type': 'application/json', ...headers });
}

/**
 * @param {Request} request
 * @param {{ BUNDLES: { put(key: string, value: ArrayBuffer, opts?: object): Promise<unknown>; get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; customMetadata?: Record<string,string> } | null>; delete(key: string): Promise<void> }, TTL_DAYS?: string, ALLOWED_ORIGINS?: string }} env
 * @param {{ now?: () => Date, randomBytes?: (n: number) => Uint8Array }} [seams]
 */
export async function handleRequest(request, env, seams = {}) {
  const now = seams.now ?? (() => new Date());
  const randomBytes = seams.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, allowed);
  const url = new URL(request.url);
  const match = /^\/v1\/bundles(?:\/([^/]+))?$/.exec(url.pathname);

  if (request.method === 'OPTIONS') {
    return match !== null && Object.keys(cors).length > 0 ? respond(204, null, cors) : respond(404, null, {});
  }
  if (match === null) return respond(404, null, cors);
  const id = match[1];

  // Writes from a browser origin that is not ours are refused outright; a request with
  // no Origin (a native client, curl) is judged by the route's own rules alone.
  const originIsForeign = origin !== null && !allowed.includes(origin);

  if (request.method === 'POST' && id === undefined) {
    if (originIsForeign) return respond(403, null, {});
    const declared = Number(request.headers.get('Content-Length') ?? '0');
    if (declared > MAX_BODY_BYTES) return respond(413, null, cors);
    // STREAM the body and stop at the cap (Gate-5 finding 13): a lying or absent
    // Content-Length must not make the Worker buffer the platform's whole 100 MB
    // allowance before it can say 413.
    const body = await readCapped(request, MAX_BODY_BYTES);
    if (body === null) return respond(413, null, cors);
    if (body.byteLength === 0) return respond(400, null, cors);
    const ttlDays = expiryDays(url.searchParams, env.TTL_DAYS);
    if (ttlDays === undefined) return respond(400, null, cors);
    const expiresAt = new Date(now().getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const newId = base64url(randomBytes(16));
    const revokeToken = base64url(randomBytes(32));
    const revokeHash = await sha256Hex(revokeToken);
    await env.BUNDLES.put(`${KEY_PREFIX}${newId}`, body, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { expiresAt, revokeHash },
    });
    return json(201, { id: newId, expiresAt, revokeToken }, cors);
  }

  if (id === undefined || !ID_RULE.test(id)) return respond(404, null, cors);

  if (request.method === 'GET' || request.method === 'HEAD') {
    // HEAD reads metadata only (R2 `head`); the in-memory test store has no `head`, so
    // fall back to `get` there — the bytes are never sent on HEAD either way.
    const object =
      request.method === 'HEAD' && typeof env.BUNDLES.head === 'function'
        ? await env.BUNDLES.head(`${KEY_PREFIX}${id}`)
        : await env.BUNDLES.get(`${KEY_PREFIX}${id}`);
    if (object === null) return respond(404, null, cors);
    const expiresAt = object.customMetadata?.expiresAt;
    if (expiresAt === undefined || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now().getTime()) {
      // Expired but not yet collected: the lifecycle rule is a backstop, not the
      // authority — and this read is the cheapest janitor there is (AC2).
      await env.BUNDLES.delete(`${KEY_PREFIX}${id}`);
      return respond(404, null, cors);
    }
    const bytes = request.method === 'HEAD' ? null : await object.arrayBuffer();
    return respond(200, bytes, {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'X-Snug-Expires-At': expiresAt,
    });
  }

  if (request.method === 'DELETE') {
    if (originIsForeign) return respond(403, null, {});
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!TOKEN_RULE.test(token)) return respond(404, null, cors);
    const object = await env.BUNDLES.get(`${KEY_PREFIX}${id}`);
    if (object === null) return respond(404, null, cors);
    const expected = object.customMetadata?.revokeHash ?? '';
    const presented = await sha256Hex(token);
    if (!timingSafeEqual(expected, presented)) return respond(404, null, cors);
    await env.BUNDLES.delete(`${KEY_PREFIX}${id}`);
    return respond(204, null, cors);
  }

  return respond(404, null, cors);
}
