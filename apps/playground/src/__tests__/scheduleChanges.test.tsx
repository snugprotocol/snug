// scheduleChanges.test.tsx — TASK-20261010-host-broker PR-4 (D-PR4-18, D-PR4-3; design D2, the
// blocker): THE SCHEDULE'S CHANGES LIST. An armed schedule's own changes are journaled in its own
// bucket (`ownUndo:<appId>:<taskId>`), and an undo must stay findable for its whole seven days
// WHATEVER was pruned or cleared from the results — so the list is read from the journal
// (`listOwnUndo(appId, { taskId })`), never from the run rows, and sits at the TOP of the schedule's
// history (the row's menu *history*). Each entry reads *changed 12 rows in Ledger · 3 hours ago ·
// undo*; the undo is the result page's: an armed confirm (role="group" named by its question, focus
// to *keep*), then *yes, undo* puts the rows back and the outcome line takes the focus.
//
// Over the REAL engine and memory db (`scheduleUiHarness`), with a real Ledger table whose live rows
// are exactly what the seeded entry captured AFTER the change, so the undo's live re-validation
// passes and the rows really go back. The Date is faked at the harness's NOW so the journal's
// liveness (the db's clock) and the page's clock agree — no fixed instant against the wall clock.
//
// Assumed (lane T-C questions): the list `schedule-changes` inside `schedule-history`, its entries
// `schedule-changes-entry`; the relative time is the page's own `relativeTime` (the contract's
// "3 h ago" read as its example); the accessors `db.putOwnUndo(appId, bucket, entry)` /
// `db.listOwnUndo(appId, { taskId })`, a task's bucket being its id.

import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnUndoEntry, ScheduleStep, ScheduledTask } from '@snugprotocol/protocol';

import { ACCESS_SHEET, OWN_UNDO } from '../access/copy.js';
import { ROW } from '../schedule/copy.page.js';
import { relativeTime } from '../schedule/pageModel.js';
import { ScheduleView } from '../views/ScheduleView.js';
import { execFrame } from './dbFrames.js';
import * as harness from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

const ARMED_AT = '2026-10-08T09:00:00.000Z';
const ENTRY_T1 = '5c4b3a29-1807-4f6e-9d5c-4b3a29180706';
const ENTRY_T2 = '6d5c4b3a-2918-4a7f-8e6d-5c4b3a291807';
const ENTRY_APPROVAL = '7e6d5c4b-3a29-4b80-9f7e-6d5c4b3a2918';
const ENTRY_UNDONE = '8f7e6d5c-4b3a-4c91-a08f-7e6d5c4b3a29';
const ROWS = 12;

const ask: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'tidy the categories', context: { maxRows: 50 } };

let env: harness.Env;

const armedTask = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 }, writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 1 }, ...over } as Partial<ScheduledTask>);

/** An entry that changed `rows` coffees from 450 to 999 at `agoMs` before NOW, in `taskId`'s bucket. */
// sanctioned by PR-4 v2.2 note h — typed as the entry `putOwnUndo` takes, so the test tsc is clean.
function entry(id: string, over: Partial<OwnUndoEntry> = {}, rows = ROWS, agoMs = 3 * harness.HOUR): OwnUndoEntry {
  const at = harness.NOW - agoMs;
  return {
    id,
    at: harness.iso(at),
    expiresAt: harness.iso(at + 7 * harness.DAY),
    authority: 'task',
    via: 'schedule',
    runId: 'r-1',
    taskId: 't1',
    steps: [{ table: 'expenses', op: 'update', columns: ['cents'], rows: Array.from({ length: rows }, (_, i) => ({ rowid: i + 1, before: [450], after: [999] })) }],
    ...over,
  };
}

async function seedLedger(): Promise<void> {
  env.db.installApp({ appId: 'ledger', displayName: 'Ledger', iconEmoji: '📒', html: '<html>ledger</html>', installSource: 'starter:ledger' });
  await env.db.applyAppDdl('ledger', ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL)']);
  for (let id = 1; id <= ROWS; id++) {
    // The LIVE rows hold the values the entry captured AFTER its change.
    const result = await env.db.driver.handle('ledger', execFrame('INSERT INTO expenses (id, label, cents) VALUES (?, ?, ?)', [id, 'coffee', 999]));
    if (!result.ok) throw new Error('seed failed');
  }
}

async function cents(): Promise<unknown[]> {
  const result = await env.db.scratchRun('ledger', [{ sql: 'SELECT cents FROM expenses ORDER BY id' }]);
  return (result.statements[0]?.rows ?? []).map((row) => row[0]);
}

function render(): HTMLDivElement {
  return harness.mount(
    <MemoryRouter initialEntries={['/schedule']}>
      <Routes>
        <Route path="/schedule" element={<ScheduleView />} />
        <Route path="/schedule/:id" element={<span data-testid="editor-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openHistory(c: HTMLElement): Promise<HTMLElement> {
  const row = c.querySelector<HTMLElement>('[data-schedule-id="t1"]')!;
  await harness.click(row.querySelector('[data-testid="schedule-kebab"]'));
  await harness.click([...row.querySelectorAll<HTMLElement>('.schedule-menu-item')].find((item) => item.textContent === ROW.history));
  const history = row.querySelector<HTMLElement>('[data-testid="schedule-history"]');
  if (history === null) throw new Error('the history did not open');
  return history;
}

const entries = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[data-testid="schedule-changes-entry"]')];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: harness.NOW });
  env = await harness.setupEnv();
  await seedLedger();
});

afterEach(() => {
  harness.unmount();
  harness.teardownEnv();
  vi.useRealTimers();
});

