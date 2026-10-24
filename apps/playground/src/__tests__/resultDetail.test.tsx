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
import {
  ACCESS_UNDO_TTL_MS,
  RUN_STATUSES,
  SCHEDULE_HELD_REASONS,
  SCHEDULE_PROPOSAL_TTL_MS,
  type OwnUndoEntry,
  type ScheduleProposalItem,
  type ScheduleRun,
  type ScheduleStep,
  type ScheduledTask,
} from '@snugprotocol/protocol';

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES } from '@snugprotocol/adapters';

import { ACCESS_SHEET, FETCH_FIRST, OWN_UNDO } from '../access/copy.js';
import type { SnugPlatform } from '../platform/platform.js';
import { RESULT_STATUS_WORD, WORDS, brainBlocked, capped, needsYouDeclined, needsYouUnanswered, noHandler } from '../schedule/copy.js';
import { ROW } from '../schedule/copy.page.js';
import {
  CAPPED_WHAT,
  CHANGES_LINK,
  DECLINED,
  DRIFTED,
  EXPIRED,
  HELD_WHY,
  NO_APP_FOR_CHANGES,
  RESULT_MISSING,
  applied,
  callsLine,
  hostWord,
  interruptedWhy,
  needsYouTitle,
  openingToRun,
  stepFacts,
  wouldChange,
} from '../schedule/copy.result.js';
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
  // PR-4 Gate-5 U2: the undo-age pins fake the Date at NOW (the page's clock and the db's agree).
  vi.useRealTimers();
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

// =============================================================================================
// TASK-20261010-host-broker PR-4 — the result page (D-PR4-18, D-PR4-6, D-PR4-15; D2, D7, D8, D13,
// D18, D19; AC31, AC32). Two sections, in order: *changes it made* (`WORDS.changesMade`) — a task's
// group reads *changed 12 rows in Ledger on its own · undo*, the user's approve *you applied this —
// 2 rows changed · undo* (now PERSISTED as the run's `applied` group, so a reload keeps it), *undone*
// after an undo, *undo ended after seven days* past it, *· can’t be undone* when `undoable:false`;
// then *changes waiting for your OK*, each held item with ONE line `HELD_WHY[reason]` above its acts.
// *stop making changes on its own* appears ONCE, under the header's when-line. Each step has ONE
// host line `stepFacts` (where · saw · tools — the word *background* never shown). `blockedBy:'brain'`
// is its own state with the one act *open Settings*, never *needs your OK*. The undo's armed confirm
// moves focus to *keep* when it arms and to the outcome line when answered; the group is
// `role="group"` named by its question; at 375 px the line wraps (`field-row-wrap`).
//
// Clocks: every own-undo entry is seeded relative to the REAL clock (the db's liveness reads it,
// like the batch's expiry above) — never a fixed instant against the wall clock.
//
// Assumed (lane T-C questions): `schedule-result-made` (section) · `schedule-made-group` ·
// `schedule-change-held` · `schedule-result-on-its-own` · `schedule-result-step-facts` ·
// `schedule-result-brain` · `schedule-result-changes-link`; the journal accessors
// `db.putOwnUndo(appId, bucket, entry)` / `db.listOwnUndo(appId, {taskId} | {bucket:'approval'})`
// with a task's bucket being its id; a task group vs the user's is told apart by the implementation.
// =============================================================================================

const U_TASK = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
const U_GONE = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const ARMED = { rowsPerRun: 200, armedAt: '2026-10-08T09:00:00.000Z', armedVersion: 1 };
const armedTask = (over: Partial<ScheduledTask> = {}): ScheduledTask => task({ writeAuthority: ARMED, ...over } as Partial<ScheduledTask>);

/** A live task-bucket entry for the two coffees (rowid 1 and 3), seeded relative to the real clock. */
// sanctioned by PR-4 v2.2 note h — typed as the entry `putOwnUndo` takes, so the test tsc is clean.
function taskEntry(id: string, rows = 2): OwnUndoEntry {
  const at = Date.now() - 3 * 3_600_000;
  return {
    id,
    at: new Date(at).toISOString(),
    expiresAt: new Date(at + 7 * 86_400_000).toISOString(),
    authority: 'task',
    via: 'schedule',
    runId: 'r1',
    taskId: 't1',
    steps: [
      {
        table: 'expenses',
        op: 'update',
        columns: ['cents'],
        rows: Array.from({ length: rows }, (_, i) => ({ rowid: i + 1, before: [450], after: [999] })),
      },
    ],
  };
}

const appliedGroup = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ appId: 'ledger', undoId: U_TASK, items: [{ summary: 'Tidied the coffees', changes: 12 }], ...over });

const heldBatch = (reason: string): NonNullable<ScheduleRun['proposals']> =>
  batch([{ appId: 'ledger', sql: SQL, summary: 'Set both coffees to 9.99', counts: { changes: 2 }, held: reason } as ScheduleProposalItem]);

