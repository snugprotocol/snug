// TASK-20261003 R3 S1 (ADR-0072 §4): the desktop shell's REAL platform object, through the
// playground's `offersOf`.
//
// WHY THIS FILE EXISTS. Whether a host can run an app is derived now, from the seats its
// platform carries — `fetchImpl`, the LAN pair, the three sidecar seats, the connections
// surface — and no longer from `kind === 'desktop'`. So the desktop is "the host that runs
// everything" only for as long as `createDesktopPlatform()` actually carries every seat, and
// that is a fact about THIS package: the playground's own suites build a fake desktop and
// would stay green with a seat deleted here (lessons 2026-08-13 — assert a cross-package
// seam's identity from the integrating side; `sidecarSeamWiring.test.ts` is the same shape).
//
// What a missing seat would cost a user: without `fetchImpl` Trade Copilot is disabled on the
// desktop ("needs more than a browser") and the wizard warns that Coinbase "may fail here";
// without the LAN pair Moodboard is; without any one sidecar seat Telepath is.

import { describe, expect, it, vi } from 'vitest';

import { HOST_OFFERS, availabilityOf, offersOf, type AppNeed, type HostOffers } from '@playground/platform/availability';

// The Tauri core module is not loadable outside a shell; what is under test is which seats
// the platform object CARRIES, not what they do when called.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));

/** The desktop, as a LITERAL — never read back from the module under test. */
const EVERYTHING: HostOffers = { network: true, 'native-fetch': true, oauth: true, lan: true, helper: true };

describe('the desktop platform offers every need an app can have', () => {
  it('createDesktopPlatform() → network, native-fetch, a sign-in, the home network and the phone helper', async () => {
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    expect(offersOf(createDesktopPlatform())).toEqual(EVERYTHING);
  });

  it('is the row `runsIn` is judged against — the table and the shell cannot drift apart', async () => {
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    expect(offersOf(createDesktopPlatform())).toEqual(HOST_OFFERS.desktop);
  });

  it('so no need set is blocked here — the desktop is where "runs in" always points', async () => {
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const offers = offersOf(createDesktopPlatform());
    const everyNeed: AppNeed[] = ['network', 'native-fetch', 'oauth', 'lan', 'helper'];
    expect(availabilityOf(everyNeed, offers)).toEqual({ ok: true });
  });

  it('each offer rests on its SEATS: take one away and that offer — and only that one — goes', async () => {
    // The mutation this file exists to catch, run against the real object rather than
    // against the source: a deleted line in platform-desktop.ts looks exactly like this.
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const without = (seat: string): HostOffers => {
      const platform = { ...createDesktopPlatform() } as Record<string, unknown>;
      delete platform[seat];
      return offersOf(platform as never);
    };
    expect(without('fetchImpl')).toEqual({ ...EVERYTHING, 'native-fetch': false });
    expect(without('lanFetch')).toEqual({ ...EVERYTHING, lan: false });
    expect(without('lanPair')).toEqual({ ...EVERYTHING, lan: false });
    for (const seat of ['sidecarCtl', 'sidecarFetch', 'sidecarWizardFetch']) {
      expect(without(seat), seat).toEqual({ ...EVERYTHING, helper: false });
    }
  });
});

describe('the scheduler seat (TASK-20261009 H3 + H1; ADR-0074 §7)', () => {
  it('createDesktopPlatform() names itself as the subject of the honesty line — "Snug for Mac" — promises only the page, and carries `notify` (the plugin seat, src/notify.ts)', async () => {
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const { scheduler } = createDesktopPlatform();
    expect(scheduler).toMatchObject({ wakeMode: 'page', hostLabel: 'Snug for Mac' });
    expect(Object.keys(scheduler ?? {}).sort()).toEqual(['hostLabel', 'notify', 'wakeMode']);
    expect(typeof scheduler?.notify, 'the H1 seat: a deleted `notify` line here would silently put the desktop back to inbox-only').toBe('function');
  });

  it('the seat’s `notify` is the one the engine reads per run — present on the object, not reached through a getter', async () => {
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const { scheduler } = createDesktopPlatform();
    expect(Object.getOwnPropertyDescriptor(scheduler, 'notify')?.get).toBeUndefined();
  });
});
