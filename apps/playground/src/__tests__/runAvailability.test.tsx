// runAvailability.test.tsx — TASK-20261003 R3 S3 (ADR-0072 §4): the run ROUTE obeys the same
// verdict as the tile. A blocked app's FRAME is replaced by the reason — for a starter preview
// and an installed app alike, so there is no bypass by URL (`#/run/starter--hue` used to walk
// straight past the tile's lock) — while the run HEADER stays: export, versions, docs and the
// connections door, so a blocked app can still be taken somewhere that runs it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import { HOST_OFF_CAPABILITIES, hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Every test cold-imports the REAL run view after `vi.resetModules()`. Under turbo's parallel load that cold import is CPU-bound well past vitest's 5000 ms
// default — the first test here timed out in the 2026-10-03 root run (the 2026-08-26 db-load
// flake class). The budget is the fix, not a retry; `appUpdate.test.tsx` is the precedent.
vi.setConfig({ testTimeout: 20_000 });

const seat = (async () => new Response('')) as never;
const runner = (over: Partial<SnugPlatform['capabilities']> = {}): SnugPlatform =>
  hostFixture({ binding: 'local-host', fetchImpl: seat, capabilities: { ...HOST_OFF_CAPABILITIES, connections: true, appExport: true, ...over } });

interface Harness {
  RunView: typeof import('../run/RunView.js')['default'];
  db: UserDb;
  /** The turn this harness was built in — see `turn`. */
  turn: number;
}

/**
 * Whose turn it is to render. A test that hits its timeout is not cancelled: vitest reports
 * it and starts the next one while the first is still inside its cold `await import(...)`.
 * When that lands, the abandoned body goes on to render and settle — it repoints the
 * module-level `container`/`root`, and the `act()` scope it holds open (React keeps ONE act
 * queue per process) stops the next test's own render from committing. That is how one
 * timeout became nine failures of ten here in the 2026-10-03 root run (the later ones
 * comparing `undefined` with a string); `hubAvailability.test.tsx` records the reproduction.
 * Each `afterEach` ends the turn; a body that finds the turn has moved on stops before it
 * touches anything shared.
 */
let turn = 0;

