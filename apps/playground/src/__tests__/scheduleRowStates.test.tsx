// scheduleRowStates.test.tsx — TASK-20261009-scheduling-framework U7 (ADR-0072 §4, ADR-0074
// §5–§6): the row-state helpers. A step whose app THIS host cannot run is blocked with the
// availability derivation's reason (never a `kind` check); a step whose app was deleted says so
// and offers *remove step*; a schedule the engine paused says why, with the count it hit, and
// offers *resume*; an imported schedule says review. The pieces are pure, so each is pinned
// on its inputs; the tiny components are mounted once each to prove the act fires.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ConnectionRequirement, ScheduleStep } from '@snugprotocol/protocol';

import { HOST_OFFERS, type AppNeed } from '../platform/availability.js';
import { appMissing, blockedHere, imported, paused } from '../schedule/copy.js';
import {
  AppMissingNote,
  BlockedStepNote,
  PausedRow,
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
