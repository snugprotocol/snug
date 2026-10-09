// scheduleA11y.test.tsx — TASK-20261009-scheduling-framework U9: the result detail, the
// Settings card, the running chip, the chat offer and the row-state pieces, walked for the
// rules that are checkable in a DOM — every interactive control has an accessible name; a
// status is never colour alone (every dot carries its word); the running chip is a live
// `status`; `prefers-reduced-motion` is honoured in the sheet these pieces style; and the
// sheet is actually imported. Contrast in both themes is measured by the e2e screenshots, not
// here.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULE_PROPOSAL_TTL_MS, type ScheduleRun, type ScheduledTask } from '@snugprotocol/protocol';

import { ResultDetail } from '../schedule/ResultDetail.js';
import { RunningChip } from '../schedule/RunningChip.js';
import { ScheduleOffer } from '../schedule/ScheduleOffer.js';
import { ScheduleSettingsCard } from '../schedule/ScheduleSettingsCard.js';
import { AppMissingNote, BlockedStepNote, PausedRow, ResultStatus, Switch } from '../schedule/ScheduleStates.js';
import { __resetSchedulerForTests, initialSchedulerView, schedulerStore } from '../schedule/scheduler.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DUE = '2026-10-09T12:00:00.000Z';
const CREATED = '2026-10-01T00:00:00.000Z';

const task: ScheduledTask = {
  id: 't1',
  title: 'Weekly spend review',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [
    { kind: 'notify', title: 'Water', body: 'the ferns' },
    { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } },
  ],
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
};

const run: ScheduleRun = {
  id: 'r1',
  taskId: 't1',
  dueAt: DUE,
  trigger: 'due',
  collapsedCount: 1,
  status: 'needs-you',
  startedAt: DUE,
  finishedAt: '2026-10-09T12:00:20.000Z',
  host: { kind: 'web' },
  steps: [{ status: 'ok' }, { status: 'refused', summary: 'the AI would change rows' }],
  calls: { ai: 1, net: 0 },
  proposals: {
    items: [{ sql: "UPDATE expenses SET cents = 999 WHERE label = 'coffee'", summary: 'Set both coffees to 9.99', counts: { changes: 2 } }],
    expiresAt: new Date(Date.now() + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
  },
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return container;
}

/** The accessible name the way a reader computes it, simplified: aria-label, aria-labelledby, text, title. */
function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const names = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter((name) => name !== '');
    if (names.length > 0) return names.join(' ');
  }
  const text = el.textContent?.trim() ?? '';
  if (text) return text;
  return el.getAttribute('title')?.trim() ?? '';
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="switch"], [role="button"], [role="link"]';

function expectEveryControlNamed(el: HTMLElement): void {
  const controls = [...el.querySelectorAll(INTERACTIVE)];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(accessibleName(control), `${control.tagName.toLowerCase()} ${control.className} has no accessible name`).not.toBe('');
  }
}

function expectStatusNeverColourAlone(el: HTMLElement): void {
  const dots = [...el.querySelectorAll('[data-testid="schedule-status"]')];
  expect(dots.length).toBeGreaterThan(0);
  for (const dot of dots) {
    const word = dot.querySelector('.schedule-status-word')?.textContent?.trim() ?? '';
    const named = dot.getAttribute('aria-label')?.trim() ?? '';
    expect(word !== '' || named !== '', 'a status dot with neither a visible word nor an aria-label').toBe(true);
    expect(dot.querySelector('.schedule-status-dot')?.getAttribute('aria-hidden')).toBe('true');
  }
}

beforeEach(async () => {
  __resetSchedulerForTests();
  localStorage.clear();
  vi.stubGlobal('Notification', undefined);
  await installTestUserDb();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  __resetSchedulerForTests();
  vi.unstubAllGlobals();
});

