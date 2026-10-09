// scheduleUiHarness.tsx — the shared bench for the schedule UI suites (TASK-20261009
// U1/U2/U4): a REAL engine over a memory-backed user db with the three outside seams faked
// exactly as `scheduler.test.ts` fakes them (a ticker factory, a lock manager or none, a
// recording executor), a held clock the page reads through `pageClock`, and the
// createRoot + act mount the hub suites use. Not a test file (no `.test.` in the name).

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useLocation } from 'react-router';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleRun, ScheduleStep, ScheduledTask } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import type { StepContext, StepExecutor, StepOutcome } from '../schedule/engine-types.js';
import type { LeaderLocks } from '../schedule/leader.js';
import { __setPageClockForTests } from '../schedule/pageModel.js';
import { __resetSchedulerForTests, initScheduler, type SchedulerDeps } from '../schedule/scheduler.js';
import type { Tick, Ticker } from '../schedule/tick.js';
import { installTestUserDb } from './userdbTestHelper.js';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Friday 2026-10-09 12:05Z — the hourly 13:00 is 55 minutes away, on the same local day in every zone. */
export const NOW = Date.parse('2026-10-09T12:05:00.000Z');
export const CREATED = '2026-10-01T00:00:00.000Z';
export const iso = (ms: number): string => new Date(ms).toISOString();

export const WEB: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };

export const NOTIFY: ScheduleStep = { kind: 'notify', title: 'Water', body: 'the ferns' };
export const THINK = (appId = 'ledger'): ScheduleStep => ({ kind: 'app-think', appId, prompt: 'sum it', context: { maxRows: 50 } });

// ------------------------------------------------------------------- the seams

export interface FakeTicker {
  factory: SchedulerDeps['ticker'];
  built: Array<{ ticker: Ticker; started: boolean; stopped: boolean; fire: (kind: Tick['kind']) => void }>;
}

export function fakeTicker(): FakeTicker {
  const built: FakeTicker['built'] = [];
  const factory: SchedulerDeps['ticker'] = (onTick, now) => {
    const entry: FakeTicker['built'][number] = {
      ticker: {
        start: () => {
          entry.started = true;
        },
        stop: () => {
          entry.stopped = true;
        },
        nextFireAt: () => undefined,
      },
      started: false,
      stopped: false,
      fire: (kind) => onTick({ kind, at: now() }),
    };
    built.push(entry);
    return entry.ticker;
  };
  return { factory, built };
}

/** A lock manager whose name is HELD by another tab: this context becomes a follower. */
export function heldElsewhere(): LeaderLocks & { release: () => void } {
  let grant: (() => void) | undefined;
  const request = (name: string, first: unknown, second?: unknown): Promise<unknown> => {
    const options = (typeof first === 'function' ? {} : first) as LockOptions;
    const callback = (typeof first === 'function' ? first : second) as (lock: Lock | null) => unknown;
    if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
    return new Promise((resolve) => {
      grant = () => resolve(callback({ name, mode: 'exclusive' }));
    });
  };
  return { request: request as LeaderLocks['request'], release: () => grant?.() };
}

export interface Recorder {
  calls: Array<{ step: ScheduleStep; ctx: StepContext }>;
  execute: StepExecutor;
}

export function recorder(answer: (step: ScheduleStep) => StepOutcome | Promise<StepOutcome> = () => ({ status: 'ok', summary: 'done', calls: { ai: 0, net: 0 } })): Recorder {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    execute: async (step, ctx) => {
      calls.push({ step, ctx });
      return answer(step);
    },
  };
}

// ------------------------------------------------------------------ the fixtures

export const makeTask = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'Hourly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [NOTIFY],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 7 * DAY,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
  ...over,
});

export const makeRun = (over: Partial<ScheduleRun> & Pick<ScheduleRun, 'taskId' | 'dueAt' | 'status'>): ScheduleRun => ({
  id: `r-${over.taskId}-${over.dueAt}`,
  trigger: 'due',
  collapsedCount: 1,
  host: { kind: 'web' },
  steps: [],
  calls: { ai: 0, net: 0 },
  ...over,
});

// ---------------------------------------------------------------------- the env

export interface Env {
  db: UserDb;
  clock: { now: number };
  rec: Recorder;
  ticker: FakeTicker;
  /** Boot the real engine over the db with the seams above (overridable per test). */
  boot(over?: Partial<SchedulerDeps>): Promise<void>;
}

export async function setupEnv(answer?: Parameters<typeof recorder>[0]): Promise<Env> {
  __resetSchedulerForTests();
  const clock = { now: NOW };
  __setPageClockForTests(() => new Date(clock.now));
  const db = await installTestUserDb();
  const rec = recorder(answer);
  const ticker = fakeTicker();
  return {
    db,
    clock,
    rec,
    ticker,
    boot: (over = {}) =>
      initScheduler({
        db: () => Promise.resolve(db),
        execute: rec.execute,
        locks: undefined,
        ticker: ticker.factory,
        now: () => new Date(clock.now),
        platform: () => WEB,
        allows: () => true,
        ...over,
      }),
  };
}

export function teardownEnv(): void {
  __resetSchedulerForTests();
  __setPageClockForTests();
}

// -------------------------------------------------------------------- the mount

let container: HTMLDivElement | undefined;
let root: Root | undefined;

export function mount(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

export function unmount(): void {
  if (root !== undefined) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
}

export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

export async function settleUntil(done: () => boolean, label: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => {
    el.click();
  });
  await settle(2);
}

export function PathProbe({ onPath }: { onPath: (path: string) => void }): ReactElement {
  const location = useLocation();
  onPath(`${location.pathname}${location.search}`);
  return <span data-testid="path-probe" />;
}

export const texts = (container: HTMLElement, selector: string): string[] => [...container.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent ?? '');
