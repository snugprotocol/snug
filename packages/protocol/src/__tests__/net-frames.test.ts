// AL-03 (TASK-20260806-connected-fetch) — the envelope net capability's protocol surface.
// INTERNAL draft frames (plan D1): `snug:net-request` / `snug:net-response` stay OUT of
// the published json-schemas SOURCES (the publishes-to-spec line) and are locked here by
// in-package tests instead. Key amendments under test: B1 (own frame size class — an
// oversized net-response can never be silently dropped), R2 (GET/HEAD body strict-reject),
// R5 (no appId field — the runner's net binding is host-assigned), C1 (the schema rejects
// a headers object carrying credential headers), open-Q2 (`link` + `x-ratelimit-*` in the
// response-header whitelist; `set-cookie` never).
import { describe, expect, it } from 'vitest';
import {
  FRAME_TYPES,
  LIMITS,
  NET_ERROR_CODES,
  NET_METHODS,
  NET_RESPONSE_HEADER_WHITELIST,
  PROTOCOL_VERSION,
  isWhitelistedNetResponseHeader,
} from '../constants.js';
import { frameWithinLimits, netRequestSchema, netResponseSchema, parseFrame, type Frame } from '../frames.js';
import { buildJsonSchemas } from '../json-schemas.js';

const validRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.netRequest,
  requestId: 'net-1',
  instanceId: 'ins-1',
  url: 'https://api.example.com/v1/data',
  method: 'GET',
  ...over,
});

const okResponse = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.netResponse,
  requestId: 'net-1',
  ok: true,
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"hello":"world"}',
  ...over,
});

describe('net-request schema (D1/D3.1)', () => {
  it('accepts a minimal GET and a POST with headers + body', () => {
    expect(netRequestSchema.safeParse(validRequest()).success).toBe(true);
    expect(
      netRequestSchema.safeParse(
        validRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }),
      ).success,
    ).toBe(true);
  });

  it('R5: carries NO appId — an app-supplied appId-like field is strict-rejected', () => {
    for (const extra of [{ appId: 'other-app' }, { skillId: 'x' }, { namespace: 'y' }]) {
      const parsed = netRequestSchema.safeParse(validRequest(extra));
      expect(parsed.success, `extra field ${Object.keys(extra)[0]} must be rejected`).toBe(false);
    }
  });

  it('R2: strict-rejects a body on GET and HEAD', () => {
    expect(netRequestSchema.safeParse(validRequest({ body: 'x' })).success).toBe(false);
    expect(netRequestSchema.safeParse(validRequest({ method: 'HEAD', body: 'x' })).success).toBe(false);
    expect(netRequestSchema.safeParse(validRequest({ method: 'POST', body: 'x' })).success).toBe(true);
  });

  it('C1: rejects a headers object carrying credential headers, any casing', () => {
    for (const name of ['Authorization', 'authorization', 'AUTHORIZATION', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'Proxy-Authorization']) {
      const parsed = netRequestSchema.safeParse(validRequest({ headers: { [name]: 'Bearer stolen' } }));
      expect(parsed.success, `${name} must never cross the bridge`).toBe(false);
    }
  });

  it('accepts only the pinned method set', () => {
    expect([...NET_METHODS]).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(netRequestSchema.safeParse(validRequest({ method: 'TRACE' })).success).toBe(false);
    expect(netRequestSchema.safeParse(validRequest({ method: 'get' })).success).toBe(false);
  });

  it('requires instanceId and requestId (stale-instance discipline like db-request)', () => {
    const { instanceId: _dropped, ...rest } = validRequest();
    expect(netRequestSchema.safeParse(rest).success).toBe(false);
    expect(netRequestSchema.safeParse(validRequest({ requestId: '' })).success).toBe(false);
  });
});

