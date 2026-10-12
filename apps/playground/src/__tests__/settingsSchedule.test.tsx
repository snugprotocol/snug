// settingsSchedule.test.tsx — TASK-20261009-scheduling-framework U6 (ADR-0074 §6–§7): Settings
// → schedule. The global pause writes the production scheduler state and raises the banner;
// browser notifications are asked for ON THE CLICK and never at mount, the opt-in lands in the
// storage key the web seat reads, and `denied` says where to change it; the honesty line is
// the host's; a follower says so; *clear history* is armed before it clears, and the accessor
// keeps what is still waiting on the user; "never let apps suggest schedules" is a storage
// flag the suggestion strip's intake reads (PR-B, P3), so the switch is rendered and writes it.
// The card is mounted in SettingsView after the connections section, gated on `allows('schedule')`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import { WEB_NOTIFY_OPT_IN_KEY } from '../platform/webNotify.js';
import { disarmAllTasks } from '../schedule/acts.js';
import { followerTab, globalPaused } from '../schedule/copy.js';
import { SETTINGS } from '../schedule/copy.page.js';
import { NO_SUGGESTIONS_KEY, NOTIFY_OPT_IN_KEY, ScheduleSettingsCard } from '../schedule/ScheduleSettingsCard.js';
import { __resetSchedulerForTests, initScheduler, schedulerStore, type SchedulerDeps } from '../schedule/scheduler.js';
import { SettingsView } from '../views/SettingsView.js';
import { installTestUserDb } from './userdbTestHelper.js';

// PR-4 Gate-5 U7: `disarmAllTasks` wrapped (not replaced) so ONE test can make Settings' act fail.
vi.mock('../schedule/acts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schedule/acts.js')>();
  return { ...actual, disarmAllTasks: vi.fn(actual.disarmAllTasks) };
});

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

const deps = (): Partial<SchedulerDeps> => ({
  db: () => Promise.resolve(db),
  execute: async () => ({ status: 'ok', calls: { ai: 0, net: 0 } }),
  locks: undefined,
  ticker: () => ({ start: () => {}, stop: () => {}, nextFireAt: () => undefined }),
  now: () => new Date(NOW),
  platform: () => WEB,
  allows: () => true,
});

const task = (): ScheduledTask => ({
  id: 't1',
  title: 'Hourly',
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

const run = (dueAt: string, status: ScheduleRun['status']): ScheduleRun => ({
  id: `r-${dueAt}`,
  taskId: 't1',
  dueAt,
  trigger: 'due',
  collapsedCount: 1,
  status,
  finishedAt: dueAt,
  host: { kind: 'web' },
  steps: [],
  calls: { ai: 0, net: 0 },
});

/** A `Notification` the way the browser exposes it: a constructor with static `permission` and `requestPermission`. */
function fakeNotification(permission: NotificationPermission, answer: NotificationPermission = 'granted'): { ctor: typeof Notification; requestPermission: ReturnType<typeof vi.fn> } {
  const requestPermission = vi.fn(async () => answer);
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
  }
  return { ctor: FakeNotification as unknown as typeof Notification, requestPermission };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(node: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  await settle();
  return container;
}

const button = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

beforeEach(async () => {
  __resetSchedulerForTests();
  vi.mocked(disarmAllTasks).mockClear();
  localStorage.clear();
  vi.stubGlobal('Notification', undefined);
  db = await installTestUserDb();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  __resetSchedulerForTests();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the global pause (E7)', () => {
  it('the switch writes schedulerState.globalPause and raises the banner; off again lowers it', async () => {
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="schedule-global-pause"]');
    expect(toggle?.getAttribute('role')).toBe('switch');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('[data-testid="schedule-global-paused-banner"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    await vi.waitFor(() => expect(db.getSchedulerState()?.globalPause).toBe(true));
    await settle();
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('[data-testid="schedule-global-paused-banner"]')?.textContent).toBe(globalPaused);

    await act(async () => {
      toggle?.click();
    });
    await vi.waitFor(() => expect(db.getSchedulerState()?.globalPause).toBe(false));
    await settle();
    expect(el.querySelector('[data-testid="schedule-global-paused-banner"]')).toBeNull();
  });
});

describe('browser notifications (H2) — asked for on the click, never at boot', () => {
  it('mounting never calls requestPermission; the click does, once, and the opt-in lands in the web seat’s storage key', async () => {
    const api = fakeNotification('default');
    vi.stubGlobal('Notification', api.ctor);
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(api.requestPermission).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="schedule-notify-state"]')?.textContent).toBe(SETTINGS.notifyDefault);
    expect(localStorage.getItem(WEB_NOTIFY_OPT_IN_KEY)).toBeNull();
    expect(NOTIFY_OPT_IN_KEY).toBe(WEB_NOTIFY_OPT_IN_KEY);

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-notify-ask"]')?.click();
    });
    await settle();
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(WEB_NOTIFY_OPT_IN_KEY)).toBe('1');
    expect(el.querySelector('[data-testid="schedule-notify-state"]')?.textContent).toBe(SETTINGS.notifyOn);
    expect(el.querySelector('[data-testid="schedule-notify-ask"]')).toBeNull();

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-notify-off"]')?.click();
    });
    await settle();
    expect(localStorage.getItem(WEB_NOTIFY_OPT_IN_KEY)).toBeNull();
    expect(el.querySelector('[data-testid="schedule-notify-state"]')?.textContent).toBe(SETTINGS.notifyAllowed);
  });

  it('a click the browser answers "denied" stores no opt-in and says where to change it', async () => {
    const api = fakeNotification('default', 'denied');
    vi.stubGlobal('Notification', api.ctor);
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-notify-ask"]')?.click();
    });
    await settle();
    expect(localStorage.getItem(WEB_NOTIFY_OPT_IN_KEY)).toBeNull();
    expect(el.querySelector('[data-testid="schedule-notify-state"]')?.textContent).toBe(SETTINGS.notifyDenied);
    expect(el.querySelector('[data-testid="schedule-notify-ask"]')).toBeNull();
  });

  it('already denied: the site-settings sentence and no button', async () => {
    const api = fakeNotification('denied');
    vi.stubGlobal('Notification', api.ctor);
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(el.querySelector('[data-testid="schedule-notify-state"]')?.textContent).toContain('site settings');
    expect(el.querySelector('[data-testid="schedule-notify-ask"]')).toBeNull();
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('no Notification API at all: the sentence says so and nothing is offered', async () => {
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(el.querySelector('[data-testid="schedule-notify-state"]')?.textContent).toBe(SETTINGS.notifyUnavailable);
    expect(el.querySelector('[data-testid="schedule-notify-ask"]')).toBeNull();
  });
});

