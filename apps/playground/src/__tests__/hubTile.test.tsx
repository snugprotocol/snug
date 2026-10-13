// hubTile.test.tsx — TASK-20261010-host-broker PR-5, AC36 (contract v2 D-PR5-6, D-PR5-6a, D-PR5-7;
// D1, D2, D3, F16, S11): ONE line per Hub tile about access between apps.
//
// THE ACCESS LINE (D-PR5-6). `accessCountsByApp(db, now)` — distinct other apps joined by ≥ 1 live
// access each way, session ones included — computed ONCE in `HubHome` (never per tile), gated by
// `allows('access')`, refreshed on the access and library revisions and by ONE timer at
// `min(nearest expiresAt − now, 24 h)`, re-armed when it fires and cleared on unmount.
// `access/AccessTileBadge.tsx`: a small muted line in normal flow AFTER `.tile-sub` inside the tile
// face — on the link branch AND the blocked branch — the ⋈ glyph `aria-hidden`, then the VISIBLE
// words `HUB_TILE.accessWords(reads, readBy)`, which so become part of the link's accessible name;
// class `.tile-access-line`; never absolutely positioned (the owned tile's hover `.tile-delete`
// sits top-right); no line at 0. Report-only.
//
// THE *COULD READ* SIBLING (D-PR5-7). When the app has no live access but a pair names it as the
// READER, a SIBLING button (never inside the link) with visible `HUB_TILE.couldRead(source)` and
// aria-label `HUB_TILE.couldReadName(app, source)` — never *works with* (not yet true), host words
// only (never the app's purpose on the tile), names bidi-isolated — starts the D-PR5-4 ask, and its
// act line (D-PR5-6a) sits beside it. No sibling for a share-link or imported reader (S11).
//
// Q (lane T-B — test ids the contract leaves open): the sibling `tile-could-read`, the act line
// `access-act-line`.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { collectSources, pendingAccessStore, reviewStore } from '../access/consent.js';
import * as copy from '../access/copy.js';
import { CONSENT_UI, STRIP_OUTCOME } from '../access/copy.js';
import { bumpAccessRevision, createGrantFromDecision, noteReaderGeneration, resetAccessSession, suspendAccess } from '../access/grants.js';
import { answerAccess } from '../access/outcome.js';
import { netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { HubView } from '../views/HubView.js';
import { HOST_OFF_CAPABILITIES, hostPlatform } from './fixtures/hostPlatform.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

const TILE = (copy as unknown as {
  HUB_TILE: { accessWords(reads: number, readBy: number): string; couldRead(sourceName: string): string; couldReadName(appName: string, sourceName: string): string };
}).HUB_TILE;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const SPENDING = { purpose: 'to show spending by category', hints: { tables: ['transactions'] } };
const COINBASE = { slot: 'coinbase', provider: { name: 'Coinbase' }, kind: 'api_key', declaredApiHosts: ['api.coinbase.com'] };

function declaring(title: string, wants: unknown): string {
  const content = JSON.stringify(wants).replace(/&/g, '&amp;').replace(/'/g, '&apos;');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="snug:access-wants" content='${content}'>\n<title>${title}</title>\n</head>\n<body></body>\n</html>`;
}

let db: UserDb;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function renderHub(Hub: typeof HubView = HubView): Promise<void> {
  if (root !== undefined) {
    act(() => root!.unmount());
    container?.remove();
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Hub />} />
          <Route path="/run/:id" element={<div data-testid="run-route" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

const tileOf = (name: string): HTMLElement => {
  const tile = [...(container?.querySelectorAll<HTMLElement>('[data-testid="installed-tile"]') ?? [])].find((candidate) => candidate.querySelector('.tile-name')?.textContent === name);
  if (tile === undefined) throw new Error(`no installed tile "${name}"`);
  return tile;
};
const lineIn = (tile: HTMLElement): HTMLElement | null => tile.querySelector<HTMLElement>('.tile-access-line');
/** The accessible name a link computes from its content: its aria-label, else its text without aria-hidden parts. */
function accessibleName(el: HTMLElement): string {
  const label = el.getAttribute('aria-label');
  if (label !== null) return label;
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function app(name: string, opts: { ddl?: string[]; wants?: unknown; installSource?: string } = {}): Promise<string> {
  const appId = db.installApp({
    displayName: name,
    html: opts.wants !== undefined ? declaring(name, opts.wants) : `<!doctype html><title>${name}</title>`,
    ...(opts.installSource !== undefined ? { installSource: opts.installSource } : {}),
  }).appId;
  if (opts.ddl !== undefined) await db.applyAppDdl(appId, opts.ddl);
  return appId;
}

async function allow(reader: string, sourceId: string, tables: string[], duration: 'session' | 'day' | 'always' = 'day'): Promise<void> {
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId);
  if (source === undefined) throw new Error('no such candidate');
  await createGrantFromDecision(db, { readerAppId: reader, source, tables, duration, unattended: false, purpose: 'to show spending', provenance: 'app', generation: 0, now: Date.now() });
}

let budget: string;
let ledger: string;
let pantry: string;

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  resetAccessSession();
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  netConfirmStore.set(null);
  db = await installTestUserDb();
  budget = await app('Budget');
  ledger = await app('Ledger', { ddl: ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER, category TEXT)'] });
  pantry = await app('Pantry', { ddl: ['CREATE TABLE items (name TEXT, qty INTEGER)'] });
});

afterEach(() => {
  if (root !== undefined) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  act(() => resetAccessSession());
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  netConfirmStore.set(null);
});

// =========================================================================================

describe('D-PR5-6 the access line — visible words, in flow, inside the tile face', () => {
  it('Budget reads Ledger: "reads 1 other app" on Budget, "read by 1 app" on Ledger, nothing on Pantry', async () => {
    await allow(budget, ledger, ['transactions']);
    await renderHub();
    expect(lineIn(tileOf('Budget'))?.textContent).toContain(TILE.accessWords(1, 0));
    expect(lineIn(tileOf('Ledger'))?.textContent).toContain(TILE.accessWords(0, 1));
    expect(lineIn(tileOf('Pantry'))).toBeNull();
  });

  it('both ways at once, distinct apps: "reads 1 other app · read by 1 app"', async () => {
    await allow(pantry, ledger, ['transactions']);
    await allow(budget, pantry, ['items']);
    await allow(budget, pantry, ['items'], 'always');
    await renderHub();
    expect(lineIn(tileOf('Pantry'))?.textContent).toContain(TILE.accessWords(1, 1));
    expect(lineIn(tileOf('Budget'))?.textContent).toContain(TILE.accessWords(1, 0));
  });

  it('the line sits AFTER .tile-sub, inside the link — the ⋈ aria-hidden, the words part of the link’s accessible name', async () => {
    await allow(budget, ledger, ['transactions']);
    await renderHub();
    const tile = tileOf('Budget');
    const link = tile.querySelector<HTMLElement>('a.tile-link')!;
    const line = lineIn(tile)!;
    expect(link.contains(line), 'inside the tile face (the link)').toBe(true);
    const sub = tile.querySelector('.tile-sub')!;
    expect(sub.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const glyph = [...line.querySelectorAll('[aria-hidden="true"]')].find((el) => el.textContent?.includes('⋈'));
    expect(glyph, 'the ⋈ glyph is aria-hidden').toBeDefined();
    expect(accessibleName(link)).toContain(TILE.accessWords(1, 0));
    expect(accessibleName(link)).not.toContain('⋈');
  });

  it('on the BLOCKED branch too: the line inside the aria-disabled control', async () => {
    db.putDeclaredConnection(budget, 'coinbase', COINBASE as Parameters<UserDb['putDeclaredConnection']>[2], 'inference');
    await allow(budget, ledger, ['transactions']);
    await renderHub();
    const tile = tileOf('Budget');
    const control = tile.querySelector<HTMLElement>('.tile-card-button');
    expect(control, 'the tile is blocked on this host').not.toBeNull();
    const line = lineIn(tile);
    expect(line).not.toBeNull();
    expect(control!.contains(line)).toBe(true);
    expect(line!.textContent).toContain(TILE.accessWords(1, 0));
  });

  it('this tab’s SESSION access counts', async () => {
    noteReaderGeneration(budget, 0);
    await allow(budget, ledger, ['transactions'], 'session');
    await renderHub();
    expect(lineIn(tileOf('Budget'))?.textContent).toContain(TILE.accessWords(1, 0));
  });

  it('none at 0: no tile carries a line when nothing reads anything', async () => {
    await renderHub();
    expect(container!.querySelectorAll('.tile-access-line')).toHaveLength(0);
  });

  it('never absolutely positioned: the theme’s .tile-access-line rule exists and sets no position: absolute; no inline position either', async () => {
    const themeDir = path.resolve(__dirname, '..', 'theme');
    const rules = readdirSync(themeDir)
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) => [...readFileSync(path.join(themeDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.tile-access-line[^{}]*)\{([^}]*)\}/g)].map((m) => m[2] ?? ''));
    expect(rules.length, 'a .tile-access-line rule in the theme').toBeGreaterThan(0);
    for (const body of rules) expect(body).not.toMatch(/position\s*:\s*(absolute|fixed)/);
    await allow(budget, ledger, ['transactions']);
    await renderHub();
    expect(lineIn(tileOf('Budget'))!.getAttribute('style') ?? '').not.toMatch(/position/);
  });

  it('report-only: the line is no control — no button, no link of its own', async () => {
    await allow(budget, ledger, ['transactions']);
    await renderHub();
    const line = lineIn(tileOf('Budget'))!;
    expect(line.querySelector('button, a')).toBeNull();
    expect(line.tagName).not.toBe('BUTTON');
  });
});

describe('D-PR5-6 refreshed — the revisions, ONE timer ≤ 24 h, computed once per shelf (F16)', () => {
  it('an access made while the shelf is up appears without a reload (the access revision)', async () => {
    await renderHub();
    expect(lineIn(tileOf('Budget'))).toBeNull();
    await act(async () => {
      await allow(budget, ledger, ['transactions']);
    });
    await settle();
    expect(lineIn(tileOf('Budget'))?.textContent).toContain(TILE.accessWords(1, 0));
  });

  it('ONE timer at the nearest expiry: a day access made an hour ago arms 23 h — and fires to take the line away, re-arming', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await allow(budget, ledger, ['transactions'], 'day');
    vi.setSystemTime(T0 + HOUR);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await renderHub();
    const armed = timers.mock.calls.filter((call) => call[1] === 23 * HOUR);
    expect(armed, 'a timer at expiresAt − now').toHaveLength(1);
    expect(lineIn(tileOf('Budget'))).not.toBeNull();
    const before = timers.mock.calls.length;
    vi.setSystemTime(T0 + DAY + 1_000);
    await act(async () => {
      (armed[0]![0] as () => void)();
    });
    await settle();
    expect(lineIn(tileOf('Budget')), 'the access expired: its line is gone').toBeNull();
    const rearmed = timers.mock.calls.slice(before).filter((call) => typeof call[1] === 'number' && call[1] > 60_000 && call[1] <= DAY);
    expect(rearmed.length, 'the timer is re-armed when it fires').toBeGreaterThanOrEqual(1);
  });

  it('never longer than 24 h: an access until stopped arms the 24-hour timer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await allow(budget, ledger, ['transactions'], 'always');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await renderHub();
    expect(timers.mock.calls.filter((call) => call[1] === DAY)).toHaveLength(1);
    expect(timers.mock.calls.some((call) => typeof call[1] === 'number' && call[1] > DAY)).toBe(false);
  });

  it('the timer is cleared on unmount', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await allow(budget, ledger, ['transactions'], 'day');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    await renderHub();
    const index = timers.mock.calls.findIndex((call) => call[1] === DAY);
    expect(index).toBeGreaterThanOrEqual(0);
    const handle = timers.mock.results[index]!.value as unknown;
    act(() => root!.unmount());
    root = undefined;
    expect(clears.mock.calls.some((call) => call[0] === handle)).toBe(true);
  });

  it('computed ONCE per shelf: the access read does not grow with the number of tiles', async () => {
    await allow(budget, ledger, ['transactions']);
    const reads = vi.spyOn(db, 'listAccessGrants');
    await renderHub();
    const withThree = reads.mock.calls.length;
    expect(withThree, 'the shelf reads the accesses').toBeGreaterThan(0);
    for (const name of ['Delta', 'Echo', 'Foxtrot', 'Golf']) await app(name);
    reads.mockClear();
    await renderHub();
    expect(reads.mock.calls.length).toBe(withThree);
  });
});

