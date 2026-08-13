// The LAN pinned-TLS transport seam (ADR-0023 Decision 3; P0 amendment 6).
//
// WHAT THIS FILE IS ABOUT. A Hue-class bridge answers at a user-supplied
// RFC-1918 IPv4 literal over TLS it signs itself. Reaching it needs a transport
// that trusts a recorded certificate pin — which the browser cannot have and
// must never have. So the desktop shell contributes an OPTIONAL second dep,
// `lanFetch(url, init, pin)`, beside `fetchImpl`, and THE EXECUTOR decides which
// one carries each request, at gates 4/5 where `lanPrivateHost` is already
// computed and the frozen ceiling is already known.
//
// The routing decision lives here rather than in the platform for one reason:
// "pinned trust only for RFC-1918 literals inside the ceiling" is a statement
// about the CEILING, and the ceiling is knowable only at this altitude. A
// platform-level router would have to re-derive it and could drift.
//
// THE GUARD RE-PROOF (lessons.md 2026-08-12 — a guard expressed as a FLAG is
// only as real as the transport's willingness to read it). The desktop redirect
// incident is the precedent: connected-fetch passed `redirect: 'manual'` and
// tauri-plugin-http silently dropped it, so the guard was a comment. Passing the
// same `init` object to a NEW transport does not carry the old transport's
// semantics with it. Hence the two re-proof describes below: a redirecting
// simulated bridge must still yield NET_REDIRECT_BLOCKED, and an oversized body
// must still yield NET_SIZE_EXCEEDED, driven THROUGH the lanFetch path.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NET_ERROR_CODES, type ConnectionRequirement } from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '@snugprotocol/db';

import { createConnectedFetch, type NetConnectionRow } from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

const APP = 'app-hue';
const SLOT = 'hue';
const BRIDGE = '192.168.1.50';
const PIN = 'a'.repeat(64);

/** The hue-shaped requirement: LAN class, one minted secret, the CLIP v2 header. */
const hueRequirement: ConnectionRequirement = {
  slot: SLOT,
  provider: { name: 'Philips Hue' },
  kind: 'api_key',
  declaredApiHosts: [BRIDGE],
  lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
  fields: [{ key: 'application_key', label: 'Bridge application key', type: 'secret' }],
  request: { headerTemplate: { 'hue-application-key': '{{application_key}}' } },
};

/** A pinned-host requirement for the negative direction (a public API). */
const publicRequirement: ConnectionRequirement = {
  slot: SLOT,
  provider: { name: 'Example' },
  kind: 'api_key',
  declaredApiHosts: ['api.example.com'],
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  request: { headerTemplate: { 'x-api-key': '{{api_key}}' } },
};

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

type Call = { url: string; init: RequestInit; pin?: string };

interface Harness {
  execute(input: { url: string; method?: 'GET' | 'POST'; body?: string }): Promise<
    ReturnType<ReturnType<typeof createConnectedFetch>['execute']> extends Promise<infer R> ? R : never
  >;
  webCalls: Call[];
  lanCalls: Call[];
  quartet: ReturnType<typeof memoryQuartet>;
}