describe('PR-4 — two sections, in order: changes it made, then changes waiting for your OK (D-PR4-18)', () => {
  it('a task’s group reads *changed 12 rows in Ledger on its own · undo*, ABOVE the held item, whose one line sits above its acts', async () => {
    seed(armedTask(), run({ applied: appliedGroup(), proposals: heldBatch('over-limit') } as Partial<ScheduleRun>));
    db.putOwnUndo('ledger', 't1', taskEntry(U_TASK, 12));
    await initScheduler(deps());
    const el = await open();
    const made = el.querySelector('[data-testid="schedule-result-made"]');
    const waiting = el.querySelector('[data-testid="schedule-result-changes"]');
    expect(made?.querySelector('h2')?.textContent).toBe(WORDS.changesMade);
    expect(WORDS.changesMade).toBe('changes it made');
    expect(waiting?.querySelector('h2')?.textContent).toBe(WORDS.changesWaiting);
    expect(made!.compareDocumentPosition(waiting!) & Node.DOCUMENT_POSITION_FOLLOWING, 'changes it made comes first').toBeTruthy();
    const group = made?.querySelector('[data-testid="schedule-made-group"]');
    expect(group?.textContent).toBe('changed 12 rows in Ledger on its own · undo');
    expect(group?.querySelector('button')?.textContent).toBe(ACCESS_SHEET.undo);
    expect(group?.className, 'at 375 px the line and its undo wrap').toContain('field-row-wrap');
    const held = waiting?.querySelector('[data-testid="schedule-change-held"]');
    expect(held?.textContent).toBe('not made — it would pass the 200 rows this schedule may change each time');
    const apply = button(el, 'apply to my data');
    expect(held!.compareDocumentPosition(apply!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the line sits above its acts').toBeTruthy();
  });

  it.each([...(SCHEDULE_HELD_REASONS ?? [])])('a %s item carries HELD_WHY’s one line, verbatim', async (reason) => {
    seed(armedTask(), run({ proposals: heldBatch(reason) }));
    await initScheduler(deps());
    const el = await open();
    // PR-4 Gate-5 U14: `full` names the bucket's LIVE count read at render — none is seeded here, so 0.
    // Was: const entry = (HELD_WHY as Record<string, string | ((appName: string) => string)>)[reason];
    //      const expected = typeof entry === 'function' ? entry('Ledger') : entry;
    const entry = (HELD_WHY as Record<string, string | ((appName: string, live: number) => string)>)[reason];
    const expected = typeof entry === 'function' ? entry('Ledger', 0) : entry;
    expect(el.querySelectorAll('[data-testid="schedule-change-held"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="schedule-change-held"]')?.textContent).toBe(expected);
  });

  it('the seven held sentences, byte for byte (the busy one names the app)', async () => {
    // PR-4 Gate-5 U14: `full` names the bucket's LIVE count read at render — the bucket is seeded at
    // its cap (20 live entries) so the contract's sentence reads byte for byte under that rule too.
    for (let i = 0; i < 20; i++) db.putOwnUndo('ledger', 't1', taskEntry(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 1));
    expect(db.listOwnUndo('ledger', { taskId: 't1' }), 'precondition: 20 live').toHaveLength(20);
    const lines: Record<string, string> = {};
    for (const reason of SCHEDULE_HELD_REASONS) {
      seed(armedTask(), run({ proposals: heldBatch(reason) }));
      schedulerStore.set({ ...initialSchedulerView(), ready: true, tasks: [armedTask()], runsByTask: { t1: [run({ proposals: heldBatch(reason) })] } });
      const el = await open();
      lines[reason] = el.querySelector('[data-testid="schedule-change-held"]')?.textContent ?? '';
      unmountNow();
    }
    expect(lines).toEqual({
      'cannot-undo': 'not made — it couldn’t be undone, so it waits for you (applying it here can’t be undone either)',
      'over-limit': 'not made — it would pass the 200 rows this schedule may change each time',
      busy: 'not made — Ledger was in the middle of a change',
      stopped: 'not made — it was stopped from making changes on its own',
      changed: 'not made — the data moved since the AI looked',
      full: 'not made — 20 earlier changes can still be undone; it will make changes again as they age out',
      failed: 'not made — something went wrong; nothing was changed',
    });
  });

  it('NEGATIVE: an unheld item (an unarmed run’s) carries no held line', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-change-held"]')).toBeNull();
    expect(el.querySelector('[data-testid="schedule-result-made"]'), 'nothing was made — no first section').toBeNull();
  });

  it('`undoable:false`: the group says it can’t be undone and offers no undo', async () => {
    seed(armedTask(), run({ applied: appliedGroup({ undoId: undefined, undoable: false }) } as Partial<ScheduleRun>));
    await initScheduler(deps());
    const el = await open();
    const group = el.querySelector('[data-testid="schedule-made-group"]');
    expect(group?.textContent).toBe('changed 12 rows in Ledger on its own · can’t be undone');
    expect(group?.querySelector('button')).toBeNull();
  });

  it('past its seven days (the journal holds it no longer): *undo ended after seven days*, no undo', async () => {
    // REBASED by PR-4 Gate-5 U2 onto a run that finished 8 days before NOW (the Date faked at NOW): the
    // line is said only past the seven days — a recent run's gone id reads *can no longer be undone*.
    // Was: seed(armedTask(), run({ applied: appliedGroup({ undoId: U_GONE }) } as Partial<ScheduleRun>));
    //      await initScheduler(deps()); const el = await open();   (a run finished minutes before NOW)
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const oldDue = new Date(NOW - 8 * 86_400_000).toISOString();
    seed(armedTask(), run({ id: 'r-old', dueAt: oldDue, startedAt: oldDue, finishedAt: new Date(Date.parse(oldDue) + 20_000).toISOString(), applied: appliedGroup({ undoId: U_GONE }) } as Partial<ScheduleRun>));
    await initScheduler(deps());
    const el = await open(oldDue);
    const group = el.querySelector('[data-testid="schedule-made-group"]');
    expect(group?.textContent).toBe('changed 12 rows in Ledger on its own · undo ended after seven days');
    expect(group?.querySelector('button')).toBeNull();
  });

  it('each result links to the schedule’s changes list, so an undo is findable for its whole seven days', async () => {
    seed(armedTask(), run({ applied: appliedGroup() } as Partial<ScheduleRun>));
    db.putOwnUndo('ledger', 't1', taskEntry(U_TASK, 12));
    await initScheduler(deps());
    const el = await open();
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="schedule-result-changes-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href') ?? '').toMatch(/^\/schedule\b.*t1/);
  });
});

describe('PR-4 — the user’s approve is PERSISTED as an `approved` entry, with its undo (D-PR4-6, D-PR4-18, D-PR4-19; v2.1 note N1)', () => {
  it('apply → the run row carries `approved` (no SQL), the approval bucket journals it as the user’s, and the first section reads *you applied this — 2 rows changed · undo*; a reload keeps it', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    let el = await open();
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(async () => expect(await coffeeCents()).toEqual([999, 999]));
    // v2.1 note N1 (orchestrator, moved from `applied`): the run's `applied` seat is the TASK's own group;
    // the user's approve of an item is ONE `approved` entry, so both can sit on one run.
    await vi.waitFor(() => expect((db.listScheduleRuns('t1')[0] as { approved?: unknown }).approved).toBeDefined());
    const approvedSeat = (db.listScheduleRuns('t1')[0] as { approved?: Array<{ appId: string; undoId?: string; summary?: string; changes: number }> }).approved!;
    expect(approvedSeat).toHaveLength(1);
    const group = approvedSeat[0]!;
    expect(group).toMatchObject({ appId: 'ledger', summary: 'Set both coffees to 9.99', changes: 2 });
    expect((db.listScheduleRuns('t1')[0] as { applied?: unknown }).applied, 'the task’s seat stays absent').toBeUndefined();
    expect(JSON.stringify(group), 'no SQL in the group').not.toContain('UPDATE');
    const journal = db.listOwnUndo('ledger', { bucket: 'approval' });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ id: group.undoId, authority: 'approval', via: 'user' });
    await settle();
    expect(el.querySelector('[data-testid="schedule-made-group"]')?.textContent).toBe('you applied this — 2 rows changed · undo');

    unmountNow();
    el = await open();
    expect(el.querySelector('[data-testid="schedule-made-group"]')?.textContent, 'a reload keeps it').toBe('you applied this — 2 rows changed · undo');
  });

  it('undo: armed confirm (role=group named by its question) with focus on *keep*; keep backs out; *yes, undo* puts the rows back and focuses the outcome', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    const el = await open();
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-made-group"] button')).not.toBeNull());
    const undoButton = (): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>('[data-testid="schedule-made-group"] button');
    await act(async () => {
      undoButton()?.click();
    });
    await settle();
    const question = OWN_UNDO.arm(2, 'Ledger');
    const confirm = el.querySelector(`[role="group"][aria-label="${question}"]`);
    expect(confirm, 'the group is named by its question').not.toBeNull();
    expect(confirm?.textContent).toContain(question);
    expect(document.activeElement?.textContent, 'focus moves to keep when it arms').toBe(ACCESS_SHEET.undoKeep);
    await act(async () => {
      button(el, ACCESS_SHEET.undoKeep)?.click();
    });
    await settle();
    expect(el.querySelector(`[role="group"][aria-label="${question}"]`)).toBeNull();
    expect(await coffeeCents(), 'keep undid nothing').toEqual([999, 999]);

    await act(async () => {
      undoButton()?.click();
    });
    await settle();
    await act(async () => {
      button(el, ACCESS_SHEET.undoYes)?.click();
    });
    await vi.waitFor(async () => expect(await coffeeCents()).toEqual([450, 500]));
    await settle();
    const group = el.querySelector('[data-testid="schedule-made-group"]');
    expect(group?.textContent).toContain(ACCESS_SHEET.undone);
    expect(group?.querySelector('button'), 'no second undo').toBeNull();
    expect(document.activeElement?.textContent, 'focus moves to the outcome line when answered').toContain(ACCESS_SHEET.undone);
    expect(db.listOwnUndo('ledger', { bucket: 'approval' }), 'the entry is no longer live').toHaveLength(0);
  });

  it('a task’s group undoes through ITS bucket: the rows go back and the task’s journal holds it no longer', async () => {
    // The live rows are the AFTER values the entry captured — the undo re-validates against them.
    await db.driver.handle('ledger', execFrame("UPDATE expenses SET cents = 999 WHERE label = 'coffee'"));
    const entry = taskEntry(U_TASK, 1);
    seed(armedTask(), run({ applied: appliedGroup({ items: [{ changes: 1 }] }) } as Partial<ScheduleRun>));
    db.putOwnUndo('ledger', 't1', entry);
    await initScheduler(deps());
    const el = await open();
    const group = el.querySelector('[data-testid="schedule-made-group"]');
    expect(group?.textContent).toBe('changed 1 row in Ledger on its own · undo');
    await act(async () => {
      group?.querySelector<HTMLButtonElement>('button')?.click();
    });
    await settle();
    await act(async () => {
      button(el, ACCESS_SHEET.undoYes)?.click();
    });
    await vi.waitFor(async () => expect(await coffeeCents()).toEqual([450, 999]));
    expect(db.listOwnUndo('ledger', { taskId: 't1' })).toHaveLength(0);
  });
});

