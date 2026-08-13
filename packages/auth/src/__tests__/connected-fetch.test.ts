// P3 CUTOVER: the FIXTURES moved from the v3 `snug_auth_specs` reader (deleted with that
// table at userdb v5) to the v4 `snug_connections` reader. Every ASSERTION below is
// unchanged, and that is the whole reason this file was migrated rather than deleted:
// these are the C1 injection gates — credential-header stripping, body scrubbing, the
// redirect block, the size cap, host-assigned binding — and a cutover of the READER must
// not quietly change which traffic they apply to.
//
// AL-03 plan D2/D3 — the connected-fetch executor, one test per enforcement gate in the
// pinned D3 order, all at the executor altitude with a fake fetch. Amendments under
// test: A1 (https-only — the http-localhost exception is dead), B1 (response cap →
// small terminal NET_SIZE_EXCEEDED, boundary cap−1/cap/cap+1), B3 (punycode both sides
// at check time), R2 (GET/HEAD body), R5 (host-assigned binding; strict input), C1
// (app-supplied credential headers stripped before fetchImpl; injected values scrubbed
// from bodies AND whitelisted headers), A2 (set-cookie never crosses).
import {
  CONNECTION_STATUS,
  LIMITS,
  NET_ERROR_CODES,
  deriveConnectionAllowedHosts,
  type ConnectionRequirement,
  type ConnectionStatus,
} from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '@snugprotocol/db';
import { createConnectedFetch, executeConnectionTestRequest, type ConnectedFetch, type NetConnectionRow } from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

// ---------------------------------------------------------------------- fixtures

const APP = 'app-net';
const SLOT = 'example';

const apiKeySpec: ConnectionRequirement = {
  slot: SLOT,
  kind: 'api_key',
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

/**
 * v4 rows carry an `imported` flag rather than v3's `imported_unapproved` STATUS, so the
 * old three-value status maps onto (status, imported). The distinction is preserved, not
 * flattened: the executor still owes NET_IMPORTED_UNAPPROVED its own code.
 */
function rowFor(
  requirement: ConnectionRequirement,
  status: 'approved' | 'unapproved' | 'imported_unapproved',
  allowedHosts?: string[],
): NetConnectionRow {
  const persisted: ConnectionStatus =
    status === 'approved' ? CONNECTION_STATUS.approved : CONNECTION_STATUS.declared;
  return {
    appId: APP,
    slot: requirement.slot,
    requirement,
    status: persisted,
    allowedHosts: allowedHosts ?? deriveConnectionAllowedHosts(requirement),
    ...(status === 'imported_unapproved' ? { imported: true } : {}),
  };
}

const API_KEY_VALUE = 'stored-key-abc123';

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

interface Harness {
  executor: ConnectedFetch;
  calls: FetchCall[];
  /**
   * Calls that took the PINNED LAN transport (ADR-0023 D3). Empty everywhere
   * except the LAN describe block — every other test in this file asserts on
   * `calls`, and a request that quietly moved to this seat would show up as an
   * empty `calls` array rather than as a passing test.
   */
  lanCalls: FetchCall[];
  quartet: ReturnType<typeof memoryQuartet>;
  confirm: ReturnType<typeof vi.fn>;
  setRow(appId: string, row: NetConnectionRow | undefined): void;
}

function harness(opts: {
  spec?: ConnectionRequirement;
  status?: 'approved' | 'unapproved' | 'imported_unapproved';
  allowedHosts?: string[];
  respond?: (url: string, init: RequestInit) => Response;
  confirmResult?: boolean;
  /** Decision 6 (desktop LAN policy) — absent everywhere else so every other test pins the browser profile. */
  transportPolicy?: { allowHttpForPrivateHosts: boolean };
  /**
   * Record a TOFU pin in the connection's `_connection` KV (ADR-0023 D3), so an
   * https LAN request can take the pinned transport. Absent by default: a
   * pinless LAN row is the honest pre-pairing state and every test outside the
   * LAN block should never come near this path.
   */
  withLanPin?: boolean;
} = {}): Harness {
  const quartet = memoryQuartet();
  // SLOT-KEYED (P1): `auth:<appId>:<slot>:<fieldKey>`.
  quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), API_KEY_VALUE);
  if (opts.withLanPin === true) {
    quartet.setSecret(
      authConnectionStateSecretKey(APP, SLOT),
      JSON.stringify({ status: 'connected', lanPin: { fingerprint: 'a'.repeat(64), cn: 'ECB5FAFFFE123456' } }),
    );
  }
  const rows = new Map<string, NetConnectionRow>();
  rows.set(APP, rowFor(opts.spec ?? apiKeySpec, opts.status ?? 'approved', opts.allowedHosts ?? ['api.example.com']));
  const calls: FetchCall[] = [];
  const lanCalls: FetchCall[] = [];
  const respond = opts.respond ?? (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const confirm = vi.fn(async () => opts.confirmResult ?? true);
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: {
      listConnections: (appId) => {
        const row = rows.get(appId);
        return row === undefined ? [] : [row];
      },
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    },
    // The pinned LAN transport is wired UNCONDITIONALLY here (a desktop shell
    // always supplies it) and records into its own array. Sharing `calls` would
    // make a request that silently switched transports invisible — the exact
    // drift the migrated test above exists to catch.
    lanFetch: async (url: string, init: RequestInit) => {
      lanCalls.push({ url, init });
      return respond(url, init);
    },
    confirmGate: { confirm },
    ...(opts.transportPolicy !== undefined ? { transportPolicy: opts.transportPolicy } : {}),
  });
  return {
    executor,
    calls,
    lanCalls,
    quartet,
    confirm,
    setRow: (appId, row) => (row === undefined ? void rows.delete(appId) : void rows.set(appId, row)),
  };
}

