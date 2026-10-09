// hubLibraryRefresh.test.tsx — TASK-20261003 K6 (ADR-0072 §3): an app the agent hands in
// while the hub is open appears on the shelf — IN PLACE.
//
// The hub read its library once, at mount. On the local runner an agent hands apps in while
// the user is looking at the hub, and the page announced that with a DOM `CustomEvent` nothing
// listened to (found 2026-10-03): the app was in the file and not on the shelf until a reload.
// The signal is now `libraryRevision` (platform/signals.ts) and the hub re-reads on a bump.
//
// "In place" is the acceptance criterion, not a nicety: a refresh that went back through the
// loading phase would unmount every tile, and with it a rename the user is in the middle of
// typing. So the editor's INPUT NODE and what was typed into it must survive the refresh.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Each case cold-imports the real hub after `vi.resetModules()` (the hubAvailability budget).
vi.setConfig({ testTimeout: 20_000 });

const HTML = (title: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`;

interface Harness {
  HubView: typeof import('../views/HubView.js')['HubView'];
  signals: typeof import('../platform/signals.js');
  db: UserDb;
  turn: number;
}

/** See hubAvailability.test.tsx: a timed-out test must not touch the next one's DOM or act queue. */
let turn = 0;
function stillMyTurn(mine: number): void {
  if (mine !== turn) throw new Error('this test was abandoned (it timed out) — it must not touch the next test’s modules or DOM');
}

async function fresh(): Promise<Harness> {
  const mine = turn;
  vi.resetModules();
  const helper = await import('./userdbTestHelper.js');
  stillMyTurn(mine);
  const db = await helper.installTestUserDb();
  stillMyTurn(mine);
  const signals = await import('../platform/signals.js');
  const hub = await import('../views/HubView.js');
  stillMyTurn(mine);
  return { HubView: hub.HubView, signals, db, turn: mine };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let observer: MutationObserver | undefined;
/** Whether the shelf's loading skeleton was EVER rendered after the first read settled. */
let sawSkeletonAgain = false;

afterEach(() => {
  turn++;
  observer?.disconnect();
  observer = undefined;
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function renderHub(harness: Harness): Promise<void> {
  stillMyTurn(harness.turn);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<harness.HubView />} />
          <Route path="/run/:id" element={<div data-testid="run-route" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
  // From here on a skeleton is a regression: read from the mutation RECORDS, because a
  // loading phase that came and went inside one task is gone from the DOM by callback time.
  sawSkeletonAgain = false;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('.skeleton') || node.querySelector('.skeleton') !== null)) sawSkeletonAgain = true;
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

const tiles = (): HTMLElement[] => [...(container?.querySelectorAll<HTMLElement>('[data-testid="installed-tile"]') ?? [])];
const tileNames = (): string[] => tiles().map((tile) => tile.querySelector('.tile-name')?.textContent ?? '');
const renameInput = (): HTMLInputElement | null => container?.querySelector<HTMLInputElement>('[data-testid="app-rename-input"]') ?? null;

async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => {
    el.click();
  });
}

describe('the hub refreshes its list IN PLACE on a library bump (K6)', () => {
  it('a handed-in app appears without a reload', async () => {
    const harness = await fresh();
    harness.db.installApp({ displayName: 'Pomodoro', html: HTML('Pomodoro') });
    await renderHub(harness);
    expect(tileNames()).toEqual(['Pomodoro']);

    // What the runner's hand-in does: writes the app into the user's file, then says so.
    harness.db.installApp({ displayName: 'Chess', html: HTML('Chess') });
    await settle();
    expect(tileNames(), 'the write alone moves nothing — the bump is the signal').toEqual(['Pomodoro']);

    await act(async () => harness.signals.bumpLibraryRevision());
    await settle();
    expect(tileNames().sort()).toEqual(['Chess', 'Pomodoro']);
  });

  it('never goes back through the loading phase: an open rename editor — the same input node, with what was typed — survives', async () => {
    const harness = await fresh();
    harness.db.installApp({ displayName: 'Pomodoro', html: HTML('Pomodoro') });
    await renderHub(harness);

    await click(tiles()[0]!.querySelector('[data-testid="app-rename"]'));
    const input = renameInput();
    expect(input).not.toBeNull();
    // Uncontrolled (`defaultValue`): the text lives in the DOM node, so a remount loses it.
    input!.value = 'Pomodoro — half typ';

    harness.db.installApp({ displayName: 'Chess', html: HTML('Chess') });
    await act(async () => harness.signals.bumpLibraryRevision());
    await settle();

    expect(tileNames().sort()).toEqual(['Chess', 'Pomodoro']);
    expect(sawSkeletonAgain, 'the shelf must not flash its loading skeleton on a refresh').toBe(false);
    expect(renameInput(), 'the editor is still open').not.toBeNull();
    expect(renameInput(), 'and it is the SAME node — the tile was never unmounted').toBe(input);
    expect(renameInput()!.value).toBe('Pomodoro — half typ');
  });

  it('an app that went away underneath leaves the shelf too', async () => {
    const harness = await fresh();
    const keep = harness.db.installApp({ displayName: 'Pomodoro', html: HTML('Pomodoro') });
    const gone = harness.db.installApp({ displayName: 'Chess', html: HTML('Chess') });
    await renderHub(harness);
    expect(tileNames().sort()).toEqual(['Chess', 'Pomodoro']);

    await harness.db.deleteApp(gone.appId);
    await act(async () => harness.signals.bumpLibraryRevision());
    await settle();
    expect(tileNames()).toEqual(['Pomodoro']);
    expect(tiles()[0]!.querySelector('a.tile-link')?.getAttribute('href')).toBe(`/run/${keep.appId}`);
  });

  it('a refresh that FAILS keeps the shelf it had — a list the user was reading is not replaced by an error', async () => {
    const harness = await fresh();
    harness.db.installApp({ displayName: 'Pomodoro', html: HTML('Pomodoro') });
    await renderHub(harness);
    // The hub's own read (the connections table, one call) — not `listApps`, which the app
    // meta refresh beside it reads too.
    vi.spyOn(harness.db, 'listConnections').mockImplementation(() => {
      throw new Error('the file is busy');
    });
    await act(async () => harness.signals.bumpLibraryRevision());
    await settle();
    expect(tileNames()).toEqual(['Pomodoro']);
    expect(container!.textContent).not.toContain('can’t reach your apps');
  });
});
