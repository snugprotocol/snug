// scheduleHonesty.test.ts — TASK-20261009-scheduling-framework E9 (ADR-0074 §5): `hostHonesty()`
// answers the one sentence for THIS host from the platform's scheduler seat and its storage rung,
// with the leader state's sibling fact as the only input it cannot read from the platform.
//
// Fed REAL platform objects where a shell's object is cheap to hold here (the web default is the
// module's own; the desktop and host shapes are the literals `schedulerSeat.test.ts` and the
// shared `hostPlatform` fixture already pin), through the set-once platform module — so each case
// takes a fresh module registry (the trap `platform.test.ts` records: `setPlatform` throws on a
// second call and after a first read). `honesty.js` is imported AFTER the reset so it binds to the
// same fresh `platform.js` the case installs into.
import { describe, expect, it, vi } from 'vitest';

import type { CustodySeat, SnugPlatform } from '../platform/platform.js';
import { hostPlatform } from './fixtures/hostPlatform.js';

type PlatformModule = typeof import('../platform/platform.js');
type HonestyModule = typeof import('../schedule/honesty.js');

async function fresh(platform?: SnugPlatform): Promise<HonestyModule & Pick<PlatformModule, 'getPlatform'>> {
  vi.resetModules();
  const platformModule: PlatformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const honesty: HonestyModule = await import('../schedule/honesty.js');
  return { ...honesty, getPlatform: platformModule.getPlatform };
}

/** The custody seat shape the host kit composes (`compose.ts`): a store with `workingCopy` on the memory rung. */
function custodySeat(workingCopy?: 'memory'): CustodySeat {
  const state = { dirty: false, readOnly: false, ...(workingCopy !== undefined ? { workingCopy } : {}) };
  return { state: { get: () => state, subscribe: () => () => {} } };
}

const DESKTOP: SnugPlatform = { kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } };

describe('hostHonesty — the web default (the module’s own object, nothing set)', () => {
  it('"runs while this tab is open" — no seat, the kind supplies the subject', async () => {
    const { hostHonesty, getPlatform } = await fresh();
    expect(getPlatform().kind).toBe('web');
    expect(getPlatform().scheduler).toMatchObject({ wakeMode: 'page', hostLabel: 'this tab' }); // H2: the web tab's seat
    expect(hostHonesty()).toBe('runs while this tab is open');
  });

  it('the leader state adds the sibling suffix only when sibling tabs cannot be seen', async () => {
    const { hostHonesty } = await fresh();
    expect(hostHonesty({ canSeeSiblings: true })).toBe('runs while this tab is open');
    expect(hostHonesty({ canSeeSiblings: false })).toBe('runs while this tab is open · other tabs can’t be seen from here');
  });
});

describe('hostHonesty — the desktop shell', () => {
  it('today’s desktop carries no seat: the kind falls back to "Snug for Mac"', async () => {
    const { hostHonesty } = await fresh(DESKTOP);
    expect(hostHonesty()).toBe('runs while Snug for Mac is open');
  });

  it('the seat PR-B composes names the host label itself — the same sentence, from the seat', async () => {
    const { hostHonesty } = await fresh({ ...DESKTOP, scheduler: { wakeMode: 'page', hostLabel: 'Snug for Mac' } });
    expect(hostHonesty()).toBe('runs while Snug for Mac is open');
  });

  it('a background seat (the deferred background-mode task) changes the verb, never by accident', async () => {
    const { hostHonesty } = await fresh({ ...DESKTOP, scheduler: { wakeMode: 'background', hostLabel: 'Snug for Mac' } });
    expect(hostHonesty()).toBe('runs in the background while Snug for Mac is running');
  });
});

describe('hostHonesty — the host kit (artifact binding)', () => {
  it('a durable working copy: "runs while this artifact is open"', async () => {
    const { hostHonesty } = await fresh(hostPlatform({ custody: custodySeat() }));
    expect(hostHonesty()).toBe('runs while this artifact is open');
  });

  it('the memory rung (Safari denies storage): the sentence says the page keeps nothing', async () => {
    const { hostHonesty } = await fresh(hostPlatform({ custody: custodySeat('memory') }));
    expect(hostHonesty()).toBe('runs while this artifact is open — this page keeps nothing after it closes');
  });

  it('the seat’s label wins over the kind, and the memory rung and the sibling suffix compose in that order', async () => {
    const { hostHonesty } = await fresh(
      hostPlatform({ custody: custodySeat('memory'), scheduler: { wakeMode: 'page', hostLabel: 'this page' } }),
    );
    expect(hostHonesty({ canSeeSiblings: false })).toBe(
      'runs while this page is open — this page keeps nothing after it closes · other tabs can’t be seen from here',
    );
  });

  it('a host without a custody seat is on the durable rung — absence never reads as memory', async () => {
    const { hostHonesty } = await fresh(hostPlatform());
    expect(hostHonesty()).toBe('runs while this artifact is open');
  });

  it('the storage rung is read PER CALL from the custody store, not captured once', async () => {
    const state: { dirty: boolean; readOnly: boolean; workingCopy?: 'memory' } = { dirty: false, readOnly: false };
    const seat: CustodySeat = { state: { get: () => state, subscribe: () => () => {} } };
    const { hostHonesty } = await fresh(hostPlatform({ custody: seat }));
    expect(hostHonesty()).toBe('runs while this artifact is open');
    state.workingCopy = 'memory';
    expect(hostHonesty()).toBe('runs while this artifact is open — this page keeps nothing after it closes');
  });
});

describe('honestyInputFor — the pure derivation the sentence is built from', () => {
  it('maps a platform and the leader state onto copy.hostHonesty’s input, field by field', async () => {
    const { honestyInputFor, getPlatform } = await fresh();
    // H2: the web default carries the tab seat, so its label and wake mode ride along.
    expect(honestyInputFor(getPlatform())).toEqual({ kind: 'web', hostLabel: 'this tab', wakeMode: 'page', storageRung: 'durable' });
    expect(
      honestyInputFor(
        hostPlatform({ custody: custodySeat('memory'), scheduler: { wakeMode: 'page', hostLabel: 'this artifact' } }),
        { canSeeSiblings: false },
      ),
    ).toEqual({ kind: 'host', hostLabel: 'this artifact', wakeMode: 'page', storageRung: 'memory', canSeeSiblingTabs: false });
  });
});
