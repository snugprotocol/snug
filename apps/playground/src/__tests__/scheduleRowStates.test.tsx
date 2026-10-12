// scheduleRowStates.test.tsx — TASK-20261009-scheduling-framework U7 (ADR-0072 §4, ADR-0074
// §5–§6): the row-state helpers. A step whose app THIS host cannot run is blocked with the
// availability derivation's reason (never a `kind` check); a step whose app was deleted says so
// and offers *remove step*; a schedule the engine paused says why, with the count it hit, and
// offers *resume*; an imported schedule says review. The pieces are pure, so each is pinned
// on its inputs; the tiny components are mounted once each to prove the act fires.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ConnectionRequirement, ScheduleStep, ScheduledTask } from '@snugprotocol/protocol';

import { HOST_OFFERS, type AppNeed } from '../platform/availability.js';
import { appMissing, blockedHere, imported, paused } from '../schedule/copy.js';
import { RELOAD, ROW } from '../schedule/copy.page.js';
import {
  AppMissingNote,
  BlockedStepNote,
  PausedRow,
  ReloadNote,
  ResultStatus,
  StatusDot,
  StepStatus,
  Switch,
  appMissingNote,
  appNeedsOf,
  pausedRow,
  rowState,
  stepAvailability,
  type AppName,
} from '../schedule/ScheduleStates.js';
import { ScheduleView } from '../views/ScheduleView.js';
import * as harness from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APPS: readonly AppName[] = [
  { appId: 'ledger', displayName: 'Ledger' },
  { appId: 'hue', displayName: 'Hue' },
];

const NOTIFY: ScheduleStep = { kind: 'notify', title: 'Water', body: 'the ferns' };
const THINK_LEDGER: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } };
const RUN_HUE: ScheduleStep = { kind: 'app-run', appId: 'hue' };
const RUN_GONE: ScheduleStep = { kind: 'app-run', appId: 'gone' };

const needs = (entries: Record<string, readonly AppNeed[]>): ReadonlyMap<string, readonly AppNeed[]> => new Map(Object.entries(entries));

const PAUSE_BASE = { consecutiveFailures: 0, unseenResults: 0 } as const;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe('stepAvailability — through the availability derivation, never a kind check', () => {
  it('a remind-me step always runs here', () => {
    expect(stepAvailability(NOTIFY, [], { needs: needs({}), offers: HOST_OFFERS.web })).toEqual({ ok: true });
  });

  it('an app step whose every need this host offers runs here', () => {
    expect(stepAvailability(THINK_LEDGER, APPS, { needs: needs({ ledger: ['network'] }), offers: HOST_OFFERS.web })).toEqual({ ok: true });
  });

  it('an app this host cannot run is blocked with the first blocker’s reason, in copy.ts’s words', () => {
    const verdict = stepAvailability(RUN_HUE, APPS, { needs: needs({ hue: ['lan'] }), offers: HOST_OFFERS.web });
    expect(verdict).toEqual({ ok: false, blocked: blockedHere('it needs your home network').text });
    expect(verdict.ok ? '' : verdict.blocked).toBe('not available in this host — it needs your home network');
  });

  it('the same app on the desktop, which offers the LAN seat, runs', () => {
    expect(stepAvailability(RUN_HUE, APPS, { needs: needs({ hue: ['lan'] }), offers: HOST_OFFERS.desktop })).toEqual({ ok: true });
  });

  it('a step whose app is gone from the file is blocked with the deleted sentence', () => {
    expect(stepAvailability(RUN_GONE, APPS, { needs: needs({}), offers: HOST_OFFERS.desktop })).toEqual({ ok: false, blocked: appMissing.text });
  });

  it('a host that is only missing a need the app does not have does not block it', () => {
    expect(stepAvailability(THINK_LEDGER, APPS, { needs: needs({ hue: ['lan'] }), offers: HOST_OFFERS.web })).toEqual({ ok: true });
  });
});

