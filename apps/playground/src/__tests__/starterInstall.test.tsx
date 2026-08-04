// starterInstall.test.tsx — TASK-20260804-hub-polish, Phase G.
//
// AC18 — an UNINSTALLED starter shows an explicit Install control and NO chat tab;
//        installing it navigates to the user's own copy. A starter the user already
//        installed opens THAT copy and never a second one (re-open is idempotent),
//        including via a direct /run/starter--* deep link. No starter interaction may
//        produce an unreachable app row.
//
// The bug this locks: RunView omitted `pinnedAppId` for a starter id, so the chat
// rail's artifact sink minted a random UUID, found no row, and INSTALLED a brand-new
// hidden app at pinned v1 — an app row reachable from nothing. The starter itself is
// read-only from examples/, so the user read it as "my edit replaced the factory app".

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import RunView from '../run/RunView.js';
import { HubView } from '../views/HubView.js';
import { modeStore } from '../state/mode.js';
import { STARTER_PREFIX } from '../starter/starterApps.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The starter every assertion below uses — found by NAME, never by list index. */
const STARTER_NAME = 'chess';
const STARTER_ID = `${STARTER_PREFIX}chess`;
const STARTER_SOURCE = 'starter:chess';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/**
 * Waits for a CONDITION rather than a fixed delay. Installing a starter chains a
 * dynamic import (the examples/ vite glob) with a user-DB write, and under full-suite
 * load that chain routinely outruns a 5 ms sleep — a fixed settle() made this file pass
 * alone and flake in `pnpm test`. Polling keeps the assertion honest: it still fails if
 * the install never happens, it just stops racing the module loader.
 */
