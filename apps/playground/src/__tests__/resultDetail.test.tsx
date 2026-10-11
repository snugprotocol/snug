// resultDetail.test.tsx — TASK-20261009-scheduling-framework U4, the detail half (ADR-0074
// §5–§6): one result opened at `/schedule/:id/result/:dueAt`.
//
// Over the REAL engine (the scheduler's composition root with its three outside seams faked —
// a quiet ticker, no lock manager, a recording executor) and a REAL memory-backed user db, so
// `markSeen` stamps the production row, `runNow` enqueues through the production queue and
// *apply to my data* reaches `executeApprovedWrite` — the one path from a proposed statement to
// data — against a real table: the applied case changes rows, the drift case halts on a count
// that moved, the failed case reports the dry-run error, and a run that asked TWO apps applies
// each item to its own app (the item names it — S4). Nothing here fakes the accessor.
//
// The last block is the ONE status vocabulary (M5): the feed, the detail and the missed card
// print `copy.RESULT_STATUS_WORD` for every run status — no surface has words of its own.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, type NavigateFunction, type NavigateOptions, type To } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { RUN_STATUSES, SCHEDULE_PROPOSAL_TTL_MS, type ScheduleProposalItem, type ScheduleRun, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import { RESULT_STATUS_WORD, capped, needsYouDeclined, needsYouUnanswered, noHandler } from '../schedule/copy.js';
import { CAPPED_WHAT, DECLINED, DRIFTED, EXPIRED, NO_APP_FOR_CHANGES, RESULT_MISSING, applied, callsLine, hostWord, interruptedWhy, needsYouTitle, openingToRun, wouldChange } from '../schedule/copy.result.js';
import type { StepContext, StepExecutor } from '../schedule/engine-types.js';
import { outcomeWord } from '../schedule/MissedCard.js';
import type { AppIndex } from '../schedule/pageModel.js';
import { ResultDetail, itemAppId, proposalFor } from '../schedule/ResultDetail.js';
import { ResultsList } from '../schedule/ResultsList.js';
import { __resetSchedulerForTests, initScheduler, initialSchedulerView, schedulerStore, type SchedulerDeps } from '../schedule/scheduler.js';
import { execFrame } from './dbFrames.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The ORDER of the two acts behind *run now and review* (S2): the navigation, then the manual run. */
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

const NOW = Date.parse('2026-10-09T12:05:00.000Z');
const DUE = '2026-10-09T12:00:00.000Z';
const CREATED = '2026-10-01T00:00:00.000Z';
const WEB: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };
const SQL = "UPDATE expenses SET cents = 999 WHERE label = 'coffee'";

let db: UserDb;
let container: HTMLDivElement | undefined;
let root: Root | undefined;
const executed: Array<{ step: ScheduleStep; ctx: StepContext }> = [];

const execute: StepExecutor = async (step, ctx) => {
  executed.push({ step, ctx });
  return { status: 'ok', summary: 'ran again', calls: { ai: 0, net: 0 } };
};

const deps = (): Partial<SchedulerDeps> => ({
  db: () => Promise.resolve(db),
  execute,
  locks: undefined,
  ticker: () => ({ start: () => {}, stop: () => {}, nextFireAt: () => undefined }),
  now: () => new Date(NOW),
  platform: () => WEB,
  allows: () => true,
});

const THINK: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } };
const NOTIFY: ScheduleStep = { kind: 'notify', title: 'Water', body: 'the ferns' };

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'Weekly spend review',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [THINK],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 3_600_000,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 1,
  ...over,
});

const run = (over: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: 'r1',
  taskId: 't1',
  dueAt: DUE,
  trigger: 'due',
  collapsedCount: 1,
  status: 'ok',
  startedAt: DUE,
  finishedAt: '2026-10-09T12:00:20.000Z',
  host: { kind: 'web' },
  steps: [{ status: 'ok', summary: 'Coffee came to 9.50 this week.' }],
  calls: { ai: 1, net: 0 },
  ...over,
});

