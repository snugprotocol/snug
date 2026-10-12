// resultsList.test.tsx — TASK-20261010-host-broker PR-4 (D-PR4-18; design D8): HOST FACTS FOLLOW
// THE AI'S WORDS wherever a result's one line is printed. The line was the first step's AI summary
// alone (`ResultsList.resultSummary`, `ScheduleRow`'s history) — an AI that says "I updated your
// budget" when it only proposed, or that says nothing of the change an armed schedule made, read as
// the whole truth. Now the host appends its own facts (`resultFacts(run)`): *· changed 12 rows in
// Ledger on its own* for an applied group, *· 1 change waiting for your OK* for pending items — in
// the results feed, in the row's history, and in the notification body the host composes when the
// schedule's alert is `notification`. The AI's words come first and are never rewritten; a run with
// neither fact reads exactly as before.
//
// The pure half calls `resultSummary` directly; the feed mounts `ResultsList`; the history and the
// notification run over the REAL engine and memory db (`scheduleUiHarness`), the notification
// through the platform's scheduler seat with a recording `notify`.
//
// Assumed (lane T-C questions): the facts are separated from the AI's words by a single space
// (each fact opens with its own "· "); *on its own* is said of an applied group on a schedule that
// makes changes on its own; "change" pluralises as "changes".

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULE_PROPOSAL_TTL_MS, type ScheduleProposalItem, type ScheduleRun, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

import { RESULT_STATUS_WORD } from '../schedule/copy.js';
import { ROW } from '../schedule/copy.page.js';
import type { AppIndex } from '../schedule/pageModel.js';
import { ResultsList, resultSummary } from '../schedule/ResultsList.js';
import { runNow } from '../schedule/scheduler.js';
import { ScheduleView } from '../views/ScheduleView.js';
import * as harness from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

const SUMMARY = 'Coffee came to 9.50 this week.';
const SQL = "UPDATE expenses SET cents = 999 WHERE label = 'coffee'";
const UNDO_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ARMED = { rowsPerRun: 200, armedAt: '2026-10-08T09:00:00.000Z', armedVersion: 1 };
const ask: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } };

/** The page's clock for the pure calls — `resultFacts` reads a batch's expiry against it (PR-4 Gate-5 U10). */
const AT = new Date(harness.NOW);

const apps: AppIndex = { bySource: new Map(), ids: new Set(['ledger']), name: (appId) => (appId === 'ledger' ? 'Ledger' : appId), emoji: () => undefined };

const item = (over: Partial<ScheduledTask> = {}): ScheduledTask => harness.makeTask({ id: 't1', title: 'Spend', steps: [ask], appVersions: { ledger: 1 }, ...over });
const armedItem = (): ScheduledTask => item({ writeAuthority: ARMED } as Partial<ScheduledTask>);