describe('net-response schema (D1)', () => {
  it('accepts success (status/headers/body, optional truncated) and error shapes', () => {
    expect(netResponseSchema.safeParse(okResponse()).success).toBe(true);
    expect(netResponseSchema.safeParse(okResponse({ truncated: true })).success).toBe(true);
    expect(
      netResponseSchema.safeParse({
        v: PROTOCOL_VERSION,
        type: FRAME_TYPES.netResponse,
        requestId: 'net-1',
        ok: false,
        error: { code: NET_ERROR_CODES.NET_HOST_BLOCKED, message: 'host outside the approved set', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('is strict: unknown fields are rejected', () => {
    expect(netResponseSchema.safeParse(okResponse({ injectedHeaders: { a: 'b' } })).success).toBe(false);
  });
});

describe('parseFrame routing', () => {
  it('routes valid net frames', () => {
    const req = parseFrame(validRequest());
    expect(req.ok).toBe(true);
    if (req.ok) expect(req.frame.type).toBe(FRAME_TYPES.netRequest);
    const res = parseFrame(okResponse());
    expect(res.ok).toBe(true);
  });

  it('returns MALFORMED with a recoverable requestId for a credential-carrying request', () => {
    const parsed = parseFrame(validRequest({ headers: { Authorization: 'Bearer stolen' } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.ignored !== true) {
      expect(parsed.code).toBe('MALFORMED');
      expect(parsed.requestId).toBe('net-1');
    } else {
      throw new Error('expected a MALFORMED failure, not a silent ignore');
    }
  });
});

describe('B1 — net frames get their OWN size class (never silently dropped)', () => {
  const CAP = LIMITS.MAX_NET_FRAME_BYTES;

  /** ASCII-only frame → serialized bytes === JSON.stringify length. */
  const responseWithSerializedBytes = (target: number): Frame => {
    const skeleton = okResponse({ body: '' }) as unknown as Frame;
    const overhead = JSON.stringify(skeleton).length;
    return okResponse({ body: 'x'.repeat(target - overhead) }) as unknown as Frame;
  };

  it('pins the class: 1 MiB response cap + 64 KiB envelope margin', () => {
    expect(CAP).toBe(1024 * 1024 + 64 * 1024);
    expect(LIMITS.MAX_NET_RESPONSE_BODY_BYTES).toBe(1024 * 1024);
    expect(LIMITS.MAX_NET_REQUEST_BODY_BYTES).toBe(256 * 1024);
  });

  it('boundary: cap−1 and cap pass, cap+1 fails (the bridge answers with a terminal error instead)', () => {
    expect(frameWithinLimits(responseWithSerializedBytes(CAP - 1))).toBe(true);
    expect(frameWithinLimits(responseWithSerializedBytes(CAP))).toBe(true);
    expect(frameWithinLimits(responseWithSerializedBytes(CAP + 1))).toBe(false);
  });

  it('a net frame above the generic 256 KiB class but under the net class is within limits', () => {
    const frame = responseWithSerializedBytes(LIMITS.MAX_FRAME_BYTES + 1024);
    expect(frameWithinLimits(frame)).toBe(true);
    // …while the same size as an app-response would be over the generic class.
    expect(LIMITS.MAX_FRAME_BYTES + 1024).toBeLessThan(CAP);
  });

  it('net-request frames use the net class too (a 256 KiB body fits)', () => {
    const frame = validRequest({ method: 'POST', body: 'y'.repeat(LIMITS.MAX_NET_REQUEST_BODY_BYTES) }) as unknown as Frame;
    expect(frameWithinLimits(frame)).toBe(true);
  });
});

describe('response-header whitelist (D1 + open Q2 + A2)', () => {
  it('pins the exact literal set', () => {
    expect([...NET_RESPONSE_HEADER_WHITELIST]).toEqual([
      'content-type',
      'content-length',
      'cache-control',
      'etag',
      'last-modified',
      'retry-after',
      'link',
    ]);
  });

  it('matches whitelist names case-insensitively plus the x-ratelimit-* glob', () => {
    expect(isWhitelistedNetResponseHeader('Content-Type')).toBe(true);
    expect(isWhitelistedNetResponseHeader('ETag')).toBe(true);
    expect(isWhitelistedNetResponseHeader('Link')).toBe(true);
    expect(isWhitelistedNetResponseHeader('X-RateLimit-Remaining')).toBe(true);
    expect(isWhitelistedNetResponseHeader('x-ratelimit-reset')).toBe(true);
  });

  it('A2: set-cookie (and other unlisted headers) never cross the bridge', () => {
    for (const name of ['set-cookie', 'Set-Cookie', 'www-authenticate', 'x-powered-by', 'authorization', 'server']) {
      expect(isWhitelistedNetResponseHeader(name), `${name} must not be whitelisted`).toBe(false);
    }
  });
});

describe('net error codes (D1)', () => {
  it('exports the pinned constant set, each equal to its own name', () => {
    for (const [key, value] of Object.entries(NET_ERROR_CODES)) expect(value).toBe(key);
    for (const name of [
      'NET_INVALID_REQUEST',
      'NET_NOT_APPROVED',
      'NET_IMPORTED_UNAPPROVED',
      'NET_SCHEME_BLOCKED',
      'NET_HOST_BLOCKED',
      'NET_SSRF_BLOCKED',
      'NET_CONFIRM_DENIED',
      'NET_REDIRECT_BLOCKED',
      'NET_SIZE_EXCEEDED',
      'NET_FETCH_FAILED',
      'NET_AUTH_FAILED',
      'NET_SCRUBBED_HEADER_STRIPPED',
    ]) {
      expect(NET_ERROR_CODES, `missing ${name}`).toHaveProperty(name);
    }
  });
});

describe('publication line — net frames stay OUT of json-schemas SOURCES (D1, extends the AL-02 guard)', () => {
  it('buildJsonSchemas() still exports exactly the pre-auth v1 wire set — no net-* entry', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names.some((n) => n.startsWith('net-'))).toBe(false);
    expect(names.sort()).toEqual(
      [
        'app-announce.json',
        'app-cancel.json',
        'app-event.json',
        'app-message.json',
        'app-request-envelope.json',
        'app-response.json',
        'db-request.json',
        'db-response.json',
        'host-event.json',
        'host-ready.json',
      ].sort(),
    );
  });
});