describe('PR-4 — the one *stop*, under the header (D-PR4-18; D7)', () => {
  it('an armed schedule’s result says so under the when-line, with ONE act *stop* — which clears the authority', async () => {
    seed(armedTask(), run());
    await initScheduler(deps());
    const el = await open();
    const line = el.querySelector('[data-testid="schedule-result-on-its-own"]');
    expect(line?.textContent).toBe('this schedule makes changes on its own · stop');
    const when = el.querySelector('[data-testid="schedule-result-when"]');
    expect(when!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING, 'under the when-line').toBeTruthy();
    expect([...el.querySelectorAll('button')].filter((b) => /^stop\b/.test(b.textContent?.trim() ?? '')), 'stop appears ONCE').toHaveLength(1);
    await act(async () => {
      line?.querySelector<HTMLButtonElement>('button')?.click();
    });
    await vi.waitFor(() => expect(db.getScheduledTask('t1')?.writeAuthority).toBeUndefined());
    expect(db.getScheduledTask('t1')?.disarmed, 'the user did this — no trace').toBeUndefined();
    await settle();
    expect(el.querySelector('[data-testid="schedule-result-on-its-own"]')).toBeNull();
  });

  it('NEGATIVE: an unarmed schedule’s result has no such line and no stop', async () => {
    seed(task(), run());
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-result-on-its-own"]')).toBeNull();
    expect(el.textContent).not.toContain('makes changes on its own');
  });
});

