// missedCard.test.tsx — TASK-20261009-scheduling-framework U4 (ADR-0074 §5; design F5): the
// catch-up card over a REAL engine. One line with the count and the AI calls; details are
// per-schedule rows with the plain-words when, "missed 4 times → runs once", the cost, run now
// / skip; *run them* shows "running i of n…" + cancel, then per-row done/failed until *ok*;
// *skip* (all) waits out a short delay with *undo* — a skip is otherwise permanent; focus moves
// to the page heading when the card leaves; an unanswered card does not count as unseen.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StepOutcome } from '../schedule/engine-types.js';
import { MISSED_ACTIONS, missedHeadline, missedRow, runningProgress } from '../schedule/copy.js';
import { MISSED, aiCallsWord } from '../schedule/copy.page.js';
import { describeSpec } from '../schedule/cron.js';
import { MissedCard, SKIP_UNDO_MS } from '../schedule/MissedCard.js';
import { schedulerStore } from '../schedule/scheduler.js';
import { HOUR, NOW, THINK, click, iso, makeRun, makeTask, mount, settle, settleUntil, setupEnv, teardownEnv, texts, unmount, type Env } from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

let env: Env;
/** The executor's gates: each call parks until the test lets it through. */
let gates: Array<(outcome?: StepOutcome) => void> = [];

const OK: StepOutcome = { status: 'ok', summary: 'done', calls: { ai: 0, net: 0 } };

beforeEach(async () => {
  gates = [];
  env = await setupEnv(
    () =>
      new Promise<StepOutcome>((resolve) => {
        gates.push((outcome = OK) => resolve(outcome));
      }),
  );
  env.db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
  env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
  env.db.putScheduledTask(makeTask({ id: 't2', title: 'Spend', steps: [THINK(), THINK()], appVersions: { ledger: 1 } }));
  env.db.putScheduledTask(makeTask({ id: 't3', title: 'Review', steps: [THINK()], appVersions: { ledger: 1 } }));
  env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - 2 * HOUR), status: 'pending', trigger: 'catch-up', collapsedCount: 4 }));
  env.db.putScheduleRun(makeRun({ taskId: 't2', dueAt: iso(NOW - HOUR), status: 'pending', trigger: 'catch-up' }));
  env.db.putScheduleRun(makeRun({ taskId: 't3', dueAt: iso(NOW - 3 * HOUR), status: 'pending', trigger: 'catch-up' }));
});

afterEach(() => {
  unmount();
  teardownEnv();
});

function render(undoMs = 40): HTMLDivElement {
  return mount(
    <>
      <h1>your apps</h1>
      <MissedCard undoMs={undoMs} />
    </>,
  );
}

const byTestId = (c: HTMLElement, id: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (c: HTMLElement, id: string): HTMLElement[] => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const pendingCount = (): number => Object.values(env.db.listAllScheduleRuns()).flat().filter((run) => run.status === 'pending').length;
const release = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await settleUntil(() => gates.length > 0, 'an executor call to release');
    const gate = gates.shift();
    await act(async () => {
      gate?.();
    });
    await settle(2);
  }
};

describe('the one line (U4)', () => {
  it('renders nothing before the engine is ready, then the headline with the count and the AI calls, as a polite status', async () => {
    const c = render();
    expect(byTestId(c, 'missed-card')).toBeNull();
    await env.boot();
    await settle();
    const card = byTestId(c, 'missed-card');
    expect(card?.getAttribute('role')).toBe('status');
    expect(card?.getAttribute('aria-live')).toBe('polite');
    expect(byTestId(c, 'missed-headline')?.textContent).toBe(missedHeadline(3, 3));
    expect(byTestId(c, 'missed-headline')?.textContent).toBe('3 schedules were missed while Snug was closed · 3 AI calls');
    expect(texts(card!, '.connection-note-actions button')).toEqual([MISSED_ACTIONS.runAll, MISSED_ACTIONS.skipAll, MISSED_ACTIONS.details]);
    expect(SKIP_UNDO_MS).toBe(5000);
  });

  it('an unanswered card is not an unseen result: nothing counts toward the ignored pause', async () => {
    await env.boot();
    render();
    await settle();
    expect(schedulerStore.get().pending).toBe(3);
    expect(schedulerStore.get().unseen).toBe(0);
    expect(env.db.listScheduledTasks().map((item) => item.unseenResults)).toEqual([0, 0, 0]);
  });
});