/** A live batch expires seven days from the REAL clock — the detail reads `Date.now()` for expiry. */
const batch = (
  items: ScheduleProposalItem[] = [{ appId: 'ledger', sql: SQL, summary: 'Set both coffees to 9.99', counts: { changes: 2 } }],
  expiresAt = new Date(Date.now() + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
): NonNullable<ScheduleRun['proposals']> => ({ items, expiresAt });

/** The second app a two-app schedule asks, with one table of its own. */
const STANDUP_SQL = "UPDATE notes SET body = 'carried over' WHERE id = 1";
async function installStandup(): Promise<void> {
  db.installApp({ appId: 'standup', displayName: 'Standup', html: '<html>standup</html>' });
  await db.applyAppDdl('standup', ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)']);
  const result = await db.driver.handle('standup', execFrame('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'open']));
  if (!result.ok) throw new Error('seed failed');
}
async function noteBodies(): Promise<unknown[]> {
  const result = await db.scratchRun('standup', [{ sql: 'SELECT body FROM notes ORDER BY id' }]);
  return (result.statements[0]?.rows ?? []).map((row) => row[0]);
}

const unmountNow = (): void => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
};

const seed = (t: ScheduledTask, r?: ScheduleRun): void => {
  db.putScheduledTask(t);
  if (r !== undefined) db.putScheduleRun(r);
};

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function open(dueAt = DUE, taskId = 't1'): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/schedule/${taskId}/result/${encodeURIComponent(dueAt)}`]}>
        <Routes>
          <Route path="/schedule/:id/result/:dueAt" element={<ResultDetail />} />
          <Route path="/schedule/:id" element={<p data-testid="editor-route">editor</p>} />
          <Route path="/schedule" element={<p data-testid="page-route">page</p>} />
          <Route path="/run/:id" element={<p data-testid="run-route">run</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
  return container;
}

const button = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

async function coffeeCents(): Promise<unknown[]> {
  const result = await db.scratchRun('ledger', [{ sql: "SELECT cents FROM expenses WHERE label = 'coffee' ORDER BY id" }]);
  return (result.statements[0]?.rows ?? []).map((row) => row[0]);
}

beforeEach(async () => {
  __resetSchedulerForTests();
  executed.length = 0;
  trace.calls.length = 0;
  db = await installTestUserDb();
  db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
  await db.applyAppDdl('ledger', ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL)']);
  for (const [id, label, cents] of [
    [1, 'coffee', 450],
    [2, 'rent', 120000],
    [3, 'coffee', 500],
  ] as const) {
    const result = await db.driver.handle('ledger', execFrame('INSERT INTO expenses (id, label, cents) VALUES (?, ?, ?)', [id, label, cents]));
    if (!result.ok) throw new Error('seed failed');
  }
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  __resetSchedulerForTests();
});

describe('the result, opened', () => {
  it('shows the status word, the title as a link to the editor, when and where it ran, what it spent, and each step', async () => {
    seed(task(), run());
    await initScheduler(deps());
    const el = await open();
    const detail = el.querySelector('[data-testid="schedule-result-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.querySelector('[data-testid="schedule-status"]')?.textContent).toBe('done');
    const title = el.querySelector<HTMLAnchorElement>('[data-testid="schedule-result-title"]');
    expect(title?.textContent).toBe('Weekly spend review');
    expect(title?.getAttribute('href')).toBe('/schedule/t1');
    const when = el.querySelector('[data-testid="schedule-result-when"]')?.textContent ?? '';
    expect(when).toMatch(/^ran .+ · .+ · on a browser tab · 1 AI call$/);
    const steps = [...el.querySelectorAll('[data-testid="schedule-result-step"]')];
    expect(steps).toHaveLength(1);
    const step = steps[0]?.textContent ?? '';
    expect(step).toContain('ask Ledger’s AI');
    expect(step).toContain('Coffee came to 9.50 this week.');
    expect(steps[0]?.querySelector('[data-testid="schedule-status"]')?.textContent).toBe('done');
    expect(steps[0]?.querySelector('a')?.getAttribute('href')).toBe('/run/ledger');
  });

  it('renders a step summary as TEXT, never as HTML', async () => {
    seed(task(), run({ steps: [{ status: 'ok', summary: '<b>bold</b> & <img src=x onerror="alert(1)">' }] }));
    await initScheduler(deps());
    const el = await open();
    const step = el.querySelector('[data-testid="schedule-result-step"]');
    expect(step?.querySelector('b, img')).toBeNull();
    expect(step?.textContent).toContain('<b>bold</b> & <img src=x onerror="alert(1)">');
  });

  it('opening is the gesture that stamps seenAt — once — and takes one off the unseen count', async () => {
    seed(task({ unseenResults: 2 }), run());
    await initScheduler(deps());
    expect(db.listScheduleRuns('t1')[0]?.seenAt).toBeUndefined();
    await open();
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.seenAt).toBe(new Date(NOW).toISOString()));
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(1);
    // A second render of the same result (StrictMode, a re-render) changes nothing more.
    await settle();
    expect(db.getScheduledTask('t1')?.unseenResults).toBe(1);
  });

  it('a result the file no longer holds: the empty state with the way back', async () => {
    seed(task());
    await initScheduler(deps());
    const el = await open('2026-10-09T09:00:00.000Z');
    expect(el.textContent).toContain(RESULT_MISSING.title);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/schedule');
  });
});

describe('changes waiting for your OK (ADR-0074 §6)', () => {
  it('renders each statement VERBATIM in a <pre>, its summary, the dry-run count, and who wrote it', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    const el = await open();
    const changes = el.querySelector('[data-testid="schedule-result-changes"]');
    expect(changes?.textContent).toContain('changes waiting for your OK');
    const item = el.querySelector('[data-testid="schedule-change"]');
    expect(item?.querySelector('pre')?.textContent).toBe(SQL);
    expect(item?.textContent).toContain('Set both coffees to 9.99');
    expect(item?.textContent).toContain('would change 2 rows in Ledger');
    expect(item?.textContent).toContain('written by the AI from your data');
    expect(button(el, 'apply to my data')).toBeDefined();
    expect(button(el, 'decline')).toBeDefined();
  });

  it('apply: the statement runs through executeApprovedWrite — rows change, the item leaves the row, the RE-VALIDATED count is shown', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    const el = await open();
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(async () => expect(await coffeeCents()).toEqual([999, 999]));
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.proposals).toBeUndefined());
    await settle();
    expect(el.querySelector('[data-testid="schedule-change"]')).toBeNull();
    const settled = el.querySelector('[data-testid="schedule-change-settled"]');
    expect(settled?.textContent).toContain(applied([2]));
    expect(settled?.querySelector('pre')?.textContent).toBe(SQL);
  });

  it('drift: the data moved between the preview and the approval — nothing is applied, the row carries the current count, the item stays', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    const el = await open();
    const third = await db.driver.handle('ledger', execFrame("INSERT INTO expenses (id, label, cents) VALUES (4, 'coffee', 300)"));
    expect(third.ok).toBe(true);
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.proposals?.items[0]?.counts).toEqual({ changes: 3 }));
    expect(await coffeeCents()).toEqual([450, 500, 300]);
    await settle();
    expect(el.querySelector('[data-testid="schedule-change-note"]')?.textContent).toBe(DRIFTED);
    expect(el.querySelector('[data-testid="schedule-change"]')?.textContent).toContain(wouldChange(3));
    expect(button(el, 'apply to my data')).toBeDefined();
  });

  it('failed: a statement the dry run refuses reports the message and changes nothing', async () => {
    seed(task(), run({ proposals: batch([{ appId: 'ledger', sql: 'UPDATE nowhere SET x = 1', counts: { changes: 0 } }]) }));
    await initScheduler(deps());
    const el = await open();
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-change-note"]')?.textContent).toMatch(/^couldn’t apply — /));
    expect(await coffeeCents()).toEqual([450, 500]);
    expect(db.listScheduleRuns('t1')[0]?.proposals?.items).toHaveLength(1);
  });

  it('decline removes the item from the row — written through db.putScheduleRun, there is no scheduler act for it', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    const el = await open();
    await act(async () => {
      button(el, 'decline')?.click();
    });
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.proposals).toBeUndefined());
    expect(await coffeeCents()).toEqual([450, 500]);
    await settle();
    expect(el.querySelector('[data-testid="schedule-change"]')).toBeNull();
    expect(el.querySelector('[data-testid="schedule-change-settled"]')?.textContent).toContain(DECLINED);
  });

  it('declining one of two keeps the other, with the batch’s expiry', async () => {
    const other = { appId: 'ledger', sql: "DELETE FROM expenses WHERE label = 'rent'", counts: { changes: 1 } };
    const live = batch([{ appId: 'ledger', sql: SQL, counts: { changes: 2 } }, other]);
    seed(task(), run({ proposals: live }));
    await initScheduler(deps());
    const el = await open();
    const declines = [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'decline');
    expect(declines).toHaveLength(2);
    await act(async () => {
      declines[0]?.click();
    });
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.proposals).toEqual({ items: [other], expiresAt: live.expiresAt }));
  });

  it('an expired batch offers nothing and says so', async () => {
    seed(task(), run({ proposals: batch(undefined, new Date(Date.now() - 1_000).toISOString()) }));
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-changes-expired"]')?.textContent).toBe(EXPIRED);
    expect(el.querySelector('[data-testid="schedule-change"]')).toBeNull();
    expect(button(el, 'apply to my data')).toBeUndefined();
  });

  it('a run that asked TWO apps applies each item to ITS OWN app, named on the row — never the first step’s (S4)', async () => {
    await installStandup();
    const standupStep: ScheduleStep = { kind: 'app-think', appId: 'standup', prompt: 'what carried over?', context: { maxRows: 50 } };
    seed(
      task({ steps: [THINK, standupStep] }),
      run({
        steps: [{ status: 'ok', summary: 'coffee' }, { status: 'ok', summary: 'notes' }],
        proposals: batch([
          { appId: 'ledger', sql: SQL, counts: { changes: 2 } },
          { appId: 'standup', sql: STANDUP_SQL, summary: 'Mark the note carried over', counts: { changes: 1 } },
        ]),
      }),
    );
    await initScheduler(deps());
    const el = await open();
    const cards = [...el.querySelectorAll<HTMLElement>('[data-testid="schedule-change"]')];
    expect(cards.map((card) => card.dataset.app)).toEqual(['ledger', 'standup']);
    expect(cards[0]?.querySelector('[data-testid="schedule-change-count"]')?.textContent).toContain('would change 2 rows in Ledger');
    expect(cards[1]?.querySelector('[data-testid="schedule-change-count"]')?.textContent).toContain('would change 1 row in Standup');
    // Standup's first: its table changes, Ledger's does not.
    await act(async () => {
      [...cards[1]!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'apply to my data')?.click();
    });
    await vi.waitFor(async () => expect(await noteBodies()).toEqual(['carried over']));
    expect(await coffeeCents()).toEqual([450, 500]);
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.proposals?.items.map((item) => item.appId)).toEqual(['ledger']));
    await settle();
    // Then Ledger's — against Ledger's data.
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(async () => expect(await coffeeCents()).toEqual([999, 999]));
    await vi.waitFor(() => expect(db.listScheduleRuns('t1')[0]?.proposals).toBeUndefined());
    await settle();
    expect([...el.querySelectorAll('[data-testid="schedule-change-settled"]')]).toHaveLength(2);
  });

  it('an item that names no app is refused: the sentence, no apply, decline only', async () => {
    schedulerStore.set({ ...initialSchedulerView(), ready: true, tasks: [task()], runsByTask: { t1: [run({ proposals: batch([{ appId: '', sql: SQL, counts: { changes: 2 } }]) })] } });
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-change-no-app"]')?.textContent).toBe(NO_APP_FOR_CHANGES);
    expect(el.querySelector('[data-testid="schedule-change-count"]')?.textContent).not.toContain(' in ');
    expect(button(el, 'apply to my data')).toBeUndefined();
    expect(button(el, 'decline')).toBeDefined();
  });

  it('proposalFor builds the one write path’s shape from the ITEM’s app: the single statement, no params, the stored count as the drift baseline', () => {
    expect(proposalFor('ledger', { appId: 'ledger', sql: SQL, summary: 'x', counts: { changes: 2 } })).toEqual({
      appId: 'ledger',
      statements: [SQL],
      params: [[]],
      summary: 'x',
      previewed: [2],
    });
    expect(proposalFor('ledger', { appId: 'ledger', sql: SQL })).toEqual({ appId: 'ledger', statements: [SQL], params: [[]], summary: '', previewed: [0] });
    expect(itemAppId({ appId: 'standup' })).toBe('standup');
    expect(itemAppId({ appId: '' })).toBeUndefined();
  });
});

describe('the states with one act', () => {
  it('needs-you: the title names the app, the body is the run’s own reason; "run now and review" enqueues one manual run through the production queue', async () => {
    // TASK-20261010-host-broker PR-1 (contract v2, `copy.result.ts`): the title is `needsYouTitle`,
    // the body the run's `reason` verbatim — the old "while you’re away" tail is wrong for a declined dialog.
    const reason = needsYouUnanswered('Ledger', 'post to api.github.com').text;
    seed(task(), run({ status: 'needs-you', reason, steps: [{ status: 'refused' }], calls: { ai: 0, net: 0 } }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-needs-you"]');
    expect(card?.querySelector('.connection-note-title')?.textContent).toBe(needsYouTitle('Ledger'));
    expect(card?.querySelector('.connection-note-body')?.textContent).toBe(reason);
    expect(card?.textContent).not.toContain('while you’re away');
    expect(el.querySelector('[data-testid="schedule-status"]')?.textContent).toBe('needs you');
    // A schedule that only ASKS runs in place: no hint about opening an app, no navigation (S2).
    expect(el.querySelector('[data-testid="schedule-result-needs-you-hint"]')).toBeNull();
    await act(async () => {
      button(el, 'run now and review')?.click();
    });
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]?.ctx.run.trigger).toBe('manual');
    expect(executed[0]?.step).toEqual(THINK);
    expect(trace.calls).toEqual(['run-now:t1']);
    expect(el.querySelector('[data-testid="run-route"]')).toBeNull();
  });

  it('needs-you on a schedule that RUNS an app (S2): the act says it will open the app, opens it FIRST, then enqueues the manual run', async () => {
    const RUN: ScheduleStep = { kind: 'app-run', appId: 'ledger' };
    // A declined dialog on the open app (ADR-0077 §3): the card says so in the run's own words.
    const reason = needsYouDeclined('Ledger', 'post to api.github.com').text;
    seed(task({ steps: [NOTIFY, RUN] }), run({ status: 'needs-you', reason, steps: [{ status: 'ok' }, { status: 'refused' }], calls: { ai: 0, net: 0 } }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-needs-you"]');
    expect(card?.querySelector('.connection-note-title')?.textContent).toBe(needsYouTitle('Ledger'));
    expect(card?.querySelector('.connection-note-body')?.textContent).toBe(reason);
    expect(card?.textContent).not.toContain('while you’re away');
    // The one act stays *run now and review*.
    expect(card?.querySelectorAll('button')).toHaveLength(1);
    expect(button(el, 'run now and review')).toBeDefined();
    expect(el.querySelector('[data-testid="schedule-result-needs-you-hint"]')?.textContent).toBe(openingToRun('Ledger'));
    await act(async () => {
      button(el, 'run now and review')?.click();
    });
    await settle();
    // The navigation, THEN the act — the engine delivers a manual run only to a live frame.
    expect(trace.calls).toEqual(['navigate:/run/ledger', 'run-now:t1']);
    expect(el.querySelector('[data-testid="run-route"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="schedule-result-detail"]')).toBeNull();
  });

  it('needs-you where the refused step is a *run <app>* step among others: that step’s app is the one opened (S2)', async () => {
    db.installApp({ appId: 'standup', displayName: 'Standup', html: '<html>standup</html>' });
    seed(
      task({ steps: [{ kind: 'app-run', appId: 'ledger' }, { kind: 'app-run', appId: 'standup' }] }),
      run({ status: 'needs-you', reason: 'refused', steps: [{ status: 'ok' }, { status: 'refused' }], calls: { ai: 0, net: 0 } }),
    );
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-result-needs-you-hint"]')?.textContent).toBe(openingToRun('Standup'));
    await act(async () => {
      button(el, 'run now and review')?.click();
    });
    await settle();
    expect(trace.calls).toEqual(['navigate:/run/standup', 'run-now:t1']);
  });

  it('no-handler: the sentence and "open <app>" to the run route', async () => {
    seed(task(), run({ status: 'no-handler', steps: [{ status: 'no-handler' }] }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-no-handler"]');
    expect(card?.textContent).toContain(noHandler('Ledger').text);
    const link = card?.querySelector('a');
    expect(link?.textContent).toBe('open Ledger');
    expect(link?.getAttribute('href')).toBe('/run/ledger');
  });

  it('capped: the ceiling sentence, with no act — tomorrow is the act', async () => {
    seed(task(), run({ status: 'capped', reason: 'capped', steps: [{ status: 'refused' }] }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-capped"]');
    expect(card?.textContent).toContain(capped(CAPPED_WHAT));
    expect(card?.querySelector('button, a')).toBeNull();
  });

  it('interrupted: the engine’s reason word in the user’s terms', async () => {
    seed(task(), run({ status: 'interrupted', reason: 'stale claim', steps: [] }));
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-result-interrupted"]')?.textContent).toBe(interruptedWhy('stale claim'));
  });
});

describe('one status vocabulary across surfaces (M5)', () => {
  const index: AppIndex = { bySource: new Map(), ids: new Set(['ledger']), name: (appId) => (appId === 'ledger' ? 'Ledger' : appId), emoji: () => undefined };
  const expected = RUN_STATUSES.map((status) => RESULT_STATUS_WORD[status]);

  it('the feed, the detail and the missed card print copy.RESULT_STATUS_WORD for every run status', async () => {
    expect(expected).toEqual(['missed', 'running', 'done', 'failed', 'skipped', 'needs you', 'interrupted', 'capped', 'not supported'].sort((a, b) => expected.indexOf(a) - expected.indexOf(b)));
    expect(new Set(expected).size, 'every status has its own word').toBe(RUN_STATUSES.length);

    // The feed: one row per status (seen, so the word stands alone).
    const rows = RUN_STATUSES.map((status, i) => ({ run: run({ status, dueAt: new Date(NOW - i * 60_000).toISOString(), seenAt: DUE }), item: task(), at: DUE }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ResultsList rows={rows} apps={index} now={new Date(NOW)} />
        </MemoryRouter>,
      );
    });
    const feed = [...container.querySelectorAll('.schedule-result-word')].map((el) => el.textContent);
    expect(feed).toEqual(expected);
    unmountNow();

    // The detail: the header's status word, per status.
    const detail: string[] = [];
    for (const status of RUN_STATUSES) {
      schedulerStore.set({ ...initialSchedulerView(), ready: true, tasks: [task()], runsByTask: { t1: [run({ status })] } });
      const el = await open();
      detail.push(el.querySelector('[data-testid="schedule-status"]')?.textContent ?? '');
      unmountNow();
    }
    expect(detail).toEqual(expected);

    // The missed card's outcome rows.
    expect(RUN_STATUSES.map((status) => outcomeWord(run({ status })))).toEqual(expected);
  });
});

describe('copy.result — the pure sentences', () => {
  it('callsLine and hostWord', () => {
    expect(callsLine({ ai: 0, net: 0 })).toBe('no AI or network calls');
    expect(callsLine({ ai: 1, net: 0 })).toBe('1 AI call');
    expect(callsLine({ ai: 2, net: 3 })).toBe('2 AI calls · 3 network calls');
    expect(hostWord({ kind: 'web' })).toBe('a browser tab');
    expect(hostWord({ kind: 'desktop' })).toBe('Snug for Mac');
    expect(hostWord({ kind: 'host', binding: 'artifact' })).toBe('an artifact page');
    expect(hostWord({ kind: 'host', binding: 'local' })).toBe('your agent’s plugin');
  });

  it('interruptedWhy maps every engine reason, and passes an unknown one through', () => {
    expect(interruptedWhy('cancelled')).toBe('you cancelled it');
    expect(interruptedWhy('timeout')).toBe('it took too long and was stopped');
    expect(interruptedWhy('paused')).toBe('all schedules were paused');
    expect(interruptedWhy('file swap')).toBe('your file changed underneath it');
    expect(interruptedWhy(undefined)).toBe('it was interrupted');
    expect(interruptedWhy('something else')).toBe('something else');
  });

  it('wouldChange and applied count rows, singular handled', () => {
    expect(wouldChange(1)).toBe('would change 1 row');
    expect(wouldChange(undefined)).toBe('row count unknown');
    expect(applied([1])).toBe('applied — 1 row changed');
    expect(applied([2, 3])).toBe('applied — 5 rows changed');
  });
});
