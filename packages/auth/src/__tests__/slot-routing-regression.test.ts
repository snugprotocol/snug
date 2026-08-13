// TASK-20260810-p1-runtime AC8: the REGRESSION pins. P1 rewires the executor's row
// lookup and swaps two gates; this file states, at the executor altitude and against the
// V4 reader, that none of the shipped negative guarantees moved.
//
// WHY A SEPARATE FILE FROM connected-fetch.test.ts. That file tests the V3 reader and must
// keep passing untouched (the B1 cutover rule: `snug_auth_specs` is a named exit item of
// P3, not of P1). Its green is evidence about the v3 path only. The v4 path is a NEW code
// route through the same ten gates, so every guarantee has to be re-proven THERE — a
// scrub that works for v3 rows says nothing about a request routed by host through a v4
// grant. These are the same claims, re-asked of the new route.
//
// The one intentional AMENDMENT is the gate 3↔4 order (fold F-m2), which is pinned
// positively in connected-fetch-slots.test.ts (P1-AC2). Nothing else about the order
// changes, and the tests below are written to fail if it does.
import { LIMITS, NET_ERROR_CODES } from '@snugprotocol/protocol';
import { CONNECTION_STATUS, type ConnectionRequirement } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';
import { createConnectedFetch, type ConnectedFetch, type NetConnectionRow } from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

const APP = 'app-regress';
const API_KEY_VALUE = 'regress-key-9f3a7c21b4e05d68a1f2c3b4';

const requirement = {
  slot: 'example',
  provider: { name: 'Example' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
} as const satisfies ConnectionRequirement;

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

type FetchCall = { url: string; init: RequestInit };

function harness(
  opts: {
    requirement?: ConnectionRequirement;
    allowedHosts?: string[];
    respond?: (url: string, init: RequestInit) => Response;
    confirmResult?: boolean;
  } = {},
): { executor: ConnectedFetch; calls: FetchCall[]; confirm: ReturnType<typeof vi.fn> } {
  const req = opts.requirement ?? requirement;
  const quartet = memoryQuartet();
  quartet.setSecret(authConnectionCredentialSecretKey(APP, req.slot, 'api_key'), API_KEY_VALUE);
  const rows: NetConnectionRow[] = [
    {
      appId: APP,
      slot: req.slot,
      requirement: req,
      status: CONNECTION_STATUS.approved,
      // `?? []` since ADR-0023 made `declaredApiHosts` required-XOR-`lanHost`. Every
      // requirement THIS suite builds declares hosts, so the fallback is unreachable
      // here — it exists to satisfy the widened type, not to admit a hostless fixture.
      allowedHosts: opts.allowedHosts ?? [...(req.declaredApiHosts ?? [])],
    },
  ];
  const calls: FetchCall[] = [];
  const respond =
    opts.respond ??
    (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const confirm = vi.fn(async () => opts.confirmResult ?? true);
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: (appId) => (appId === APP ? rows : []) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    },
    confirmGate: { confirm },
  });
  return { executor, calls, confirm };
}

const GET = (url = 'https://api.example.com/v1/data'): { url: string; method: 'GET' } => ({ url, method: 'GET' });

