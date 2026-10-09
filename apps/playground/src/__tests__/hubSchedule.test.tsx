// hubSchedule.test.tsx — TASK-20261009-scheduling-framework U1 (ADR-0074): the entry points.
// The hub's "schedule" section renders NOTHING for a first-time user (no schedules, no
// template whose app is installed), else sits between "your apps" and the starters with the
// next three, the when and the next, and an "all schedules" link carrying the unread count;
// with nothing scheduled but Ledger installed it offers the template that fits. The missed
// card sits below the create bar AFTER the protection offer — one banner at a time, the offer
// wins. The header item is a calendar named "schedule" (", N unread" while results wait),
// placed right after the gear (pinned at the source, since mounting the whole App here would
// boot a second shell).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HUB, RELOAD } from '../schedule/copy.page.js';
import { describeSpec } from '../schedule/cron.js';
import { templateCard } from '../schedule/Templates.js';
import { schedulerStore, type SchedulerView } from '../schedule/scheduler.js';
import { protectOfferStore } from '../vault/protectOffer.js';
import { HubView } from '../views/HubView.js';
import { ScheduleNavItem } from '../views/ScheduleView.js';
import { HOUR, NOW, THINK, click, iso, makeRun, makeTask, mount, settle, setupEnv, teardownEnv, texts, unmount, type Env } from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

let env: Env;
let path = '';

function PathProbe(): JSX.Element {
  const location = useLocation();
  path = `${location.pathname}${location.search}`;
  return <span data-testid="path-probe" />;
}

beforeEach(async () => {
  env = await setupEnv();
  path = '';
  protectOfferStore.set(false);
});

afterEach(() => {
  unmount();
  teardownEnv();
  protectOfferStore.set(false);
});