describe('D-PR5-6 gated by allows(access)', () => {
  it('a host without access shows no line — and the same host with access on does (the twin)', async () => {
    for (const access of [false, true]) {
      if (root !== undefined) act(() => root!.unmount());
      root = undefined;
      container?.remove();
      vi.resetModules();
      const platform = await import('../platform/platform.js');
      platform.setPlatform(hostPlatform({ capabilities: { ...HOST_OFF_CAPABILITIES, access } }));
      const helper = await import('./userdbTestHelper.js');
      const fresh = await helper.installTestUserDb();
      const consent = await import('../access/consent.js');
      const grants = await import('../access/grants.js');
      const reader = fresh.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
      const source = fresh.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
      await fresh.applyAppDdl(source, ['CREATE TABLE transactions (amount INTEGER)']);
      const ranked = await consent.collectSources(fresh, reader);
      const candidate = [...ranked.matched, ...ranked.rest].find((c) => c.appId === source)!;
      await grants.createGrantFromDecision(fresh, { readerAppId: reader, source: candidate, tables: ['transactions'], duration: 'day', unattended: false, purpose: 'to show spending', provenance: 'app', generation: 0, now: Date.now() });
      const { HubView: FreshHub } = await import('../views/HubView.js');
      await renderHub(FreshHub);
      const line = container!.querySelectorAll('.tile-access-line');
      if (access) expect(line.length, 'access on: the line renders').toBeGreaterThan(0);
      else expect(line.length, 'access off: no line').toBe(0);
    }
    vi.resetModules();
  });
});