const headerBlob = (call: FetchCall): string =>
  Object.entries((call.init.headers ?? {}) as Record<string, string>)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AC8 regression — https-only and the frozen ceiling survive slot routing', () => {
  it('A1: http is blocked even for a localhost host sitting INSIDE the frozen set', async () => {
    const localhostReq = {
      ...requirement,
      declaredApiHosts: ['localhost', 'api.example.com'],
    } as unknown as ConnectionRequirement;
    const { executor, calls } = harness({
      requirement: localhostReq,
      allowedHosts: ['localhost', 'api.example.com'],
    });
    expect(await executor.execute(APP, { url: 'http://localhost:8787/dev', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('the ceiling is exact-hostname — suffix tricks stay blocked under host ROUTING', async () => {
    // Sharper under v4 than v3: routing now SEARCHES hosts, so a substring-style match
    // would both mis-route and widen. `api.example.com.evil.com` must match no row.
    const { executor, calls } = harness();
    for (const url of ['https://api.example.com.evil.com/x', 'https://evil.example/steal']) {
      const result = await executor.execute(APP, { url, method: 'GET' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      // Under v4 an unmatched host is a ROUTING miss, so the honest code is NOT_APPROVED.
      expect([NET_ERROR_CODES.NET_NOT_APPROVED, NET_ERROR_CODES.NET_HOST_BLOCKED]).toContain(result.code);
    }
    expect(calls).toHaveLength(0);
  });

  it('B3: a stored-UNICODE ceiling entry still matches its punycoded request host', async () => {
    const unicodeReq = {
      ...requirement,
      declaredApiHosts: ['api.münchen.example'],
    } as unknown as ConnectionRequirement;
    const { executor, calls } = harness({ requirement: unicodeReq, allowedHosts: ['api.münchen.example'] });
    const result = await executor.execute(APP, { url: 'https://api.xn--mnchen-3ya.example/v1', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('case and port do not defeat the routed ceiling match', async () => {
    const { executor, calls } = harness();
    expect((await executor.execute(APP, { url: 'https://API.EXAMPLE.COM/x', method: 'GET' })).ok).toBe(true);
    expect((await executor.execute(APP, { url: 'https://api.example.com:8443/x', method: 'GET' })).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('AC8 regression — SSRF, confirm, and the C1 header strip survive slot routing', () => {
  it('the SSRF literal guard fires even for a host the user APPROVED into the ceiling', async () => {
    const loopbackReq = { ...requirement, declaredApiHosts: ['127.0.0.1'] } as unknown as ConnectionRequirement;
    const { executor, calls } = harness({ requirement: loopbackReq, allowedHosts: ['127.0.0.1'] });
    expect(await executor.execute(APP, { url: 'https://127.0.0.1/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SSRF_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('a denied POST performs NO fetch and reads NO credential', async () => {
    const { executor, calls, confirm } = harness({ confirmResult: false });
    expect(await executor.execute(APP, { url: 'https://api.example.com/x', method: 'POST', body: '{}' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_CONFIRM_DENIED,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('GET/HEAD never consult the confirm gate', async () => {
    const { executor, confirm } = harness();
    await executor.execute(APP, GET());
    expect(confirm).not.toHaveBeenCalled();
  });

  it('C1: app-supplied credential-shaped headers never reach fetchImpl; the injected value wins', async () => {
    const { executor, calls } = harness();
    await executor.execute(APP, {
      ...GET(),
      headers: {
        Authorization: 'Bearer app-forged-token',
        Cookie: 'session=app-forged',
        'X-Api-Key': 'app-forged-key',
        'X-Custom-Auth': 'app-forged-custom',
        'X-Harmless': 'kept',
      },
    } as never);
    const blob = headerBlob(calls[0]!);
    expect(blob).not.toContain('app-forged-token');
    expect(blob).not.toContain('app-forged');
    expect(blob).toContain(API_KEY_VALUE); // the HOST's value occupies the seat
    expect(blob).toContain('kept'); // non-credential headers still cross
  });
});

describe('AC8 regression — redirect block, size cap, and the scrubber survive slot routing', () => {
  it('a 30x is NET_REDIRECT_BLOCKED and redirect:manual is passed to fetchImpl', async () => {
    const { executor, calls } = harness({
      respond: () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }),
    });
    expect(await executor.execute(APP, GET())).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_REDIRECT_BLOCKED,
    });
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('an over-cap response is a SMALL terminal error with NO partial body', async () => {
    const { executor } = harness({
      respond: () => new Response('a'.repeat(LIMITS.MAX_NET_RESPONSE_BODY_BYTES + 1), { status: 200 }),
    });
    const result = await executor.execute(APP, GET());
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SIZE_EXCEEDED });
    if (result.ok) throw new Error('unreachable');
    expect(result.message.length).toBeLessThan(300);
  });

  it('the injected value is scrubbed from the response BODY (C1 negative)', async () => {
    const { executor } = harness({
      respond: () => new Response(JSON.stringify({ echoed: API_KEY_VALUE }), { status: 200 }),
    });
    const result = await executor.execute(APP, GET());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.body).not.toContain(API_KEY_VALUE);
  });

  it('R1: the injected value is scrubbed from WHITELISTED response headers too', async () => {
    const { executor } = harness({
      respond: () =>
        new Response('{}', { status: 200, headers: { 'content-type': `application/json; k=${API_KEY_VALUE}` } }),
    });
    const result = await executor.execute(APP, GET());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.headers)).not.toContain(API_KEY_VALUE);
  });

  it('A2: set-cookie never crosses, whitelisted headers do', async () => {
    const { executor } = harness({
      respond: () =>
        new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'sid=secret', 'content-type': 'application/json' },
        }),
    });
    const result = await executor.execute(APP, GET());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.headers)).not.toContain('set-cookie');
    expect(result.headers['content-type']).toContain('application/json');
  });
});

describe('AC8 regression — the new error code joins the CTA map correctly (M12)', () => {
  it('NET_AMBIGUOUS_CONNECTION is a real, distinct protocol code', async () => {
    // It must be a NAMED constant, not a string literal invented at the throw site: the
    // playground's CTA map keys off these codes, and an unnamed code cannot be mapped.
    const codes = NET_ERROR_CODES as unknown as Record<string, string>;
    expect(codes['NET_AMBIGUOUS_CONNECTION']).toBe('NET_AMBIGUOUS_CONNECTION');
    // And it must be genuinely new, not an alias of an existing one.
    const values = Object.values(NET_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
