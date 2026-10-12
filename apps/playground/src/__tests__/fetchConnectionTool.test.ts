// fetchConnectionTool.test.ts — TASK-20261010-host-broker PR-4 (AC30; contract v2 D-PR4-13; security
// S1, S5, S6, S11, S14; feasibility F13).
//
// `fetch_connection` — the scheduled agent's ONE network tool: GET only, host-pinned, tainted after a
// shared read. What this file pins, at the TOOL altitude, through the REAL executor
// (`createConnectedFetch` wrapped in a recording spy, the real deps assembly, the real user db):
//
//   - THE INPUT is exactly `{connection, path, query?}`. No method can be expressed: a `method:'POST'`,
//     a `body`, `headers` or a `url` in the input are IGNORED — the executor sees a GET with no body,
//     and the scheduled confirm gate is never asked (its refused list stays empty).
//   - RESOLUTION. An approved row whose frozen ceiling is ONE host → `snug-connection://<slot><path>`
//     (ADR-0026, host-clean). Else the single API host the APPROVED requirement declares (never the
//     staged `pendingRequirement`), which must be in the row's `allowedHosts` → a composed
//     `https://<apiHost><path>?<query>`. Anything else is refused by name.
//   - REFUSED BY NAME BEFORE THE EXECUTOR: the path grammar `^/(?!/)[!-~]*$` with no `?` `#` `\`
//     (≤ 2,048) — so `/\t/<other approved host>/x` and `/\n/…`, which the WHATWG parser would turn
//     into another host, never reach `new URL`; `//x`; a slot outside `CONNECTION_SLOT_RULE`; a
//     sidecar-class slot (and the deps carry NO `sidecarFetch` at all); a LAN-class row; an app that
//     may not reach the network; an unapproved row; a host outside `allowedHosts`.
//   - THE DEPS: `createScheduledConfirmGate()`, `requestTimeoutMs: 30_000`, an auth-shaped failure
//     reported `via: 'scheduled-run'`.
//   - A COMPOSED-PATH FAILURE is answered by CODE only — a fixed, host-free sentence naming the slot;
//     two slots claiming one host → *two connections reach that service*.
//   - EVERY STRING RETURNED passes `scrubOrWithhold(…, 'deliver')`: an injected value echoed
//     JSON-escaped (which R-54's exact-substring scrub cannot see) is masked; a text that still looks
//     like a credential after the shape scrub answers `Error: withheld — the answer looked like it
//     carried a credential`. The body is cut at `FETCH_CONNECTION_MAX_CHARS` (16,000).
//   - COUNTED BEFORE: `onNetCall()` is asked before the executor; `false` → `NET_CALL_LIMIT_MESSAGE`.
//   - THE TAINT: once `taint()` answers true (the turn recorded a shared read), every call answers
//     `Error: not after reading another app’s data in this run — answer with what you have`;
//     a fetch made BEFORE the read stands.
//
// Assumed seams (Q-T-A-5): `buildFetchConnectionTool({appId, getDb, onNetCall?, signal?, fetchImpl?,
// taint})` returns ONE `AgentTool` named `FETCH_CONNECTION_TOOL_NAME = 'fetch_connection'`;
// `taint: () => boolean`; `fetchableConnections(db, appId)` answers entries carrying `slot`.
//
// RED until `agent/fetchConnectionTool.ts` exists (the static import below fails the file).
//
// OWN FILE AND OWN PLATFORM: the platform is set once, before anything reads it — a DESKTOP shell
// that DOES carry a sidecar seat and a LAN transport, so "refused before the executor" and "the deps
// omit sidecarFetch" are proven against a platform where both transports exist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedFetchDeps, NetRequestInput } from '@snugprotocol/auth';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey, type UserDb } from '@snugprotocol/db';
import { getToolPrompt } from '@snugprotocol/knowledge';
import { APP_AGENT_DEADLINE_MARGIN_MS, FETCH_CONNECTION_MAX_CHARS, SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';

const h = vi.hoisted(() => ({
  built: [] as unknown[],
  executed: [] as Array<{ appId: string; input: unknown }>,
  gates: [] as Array<{ refused: readonly unknown[] }>,
}));

vi.mock('@snugprotocol/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snugprotocol/auth')>();
  return {
    ...actual,
    createConnectedFetch: (deps: ConnectedFetchDeps) => {
      h.built.push(deps);
      const executor = actual.createConnectedFetch(deps);
      return {
        execute: (appId: string, input: NetRequestInput) => {
          h.executed.push({ appId, input });
          return executor.execute(appId, input);
        },
      };
    },
  };
});

