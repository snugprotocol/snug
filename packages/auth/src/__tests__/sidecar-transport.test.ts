/**
 * THE SIDECAR TRANSPORT SEAT (ADR-0032) — how an APP's request reaches the helper.
 *
 * FOUND BY WALKING THE PATH (owner, 2026-08-17): the wizard linked WhatsApp successfully and
 * the app then reported "the WhatsApp helper is not running". Both were true statements about
 * different doors. The wizard calls `sidecar_wizard_fetch` (a Tauri command); the APP calls
 * `snug-connection://whatsapp/chats`, which goes through the EXECUTOR — and the executor had
 * no sidecar branch at all. It resolved the symbolic host to `https://whatsapp.sidecar.localhost/…`
 * and handed that to `fetchImpl`, which tried a real DNS lookup and failed `NET_FETCH_FAILED`.
 *
 * `.localhost` is reserved by RFC 6761 and the helper has NO TCP endpoint whatsoever, so that
 * request could never have succeeded. The host is an IDENTITY for the frozen ceiling to hold,
 * not an address — which is exactly why the executor must recognise it and route to the
 * unix-socket transport instead of dialling it.
 *
 * The seat mirrors `lanFetch`: an optional dep, and its ABSENCE is a named refusal rather
 * than a silent fallback to `fetchImpl` — the same reasoning the LAN comment gives, since a
 * fallback would send a credentialed request down a transport the user never approved.
 */

import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_STATUS, SIDECAR_SYMBOLIC_HOST, type ConnectionRequirement, type ConnectionStatus } from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';
import { createConnectedFetch, type NetConnectionRow } from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

const APP = 'whatsapp-twin';
const SLOT = 'whatsapp';
const TOKEN = 'minted-sidecar-token';

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

const requirement: ConnectionRequirement = {
  slot: SLOT,
  kind: 'linked_device',
  provider: { name: 'WhatsApp' },
  fields: [{ key: 'sidecar_token', label: 'Helper access token', type: 'secret' }],
  request: { headerTemplate: { authorization: 'Bearer {{sidecar_token}}' } },
  declaredApiHosts: [SIDECAR_SYMBOLIC_HOST],
};

const row: NetConnectionRow = {
  appId: APP,
  slot: SLOT,
  requirement,
  status: CONNECTION_STATUS.approved as ConnectionStatus,
  allowedHosts: [SIDECAR_SYMBOLIC_HOST],
};

function harness(opts: { sidecarFetch?: unknown; withToken?: boolean } = {}) {
  const quartet = memoryQuartet();
  if (opts.withToken !== false) {
    quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'sidecar_token'), TOKEN);
  }
  const networkCalls: string[] = [];
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: () => [row] },
    fetchImpl: async (url: string) => {
      networkCalls.push(url);
      throw new TypeError('getaddrinfo ENOTFOUND whatsapp.sidecar.localhost');
    },
    confirmGate: { confirm: () => true },
    ...(opts.sidecarFetch !== undefined ? { sidecarFetch: opts.sidecarFetch } : {}),
  } as never);
  return { executor, networkCalls };
}

describe('an app reaches the helper through the sidecar transport, never the network', () => {
  it('routes a symbolic sidecar request to sidecarFetch', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const sidecarFetch = vi.fn(async (method: string, pathAndQuery: string) => {
      calls.push({ method, path: pathAndQuery });
      return { status: 200, body: JSON.stringify({ chats: [] }) };
    });
    const { executor, networkCalls } = harness({ sidecarFetch });

    const result = await executor.execute(APP, { url: `snug-connection://${SLOT}/chats` });

    expect(result.ok, 'the read succeeds').toBe(true);
    expect(sidecarFetch).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/chats' });
    // THE POINT: nothing was ever dialled. A `.localhost` name with no TCP endpoint behind it
    // can only fail, so a request that reached the network is the bug.
    expect(networkCalls, 'no network fetch is attempted for the sidecar host').toEqual([]);
  });

  it('passes the PATH AND QUERY through, so history paging works', async () => {
    const sidecarFetch = vi.fn(async (_m: string, _p: string, _b?: string, _h?: Record<string, string>) => ({ status: 200, body: '{}' }));
    const { executor } = harness({ sidecarFetch });

    await executor.execute(APP, { url: `snug-connection://${SLOT}/chats/a%40s.whatsapp.net/messages?since=5` });

    expect(sidecarFetch.mock.calls[0]?.[1]).toBe('/chats/a%40s.whatsapp.net/messages?since=5');
  });

  it('carries the request BODY for a send', async () => {
    const sidecarFetch = vi.fn(async (_m: string, _p: string, _b?: string, _h?: Record<string, string>) => ({ status: 200, body: '{"id":"m1"}' }));
    const { executor } = harness({ sidecarFetch });

    await executor.execute(APP, {
      url: `snug-connection://${SLOT}/chats/x@g.us/messages`,
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    });

    expect(sidecarFetch.mock.calls[0]?.[0]).toBe('POST');
    expect(sidecarFetch.mock.calls[0]?.[2]).toBe(JSON.stringify({ text: 'hi' }));
  });

  it('REFUSES by name when the seat is absent — never falls back to the network', async () => {
    // The `lanFetch` rule, for the same reason: `deps.sidecarFetch ?? deps.fetchImpl` would
    // send a credentialed request down a transport nobody approved, and on a browser (where
    // the seat is genuinely absent) it would leak the attempt to a DNS resolver.
    const { executor, networkCalls } = harness({});

    const result = await executor.execute(APP, { url: `snug-connection://${SLOT}/chats` });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.toLowerCase()).toMatch(/desktop|helper/);
    expect(networkCalls, 'the absent seat is a refusal, not a fallback').toEqual([]);
  });

  it('still injects the credential — the helper requires it on every route', async () => {
    // C1 holds here as everywhere: the app never sees the token, the host attaches it.
    const sidecarFetch = vi.fn(async (_m: string, _p: string, _b?: string, _h?: Record<string, string>) => ({ status: 200, body: '{}' }));
    const { executor } = harness({ sidecarFetch });

    await executor.execute(APP, { url: `snug-connection://${SLOT}/chats` });

    const headers = sidecarFetch.mock.calls[0]?.[3] as Record<string, string> | undefined;
    expect(headers?.['authorization'], 'the minted token rides the request').toBe(`Bearer ${TOKEN}`);
  });

  it('does NOT route a non-sidecar host to the sidecar seat', async () => {
    // Non-vacuity, and the property that keeps this from becoming a general local-fetch
    // primitive: only the symbolic sidecar host takes this branch.
    const sidecarFetch = vi.fn(async (_m: string, _p: string, _b?: string, _h?: Record<string, string>) => ({ status: 200, body: '{}' }));
    const other: NetConnectionRow = {
      ...row,
      slot: 'other',
      requirement: { ...requirement, slot: 'other', kind: 'api_key', declaredApiHosts: ['api.example.com'] },
      allowedHosts: ['api.example.com'],
    };
    const quartet = memoryQuartet();
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'other', 'sidecar_token'), TOKEN);
    const seen: string[] = [];
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(quartet),
      connectionReader: { listConnections: () => [other] },
      fetchImpl: async (url: string) => {
        seen.push(url);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      confirmGate: { confirm: () => true },
      sidecarFetch,
    } as never);

    await executor.execute(APP, { url: 'snug-connection://other/v1/thing' });

    expect(sidecarFetch, 'an ordinary host never reaches the sidecar seat').not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });
});