describe('the schedule’s changes list — at the top of its history, read from its own bucket (D-PR4-18)', () => {
  it('each live entry reads *changed 12 rows in Ledger · <when> · undo*, above the results', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putScheduleRun(harness.makeRun({ taskId: 't1', dueAt: harness.iso(harness.NOW - 3 * harness.HOUR), status: 'ok', steps: [{ status: 'ok', summary: 'tidied' }] }));
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    await env.boot();
    const c = render();
    await harness.settle();
    const history = await openHistory(c);
    const list = history.querySelector('[data-testid="schedule-changes"]');
    expect(list, 'the list sits in the history view').not.toBeNull();
    const firstResult = history.querySelector('.schedule-history-entry');
    expect(firstResult, 'the results are still listed').not.toBeNull();
    expect(list!.compareDocumentPosition(firstResult!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the changes come first').toBeTruthy();
    const when = relativeTime(new Date(harness.NOW - 3 * harness.HOUR), new Date(harness.NOW));
    expect(entries(c).map((e) => e.textContent)).toEqual([`changed 12 rows in Ledger · ${when} · ${ACCESS_SHEET.undo}`]);
  });

  it('NEGATIVE: only THIS schedule’s bucket — another schedule’s entries and the user’s own approvals are not listed; an undone one is not live', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putScheduledTask(armedTask({ id: 't2', title: 'Other' }));
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    env.db.putOwnUndo('ledger', 't2', entry(ENTRY_T2, { taskId: 't2' }, 3));
    env.db.putOwnUndo('ledger', 'approval', entry(ENTRY_APPROVAL, { authority: 'approval', via: 'user', runId: undefined, taskId: undefined }, 4));
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_UNDONE, { undoneAt: harness.iso(harness.NOW - harness.HOUR) }, 5));
    await env.boot();
    const c = render();
    await harness.settle();
    await openHistory(c);
    expect(entries(c)).toHaveLength(1);
    expect(entries(c)[0]?.textContent).toContain('changed 12 rows in Ledger');
  });

  it('findable whatever was pruned or cleared: with NO result left, the history still lists the change and its undo', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    await env.boot();
    const c = render();
    await harness.settle();
    const history = await openHistory(c);
    expect(entries(c)).toHaveLength(1);
    expect(history.textContent).toContain(ROW.historyEmpty);
  });

  it('a schedule stopped from making changes still lists the changes it made — the stop never drops an undo', async () => {
    env.db.putScheduledTask(harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 } }));
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    await env.boot();
    const c = render();
    await harness.settle();
    await openHistory(c);
    expect(entries(c)).toHaveLength(1);
  });

  it('NEGATIVE: nothing in the bucket — no list, the history reads as before', async () => {
    env.db.putScheduledTask(armedTask());
    await env.boot();
    const c = render();
    await harness.settle();
    const history = await openHistory(c);
    expect(history.querySelector('[data-testid="schedule-changes"]')).toBeNull();
    expect(history.textContent).toBe(ROW.historyEmpty);
  });
});

describe('undo from the list — the result page’s armed confirm (D-PR4-18, D-PR4-19; D19)', () => {
  it('arms with focus on *keep* (role=group named by its question); *yes, undo* puts the 12 rows back, the entry reads undone and takes the focus', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    await env.boot();
    const c = render();
    await harness.settle();
    await openHistory(c);
    expect(await cents()).toEqual(Array(ROWS).fill(999));
    await harness.click(entries(c)[0]?.querySelector('button'));
    const question = OWN_UNDO.arm(12, 'Ledger');
    const confirm = c.querySelector(`[role="group"][aria-label="${question}"]`);
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain(question);
    expect(document.activeElement?.textContent).toBe(ACCESS_SHEET.undoKeep);
    await harness.click([...(confirm?.querySelectorAll('button') ?? [])].find((b) => b.textContent === ACCESS_SHEET.undoYes));
    await vi.waitFor(async () => expect(await cents()).toEqual(Array(ROWS).fill(450)));
    await harness.settle();
    expect(c.textContent).toContain(ACCESS_SHEET.undone);
    expect(document.activeElement?.textContent ?? '').toContain(ACCESS_SHEET.undone);
    expect(env.db.listOwnUndo('ledger', { taskId: 't1' }), 'the entry is no longer live').toHaveLength(0);
  });

  it('*keep* backs out: nothing is undone and the entry still offers its undo', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    await env.boot();
    const c = render();
    await harness.settle();
    await openHistory(c);
    await harness.click(entries(c)[0]?.querySelector('button'));
    await harness.click([...c.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === ACCESS_SHEET.undoKeep));
    expect(c.querySelector('[role="group"]')).toBeNull();
    expect(await cents()).toEqual(Array(ROWS).fill(999));
    expect(entries(c)[0]?.querySelector('button')?.textContent).toBe(ACCESS_SHEET.undo);
  });

  it('a row someone changed since: nothing happens, and the outcome says so in the sheet’s words', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putOwnUndo('ledger', 't1', entry(ENTRY_T1));
    await env.db.driver.handle('ledger', execFrame('UPDATE expenses SET cents = 1 WHERE id = 1'));
    await env.boot();
    const c = render();
    await harness.settle();
    await openHistory(c);
    await harness.click(entries(c)[0]?.querySelector('button'));
    await act(async () => {
      [...c.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === ACCESS_SHEET.undoYes)?.click();
    });
    await harness.settle();
    expect(c.textContent).toContain("couldn't undo");
    expect((await cents())[1], 'nothing was put back').toBe(999);
  });
});