describe('details', () => {
  it('per-schedule rows, oldest due first: the when, "missed N times → runs once", the cost, run now / skip', async () => {
    await env.boot();
    const c = render();
    await settle();
    await click(byTestId(c, 'missed-details'));
    const rows = all(c, 'missed-row');
    expect(rows.map((row) => row.querySelector('.missed-row-title')?.textContent)).toEqual(['Review', 'Hourly', 'Spend']);
    const hourly = rows[1]!;
    expect(hourly.querySelector('.missed-row-when')?.textContent).toBe(missedRow(describeSpec({ kind: 'every', n: 1, unit: 'hours', tz: 'UTC' }), 4));
    expect(hourly.querySelector('.missed-row-when')?.textContent).toBe('Every hour · missed 4 times → runs once');
    expect(hourly.querySelector('.missed-row-cost')?.textContent).toBe(aiCallsWord(0));
    expect(rows[2]!.querySelector('.missed-row-when')?.textContent).toBe('Every hour · missed once');
    expect(rows[2]!.querySelector('.missed-row-cost')?.textContent).toBe('2 AI calls');
    expect(texts(hourly, 'button')).toEqual([MISSED_ACTIONS.run, MISSED_ACTIONS.skip]);
  });

  it('run now runs that one candidate (once, collapsed); skip writes that one as skipped — permanent', async () => {
    await env.boot();
    const c = render();
    await settle();
    await click(byTestId(c, 'missed-details'));
    await click(all(c, 'missed-row-run')[1]); // Hourly, collapsed ×4
    await release(1);
    await settleUntil(() => env.db.listScheduleRuns('t1')[0]?.status === 'ok', 'Hourly ran');
    expect(env.rec.calls.filter((call) => call.ctx.task.id === 't1')).toHaveLength(1);
    expect(env.db.listScheduleRuns('t1')[0]).toMatchObject({ trigger: 'catch-up', collapsedCount: 4, status: 'ok' });
    expect(byTestId(c, 'missed-headline')?.textContent).toBe(missedHeadline(2, 3));
    await click(all(c, 'missed-row-skip')[1]); // Spend (Review, Spend remain)
    await settleUntil(() => env.db.listScheduleRuns('t2')[0]?.status === 'skipped', 'Spend skipped');
    expect(env.db.listScheduleRuns('t2')[0]).toMatchObject({ status: 'skipped', reason: 'user' });
    expect(byTestId(c, 'missed-headline')?.textContent).toBe(missedHeadline(1, 1));
  });
});