describe('PR-4 — each step’s ONE host line, stepFacts (D-PR4-18; D18, R-88)', () => {
  const facts = (el: HTMLElement): string[] => [...el.querySelectorAll('[data-testid="schedule-result-step-facts"]')].map((n) => n.textContent ?? '');

  it('an ask step: Snug did it itself — the app didn’t open; a tools step that needed nothing says so, joined by a middle dot', async () => {
    seed(task(), run({ steps: [{ status: 'ok', summary: 'fine', tools: { used: 0 } } as never] }));
    await initScheduler(deps());
    const el = await open();
    expect(facts(el)).toEqual(['Snug did this itself — Ledger didn’t open · didn’t need to look anything up']);
  });

  it('a tool-free ask step says only where it ran', async () => {
    seed(task(), run());
    await initScheduler(deps());
    const el = await open();
    expect(facts(el)).toEqual(['Snug did this itself — Ledger didn’t open']);
  });

  it('a run step: in the open app, or out of sight while it was closed — never the word *background*', async () => {
    const RUN: ScheduleStep = { kind: 'app-run', appId: 'ledger' };
    seed(task({ steps: [RUN, RUN] }), run({ steps: [{ status: 'ok', inOpenApp: true } as never, { status: 'ok' }] }));
    await initScheduler(deps());
    const el = await open();
    expect(facts(el)).toEqual(['ran in Ledger while it was open', 'ran Ledger out of sight while it was closed']);
    expect(el.textContent).not.toMatch(/\bbackground\b/i);
  });

  it('what it saw (R-88 closed): one shared table is named with its app; more than two fold into a count', async () => {
    seed(
      task(),
      run({
        steps: [{ status: 'ok', saw: [{ source: 'Budget', table: 'transactions' }] } as never],
      }),
    );
    await initScheduler(deps());
    let el = await open();
    expect(facts(el)[0]).toBe('Snug did this itself — Ledger didn’t open · read Budget’s transactions (you allowed it)');
    unmountNow();
    schedulerStore.set({
      ...initialSchedulerView(),
      ready: true,
      tasks: [task()],
      runsByTask: {
        t1: [
          run({
            steps: [
              {
                status: 'ok',
                saw: [
                  { source: 'Budget', table: 'transactions' },
                  { source: 'Budget', table: 'budgets' },
                  { source: 'Standup', table: 'notes' },
                ],
              } as never,
            ],
          }),
        ],
      },
    });
    el = await open();
    expect(facts(el)[0]).toContain('read 3 tables from 2 apps you allowed');
  });

  it('what it looked up, through which connection (slot names on the row, the connection’s name on the page)', async () => {
    // sanctioned by PR-4 v2.2 note g — a provider the registry does not know, so the 'inference' declaration is admitted as written.
    db.putDeclaredConnection(
      'ledger',
      'songbook',
      {
        slot: 'songbook',
        kind: 'api_key',
        provider: { name: 'Songbook' },
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
        request: { headerTemplate: { Authorization: 'Bearer {{api_key}}' } },
        declaredApiHosts: ['api.songbook.example'],
      },
      'inference',
    );
    db.approveConnection('ledger', 'songbook');
    seed(task(), run({ steps: [{ status: 'ok', tools: { used: 3, fetched: [{ connection: 'songbook', calls: 3 }] } } as never] }));
    await initScheduler(deps());
    const el = await open();
    expect(facts(el)[0]).toBe('Snug did this itself — Ledger didn’t open · looked things up 3 times through Songbook');
  });

  it('a brain that could not look things up: the step says so on the result too', async () => {
    seed(task(), run({ steps: [{ status: 'ok', tools: { unavailable: 'brain' } } as never] }));
    await initScheduler(deps());
    const el = await open();
    expect(facts(el)[0]).toContain('without looking things up');
  });
});