function renderHub(): HTMLDivElement {
  return mount(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HubView />} />
        <Route path="/schedule" element={<PathProbe />} />
        <Route path="/schedule/new" element={<PathProbe />} />
        <Route path="/schedule/:id" element={<PathProbe />} />
        <Route path="/run/:id" element={<PathProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const byTestId = (c: HTMLElement, id: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sectionTitles = (c: HTMLElement): string[] => texts(c, '.section-title');
const before = (a: Element | null, b: Element | null): boolean => a !== null && b !== null && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the hub section (U1)', () => {
  it('renders NOTHING for a first-time user: no schedules, no starters installed — and no missed card', async () => {
    await env.boot();
    const c = renderHub();
    await settle();
    expect(byTestId(c, 'schedule-hub-section')).toBeNull();
    expect(byTestId(c, 'missed-card')).toBeNull();
    expect(sectionTitles(c)).toEqual(['your apps', 'starter apps']);
  });

  it('with schedules: between "your apps" and the starters, the next three soonest first with when + next, and "all schedules · N unread"', async () => {
    env.db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    env.db.putScheduledTask(makeTask({ id: 't2', title: 'Two', spec: { kind: 'every', n: 2, unit: 'hours', tz: 'UTC' }, cron: '0 */2 * * *' }));
    env.db.putScheduledTask(makeTask({ id: 't3', title: 'Three', spec: { kind: 'every', n: 3, unit: 'hours', tz: 'UTC' }, cron: '0 */3 * * *' }));
    env.db.putScheduledTask(makeTask({ id: 't4', title: 'Weekly', spec: { kind: 'weekly', days: ['mon'], time: '09:00', tz: 'UTC' }, cron: '0 9 * * 1' }));
    env.db.putScheduledTask(makeTask({ id: 't5', title: 'Off', enabled: false }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - HOUR), status: 'ok', finishedAt: iso(NOW - HOUR), steps: [{ status: 'ok', summary: 'fine' }] }));
    await env.boot();
    const c = renderHub();
    await settle();
    const section = byTestId(c, 'schedule-hub-section');
    expect(section).not.toBeNull();
    expect(sectionTitles(c)).toEqual(['your apps', HUB.heading, 'starter apps']);
    expect(before(c.querySelector('[data-testid="installed-tile"]'), section), 'after the user’s own tiles').toBe(true);
    expect(before(section, c.querySelector('[data-testid="starter-tile"]')), 'before the starters').toBe(true);
    const rows = [...c.querySelectorAll<HTMLElement>('[data-testid="schedule-hub-row"]')];
    expect(rows).toHaveLength(3);
    expect(texts(c, '.schedule-hub-title')).toEqual(['Hourly', 'Two', 'Three']);
    expect(rows[0]?.querySelector('.schedule-hub-when')?.textContent).toBe(describeSpec({ kind: 'every', n: 1, unit: 'hours', tz: 'UTC' }));
    expect(rows[0]?.querySelector('.schedule-hub-next')?.textContent).toBe('in 55 minutes');
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/schedule/t1');
    const all = byTestId(c, 'schedule-hub-all');
    expect(all?.getAttribute('href')).toBe('/schedule');
    expect(all?.textContent).toBe(`${HUB.all} · ${HUB.unread(1)}`);
    expect(byTestId(c, 'schedule-hub-template')).toBeNull();
  });

  it('nothing scheduled but Ledger installed: the section offers the template that fits, opening the prefilled editor', async () => {
    env.db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>', installSource: 'starter:ledger' });
    await env.boot();
    const c = renderHub();
    await settle();
    expect(byTestId(c, 'schedule-hub-section')).not.toBeNull();
    const offers = [...c.querySelectorAll<HTMLElement>('[data-testid="schedule-hub-template"]')];
    expect(offers.map((offer) => offer.querySelector('.schedule-hub-title')?.textContent)).toEqual(['weekly spend review']);
    // The same registry as the page's cards and the editor: the when is the fill's own.
    const card = templateCard('spend-review', new Map([['starter:ledger', 'ledger']]));
    expect(offers[0]?.querySelector('.schedule-hub-when')?.textContent).toBe(card.when);
    expect(offers[0]?.querySelector('.schedule-hub-when')?.textContent).toBe('Fridays at 5:00 PM');
    expect(offers[0]?.textContent).toContain(HUB.setUp);
    await click(offers[0]?.querySelector('a'));
    expect(path).toBe('/schedule/new?template=spend-review');
    expect(path).toBe(card.href);
  });

  it('a tab promoted over a stale copy (view.needsReload) carries the reload strip — even with nothing scheduled and no starter installed (S3)', async () => {
    await env.boot();
    const c = renderHub();
    await settle();
    expect(byTestId(c, 'schedule-hub-section')).toBeNull();
    await act(async () => {
      schedulerStore.set({ ...schedulerStore.get(), needsReload: true } as SchedulerView);
    });
    const section = byTestId(c, 'schedule-hub-section');
    expect(section).not.toBeNull();
    const strip = section?.querySelector('[data-testid="schedule-reload"]');
    expect(strip?.className).toContain('connection-note');
    expect(strip?.textContent).toContain(RELOAD.note);
    expect(strip?.querySelector('[data-testid="schedule-reload-act"]')?.textContent).toBe(RELOAD.act);
  });

  it('a host that does not allow scheduling (the engine never readies) shows no section even with rows in the file', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    await env.boot({ allows: () => false });
    const c = renderHub();
    await settle();
    expect(schedulerStore.get().ready).toBe(false);
    expect(byTestId(c, 'schedule-hub-section')).toBeNull();
  });
});