describe('the honesty line and the follower state (E2, E9)', () => {
  it('says what THIS host can do — no lock manager here, so sibling tabs cannot be seen', async () => {
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(el.querySelector('[data-testid="schedule-honesty"]')?.textContent).toBe('runs while this tab is open · other tabs can’t be seen from here');
    expect(el.querySelector('[data-testid="schedule-follower"]')).toBeNull();
  });

  it('a follower tab says scheduling runs in another tab', async () => {
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    await act(async () => {
      schedulerStore.set({ ...schedulerStore.get(), leader: { leader: false, canSeeSiblings: true, reason: 'locks' } });
    });
    expect(el.querySelector('[data-testid="schedule-follower"]')?.textContent).toBe(followerTab);
    expect(el.querySelector('[data-testid="schedule-honesty"]')?.textContent).toBe('runs while this tab is open');
  });
});

describe('clear history (F19)', () => {
  it('is armed before it clears; "keep" stands down; "clear" keeps only what still waits on the user', async () => {
    db.putScheduledTask(task());
    db.putScheduleRun(run('2026-10-09T10:00:00.000Z', 'ok'));
    db.putScheduleRun(run('2026-10-09T11:00:00.000Z', 'failed'));
    db.putScheduleRun(run('2026-10-09T12:00:00.000Z', 'needs-you'));
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(el.querySelector('[data-testid="schedule-clear-confirm"]')).toBeNull();

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-clear-history"]')?.click();
    });
    expect(el.querySelector('[data-testid="schedule-clear-confirm"]')?.textContent).toContain(SETTINGS.clearArm);
    await act(async () => {
      button(el, SETTINGS.clearKeep)?.click();
    });
    expect(el.querySelector('[data-testid="schedule-clear-confirm"]')).toBeNull();
    expect(db.listScheduleRuns('t1')).toHaveLength(3);

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-clear-history"]')?.click();
    });
    await act(async () => {
      button(el, SETTINGS.clearConfirm)?.click();
    });
    await vi.waitFor(() => expect(db.listScheduleRuns('t1').map((row) => row.status)).toEqual(['needs-you']));
    await settle();
    expect(el.querySelector('[data-testid="schedule-clear-confirm"]')).toBeNull();
    expect(el.textContent).toContain(SETTINGS.cleared);
  });
});

