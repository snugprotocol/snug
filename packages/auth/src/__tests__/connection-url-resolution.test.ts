// TASK-20260814-hue-starter-real-connection (ADR-0026 §2-3) — symbolic connection
// addressing in the connected-fetch executor, written RED-FIRST at Gate 3.
//
// THE CONTRACT UNDER TEST: `snug-connection://<slot><path>` resolves the CALLING APP's
// own slot to its single frozen-ceiling host and then the ENTIRE existing pipeline runs
// on the resolved URL — resolution grants nothing, it only translates. The refusal
// triple (unknown slot / unapproved / not-exactly-one-host), the fail-closed
// double-ambiguity decision, and the disclosure boundary (the resolved host never
// reaches the APP; the USER's confirm dialog carries it) are each pinned by outcome.
//
// POSTURE INHERITED FROM connected-fetch-slots.test.ts: executor-altitude with a fake
// fetch, REAL credential-shaped values, and theft/leak claims asserted by probing the
// surface the value would occupy — never by the absence of a key.

import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { CONNECTION_STATUS, type ConnectionRequirement, type ConnectionStatus } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '@snugprotocol/db';
import { createConnectedFetch, type ConnectedFetch, type NetConnectionRow } from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

// ---------------------------------------------------------------------- fixtures

const APP = 'app-symbolic';
const BRIDGE = '192.168.1.50';
const PIN = 'c'.repeat(64);
const HUE_KEY = 'Jq8Z-hue-application-key-40chars-9Xq2LmNp';
const CLOUD_KEY = 'od-live-4417ZmNoPqRsTuVwXyZ01234567aBcDeF98';

/** The Hue LAN row, post-collection post-approval — the shape the wizard leaves behind. */
const hueRequirement = {
  slot: 'hue',
  provider: { name: 'Philips Hue' },
  kind: 'api_key',
  fields: [{ key: 'application_key', label: 'Bridge application key', type: 'secret', required: true }],
  request: { headerTemplate: { 'hue-application-key': '{{application_key}}' } },
  lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
  declaredApiHosts: [BRIDGE],
} as const satisfies ConnectionRequirement;

/** A cloud single-host row — the scheme is not LAN-specific (ADR-0026 §5). */
const cloudRequirement = {
  slot: 'files',
  provider: { name: 'OneDrive' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['graph.microsoft.com'],
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

function row(
  requirement: ConnectionRequirement,
  opts: { status?: ConnectionStatus; allowedHosts?: string[] } = {},
): NetConnectionRow {
  return {
    appId: APP,
    slot: requirement.slot,
    requirement,
    status: opts.status ?? CONNECTION_STATUS.approved,
    allowedHosts: opts.allowedHosts ?? [...(requirement.declaredApiHosts ?? [])],
  };
}

type FetchCall = { url: string; init: RequestInit };

interface Harness {
  executor: ConnectedFetch;
  calls: FetchCall[];
  lanCalls: { url: string; init: RequestInit; pin: string }[];
  quartet: ReturnType<typeof memoryQuartet>;
  confirm: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    rows?: NetConnectionRow[];
    respond?: (url: string) => Response;
    /** true = desktop profile: transportPolicy + a pinned lanFetch. Default true. */
    desktop?: boolean;
    lanRespond?: (url: string) => Response | Error;
    seedHuePairing?: boolean;
  } = {},
): Harness {
  const quartet = memoryQuartet();
  quartet.setSecret(authConnectionCredentialSecretKey(APP, 'hue', 'application_key'), HUE_KEY);
  quartet.setSecret(authConnectionCredentialSecretKey(APP, 'files', 'api_key'), CLOUD_KEY);
  if (opts.seedHuePairing !== false) {
    quartet.setSecret(
      authConnectionStateSecretKey(APP, 'hue'),
      JSON.stringify({ status: 'connected', lanPin: { fingerprint: PIN }, lanVerifiedAt: 1755200000000 }),
    );
  }
  const rows = opts.rows ?? [row(hueRequirement), row(cloudRequirement)];
  const calls: FetchCall[] = [];
  const lanCalls: Harness['lanCalls'] = [];
  const respond = opts.respond ?? (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const confirm = vi.fn(async () => true);
  const desktop = opts.desktop !== false;
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: (appId) => (appId === APP ? rows : []) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return respond(url);
    },
    confirmGate: { confirm },
    ...(desktop
      ? {
          transportPolicy: { allowHttpForPrivateHosts: true },
          lanFetch: async (url, init, pin) => {
            lanCalls.push({ url, init, pin });
            const answer = (opts.lanRespond ?? (() => new Response('{"data":[]}', { status: 200 })))(url);
            if (answer instanceof Error) throw answer;
            return answer;
          },
        }
      : {}),
  });
  return { executor, calls, lanCalls, quartet, confirm };
}