describe('the missed card on the hub (U1/U4)', () => {
  it('sits below the create bar; renders only once the protection offer is out of the way', async () => {
    env.db.installApp({ appId: 'ledger', displayName: 'Ledger', html: '<html>ledger</html>' });
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Spend', steps: [THINK()], appVersions: { ledger: 1 } }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - 2 * HOUR), status: 'pending', trigger: 'catch-up', collapsedCount: 2 }));
    await env.boot();
    protectOfferStore.set(true);
    const c = renderHub();
    await settle();
    expect(byTestId(c, 'protection-offer')).not.toBeNull();
    expect(byTestId(c, 'missed-card'), 'one banner at a time — the offer wins').toBeNull();
    await act(async () => protectOfferStore.set(false));
    await settle();
    expect(byTestId(c, 'protection-offer')).toBeNull();
    const card = byTestId(c, 'missed-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('role')).toBe('status');
    expect(card?.getAttribute('aria-live')).toBe('polite');
    expect(card?.className).toContain('connection-note');
    expect(card?.textContent).toContain('1 schedule was missed while Snug was closed · 1 AI call');
    expect(before(c.querySelector('.create-bar'), card), 'below the create bar').toBe(true);
    expect(before(card, c.querySelector('.section-title')), 'above the shelf').toBe(true);
  });
});

describe('the header item (U1)', () => {
  function renderNav(): HTMLDivElement {
    return mount(
      <MemoryRouter initialEntries={['/']}>
        <ScheduleNavItem />
      </MemoryRouter>,
    );
  }

  it('is an icon nav item to /schedule named "schedule" — ", N unread" while results wait', async () => {
    env.db.putScheduledTask(makeTask({ id: 't1', title: 'Hourly' }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - HOUR), status: 'ok', finishedAt: iso(NOW - HOUR) }));
    env.db.putScheduleRun(makeRun({ taskId: 't1', dueAt: iso(NOW - 2 * HOUR), status: 'failed', finishedAt: iso(NOW - 2 * HOUR) }));
    await env.boot();
    const c = renderNav();
    await settle(1);
    const item = byTestId(c, 'schedule-nav');
    expect(item?.tagName).toBe('A');
    expect(item?.getAttribute('href')).toBe('/schedule');
    expect(item?.className).toContain('nav-link-icon');
    expect(item?.getAttribute('aria-label')).toBe('schedule, 2 unread');
    expect(item?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(item?.querySelector('.schedule-nav-badge')?.textContent).toBe('2');
  });

  it('with nothing unread the name is just "schedule" and there is no badge', async () => {
    await env.boot();
    const c = renderNav();
    await settle(1);
    const item = byTestId(c, 'schedule-nav');
    expect(item?.getAttribute('aria-label')).toBe('schedule');
    expect(item?.querySelector('.schedule-nav-badge')).toBeNull();
  });

  it('App.tsx mounts it RIGHT AFTER the gear, and routes /schedule, /schedule/new, /schedule/:id and the result detail', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const gearThenCalendar = /⚙️\s*<\/NavLink>\s*(?:\{\/\*[\s\S]*?\*\/\})?\s*<ScheduleNavItem \/>/;
    expect(app).toMatch(gearThenCalendar);
    for (const route of ['/schedule', '/schedule/new', '/schedule/:id', '/schedule/:id/result/:dueAt']) {
      expect(app, `a route for ${route}`).toContain(`path="${route}"`);
    }
    expect(app).toMatch(/path="\/schedule"[\s\S]*?<ScheduleGate>\s*<ScheduleView \/>/);
    expect(app).toMatch(/path="\/schedule\/new"[\s\S]*?<ScheduleEditorView \/>/);
    expect(app).toMatch(/path="\/schedule\/:id"[\s\S]*?<ScheduleEditorView \/>/);
    expect(app).toMatch(/path="\/schedule\/:id\/result\/:dueAt"[\s\S]*?<ResultDetail \/>/);
  });

  it('HubView places the missed card right after the protection offer (hidden while it shows) and the section before the shared shelf', () => {
    const hub = readFileSync(join(SRC, 'views', 'HubView.tsx'), 'utf8');
    expect(hub).toMatch(/<ProtectionOffer \/>\s*(?:\{\/\*[\s\S]*?\*\/\})?\s*\{protectOffered \? null : <MissedCard \/>\}/);
    expect(hub).toMatch(/<ScheduleHubSection installedBySource=\{installedBySource\} \/>\s*(?:\{\/\*[\s\S]*?\*\/\})?\s*<SharedShelf installedBySource=\{installedBySource\} \/>/);
    expect(hub.indexOf('your apps')).toBeLessThan(hub.indexOf('<ScheduleHubSection'));
  });
});