const GET = (url = 'https://api.example.com/v1/data'): { url: string; method: 'GET' } => ({ url, method: 'GET' });

const headerOf = (call: FetchCall, name: string): string | undefined => {
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ gate 1: shape

describe('gate 1 — request shape (zod, fail closed)', () => {
  it('rejects unknown fields — an app-supplied appId-like field never reaches routing (R5)', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { ...GET(), appId: 'other-app' } as never);
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_INVALID_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it('rejects a body on GET/HEAD (R2) and unknown methods', async () => {
    const { executor, calls } = harness();
    expect(await executor.execute(APP, { ...GET(), body: 'x' } as never)).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_INVALID_REQUEST });
    expect(await executor.execute(APP, { url: 'https://api.example.com/', method: 'TRACE' } as never)).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_INVALID_REQUEST,
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects an unparseable URL', async () => {
    const { executor } = harness();
    expect(await executor.execute(APP, { url: 'not a url', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_INVALID_REQUEST,
    });
  });

  it('enforces the request-body BYTE cap (multibyte chars under the char cap still count)', async () => {
    const { executor, calls } = harness();
    // 100k chars → ~300k bytes: inside any char-count bound, over the 256 KiB byte cap.
    const body = '€'.repeat(100_000);
    const result = await executor.execute(APP, { url: 'https://api.example.com/x', method: 'POST', body });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SIZE_EXCEEDED });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------- gates 2+3: binding + status

describe('gates 2+3 — host-assigned binding, spec existence, status gating (AL-02 contract)', () => {
  it('uses ONLY the host-passed binding: an unknown appId is NET_NOT_APPROVED, no fetch', async () => {
    const { executor, calls } = harness();
    expect(await executor.execute('some-other-app', GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(calls).toHaveLength(0);
  });

  it('bars an unapproved spec (status literal from AUTH_SPEC_STATUS)', async () => {
    const { executor, calls } = harness({ status: 'unapproved' });
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(calls).toHaveLength(0);
  });

  it('bars imported_unapproved with the DISTINCT error the settings panel can name', async () => {
    const { executor, calls } = harness({ status: 'imported_unapproved' });
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED });
    expect(calls).toHaveLength(0);
  });
});

// -------------------------------------------------- gate 4: scheme + host ceiling

describe('gate 4 — https-only scheme + frozen-host ceiling (A1/B3)', () => {
  it('A1: http is blocked even for localhost dev hosts sitting IN the frozen set — the exception is dead', async () => {
    const { executor, calls } = harness({ allowedHosts: ['localhost', 'api.example.com'] });
    expect(await executor.execute(APP, { url: 'http://localhost:8787/dev', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(await executor.execute(APP, { url: 'http://api.example.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('blocks non-http(s) schemes outright', async () => {
    const { executor } = harness();
    expect(await executor.execute(APP, { url: 'ftp://api.example.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
  });

  /**
   * THE REFUSAL IS UNCHANGED; ONLY THE CODE'S NAME MOVED (P1, restated at the P3 cutover).
   * v3 read one app-keyed row and could say "this host violates THAT row's ceiling" —
   * NET_HOST_BLOCKED. v4 ROUTES BY HOST, so an off-ceiling host matches no row at all:
   * there is no ceiling that was violated, only a host nothing was ever approved for, and
   * NET_NOT_APPROVED is the honest name for that. The security property under test is
   * identical and is carried by the `calls` assertion below — every one of these URLs,
   * suffix tricks included, is refused with ZERO fetches.
   */
  it('blocks a host outside the frozen ceiling, including suffix tricks', async () => {
    const { executor, calls } = harness();
    for (const url of [
      'https://evil.example/steal',
      'https://api.example.com.evil.com/x', // suffix trick — exact hostname match only
      'https://apiXexample.com/x'.replace('X', '-'),
    ]) {
      expect(await executor.execute(APP, { url, method: 'GET' })).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    }
    expect(calls).toHaveLength(0);
  });

  it('B3: a stored-UNICODE ceiling entry matches its punycoded request host at check time', async () => {
    const { executor, calls } = harness({ allowedHosts: ['api.münchen.example'] });
    const result = await executor.execute(APP, { url: 'https://api.xn--mnchen-3ya.example/v1', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('case and port do not defeat the ceiling match (hostname-exact, case-insensitive)', async () => {
    const { executor, calls } = harness();
    expect((await executor.execute(APP, { url: 'https://API.EXAMPLE.COM/x', method: 'GET' })).ok).toBe(true);
    expect((await executor.execute(APP, { url: 'https://api.example.com:8443/x', method: 'GET' })).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('rejects URLs with embedded credentials', async () => {
    const { executor } = harness();
    expect(await executor.execute(APP, { url: 'https://user:pass@api.example.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_INVALID_REQUEST,
    });
  });
});

// ------------------------------------------------------------- gate 5: SSRF guard

describe('gate 5 — SSRF literal guard (honest browser edition)', () => {
  it('blocks a private/loopback literal EVEN when the user approved it into the ceiling', async () => {
    const { executor, calls } = harness({ allowedHosts: ['127.0.0.1', '[::1]', 'internal-db.local', '169.254.169.254'] });
    for (const url of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://internal-db.local/x', 'https://169.254.169.254/latest/meta-data']) {
      expect(await executor.execute(APP, { url, method: 'GET' })).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SSRF_BLOCKED });
    }
    expect(calls).toHaveLength(0);
  });
});

// --------------------------------- desktop transport policy (Decision 6, gates 4+5)

/**
 * TASK-20260812-desktop-hub-scaffold Decision 6 — the LAN/Hue-class scheme policy.
 *
 * The policy's ENTIRE behavioural delta: with `allowHttpForPrivateHosts: true`, an
 * RFC-1918 private-range IPv4 LITERAL host may be reached (http admitted at gate 4,
 * gate 5's private-range refusal stood down for exactly that class) — and ONLY when the
 * frozen approved ceiling already contains it (gates 2+3 run unchanged). Everything
 * else — public hosts, loopback, link-local, `localhost`, name suffixes, IPv6 in any
 * form, every request with the policy absent — is byte-identical to the browser profile.
 */
describe('desktop transport policy — LAN http for private IPv4 literals (Decision 6)', () => {
  const LAN_HOST = '192.168.1.5';
  const POLICY_ON = { allowHttpForPrivateHosts: true } as const;

  it('policy ABSENT: an http private-IP request is refused exactly as today (NET_SCHEME_BLOCKED, no fetch)', async () => {
    const { executor, calls } = harness({ allowedHosts: [LAN_HOST] });
    expect(await executor.execute(APP, { url: `http://${LAN_HOST}/api/lights`, method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('policy FALSE is the same as absent — no half-on state', async () => {
    const { executor, calls } = harness({ allowedHosts: [LAN_HOST], transportPolicy: { allowHttpForPrivateHosts: false } });
    expect(await executor.execute(APP, { url: `http://${LAN_HOST}/api/lights`, method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('policy ON: http to a PUBLIC hostname stays refused — the admission never reaches DNS names', async () => {
    const { executor, calls } = harness({ transportPolicy: POLICY_ON });
    expect(await executor.execute(APP, { url: 'http://api.example.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('policy ON: http to a private literal IN the approved ceiling executes through fetchImpl, gates intact', async () => {
    const { executor, calls } = harness({ allowedHosts: [LAN_HOST], transportPolicy: POLICY_ON });
    const result = await executor.execute(APP, { url: `http://${LAN_HOST}/api/lights`, method: 'GET' });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://${LAN_HOST}/api/lights`);
    // The request is still the full 10-gate path: injection ran (gate 8)…
    expect(headerOf(calls[0]!, 'x-api-key')).toBe(API_KEY_VALUE);
    // …and the redirect posture survived the scheme admission (gate 9).
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('policy ON: a private literal NOT in the ceiling is still refused — the frozen ceiling rules', async () => {
    const { executor, calls } = harness({ allowedHosts: [LAN_HOST], transportPolicy: POLICY_ON });
    expect(await executor.execute(APP, { url: 'http://192.168.1.6/api/lights', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
    expect(calls).toHaveLength(0);
  });

  it('policy ON: loopback, link-local, localhost, and .local stay refused over http — never exempted', async () => {
    // Every host is seeded INTO the ceiling so the refusal proven here is the scheme/SSRF
    // gate's own, not the ceiling's.
    const hosts = ['127.0.0.1', '169.254.1.1', 'localhost', 'foo.local'];
    const { executor, calls } = harness({ allowedHosts: hosts, transportPolicy: POLICY_ON });
    for (const host of hosts) {
      expect(await executor.execute(APP, { url: `http://${host}/x`, method: 'GET' }), `http://${host} must be refused`).toMatchObject({
        ok: false,
        code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('policy ON: loopback/link-local stay SSRF-refused over https too — the stand-down is only the RFC-1918 class', async () => {
    const { executor, calls } = harness({ allowedHosts: ['127.0.0.1', '169.254.169.254'], transportPolicy: POLICY_ON });
    for (const url of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data']) {
      expect(await executor.execute(APP, { url, method: 'GET' }), `${url} must be refused`).toMatchObject({
        ok: false,
        code: NET_ERROR_CODES.NET_SSRF_BLOCKED,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('policy ON: non-http(s) schemes stay refused even for the admitted host class', async () => {
    const { executor, calls } = harness({ allowedHosts: [LAN_HOST], transportPolicy: POLICY_ON });
    expect(await executor.execute(APP, { url: `ftp://${LAN_HOST}/x`, method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('policy ON: https to a public host is byte-identical to today', async () => {
    const { executor, calls } = harness({ transportPolicy: POLICY_ON });
    expect((await executor.execute(APP, GET())).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0]!, 'x-api-key')).toBe(API_KEY_VALUE);
  });

  /**
   * MIGRATED at P5 (ADR-0023 D3) — the gate semantics are UNCHANGED and still
   * asserted here; what moved is which transport an admitted https LAN request
   * lands on.
   *
   * When this test was written, `fetchImpl` was the only transport that existed,
   * so "gate 5 stood down and the request went out" and "it went out through
   * fetchImpl" were the same observation. ADR-0023 separates them: an https LAN
   * host is a device serving a private-CA certificate, which the public-root
   * transport cannot verify, so it now rides the pinned `lanFetch` seat. The
   * http rung this describe block is named for is untouched (see the test above
   * it, which still asserts `calls`).
   *
   * Both halves of the original claim survive verbatim: policy ON admits the
   * request, policy ABSENT still refuses it with NET_SSRF_BLOCKED and sends
   * nothing anywhere. The `lan-pinned-transport.test.ts` suite owns the routing
   * detail; this one keeps owning the GATE.
   */
  it('policy ON: https to an approved private literal is admitted by the gates (Hue v2 speaks https) — policy ABSENT it stays SSRF-refused', async () => {
    const on = harness({ allowedHosts: [LAN_HOST], transportPolicy: POLICY_ON, withLanPin: true });
    expect((await on.executor.execute(APP, { url: `https://${LAN_HOST}/clip/v2`, method: 'GET' })).ok).toBe(true);
    // Admitted — and carried by the PINNED transport, never the public-root one.
    expect(on.lanCalls).toHaveLength(1);
    expect(on.calls, 'an https LAN host must not ride the public-root transport').toHaveLength(0);

    const off = harness({ allowedHosts: [LAN_HOST] });
    expect(await off.executor.execute(APP, { url: `https://${LAN_HOST}/clip/v2`, method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SSRF_BLOCKED,
    });
    expect(off.calls).toHaveLength(0);
    expect(off.lanCalls).toHaveLength(0);
  });

  it('octet-boundary correctness at the executor: 172.16/172.31 admitted, 172.15/172.32 refused', async () => {
    for (const [host, admitted] of [
      ['172.16.0.1', true],
      ['172.31.255.254', true],
      ['172.15.255.255', false],
      ['172.32.0.1', false],
    ] as const) {
      const { executor, calls } = harness({ allowedHosts: [host], transportPolicy: POLICY_ON });
      const result = await executor.execute(APP, { url: `http://${host}/x`, method: 'GET' });
      if (admitted) {
        expect(result.ok, `http://${host} must execute`).toBe(true);
        expect(calls).toHaveLength(1);
      } else {
        expect(result, `http://${host} must be refused`).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SCHEME_BLOCKED });
        expect(calls).toHaveLength(0);
      }
    }
  });

  /**
   * MIGRATED at P5 (ADR-0023 D3), same shape as the https test above: the CLAIM
   * — "the probe shares the executor's deps, so the LAN policy rides along with
   * no second wiring seat" — is unchanged and still the thing under test. What
   * moved is that the probe's https LAN request now lands on the pinned
   * transport, so the deps carry a `lanFetch` and a recorded pin, and the
   * assertion follows the request to where it actually goes.
   *
   * The negative half is untouched: with the policy ABSENT the probe is still
   * refused and still sends nothing, on either transport.
   */
  it('executeConnectionTestRequest carries the policy through — the probe reaches an approved LAN host only under policy', async () => {
    const lanRequirement: ConnectionRequirement = {
      slot: 'hue',
      kind: 'api_key',
      provider: { name: 'Hue Bridge' },
      fields: [{ key: 'api_key', label: 'Application key', type: 'secret' }],
      request: { headerTemplate: { 'hue-application-key': '{{api_key}}' } },
      declaredApiHosts: [LAN_HOST],
      testRequest: { method: 'GET', pathAndQuery: '/clip/v2/resource/bridge' },
    };
    const depsFor = (policy: { allowHttpForPrivateHosts: boolean } | undefined): {
      deps: Parameters<typeof executeConnectionTestRequest>[0];
      calls: FetchCall[];
    } => {
      const quartet = memoryQuartet();
      quartet.setSecret(authConnectionCredentialSecretKey(APP, 'hue', 'api_key'), API_KEY_VALUE);
      quartet.setSecret(
        authConnectionStateSecretKey(APP, 'hue'),
        JSON.stringify({ status: 'connected', lanPin: { fingerprint: 'a'.repeat(64), cn: 'bridge' } }),
      );
      // ONE array for BOTH transports here, deliberately: this test's claim is
      // about the POLICY reaching the probe at all, not about which seat carries
      // it (the migrated test above owns that, and lan-pinned-transport.test.ts
      // owns the routing in full). Merging them keeps the original assertion —
      // "exactly one request went out, to this URL" — literally intact.
      const calls: FetchCall[] = [];
      return {
        deps: {
          credentialStore: new UserDbCredentialStore(quartet),
          connectionReader: { listConnections: () => [rowFor(lanRequirement, 'approved', [LAN_HOST])] },
          fetchImpl: async (url: string, init?: RequestInit) => {
            calls.push({ url, init: init ?? {} });
            return new Response('{"bridge":"ok"}', { status: 200 });
          },
          lanFetch: async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response('{"bridge":"ok"}', { status: 200 });
          },
          confirmGate: { confirm: async () => true },
          ...(policy !== undefined ? { transportPolicy: policy } : {}),
        },
        calls,
      };
    };

    const on = depsFor(POLICY_ON);
    const okResult = await executeConnectionTestRequest(on.deps, APP, 'hue');
    expect(okResult).toMatchObject({ ok: true, status: 200 });
    expect(on.calls).toHaveLength(1);
    expect(on.calls[0]!.url).toBe(`https://${LAN_HOST}/clip/v2/resource/bridge`);

    const off = depsFor(undefined);
    expect(await executeConnectionTestRequest(off.deps, APP, 'hue')).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SSRF_BLOCKED,
    });
    expect(off.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------ gate 6: confirm gate

describe('gate 6 — mutating-method confirm gate (open Q1)', () => {
  it('GET/HEAD never consult the gate', async () => {
    const { executor, confirm } = harness();
    await executor.execute(APP, GET());
    await executor.execute(APP, { url: 'https://api.example.com/x', method: 'HEAD' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a denied POST performs NO fetch at all — credentials are never even resolved', async () => {
    const { executor, calls, confirm, quartet } = harness({ confirmResult: false });
    const reads = vi.spyOn(quartet, 'getSecret');
    const result = await executor.execute(APP, { url: 'https://api.example.com/items', method: 'POST', body: '{}' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(confirm).toHaveBeenCalledWith({ appId: APP, host: 'api.example.com', method: 'POST', url: 'https://api.example.com/items' });
    expect(calls).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
  });

  it('a granted POST proceeds', async () => {
    const { executor, calls } = harness({ confirmResult: true });
    expect((await executor.execute(APP, { url: 'https://api.example.com/items', method: 'POST', body: '{}' })).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// ------------------------------------------------------- gate 7: header stripping

describe('gate 7 — app-supplied credential-shaped headers are ALWAYS stripped (C1)', () => {
  it('Authorization/Cookie/Proxy-Authorization/api-key-pattern headers never reach fetchImpl; the injected value wins', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, {
      url: 'https://api.example.com/v1/data',
      method: 'GET',
      headers: {
        Authorization: 'Bearer app-forged-token',
        Cookie: 'session=stolen',
        'Proxy-Authorization': 'Basic forged',
        'X-Api-Key': 'app-forged-key',
        'x-goog-api-key': 'forged-too',
        Accept: 'application/json',
      },
    });
    expect(result.ok).toBe(true);
    const call = calls[0]!;
    const names = Object.keys((call.init.headers ?? {}) as Record<string, string>).map((n) => n.toLowerCase());
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('proxy-authorization');
    expect(names).not.toContain('x-goog-api-key');
    expect(headerOf(call, 'accept')).toBe('application/json');
    // The ONLY X-Api-Key/Authorization values present are the injected ones.
    expect(headerOf(call, 'x-api-key')).toBe(API_KEY_VALUE);
    expect(headerOf(call, 'authorization')).toBeUndefined();
    const serialized = JSON.stringify(call.init.headers);
    expect(serialized).not.toContain('app-forged-token');
    expect(serialized).not.toContain('app-forged-key');
    expect(serialized).not.toContain('stolen');
  });
});

// ------------------------------------------------------------- gate 8: injection

describe('gate 8 — credential injection per kind (values read PER USE, AL-02 D4)', () => {
  it('api_key: renders the header template with the stored value', async () => {
    const { executor, calls } = harness();
    expect((await executor.execute(APP, GET())).ok).toBe(true);
    expect(headerOf(calls[0]!, 'x-api-key')).toBe(API_KEY_VALUE);
  });

  it('re-reads the store on every call — no cached credential serves a later request', async () => {
    const { executor, calls, quartet } = harness();
    await executor.execute(APP, GET());
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), 'rotated-key-xyz789');
    await executor.execute(APP, GET());
    expect(headerOf(calls[1]!, 'x-api-key')).toBe('rotated-key-xyz789');
  });

  it('bearer_token without a template defaults to Authorization: Bearer <field[0]>', async () => {
    const spec: ConnectionRequirement = {
      slot: SLOT,
      kind: 'bearer_token',
      provider: { name: 'Tok' },
      fields: [{ key: 'token', label: 'Token', type: 'secret' }],
      declaredApiHosts: ['api.example.com'],
    };
    const { executor, calls, quartet } = harness({ spec });
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'token'), 'bearer-value-123');
    expect((await executor.execute(APP, GET())).ok).toBe(true);
    expect(headerOf(calls[0]!, 'authorization')).toBe('Bearer bearer-value-123');
  });

  it('basic_auth without a template defaults to Authorization: Basic base64(user:pass)', async () => {
    const spec: ConnectionRequirement = {
      slot: SLOT,
      kind: 'basic_auth',
      provider: { name: 'Basic' },
      fields: [
        { key: 'username', label: 'User', type: 'text' },
        { key: 'password', label: 'Pass', type: 'password' },
      ],
      declaredApiHosts: ['api.example.com'],
    };
    const { executor, calls, quartet } = harness({ spec });
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'username'), 'alice');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'password'), 'p4ss:w0rd');
    expect((await executor.execute(APP, GET())).ok).toBe(true);
    expect(headerOf(calls[0]!, 'authorization')).toBe(`Basic ${btoa('alice:p4ss:w0rd')}`);
  });

  it('a missing required credential is NET_AUTH_FAILED with no fetch', async () => {
    const { executor, calls, quartet } = harness();
    quartet.deleteSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'));
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('oauth2_auth_code: injects Bearer <access_token> from the store', async () => {
    const spec: ConnectionRequirement = {
      slot: SLOT,
      kind: 'oauth2_auth_code',
      provider: { name: 'Spotify' },
      endpoints: { authorizeUrl: 'https://accounts.example.com/authorize', tokenUrl: 'https://accounts.example.com/token' },
      fields: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
      declaredApiHosts: ['api.example.com'],
    };
    const { executor, calls, quartet } = harness({ spec, allowedHosts: ['api.example.com', 'accounts.example.com'] });
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'access_token'), 'oauth-access-token-1');
    quartet.setSecret(
      authConnectionStateSecretKey(APP, SLOT),
      JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }),
    );
    expect((await executor.execute(APP, GET())).ok).toBe(true);
    expect(headerOf(calls[0]!, 'authorization')).toBe('Bearer oauth-access-token-1');
  });

  it('oauth 401 → ONE transparent refresh through the frozen ceiling → retried with the new token', async () => {
    const spec: ConnectionRequirement = {
      slot: SLOT,
      kind: 'oauth2_auth_code',
      provider: { name: 'Spotify' },
      endpoints: {
        authorizeUrl: 'https://accounts.example.com/authorize',
        tokenUrl: 'https://accounts.example.com/token',
        refreshUrl: 'https://accounts.example.com/token',
      },
      fields: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
      declaredApiHosts: ['api.example.com'],
    };
    let apiCalls = 0;
    const { executor, calls, quartet } = harness({
      spec,
      allowedHosts: ['api.example.com', 'accounts.example.com'],
      respond: (url) => {
        if (url.startsWith('https://accounts.example.com/token')) {
          return new Response(JSON.stringify({ access_token: 'refreshed-token-2', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        apiCalls += 1;
        return apiCalls === 1
          ? new Response('unauthorized', { status: 401 })
          : new Response('{"fine":true}', { status: 200 });
      },
    });
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'access_token'), 'stale-token-1');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'refresh_token'), 'refresh-token-1');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'client_id'), 'client-1');
    quartet.setSecret(
      authConnectionStateSecretKey(APP, SLOT),
      JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }),
    );
    const result = await executor.execute(APP, GET());
    expect(result).toMatchObject({ ok: true, status: 200 });
    // call order: api (401) → refresh POST → api retry with the refreshed token
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/v1/data',
      'https://accounts.example.com/token',
      'https://api.example.com/v1/data',
    ]);
    expect(headerOf(calls[2]!, 'authorization')).toBe('Bearer refreshed-token-2');
  });

  it('static kinds surface a 401 as-is — exactly one fetch, no refresh attempt', async () => {
    const { executor, calls } = harness({ respond: () => new Response('nope', { status: 401 }) });
    const result = await executor.execute(APP, GET());
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(calls).toHaveLength(1);
  });
});

// -------------------------------------------------------- gate 9: redirect posture

describe('gate 9 — redirects are never followed (B2 posture, net side)', () => {
  it('passes redirect:manual to fetchImpl and maps a 30x to NET_REDIRECT_BLOCKED', async () => {
    const { executor, calls } = harness({
      respond: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/exfil' } }),
    });
    const result = await executor.execute(APP, GET());
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_REDIRECT_BLOCKED });
    expect(calls).toHaveLength(1); // the Location target is NEVER fetched
    expect(calls[0]!.init.redirect).toBe('manual');
  });
});

// --------------------------------------------------- gate 10: size cap + scrubbing

describe('gate 10 — response size cap (B1) and the scrubber (D4/R1/A2)', () => {
  const CAP = LIMITS.MAX_NET_RESPONSE_BODY_BYTES;
  const bodyOf = (n: number): Response => new Response('x'.repeat(n), { status: 200 });

  it('boundary: cap−1 and cap deliver; cap+1 is a SMALL terminal NET_SIZE_EXCEEDED with NO partial body', async () => {
    for (const [size, delivered] of [
      [CAP - 1, true],
      [CAP, true],
      [CAP + 1, false],
    ] as const) {
      const { executor } = harness({ respond: () => bodyOf(size) });
      const result = await executor.execute(APP, GET());
      if (delivered) {
        expect(result.ok, `${size} bytes must deliver`).toBe(true);
        if (result.ok) expect(result.body).toHaveLength(size);
      } else {
        expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SIZE_EXCEEDED });
        expect(JSON.stringify(result)).not.toContain('xxxx'); // no partial payload rides the error
      }
    }
  });

  it('scrubs every injected header VALUE from the body before it crosses (C1 negative)', async () => {
    const { executor } = harness({
      respond: () =>
        new Response(JSON.stringify({ echoedHeaders: { 'x-api-key': API_KEY_VALUE }, note: `saw ${API_KEY_VALUE}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await executor.execute(APP, GET());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_KEY_VALUE);
    if (result.ok) expect(result.body).toContain('***');
  });

  it('R1: scrubs injected values planted in WHITELISTED response headers', async () => {
    const { executor } = harness({
      respond: () =>
        new Response('{}', {
          status: 200,
          headers: {
            etag: `W/"${API_KEY_VALUE}"`,
            'cache-control': `no-store, probe=${API_KEY_VALUE}`,
            'x-ratelimit-remaining': `10;k=${API_KEY_VALUE}`,
          },
        }),
    });
    const result = await executor.execute(APP, GET());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_KEY_VALUE);
  });

  it('A2: set-cookie (and every non-whitelisted header) never crosses; whitelisted ones do', async () => {
    const { executor } = harness({
      respond: () =>
        new Response('{}', {
          status: 200,
          headers: {
            'set-cookie': 'session=server-secret; HttpOnly',
            'content-type': 'application/json',
            etag: '"v1"',
            'x-ratelimit-remaining': '9',
            'x-powered-by': 'leaky-server',
            link: '<https://api.example.com/page2>; rel="next"',
          },
        }),
    });
    const result = await executor.execute(APP, GET());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = Object.keys(result.headers);
    expect(names).not.toContain('set-cookie');
    expect(names).not.toContain('x-powered-by');
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers.etag).toBe('"v1"');
    expect(result.headers['x-ratelimit-remaining']).toBe('9');
    expect(result.headers.link).toContain('rel="next"');
    expect(JSON.stringify(result)).not.toContain('server-secret');
  });

  it('non-2xx statuses are deliveries, not envelope errors (the app sees the real status)', async () => {
    const { executor } = harness({ respond: () => new Response('missing', { status: 404 }) });
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: true, status: 404, body: 'missing' });
  });

  it('a thrown fetch (network/timeout) maps to NET_FETCH_FAILED, retryable', async () => {
    const quartet = memoryQuartet();
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), API_KEY_VALUE);
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(quartet),
      connectionReader: { listConnections: () => [rowFor(apiKeySpec, 'approved')] },
      fetchImpl: async () => {
        throw new TypeError('network down');
      },
      confirmGate: { confirm: async () => true },
    });
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_FETCH_FAILED, retryable: true });
  });
});

// --------------------------------------------------- optional fields (P5 BLOCKER)

/**
 * `required: false` FIELDS, END TO END.
 *
 * The defect these pin: two lints disagreed about which key list a header template is
 * legal against. The executor lints the requirement's DECLARED field keys
 * (`spec.fields.map(f => f.key)`); `renderAuthHeaderTemplate` then re-linted only the
 * keys whose values were actually LOADED. A declared-but-blank OPTIONAL field is absent
 * from the loaded set by design (the loader `continue`s past it), so every template
 * mentioning that field passed the outer lint and was rejected by the inner one. The
 * wizard reported CONNECTED and every later request failed closed with NET_AUTH_FAILED
 * and zero fetches — precisely the "shows connected, fails later" outcome the
 * credential-save path claims to have closed.
 *
 * MIGRATED 2026-08-13 (TASK-20260812-desktop-auth-awareness P3): these tests originally
 * rode the SHIPPED Coinbase entry, whose `passphrase` was the founding `required: false`
 * example. The CDP rewrite (ADR-0022 §5) removed that seat — the HMAC+passphrase scheme
 * described keys Coinbase expired 2025-02-05 — and no shipped entry currently declares
 * an optional field. The MECHANISM these pin is executor-altitude and unchanged (the
 * declared-vs-loaded lint disagreement lives in connected-fetch + template-engine, not
 * in registry data), so the spec moved to a fixture that declares the exact founding
 * shape: three fields, third one optional, a template that references it. Every
 * assertion is carried over verbatim; only the data source moved. If a shipped entry
 * ever declares an optional field again, add a companion premise test against it.
 */
describe('optional credential fields — declared but not stored', () => {
  const optionalFieldSpecFields: NonNullable<ConnectionRequirement['fields']> = [
    { key: 'api_key', label: 'API key', type: 'text' },
    { key: 'api_secret', label: 'API secret', type: 'secret' },
    { key: 'passphrase', label: 'Passphrase', type: 'secret', required: false },
  ];

  const coinbaseSpec: ConnectionRequirement = {
    slot: SLOT,
    kind: 'api_key',
    provider: { name: 'Meridian Exchange' },
    fields: optionalFieldSpecFields,
    request: {
      headerTemplate: {
        'CB-ACCESS-KEY': '{{api_key}}',
        'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
        'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
        'CB-ACCESS-SIGN':
          '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery)}}',
      },
    },
    declaredApiHosts: ['api.example.com'],
  };

  /** The fixture must keep its optional seat, or these tests silently stop testing it. */
  it('the fixture really does declare its third field as optional (premise pin)', () => {
    expect(optionalFieldSpecFields.find((f) => f.key === 'passphrase')?.required).toBe(false);
  });

  function coinbaseHarness(stored: Record<string, string>): Harness {
    const quartet = memoryQuartet();
    for (const [key, value] of Object.entries(stored)) {
      quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, key), value);
    }
    const calls: FetchCall[] = [];
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(quartet),
      connectionReader: { listConnections: () => [rowFor(coinbaseSpec, 'approved')] },
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      confirmGate: { confirm: async () => true },
    });
    // NO `lanFetch` is wired and `lanCalls` is permanently empty, and both are
    // STATED rather than optional-chained past: this fixture's host is
    // `api.example.com`, so the LAN path is unreachable by construction. If a
    // future edit points it at a private literal, the request will fail with the
    // named "only the desktop app can reach it" refusal rather than quietly
    // taking a transport this harness never configured.
    return { executor, calls, lanCalls: [], quartet, confirm: vi.fn(), setRow: () => {} };
  }

  it('SENDS the request with the optional header empty when the field was left blank', async () => {
    const { executor, calls } = coinbaseHarness({ api_key: 'KEY123', api_secret: 'c2VjcmV0' });

    const result = await executor.execute(APP, GET());

    // The whole point: this used to be NET_AUTH_FAILED with zero fetches.
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0]!, 'CB-ACCESS-KEY')).toBe('KEY123');
    // Declared-but-unstored optional field resolves to empty, not to a throw.
    expect(headerOf(calls[0]!, 'CB-ACCESS-PASSPHRASE')).toBe('');
  });

  it('signs over the SAME memoized timestamp it sends, even with the optional field blank', async () => {
    const { executor, calls } = coinbaseHarness({ api_key: 'KEY123', api_secret: 'c2VjcmV0' });
    await executor.execute(APP, GET());

    const sent = headerOf(calls[0]!, 'CB-ACCESS-TIMESTAMP')!;
    const sign = headerOf(calls[0]!, 'CB-ACCESS-SIGN')!;
    expect(sent).toMatch(/^\d+$/);
    expect(sign).not.toBe('');

    // Recompute the signature over the timestamp that was actually sent. If the engine
    // had evaluated `request.timestamp` twice, these would disagree across a second
    // boundary — the memoization and the optional-field fix must not have broken it.
    //
    // `hmac_sha256_b64` base64-DECODES its secret argument before signing (the fused
    // Coinbase-Exchange shape), so the key here is the decoded bytes of 'c2VjcmV0'.
    const secretBytes = Uint8Array.from(atob('c2VjcmV0'), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${sent}GET/v1/data`)),
    );
    const expected = btoa(String.fromCharCode(...mac));
    expect(sign).toBe(expected);
  });

  it('a REQUIRED field that is missing still fails closed — the fix did not widen to required fields', async () => {
    const { executor, calls } = coinbaseHarness({ api_key: 'KEY123' }); // api_secret absent
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('a token naming NO declared field is still rejected — the typo guard survives', async () => {
    const typoSpec: ConnectionRequirement = {
      ...coinbaseSpec,
      request: { headerTemplate: { 'X-Typo': '{{passphrasee}}' } },
    };
    const quartet = memoryQuartet();
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), 'KEY123');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_secret'), 'c2VjcmV0');
    const calls: FetchCall[] = [];
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(quartet),
      connectionReader: { listConnections: () => [rowFor(typoSpec, 'approved')] },
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return new Response('{}', { status: 200 });
      },
      confirmGate: { confirm: async () => true },
    });
    expect(await executor.execute(APP, GET())).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(calls).toHaveLength(0);
  });
});
