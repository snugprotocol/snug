// hostSurfaces.test.ts — TASK-20260905-host-kit P2: the optional surface flags on
// `SnugPlatform.capabilities` read through ONE helper, `allows(surface)`, whose rule is
// "absence = enabled" (the inverse of `hubAuth?`, on purpose: a test-constructed or web
// platform must keep every surface, and only a host that SAYS `false` hides one).
// Fresh module graph per case — setPlatform is set-once.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostSurface } from '../platform/platform.js';

const SURFACES: readonly HostSurface[] = ['brainSettings', 'account', 'sync', 'connections', 'share'];

async function fresh(): Promise<typeof import('../platform/platform.js')> {
  vi.resetModules();
  return import('../platform/platform.js');
}

afterEach(() => {
  vi.resetModules();
});

describe('secretsUsable() — whether any credential has a use on this platform (C1)', () => {
  it('web default: usable (BYOK keys and connection tokens both have consumers)', async () => {
    const platform = await fresh();
    expect(platform.secretsUsable()).toBe(true);
  });

  it('host posture with brainSettings AND connections off: NOT usable; either one alone keeps it usable', async () => {
    const off = await fresh();
    off.setPlatform({ kind: 'host', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, brainSettings: false, connections: false } });
    expect(off.secretsUsable()).toBe(false);
    const brainOnly = await fresh();
    brainOnly.setPlatform({ kind: 'host', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, connections: false } });
    expect(brainOnly.secretsUsable()).toBe(true);
    const connectionsOnly = await fresh();
    connectionsOnly.setPlatform({ kind: 'host', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, brainSettings: false } });
    expect(connectionsOnly.secretsUsable()).toBe(true);
  });
});

describe('allows(surface)', () => {
  it('the web default allows every surface (absence = enabled)', async () => {
    const platform = await fresh();
    for (const surface of SURFACES) expect(platform.allows(surface), surface).toBe(true);
  });

  it('a platform that says false hides exactly that surface; true and absent both allow', async () => {
    const platform = await fresh();
    platform.setPlatform({
      kind: 'host',
      capabilities: {
        subscriptionMode: false,
        hubSyncOrigin: false,
        lanHttpPrivate: false,
        brainSettings: false,
        account: false,
        share: true,
        // `sync` and `connections` deliberately absent → enabled
      },
    });
    expect(platform.allows('brainSettings')).toBe(false);
    expect(platform.allows('account')).toBe(false);
    expect(platform.allows('share')).toBe(true);
    expect(platform.allows('sync')).toBe(true);
    expect(platform.allows('connections')).toBe(true);
  });

  it('the host kit posture: every surface off at once', async () => {
    const platform = await fresh();
    platform.setPlatform({
      kind: 'host',
      binding: 'artifact',
      capabilities: {
        subscriptionMode: false,
        hubSyncOrigin: false,
        lanHttpPrivate: false,
        hubAuth: false,
        brainSettings: false,
        account: false,
        sync: false,
        connections: false,
        share: false,
      },
    });
    for (const surface of SURFACES) expect(platform.allows(surface), surface).toBe(false);
    expect(platform.getPlatform().kind).toBe('host');
    expect(platform.getPlatform().binding).toBe('artifact');
  });
});
