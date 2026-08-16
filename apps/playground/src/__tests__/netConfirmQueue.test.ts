/**
 * TASK-20260815-provider-chat-lane AC11 (plan-review F4) — parked confirms are a QUEUE.
 *
 * The v1 store was a single slot set unconditionally: a second parked confirm OVERWROTE
 * the first, orphaning its resolver — that executor call awaited forever. One app firing
 * two concurrent mutating requests was rare; a chat rail sitting beside a running app
 * makes "app auto-POSTs while the user's provider_write is mid-confirm" ordinary, so the
 * collision gets a queue: the dialog renders the head, resolution advances the tail, and
 * EVERY parked promise settles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

import { installTestUserDb } from './userdbTestHelper.js';
import { createNetHandlerFor, netConfirmStore, resolveNetConfirm, __resetNetStateForTests } from '../state/net.js';
import { getUserDb } from '../state/userdb.js';

const APP = 'app-confirm-queue';
const HOST = 'api.queue.example';

async function seed(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Queue App', html: '<p>q</p>' });
  db.setSecret(authConnectionCredentialSecretKey(APP, 'q', 'api_key'), 'k-123');
  db.putDeclaredConnection(
    APP,
    'q',
    {
      slot: 'q',
      kind: 'api_key' as const,
      provider: { name: 'Queue Service' },
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
      declaredApiHosts: [HOST],
    },
    'inference',
  );
  db.approveConnection(APP, 'q');
}

const postFrame = (requestId: string, path: string): Parameters<ReturnType<typeof createNetHandlerFor>['handle']>[1] => ({
  v: 1,
  type: 'snug:net-request',
  requestId,
  instanceId: 'ins-1',
  url: `https://${HOST}${path}`,
  method: 'POST',
  body: '{}',
});

beforeEach(async () => {
  __resetNetStateForTests();
  await installTestUserDb();
  await seed();
});
afterEach(() => {
  __resetNetStateForTests();
});

describe('the confirm queue', () => {
  it('two concurrent confirms BOTH settle, in FIFO order, each with its own decision', async () => {
    const handler = createNetHandlerFor({ fetchImpl: async () => new Response('ok', { status: 200 }) });
    const first = handler.handle(APP, postFrame('r1', '/v1/first'));
    const second = handler.handle(APP, postFrame('r2', '/v1/second'));

    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    expect(netConfirmStore.get()?.request.url).toContain('/v1/first');

    resolveNetConfirm({ granted: true });
    // The head resolved; the SECOND parked confirm surfaces rather than being orphaned.
    await vi.waitFor(() => expect(netConfirmStore.get()?.request.url).toContain('/v1/second'));

    resolveNetConfirm({ granted: false });
    await expect(first).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(second).resolves.toMatchObject({ ok: false, code: 'NET_CONFIRM_DENIED' });
    expect(netConfirmStore.get()).toBeNull();
  });

  it('__resetNetStateForTests clears the whole queue, not just the head', async () => {
    const handler = createNetHandlerFor({ fetchImpl: async () => new Response('ok', { status: 200 }) });
    void handler.handle(APP, postFrame('r1', '/v1/a')).catch(() => undefined);
    void handler.handle(APP, postFrame('r2', '/v1/b')).catch(() => undefined);
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());

    __resetNetStateForTests();
    expect(netConfirmStore.get()).toBeNull();
    // A fresh confirm parks cleanly after the reset — no stale tail resurfaces.
    const fresh = handler.handle(APP, postFrame('r3', '/v1/c'));
    await vi.waitFor(() => expect(netConfirmStore.get()?.request.url).toContain('/v1/c'));
    resolveNetConfirm({ granted: false });
    await expect(fresh).resolves.toMatchObject({ ok: false });
  });
});