function harness(
  opts: {
    requirement?: ConnectionRequirement;
    allowedHosts?: string[];
    /** The `_connection` KV's recorded pin. `null` writes NO pin at all. */
    pin?: string | null;
    /** Desktop by default — the whole point of this file. */
    transportPolicy?: { allowHttpForPrivateHosts: boolean };
    /** Absent = a WEB platform: no LAN transport exists at all. */
    withLanFetch?: boolean;
    respond?: (url: string, init: RequestInit) => Response;
  } = {},
): Harness {
  const requirement = opts.requirement ?? hueRequirement;
  const quartet = memoryQuartet();
  quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'application_key'), 'minted-bridge-key');
  quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), 'public-api-key');
  if (opts.pin !== null) {
    quartet.setSecret(
      authConnectionStateSecretKey(APP, SLOT),
      JSON.stringify({ status: 'connected', lanPin: { fingerprint: opts.pin ?? PIN, cn: 'ECB5FAFFFE123456' } }),
    );
  }
  const row: NetConnectionRow = {
    appId: APP,
    slot: SLOT,
    requirement,
    status: 'approved',
    allowedHosts: opts.allowedHosts ?? (requirement.declaredApiHosts ?? []),
  };
  const respond =
    opts.respond ?? (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const webCalls: Call[] = [];
  const lanCalls: Call[] = [];
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: (appId) => (appId === APP ? [row] : []) },
    fetchImpl: async (url, init) => {
      webCalls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    },
    ...(opts.withLanFetch !== false
      ? {
          lanFetch: async (url: string, init: RequestInit, pin: string) => {
            lanCalls.push({ url, init, pin });
            return respond(url, init);
          },
        }
      : {}),
    confirmGate: { confirm: async () => true },
    ...(opts.transportPolicy !== undefined
      ? { transportPolicy: opts.transportPolicy }
      : { transportPolicy: { allowHttpForPrivateHosts: true } }),
  });
  return {
    execute: (input) => executor.execute(APP, input) as never,
    webCalls,
    lanCalls,
    quartet,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------- routing

describe('routing — the executor decides, at the gate that knows the ceiling', () => {
  it('an RFC-1918 literal inside the frozen ceiling routes to lanFetch, carrying the connection pin', async () => {
    const h = harness();
    const result = await h.execute({ url: `https://${BRIDGE}/clip/v2/resource/light` });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(h.lanCalls, 'the LAN transport must carry it').toHaveLength(1);
    expect(h.webCalls, 'the web transport must not see it at all').toHaveLength(0);
    expect(h.lanCalls[0]?.pin).toBe(PIN);
    expect(h.lanCalls[0]?.url).toBe(`https://${BRIDGE}/clip/v2/resource/light`);
  });

  it('the injected credential rides the LAN path exactly as it rides the web one (C1 unchanged)', async () => {
    const h = harness();
    await h.execute({ url: `https://${BRIDGE}/clip/v2/resource/light` });
    const headers = (h.lanCalls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers['hue-application-key']).toBe('minted-bridge-key');
  });

  it('a PUBLIC host can NEVER reach lanFetch, even with a pin recorded and the policy on', async () => {
    // THE NEGATIVE THAT MATTERS MOST: pinned trust is a property of the host
    // class, not of having a pin. A row that somehow carries one must not buy
    // relaxed certificate verification for api.example.com.
    const h = harness({ requirement: publicRequirement, allowedHosts: ['api.example.com'] });
    const result = await h.execute({ url: 'https://api.example.com/v1/data' });

    expect(result).toMatchObject({ ok: true });
    expect(h.lanCalls, 'a public host must never touch the pinned transport').toHaveLength(0);
    expect(h.webCalls).toHaveLength(1);
  });

  it('a private literal NOT in the frozen ceiling is refused outright — it never reaches either transport', async () => {
    const h = harness({ allowedHosts: [BRIDGE] });
    const result = await h.execute({ url: 'https://192.168.9.9/api' });

    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(h.lanCalls).toHaveLength(0);
    expect(h.webCalls).toHaveLength(0);
  });

  it('loopback is not the LAN class: it is refused, never routed to the pinned transport', async () => {
    const h = harness({ allowedHosts: ['127.0.0.1', BRIDGE] });
    const result = await h.execute({ url: 'https://127.0.0.1/api' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SSRF_BLOCKED });
    expect(h.lanCalls).toHaveLength(0);
  });

  it('WITHOUT the desktop transport policy (the web profile) a LAN host never routes to lanFetch', async () => {
    // Web platforms pass no policy. Even if a lanFetch dep were somehow present,
    // the host class the routing keys on is only computed under the policy.
    const h = harness({ transportPolicy: { allowHttpForPrivateHosts: false } });
    const result = await h.execute({ url: `https://${BRIDGE}/api` });

    expect(h.lanCalls, 'the web profile has no pinned path').toHaveLength(0);
    // It still fails the SSRF gate, exactly as it does today — byte-identical
    // web behavior is the AC10 promise.
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SSRF_BLOCKED });
  });

  it('with NO lanFetch dep at all, a LAN request fails honestly instead of silently falling back to the web fetch', async () => {
    // THE FALLBACK TRAP. `deps.lanFetch ?? deps.fetchImpl` would look tidy and
    // would send the bridge request through a transport that verifies against
    // the public root store — failing with an opaque TLS error the user cannot
    // act on, or worse, succeeding against something that ISN'T their bridge.
    const h = harness({ withLanFetch: false });
    const result = await h.execute({ url: `https://${BRIDGE}/api` });

    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(h.webCalls, 'the web transport must NOT be the fallback for a LAN host').toHaveLength(0);
    if (!result.ok) expect(result.message).toContain('desktop');
  });
});

// ---------------------------------------------------------------- the pin

describe('the pin — sourced from the connection dynamic-state KV (ADR-0014 custody)', () => {
  it('reads the pin from `auth:<appId>:<slot>:_connection`, never a db column', async () => {
    const h = harness({ pin: 'b'.repeat(64) });
    await h.execute({ url: `https://${BRIDGE}/api` });
    expect(h.lanCalls[0]?.pin).toBe('b'.repeat(64));
    // The key it actually read — pinned so a move to a column is a red test.
    expect(h.quartet.getSecret(authConnectionStateSecretKey(APP, SLOT))).toContain('lanPin');
  });

  it('a LAN request with NO recorded pin is REFUSED — never sent in pair mode by accident', async () => {
    // Pair mode is a wizard step the user consents to. A request-time fallback
    // to it would turn every unpaired request into a silent trust-anything call.
    const h = harness({ pin: null });
    const result = await h.execute({ url: `https://${BRIDGE}/api` });

    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(h.lanCalls).toHaveLength(0);
    if (!result.ok) expect(result.message).toMatch(/pair|pin/i);
  });

  it('a structurally invalid recorded pin is refused, not passed through to the transport', async () => {
    const h = harness({ pin: 'not-a-fingerprint' });
    const result = await h.execute({ url: `https://${BRIDGE}/api` });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(h.lanCalls).toHaveLength(0);
  });

  it('the pin is per-connection: it is read for the slot that matched, never shared', async () => {
    const h = harness({ pin: 'c'.repeat(64) });
    await h.execute({ url: `https://${BRIDGE}/api` });
    expect(h.lanCalls[0]?.pin).toBe('c'.repeat(64));
    // A pin written under a DIFFERENT slot is invisible to this connection.
    h.quartet.setSecret(
      authConnectionStateSecretKey(APP, 'other-slot'),
      JSON.stringify({ status: 'connected', lanPin: { fingerprint: 'd'.repeat(64), cn: 'x' } }),
    );
    await h.execute({ url: `https://${BRIDGE}/api` });
    expect(h.lanCalls[1]?.pin).toBe('c'.repeat(64));
  });
});

