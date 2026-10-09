// scheduleView.test.tsx — TASK-20261009-scheduling-framework U2 (ADR-0074; design F1, F9,
// F12): the /schedule route over a REAL engine on a memory db. The create bar comes first
// and hands the sentence to the editor route; results are every result across schedules,
// newest first, with an unread dot AND the status word; the schedules group as needs your
// attention / today / upcoming / paused with each attention line's one act; a row is a
// title + a `role="switch"`, a when + next line, app chips named after the app, a kebab
// with run now · edit · history · delete (the tiles' armed inline confirm); the banners
// (global pause, follower tab); loading, error and the host refusal.
import { act } from 'react';
import { MemoryRouter, Route, Routes, useLocation, type NavigateFunction, type NavigateOptions, type To } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY, RESULT_STATUS_WORD, followerTab, globalPaused, imported, needsYou, paused } from '../schedule/copy.js';
import { GROUPS, PAGE, RELOAD, RESULTS, ROW } from '../schedule/copy.page.js';
import { describeSpec } from '../schedule/cron.js';
import { newScheduleHref } from '../schedule/routes.js';
import { freshSchedulerState, schedulerStore, type SchedulerView } from '../schedule/scheduler.js';
import { ScheduleView } from '../views/ScheduleView.js';
import {
  HOUR,
  MINUTE,
  NOW,
  THINK,
  WEB,
  click,
  heldElsewhere,
  iso,
  makeRun,
  makeTask,
  mount,
  settle,
  settleUntil,
  setupEnv,
  teardownEnv,
  texts,
  unmount,
  type Env,
} from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The ORDER of the two acts behind *run now* on a schedule that runs an app (S2): the navigation, then the manual run. */
const trace = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: (): NavigateFunction => {
      const navigate = actual.useNavigate();
      const traced: NavigateFunction = (to: To | number, options?: NavigateOptions) => {
        trace.calls.push(`navigate:${typeof to === 'number' ? to : typeof to === 'string' ? to : (to.pathname ?? '')}`);
        return typeof to === 'number' ? navigate(to) : navigate(to, options);
      };
      return traced;
    },
  };
});
vi.mock('../schedule/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schedule/scheduler.js')>();
  return {
    ...actual,
    runNow: (taskId: string) => {
      trace.calls.push(`run-now:${taskId}`);
      return actual.runNow(taskId);
    },
  };
});

// A real sql.js db per test (the 2026-08-26 db-load class): the budget is the fix, not a retry.
vi.setConfig({ testTimeout: 20_000 });

let env: Env;
let path = '';

beforeEach(async () => {
  env = await setupEnv();
  env.db.installApp({ appId: 'ledger', displayName: 'Ledger', iconEmoji: '📒', html: '<html>ledger</html>', installSource: 'starter:ledger' });
  path = '';
  trace.calls.length = 0;
});

afterEach(() => {
  unmount();
  teardownEnv();
});