const headerOf = (init: RequestInit, name: string): string | undefined => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ----------------------------------------------------- resolution + intact gates

describe('ADR-0026 §2 — resolution translates, the pipeline gates', () => {
  it('resolves the slot to the frozen ceiling host and rides the PINNED lane with the injected header', async () => {
    const { executor, calls, lanCalls } = harness();
    const result = await executor.execute(APP, { url: 'snug-connection://hue/clip/v2/resource/room', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(calls, 'a LAN host must never ride the public transport').toHaveLength(0);
    expect(lanCalls).toHaveLength(1);
    expect(lanCalls[0]!.url).toBe(`https://${BRIDGE}/clip/v2/resource/room`);
    expect(headerOf(lanCalls[0]!.init, 'hue-application-key')).toBe(HUE_KEY);
    expect(lanCalls[0]!.pin).toBe(PIN);
  });

  it('a cloud single-host connection resolves through the ordinary transport — the scheme is not LAN-specific', async () => {
    const { executor, calls, lanCalls } = harness();
    const result = await executor.execute(APP, { url: 'snug-connection://files/v1.0/me/drive', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(lanCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/drive');
    expect(headerOf(calls[0]!.init, 'x-api-key')).toBe(CLOUD_KEY);
  });

  it('literal URLs are untouched by the scheme — byte-identical routing for existing apps', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/me');
  });

  it('an UNKNOWN slot is NET_INVALID_REQUEST — and the message names no host', async () => {
    const { executor, calls, lanCalls } = harness();
    const result = await executor.execute(APP, { url: 'snug-connection://sonos/api', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_INVALID_REQUEST);
    expect(result.message).not.toContain(BRIDGE);
    expect(calls).toHaveLength(0);
    expect(lanCalls).toHaveLength(0);
  });

  it('a declared-but-unapproved slot is NET_NOT_APPROVED — the connect CTA case', async () => {
    const { executor } = harness({ rows: [row(hueRequirement, { status: CONNECTION_STATUS.declared, allowedHosts: [] })] });
    const result = await executor.execute(APP, { url: 'snug-connection://hue/clip/v2/resource/room', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_NOT_APPROVED);
  });

  it('a ceiling with two hosts refuses NET_AMBIGUOUS_CONNECTION — a symbolic address must have one meaning', async () => {
    const twoHost = {
      slot: 'multi',
      provider: { name: 'Multi Host' },
      kind: 'api_key',
      fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
      declaredApiHosts: ['a.example.com', 'b.example.com'],
    } as const satisfies ConnectionRequirement;
    const { executor } = harness({ rows: [row(twoHost)] });
    const result = await executor.execute(APP, { url: 'snug-connection://multi/v1', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION);
  });

  it('a MALFORMED connection url refuses NET_INVALID_REQUEST instead of falling through to scheme gates', async () => {
    const { executor } = harness();
    const result = await executor.execute(APP, { url: 'snug-connection://HUE/clip', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_INVALID_REQUEST);
  });

  it('TWO approved slots claiming the resolved host refuse fail-closed — and the rival credential is never read', async () => {
    // Slot 'hue' resolves to the bridge host; slot 'rival' ALSO claims that host. The
    // symbolic URL names 'hue' unambiguously — and the executor still refuses, because
    // the slot name selects a ceiling to translate through, never a credential-routing
    // tiebreak (ADR-0026 §2's fail-closed corollary).
    const rivalRequirement = {
      slot: 'rival',
      provider: { name: 'Rival Device' },
      kind: 'bearer_token',
      fields: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
      declaredApiHosts: [BRIDGE],
    } as const satisfies ConnectionRequirement;
    const h = harness({ rows: [row(hueRequirement), row(rivalRequirement)] });
    h.quartet.setSecret(authConnectionCredentialSecretKey(APP, 'rival', 'token'), 'rival-token-Zx91LmQw44');
    const reads = vi.spyOn(h.quartet, 'getSecret');
    const result = await h.executor.execute(APP, { url: 'snug-connection://hue/clip/v2/resource/room', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION);
    // Refused BEFORE any credential read — neither slot's secret was touched.
    const credentialKeys = [
      authConnectionCredentialSecretKey(APP, 'hue', 'application_key'),
      authConnectionCredentialSecretKey(APP, 'rival', 'token'),
    ];
    for (const call of reads.mock.calls) {
      expect(credentialKeys, `credential read after refusal: ${String(call[0])}`).not.toContain(call[0]);
    }
    expect(h.calls).toHaveLength(0);
    expect(h.lanCalls).toHaveLength(0);
  });
});

// ----------------------------------------------------- the disclosure boundary

/**
 * ADR-0033's standing gate keys on the connection SLOT, and the slot only exists on this
 * symbolic path — an absolute-URL request has none, which is exactly what keeps a standing
 * grant off the wizard's probe. `confirm-seat-scope.test.ts` pins the absent case; the
 * present case has to be pinned HERE, because this file owns the symbolic harness. Without
 * this test a broken `slot` wire would look like "the probe is correctly excluded" — every
 * negative would stay green while arming silently never matched anything.
 */
describe('ADR-0033 — the confirm seat learns the slot on the symbolic path', () => {
  it('a symbolic mutating request carries its slot AND its body to the confirm gate', async () => {
    const { executor, confirm } = harness();
    await executor.execute(APP, {
      url: 'snug-connection://files/v1.0/me/drive/items',
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({
      slot: 'files',
      body: JSON.stringify({ text: 'hi' }),
      method: 'POST',
    });
  });

  it('the host handed to the confirm gate is the RESOLVED one, not the symbolic spelling', async () => {
    // The gate decides about a real destination; `snug-connection` is not a host.
    const { executor, confirm } = harness();
    await executor.execute(APP, { url: 'snug-connection://files/v1.0/me/drive/items', method: 'POST', body: '{}' });
    expect(confirm.mock.calls[0]![0]!.host).not.toContain('snug-connection');
  });
});

describe('ADR-0026 §3 — the resolved host never reaches the APP', () => {
  it('on WEB (no transport policy) a symbolic LAN request refuses NET_SSRF_BLOCKED with a HOST-CLEAN message', async () => {
    const { executor } = harness({ desktop: false });
    const result = await executor.execute(APP, { url: 'snug-connection://hue/clip/v2/resource/room', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_SSRF_BLOCKED);
    expect(result.message).not.toContain(BRIDGE);
  });

  it('a transport failure message is scrubbed of the resolved address', async () => {
    const { executor } = harness({
      lanRespond: () => new Error(`connect ECONNREFUSED https://${BRIDGE}/clip/v2/resource/room`),
    });
    const result = await executor.execute(APP, { url: 'snug-connection://hue/clip/v2/resource/room', method: 'GET' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NET_ERROR_CODES.NET_FETCH_FAILED);
    expect(result.message).not.toContain(BRIDGE);
  });

  it('response BODIES are NOT scrubbed of the device’s own address — the provider’s data surface stays intact', async () => {
    const { executor } = harness({
      lanRespond: () => new Response(JSON.stringify({ data: [{ internalipaddress: BRIDGE }] }), { status: 200 }),
    });
    const result = await executor.execute(APP, { url: 'snug-connection://hue/clip/v2/resource/room', method: 'GET' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain(BRIDGE);
  });

  it('the USER sees the truth the app cannot: the confirm gate carries the RESOLVED host on a write (AC8)', async () => {
    const { executor, confirm, lanCalls } = harness();
    const result = await executor.execute(APP, {
      url: 'snug-connection://hue/clip/v2/resource/grouped_light/abc-123',
      method: 'PUT',
      body: JSON.stringify({ on: { on: true } }),
    });
    expect(result.ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const request = confirm.mock.calls[0]![0] as { host: string; method: string; url: string };
    expect(request.host).toBe(BRIDGE);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(`https://${BRIDGE}/clip/v2/resource/grouped_light/abc-123`);
    expect(lanCalls).toHaveLength(1);
  });
});
