// schedulerSeat.test.ts — TASK-20261009-scheduling-framework C7 (ADR-0074 §5, §7): the
// scheduler's platform seat, the `schedule` surface flag, and the revision signal.
//
// Three facts, each pinned against a REAL platform shape rather than a fixture of its own:
//   - `allows('schedule')` is true on the web default and on `hostCapabilities()` (absence
//     means enabled, like every host surface flag), and false ONLY when a platform says
//     `schedule: false` — the one reader every scheduling surface gates on;
//   - `scheduler` is OPTIONAL on `SnugPlatform` and typed: a platform without it is the
//     in-page story, a platform with it carries `wakeMode` + `hostLabel`, and `notify` is
//     optional within the seat (a host that cannot notify still has a label);
//   - `scheduleRevisionStore` bumps like the brain and library revisions, and the hook follows.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostCapabilities } from '../platform/hostCapabilities.js';
import type { SchedulerSeat, SnugPlatform } from '../platform/platform.js';
import { hostPlatform } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Module-level state under test (set-once platform) — each case gets a fresh module registry. */
async function freshPlatform(): Promise<typeof import('../platform/platform.js')> {
  vi.resetModules();
  return import('../platform/platform.js');
}

describe('allows("schedule") — absence means enabled; only an explicit false hides the surface', () => {
  it('is true on the web default, which names no `schedule` key at all', async () => {
    const { allows, getPlatform } = await freshPlatform();
    expect(getPlatform().capabilities.schedule).toBeUndefined();
    expect(allows('schedule')).toBe(true);
  });

  it('is true on hostCapabilities() — the kit binding runs the scheduler while its page is open', async () => {
    const { allows, setPlatform } = await freshPlatform();
    setPlatform(hostPlatform());
    expect(hostCapabilities().schedule).toBe(true);
    expect(allows('schedule')).toBe(true);
  });

  it('is false only when a platform says `schedule: false`', async () => {
    const { allows, setPlatform } = await freshPlatform();
    setPlatform(hostPlatform({ capabilities: hostCapabilities({ schedule: false }) }));
    expect(allows('schedule')).toBe(false);
  });

  it('a desktop platform that never mentions the key keeps the surface (no regression for a shell that predates it)', async () => {
    const { allows, setPlatform } = await freshPlatform();
    setPlatform({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } });
    expect(allows('schedule')).toBe(true);
  });
});

describe('SchedulerSeat — optional on the platform, typed when present', () => {
  it('the web default carries the tab seat (H2): page wake, "this tab", notify only through the opt-in', async () => {
    const { getPlatform } = await freshPlatform();
    expect(getPlatform().scheduler).toMatchObject({ wakeMode: 'page', hostLabel: 'this tab' });
  });

  it('a seat with only the two required fields type-checks — `notify` is optional within it', async () => {
    const seat: SchedulerSeat = { wakeMode: 'page', hostLabel: 'this artifact' };
    const platform: SnugPlatform = hostPlatform({ scheduler: seat });
    const { getPlatform, setPlatform } = await freshPlatform();
    setPlatform(platform);
    expect(getPlatform().scheduler).toBe(seat);
    expect(getPlatform().scheduler?.notify).toBeUndefined();
    expect(getPlatform().scheduler?.wakeMode).toBe('page');
    expect(getPlatform().scheduler?.hostLabel).toBe('this artifact');
  });

  it('a seat with `notify` answers one of the three outcomes — the shape a desktop shell will implement', async () => {
    const seen: Array<{ title: string; body: string }> = [];
    const seat: SchedulerSeat = {
      wakeMode: 'page',
      hostLabel: 'Snug for Mac',
      notify: async (n) => {
        seen.push(n);
        return 'shown';
      },
    };
    const { getPlatform, setPlatform } = await freshPlatform();
    setPlatform({ kind: 'desktop', scheduler: seat, capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } });
    const outcome = await getPlatform().scheduler?.notify?.({ title: 'Ledger', body: 'your digest is ready' });
    expect(outcome).toBe('shown');
    expect(seen).toEqual([{ title: 'Ledger', body: 'your digest is ready' }]);
    // The three outcomes are the whole enum — a reader's switch may be exhaustive over them.
    const outcomes: Array<Awaited<ReturnType<NonNullable<SchedulerSeat['notify']>>>> = ['shown', 'denied', 'unavailable'];
    expect(outcomes).toHaveLength(3);
  });
});

describe('scheduleRevisionStore — the same counter shape as the brain and library revisions', () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('starts at 0, bumps by one per call, and notifies subscribers', async () => {
    vi.resetModules();
    const { bumpScheduleRevision, scheduleRevisionStore } = await import('../platform/signals.js');
    expect(scheduleRevisionStore.get()).toBe(0);
    const seen: number[] = [];
    const unsubscribe = scheduleRevisionStore.subscribe(() => seen.push(scheduleRevisionStore.get()));
    bumpScheduleRevision();
    bumpScheduleRevision();
    expect(scheduleRevisionStore.get()).toBe(2);
    expect(seen).toEqual([1, 2]);
    unsubscribe();
    bumpScheduleRevision();
    expect(seen).toEqual([1, 2]);
  });

  it('is its own counter — a schedule bump moves neither the brain nor the library revision', async () => {
    vi.resetModules();
    const signals = await import('../platform/signals.js');
    signals.bumpScheduleRevision();
    expect(signals.scheduleRevisionStore.get()).toBe(1);
    expect(signals.brainRevisionStore.get()).toBe(0);
    expect(signals.libraryRevisionStore.get()).toBe(0);
  });

  it('useScheduleRevision() re-renders on a bump', async () => {
    vi.resetModules();
    const { bumpScheduleRevision, useScheduleRevision } = await import('../platform/signals.js');
    const renders: number[] = [];
    function Probe(): null {
      renders.push(useScheduleRevision());
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => mounted.render(createElement(Probe)));
    expect(renders).toEqual([0]);
    act(() => bumpScheduleRevision());
    expect(renders.at(-1)).toBe(1);
  });
});