describe('D-PR5-7 the *could read* sibling — when a pair names the app as the reader', () => {
  beforeEach(() => {
    db.saveAppVersion(budget, declaring('Budget', [SPENDING]));
  });

  const sibling = (tile: HTMLElement): HTMLElement | null => tile.querySelector<HTMLElement>('[data-testid="tile-could-read"]');

  it('a SIBLING button — never inside the link — with the host’s visible words and an aria-label naming both apps', async () => {
    await renderHub();
    const tile = tileOf('Budget');
    const button = sibling(tile);
    expect(button, 'Budget declares a want Ledger’s registered table meets').not.toBeNull();
    expect(button!.tagName).toBe('BUTTON');
    expect(tile.querySelector('a.tile-link')!.contains(button)).toBe(false);
    expect(button!.textContent).toBe(TILE.couldRead('Ledger'));
    expect(button!.getAttribute('aria-label')).toBe(TILE.couldReadName('Budget', 'Ledger'));
  });

  it('never "works with" (not yet true), never the app’s own purpose on the tile', async () => {
    await renderHub();
    const tile = tileOf('Budget');
    expect(tile.textContent).not.toMatch(/works with/i);
    expect(tile.textContent).not.toContain(SPENDING.purpose);
    expect(sibling(tile)).not.toBeNull();
  });

  it('the source’s name is bidi-isolated', async () => {
    await renderHub();
    const isolated = [...sibling(tileOf('Budget'))!.querySelectorAll('bdi')].map((el) => el.textContent);
    expect(isolated).toContain('Ledger');
  });

  it('ONE line per tile: an app with live access shows its access line, and no sibling', async () => {
    await allow(budget, pantry, ['items']);
    await renderHub();
    const tile = tileOf('Budget');
    expect(lineIn(tile)?.textContent).toContain(TILE.accessWords(1, 0));
    expect(sibling(tile)).toBeNull();
  });

  it('only the READER’s tile: the source (Ledger) carries no sibling', async () => {
    await renderHub();
    expect(sibling(tileOf('Ledger'))).toBeNull();
    expect(sibling(tileOf('Pantry'))).toBeNull();
  });

  it('S11: no sibling for a reader installed from a share link', async () => {
    await app('Shared', { wants: [SPENDING], installSource: 'share:7e2d' });
    await renderHub();
    expect(sibling(tileOf('Shared'))).toBeNull();
    expect(sibling(tileOf('Budget'))).not.toBeNull();
  });

  it('S11: no sibling for an IMPORTED reader (the appProvenance marker)', async () => {
    db.setSetting(`appProvenance:${budget}`, { imported: true, at: new Date().toISOString() });
    await renderHub();
    expect(sibling(tileOf('Budget'))).toBeNull();
  });

  it('a host without access shows no sibling — gated like the line', async () => {
    vi.resetModules();
    const platform = await import('../platform/platform.js');
    platform.setPlatform(hostPlatform({ capabilities: { ...HOST_OFF_CAPABILITIES, access: false } }));
    const helper = await import('./userdbTestHelper.js');
    const fresh = await helper.installTestUserDb();
    fresh.installApp({ displayName: 'Budget', html: declaring('Budget', [SPENDING]) });
    const source = fresh.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await fresh.applyAppDdl(source, ['CREATE TABLE transactions (amount INTEGER)']);
    const { HubView: FreshHub } = await import('../views/HubView.js');
    await renderHub(FreshHub);
    expect(container!.querySelector('[data-testid="tile-could-read"]')).toBeNull();
    vi.resetModules();
  });
});