// ------------------------------------------------- THE GUARD RE-PROOF (2026-08-12)

describe('guard re-proof — the LAN transport does not inherit semantics, it is PROVEN to honor them', () => {
  it('a redirecting simulated bridge yields NET_REDIRECT_BLOCKED through the LAN path', async () => {
    // Not "we passed redirect:'manual' so it must be fine" — the whole lesson is
    // that a transport may ignore it. This drives a 302 back through the LAN
    // path and asserts the OUTCOME.
    const h = harness({
      respond: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    });
    const result = await h.execute({ url: `https://${BRIDGE}/api` });

    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_REDIRECT_BLOCKED });
    expect(h.lanCalls).toHaveLength(1);
  });

  it('the LAN path is still HANDED redirect:manual — the statement of intent survives the reroute', async () => {
    const h = harness();
    await h.execute({ url: `https://${BRIDGE}/api` });
    expect(h.lanCalls[0]?.init.redirect).toBe('manual');
  });

  it('an oversized body from the bridge yields NET_SIZE_EXCEEDED through the LAN path', async () => {
    const h = harness({
      respond: () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
    });
    const result = await h.execute({ url: `https://${BRIDGE}/api` });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_SIZE_EXCEEDED });
  });

  it('a mutating LAN request still passes the confirm gate BEFORE any credential moves', async () => {
    const confirms: unknown[] = [];
    const quartet = memoryQuartet();
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'application_key'), 'minted-bridge-key');
    quartet.setSecret(
      authConnectionStateSecretKey(APP, SLOT),
      JSON.stringify({ status: 'connected', lanPin: { fingerprint: PIN, cn: 'x' } }),
    );
    const lanCalls: Call[] = [];
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(quartet),
      connectionReader: {
        listConnections: () => [
          { appId: APP, slot: SLOT, requirement: hueRequirement, status: 'approved', allowedHosts: [BRIDGE] },
        ],
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
      lanFetch: async (url: string, init: RequestInit, pin: string) => {
        lanCalls.push({ url, init, pin });
        return new Response('{}', { status: 200 });
      },
      confirmGate: {
        confirm: (request) => {
          confirms.push(request);
          return false; // denied
        },
      },
      transportPolicy: { allowHttpForPrivateHosts: true },
    });

    const result = await executor.execute(APP, { url: `https://${BRIDGE}/clip/v2/resource/light`, method: 'PUT', body: '{"on":{"on":true}}' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(confirms).toHaveLength(1);
    expect(lanCalls, 'a denied confirm means no request, on any transport').toHaveLength(0);
  });

  it('the auth-shaped failure observer fires for a credentialed 401 from the bridge, same as the web path', async () => {
    const observed: Array<[string, number]> = [];
    const quartet = memoryQuartet();
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'application_key'), 'stale-key');
    quartet.setSecret(
      authConnectionStateSecretKey(APP, SLOT),
      JSON.stringify({ status: 'connected', lanPin: { fingerprint: PIN, cn: 'x' } }),
    );
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(quartet),
      connectionReader: {
        listConnections: () => [
          { appId: APP, slot: SLOT, requirement: hueRequirement, status: 'approved', allowedHosts: [BRIDGE] },
        ],
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
      lanFetch: async () => new Response('{"errors":[{"description":"unauthorized user"}]}', { status: 401 }),
      confirmGate: { confirm: () => true },
      transportPolicy: { allowHttpForPrivateHosts: true },
      onAuthShapedFailure: (slot, status) => void observed.push([slot, status]),
    });

    const result = await executor.execute(APP, { url: `https://${BRIDGE}/clip/v2/resource/light` });
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(observed).toEqual([[SLOT, 401]]);
  });
});

// ------------------------------------------------------------ the web promise

describe('AC10 — the web profile is byte-identical', () => {
  it('a public-host request is handed to fetchImpl with no pin argument anywhere in sight', async () => {
    const h = harness({ requirement: publicRequirement, allowedHosts: ['api.example.com'] });
    await h.execute({ url: 'https://api.example.com/v1/data' });
    expect(h.webCalls).toHaveLength(1);
    expect(h.webCalls[0]?.pin).toBeUndefined();
    const headers = (h.webCalls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('public-api-key');
  });
});