vi.mock('../schedule/scheduledConfirmGate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schedule/scheduledConfirmGate.js')>();
  return {
    ...actual,
    createScheduledConfirmGate: () => {
      const gate = actual.createScheduledConfirmGate();
      h.gates.push(gate);
      return gate;
    },
  };
});

import { FETCH_CONNECTION_TOOL_NAME, buildFetchConnectionTool, fetchableConnections } from '../agent/fetchConnectionTool.js';
import { setPlatform } from '../platform/platform.js';
import { scrubOrWithhold } from '../schedule/scrub.js';
import { NET_CALL_LIMIT_MESSAGE, __resetNetStateForTests, authShapedFailureStore, invalidateNetGrants, netConfirmStore } from '../state/net.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const sidecarFetch = vi.fn(async () => ({ status: 200, body: '{}' }));
const lanFetch = vi.fn(async () => new Response('{}', { status: 200 }));
setPlatform({
  kind: 'desktop',
  capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  sidecarCtl: async () => ({ running: true, nonce: 'n' }),
  sidecarFetch,
  lanFetch,
});

const APP = 'app-fetch-connection';
const KEY_SLOT = 'melodine';
const KEY_HOST = 'api.melodine.example';
/** Credential-shaped AND carrying a `/`, so its JSON-escaped echo (`\/`) is a different string. */
const SECRET = 'sk-0123456789/abcdefgh';
const OAUTH_SLOT = 'music';
const OAUTH_API_HOST = 'api.musicsvc.example';
const OAUTH_ACCOUNTS_HOST = 'accounts.musicsvc.example';
const BRIDGE = '192.168.1.20';

const TAINT = 'Error: not after reading another app’s data in this run — answer with what you have';
const WITHHELD = 'Error: withheld — the answer looked like it carried a credential';

const keyRequirement = (slot: string, hosts: string[]) => ({
  slot,
  kind: 'api_key' as const,
  provider: { name: 'Melodine Streaming' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: hosts,
});

const oauthRequirement = (slot: string, apiHosts: string[]) => ({
  slot,
  kind: 'oauth2_auth_code' as const,
  provider: { name: 'Music Service' },
  endpoints: {
    authorizeUrl: `https://${OAUTH_ACCOUNTS_HOST}/authorize`,
    tokenUrl: `https://${OAUTH_ACCOUNTS_HOST}/token`,
    refreshUrl: `https://${OAUTH_ACCOUNTS_HOST}/token`,
  },
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text' as const }],
  declaredApiHosts: apiHosts,
});

function seedOauth(db: UserDb, appId: string, slot: string, apiHosts: string[]): void {
  db.putDeclaredConnection(appId, slot, oauthRequirement(slot, apiHosts), 'inference');
  db.approveConnection(appId, slot);
  db.setSecret(authConnectionCredentialSecretKey(appId, slot, 'access_token'), `token-${slot}`);
  db.setSecret(authConnectionCredentialSecretKey(appId, slot, 'refresh_token'), `refresh-${slot}`);
  db.setSecret(authConnectionCredentialSecretKey(appId, slot, 'client_id'), `client-${slot}`);
  // Relative to the moment the row is seeded — never a fixed instant against the executor's clock.
  db.setSecret(authConnectionStateSecretKey(appId, slot), JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }));
}

let db: UserDb;