describe('the result detail', () => {
  it('every control named, status never colour alone, headings present', async () => {
    schedulerStore.set({ ...initialSchedulerView(), ready: true, tasks: [task], runsByTask: { t1: [run] } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={[`/schedule/t1/result/${encodeURIComponent(DUE)}`]}>
          <Routes>
            <Route path="/schedule/:id/result/:dueAt" element={<ResultDetail />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    const el = container;
    expect(el.querySelector('[data-testid="schedule-result-detail"]')).not.toBeNull();
    expectEveryControlNamed(el);
    expectStatusNeverColourAlone(el);
    expect(el.querySelector('h1')?.textContent).toBe('Weekly spend review');
    for (const section of el.querySelectorAll('section[aria-labelledby]')) {
      const id = section.getAttribute('aria-labelledby') ?? '';
      expect(document.getElementById(id)?.tagName).toBe('H2');
    }
    expect(el.querySelector('[data-testid="schedule-result-needs-you"]')?.getAttribute('role')).toBe('status');
    expect(el.querySelector('pre.schedule-result-sql')).not.toBeNull();
  });
});

describe('the Settings card', () => {
  it('names every control; the switches are role=switch named by their row labels', async () => {
    schedulerStore.set({ ...initialSchedulerView(), ready: true, leader: { leader: true, canSeeSiblings: false, reason: 'no-locks' } });
    const el = await mount(<ScheduleSettingsCard />);
    expectEveryControlNamed(el);
    const switches = [...el.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(2);
    expect(switches.map((s) => accessibleName(s))).toEqual(['pause all schedules', 'never let apps suggest schedules']);
    // The armed confirm is a named group, and its controls are named too.
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="schedule-clear-history"]')?.click();
    });
    expect(el.querySelector('[data-testid="schedule-clear-confirm"]')?.getAttribute('aria-label')).toBe('clear history');
    expectEveryControlNamed(el);
  });
});

describe('the running chip', () => {
  it('is a live status with an accessible name that reads the whole sentence; its act names what it cancels', async () => {
    schedulerStore.set({ ...initialSchedulerView(), ready: true, tasks: [task], running: { taskId: 't1', dueAt: DUE, startedAt: DUE, stepIndex: 0 } });
    const el = await mount(<RunningChip />);
    const chip = el.querySelector('[data-testid="schedule-running-chip"]');
    expect(chip?.getAttribute('role')).toBe('status');
    expect(accessibleName(chip!)).toBe('a schedule is running: Weekly spend review');
    expect(chip?.querySelector('.schedule-running-pulse')?.getAttribute('aria-hidden')).toBe('true');
    expectEveryControlNamed(el);
    expect(accessibleName(chip!.querySelector('button')!)).toBe('cancel Weekly spend review');
  });
});

describe('the chat offer', () => {
  it('names its two controls', async () => {
    const el = await mount(<ScheduleOffer text="remind me every weekday at 8 to stretch" />);
    expect(el.querySelector('[data-testid="schedule-offer"]')).not.toBeNull();
    expectEveryControlNamed(el);
  });
});

describe('the row-state pieces', () => {
  it('every act is named; every status dot carries its word; the switch is named by its label', async () => {
    const el = await mount(
      <>
        <span id="row-label">Hourly ledger digest</span>
        <Switch checked onChange={() => {}} labelledBy="row-label" />
        <PausedRow task={{ pausedReason: 'failures', consecutiveFailures: 5, unseenResults: 0 }} onResume={() => {}} />
        <AppMissingNote onRemove={() => {}} />
        <BlockedStepNote reason="not available in this host — it needs your home network" />
        <ResultStatus status="ok" />
        <ResultStatus status="failed" />
        <ResultStatus status="pending" />
      </>,
    );
    expectEveryControlNamed(el);
    expectStatusNeverColourAlone(el);
    expect(accessibleName(el.querySelector('[role="switch"]')!)).toBe('Hourly ledger digest');
  });
});

describe('motion and the sheet', () => {
  const css = readFileSync(path.resolve(__dirname, '../theme/schedule-bits.css'), 'utf8');

  it('honours prefers-reduced-motion: the pulse and the reveal are switched off', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.schedule-running-pulse');
    expect(reduced).toContain('animation: none');
  });

  it('spends colour only through tokens — no literal colour in the sheet', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\brgba?\(/i);
    expect(rules).not.toMatch(/\bhsla?\(/i);
  });

  it('is imported once from app.css, with the other per-surface sheets', () => {
    const app = readFileSync(path.resolve(__dirname, '../theme/app.css'), 'utf8');
    expect(app.match(/@import '\.\/schedule-bits\.css';/g)).toHaveLength(1);
  });
});