describe('never let apps suggest schedules (ADR-0074 §4; the strip’s intake reads it — P3)', () => {
  it('is a switch that writes the flag the intake reads, off by default, with its sentences', async () => {
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="schedule-no-suggestions"]');
    expect(toggle?.getAttribute('role')).toBe('switch');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(el.textContent).toContain(SETTINGS.noSuggestions);
    expect(el.textContent).toContain(SETTINGS.noSuggestionsHint);
    expect([...el.querySelectorAll('[role="switch"]')]).toHaveLength(2);
    expect(NO_SUGGESTIONS_KEY).toBe('snug:schedule-no-suggestions');
    expect(localStorage.getItem(NO_SUGGESTIONS_KEY)).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(localStorage.getItem(NO_SUGGESTIONS_KEY)).toBe('1');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      toggle?.click();
    });
    expect(localStorage.getItem(NO_SUGGESTIONS_KEY)).toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('reads the flag back on mount', async () => {
    localStorage.setItem(NO_SUGGESTIONS_KEY, '1');
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(el.querySelector('[data-testid="schedule-no-suggestions"]')?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('the mount in SettingsView', () => {
  it('a "schedule" section follows the connections section on the web default platform', async () => {
    await initScheduler(deps());
    const el = await render(<SettingsView />);
    const sections = [...el.querySelectorAll('[data-testid^="settings-section-"]')].map((section) => section.getAttribute('data-testid'));
    expect(sections).toContain('settings-section-schedule');
    expect(sections.indexOf('settings-section-schedule')).toBe(sections.indexOf('settings-section-connections') + 1);
    expect(el.querySelector('[data-testid="settings-section-schedule"] [data-testid="schedule-settings-card"]')).not.toBeNull();
  });
});

describe('the mount is gated on allows("schedule") (C7)', () => {
  it('renders no schedule section where the host switches scheduling off', async () => {
    // A fresh module registry: the platform is set once and locks on its first read.
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, schedule: false } });
    const helper = await import('./userdbTestHelper.js');
    await helper.installTestUserDb();
    const view = await import('../views/SettingsView.js');
    const el = await render(<view.SettingsView />);
    expect(el.querySelector('[data-testid="settings-section-connections"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="settings-section-schedule"]')).toBeNull();
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 — the Settings kill switch is an ACT, not a row (D-PR4-10; SC6):
// *stop every schedule making changes on its own* — shown ONLY while some schedule is armed,
// naming how many — clears `writeAuthority` on every task (one task write each). No switch, no
// storage flag, no disabled tick. A disarm the user performs here leaves no `disarmed` trace (that
// seat is for a disarm the user did NOT perform — D-PR4-7).
//
// Assumed (lane T-C question): the act is the button whose text is the contract's phrase; the
// count is named in the same settings row (`schedule-on-its-own-row`).
// =============================================================================================

describe('PR-4 — *stop every schedule making changes on its own* (D-PR4-10)', () => {
  const STOP_ALL = 'stop every schedule making changes on its own';
  const ARMED_AT = '2026-10-08T09:00:00.000Z';
  const ask = { kind: 'app-think', appId: 'ledger', prompt: 'tidy the categories', context: { maxRows: 50 } } as const;
  const armed = (id: string): ScheduledTask =>
    ({ ...task(), id, title: `armed ${id}`, steps: [ask], writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 1 } }) as ScheduledTask;

  it('NEGATIVE: with no armed schedule the act is not shown at all — never a disabled control', async () => {
    db.putScheduledTask({ ...task(), steps: [ask] });
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(button(el, STOP_ALL)).toBeUndefined();
    expect(el.textContent).not.toContain(STOP_ALL);
    expect(el.querySelector('[data-testid="schedule-on-its-own-row"]')).toBeNull();
    expect([...el.querySelectorAll('[role="switch"]')], 'no switch was added for this').toHaveLength(2);
  });

  it('shown while some schedule is armed, naming how many', async () => {
    db.putScheduledTask(armed('a1'));
    db.putScheduledTask(armed('a2'));
    db.putScheduledTask({ ...task(), id: 'u1', steps: [ask] });
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(button(el, STOP_ALL)).toBeDefined();
    const row = el.querySelector('[data-testid="schedule-on-its-own-row"]');
    expect(row?.textContent ?? '').toMatch(/\b2\b/);
    expect(row?.textContent ?? '', 'the unarmed schedule is not counted').not.toMatch(/\b3\b/);
  });

  it('clears the authority on EVERY armed schedule, leaves the others alone, writes no trace — then the act goes', async () => {
    db.putScheduledTask(armed('a1'));
    db.putScheduledTask(armed('a2'));
    db.putScheduledTask({ ...task(), id: 'u1', steps: [ask] });
    const untouched = db.getScheduledTask('u1');
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    await act(async () => {
      button(el, STOP_ALL)?.click();
    });
    await vi.waitFor(() => {
      expect(db.getScheduledTask('a1')?.writeAuthority).toBeUndefined();
      expect(db.getScheduledTask('a2')?.writeAuthority).toBeUndefined();
    });
    for (const id of ['a1', 'a2']) {
      expect(db.getScheduledTask(id)?.disarmed, `${id}: the user did this — no trace`).toBeUndefined();
      expect(db.getScheduledTask(id)?.enabled, `${id}: still on — only the authority went`).toBe(true);
    }
    expect(db.getScheduledTask('u1')).toEqual(untouched);
    await settle();
    expect(button(el, STOP_ALL)).toBeUndefined();
  });

  it('one armed schedule is named as one', async () => {
    db.putScheduledTask(armed('a1'));
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    expect(el.querySelector('[data-testid="schedule-on-its-own-row"]')?.textContent ?? '').toMatch(/\b1\b/);
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 Gate 5 — U7: Settings' act answers in words where the focus was.
// The row disappearing is the answer (D-I4-14, no confirm) — but the focused button goes with it, so
// the card leaves ONE outcome line, `SETTINGS.stoppedAll(n)` from `disarmAllTasks()`'s count, with
// `role="status"`, and moves the focus to it; a failure is caught into words (an `error-note`),
// never an unhandled rejection.
// =============================================================================================

describe('PR-4 Gate-5 U7 — *stop every schedule making changes on its own* answers in words', () => {
  const STOP_ALL = 'stop every schedule making changes on its own';
  const ask = { kind: 'app-think', appId: 'ledger', prompt: 'tidy the categories', context: { maxRows: 50 } } as const;
  const armed = (id: string): ScheduledTask =>
    ({ ...task(), id, title: `armed ${id}`, steps: [ask], writeAuthority: { rowsPerRun: 200, armedAt: '2026-10-08T09:00:00.000Z', armedVersion: 1 } }) as ScheduledTask;

  it('SETTINGS.stoppedAll(n) is a sentence naming how many stopped', () => {
    expect(typeof SETTINGS.stoppedAll).toBe('function');
    expect(SETTINGS.stoppedAll(2)).toMatch(/\b2\b/);
    expect(SETTINGS.stoppedAll(1)).toMatch(/\b1\b/);
    expect(SETTINGS.stoppedAll(2)).not.toMatch(/\b(task|proposal)s?\b/i);
  });

  it('after the act: a role="status" line reads SETTINGS.stoppedAll(2) and holds the focus', async () => {
    db.putScheduledTask(armed('a1'));
    db.putScheduledTask(armed('a2'));
    await initScheduler(deps());
    const el = await render(<ScheduleSettingsCard />);
    const stop = button(el, STOP_ALL);
    await act(async () => {
      stop?.focus();
      stop?.click();
    });
    await vi.waitFor(() => expect(db.getScheduledTask('a2')?.writeAuthority).toBeUndefined());
    await settle();
    const line = [...el.querySelectorAll<HTMLElement>('[role="status"]')].find((node) => node.textContent === SETTINGS.stoppedAll(2));
    expect(line, 'the outcome line').toBeDefined();
    expect(document.activeElement, 'focus moves to the outcome line, never to <body>').toBe(line);
  });

  it('a failing act is caught into words — an error-note, and the act stays for another try', async () => {
    db.putScheduledTask(armed('a1'));
    await initScheduler(deps());
    vi.mocked(disarmAllTasks).mockRejectedValueOnce(new Error('the file is read-only here'));
    const el = await render(<ScheduleSettingsCard />);
    await act(async () => {
      button(el, STOP_ALL)?.click();
    });
    await settle();
    expect(vi.mocked(disarmAllTasks)).toHaveBeenCalledTimes(1);
    const note = el.querySelector('.error-note');
    expect(note, 'the failure is said').not.toBeNull();
    expect((note?.textContent ?? '').trim()).not.toBe('');
    expect(button(el, STOP_ALL), 'nothing stopped — the act is still there').toBeDefined();
    expect(db.getScheduledTask('a1')?.writeAuthority).toBeDefined();
  });
});
