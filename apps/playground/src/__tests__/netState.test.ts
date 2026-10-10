// AL-03 playground half — the net state module wires the connected-fetch executor to
// the page user DB and exposes a NetHandler the runner routes to. Under test: the
// connection reader maps ConnectionRow → NetConnectionRow, the confirm gate is the
// session-remember gate keyed (app, host, method) with re-approval invalidation, and the
// Connections actions (approve/reapprove/revoke) invalidate remembered grants.
//
// P3 CUTOVER: the FIXTURES moved from v3 `snug_auth_specs` to v4 `snug_connections` — the
// surface the playground now routes through. Every ASSERTION below is unchanged, which is
// the point: the executor wiring, the status contract, and the confirm gate's remember +
// invalidate behavior must all survive the cutover byte-for-byte, and this file is what
// proves they did rather than being quietly re-scoped along with the storage.
import { createConnectedFetch } from '@snugprotocol/auth';
import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestUserDb } from './userdbTestHelper.js';
import {
  armStandingApproval,
  authShapedFailureStore,
  connectedFetchDepsFor,
  createNetHandlerFor,
  netConfirmStore,
  resolveNetConfirm,
  invalidateNetGrants,
  __resetNetStateForTests,
} from '../state/net.js';
import { getUserDb } from '../state/userdb.js';
// TASK-20261010-host-broker PR-1 — the delegated run's record and the registry's generations.
import { beginDelegatedRun, clearTouchedGeneration, endDelegatedRun, touchedGeneration } from '../schedule/runPlacement.js';
import { markAppHostAnnounced, registerAppHost, setAppHostGeneration } from '../state/appHosts.js';

const APP = 'app-net-1';

const SLOT = 'example';

const apiKeyRequirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