describe('appNeedsOf — the hub’s own derivation over the connections table', () => {
  it('groups rows per app and reads each app’s needs; an app with no rows has no entry', () => {
    const lanHost = { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' } as const;
    const hue = { slot: 'hue', provider: { name: 'Philips Hue' }, kind: 'api_key', lanHost } as unknown as ConnectionRequirement;
    const phone = { slot: 'wa', provider: { name: 'WhatsApp' }, kind: 'linked_device' } as unknown as ConnectionRequirement;
    const db = {
      listConnections: () => [
        { appId: 'hue', slot: 'hue', status: 'declared', requirement: hue },
        { appId: 'chat', slot: 'wa', status: 'approved', requirement: phone },
        { appId: 'old', slot: 'x', status: 'revoked', requirement: phone },
      ],
      getSecret: () => undefined,
      listSecretKeys: () => [],
    } as unknown as Pick<UserDb, 'listConnections' | 'getSecret' | 'listSecretKeys'>;
    const map = appNeedsOf(db);
    expect(map.get('hue')).toEqual(['lan']);
    expect(map.get('chat')).toEqual(['helper']);
    expect(map.get('old')).toEqual([]);
    expect(map.get('ledger')).toBeUndefined();
  });
});

describe('appMissingNote', () => {
  it('answers copy.appMissing for a step whose app is gone, nothing for a present app or a remind-me step', () => {
    expect(appMissingNote(RUN_GONE, APPS)).toEqual(appMissing);
    expect(appMissingNote(RUN_HUE, APPS)).toBeUndefined();
    expect(appMissingNote(NOTIFY, [])).toBeUndefined();
  });

  it('the note renders the sentence and "remove step" fires the callback', () => {
    const onRemove = vi.fn();
    const el = render(<AppMissingNote onRemove={onRemove} />);
    expect(el.textContent).toContain('this app was deleted');
    const button = el.querySelector('button');
    expect(button?.textContent).toBe('remove step');
    act(() => button?.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe('pausedRow / rowState (E7, E8, C4)', () => {
  it('failures: the count the engine hit; the default when the row carries none', () => {
    expect(pausedRow({ ...PAUSE_BASE, pausedReason: 'failures', consecutiveFailures: 3 })).toEqual(paused('failures', 3));
    expect(pausedRow({ ...PAUSE_BASE, pausedReason: 'failures' })).toEqual(paused('failures'));
    expect(pausedRow({ ...PAUSE_BASE, pausedReason: 'failures', consecutiveFailures: 3 })?.text).toBe('paused: 3 failures in a row');
  });

  it('ignored: the unseen count; app-updated: no count', () => {
    expect(pausedRow({ ...PAUSE_BASE, pausedReason: 'ignored', unseenResults: 12 })).toEqual(paused('ignored', 12));
    expect(pausedRow({ ...PAUSE_BASE, pausedReason: 'app-updated', unseenResults: 4 })).toEqual(paused('app-updated'));
  });

  it('not paused by the engine: nothing', () => {
    expect(pausedRow(PAUSE_BASE)).toBeUndefined();
  });

  it('rowState: paused wins; an imported schedule that is off says review; an enabled one says nothing', () => {
    expect(rowState({ ...PAUSE_BASE, pausedReason: 'failures', provenance: 'imported', enabled: false })).toEqual(paused('failures'));
    expect(rowState({ ...PAUSE_BASE, provenance: 'imported', enabled: false })).toEqual(imported);
    expect(rowState({ ...PAUSE_BASE, provenance: 'imported', enabled: true })).toBeUndefined();
    expect(rowState({ ...PAUSE_BASE, provenance: 'user', enabled: false })).toBeUndefined();
  });

  it('PausedRow renders the reason and "resume" fires; renders nothing when not paused', () => {
    const onResume = vi.fn();
    const el = render(<PausedRow task={{ ...PAUSE_BASE, pausedReason: 'ignored', unseenResults: 30 }} onResume={onResume} />);
    expect(el.textContent).toContain('paused: nobody opened 30 results');
    const button = el.querySelector('button');
    expect(button?.textContent).toBe('resume');
    act(() => button?.click());
    expect(onResume).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = undefined;
    const none = render(<PausedRow task={PAUSE_BASE} onResume={onResume} />);
    expect(none.innerHTML).toBe('');
  });
});

describe('the tiny components', () => {
  it('BlockedStepNote: the reason, no act', () => {
    const el = render(<BlockedStepNote reason={blockedHere('it needs your home network').text} />);
    expect(el.textContent).toBe('not available in this host — it needs your home network');
    expect(el.querySelector('button')).toBeNull();
  });

  it('StatusDot pairs an aria-hidden dot with a visible word; ResultStatus and StepStatus pick the word per status', () => {
    const el = render(
      <>
        <StatusDot tone="ok" word="done" />
        <ResultStatus status="needs-you" />
        <StepStatus status="refused" />
      </>,
    );
    const dots = [...el.querySelectorAll('[data-testid="schedule-status"]')];
    expect(dots.map((dot) => dot.textContent)).toEqual(['done', 'needs you', 'refused']);
    for (const dot of dots) expect(dot.querySelector('.schedule-status-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(dots[0]?.className).toContain('is-ok');
    expect(dots[1]?.className).toContain('is-warn');
  });

  it('ReloadNote (S3): one line, one act — the sentence from copy.page, and the act reloads', () => {
    const reload = vi.fn();
    const el = render(<ReloadNote reload={reload} />);
    const note = el.querySelector('[data-testid="schedule-reload"]');
    expect(note?.className).toContain('connection-note');
    expect(note?.getAttribute('role')).toBe('status');
    expect(note?.textContent).toContain(RELOAD.note);
    expect(RELOAD.note).toBe('another tab was running your schedules — reload to continue here');
    const button = el.querySelector<HTMLButtonElement>('[data-testid="schedule-reload-act"]');
    expect(button?.textContent).toBe(RELOAD.act);
    expect(RELOAD.act).toBe('reload');
    act(() => button?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('Switch is a role=switch named by its label, flipping aria-checked through onChange', () => {
    const onChange = vi.fn();
    const el = render(
      <>
        <span id="lbl">pause all schedules</span>
        <Switch checked={false} onChange={onChange} labelledBy="lbl" />
      </>,
    );
    const toggle = el.querySelector('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(toggle?.getAttribute('aria-labelledby')).toBe('lbl');
    expect(toggle?.textContent).toBe('off');
    act(() => (toggle as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 — the row shows the authority wherever the task is (D-PR4-8,
// D-PR4-10, D-PR4-18; D5, D6). Line 2 gains the chip *makes changes on its own* (a glyph whose
// accessible name is the words; the words on a wide screen); the kebab gains *stop making changes
// on its own* on an armed task, whose outcome is *it won’t change data on its own any more — turn
// it back on from edit*; a disarm the user did NOT perform leaves the attention line *no longer
// makes changes on its own — arrived with an imported file | this app was updated* with the one act
// *review*; on a task that was armed, `paused('app-updated')` reads *…resuming won’t let it make
// changes on its own until you confirm again*; the delete confirm of a schedule whose changes can
// still be undone says they can’t be after this.
//
// Over the REAL engine and memory db (`scheduleUiHarness`), the Date faked at the harness's NOW so
// the own-undo journal's liveness (the db's clock) and the page's clock agree — no fixture is
// seeded at a fixed instant against the wall clock.
//
// Assumed (lane T-C questions): the chip `schedule-on-its-own-chip`; the act's outcome line
// `schedule-row-outcome`; the own-undo journal is the UserDb accessor `putOwnUndo(appId, bucket, entry)`
// with the task's id as its bucket.
// =============================================================================================

const ON_ITS_OWN = 'makes changes on its own';
const STOP = 'stop making changes on its own';
const STOPPED = 'it won’t change data on its own any more — turn it back on from edit';
const ARMED_AT = '2026-10-08T09:00:00.000Z';
const UNDO_ID = '3b2a1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('PR-4 — pausedRow on a schedule that WAS armed (D-PR4-8; D6)', () => {
  it('paused by an app update with the disarm trace: the armed copy, resume still the one act', () => {
    const row = pausedRow({ ...PAUSE_BASE, pausedReason: 'app-updated', disarmed: { reason: 'app-updated', at: ARMED_AT } } as Parameters<typeof pausedRow>[0]);
    expect(row).toEqual({ text: 'paused: this app was updated — resuming won’t let it make changes on its own until you confirm again', action: 'resume' });
  });

  it('…and a schedule that never made changes on its own keeps the plain sentence (negative twin)', () => {
    expect(pausedRow({ ...PAUSE_BASE, pausedReason: 'app-updated' })).toEqual(paused('app-updated'));
  });
});

describe('PR-4 — the row: chip, act, attention, delete warning (D-PR4-8, D-PR4-10, D-PR4-18)', () => {
  let env: harness.Env;
  let path = '';

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: harness.NOW });
    env = await harness.setupEnv();
    env.db.installApp({ appId: 'ledger', displayName: 'Ledger', iconEmoji: '📒', html: '<html>ledger</html>', installSource: 'starter:ledger' });
    path = '';
  });

  afterEach(() => {
    harness.unmount();
    harness.teardownEnv();
    vi.useRealTimers();
  });

  const ask: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'tidy the categories', context: { maxRows: 50 } };
  const armedTask = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
    harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 }, writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 1 }, ...over } as Partial<ScheduledTask>);

  function render(): HTMLDivElement {
    return harness.mount(
      <MemoryRouter initialEntries={['/schedule']}>
        <Routes>
          <Route path="/schedule" element={<ScheduleView />} />
          <Route path="/schedule/:id" element={<harness.PathProbe onPath={(p) => (path = p)} />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  const rowEl = (c: HTMLElement): HTMLElement => c.querySelector<HTMLElement>('[data-schedule-id="t1"]')!;
  const menuItems = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('.schedule-menu-item')];

  it('an armed row’s line 2 carries the chip: a glyph whose accessible name is the words, the words beside it for a wide screen', async () => {
    env.db.putScheduledTask(armedTask());
    await env.boot();
    const c = render();
    await harness.settle();
    const chip = rowEl(c).querySelector('.schedule-row-line2 [data-testid="schedule-on-its-own-chip"]');
    expect(chip, 'the chip sits on line 2').not.toBeNull();
    expect(chip?.getAttribute('role')).toBe('img');
    expect(chip?.getAttribute('aria-label')).toBe(ON_ITS_OWN);
    expect(chip?.textContent).toContain(ON_ITS_OWN);
  });

  it('NEGATIVE: an unarmed row has no chip, and its kebab has no stop act (the four acts as before)', async () => {
    env.db.putScheduledTask(harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 } }));
    await env.boot();
    const c = render();
    await harness.settle();
    expect(rowEl(c).querySelector('[data-testid="schedule-on-its-own-chip"]')).toBeNull();
    await harness.click(rowEl(c).querySelector('[data-testid="schedule-kebab"]'));
    expect(menuItems(c).map((item) => item.textContent)).toEqual([ROW.runNow, ROW.edit, ROW.history, ROW.delete]);
  });

  it('the kebab’s *stop making changes on its own* clears the authority (no trace, still on) and says what happened, in the row', async () => {
    env.db.putScheduledTask(armedTask());
    await env.boot();
    const c = render();
    await harness.settle();
    await harness.click(rowEl(c).querySelector('[data-testid="schedule-kebab"]'));
    const stop = menuItems(c).find((item) => item.textContent === STOP);
    expect(stop, 'the act is in the menu').toBeDefined();
    await harness.click(stop);
    await harness.settleUntil(() => env.db.getScheduledTask('t1')?.writeAuthority === undefined, 'the authority cleared');
    const task = env.db.getScheduledTask('t1');
    expect(task?.disarmed, 'the user did this — no trace').toBeUndefined();
    expect(task?.enabled).toBe(true);
    const outcome = rowEl(c).querySelector('[data-testid="schedule-row-outcome"]');
    expect(outcome?.textContent).toBe(STOPPED);
    expect(outcome?.getAttribute('role')).toBe('status');
    expect(rowEl(c).querySelector('[data-testid="schedule-on-its-own-chip"]'), 'the chip goes with it').toBeNull();
  });

  it.each([
    ['imported', 'no longer makes changes on its own — arrived with an imported file'],
    ['app-updated', 'no longer makes changes on its own — this app was updated'],
  ] as const)('a disarm the user did not perform (%s) leaves the attention line with the one act *review*, which opens the editor', async (reason, text) => {
    env.db.putScheduledTask(harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 }, disarmed: { reason, at: ARMED_AT } } as Partial<ScheduledTask>));
    await env.boot();
    const c = render();
    await harness.settle();
    const attention = rowEl(c).querySelector('[data-testid="schedule-attention"]');
    expect(attention?.querySelector('span')?.textContent).toBe(text);
    const act1 = rowEl(c).querySelector('[data-testid="schedule-attention-act"]');
    expect(act1?.textContent).toBe('review');
    // sanctioned by PR-4 v2.2 note f — the group is read before the click navigates away from the list.
    expect(c.querySelector('[data-testid="schedule-group-attention"] [data-schedule-id="t1"]'), 'it sits under needs your attention').not.toBeNull();
    await harness.click(act1);
    expect(path).toBe('/schedule/t1');
  });

  it('paused by an app update on a schedule that was armed: the armed paused copy, resume the act', async () => {
    env.db.putScheduledTask(
      harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 }, enabled: false, pausedReason: 'app-updated', disarmed: { reason: 'app-updated', at: ARMED_AT } } as Partial<ScheduledTask>),
    );
    await env.boot();
    const c = render();
    await harness.settle();
    expect(rowEl(c).querySelector('[data-testid="schedule-attention"] span')?.textContent).toBe(
      'paused: this app was updated — resuming won’t let it make changes on its own until you confirm again',
    );
    expect(rowEl(c).querySelector('[data-testid="schedule-attention-act"]')?.textContent).toBe('resume');
  });

  it('the delete confirm of a schedule whose changes can still be undone says they can’t be after this; without any, it reads as before', async () => {
    env.db.putScheduledTask(armedTask());
    env.db.putOwnUndo('ledger', 't1', {
      id: UNDO_ID,
      at: harness.iso(harness.NOW - harness.HOUR),
      expiresAt: harness.iso(harness.NOW - harness.HOUR + 7 * harness.DAY),
      authority: 'task',
      via: 'schedule',
      runId: 'r-1',
      taskId: 't1',
      steps: [{ table: 'expenses', op: 'update', columns: ['cents'], rows: [{ rowid: 1, before: [450], after: [999] }] }],
    });
    await env.boot();
    const c = render();
    await harness.settle();
    await harness.click(rowEl(c).querySelector('[data-testid="schedule-kebab"]'));
    await harness.click(menuItems(c).find((item) => item.textContent === ROW.delete));
    const confirm = rowEl(c).querySelector('[role="group"]');
    expect(confirm?.textContent).toContain(ROW.deleteConfirm);
    expect(confirm?.textContent).toContain('— its changes from the last seven days can’t be undone after this');
  });

  it('NEGATIVE: a schedule with no live undo entry keeps the plain delete question', async () => {
    env.db.putScheduledTask(harness.makeTask({ id: 't1', title: 'Tidy', steps: [ask], appVersions: { ledger: 1 } }));
    await env.boot();
    const c = render();
    await harness.settle();
    await harness.click(rowEl(c).querySelector('[data-testid="schedule-kebab"]'));
    await harness.click(menuItems(c).find((item) => item.textContent === ROW.delete));
    expect(rowEl(c).querySelector('[role="group"]')?.textContent).not.toContain('can’t be undone');
  });
});
