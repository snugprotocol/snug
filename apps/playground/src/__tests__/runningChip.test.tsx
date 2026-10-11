// runningChip.test.tsx — TASK-20261009-scheduling-framework U10 (security F15): the header
// whisper while a scheduled job is in flight. Over the REAL engine with an executor that holds
// its step open until the test releases or cancels it, so "renders only while something runs"
// and "cancel records the result interrupted" are the production queue's own behaviour, not a
// store the test set by hand. The mount in App.tsx's header is pinned by reading the source:
// the chip must follow `<HelperSurface />` directly, on every route.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduledTask } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import { REFRESH_RUN, RUNNING_CHIP } from '../schedule/copy.js';
import type { StepExecutor, StepOutcome } from '../schedule/engine-types.js';
import { RunningChip } from '../schedule/RunningChip.js';
import { beginDelegatedRun, clearTouchedGeneration, endDelegatedRun } from '../schedule/runPlacement.js';
import { __resetSchedulerForTests, initScheduler, runNow, schedulerStore, type SchedulerDeps } from '../schedule/scheduler.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-09T12:05:00.000Z');
const CREATED = '2026-10-01T00:00:00.000Z';
const WEB: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };

let db: UserDb;
let container: HTMLDivElement | undefined;
let root: Root | undefined;
let release: (() => void) | undefined;

/** Holds the step open: resolves on `release()`, rejects when the queue aborts it (the cancel). */
const holding: StepExecutor = (_step, ctx) =>
  new Promise<StepOutcome>((resolve, reject) => {
    release = () => resolve({ status: 'ok', summary: 'done', calls: { ai: 0, net: 0 } });
    ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

const deps = (): Partial<SchedulerDeps> => ({
  db: () => Promise.resolve(db),
  execute: holding,
  locks: undefined,
  ticker: () => ({ start: () => {}, stop: () => {}, nextFireAt: () => undefined }),
  now: () => new Date(NOW),
  platform: () => WEB,
  allows: () => true,
});

const task = (): ScheduledTask => ({
  id: 't1',
  title: 'Hourly ledger digest',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [{ kind: 'notify', title: 'Water', body: 'the ferns' }],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 3_600_000,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
});

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <RunningChip />
      </MemoryRouter>,
    );
  });
  return container;
}

beforeEach(async () => {
  __resetSchedulerForTests();
  release = undefined;
  db = await installTestUserDb();
  db.putScheduledTask(task());
});

afterEach(() => {
  release?.();
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  __resetSchedulerForTests();
});