/** A pending batch, live by the REAL clock (no fixed instant against the wall clock). */
const pending = (n: number): NonNullable<ScheduleRun['proposals']> => ({
  items: Array.from({ length: n }, (_, i): ScheduleProposalItem => ({ appId: 'ledger', sql: `${SQL} AND id = ${i + 1}`, counts: { changes: 1 } })),
  expiresAt: new Date(Date.now() + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
});
const appliedGroup = { appId: 'ledger', undoId: UNDO_ID, items: [{ changes: 12 }] };

const run = (over: Partial<ScheduleRun> & Record<string, unknown> = {}): ScheduleRun =>
  harness.makeRun({ taskId: 't1', dueAt: harness.iso(harness.NOW - harness.HOUR), status: 'ok', finishedAt: harness.iso(harness.NOW - harness.HOUR + 20_000), steps: [{ status: 'ok', summary: SUMMARY }], ...over } as Partial<ScheduleRun> &
    Pick<ScheduleRun, 'taskId' | 'dueAt' | 'status'>);

describe('resultSummary — the AI’s words, then the host’s facts (D-PR4-18; D8)', () => {
  it('an applied group: *· changed 12 rows in Ledger on its own* follows the AI’s words', () => {
    expect(resultSummary(run({ applied: appliedGroup }), armedItem(), apps, AT)).toBe(`${SUMMARY} · changed 12 rows in Ledger on its own`);
  });

  it('pending items: *· 1 change waiting for your OK*; two are *changes*', () => {
    expect(resultSummary(run({ proposals: pending(1) }), item(), apps, AT)).toBe(`${SUMMARY} · 1 change waiting for your OK`);
    expect(resultSummary(run({ proposals: pending(2) }), item(), apps, AT)).toBe(`${SUMMARY} · 2 changes waiting for your OK`);
  });

  it('both: what it made, then what waits', () => {
    expect(resultSummary(run({ applied: appliedGroup, proposals: pending(1) }), armedItem(), apps, AT)).toBe(`${SUMMARY} · changed 12 rows in Ledger on its own · 1 change waiting for your OK`);
  });

  it('the facts follow even when the AI said nothing — after the status’s own words', () => {
    expect(resultSummary(run({ steps: [{ status: 'ok' }], applied: appliedGroup }), armedItem(), apps, AT)).toBe(`${RESULT_STATUS_WORD.ok} · changed 12 rows in Ledger on its own`);
  });

  it('NEGATIVE: the AI’s own claim is never taken for a fact — an AI that says it changed rows, on a run that changed none, gets no host fact', () => {
    const claim = 'I updated 40 rows in your ledger.';
    expect(resultSummary(run({ steps: [{ status: 'ok', summary: claim }] }), item(), apps, AT)).toBe(claim);
  });

  it('NEGATIVE: a run with neither fact reads exactly as before', () => {
    expect(resultSummary(run(), item(), apps, AT)).toBe(SUMMARY);
  });
});

describe('the feed (ResultsList) prints the facts after the AI’s words', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  it('the row’s one line carries them', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const rows = [{ run: run({ applied: appliedGroup, proposals: pending(1), seenAt: harness.iso(harness.NOW) }), item: armedItem(), at: harness.iso(harness.NOW - harness.HOUR) }];
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ResultsList rows={rows} apps={apps} now={new Date(harness.NOW)} />
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('.schedule-result-summary')?.textContent).toBe(`${SUMMARY} · changed 12 rows in Ledger on its own · 1 change waiting for your OK`);
  });
});