beforeEach(async () => {
  __resetNetStateForTests();
  invalidateNetGrants(APP);
  authShapedFailureStore.set(null);
  h.built.length = 0;
  h.executed.length = 0;
  h.gates.length = 0;
  sidecarFetch.mockClear();
  lanFetch.mockClear();
  db = await installTestUserDb();
  db.installApp({ appId: APP, displayName: 'Party Deck', html: '<p>deck</p>' });
  // ONE host in the frozen ceiling → the symbolic form.
  db.putDeclaredConnection(APP, KEY_SLOT, keyRequirement(KEY_SLOT, [KEY_HOST]), 'inference');
  db.approveConnection(APP, KEY_SLOT);
  db.setSecret(authConnectionCredentialSecretKey(APP, KEY_SLOT, 'api_key'), SECRET);
  // OAuth: the ceiling carries the accounts host too (multi-host by derivation) → the composed form.
  seedOauth(db, APP, OAUTH_SLOT, [OAUTH_API_HOST]);
  // A sidecar-class slot (the WhatsApp helper's symbolic host).
  db.putDeclaredConnection(APP, 'whatsapp', { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] }, 'starter');
  db.approveConnection(APP, 'whatsapp');
  db.setSecret(authConnectionCredentialSecretKey(APP, 'whatsapp', 'sidecar_token'), 'tok-minted-test');
  // A LAN-class row (one host — it WOULD resolve symbolically — refused by its class).
  db.putDeclaredConnection(
    APP,
    'hue',
    { slot: 'hue', kind: 'api_key', provider: { name: 'Philips Hue' }, declaredApiHosts: [BRIDGE], lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' } },
    'inference',
  );
  db.approveConnection(APP, 'hue');
  // Declared, never approved.
  db.putDeclaredConnection(APP, 'later', keyRequirement('later', ['api.later.example']), 'inference');
});

afterEach(() => {
  __resetNetStateForTests();
});

interface Built {
  run: (input: Record<string, unknown>) => Promise<string>;
  fetches: Array<{ url: string; init?: RequestInit }>;
  tool: ReturnType<typeof buildFetchConnectionTool>;
}