describe('RunningChip (U10)', () => {
  it('renders nothing while nothing is running', async () => {
    await initScheduler(deps());
    const el = await mount();
    expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull();
    expect(el.innerHTML).toBe('');
  });

  it('while a run is in flight: role=status, the label, the schedule’s title, and one act whose name says what it cancels', async () => {
    await initScheduler(deps());
    const el = await mount();
    await act(async () => {
      await runNow('t1');
    });
    await vi.waitFor(() => expect(schedulerStore.get().running?.taskId).toBe('t1'));
    await act(async () => {
      await Promise.resolve();
    });
    const chip = el.querySelector('[data-testid="schedule-running-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.getAttribute('aria-label')).toBe(`${RUNNING_CHIP.label}: Hourly ledger digest`);
    expect(chip?.className).toContain('auth-repair-chip');
    expect(chip?.className).toContain('app-update-chip');
    expect(chip?.textContent).toContain(RUNNING_CHIP.label);
    expect(chip?.textContent).toContain('Hourly ledger digest');
    const cancel = chip?.querySelector('button');
    expect(cancel?.textContent).toBe(RUNNING_CHIP.cancel);
    expect(cancel?.getAttribute('aria-label')).toBe('cancel Hourly ledger digest');
  });

  it('cancel records the run interrupted (reason cancelled) and the chip leaves', async () => {
    await initScheduler(deps());
    const el = await mount();
    await act(async () => {
      await runNow('t1');
    });
    await vi.waitFor(() => expect(schedulerStore.get().running?.taskId).toBe('t1'));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-running-chip"] button')?.click();
    });
    await vi.waitFor(() => expect(schedulerStore.get().running).toBeUndefined());
    const rows = db.listScheduleRuns('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('interrupted');
    expect(rows[0]?.reason).toBe('cancelled');
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull();
  });

  it('a run that finishes on its own takes the chip with it', async () => {
    await initScheduler(deps());
    const el = await mount();
    await act(async () => {
      await runNow('t1');
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-running-chip"]')).not.toBeNull());
    await act(async () => {
      release?.();
      release = undefined;
    });
    await vi.waitFor(() => expect(schedulerStore.get().running).toBeUndefined());
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull();
    expect(db.listScheduleRuns('t1')[0]?.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1 (ADR-0077 §2; contract v2 RunningChip) — a run on the OPEN app
// says where it is running. With a delegated run in flight for the running schedule's app, the
// label reads *running in <app>* (`RUNNING_CHIP.inApp`) and the accessible name says the whole
// sentence: "<title> is running in <app>". Without one, the chip is exactly as above.
// ---------------------------------------------------------------------------------------------

describe('RunningChip — a run delegated to the open app (TASK-20261010-host-broker PR-1)', () => {
  const ended: Array<() => void> = [];
  afterEach(() => {
    for (const end of ended.splice(0)) end();
  });

  async function startRun(): Promise<HTMLDivElement> {
    db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<p>ledger</p>' });
    db.putScheduledTask({ ...task(), steps: [{ kind: 'app-run', appId: 'ledger' }] });
    await initScheduler(deps());
    const el = await mount();
    await act(async () => {
      await runNow('t1');
    });
    await vi.waitFor(() => expect(schedulerStore.get().running?.taskId).toBe('t1'));
    return el;
  }

  function delegate(appId: string, taskId: string, appName: string): void {
    const begun = beginDelegatedRun({ appId, appName, runId: 'run-x', taskId, title: 'Hourly ledger digest', generation: 1 });
    expect(begun.ok).toBe(true);
    ended.push(() => {
      endDelegatedRun(appId, 'run-x');
      clearTouchedGeneration(appId, 1);
    });
  }

  it('with a delegated run for the running schedule’s app: the label is `RUNNING_CHIP.inApp(appName)`, the aria-label "<title> is running in <app>"', async () => {
    const el = await startRun();
    await act(async () => {
      delegate('ledger', 't1', 'Ledger');
    });
    await vi.waitFor(() =>
      expect(el.querySelector('.schedule-running-label')?.textContent).toBe(RUNNING_CHIP.inApp('Ledger')),
    );
    const chip = el.querySelector('[data-testid="schedule-running-chip"]');
    expect(chip?.getAttribute('aria-label')).toBe('Hourly ledger digest is running in Ledger');
    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.querySelector('button')?.textContent).toBe(RUNNING_CHIP.cancel); // the one act is unchanged
  });

  it('the label follows the store: when the delegated run ends, the chip reads as before', async () => {
    const el = await startRun();
    await act(async () => {
      delegate('ledger', 't1', 'Ledger');
    });
    await vi.waitFor(() => expect(el.querySelector('.schedule-running-label')?.textContent).toBe(RUNNING_CHIP.inApp('Ledger')));
    await act(async () => {
      endDelegatedRun('ledger', 'run-x');
    });
    await vi.waitFor(() => expect(el.querySelector('.schedule-running-label')?.textContent).toBe(RUNNING_CHIP.label));
    expect(el.querySelector('[data-testid="schedule-running-chip"]')?.getAttribute('aria-label')).toBe(`${RUNNING_CHIP.label}: Hourly ledger digest`);
  });

  it('NEGATIVE: a delegated run for ANOTHER app (another schedule) leaves the label unchanged', async () => {
    const el = await startRun();
    await act(async () => {
      delegate('weather', 't-other', 'Weather');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('.schedule-running-label')?.textContent).toBe(RUNNING_CHIP.label);
    expect(el.querySelector('[data-testid="schedule-running-chip"]')?.getAttribute('aria-label')).toBe(`${RUNNING_CHIP.label}: Hourly ledger digest`);
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-3 (contract v2 D-PR3-19; DS8, F13) — a REFRESH another app asked
// for is visible too. It runs the SOURCE's own code on its open frame as a delegated run with
// `posture: 'refresh'`, and no schedule is running, so the scheduler's view says nothing; the chip
// renders from the placement store instead: the label `RUNNING_CHIP.fetching(<source>)`, the title
// the record's own (`REFRESH_RUN.title(<asker>)`), the accessible name "<source> is fetching new
// data — <asker> asked", and NO act in PR-3 (the run is bounded by 90 s; *cancel* is a rider). A
// delegated run with the default posture and nothing running stays invisible (today's rule).
//
// `posture` is what `beginDelegatedRun`'s input gains in PR-3; until then a LOCAL structural type
// stands in (the implementation lane replaces it with the real field at Gate 5).
// ---------------------------------------------------------------------------------------------

describe('RunningChip — a refresh another app asked for (TASK-20261010-host-broker PR-3)', () => {
  type Posture = 'schedule' | 'refresh';
  type PosturedBegin = Parameters<typeof beginDelegatedRun>[0] & { posture?: Posture };

  const ended: Array<() => void> = [];
  afterEach(() => {
    for (const end of ended.splice(0)) end();
  });

  function delegate(input: PosturedBegin): void {
    const begun = beginDelegatedRun(input);
    expect(begun.ok).toBe(true);
    ended.push(() => {
      endDelegatedRun(input.appId, input.runId);
      clearTouchedGeneration(input.appId, input.generation);
    });
  }

  const refreshRun = (): PosturedBegin => ({
    appId: 'ledger',
    appName: 'Ledger',
    runId: 'refresh-run-1',
    taskId: 'access-refresh',
    title: REFRESH_RUN.title('Budget'),
    generation: 1,
    posture: 'refresh',
  });

  it('nothing scheduled is running, a refresh is in flight → the chip: label `RUNNING_CHIP.fetching(source)`, the title `REFRESH_RUN.title(asker)`, role=status, the accessible name "<source> is fetching new data — <asker> asked", and NO act', async () => {
    await initScheduler(deps());
    const el = await mount();
    expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull();
    await act(async () => {
      delegate(refreshRun());
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-running-chip"]')).not.toBeNull());
    expect(schedulerStore.get().running, 'the scheduler has nothing running').toBeUndefined();
    const chip = el.querySelector('[data-testid="schedule-running-chip"]')!;
    expect(chip.getAttribute('role')).toBe('status');
    expect(chip.querySelector('.schedule-running-label')?.textContent).toBe(RUNNING_CHIP.fetching('Ledger'));
    expect(chip.querySelector('.schedule-running-title')?.textContent).toBe(REFRESH_RUN.title('Budget'));
    expect(chip.getAttribute('aria-label')).toBe('Ledger is fetching new data — Budget asked');
    expect(chip.querySelector('button'), 'no act in PR-3 — the run is bounded').toBeNull();
    expect(chip.textContent).not.toContain(RUNNING_CHIP.cancel);
  });

  it('the chip leaves when the refresh ends', async () => {
    await initScheduler(deps());
    const el = await mount();
    const run = refreshRun();
    await act(async () => {
      delegate(run);
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-running-chip"]')).not.toBeNull());
    await act(async () => {
      endDelegatedRun(run.appId, run.runId);
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull());
    expect(el.innerHTML).toBe('');
  });

  it('NEGATIVE: a delegated run with the DEFAULT posture and nothing scheduled running → no chip (today’s rule: the schedule chip follows the scheduler)', async () => {
    await initScheduler(deps());
    const el = await mount();
    await act(async () => {
      delegate({ appId: 'ledger', appName: 'Ledger', runId: 'run-x', taskId: 't-other', title: 'Hourly ledger digest', generation: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull();
    expect(el.innerHTML).toBe('');
  });

  it('NEGATIVE: an explicit `posture: "schedule"` without a running schedule → no chip either', async () => {
    await initScheduler(deps());
    const el = await mount();
    await act(async () => {
      delegate({ appId: 'ledger', appName: 'Ledger', runId: 'run-s', taskId: 't-other', title: 'Hourly ledger digest', generation: 1, posture: 'schedule' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="schedule-running-chip"]')).toBeNull();
  });
});

describe('the mount (App.tsx header, every route)', () => {
  it('sits in the header nav directly after <HelperSurface />', () => {
    const source = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(source).toContain("import { RunningChip } from './schedule/RunningChip.js';");
    const helper = source.indexOf('<HelperSurface />');
    const chip = source.indexOf('<RunningChip />');
    expect(helper).toBeGreaterThan(0);
    expect(chip).toBeGreaterThan(helper);
    // Nothing but whitespace and a comment between the two: the chip is the next element.
    const between = source.slice(helper + '<HelperSurface />'.length, chip).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(between.trim()).toBe('');
  });
});