async function seedApprovedApp(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
  // SLOT-KEYED (P1): `auth:<appId>:<slot>:<fieldKey>`. The v3 app-keyed path is gone, so
  // a credential written the old way would simply not be found — which is exactly what
  // the injection assertion below would catch.
  db.setSecret(`auth:${APP}:${SLOT}:api_key`, 'stored-key-abc123');
  db.putDeclaredConnection(APP, SLOT, apiKeyRequirement, 'inference');
  db.approveConnection(APP, SLOT);
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
    db.putDeclaredConnection(APP, SLOT, apiKeyRequirement, 'inference'); // declared, unapproved
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

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1 — the run-scoped gate at the RIGHT ALTITUDE (ADR-0077 §3;
// contract v2 D-PR1-3, D-PR1-9; security blocker 1, security 3 / feasibility F7).
//
// `runScopedGate.test.ts` proves the gate with its deps faked. These cases prove the WIRING,
// through the REAL `state/net.ts`: the live frame's handler (`createNetHandlerFor()` with no
// `confirmGate`) must default to the run-scoped gate, so a delegated run on the open app meets
// a `scheduled`-tagged dialog even though the user REMEMBERED a grant for the session AND ARMED
// a standing approval for the same app, host and thread — the two answers the Gate-5 fold
// named as the hazard ("presence is not consent"). And only the frame path changes:
// `connectedFetchDepsFor`'s default stays the standing gate (the wizard probe, the provider
// tools and the sidecar pump are untouched).
//
// Registry hygiene: `__resetAppHostsForTest` also drops every host LISTENER — including the one
// `state/net.ts` installs to clear the sticky posture on a retraction — so this block never
// calls it; it unregisters what it registered instead. Each test uses its own app id because
// the session gate's remembered grants and the standing store outlive `__resetNetStateForTests`.
// ---------------------------------------------------------------------------------------------

describe('the run-scoped gate through the real handler (TASK-20261010-host-broker PR-1)', () => {
  const symbolicSend = 'snug-connection://example/chats/thread-1/messages';
  const postFrame = (requestId: string) => ({
    v: 1 as const,
    type: 'snug:net-request' as const,
    requestId,
    instanceId: 'ins-1',
    url: symbolicSend,
    method: 'POST' as const,
    body: '{"text":"hi"}',
  });

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  async function seedApp(appId: string): Promise<void> {
    const db = await getUserDb();
    db.installApp({ appId, displayName: 'Net App', html: '<p>net</p>' });
    db.setSecret(`auth:${appId}:${SLOT}:api_key`, 'stored-key-abc123');
    db.putDeclaredConnection(appId, SLOT, apiKeyRequirement, 'inference');
    db.approveConnection(appId, SLOT);
  }

  /** The open app's view: registered, at `generation`, announced. Unregistered after the test. */
  function openApp(appId: string, generation: number): () => void {
    const unregister = registerAppHost(appId, vi.fn());
    setAppHostGeneration(appId, generation);
    markAppHostAnnounced(appId, generation);
    cleanups.push(unregister);
    return unregister;
  }

  function begin(appId: string, generation: number, runId = 'run-1'): void {
    const begun = beginDelegatedRun({ appId, appName: 'Net App', runId, taskId: 't1', title: 'Morning post', generation });
    expect(begun.ok).toBe(true);
    cleanups.push(() => {
      endDelegatedRun(appId, runId);
      clearTouchedGeneration(appId, generation);
    });
  }

  /** Remember a session grant AND arm a standing approval — the page's chain at its most permissive. */
  async function rememberAndArm(appId: string, handler: ReturnType<typeof createNetHandlerFor>): Promise<void> {
    const first = handler.handle(appId, postFrame('remember'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: true, rememberSession: true });
    expect((await first).ok).toBe(true);
    armStandingApproval({
      appId,
      slot: SLOT,
      threadJid: 'thread-1',
      trigger: 'all',
      maxPerWindow: 100,
      windowMs: 60_000,
      armedAt: Date.now(),
      sends: [],
    });
    // CONTROL: outside a run the ordinary chain answers — no dialog, the request goes out.
    const control = await handler.handle(appId, postFrame('control'));
    expect(control.ok).toBe(true);
    expect(netConfirmStore.get()).toBeNull();
  }

  function countingFetch(): { urls: string[]; fetchImpl: (url: string) => Promise<Response> } {
    const urls: string[] = [];
    return {
      urls,
      fetchImpl: async (url: string) => {
        urls.push(url);
        return new Response('{}', { status: 200 });
      },
    };
  }

  it('NEGATIVE (right altitude): with a run in flight, a remembered AND an armed grant do not answer — a `scheduled`-tagged dialog is parked and nothing is sent', async () => {
    const appId = 'app-deleg-altitude';
    await seedApp(appId);
    const net = countingFetch();
    const handler = createNetHandlerFor({ fetchImpl: net.fetchImpl });
    await rememberAndArm(appId, handler);
    const sentBefore = net.urls.length;

    openApp(appId, 1);
    begin(appId, 1);
    const during = handler.handle(appId, postFrame('during'));

    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    const pending = netConfirmStore.get()!;
    expect(pending.request).toMatchObject({ appId, host: 'api.example.com', method: 'POST' });
    expect(pending.scheduled).toEqual({ title: 'Morning post', appName: 'Net App', runId: 'run-1' });
    expect(net.urls).toHaveLength(sentBefore); // parked, not passed

    // The run ends (result, bound, cancel or handover): the parked dialog is WITHDRAWN.
    endDelegatedRun(appId, 'run-1');
    await vi.waitFor(() => expect(netConfirmStore.get()).toBeNull());
    expect(await during).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(net.urls).toHaveLength(sentBefore);
  });

  it('allowing the scheduled dialog sends THAT request once — and the next call during the run asks again (nothing remembered)', async () => {
    const appId = 'app-deleg-allow';
    await seedApp(appId);
    const net = countingFetch();
    const handler = createNetHandlerFor({ fetchImpl: net.fetchImpl });
    await rememberAndArm(appId, handler);
    const sentBefore = net.urls.length;

    openApp(appId, 1);
    begin(appId, 1);
    const first = handler.handle(appId, postFrame('first'));
    await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toBeDefined());
    resolveNetConfirm({ granted: true });
    expect((await first).ok).toBe(true);
    expect(net.urls).toHaveLength(sentBefore + 1);

    const second = handler.handle(appId, postFrame('second'));
    await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toBeDefined());
    resolveNetConfirm({ granted: false });
    expect(await second).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(net.urls).toHaveLength(sentBefore + 1);
  });

  it('STICKY: after the run, a POST from the SAME frame generation parks an `afterRun`-tagged dialog — the remembered grant still does not answer', async () => {
    const appId = 'app-deleg-sticky';
    await seedApp(appId);
    const net = countingFetch();
    const handler = createNetHandlerFor({ fetchImpl: net.fetchImpl });
    await rememberAndArm(appId, handler);
    const sentBefore = net.urls.length;

    openApp(appId, 1);
    begin(appId, 1);
    endDelegatedRun(appId, 'run-1');
    expect(touchedGeneration(appId)).toBe(1);

    const after = handler.handle(appId, postFrame('after'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    const pending = netConfirmStore.get()!;
    expect(pending.scheduled).toMatchObject({ afterRun: true, appName: 'Net App' });
    expect(net.urls).toHaveLength(sentBefore);
    resolveNetConfirm({ granted: false });
    expect(await after).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
  });

  it('a RETRACTION (the app closed) clears the sticky posture: reopened at the same generation, the next POST passes through the remembered grant', async () => {
    const appId = 'app-deleg-retract';
    await seedApp(appId);
    const net = countingFetch();
    const handler = createNetHandlerFor({ fetchImpl: net.fetchImpl });
    await rememberAndArm(appId, handler);

    const unregister = openApp(appId, 0);
    begin(appId, 0);
    endDelegatedRun(appId, 'run-1');
    expect(touchedGeneration(appId)).toBe(0);

    unregister(); // the view unmounts — `state/net.ts` hears the retraction
    expect(touchedGeneration(appId)).toBeUndefined();

    openApp(appId, 0); // reopened: a fresh registration, generation 0 again
    const result = await handler.handle(appId, postFrame('reopened'));
    expect(result.ok).toBe(true);
    expect(netConfirmStore.get()).toBeNull();
  });

  it('`connectedFetchDepsFor`’s default is STILL the standing gate: a probe-shaped call during a run passes on the remembered grant and never parks a scheduled confirm', async () => {
    const appId = 'app-deleg-probe';
    await seedApp(appId);
    const net = countingFetch();
    const handler = createNetHandlerFor({ fetchImpl: net.fetchImpl });
    await rememberAndArm(appId, handler);

    openApp(appId, 1);
    begin(appId, 1);
    const db = await getUserDb();
    const executor = createConnectedFetch(connectedFetchDepsFor(db, net.fetchImpl));
    const result = await executor.execute(appId, { url: 'https://api.example.com/v1/items', method: 'POST', body: '{}' });
    expect(result.ok).toBe(true);
    expect(netConfirmStore.get()).toBeNull();
  });

  it('`scheduledRun()` answering true at an auth-shaped failure attributes it: the store entry carries `via: \'scheduled-run\'`', async () => {
    const appId = 'app-deleg-auth';
    await seedApp(appId);
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
      scheduledRun: () => true,
    });
    const result = await handler.handle(appId, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r1',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/data',
      method: 'GET',
    });
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(authShapedFailureStore.get()).toEqual({ appId, slot: SLOT, status: 401, detail: 'unauthorized', via: 'scheduled-run' });
  });

  it('NEGATIVE: `scheduledRun()` answering false leaves the entry exactly as today — no `via` key', async () => {
    const appId = 'app-deleg-auth-no';
    await seedApp(appId);
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
      scheduledRun: () => false,
    });
    await handler.handle(appId, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r1',
      instanceId: 'ins-1',
      url: 'https://api.example.com/v1/data',
      method: 'GET',
    });
    expect(authShapedFailureStore.get()).toEqual({ appId, slot: SLOT, status: 401, detail: 'unauthorized' });
  });
});