describe('PR-4 — blockedBy:"brain" is its own state: *open Settings*, never *needs your OK* (D-PR4-15; D13)', () => {
  it('a step refused because the brain is the demo or keyless: the one act opens Settings; no needs-you card, no run-now act', async () => {
    seed(task(), run({ status: 'needs-you', reason: 'refused', steps: [{ status: 'refused', blockedBy: 'brain', summary: 'refused' } as never] }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-brain"]');
    expect(card).not.toBeNull();
    const act1 = [...(card?.querySelectorAll('a, button') ?? [])];
    expect(act1).toHaveLength(1);
    expect(act1[0]?.textContent).toBe('open Settings');
    expect(act1[0]?.getAttribute('href')).toBe('/settings');
    expect(el.querySelector('[data-testid="schedule-result-needs-you"]')).toBeNull();
    expect(el.textContent).not.toContain('needs your OK');
    expect(button(el, 'run now and review')).toBeUndefined();
  });
});

// =============================================================================================
// TASK-20261023-siwc-chatgpt-plan Gate 3, L5 — the result page on the ChatGPT plan (AC7, AC14;
// plan §12 L5-3, L5-4; ADR-0078 §5, §8).
//
// L5-3: `stepResultSchema` is strict and carries no `code` (a C3 change, queued), so a usage-limit
// refusal is recognised by its summary being EXACTLY the single-homed sentence
// `CHATGPT_ERROR_SENTENCES.CHATGPT_USAGE_LIMIT` (compared, never retyped — imported here too), and
// its StepRow carries **Manage usage** as the PRIMARY action. No `blockedBy` — it is not a
// brain-missing state.
// L5-4: the run-level brain card shows the FIRST blocked step's summary (the plan's signed-out
// sentence), never "it's the demo, or it has no key yet" for a chatgpt-blocked run; **open
// Settings** stays its primary act; a blocked step with NO summary keeps today's sentence.
// RED until StepRow and the brain card read the step.
// =============================================================================================

describe('the result page on the ChatGPT plan (L5-3, L5-4)', () => {
  const LIMIT = CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_LIMIT];
  const SIGNED_OUT_REFUSAL = 'Sign in to ChatGPT to run this step — it runs on your ChatGPT plan.';
  const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

  const manageUsageIn = (scope: ParentNode): HTMLAnchorElement | undefined =>
    [...scope.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === 'Manage usage');

  it('a step refused with the usage-limit sentence: its row carries Manage usage as the PRIMARY action', async () => {
    seed(task(), run({ status: 'failed', reason: LIMIT, steps: [{ status: 'refused', summary: LIMIT }] }));
    await initScheduler(deps());
    const el = await open();
    const row = el.querySelector('[data-testid="schedule-result-step"]');
    expect(row?.textContent).toContain(LIMIT);
    const manage = manageUsageIn(row!);
    expect(manage, 'the limit names its one remedy').toBeDefined();
    expect(manage!.getAttribute('href')).toBe(MANAGE_USAGE_URL);
    expect(manage!.classList.contains('btn-primary')).toBe(true);
    // FIRST (§12's rule; verifier R3): Manage usage renders before the "open <app>" link in the row.
    const openApp = row!.querySelector<HTMLAnchorElement>('.schedule-result-step-app');
    expect(openApp, 'the row still offers the app').not.toBeNull();
    expect(manage!.compareDocumentPosition(openApp!) & Node.DOCUMENT_POSITION_FOLLOWING, 'Manage usage comes first').toBeTruthy();
    const anchors = [...row!.querySelectorAll('a')];
    expect(anchors.indexOf(manage!)).toBeLessThan(anchors.indexOf(openApp!));
    // Not a brain-missing state: no open-Settings brain card.
    expect(el.querySelector('[data-testid="schedule-result-brain"]')).toBeNull();
  });

  it('NEGATIVE: a refused step with any other summary carries no Manage usage act', async () => {
    seed(task(), run({ status: 'failed', reason: 'the app said no', steps: [{ status: 'refused', summary: 'the app said no' }] }));
    await initScheduler(deps());
    const el = await open();
    expect(manageUsageIn(el)).toBeUndefined();
  });

  it('a chatgpt-blocked run: the brain card says the plan’s sentence, NOT the demo/keyless one — open Settings still primary', async () => {
    seed(task(), run({ status: 'needs-you', reason: 'refused', steps: [{ status: 'refused', blockedBy: 'brain', summary: SIGNED_OUT_REFUSAL }] }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-brain"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.connection-note-title')?.textContent).toBe(SIGNED_OUT_REFUSAL);
    expect(el.textContent).not.toContain(brainBlocked.text);
    expect(el.textContent).not.toContain('it’s the demo, or it has no key yet');
    const acts = [...card!.querySelectorAll('a, button')];
    expect(acts).toHaveLength(1);
    expect(acts[0]?.textContent).toBe('open Settings');
    expect(acts[0]?.getAttribute('href')).toBe('/settings');
    expect(acts[0]?.classList.contains('btn-primary')).toBe(true);
  });

  it('a blocked step with NO summary keeps today’s card — the keyless sentence and open Settings', async () => {
    seed(task(), run({ status: 'needs-you', reason: 'refused', steps: [{ status: 'refused', blockedBy: 'brain' } as never] }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-brain"]');
    expect(card?.querySelector('.connection-note-title')?.textContent).toBe(brainBlocked.text);
    expect([...(card?.querySelectorAll('a, button') ?? [])].map((a) => a.textContent)).toEqual(['open Settings']);
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 Gate 5 — the result page's UI folds (U2, U6, U7, U14).
//
// U2: the made line says what is TRUE of its undo. The page reads the journal with the undone
// entries too (A12, `listOwnUndo(…, { includeUndone: true })`): an entry undone earlier reads
// *undone* after a reload; an id the journal no longer holds reads *can no longer be undone* (the
// data-write card's words, ONE home) — unless the run finished `ACCESS_UNDO_TTL_MS` or more ago,
// when it reads *undo ended after seven days*. The Date is faked at NOW in every pin here, so the
// page's clock, the db's liveness and the run's instants agree — no fixed instant against the wall.
// U6: the link to the changes list shows only when the schedule makes changes on its own or the run
// has the TASK's `applied` group (an approval lives in the approval bucket, which that list never
// shows), and says what the list holds.
// U7: the result page's *stop* leaves a focused `role="status"` line in place of the act.
// U14: a held *full* names the live count read at render; the capped line names the limit's kind.
// =============================================================================================

describe('PR-4 Gate-5 U2 — the made line says what is true of its undo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  const madeText = (el: HTMLElement): string | null | undefined => el.querySelector('[data-testid="schedule-made-group"]')?.textContent;

  it('an approve undone on this page, then a reload: *you applied this — 2 rows changed · undone* — never *undo ended*', async () => {
    seed(task(), run({ proposals: batch() }));
    await initScheduler(deps());
    let el = await open();
    await act(async () => {
      button(el, 'apply to my data')?.click();
    });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="schedule-made-group"] button')).not.toBeNull());
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-made-group"] button')?.click();
    });
    await settle();
    await act(async () => {
      button(el, ACCESS_SHEET.undoYes)?.click();
    });
    await vi.waitFor(async () => expect(await coffeeCents()).toEqual([450, 500]));
    await settle();

    unmountNow();
    el = await open();
    expect(madeText(el)).toBe(`you applied this — 2 rows changed · ${ACCESS_SHEET.undone}`);
    expect(el.querySelector('[data-testid="schedule-made-group"] button'), 'nothing more to undo').toBeNull();
    expect(el.textContent).not.toContain('undo ended after seven days');
  });

  it('a task’s group whose entry was undone earlier (still in the journal, marked) reads *undone* on open', async () => {
    seed(armedTask(), run({ applied: appliedGroup() } as Partial<ScheduleRun>));
    db.putOwnUndo('ledger', 't1', { ...taskEntry(U_TASK, 12), undoneAt: new Date(NOW - 60_000).toISOString() });
    await initScheduler(deps());
    const el = await open();
    expect(madeText(el)).toBe(`changed 12 rows in Ledger on its own · ${ACCESS_SHEET.undone}`);
    expect(el.querySelector('[data-testid="schedule-made-group"] button')).toBeNull();
  });

  it('a gone id on a RECENT run (evicted early, or undone and aged out of the journal): *can no longer be undone* — the card’s words', async () => {
    seed(armedTask(), run({ applied: appliedGroup({ undoId: U_GONE }) } as Partial<ScheduleRun>));
    await initScheduler(deps());
    const el = await open();
    expect(madeText(el)).toBe('changed 12 rows in Ledger on its own · can no longer be undone');
    expect(el.querySelector('[data-testid="schedule-made-group"] button')).toBeNull();
    expect(madeText(el)).not.toContain('seven days');
  });

  it('…the user’s own approve whose entry the approval bucket evicted early reads the same', async () => {
    seed(task(), run({ approved: [{ appId: 'ledger', undoId: U_GONE, summary: 'Set both coffees to 9.99', changes: 2 }] } as Partial<ScheduleRun>));
    await initScheduler(deps());
    const el = await open();
    expect(madeText(el)).toBe('you applied this — 2 rows changed · can no longer be undone');
  });

  it('the boundary is the run’s finish + ACCESS_UNDO_TTL_MS: one minute short reads *can no longer be undone*; at it, *undo ended after seven days*', async () => {
    const at = (finishedMs: number, id: string): { due: string; row: ScheduleRun } => {
      const due = new Date(finishedMs - 20_000).toISOString();
      return { due, row: run({ id, dueAt: due, startedAt: due, finishedAt: new Date(finishedMs).toISOString(), applied: appliedGroup({ undoId: U_GONE }) } as Partial<ScheduleRun>) };
    };
    const short = at(NOW - ACCESS_UNDO_TTL_MS + 60_000, 'r-short');
    const past = at(NOW - ACCESS_UNDO_TTL_MS, 'r-past');
    seed(armedTask(), short.row);
    db.putScheduleRun(past.row);
    await initScheduler(deps());
    let el = await open(short.due);
    expect(madeText(el)).toBe('changed 12 rows in Ledger on its own · can no longer be undone');
    unmountNow();
    el = await open(past.due);
    expect(madeText(el)).toBe('changed 12 rows in Ledger on its own · undo ended after seven days');
  });
});

describe('PR-4 Gate-5 U6 — the link to the changes list: when it shows, and what it says', () => {
  const link = (el: HTMLElement): HTMLAnchorElement | null => el.querySelector<HTMLAnchorElement>('[data-testid="schedule-result-changes-link"]');

  it('an armed schedule’s result links to its changes, in words that say what the list holds', async () => {
    seed(armedTask(), run());
    await initScheduler(deps());
    const el = await open();
    expect(link(el)?.textContent).toBe(CHANGES_LINK);
    expect(CHANGES_LINK).toBe('this schedule’s changes you can still undo');
  });

  it('a run with the task’s own group links to them even once the schedule was stopped', async () => {
    seed(task(), run({ applied: appliedGroup() } as Partial<ScheduleRun>));
    db.putOwnUndo('ledger', 't1', taskEntry(U_TASK, 12));
    await initScheduler(deps());
    const el = await open();
    expect(link(el)).not.toBeNull();
  });

  it('NEGATIVE: an approved-only run of an UNARMED schedule shows no link — the list never holds the user’s approvals', async () => {
    seed(task(), run({ approved: [{ appId: 'ledger', undoId: U_GONE, summary: 'Set both coffees to 9.99', changes: 2 }] } as Partial<ScheduleRun>));
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-result-made"]'), 'the approval is still shown').not.toBeNull();
    expect(link(el)).toBeNull();
  });
});

describe('PR-4 Gate-5 U7 — the result page’s *stop* answers in words, where the focus was', () => {
  it('after *stop*, a role="status" line reads ROW.stoppedOnItsOwn and holds the focus', async () => {
    seed(armedTask(), run());
    await initScheduler(deps());
    const el = await open();
    const stop = el.querySelector<HTMLButtonElement>('[data-testid="schedule-result-on-its-own"] button');
    await act(async () => {
      stop?.focus();
      stop?.click();
    });
    await vi.waitFor(() => expect(db.getScheduledTask('t1')?.writeAuthority).toBeUndefined());
    await settle();
    const status = [...el.querySelectorAll<HTMLElement>('[role="status"]')].find((node) => node.textContent === ROW.stoppedOnItsOwn);
    expect(status, 'the outcome line').toBeDefined();
    expect(document.activeElement, 'focus moves to the outcome line, never to <body>').toBe(status);
  });
});

describe('PR-4 Gate-5 U14 — the held *full* names the live count; the capped line names the limit', () => {
  it('a *full* item reads the task bucket’s live count at render — 3, not the cap', async () => {
    for (const id of ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c']) db.putOwnUndo('ledger', 't1', taskEntry(id, 1));
    seed(armedTask(), run({ proposals: heldBatch('full') }));
    await initScheduler(deps());
    const el = await open();
    const full = HELD_WHY.full as (appName: string, live: number) => string;
    expect(el.querySelector('[data-testid="schedule-change-held"]')?.textContent).toBe(full('Ledger', 3));
    expect(el.querySelector('[data-testid="schedule-change-held"]')?.textContent).toContain('3 earlier changes');
  });

  it('a run capped by the NETWORK limit says the network limit — never the AI one', async () => {
    seed(task(), run({ status: 'capped', reason: capped('network call'), steps: [{ status: 'refused' }] }));
    await initScheduler(deps());
    const el = await open();
    const card = el.querySelector('[data-testid="schedule-result-capped"]');
    expect(card?.textContent).toContain(capped('network call'));
    expect(card?.textContent).not.toContain('AI call');
  });

  it('…and a run capped by the AI limit says the AI one (the twin)', async () => {
    seed(task(), run({ status: 'capped', reason: capped('AI call'), steps: [{ status: 'refused' }] }));
    await initScheduler(deps());
    const el = await open();
    expect(el.querySelector('[data-testid="schedule-result-capped"]')?.textContent).toContain(capped('AI call'));
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-5 (AC39b; contract v2 D-PR5-19; D11). An *ask* step that fetched new
// data first says so in its ONE host line: the NEW internal step-result seat `fetched` (≤ 8 entries,
// `{source ≤ 64, outcome: 'fresh' | 'recent' | 'failed' | 'skipped' | 'none'}`) is rendered by
// `fetchedFact` inside `stepFacts`, from `access/copy.ts` `FETCH_FIRST`'s words (never respelled);
// `none` → *didn’t fetch first — no app lets <App> ask for new data any more*. The AI's `summary` is
// never rewritten.
// ---------------------------------------------------------------------------------------------

describe('PR-5 D-PR5-19 — the `fetched` seat in stepFacts (fetchedFact)', () => {
  const NAMES = { app: 'Budget', connection: (slot: string) => slot };
  const BUDGET_THINK: ScheduleStep = { kind: 'app-think', appId: 'budget', prompt: 'sum it', context: { maxRows: 50 } };
  const factsOf = (fetched: Array<{ source: string; outcome: string }>): string => stepFacts(BUDGET_THINK, { status: 'ok', summary: 'fine', fetched } as never, NAMES) ?? '';
  const word = (value: unknown, ...args: unknown[]): string => (typeof value === 'function' ? (value as (...a: unknown[]) => string)(...args) : String(value));

  it('fresh → FETCH_FIRST.done(source), joined to the where-fact by a middle dot', () => {
    const line = factsOf([{ source: 'Ledger', outcome: 'fresh' }]);
    expect(line).toContain(FETCH_FIRST.done('Ledger'));
    expect(line).toContain('Snug did this itself — Budget didn’t open');
    expect(line.split(' · ').length).toBeGreaterThanOrEqual(2);
  });

  it('failed → FETCH_FIRST.failed(source)', () => {
    expect(factsOf([{ source: 'Ledger', outcome: 'failed' }])).toContain(FETCH_FIRST.failed('Ledger'));
  });

  it('skipped → FETCH_FIRST.skipped', () => {
    expect(factsOf([{ source: 'Pantry', outcome: 'skipped' }])).toContain(word(FETCH_FIRST.skipped, 'Pantry'));
  });

  it('none → *didn’t fetch first — no app lets Budget ask for new data any more* (the step’s own app named)', () => {
    expect(factsOf([{ source: 'Budget', outcome: 'none' }])).toContain('didn’t fetch first — no app lets Budget ask for new data any more');
  });

  it('two sources → each said', () => {
    const line = factsOf([
      { source: 'Ledger', outcome: 'fresh' },
      { source: 'Pantry', outcome: 'failed' },
    ]);
    expect(line).toContain(FETCH_FIRST.done('Ledger'));
    expect(line).toContain(FETCH_FIRST.failed('Pantry'));
  });

  it('GUARD: no `fetched` seat → the line is exactly what it was', () => {
    expect(stepFacts(BUDGET_THINK, { status: 'ok', summary: 'fine' }, NAMES)).toBe('Snug did this itself — Budget didn’t open');
  });

  it('on the page: the step’s facts carry the fetch, and the AI’s summary is shown unchanged', async () => {
    seed(task(), run({ steps: [{ status: 'ok', summary: 'Coffee came to 9.50 this week.', fetched: [{ source: 'Pantry', outcome: 'fresh' }] } as never] }));
    await initScheduler(deps());
    const el = await open();
    const facts = [...el.querySelectorAll('[data-testid="schedule-result-step-facts"]')].map((n) => n.textContent ?? '');
    expect(facts[0]).toContain(FETCH_FIRST.done('Pantry'));
    expect(el.textContent).toContain('Coffee came to 9.50 this week.');
  });
});