async function settleUntil(done: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Records the router's current path so navigation can be asserted without a real URL bar. */
function PathProbe({ onPath }: { onPath: (path: string) => void }): ReactElement {
  const location = useLocation();
  onPath(location.pathname);
  return <span />;
}

function mount(element: Parameters<Root['render']>[0]): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function unmountCurrent(): void {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

async function renderHub(): Promise<{ el: HTMLDivElement; path: () => string }> {
  let current = '/';
  const el = mount(
    <MemoryRouter initialEntries={['/']}>
      <PathProbe onPath={(p) => (current = p)} />
      <HubView />
    </MemoryRouter>,
  );
  await settle();
  return { el, path: () => current };
}

async function renderRun(id: string): Promise<{ el: HTMLDivElement; path: () => string }> {
  let current = `/run/${id}`;
  const el = mount(
    <MemoryRouter initialEntries={[`/run/${id}`]}>
      <PathProbe onPath={(p) => (current = p)} />
      <Routes>
        <Route path="/run/:id" element={<RunView />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
  return { el, path: () => current };
}

/** Starter tiles by NAME — list order is only stable when timestamps differ (lessons). */
function starterTile(el: HTMLElement, name: string): HTMLElement {
  const tiles = [...el.querySelectorAll<HTMLElement>('[data-testid="starter-tile"]')];
  const found = tiles.find((tile) => tile.getAttribute('data-starter-name') === name);
  if (found === undefined) {
    throw new Error(`no starter tile named "${name}" (saw ${tiles.map((t) => t.getAttribute('data-starter-name')).join(', ')})`);
  }
  return found;
}

const installButton = (tile: HTMLElement): HTMLButtonElement | null =>
  tile.querySelector<HTMLButtonElement>('[data-testid="starter-install"]');
const openButton = (tile: HTMLElement): HTMLButtonElement | null =>
  tile.querySelector<HTMLButtonElement>('[data-testid="starter-open"]');

function tabNames(el: HTMLElement): string[] {
  const group = el.querySelector('[aria-label="rail tabs"]');
  if (group === null) return [];
  return [...group.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim());
}

beforeEach(async () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  db = await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('an uninstalled starter offers an explicit Install control (AC18)', () => {
  it('shows Install — not a silent auto-install-on-click', async () => {
    const { el } = await renderHub();
    const tile = starterTile(el, STARTER_NAME);
    const install = installButton(tile);
    expect(install, 'an uninstalled starter must offer an explicit Install control').not.toBeNull();
    expect(install!.textContent?.toLowerCase()).toContain('install');
    // Nothing was installed merely by rendering the shelf.
    expect(db.listApps()).toHaveLength(0);
  });

  it('installing navigates to the user’s OWN copy, not to the starter route', async () => {
    const { el, path } = await renderHub();
    act(() => {
      installButton(starterTile(el, STARTER_NAME))!.click();
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');

    const apps = db.listApps();
    expect(apps).toHaveLength(1);
    const copy = apps[0]!;
    expect(copy.installSource).toBe(STARTER_SOURCE);
    expect(path()).toBe(`/run/${copy.appId}`);
    expect(path()).not.toContain(STARTER_PREFIX);
  });

  it('a double-click installs exactly one copy (the latch survives)', async () => {
    const { el } = await renderHub();
    const install = installButton(starterTile(el, STARTER_NAME))!;
    act(() => {
      install.click();
      install.click();
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');
    // A second install would land AFTER the first; settle again so the latch is really
    // tested rather than the assertion simply running before the race could resolve.
    await settle();
    await settle();
    expect(db.listApps()).toHaveLength(1);
  });

  it('an install failure is surfaced, not swallowed', async () => {
    const { el } = await renderHub();
    // installApp is what the library.save path ultimately calls.
    vi.spyOn(db, 'installApp').mockImplementation(() => {
      throw new Error('disk full');
    });
    act(() => {
      installButton(starterTile(el, STARTER_NAME))!.click();
    });
    await settleUntil(() => el.querySelector('[role="alert"]') !== null, 'the install error to surface');
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('disk full');
  });
});

describe('an installed starter opens the user’s copy, never a second one (AC18)', () => {
  it('the tile switches to an Open control and keeps the installed badge', async () => {
    const copy = db.installApp({ displayName: 'chess', html: '<html>copy</html>', installSource: STARTER_SOURCE });
    const { el, path } = await renderHub();
    const tile = starterTile(el, STARTER_NAME);
    expect(installButton(tile), 'an installed starter must not offer Install again').toBeNull();
    expect(tile.querySelector('.tile-installed-badge')).not.toBeNull();

    act(() => {
      openButton(tile)!.click();
    });
    await settle();
    expect(path()).toBe(`/run/${copy.appId}`);
    // Idempotent: opening did not mint a second row.
    expect(db.listApps()).toHaveLength(1);
  });
});

describe('a direct /run/starter--* deep link resolves to the installed copy (AC18)', () => {
  it('redirects to the user’s copy when one exists', async () => {
    const copy = db.installApp({ displayName: 'chess', html: '<html>copy</html>', installSource: STARTER_SOURCE });
    const { path } = await renderRun(STARTER_ID);
    expect(path(), 'a bookmark/back-button visit must land on the user’s copy').toBe(`/run/${copy.appId}`);
    expect(db.listApps()).toHaveLength(1);
  });

  it('stays on the read-only starter when the user has NOT installed it', async () => {
    const { path } = await renderRun(STARTER_ID);
    expect(path()).toBe(`/run/${STARTER_ID}`);
    expect(db.listApps()).toHaveLength(0);
  });
});

describe('a starter shows no chat tab until it is installed (AC18)', () => {
  it('the rail offers no chat tab for a starter', async () => {
    const { el } = await renderRun(STARTER_ID);
    const names = tabNames(el);
    expect(names.length).toBeGreaterThan(0);
    expect(names, 'a starter must not expose the chat rail — that is where the fork happened').not.toContain('chat');
  });

  it('the installed copy DOES offer the chat tab', async () => {
    const copy = db.installApp({ displayName: 'chess', html: '<html>copy</html>', installSource: STARTER_SOURCE });
    const { el } = await renderRun(copy.appId);
    expect(tabNames(el)).toContain('chat');
  });
});

describe('no starter interaction can produce an unreachable app row (AC18)', () => {
  /**
   * The regression itself. "Reachable" means the hub actually renders a route into the
   * row: a tile in the installed grid, or the starter shelf's install_source dedup map.
   * The hidden fork produced a row that NEITHER surfaced.
   *
   * This asks the rendered HUB which app ids it links to — comparing db.listApps()
   * against itself would be a tautology that can only ever pass.
   */
  const unreachableRows = async (trueRowIds?: readonly string[]): Promise<string[]> => {
    const { el } = await renderHub();
    const linked = new Set(
      [...el.querySelectorAll<HTMLAnchorElement>('[data-testid="installed-tile"] a.tile-link')].map(
        (a) => a.getAttribute('href')?.replace('/run/', '') ?? '',
      ),
    );
    unmountCurrent();
    // `trueRowIds` lets the self-check below supply the REAL row set while the hub is
    // rendered from a doctored one; production callers pass nothing and read the DB.
    const rows = trueRowIds ?? db.listApps().map((app) => app.appId);
    return [...rows].filter((id) => !linked.has(id));
  };

  it('visiting a starter, then installing it, leaves exactly one reachable row', async () => {
    // 1. Deep-link the read-only starter (the old fork path ran the chat rail here).
    await renderRun(STARTER_ID);
    await settle();
    expect(db.listApps(), 'merely opening a starter must never write an app row').toHaveLength(0);
    unmountCurrent();

    // 2. Install it from the hub.
    const hub = await renderHub();
    act(() => {
      installButton(starterTile(hub.el, STARTER_NAME))!.click();
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');
    unmountCurrent();

    const apps = db.listApps();
    expect(apps).toHaveLength(1);
    // Every row is reachable from the hub: it is LINKED by a rendered tile AND its
    // install_source maps back to the starter shelf.
    expect(await unreachableRows()).toEqual([]);
    expect(apps[0]!.installSource).toBe(STARTER_SOURCE);
    expect(db.getAppByInstallSource(STARTER_SOURCE)?.appId).toBe(apps[0]!.appId);
  });

  it('the reachability probe really detects an orphan row (probe self-check)', async () => {
    // Guards the guard. If unreachableRows() could only ever return [], the assertion
    // above would pass no matter what the code did (lessons.md 2026-08-04). Feed it a
    // row the hub genuinely cannot render — one hidden from the library listing, which
    // is the shape the artifactSink fork used to mint — and it must be REPORTED.
    db.installApp({ appId: 'orphan-1', displayName: 'Orphan', html: '<html>x</html>' });
    // Hide the row from the hub's listing only — it is still really in the DB. That
    // asymmetry (a row exists, nothing links to it) is precisely a hidden fork. The spy
    // must stay live while the hub renders, so the TRUE row set is captured up front and
    // handed to the SAME helper the AC assertion above uses.
    const trueRowIds = db.listApps().map((app) => app.appId);
    expect(trueRowIds).toContain('orphan-1');
    const real = db.listApps.bind(db);
    vi.spyOn(db, 'listApps').mockImplementation(() => real().filter((app) => app.appId !== 'orphan-1'));

    const orphans = await unreachableRows(trueRowIds);
    vi.restoreAllMocks();
    expect(orphans, 'the probe failed to flag a row the hub cannot reach').toContain('orphan-1');
  });

  /**
   * ADVERSARIAL-REVIEW FIX (2026-08-04). The three tests above were VACUOUS for the
   * defect they name: reviewer restored the fork end-to-end (chat tab back on the
   * starter route + coercion removed) and all three stayed GREEN.
   *
   * Why: `unreachableRows()` measures the wrong property. A forked app is a normal
   * `snug_apps` row, so the hub lists it and renders a tile — it IS reachable. What
   * makes it the bug is that it is a SECOND, UNWANTED row the user never asked for.
   *
   * So assert the OUTCOME, not reachability: after interacting with an uninstalled
   * starter, the library must be empty, and every row that ever appears must carry an
   * `installSource`. A hidden fork mints a row with `installSource === undefined`,
   * which this catches by construction and no tile-linking probe ever will.
   */
  it('interacting with an uninstalled starter writes NO app row (the fork, asserted by outcome)', async () => {
    const { el } = await renderRun(STARTER_ID);
    await settle();

    // Drive the fork for REAL: click every rail tab the starter exposes, then — if any
    // of them yields a composer — type and submit. The hidden fork was minted by the
    // chat rail's artifact write, so a probe that never sends a turn cannot see it.
    // This is the reviewer's finding: the tab-list assertion only watches the ONE path
    // it names, while this watches the outcome regardless of which path produced it.
    for (const tab of [...el.querySelectorAll<HTMLButtonElement>('.seg button')]) {
      act(() => tab.click());
      await settle();
      const textarea = el.querySelector('textarea');
      if (textarea !== null) {
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        act(() => {
          setValue?.call(textarea, 'make the board green');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const send = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => (b.textContent ?? '').trim().toLowerCase() === 'send',
        );
        act(() => send?.click());
        await settle();
      }
    }

    expect(db.listApps(), 'an uninstalled starter must never write an app row').toHaveLength(0);
    unmountCurrent();
  });

  it('every row the library ever holds is an installed copy, never a fork (AC18 outcome)', async () => {
    // A fork is exactly a row with no install_source. Install legitimately, then drive
    // the run view of the INSTALLED copy — the surface that is allowed to write — and
    // assert we still have exactly one source-tagged row rather than a second one.
    const hub = await renderHub();
    act(() => {
      installButton(starterTile(hub.el, STARTER_NAME))!.click();
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');
    unmountCurrent();

    const installed = db.listApps()[0]!;
    await renderRun(installed.appId);
    await settle();
    unmountCurrent();

    const rows = db.listApps();
    expect(rows).toHaveLength(1);
    expect(
      rows.filter((app) => app.installSource === undefined),
      'a row with no install_source is a hidden fork',
    ).toEqual([]);
  });

  it('re-opening the installed starter twice still yields one row', async () => {
    db.installApp({ displayName: 'chess', html: '<html>copy</html>', installSource: STARTER_SOURCE });
    for (let i = 0; i < 2; i++) {
      const { el } = await renderHub();
      act(() => {
        openButton(starterTile(el, STARTER_NAME))!.click();
      });
      await settle();
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    }
    expect(db.listApps()).toHaveLength(1);
  });
});
