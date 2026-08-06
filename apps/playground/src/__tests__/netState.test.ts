// AL-03 playground half — the net state module wires the connected-fetch executor to
// the page user DB and exposes a NetHandler the runner routes to. Under test: the spec
// reader maps AuthSpecRow → NetSpecRow, the confirm gate is the session-remember gate
// keyed (app, host, method) with re-approval invalidation, and the Connections actions
// (approve/reapprove/revoke) invalidate remembered grants.
import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestUserDb } from './userdbTestHelper.js';
import {
  createNetHandlerFor,
  netConfirmStore,
  resolveNetConfirm,
  invalidateNetGrants,
  __resetNetStateForTests,
} from '../state/net.js';
import { getUserDb } from '../state/userdb.js';

const APP = 'app-net-1';

const apiKeySpec = {
  kind: 'api_key' as const,
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

async function seedApprovedApp(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
  db.setSecret(`auth:${APP}:api_key`, 'stored-key-abc123');
  db.putAuthSpec(APP, apiKeySpec);
  db.approveAuthSpec(APP);
}

beforeEach(async () => {
  __resetNetStateForTests();
  await installTestUserDb();
});
afterEach(() => {
  __resetNetStateForTests();
  vi.restoreAllMocks();
});

describe('createNetHandlerFor — executor wiring', () => {
  it('routes a GET through the executor against the approved spec, injecting the stored key', async () => {
    await seedApprovedApp();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const handler = createNetHandlerFor({
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const result = await handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r1',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/data',
      method: 'GET',
    });
    expect(result.ok).toBe(true);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    const key = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-api-key')?.[1];
    expect(key).toBe('stored-key-abc123');
  });

  it('bars an unapproved app with NET_NOT_APPROVED (status contract)', async () => {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
    db.putAuthSpec(APP, apiKeySpec); // unapproved
    const handler = createNetHandlerFor({ fetchImpl: async () => new Response('') });
    const result = await handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r1',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/data',
      method: 'GET',
    });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
  });
});

describe('confirm gate — session remember + re-approval invalidation (R3)', () => {
  it('a POST opens a confirm request in the store; resolving grants it', async () => {
    await seedApprovedApp();
    const handler = createNetHandlerFor({ fetchImpl: async () => new Response('{}', { status: 200 }) });
    const promise = handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r1',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/items',
      method: 'POST',
      body: '{}',
    });
    // The dialog observes a pending confirm and resolves it.
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    const pending = netConfirmStore.get()!;
    expect(pending.request).toMatchObject({ appId: APP, host: 'api.example.com', method: 'POST' });
    resolveNetConfirm({ granted: true, rememberSession: true });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(netConfirmStore.get()).toBeNull(); // dialog closes

    // Second POST is remembered — no new pending confirm.
    const second = handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r2',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/items',
      method: 'POST',
      body: '{}',
    });
    expect((await second).ok).toBe(true);
    expect(netConfirmStore.get()).toBeNull();

    // invalidateNetGrants(APP) forces a fresh prompt (re-approval hook).
    invalidateNetGrants(APP);
    const third = handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r3',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/items',
      method: 'POST',
      body: '{}',
    });
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: false });
    expect((await third)).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
  });

  it('a denied confirm returns NET_CONFIRM_DENIED and performs no fetch', async () => {
    await seedApprovedApp();
    const calls: string[] = [];
    const handler = createNetHandlerFor({
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response('{}');
      },
    });
    const promise = handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r1',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/items',
      method: 'DELETE',
    });
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: false });
    expect(await promise).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(calls).toHaveLength(0);
  });
});