function build(options: {
  appId?: string;
  taint?: () => boolean;
  onNetCall?: () => boolean;
  signal?: AbortSignal;
  response?: (url: string) => Response | Promise<Response>;
  getDb?: () => Promise<UserDb>;
} = {}): Built {
  const fetches: Built['fetches'] = [];
  const tool = buildFetchConnectionTool({
    appId: options.appId ?? APP,
    getDb: options.getDb ?? (() => getUserDb()),
    taint: options.taint ?? (() => false),
    ...(options.onNetCall !== undefined ? { onNetCall: options.onNetCall } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    fetchImpl: async (url: string, init?: RequestInit) => {
      fetches.push({ url, ...(init !== undefined ? { init } : {}) });
      return (await options.response?.(url)) ?? new Response('{"top":"song"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { run: async (input) => String(await tool.run(input)), fetches, tool };
}

const inputOf = (index = 0): NetRequestInput => h.executed[index]?.input as NetRequestInput;

/** Nothing reached the executor or any transport. */
function expectNothingSent(built: Built): void {
  expect(h.executed).toEqual([]);
  expect(built.fetches).toEqual([]);
  expect(sidecarFetch).not.toHaveBeenCalled();
  expect(lanFetch).not.toHaveBeenCalled();
}

describe('the input — exactly {connection, path, query}; no method can be expressed', () => {
  it('the tool is `fetch_connection`, its description is the knowledge store’s prompt, its schema has exactly the three keys', () => {
    const { tool } = build();
    expect(FETCH_CONNECTION_TOOL_NAME).toBe('fetch_connection');
    expect(tool.def.name).toBe('fetch_connection');
    expect(tool.def.description).toBe(getToolPrompt('fetch-connection'));
    const schema = tool.def.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['connection', 'path', 'query']);
    expect([...(schema.required ?? [])].sort()).toEqual(['connection', 'path']);
    expect(JSON.stringify(schema)).not.toMatch(/method|body|headers|url|appId/);
  });

  it('method:"POST", a body, headers and a url in the input are IGNORED — the executor sees a GET with no body; no confirm is ever asked', async () => {
    const built = build();
    const answer = await built.run({
      connection: KEY_SLOT,
      path: '/v1/top-track',
      method: 'POST',
      body: '{"name":"Mix"}',
      headers: { 'X-Custom': 'yes', Authorization: 'Bearer stolen-token-0123456789' },
      url: 'https://evil.example/steal',
    });
    expect(answer).toContain('"top":"song"');
    expect(h.executed).toHaveLength(1);
    const input = inputOf();
    expect(input.method ?? 'GET').toBe('GET');
    expect(input.body).toBeUndefined();
    expect(JSON.stringify(input.headers ?? {})).not.toMatch(/X-Custom|stolen-token/);
    expect(input.url).toBe(`snug-connection://${KEY_SLOT}/v1/top-track`);
    expect(built.fetches).toHaveLength(1);
    expect(built.fetches[0]?.url).toBe(`https://${KEY_HOST}/v1/top-track`);
    expect(built.fetches[0]?.init?.method ?? 'GET').toBe('GET');
    expect(built.fetches[0]?.init?.body ?? undefined).toBeUndefined();
    expect(built.fetches.some((call) => call.url.includes('evil.example'))).toBe(false);
    // Nobody is at the dialog: no confirm was parked, and the scheduled gate refused nothing.
    expect(netConfirmStore.get()).toBeNull();
    expect(h.gates.length).toBeGreaterThan(0);
    for (const gate of h.gates) expect(gate.refused).toEqual([]);
  });
});

describe('resolution — one host is symbolic; a multi-host connection composes its ONE approved API host', () => {
  it('a one-host connection → snug-connection://<slot><path>; the credential reaches the wire, never the answer', async () => {
    const built = build();
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/top-track' });
    expect(inputOf().url).toBe(`snug-connection://${KEY_SLOT}/v1/top-track`);
    expect((built.fetches[0]?.init?.headers as Record<string, string>)['X-Api-Key']).toBe(SECRET);
    expect(answer).toContain('<api_result>');
    expect(answer).toContain('"top":"song"');
    expect(answer).not.toContain(SECRET);
    expect(answer).not.toContain('sk-0123456789');
  });

  it('query values go through URLSearchParams (encoded, never pasted)', async () => {
    const built = build();
    await built.run({ connection: KEY_SLOT, path: '/v1/search', query: { limit: 5, q: 'a b&c=d', explicit: true } });
    expect(inputOf().url).toBe(`snug-connection://${KEY_SLOT}/v1/search?limit=5&q=a+b%26c%3Dd&explicit=true`);
    expect(built.fetches[0]?.url).toBe(`https://${KEY_HOST}/v1/search?limit=5&q=a+b%26c%3Dd&explicit=true`);
  });

  it('a multi-host (OAuth) connection → https://<its one declared API host><path> — composed, and it reaches that host only', async () => {
    const built = build();
    const answer = await built.run({ connection: OAUTH_SLOT, path: '/v1/me', query: { fields: 'name' } });
    expect(inputOf().url).toBe(`https://${OAUTH_API_HOST}/v1/me?fields=name`);
    expect(built.fetches.map((call) => new URL(call.url).hostname)).toEqual([OAUTH_API_HOST]);
    expect(answer).toContain('"top":"song"');
  });

  it('the composed host comes from the APPROVED requirement — a staged pendingRequirement’s host is never used', async () => {
    db.stagePendingRequirement(APP, OAUTH_SLOT, oauthRequirement(OAUTH_SLOT, ['api.evil.example']));
    const built = build();
    await built.run({ connection: OAUTH_SLOT, path: '/v1/me' });
    expect(inputOf().url).toBe(`https://${OAUTH_API_HOST}/v1/me`);
    expect(built.fetches.some((call) => call.url.includes('evil.example'))).toBe(false);
  });

  it('a multi-host connection that declares TWO API hosts has no one host to compose → refused by name before the executor', async () => {
    db.putDeclaredConnection(APP, 'dual', keyRequirement('dual', ['api.one.example', 'api.two.example']), 'inference');
    db.approveConnection(APP, 'dual');
    db.setSecret(authConnectionCredentialSecretKey(APP, 'dual', 'api_key'), 'sk-dualkey-0123456789');
    const built = build();
    const answer = await built.run({ connection: 'dual', path: '/v1/x' });
    expect(answer.startsWith('Error:')).toBe(true);
    expectNothingSent(built);
  });

  it('an API host that is NOT in the row’s allowedHosts → refused before the executor', async () => {
    const real = await getUserDb();
    // Still a MULTI-host ceiling (so the composed path is the one asked), but without the declared API host.
    const doctor = <T extends { slot: string; allowedHosts: string[] }>(row: T): T =>
      row.slot === OAUTH_SLOT ? { ...row, allowedHosts: [...row.allowedHosts.filter((host) => host !== OAUTH_API_HOST), 'cdn.musicsvc.example'] } : row;
    const doctored = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'listConnections') return (appId?: string) => target.listConnections(appId).map(doctor);
        if (prop === 'getConnection') return (appId: string, slot: string) => {
          const row = target.getConnection(appId, slot);
          return row === undefined ? undefined : doctor(row);
        };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const built = build({ getDb: () => Promise.resolve(doctored) });
    const answer = await built.run({ connection: OAUTH_SLOT, path: '/v1/me' });
    expect(answer.startsWith('Error:')).toBe(true);
    expectNothingSent(built);
  });
});

describe('negatives — each refused BY NAME before the executor (AC30)', () => {
  const OTHER = KEY_HOST; // another APPROVED host of the same app — the target a path trick would reach
  const BAD_PATHS: Array<[string, string]> = [
    ['a tab the URL parser strips: /\\t/<other approved host>/x', `/\t/${OTHER}/x`],
    ['a line feed the URL parser strips: /\\n/<other approved host>/x', `/\n/${OTHER}/x`],
    ['a carriage return: /\\r/<other approved host>/x', `/\r/${OTHER}/x`],
    ['a protocol-relative path: //x', `//${OTHER}/x`],
    ['a ? in the path', '/v1/me?admin=1'],
    ['a # in the path', '/v1/me#frag'],
    ['a backslash in the path', '/v1\\me'],
    ['a backslash that the parser treats as a slash: /\\<host>/x', `/\\${OTHER}/x`],
    ['no leading slash', 'v1/me'],
    ['a space', '/v1/m e'],
    ['a C0 control', '/v1/\u0000me'],
    ['a non-ASCII character', '/v1/mé'],
    ['an empty path', ''],
    ['a path over 2,048 characters', `/${'a'.repeat(2048)}`],
  ];

  for (const [name, path] of BAD_PATHS) {
    it(`${name} → refused; nothing reaches the executor or any transport`, async () => {
      const built = build();
      const answer = await built.run({ connection: OAUTH_SLOT, path });
      expect(answer.startsWith('Error:')).toBe(true);
      expectNothingSent(built);
    });
  }

  it('a path of exactly 2,048 characters is admitted (the bound is inclusive)', async () => {
    const built = build();
    await built.run({ connection: KEY_SLOT, path: `/${'a'.repeat(2047)}` });
    expect(h.executed).toHaveLength(1);
  });

  const BAD_SLOTS: Array<[string, unknown]> = [
    ['an upper-case slot', 'Music'],
    ['a slot with a slash', 'music/x'],
    ['a dotted slot', '../music'],
    ['a host instead of a slot', OAUTH_API_HOST],
    ['a non-string slot', 42],
    ['an unknown slot', 'nope'],
  ];

  for (const [name, connection] of BAD_SLOTS) {
    it(`${name} → refused; nothing sent`, async () => {
      const built = build();
      const answer = await built.run({ connection, path: '/v1/me' });
      expect(answer.startsWith('Error:')).toBe(true);
      expectNothingSent(built);
    });
  }

  it('a sidecar-class slot → refused by name; the helper is never dialled', async () => {
    const built = build();
    const answer = await built.run({ connection: 'whatsapp', path: '/chats' });
    expect(answer.startsWith('Error:')).toBe(true);
    expectNothingSent(built);
  });

  it('a LAN-class row → refused by name; the LAN transport is never used', async () => {
    const built = build();
    const answer = await built.run({ connection: 'hue', path: '/clip/v2/resource/light' });
    expect(answer.startsWith('Error:')).toBe(true);
    expectNothingSent(built);
  });

  it('an unapproved (declared) row → refused by name', async () => {
    const built = build();
    const answer = await built.run({ connection: 'later', path: '/v1/x' });
    expect(answer.startsWith('Error:')).toBe(true);
    expectNothingSent(built);
  });

  it('an app that may not reach the network (a shared copy) → refused by name, whatever its rows say', async () => {
    const barred = 'shared--deck-copy';
    try {
      db.putDeclaredConnection(barred, KEY_SLOT, keyRequirement(KEY_SLOT, [KEY_HOST]), 'inference');
      db.approveConnection(barred, KEY_SLOT);
    } catch {
      // The file may refuse a row for an unowned id outright — the tool's refusal is what is pinned.
    }
    const built = build({ appId: barred });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/top-track' });
    expect(answer.startsWith('Error:')).toBe(true);
    expectNothingSent(built);
  });
});

describe('the deps — a scheduled run’s, with no sidecar transport', () => {
  // INVERTED by PR-4 Gate-5 J5 — the request timeout drops below the agent's 30 s deadline margin so the
  // margin holds even for a fetch the signal cannot reach. Was: `expect(deps.requestTimeoutMs).toBe(30_000);`
  it('createConnectedFetch gets NO sidecarFetch (even on a platform that has one), requestTimeoutMs 20_000 and a fresh scheduled confirm gate', async () => {
    const built = build();
    await built.run({ connection: KEY_SLOT, path: '/v1/top-track' });
    expect(h.built.length).toBeGreaterThan(0);
    for (const deps of h.built as ConnectedFetchDeps[]) {
      expect('sidecarFetch' in deps).toBe(false);
      expect(deps.requestTimeoutMs).toBe(20_000);
      expect(deps.requestTimeoutMs!).toBeLessThan(APP_AGENT_DEADLINE_MARGIN_MS);
      expect(h.gates).toContain(deps.confirmGate);
    }
  });

  it('an auth-shaped failure is reported to the reconnect chip as the scheduled run’s (`via: "scheduled-run"`)', async () => {
    const built = build({ response: () => new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }) });
    await built.run({ connection: KEY_SLOT, path: '/v1/top-track' });
    expect(authShapedFailureStore.get()).toMatchObject({ appId: APP, slot: KEY_SLOT, status: 401, via: 'scheduled-run' });
  });
});

describe('a composed-path failure is answered by CODE only — no host', () => {
  it('a transport failure on the composed path names the slot and never the host', async () => {
    const built = build({
      response: () => {
        throw new TypeError(`getaddrinfo ENOTFOUND ${OAUTH_API_HOST} (https://${OAUTH_API_HOST}/v1/me)`);
      },
    });
    const answer = await built.run({ connection: OAUTH_SLOT, path: '/v1/me' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(answer).toContain(OAUTH_SLOT);
    expect(answer).not.toContain('musicsvc.example');
  });

  it('two slots claiming one host → *two connections reach that service*, no host', async () => {
    seedOauth(db, APP, 'twin', [OAUTH_API_HOST]);
    const built = build();
    const answer = await built.run({ connection: OAUTH_SLOT, path: '/v1/me' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(answer).toContain('two connections reach that service');
    expect(answer).not.toContain('musicsvc.example');
    expect(built.fetches).toEqual([]);
  });
});

describe('every returned string is scrubbed (`deliver`) before the cut', () => {
  it('the injected credential echoed JSON-escaped — invisible to the exact-substring scrub — is masked', async () => {
    // A server that escapes `/` in JSON strings (PHP's json_encode default) echoes the key as `sk-0123456789\/abcdefgh`.
    const echoed = `{"echo":"${SECRET.replace('/', '\\/')}"}`;
    expect(echoed).toContain('sk-0123456789\\/abcdefgh'); // the escaped form really differs from the stored value
    expect(echoed).not.toContain(SECRET);
    const built = build({ response: () => new Response(echoed, { status: 200, headers: { 'content-type': 'application/json' } }) });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/echo' });
    expect(answer).not.toContain('sk-0123456789');
    expect(answer).not.toContain(SECRET);
  });

  it('a credential-shaped content type is masked too', async () => {
    const built = build({ response: () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json; token=Bearer abcdefgh12345678wxyz' } }) });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/x' });
    expect(answer).not.toContain('abcdefgh12345678wxyz');
  });

  it('a text that still looks like a credential after the shape scrub → the withheld sentence, never the value', async () => {
    const body = 'see https://admin:hunter2x9q@internal.example/panel for the console';
    expect(scrubOrWithhold(body, 'deliver')).toBeUndefined(); // the deliver policy withholds this text (scrub.ts, unchanged)
    const built = build({ response: () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }) });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/x' });
    expect(answer).toContain(WITHHELD);
    expect(answer).not.toContain('hunter2x9q');
  });
});

describe('the size — FETCH_CONNECTION_MAX_CHARS (16,000)', () => {
  it('the constant is 16,000', () => {
    expect(FETCH_CONNECTION_MAX_CHARS).toBe(16_000);
  });

  it('a 20,000-character body is cut to at most 16,000 characters of it; its tail never reaches the model', async () => {
    const body = `${'x'.repeat(20_000)}ENDMARK`;
    const built = build({ response: () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }) });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/big' });
    const kept = (answer.match(/x/g) ?? []).length;
    expect(kept).toBeGreaterThanOrEqual(15_000);
    expect(kept).toBeLessThanOrEqual(16_000);
    expect(answer).not.toContain('ENDMARK');
  });
});

describe('counted BEFORE the executor — the day’s net ceiling', () => {
  it('onNetCall is asked once per fetch, before anything is sent', async () => {
    const events: string[] = [];
    const built = build({
      onNetCall: () => {
        events.push('count');
        return true;
      },
      response: () => {
        events.push('fetch');
        return new Response('{}', { status: 200 });
      },
    });
    await built.run({ connection: KEY_SLOT, path: '/v1/a' });
    await built.run({ connection: OAUTH_SLOT, path: '/v1/b' });
    expect(events).toEqual(['count', 'fetch', 'count', 'fetch']);
  });

  it('onNetCall → false: the limit sentence, nothing reaches the executor', async () => {
    const built = build({ onNetCall: () => false });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/a' });
    expect(answer).toContain(NET_CALL_LIMIT_MESSAGE);
    expectNothingSent(built);
  });
});

describe('the taint — not after reading another app’s data in this run', () => {
  it('once taint() answers true, the call answers the taint sentence and nothing is sent', async () => {
    const built = build({ taint: () => true });
    const answer = await built.run({ connection: KEY_SLOT, path: '/v1/a' });
    expect(answer).toBe(TAINT);
    expectNothingSent(built);
  });

  it('taint is read at EACH call: a fetch made before the read stands; the one after is refused (fetch-then-read passes)', async () => {
    let tainted = false;
    const built = build({ taint: () => tainted });
    const first = await built.run({ connection: KEY_SLOT, path: '/v1/a' });
    expect(first).toContain('<api_result>');
    tainted = true;
    const second = await built.run({ connection: KEY_SLOT, path: '/v1/b' });
    expect(second).toBe(TAINT);
    expect(built.fetches).toHaveLength(1);
  });
});

describe('the turn’s signal', () => {
  it('an aborted signal sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const built = build({ signal: controller.signal });
    await built.run({ connection: KEY_SLOT, path: '/v1/a' });
    expect(built.fetches).toEqual([]);
  });

  // PR-4 Gate-5 J5 [JOBS-F5] — the fetch carries the turn's signal (`AbortSignal.any` over the executor's own).
  it('a fetch IN FLIGHT hears the turn’s abort: the transport’s signal fires and the tool answers at once', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = buildFetchConnectionTool({
      appId: APP,
      getDb: () => getUserDb(),
      taint: () => false,
      signal: controller.signal,
      fetchImpl: (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          seen = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          // The red case's bound, in real time: a transport the turn cannot reach answers late.
          setTimeout(() => resolve(new Response('{"late":true}', { status: 200, headers: { 'content-type': 'application/json' } })), 400);
        }),
    });
    const pending = Promise.resolve(tool.run({ connection: KEY_SLOT, path: '/v1/slow' })).then(String);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    const answer = await Promise.race([pending, new Promise<string>((resolve) => setTimeout(() => resolve('STILL IN FLIGHT'), 150))]);
    expect(seen?.aborted, 'the transport’s signal is the turn’s too').toBe(true);
    expect(answer).not.toBe('STILL IN FLIGHT');
    expect(answer).not.toContain('"late":true');
    await pending; // settle the red case's late answer before the next row
  });

  it('the executor’s own timeout signal still rides alongside: an un-aborted turn’s fetch carries a live signal', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = buildFetchConnectionTool({
      appId: APP,
      getDb: () => getUserDb(),
      taint: () => false,
      signal: controller.signal,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Response('{"top":"song"}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(String(await tool.run({ connection: KEY_SLOT, path: '/v1/a' }))).toContain('"top":"song"');
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
  });
});

describe('fetchableConnections — what the consent and the agent may name', () => {
  it('approved, non-sidecar, non-LAN rows only (the declared one, the helper and the bridge are out)', () => {
    const slots = fetchableConnections(db, APP).map((entry) => entry.slot).sort();
    expect(slots).toEqual([KEY_SLOT, OAUTH_SLOT].sort());
  });

  it('an app that may not reach the network has none', () => {
    expect(fetchableConnections(db, 'shared--deck-copy')).toEqual([]);
  });
});