describe('D-PR5-6a the sibling’s act and its act line', () => {
  beforeEach(() => {
    db.saveAppVersion(budget, declaring('Budget', [SPENDING]));
  });

  const actLine = (tile: HTMLElement): HTMLElement | null => tile.querySelector<HTMLElement>('[data-testid="access-act-line"]');

  it('the tap starts the declared ask, pinned to the source', async () => {
    await renderHub();
    await act(async () => tileOf('Budget').querySelector<HTMLElement>('[data-testid="tile-could-read"]')!.click());
    await settle();
    expect(reviewStore.get()).toBe(budget);
    const pending = pendingAccessStore.get()[budget] as ReturnType<typeof pendingAccessStore.get>[string] & { askedIn?: string };
    expect(pending.askedIn).toBe('declared');
    expect(pending.preselect?.appId).toBe(ledger);
  });

  it('allowed: the act line beside it says so, with *stop*', async () => {
    await renderHub();
    await act(async () => tileOf('Budget').querySelector<HTMLElement>('[data-testid="tile-could-read"]')!.click());
    await settle();
    const pending = pendingAccessStore.get()[budget]!;
    await act(async () => {
      await answerAccess(pending, {
        kind: 'allow',
        sourceAppId: ledger,
        tables: [{ name: 'transactions', withheld: [], write: false }],
        duration: 'day',
        unattended: false,
        kv: false,
        refresh: false,
      } as Parameters<typeof answerAccess>[1]);
    });
    await settle();
    const tile = tileOf('Budget');
    const line = actLine(tile);
    expect(line).not.toBeNull();
    expect(line!.getAttribute('role')).toBe('status');
    expect(line!.textContent).toContain(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day'));
    expect([...line!.querySelectorAll('button')].some((button) => button.textContent === STRIP_OUTCOME.undo)).toBe(true);
  });

  it('another question is open first: the act line says to answer it — nothing parked', async () => {
    netConfirmStore.set({ request: {} as PendingNetConfirm['request'], resolve: () => undefined });
    await renderHub();
    await act(async () => tileOf('Budget').querySelector<HTMLElement>('[data-testid="tile-could-read"]')!.click());
    await settle();
    expect(actLine(tileOf('Budget'))?.textContent).toContain(CONSENT_UI.answerOtherFirst);
    expect(pendingAccessStore.get()[budget]).toBeUndefined();
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold on the Hub tile.
//
// G5-14 (IB-3) a PAUSED pair shows no *could read* sibling: *allow again* on that access's row is
//       the act — a new ask would leave a duplicate beside the paused row.
// G5-15 (IB-4) keyboard *stop* on the sibling's act line keeps focus on the line; (IB-7) the Hub's
//       one read computes `foundGrants` ONCE — the counts, the pairs and the timer share it (it was
//       three passes, each reading every grant).
// =========================================================================================

describe('G5-14 a paused pair shows no *could read* sibling', () => {
  beforeEach(() => {
    db.saveAppVersion(budget, declaring('Budget', [SPENDING]));
  });

  it('G5-14 Budget’s access to Ledger paused by reader-updated: no sibling on Budget’s tile', async () => {
    await allow(budget, ledger, ['transactions']);
    const grant = db.listAccessGrants()[0]!;
    await suspendAccess(db, grant.id, 'reader-updated', new Date().toISOString());
    await renderHub();
    expect(tileOf('Budget').querySelector('[data-testid="tile-could-read"]')).toBeNull();
  });
});

describe('G5-15 the sibling’s act line and the Hub’s one read', () => {
  beforeEach(() => {
    db.saveAppVersion(budget, declaring('Budget', [SPENDING]));
  });

  it('G5-15 (IB-4) keyboard *stop* on the allowed line: focus lands on the act line, never <body>', async () => {
    await renderHub();
    await act(async () => tileOf('Budget').querySelector<HTMLElement>('[data-testid="tile-could-read"]')!.click());
    await settle();
    const pending = pendingAccessStore.get()[budget]!;
    await act(async () => {
      await answerAccess(pending, {
        kind: 'allow',
        sourceAppId: ledger,
        tables: [{ name: 'transactions', withheld: [], write: false }],
        duration: 'day',
        unattended: false,
        kv: false,
        refresh: false,
      } as Parameters<typeof answerAccess>[1]);
    });
    await settle();
    const lineEl = (): HTMLElement | null => container!.querySelector<HTMLElement>('[data-testid="access-act-line"]');
    const stop = [...lineEl()!.querySelectorAll('button')].find((button) => button.textContent === STRIP_OUTCOME.undo)!;
    stop.focus();
    await act(async () => stop.click());
    await settle(8);
    expect(lineEl()?.getAttribute('data-outcome')).toBe('stopped');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(lineEl());
  });

  it('G5-15 (IB-7) one Hub read reads the file’s grants ONCE (counts, pairs and timer share foundGrants)', async () => {
    await allow(budget, pantry, ['items']);
    await renderHub();
    const reads = vi.spyOn(db, 'listAccessGrants');
    await act(async () => {
      bumpAccessRevision();
    });
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