describe('the row’s history and the notification body — over the real engine', () => {
  let env: harness.Env;

  beforeEach(async () => {
    env = await harness.setupEnv((step) => ({
      status: 'ok',
      summary: SUMMARY,
      calls: { ai: 1, net: 0 },
      ...(step.kind === 'app-think' ? { proposals: [{ appId: 'ledger', sql: SQL, counts: { changes: 2 } }], alert: { title: 'Spend', body: 'coffee is up' } } : {}),
    }));
    env.db.installApp({ appId: 'ledger', displayName: 'Ledger', iconEmoji: '📒', html: '<html>ledger</html>', installSource: 'starter:ledger' });
  });

  afterEach(() => {
    harness.unmount();
    harness.teardownEnv();
  });

  function render(): HTMLDivElement {
    return harness.mount(
      <MemoryRouter initialEntries={['/schedule']}>
        <Routes>
          <Route path="/schedule" element={<ScheduleView />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  async function historyOf(c: HTMLElement): Promise<string[]> {
    const row = c.querySelector<HTMLElement>('[data-schedule-id="t1"]')!;
    await harness.click(row.querySelector('[data-testid="schedule-kebab"]'));
    await harness.click([...row.querySelectorAll<HTMLElement>('.schedule-menu-item')].find((entry) => entry.textContent === ROW.history));
    return harness.texts(row, '.schedule-history-summary');
  }

  it('the history line of a run with pending items carries *· 1 change waiting for your OK* after the AI’s words', async () => {
    env.db.putScheduledTask(item());
    env.db.putScheduleRun(run({ proposals: pending(1) }));
    await env.boot();
    const c = render();
    await harness.settle();
    expect(await historyOf(c)).toEqual([`${SUMMARY} · 1 change waiting for your OK`]);
  });

  it('the history line of an armed schedule’s run that made changes says so', async () => {
    env.db.putScheduledTask(armedItem());
    env.db.putScheduleRun(run({ applied: appliedGroup }));
    await env.boot();
    const c = render();
    await harness.settle();
    expect(await historyOf(c)).toEqual([`${SUMMARY} · changed 12 rows in Ledger on its own`]);
  });

  it('NEGATIVE: a run with neither fact keeps its plain history line', async () => {
    env.db.putScheduledTask(item());
    env.db.putScheduleRun(run());
    await env.boot();
    const c = render();
    await harness.settle();
    expect(await historyOf(c)).toEqual([SUMMARY]);
  });

  it('a `notification` schedule’s notification body is host-composed with the facts — the app’s words first, then *· 1 change waiting for your OK*', async () => {
    const notify = vi.fn<(n: { title: string; body: string }) => Promise<'shown' | 'denied' | 'unavailable'>>(async () => 'shown');
    env.db.putScheduledTask(item({ alert: 'notification' }));
    await env.boot({ platform: () => ({ ...harness.WEB, scheduler: { wakeMode: 'page', hostLabel: 'this tab', notify } }) });
    const result = await runNow('t1');
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const shown = notify.mock.calls[0]![0];
    expect(shown.title, 'the title stays the host’s').toBe('Ledger');
    expect(shown.body.startsWith('Ledger: Spend — coffee is up')).toBe(true);
    expect(shown.body).toContain('· 1 change waiting for your OK');
  });

  it('NEGATIVE: an `inbox` schedule raises no notification for its facts', async () => {
    const notify = vi.fn<(n: { title: string; body: string }) => Promise<'shown' | 'denied' | 'unavailable'>>(async () => 'shown');
    env.db.putScheduledTask(item({ alert: 'inbox' }));
    await env.boot({ platform: () => ({ ...harness.WEB, scheduler: { wakeMode: 'page', hostLabel: 'this tab', notify } }) });
    await runNow('t1');
    await harness.settleUntil(() => env.db.listScheduleRuns('t1')[0]?.status === 'ok', 'the run finished');
    expect(notify).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 Gate 5 — U10: a batch counts as waiting only before its
// `expiresAt`, read against the clock the caller hands in (`resultFacts(run, appName, now)`,
// threaded through `resultSummary`, the row's history line and the notification). U13: the history
// line drops an empty words segment — never a leading ' · '.
//
// The expiry instants are relative to the harness's NOW and the pure calls pass NOW: an
// implementation that read the wall clock instead would call the "live" batch below expired (NOW is
// in the past), so the pin also proves the clock is the one handed in.
// =============================================================================================

describe('PR-4 Gate-5 U10 — an expired batch is not *waiting for your OK*', () => {
  const batchUntil = (expiresAtMs: number, n = 2): NonNullable<ScheduleRun['proposals']> => ({
    items: Array.from({ length: n }, (_, i): ScheduleProposalItem => ({ appId: 'ledger', sql: `${SQL} AND id = ${i + 1}`, counts: { changes: 1 } })),
    expiresAt: harness.iso(expiresAtMs),
  });

  it('expired before now: no waiting fact — the AI’s words alone', () => {
    expect(resultSummary(run({ proposals: batchUntil(harness.NOW - harness.HOUR) }), item(), apps, AT)).toBe(SUMMARY);
  });

  it('expiring exactly now is expired', () => {
    expect(resultSummary(run({ proposals: batchUntil(harness.NOW) }), item(), apps, AT)).toBe(SUMMARY);
  });

  it('still live at now: *· 2 changes waiting for your OK* (the clock is the one handed in, not the wall’s)', () => {
    expect(resultSummary(run({ proposals: batchUntil(harness.NOW + harness.HOUR) }), item(), apps, AT)).toBe(`${SUMMARY} · 2 changes waiting for your OK`);
  });

  it('an expired batch beside an applied group keeps the group’s fact only', () => {
    expect(resultSummary(run({ applied: appliedGroup, proposals: batchUntil(harness.NOW - harness.DAY) }), armedItem(), apps, AT)).toBe(`${SUMMARY} · changed 12 rows in Ledger on its own`);
  });

  describe('the feed', () => {
    let container: HTMLDivElement | undefined;
    let root: Root | undefined;

    afterEach(() => {
      act(() => root?.unmount());
      container?.remove();
      container = undefined;
      root = undefined;
    });

    it('the feed’s line reads the expiry against the feed’s `now`: expired says nothing waits, live says it does', async () => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      const rows = [
        { run: run({ id: 'r-expired', proposals: batchUntil(harness.NOW - harness.HOUR), seenAt: harness.iso(harness.NOW) }), item: item(), at: harness.iso(harness.NOW - 2 * harness.HOUR) },
        { run: run({ id: 'r-live', dueAt: harness.iso(harness.NOW - 30 * harness.MINUTE), proposals: batchUntil(harness.NOW + harness.HOUR), seenAt: harness.iso(harness.NOW) }), item: item(), at: harness.iso(harness.NOW - harness.HOUR) },
      ];
      await act(async () => {
        root!.render(
          <MemoryRouter>
            <ResultsList rows={rows} apps={apps} now={new Date(harness.NOW)} />
          </MemoryRouter>,
        );
      });
      const lines = [...container.querySelectorAll('.schedule-result-summary')].map((el) => el.textContent);
      expect(lines).toContain(SUMMARY);
      expect(lines).toContain(`${SUMMARY} · 2 changes waiting for your OK`);
      expect(lines.filter((line) => line?.includes('waiting for your OK'))).toHaveLength(1);
    });
  });
});

describe('PR-4 Gate-5 U10/U13 — the row’s history line, over the real engine', () => {
  let env: harness.Env;

  beforeEach(async () => {
    env = await harness.setupEnv();
    env.db.installApp({ appId: 'ledger', displayName: 'Ledger', iconEmoji: '📒', html: '<html>ledger</html>', installSource: 'starter:ledger' });
  });

  afterEach(() => {
    harness.unmount();
    harness.teardownEnv();
  });

  async function historyOf(c: HTMLElement): Promise<string[]> {
    const row = c.querySelector<HTMLElement>('[data-schedule-id="t1"]')!;
    await harness.click(row.querySelector('[data-testid="schedule-kebab"]'));
    await harness.click([...row.querySelectorAll<HTMLElement>('.schedule-menu-item')].find((entry) => entry.textContent === ROW.history));
    return harness.texts(row, '.schedule-history-summary');
  }

  function render(): HTMLDivElement {
    return harness.mount(
      <MemoryRouter initialEntries={['/schedule']}>
        <Routes>
          <Route path="/schedule" element={<ScheduleView />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('U10: a run whose batch expired (a day before NOW — past by the page’s clock and the wall’s) says nothing waits', async () => {
    env.db.putScheduledTask(item());
    env.db.putScheduleRun(run({ proposals: { items: [{ appId: 'ledger', sql: SQL, counts: { changes: 2 } }], expiresAt: harness.iso(harness.NOW - harness.DAY) } }));
    await env.boot();
    const c = render();
    await harness.settle();
    expect(await historyOf(c)).toEqual([SUMMARY]);
  });

  it('U13: a run whose first step said nothing (an empty summary) reads its facts with no leading “ · ”', async () => {
    env.db.putScheduledTask(armedItem());
    env.db.putScheduleRun(run({ steps: [{ status: 'ok', summary: '' }], applied: appliedGroup }));
    await env.boot();
    const c = render();
    await harness.settle();
    const lines = await historyOf(c);
    expect(lines).toEqual(['changed 12 rows in Ledger on its own']);
    expect(lines[0]?.startsWith(' · ')).toBe(false);
  });
});
