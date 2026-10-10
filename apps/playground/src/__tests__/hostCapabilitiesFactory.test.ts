// hostCapabilitiesFactory.test.ts — TASK-20261003 K4 (ADR-0072 §3): ONE capability table for
// every host binding. The block used to be hand-written in the kit's platform, twice in the
// runner's composition and once in this package's fixture; this pins the one that is left,
// and that the fixture is made of it. (That no OTHER literal exists is the kit's lint —
// apps/host `oneKit.test.ts`.)
import { describe, expect, it } from 'vitest';

import { hostCapabilities } from '../platform/hostCapabilities.js';
import { HOST_OFF_CAPABILITIES, hostPlatform } from './fixtures/hostPlatform.js';

describe('hostCapabilities — the kit’s posture, stated once', () => {
  it('every launch boolean explicit, every host surface off, the app export ON, the scheduler ON, access between apps ON', () => {
    expect(hostCapabilities()).toEqual({
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
      appExport: true,
      // TASK-20261009 C7 (ADR-0074 §7): the kit binding runs the scheduler while its page is open.
      schedule: true,
      // TASK-20261010-cross-app-access AC20 (ADR-0075): ON by default; a kit page whose boot probe
      // cannot construct a blob Worker composes `{ access: false }` (capability truth, ADR-0072 §4).
      access: true,
    });
  });

  it('the access flag is an override like any other: a host that cannot run the read says false, and only that moves', () => {
    expect(hostCapabilities({ access: false })).toEqual({ ...hostCapabilities(), access: false });
  });

  it('a binding states only what it does differently — and nothing else moves', () => {
    const runner = hostCapabilities({ connections: true, oauthRedirect: false });
    expect(runner).toEqual({ ...hostCapabilities(), connections: true, oauthRedirect: false });
    expect(hostCapabilities({ appExport: false }).appExport).toBe(false);
  });

  it('hands back a FRESH object each time — one binding’s overrides cannot leak into the next', () => {
    const first = hostCapabilities();
    first.connections = true;
    expect(hostCapabilities().connections).toBe(false);
    expect(hostCapabilities()).not.toBe(hostCapabilities());
  });

  it('the playground’s host fixture is this table, not a fifth copy of it', () => {
    expect(HOST_OFF_CAPABILITIES).toEqual(hostCapabilities());
    expect(hostPlatform().capabilities).toEqual(hostCapabilities());
  });
});