function render(): HTMLDivElement {
  return mount(
    <MemoryRouter initialEntries={['/schedule']}>
      <Routes>
        <Route path="/schedule" element={<ScheduleView />} />
        <Route path="/schedule/new" element={<PathProbe />} />
        <Route path="/schedule/:id" element={<PathProbe />} />
        <Route path="/schedule/:id/result/:dueAt" element={<PathProbe />} />
        <Route path="/run/:id" element={<PathProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Records where the router went (the editor, the detail, an app) in module scope. */
function PathProbe(): JSX.Element {
  const location = useLocation();
  path = `${location.pathname}${location.search}`;
  return <span data-testid="path-probe" />;
}

/** React's controlled input: set through the native setter so the change reaches the handler. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const q = <T extends Element = HTMLElement>(c: HTMLElement, selector: string): T | null => c.querySelector<T>(selector);
const qa = (c: HTMLElement, selector: string): HTMLElement[] => [...c.querySelectorAll<HTMLElement>(selector)];
const byTestId = (c: HTMLElement, id: string): HTMLElement | null => q(c, `[data-testid="${id}"]`);
const rowTitles = (c: HTMLElement, group: string): string[] => texts(c, `[data-testid="schedule-group-${group}"] .schedule-row-title`);

describe('loading, empty, error (U2)', () => {
  it('shows a skeleton while the engine is not ready', () => {
    const c = render();
    expect(byTestId(c, 'schedule-loading')).not.toBeNull();
    expect(qa(c, '.skeleton').length).toBeGreaterThan(0);
    expect(byTestId(c, 'schedule-templates'), 'the templates render even while loading').not.toBeNull();
  });

  it('empty: the create bar FIRST, EMPTY.page, the honesty line, the templates — and no results section', async () => {
    await env.boot();
    const c = render();
    await settle();
    expect(byTestId(c, 'schedule-loading')).toBeNull();
    expect(c.textContent).toContain(PAGE.emptyTitle);
    expect(c.textContent).toContain(EMPTY.page);
    expect(byTestId(c, 'schedule-honesty')?.textContent).toBe('runs while this tab is open · other tabs can’t be seen from here');
    expect(qa(c, '[data-testid="schedule-template"]')).toHaveLength(4);
    expect(byTestId(c, 'schedule-results')).toBeNull();
    const page = q(c, '.schedule-page');
    const children = [...(page?.children ?? [])];
    expect(children[0]?.className).toContain('settings-hero');
    expect(children[1]?.getAttribute('data-testid'), 'the create bar is the first thing after the heading').toBe('schedule-create-bar');
    const bar = byTestId(c, 'schedule-create-bar');
    expect(q<HTMLInputElement>(bar!, 'input')?.placeholder).toBe(EMPTY.createPlaceholder);
    expect(q<HTMLInputElement>(bar!, 'input')?.getAttribute('aria-label')).toBe(PAGE.createLabel);
    expect(byTestId(c, 'schedule-new')?.getAttribute('href')).toBe('/schedule/new');
  });

  it('a boot that failed is an EmptyState carrying the engine’s one line', async () => {
    await env.boot({ db: () => Promise.reject(new Error('the file is busy')) });
    const c = render();
    await settle();
    expect(c.textContent).toContain(PAGE.errorTitle);
    expect(c.textContent).toContain('the file is busy');
  });
});

describe('the create bar (design F1)', () => {
  it('submit opens the editor route with the sentence and NOTHING else — the editor reads the when itself (M10)', async () => {
    await env.boot();
    const c = render();
    await settle();
    const input = q<HTMLInputElement>(c, 'input[aria-label="describe what and when"]');
    expect(input).not.toBeNull();
    expect((byTestId(c, 'schedule-create-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId(c, 'schedule-new')?.getAttribute('href')).toBe(newScheduleHref());
    await type(input!, 'every weekday at 8, water the ferns');
    await click(byTestId(c, 'schedule-create-submit'));
    expect(path).toBe(newScheduleHref({ text: 'every weekday at 8, water the ferns' }));
    expect(path).toBe('/schedule/new?text=every+weekday+at+8%2C+water+the+ferns');
    expect([...new URLSearchParams(path.split('?')[1]).keys()]).toEqual(['text']);
  });

  it('a sentence the grammar cannot read still opens the editor, with the text and no when', async () => {
    await env.boot();
    const c = render();
    await settle();
    await type(q<HTMLInputElement>(c, 'input[aria-label="describe what and when"]')!, 'water the ferns');
    await act(async () => {
      q<HTMLInputElement>(c, 'input[aria-label="describe what and when"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(path).toBe('/schedule/new?text=water+the+ferns');
  });
});

describe('results (design F9)', () => {
  const seedResults = (): void => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly', steps: [THINK()], appVersions: { ledger: 1 } }));
    env.db.putScheduledTask(makeTask({ id: 't2', title: 'Weekly', steps: [THINK()], appVersions: { ledger: 1 }, spec: { kind: 'weekly', days: ['mon'], time: '09:00', tz: 'UTC' }, cron: '0 9 * * 1' }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - 3 * HOUR), status: 'ok', finishedAt: iso(NOW - 3 * HOUR + MINUTE), seenAt: iso(NOW - 2 * HOUR), steps: [{ status: 'ok', summary: 'all quiet' }] }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - HOUR), status: 'failed', finishedAt: iso(NOW - 59 * MINUTE), reason: 'the brain did not answer' }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - 30 * MINUTE), status: 'pending', trigger: 'catch-up' }));
    env.db.putScheduleRun(makeRun({ taskId: 't2', dueAt: iso(NOW - 2 * HOUR), status: 'needs-you', finishedAt: iso(NOW - 2 * HOUR), reason: 'post to Notion' }));
    env.db.putScheduleRun(makeRun({ taskId: 't2', dueAt: iso(NOW - 4 * HOUR), status: 'skipped', finishedAt: iso(NOW - 4 * HOUR), reason: 'stale' }));
  };

  it('every result across schedules, newest first; an unread row carries the dot AND the word; each links to its detail', async () => {
    seedResults();
    await env.boot();
    const c = render();
    await settle();
    const rows = qa(c, '[data-testid="schedule-result"]');
    expect(rows.map((row) => row.dataset.status)).toEqual(['failed', 'needs-you', 'ok']);
    expect(rows.map((row) => row.dataset.unread)).toEqual(['true', 'true', 'false']);
    expect(rows.map((row) => q(row, '.schedule-dot') !== null)).toEqual([true, true, false]);
    expect(q(rows[0]!, '.schedule-result-word')?.textContent).toBe(`${RESULTS.unread} · ${RESULT_STATUS_WORD.failed}`);
    expect(q(rows[2]!, '.schedule-result-word')?.textContent).toBe(RESULT_STATUS_WORD.ok);
    expect(q(rows[0]!, '.schedule-result-summary')?.textContent).toBe('the brain did not answer');
    expect(q(rows[2]!, '.schedule-result-summary')?.textContent).toBe('all quiet');
    expect(q(rows[0]!, '.schedule-result-meta')?.textContent).toBe('Hourly · Ledger · 59 minutes ago');
    expect(q(rows[0]!, 'a')?.getAttribute('href')).toBe(`/schedule/t1/result/${encodeURIComponent(iso(NOW - HOUR))}`);
    expect(q(rows[1]!, '.schedule-result-summary')?.textContent).toBe(needsYou('Ledger', 'post to Notion').text);
    expect(byTestId(c, 'schedule-results')?.querySelector('.section-title')?.textContent).toBe(`${RESULTS.heading} · 2 ${RESULTS.unread}`);
  });

  it('a needs-you row carries its one act, which opens the app the schedule runs and THEN runs it (S2: the user’s own run rides the live frame)', async () => {
    seedResults();
    await env.boot();
    const c = render();
    await settle();
    const act1 = byTestId(c, 'result-needs-you-act');
    expect(act1?.textContent).toBe(needsYou('Ledger', 'post to Notion').action);
    const needsRow = qa(c, '[data-testid="schedule-result"]').find((row) => row.dataset.status === 'needs-you');
    const taskId = (q(needsRow!, 'a')?.getAttribute('href') ?? '').split('/')[2];
    expect(taskId).toMatch(/^t\d$/);
    await click(act1);
    expect(path).toBe('/run/ledger');
    expect(trace.calls).toEqual(['navigate:/run/ledger', `run-now:${taskId}`]);
  });

  it('mark all read is one gesture: every unread result is seen, the button goes, the engine’s unseen count is 0', async () => {
    seedResults();
    await env.boot();
    const c = render();
    await settle();
    expect(schedulerStore.get().unseen).toBe(2);
    await click(byTestId(c, 'results-mark-all-read'));
    await settleUntil(() => schedulerStore.get().unseen === 0, 'mark all seen');
    expect(qa(c, '[data-testid="schedule-result"]').map((row) => row.dataset.unread)).toEqual(['false', 'false', 'false']);
    expect(byTestId(c, 'results-mark-all-read')).toBeNull();
    expect(byTestId(c, 'schedule-results')?.querySelector('.section-title')?.textContent).toBe(RESULTS.heading);
  });
});

describe('the groups (U2)', () => {
  const seedGroups = (): void => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    env.db.putScheduledTask(makeTask({ id: 't2', title: 'Weekly', spec: { kind: 'weekly', days: ['mon'], time: '09:00', tz: 'UTC' }, cron: '0 9 * * 1' }));
    env.db.putScheduledTask(makeTask({ id: 't3', title: 'Off', enabled: false }));
    env.db.putScheduledTask(makeTask({ id: 't4', title: 'Broken', enabled: false, pausedReason: 'failures', consecutiveFailures: 5 }));
    env.db.putScheduledTask(makeTask({ id: 't5', title: 'Imported', enabled: false, provenance: 'imported' }));
    env.db.putScheduledTask(makeTask({ id: 't6', title: 'Needy', steps: [THINK()], appVersions: { ledger: 1 } }));
    env.db.putScheduleRun(makeRun({ taskId: 't6', dueAt: iso(NOW - HOUR), status: 'needs-you', finishedAt: iso(NOW - HOUR), reason: 'post to Notion' }));
  };

  it('needs your attention (needs-you · paused with reason · imported) / today / upcoming / paused', async () => {
    seedGroups();
    await env.boot();
    const c = render();
    await settle();
    expect(texts(c, '.schedule-group .section-title')).toEqual([GROUPS.attention, GROUPS.today, GROUPS.upcoming, GROUPS.paused]);
    expect(rowTitles(c, 'attention')).toEqual(['Broken', 'Imported', 'Needy']);
    expect(rowTitles(c, 'today')).toEqual(['Hourly']);
    expect(rowTitles(c, 'upcoming')).toEqual(['Weekly']);
    expect(rowTitles(c, 'paused')).toEqual(['Off']);
    const lines = qa(c, '[data-testid="schedule-attention"]');
    expect(lines.map((line) => line.dataset.kind)).toEqual(['paused', 'imported', 'needs-you']);
    expect(lines[0]?.textContent).toContain(paused('failures', 5).text);
    expect(lines[0]?.textContent).toContain(paused('failures').action);
    expect(lines[1]?.textContent).toContain(imported.text);
    expect(lines[1]?.textContent).toContain(imported.action);
    expect(lines[2]?.textContent).toContain(needsYou('Ledger', 'post to Notion').text);
  });

  it('resume on a paused schedule clears the pause and turns it on; review on an imported one opens the editor', async () => {
    seedGroups();
    await env.boot();
    const c = render();
    await settle();
    const acts = qa(c, '[data-testid="schedule-attention-act"]');
    await click(acts[0]);
    await settleUntil(() => env.db.getScheduledTask('t4')?.enabled === true, 'resumed');
    expect(env.db.getScheduledTask('t4')?.pausedReason).toBeUndefined();
    expect(rowTitles(c, 'attention')).toEqual(['Imported', 'Needy']);
    expect(rowTitles(c, 'today')).toEqual(['Broken', 'Hourly']);
    await click(qa(c, '[data-testid="schedule-attention-act"]')[0]);
    expect(path).toBe('/schedule/t5');
  });

  it('an imported row’s switch never enables it: the click opens the editor, where the consent panel is the one way on (S2)', async () => {
    seedGroups();
    await env.boot();
    const c = render();
    await settle();
    const sw = q(c, '[data-schedule-id="t5"] [role="switch"]');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(sw?.getAttribute('data-review-first')).toBe('true');
    await click(sw);
    expect(path).toBe('/schedule/t5');
    expect(env.db.getScheduledTask('t5')?.enabled, 'nothing was enabled').toBe(false);
    expect(q(c, '[data-testid="schedule-row-error"]')).toBeNull();
  });
});

describe('a row (design F12)', () => {
  const seedRow = (): void => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly', steps: [THINK()], appVersions: { ledger: 1 } }));
  };

  it('line 1: the title and a role="switch" named after it; off → the row moves to paused', async () => {
    seedRow();
    await env.boot();
    const c = render();
    await settle();
    const sw = q(c, '[role="switch"]');
    expect(sw?.getAttribute('aria-label')).toBe('Hourly');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect(sw?.textContent).toContain(ROW.on);
    await click(sw);
    await settleUntil(() => env.db.getScheduledTask('t1')?.enabled === false, 'switched off');
    expect(q(c, '[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(rowTitles(c, 'paused')).toEqual(['Hourly']);
    expect(rowTitles(c, 'today')).toEqual([]);
  });

  it('a refused enable shows the engine’s reason inline, in words, and the row stays off (S2)', async () => {
    env.db.putScheduledTask(makeTask({ id: 't8', title: 'Orphan', enabled: false, steps: [THINK('gone')] }));
    await env.boot();
    const c = render();
    await settle();
    expect(rowTitles(c, 'paused')).toEqual(['Orphan']);
    const sw = q(c, '[data-schedule-id="t8"] [role="switch"]');
    expect(sw?.getAttribute('data-review-first')).toBeNull();
    await click(sw);
    await settleUntil(() => q(c, '[data-testid="schedule-row-error"]') !== null, 'the refusal');
    const note = q(c, '[data-testid="schedule-row-error"]');
    expect(note?.getAttribute('role')).toBe('alert');
    expect(note?.textContent).toMatch(/gone/);
    expect(env.db.getScheduledTask('t8')?.enabled).toBe(false);
    expect(path).toBe('');
  });

  it('line 2: the when, "next <relative>", and the app collapsed to a chip named after the app', async () => {
    seedRow();
    await env.boot();
    const c = render();
    await settle();
    const row = byTestId(c, 'schedule-row')!;
    expect(q(row, '.schedule-row-when')?.textContent).toBe(describeSpec({ kind: 'every', n: 1, unit: 'hours', tz: 'UTC' }));
    expect(q(row, '.schedule-row-next')?.textContent).toBe(ROW.next('in 55 minutes'));
    const chip = q(row, '[data-testid="schedule-app-chip"]');
    expect(chip?.getAttribute('aria-label')).toBe('Ledger');
    expect(q(chip!, '.schedule-app-emoji')?.textContent).toBe('📒');
  });

  it('the kebab: run now runs once, history toggles the inline list, edit opens the editor route', async () => {
    seedRow();
    await env.boot();
    const c = render();
    await settle();
    const kebab = byTestId(c, 'schedule-kebab')!;
    expect(kebab.getAttribute('aria-label')).toBe(ROW.menu('Hourly'));
    await click(kebab);
    expect(texts(c, '.schedule-menu-item')).toEqual([ROW.runNow, ROW.edit, ROW.history, ROW.delete]);
    await click(qa(c, '.schedule-menu-item')[0]);
    await settleUntil(() => env.rec.calls.length === 1, 'run now executed');
    await settleUntil(() => env.db.listScheduleRuns('t1')[0]?.status === 'ok', 'the run was recorded');
    expect(env.db.listScheduleRuns('t1')[0]).toMatchObject({ trigger: 'manual', status: 'ok' });
    expect(byTestId(c, 'schedule-menu'), 'the menu closed').toBeNull();
    await click(byTestId(c, 'schedule-kebab'));
    await click(qa(c, '.schedule-menu-item')[2]);
    const history = byTestId(c, 'schedule-history');
    expect(history).not.toBeNull();
    expect(texts(history!, '.schedule-history-status')).toEqual([RESULT_STATUS_WORD.ok]);
    expect(history?.textContent).toContain('done');
    await click(byTestId(c, 'schedule-kebab'));
    await click(qa(c, '.schedule-menu-item')[2]);
    expect(byTestId(c, 'schedule-history'), 'history toggles').toBeNull();
    await click(byTestId(c, 'schedule-kebab'));
    await click(qa(c, '.schedule-menu-item')[1]);
    expect(path).toBe('/schedule/t1');
  });

  it('run now on a schedule that RUNS an app opens the app FIRST, then enqueues the manual run (S2); a reminder runs in place', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly', steps: [{ kind: 'app-run', appId: 'ledger' }], appVersions: { ledger: 1 } }));
    env.db.putScheduledTask(makeTask({ id: 't2', title: 'Water' }));
    await env.boot();
    const c = render();
    await settle();
    const rowOf = (title: string): HTMLElement => qa(c, '[data-testid="schedule-row"]').find((row) => row.querySelector('.schedule-row-title')?.textContent === title)!;
    // The reminder-only schedule: run now in place, no navigation.
    await click(rowOf('Water').querySelector('[data-testid="schedule-kebab"]'));
    await click(qa(rowOf('Water'), '.schedule-menu-item')[0]);
    await settleUntil(() => env.rec.calls.length === 1, 'the reminder ran');
    expect(trace.calls).toEqual(['run-now:t2']);
    expect(path).toBe('');
    trace.calls.length = 0;
    // The schedule that runs Ledger: the app opens, THEN the manual run is enqueued into it.
    await click(rowOf('Hourly').querySelector('[data-testid="schedule-kebab"]'));
    await click(qa(rowOf('Hourly'), '.schedule-menu-item')[0]);
    await settle();
    expect(trace.calls).toEqual(['navigate:/run/ledger', 'run-now:t1']);
    expect(path).toBe('/run/ledger');
  });

  it('the needs-you line’s *run now and review* on a schedule that RUNS an app is the same act: the app, then the manual run (S2)', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly', steps: [{ kind: 'app-run', appId: 'ledger' }], appVersions: { ledger: 1 } }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - HOUR), status: 'needs-you', reason: 'post to Notion', steps: [{ status: 'refused' }] }));
    await env.boot();
    const c = render();
    await settle();
    const act1 = byTestId(c, 'schedule-attention-act');
    expect(act1?.textContent).toBe(needsYou('Ledger', 'post to Notion').action);
    await click(act1);
    await settle();
    expect(trace.calls).toEqual(['navigate:/run/ledger', 'run-now:t1']);
    expect(path).toBe('/run/ledger');
  });

  it('delete arms the tiles’ inline confirm — keep backs out, delete removes the schedule and its runs', async () => {
    seedRow();
    await env.boot();
    const c = render();
    await settle();
    await click(byTestId(c, 'schedule-kebab'));
    await click(qa(c, '.schedule-menu-item')[3]);
    const confirm = q(c, '[role="group"][aria-label="delete Hourly?"]');
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain(ROW.deleteConfirm);
    await click(byTestId(c, 'schedule-delete-cancel'));
    expect(q(c, '[role="group"][aria-label="delete Hourly?"]')).toBeNull();
    expect(env.db.getScheduledTask('t1')).toBeDefined();
    await click(byTestId(c, 'schedule-kebab'));
    await click(qa(c, '.schedule-menu-item')[3]);
    await click(byTestId(c, 'schedule-delete-confirm'));
    await settleUntil(() => env.db.getScheduledTask('t1') === undefined, 'deleted');
    expect(qa(c, '[data-testid="schedule-row"]')).toHaveLength(0);
    expect(c.textContent).toContain(PAGE.emptyTitle);
  });
});

describe('the banners', () => {
  it('the global pause: copy.globalPaused with a resume that lifts it', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    env.db.setSchedulerState({ ...freshSchedulerState(iso(NOW)), globalPause: true });
    await env.boot();
    const c = render();
    await settle();
    const banner = byTestId(c, 'schedule-global-paused');
    expect(banner?.textContent).toContain(globalPaused);
    expect(banner?.getAttribute('role')).toBe('status');
    await click(byTestId(c, 'schedule-resume-all'));
    await settleUntil(() => env.db.getSchedulerState()?.globalPause === false, 'resumed');
    expect(byTestId(c, 'schedule-global-paused')).toBeNull();
  });

  it('a follower tab says so (copy.followerTab)', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    await env.boot({ locks: heldElsewhere() });
    const c = render();
    await settle();
    expect(schedulerStore.get().leader?.leader).toBe(false);
    expect(byTestId(c, 'schedule-follower')?.textContent).toBe(followerTab);
  });

  it('a tab promoted over a stale copy (view.needsReload) shows the one-line reload strip with its act (S3)', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    await env.boot();
    const c = render();
    await settle();
    expect(byTestId(c, 'schedule-reload')).toBeNull();
    await act(async () => {
      // The engine sets this when the election promotes this tab over a copy another tab had moved on from.
      schedulerStore.set({ ...schedulerStore.get(), needsReload: true } as SchedulerView);
    });
    const strip = byTestId(c, 'schedule-reload');
    expect(strip?.className).toContain('connection-note');
    expect(strip?.textContent).toContain(RELOAD.note);
    expect(byTestId(c, 'schedule-reload-act')?.textContent).toBe(RELOAD.act);
    expect(rowTitles(c, 'today'), 'the rows stay on screen beneath the strip').toEqual(['Hourly']);
  });
});

// LAST: the platform locks on first read, so the refusal needs a fresh module graph (the
// `platform.test.ts` pattern) — nothing after this describe may rely on the earlier instances.
describe('allows("schedule") === false', () => {
  it('renders the named refusal, never an empty main region', async () => {
    vi.resetModules();
    const platform = await import('../platform/platform.js');
    platform.setPlatform({ ...WEB, capabilities: { ...WEB.capabilities, schedule: false } });
    const fresh = await import('../views/ScheduleView.js');
    const c = mount(
      <MemoryRouter initialEntries={['/schedule']}>
        <fresh.ScheduleView />
      </MemoryRouter>,
    );
    await settle(1);
    expect(byTestId(c, 'schedule-unavailable')).not.toBeNull();
    expect(c.textContent).toContain(PAGE.unavailableTitle);
    expect(c.textContent).toContain(PAGE.unavailableLesson);
    expect(byTestId(c, 'schedule-create-bar')).toBeNull();
  });
});