describe('run them', () => {
  it('queues every candidate: "running i of n…" + cancel while they run, then each row’s outcome until ok — and focus moves to the heading when the card leaves', async () => {
    await env.boot();
    const c = render();
    await settle();
    await click(byTestId(c, 'missed-run-all'));
    await settleUntil(() => byTestId(c, 'missed-progress') !== null, 'the progress line');
    expect(byTestId(c, 'missed-progress')?.textContent).toContain(runningProgress(1, 3));
    expect(byTestId(c, 'missed-cancel')?.textContent).toBe(MISSED_ACTIONS.cancel);
    // The queue runs in the file's order — Hourly (one step), Spend (two), Review (one) — while
    // the card lists oldest-due first; the counter follows the queue, the rows the card.
    await release(1); // Hourly
    await settleUntil(() => byTestId(c, 'missed-progress')?.textContent?.includes(runningProgress(2, 3)) === true, 'running 2 of 3');
    await release(2); // Spend
    await settleUntil(() => byTestId(c, 'missed-progress')?.textContent?.includes(runningProgress(3, 3)) === true, 'running 3 of 3');
    await release(1); // Review
    await settleUntil(() => byTestId(c, 'missed-outcomes') !== null, 'the outcomes');
    const outcomes = all(c, 'missed-outcome');
    expect(outcomes.map((row) => row.querySelector('.missed-row-title')?.textContent)).toEqual(['Review', 'Hourly', 'Spend']);
    expect(outcomes.map((row) => row.querySelector('.missed-row-outcome')?.textContent)).toEqual([MISSED.done, MISSED.done, MISSED.done]);
    expect(pendingCount()).toBe(0);
    await click(byTestId(c, 'missed-ok'));
    expect(byTestId(c, 'missed-card')).toBeNull();
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('cancel interrupts the one in flight; the rest still run; the outcomes say so per row', async () => {
    await env.boot();
    const c = render();
    await settle();
    await click(byTestId(c, 'missed-run-all'));
    await settleUntil(() => gates.length > 0, 'the first executor call');
    await click(byTestId(c, 'missed-cancel'));
    // The queue does not race the executor: the aborted call answers, then the run folds to `interrupted`.
    await release(1); // Hourly, aborted
    await settleUntil(() => env.db.listScheduleRuns('t1')[0]?.status === 'interrupted', 'Hourly interrupted');
    expect(env.db.listScheduleRuns('t1')[0]).toMatchObject({ status: 'interrupted', reason: 'cancelled' });
    await release(2); // Spend
    await release(1); // Review
    await settleUntil(() => byTestId(c, 'missed-outcomes') !== null, 'the outcomes');
    expect(all(c, 'missed-outcome').map((row) => row.querySelector('.missed-row-outcome')?.textContent)).toEqual([MISSED.done, 'interrupted', MISSED.done]);
  });

  it('a failed run reads "failed" in its row', async () => {
    await env.boot();
    const c = render();
    await settle();
    await click(byTestId(c, 'missed-run-all'));
    await settleUntil(() => gates.length > 0, 'the first executor call');
    await act(async () => {
      gates.shift()?.({ status: 'failed', summary: 'no brain', calls: { ai: 0, net: 0 } });
    });
    await release(2); // Spend
    await release(1); // Review
    await settleUntil(() => byTestId(c, 'missed-outcomes') !== null, 'the outcomes');
    expect(all(c, 'missed-outcome').map((row) => row.querySelector('.missed-row-outcome')?.textContent)).toEqual([MISSED.done, 'failed', MISSED.done]);
  });
});

describe('skip all, with undo', () => {
  it('skip waits out the delay with an undo; undo keeps every candidate; letting it run out skips them all and the card leaves (focus to the heading)', async () => {
    await env.boot();
    const c = render(40);
    await settle();
    await click(byTestId(c, 'missed-skip-all'));
    const strip = byTestId(c, 'missed-undo');
    expect(strip?.textContent).toContain(MISSED.skippingSoon(3));
    expect(byTestId(c, 'missed-undo-act')?.textContent).toBe(MISSED_ACTIONS.undo);
    await click(byTestId(c, 'missed-undo-act'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(pendingCount(), 'undo kept every candidate').toBe(3);
    expect(byTestId(c, 'missed-headline')?.textContent).toBe(missedHeadline(3, 3));
    await click(byTestId(c, 'missed-skip-all'));
    await settleUntil(() => pendingCount() === 0, 'the delay ran out and the skip landed');
    await settle();
    expect(Object.values(env.db.listAllScheduleRuns()).flat().map((run) => run.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(Object.values(env.db.listAllScheduleRuns()).flat().every((run) => run.reason === 'user')).toBe(true);
    expect(byTestId(c, 'missed-card')).toBeNull();
    expect(document.activeElement?.tagName).toBe('H1');
    expect(env.rec.calls).toHaveLength(0);
  });

  it('leaving the page during the delay keeps the decision: the skip lands at unmount', async () => {
    await env.boot();
    const c = render(60_000);
    await settle();
    await click(byTestId(c, 'missed-skip-all'));
    expect(pendingCount()).toBe(3);
    unmount();
    await settleUntil(() => pendingCount() === 0, 'the skip landed on unmount');
  });
});