function stillMyTurn(mine: number): void {
  if (mine !== turn) throw new Error('this test was abandoned (it timed out) — it must not touch the next test’s modules or DOM');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  const mine = turn;
  vi.resetModules();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  localStorage.clear();
  sessionStorage.clear();
  const platformModule = await import('../platform/platform.js');
  stillMyTurn(mine);
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  stillMyTurn(mine);
  const db = await helper.installTestUserDb();
  stillMyTurn(mine);
  const run = await import('../run/RunView.js');
  stillMyTurn(mine);
  return { RunView: run.default, db, turn: mine };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let observer: MutationObserver | undefined;
/** Whether an app frame was EVER in the DOM — "no bypass" is about every moment, not the settled one. */
let sawFrame = false;

/**
 * Did these mutation records ADD an iframe? Read from the records, never from the DOM at
 * callback time: React commits a render and then flushes the effects it scheduled inside one
 * task, so a frame mounted by one commit and removed by the next is already gone when the
 * observer's callback runs — but both the add and the remove are in the records.
 */
const addsFrame = (records: MutationRecord[]): boolean =>
  records.some((record) =>
    [...record.addedNodes].some((node) => node instanceof Element && (node.tagName === 'IFRAME' || node.querySelector('iframe') !== null)),
  );

afterEach(async () => {
  turn++;
  observer?.disconnect();
  observer = undefined;
  if (root !== undefined) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function openRoute(harness: Harness, id: string, nextId?: string): Promise<void> {
  stillMyTurn(harness.turn);
  container = document.createElement('div');
  document.body.appendChild(container);
  sawFrame = false;
  observer = new MutationObserver((records) => {
    if (addsFrame(records)) sawFrame = true;
  });
  observer.observe(container, { childList: true, subtree: true });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${id}`]}>
        {/* A sibling link, so a test can move the SAME mounted RunView to another app. */}
        {nextId !== undefined ? (
          <Link to={`/run/${nextId}`} data-testid="go-next">
            next
          </Link>
        ) : null}
        <Routes>
          <Route path="/run/:id" element={<harness.RunView />} />
          <Route path="/download" element={<div data-testid="download-route" />} />
          <Route path="/" element={<div data-testid="hub-route" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  if (container.querySelector('iframe') !== null) sawFrame = true;
  await settle();
}

const byTestId = (id: string): HTMLElement | null => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const frame = (): HTMLIFrameElement | null => container?.querySelector<HTMLIFrameElement>('[data-testid="frame-wrap"] iframe') ?? null;

async function waitFor(done: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const coinbase = { slot: 'coinbase', provider: { name: 'Coinbase' }, kind: 'api_key', declaredApiHosts: ['api.coinbase.com'] };

function install(db: UserDb, name: string, requirement?: Record<string, unknown>): string {
  const app = db.installApp({ displayName: name, html: `<!doctype html><title>${name}</title><p>${name}</p>` });
  if (requirement !== undefined) db.putDeclaredConnection(app.appId, requirement['slot'] as string, requirement, 'inference');
  return app.appId;
}

describe('a starter this host cannot run — no bypass by URL', () => {
  it('web: /run/starter--hue shows the reason INSTEAD of the frame, with the app’s own identity', async () => {
    const harness = await fresh();
    await openRoute(harness, 'starter--hue');

    const panel = byTestId('run-blocked');
    expect(panel, 'the route says why').not.toBeNull();
    expect(panel!.textContent).toContain('Moodboard can’t run here');
    expect(panel!.textContent).toContain('needs your home network');
    expect(panel!.textContent).toContain('it talks to a device on your home network, and this host cannot reach your home network.');
    expect(panel!.querySelector('.run-blocked-emoji')?.textContent).toBe('🌗');
    const download = panel!.querySelector<HTMLAnchorElement>('[data-testid="run-blocked-download"]');
    expect(download?.getAttribute('href')).toBe('/download');
    expect(download?.textContent).toBe('Snug for Mac');
    // It replaces the FRAME, inside the frame's own slot — never the view.
    expect(byTestId('frame-wrap')?.contains(panel)).toBe(true);
    expect(frame()).toBeNull();
    expect(sawFrame, 'the app frame never mounted, not even for a moment').toBe(false);
  });

  it('web: the header stays for a blocked starter — install, the theme and the think rail are all still there', async () => {
    const harness = await fresh();
    await openRoute(harness, 'starter--hue');
    expect(byTestId('run-blocked')).not.toBeNull();
    expect(byTestId('starter-install')).not.toBeNull();
    expect(byTestId('rail-toggle')).not.toBeNull();
    // The header names the app plainly: a frame that never mounts never announces, and the
    // "connecting…" shimmer would otherwise wait for it forever.
    const header = container!.querySelector('.run-header');
    expect(header?.querySelector('.run-name')?.textContent).toBe('Moodboard');
    expect(header?.textContent).not.toContain('connecting…');
  });

  it('web: Trade Copilot and Telepath are blocked for THEIR reasons', async () => {
    const harness = await fresh();
    await openRoute(harness, 'starter--trade-copilot');
    expect(byTestId('run-blocked')?.textContent).toContain('Trade Copilot can’t run here');
    expect(byTestId('run-blocked')?.textContent).toContain('needs more than a browser');
    expect(byTestId('run-blocked-runs-in')?.textContent).toContain('your agent’s plugin');
    expect(byTestId('run-blocked-runs-in')?.textContent).not.toContain('the web playground');
    expect(sawFrame).toBe(false);
  });

  it('web (positive twin): a starter with no needs mounts its frame and shows no panel', async () => {
    const harness = await fresh();
    await openRoute(harness, 'starter--chess');
    await waitFor(() => frame() !== null, 'the chess frame');
    expect(byTestId('run-blocked')).toBeNull();
    expect(frame()!.getAttribute('sandbox'), 'C2: the sandbox is untouched by this gate').toBe('allow-scripts');
  });

  it('an artifact: a connected starter is DISABLED with the true reason — never "runs in its sample mode"', async () => {
    const harness = await fresh(hostFixture());
    await openRoute(harness, 'starter--weather');
    const panel = byTestId('run-blocked');
    expect(panel?.textContent).toContain('Should I? can’t run here');
    expect(panel?.textContent).toContain('needs live connections');
    expect(panel?.textContent).toContain('connections aren’t available in this host');
    expect(container!.textContent).not.toMatch(/sample mode/);
    expect(sawFrame).toBe(false);
    // Every place it runs, most capable first; only the desktop is a link.
    const places = [...(byTestId('run-blocked-runs-in')?.querySelectorAll('li') ?? [])].map((li) => li.getAttribute('data-runs-in'));
    expect(places).toEqual(['desktop', 'runner', 'web']);
    expect(byTestId('run-blocked-runs-in')?.querySelectorAll('a')).toHaveLength(1);
  });

  it('the local runner: Trade Copilot RUNS — the process carries the request', async () => {
    const harness = await fresh(runner());
    await openRoute(harness, 'starter--trade-copilot');
    await waitFor(() => frame() !== null, 'the trade-copilot frame');
    expect(byTestId('run-blocked')).toBeNull();
  });

  it('a runner whose sign-in port was taken: Gmail is blocked, and "it runs in" names only places that are ELSEWHERE', async () => {
    // A healthy runner runs Gmail, so the class is among the app's places — but this panel is
    // being read inside a runner that just said no. "open Snug from your agent" would send
    // the user in a circle.
    const harness = await fresh(runner({ oauthRedirect: false }));
    await openRoute(harness, 'starter--gmail');
    const panel = byTestId('run-blocked');
    expect(panel?.textContent).toContain('needs a provider sign-in');
    const places = [...(byTestId('run-blocked-runs-in')?.querySelectorAll('li') ?? [])].map((li) => li.getAttribute('data-runs-in'));
    expect(places).toEqual(['desktop', 'web']);
    expect(byTestId('run-blocked-runs-in')?.textContent).not.toContain('your agent’s plugin');
    expect(sawFrame).toBe(false);
  });
});

describe('an installed app this host cannot run', () => {
  it('web: the frame is replaced by the reason, and the header keeps export, the connections door, versions and docs', async () => {
    const harness = await fresh();
    const appId = install(harness.db, 'Portfolio', coinbase);
    await openRoute(harness, appId);
    await waitFor(() => byTestId('run-blocked') !== null, 'the blocked panel');

    expect(byTestId('run-blocked')!.textContent).toContain('Portfolio can’t run here');
    expect(byTestId('run-blocked')!.textContent).toContain('needs more than a browser');
    expect(frame()).toBeNull();
    expect(sawFrame, 'the rows are read BEFORE the frame may mount').toBe(false);

    // The header stays, so a blocked app can still be exported and reconnected elsewhere.
    expect(byTestId('share-app'), 'export / share').not.toBeNull();
    expect(byTestId('manage-connections'), 'the connections door').not.toBeNull();
    const tabs = [...(container!.querySelector('[aria-label="rail tabs"]')?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'));
    expect(tabs).toEqual(expect.arrayContaining(['docs', 'versions']));
    expect(container!.querySelector('.run-header .run-name')?.textContent).toBe('Portfolio');
  });

  it('web (positive twin): the same app with its connection REVOKED runs; so does an app with no row', async () => {
    const harness = await fresh();
    const revoked = install(harness.db, 'Portfolio', coinbase);
    harness.db.approveConnection(revoked, 'coinbase');
    harness.db.revokeConnection(revoked, 'coinbase');
    await openRoute(harness, revoked);
    await waitFor(() => frame() !== null, 'the frame of an app whose only row is revoked');
    expect(byTestId('run-blocked')).toBeNull();
  });

  it('moving from an app that runs to one that cannot never mounts a frame for the second — the verdict is keyed by app', async () => {
    // The route element is not keyed by id, so `/run/A` → `/run/B` re-renders the SAME
    // RunView. If B were judged by A's rows for even one render, B's frame would mount (in
    // B's database namespace) before B's own rows said no.
    const harness = await fresh();
    const runs = install(harness.db, 'Notes');
    const cannot = install(harness.db, 'Portfolio', coinbase);
    await openRoute(harness, runs, cannot);
    await waitFor(() => frame() !== null, 'the first app’s frame');

    let frameAfterMove = false;
    const watch = new MutationObserver((records) => {
      if (addsFrame(records)) frameAfterMove = true;
    });
    watch.observe(container!, { childList: true, subtree: true });
    await act(async () => {
      byTestId('go-next')!.click();
    });
    await waitFor(() => byTestId('run-blocked') !== null, 'the second app’s blocked panel');
    await settle();
    if (addsFrame(watch.takeRecords())) frameAfterMove = true;
    watch.disconnect();

    expect(byTestId('run-blocked')!.textContent).toContain('Portfolio can’t run here');
    expect(frame()).toBeNull();
    expect(frameAfterMove, 'no frame existed at any moment after the move').toBe(false);
  });

  it('the local runner: the same Coinbase app runs', async () => {
    const harness = await fresh(runner());
    const appId = install(harness.db, 'Portfolio', coinbase);
    await openRoute(harness, appId);
    await waitFor(() => frame() !== null, 'the frame under the runner');
    expect(byTestId('run-blocked')).toBeNull();
  });
});
