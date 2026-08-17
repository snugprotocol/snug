// The helper must be RUNNING when an app reaches for it (ADR-0032).
//
// FOUND BY WALKING THE PATH (owner, 2026-08-17): the wizard linked WhatsApp, the token was
// stored, the connection showed connected — and the app still said "the WhatsApp helper is
// not running". It was telling the truth. `sidecarCtl('start')` had exactly ONE caller in
// the entire codebase: `beginDeviceLink`, in the wizard. Nothing started the helper for an
// APP, so the moment the wizard closed, the process the whole feature depends on was gone
// and every app request failed at a socket that did not exist.
//
// The helper is deliberately a spawn-supervised child rather than a daemon, so "who starts
// it" is a real question the design owes an answer to. The answer is the TRANSPORT: an app
// request is exactly the evidence that it is wanted, `sidecar_ctl start` is idempotent by
// construction (a second call returns the running instance rather than spawning a rival),
// and starting it anywhere earlier would run a WhatsApp session for users who never open
// the app.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SnugPlatform } from '../platform/platform.js';

function desktopPlatform(seats: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...seats,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('the app-facing sidecar transport starts the helper on demand', () => {
  it('calls sidecarCtl("start") before the first request', async () => {
    const order: string[] = [];
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async (action) => {
          order.push(`ctl:${action}`);
          return { running: true, nonce: 'n' };
        },
        sidecarFetch: async (method, path) => {
          order.push(`fetch:${method} ${path}`);
          return { status: 200, body: '{"chats":[]}' };
        },
      }),
    );

    const net = await import('../state/net.js');
    const result = await net.__sidecarAppFetchForTests('GET', '/chats');

    expect(result.status).toBe(200);
    // THE ORDER IS THE PROPERTY: the helper is up before anything is asked of it.
    expect(order).toEqual(['ctl:start', 'fetch:GET /chats']);
  });

  it('surfaces a start failure as a named error rather than a socket error', async () => {
    // "could not start" and "started but did not answer" are different problems with
    // different fixes; collapsing them is what made the earlier rounds of this bug so hard
    // to read.
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async () => {
          throw new Error('node 18 is too old');
        },
        sidecarFetch: async () => ({ status: 200, body: '{}' }),
      }),
    );

    const net = await import('../state/net.js');
    await expect(net.__sidecarAppFetchForTests('GET', '/chats')).rejects.toThrow(/node 18 is too old/);
  });

  it('refuses when the shell offers no sidecar seat at all (web)', async () => {
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } });

    const net = await import('../state/net.js');
    await expect(net.__sidecarAppFetchForTests('GET', '/chats')).rejects.toThrow(/desktop/i);
  });
});
