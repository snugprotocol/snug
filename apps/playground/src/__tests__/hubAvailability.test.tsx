// hubAvailability.test.tsx — TASK-20261003 R3 S2/S3 (ADR-0072 §4): the hub offers only what
// this host can run. Starter tiles obey the ONE derivation (`platform/availability.ts`) at
// FIRST PAINT; installed tiles get the same verdict from their connection rows, read in ONE
// `listConnections()` call inside the hub's existing list resolution.
//
// What this replaces: a `desktopOnly` flag in the hub's look table, checked against
// `kind !== 'desktop'`. It locked Trade Copilot under the local runner (where the process
// carries the request and Coinbase's missing CORS is no wall), left every connected starter
// enabled inside an artifact that has no connections at all, and gated installed apps nowhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import { HOST_OFF_CAPABILITIES, hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Every test cold-imports the REAL hub after `vi.resetModules()`. Under turbo's parallel load that cold import is CPU-bound well past vitest's 5000 ms
// default — the first test here timed out in the 2026-10-03 root run (the 2026-08-26 db-load
// flake class). The budget is the fix, not a retry; `appUpdate.test.tsx` is the precedent.
vi.setConfig({ testTimeout: 20_000 });

const seat = (async () => new Response('')) as never;

/** The local runner: connections through the process, no LAN, no helper (apps/host compose-local). */
const runner = (over: Partial<SnugPlatform['capabilities']> = {}): SnugPlatform =>
  hostFixture({ binding: 'local-host', fetchImpl: seat, capabilities: { ...HOST_OFF_CAPABILITIES, connections: true, appExport: true, ...over } });

/** The desktop shell's seats (apps/desktop platform-desktop.ts carries every one). */
const desktop = (): SnugPlatform => ({
  kind: 'desktop',
  capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  fetchImpl: seat,
  lanFetch: seat,
  lanPair: seat,
  sidecarCtl: seat,
  sidecarFetch: seat,
  sidecarWizardFetch: seat,
});

const KEEPERS = ['adventure quest', 'chess', 'flying pig', 'quiz me'];
const CONNECTED = ['github', 'gmail', 'hue', 'ledger', 'spotify', 'trade copilot', 'weather', 'whatsapp'];

interface Harness {
  HubView: typeof import('../views/HubView.js')['HubView'];
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
 * timeout became a run of failures in the 2026-10-03 root run (the blocked set read `[]`
 * where it expected `['hue', 'whatsapp']`). Reproduced the same day: with this guard
 * switched off, one forced timeout failed 15 of the 16 tests after it, and only itself with
 * the guard on; an abandoned `act()` scope ALONE, rendering nothing, gave the same `[]` —
 * so keeping each test's handles to itself would not have been enough.
 * Each `afterEach` ends the turn; a body that finds the turn has moved on stops before it
 * renders, settles or touches anything shared.
 */
let turn = 0;

function stillMyTurn(mine: number): void {
  if (mine !== turn) throw new Error('this test was abandoned (it timed out) — it must not touch the next test’s modules or DOM');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  const mine = turn;
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  stillMyTurn(mine);
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  stillMyTurn(mine);
  const db = await helper.installTestUserDb();
  stillMyTurn(mine);
  const hub = await import('../views/HubView.js');
  stillMyTurn(mine);
  return { HubView: hub.HubView, db, turn: mine };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  turn++;
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

/** Synchronous on purpose: what is in the DOM when this returns is the FIRST paint. */
function renderHubNow(harness: Harness): void {
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
          <Route path="/download" element={<div data-testid="download-route" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function renderHub(harness: Harness): Promise<void> {
  renderHubNow(harness);
  await settle();
}

const starterTiles = (): HTMLElement[] => [...(container?.querySelectorAll<HTMLElement>('[data-testid="starter-tile"]') ?? [])];
const starterTile = (name: string): HTMLElement => {
  const tile = starterTiles().find((candidate) => candidate.getAttribute('data-starter-name') === name);
  if (tile === undefined) throw new Error(`no starter tile "${name}"`);
  return tile;
};
const control = (tile: HTMLElement): HTMLButtonElement => {
  const button = tile.querySelector<HTMLButtonElement>('.tile-card-button');
  if (button === null) throw new Error('the tile has no control');
  return button;
};
const isBlocked = (tile: HTMLElement): boolean => control(tile).disabled || control(tile).getAttribute('aria-disabled') === 'true';
const blockedStarters = (): string[] =>
  starterTiles()
    .filter(isBlocked)
    .map((tile) => tile.getAttribute('data-starter-name') ?? '')
    .sort();
const reason = (tile: HTMLElement): string => tile.querySelector('[data-testid="tile-blocked-reason"]')?.textContent?.trim() ?? '';

async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => {
    el.click();
  });
}

describe('S2 — starter tiles obey the derivation at first paint', () => {
  it.each([
    ['web', undefined, ['hue', 'trade copilot', 'whatsapp']],
    ['the local runner', runner(), ['hue', 'whatsapp']],
    ['an artifact', hostFixture(), [...CONNECTED]],
    ['the desktop', desktop(), []],
  ] as const)('%s: the blocked set is right in the FIRST paint and never changes after it', async (_name, platform, expected) => {
    const harness = await fresh(platform);
    renderHubNow(harness);
    // No await between the render and this read: a tile that flips after mount is a tile
    // that was clickable (or dead) for as long as a lazy chunk took.
    const first = blockedStarters();
    expect(first).toEqual([...expected].sort());
    expect(starterTiles()).toHaveLength(KEEPERS.length + CONNECTED.length);
    await settle();
    await settle();
    expect(blockedStarters(), 'no tile changed its enabled state after mount').toEqual(first);
  });

  it('web: the three desktop-needing starters look EXACTLY as before — the `desktop` badge, the /download link — each with its own true reason', async () => {
    const harness = await fresh();
    await renderHub(harness);
    const reasons: Record<string, string> = {};
    for (const name of ['hue', 'trade copilot', 'whatsapp']) {
      const tile = starterTile(name);
      const badge = tile.querySelector('[data-testid="desktop-only-badge"]');
      expect(badge, `${name} keeps its badge`).not.toBeNull();
      expect(badge!.textContent?.trim()).toBe('desktop');
      expect(badge!.tagName).toBe('A');
      expect(badge!.getAttribute('href')).toBe('/download');
      expect(badge!.getAttribute('title')).toMatch(/^needs the Snug desktop app \(a free download\) — /);
      expect(control(tile).disabled, `${name} offers no open that cannot work`).toBe(true);
      // The web shelf does NOT grow the new visible note: it renders as it always did.
      expect(tile.querySelector('[data-testid="tile-blocked-reason"]')).toBeNull();
      reasons[name] = `${badge!.getAttribute('title')} | ${control(tile).getAttribute('title')}`;
    }
    // One reason string ("a web page cannot reach your home network") was true for hue only.
    expect(reasons['hue']).toMatch(/home network/);
    expect(reasons['hue']).toMatch(/^.*\| Moodboard needs the free desktop app — /);
    expect(reasons['trade copilot']).toMatch(/turns away requests sent from a web page/);
    expect(reasons['trade copilot']).not.toMatch(/home network/);
    expect(reasons['whatsapp']).toMatch(/helper program/);
    expect(reasons['whatsapp']).not.toMatch(/home network/);
  });

  it('web: gmail and every other connected starter stay enabled, with no badge and no note', async () => {
    const harness = await fresh();
    await renderHub(harness);
    for (const name of ['gmail', 'github', 'ledger', 'spotify', 'weather', ...KEEPERS]) {
      const tile = starterTile(name);
      expect(isBlocked(tile), name).toBe(false);
      expect(tile.querySelector('[data-testid="desktop-only-badge"]')).toBeNull();
      expect(tile.querySelector('[data-testid="tile-blocked-reason"]')).toBeNull();
    }
  });

  it('the local runner: Trade Copilot is ENABLED; Moodboard and Telepath are disabled, each for its own reason, as visible text', async () => {
    const harness = await fresh(runner());
    await renderHub(harness);

    expect(isBlocked(starterTile('trade copilot')), 'a process carries the request — Coinbase’s missing CORS is no wall').toBe(false);
    expect(reason(starterTile('hue'))).toBe('needs your home network');
    expect(reason(starterTile('whatsapp'))).toBe('needs the phone helper');
    // The badge is the WEB shelf's; elsewhere the reason is text a person can read without hovering.
    expect(container!.querySelector('[data-testid="desktop-only-badge"]')).toBeNull();
  });

  it('a blocked tile stays focusable, describes itself, links to where it runs — and activating it does nothing', async () => {
    const harness = await fresh(runner());
    await renderHub(harness);
    const tile = starterTile('hue');
    const button = control(tile);

    expect(button.disabled, 'aria-disabled, never the disabled attribute: the reason must be reachable by keyboard').toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const note = container!.querySelector(`[id="${describedBy}"]`);
    expect(note?.textContent).toContain('needs your home network');
    expect(note?.textContent).toContain('runs in');
    button.focus();
    expect(document.activeElement).toBe(button);

    const link = tile.querySelector<HTMLAnchorElement>('[data-testid="runs-in-desktop"]');
    expect(link?.getAttribute('href')).toBe('/download');
    expect(link?.textContent).toBe('Snug for Mac');

    await click(button);
    expect(container!.querySelector('[data-testid="run-route"]'), 'no navigation from a blocked tile').toBeNull();
    expect(container!.querySelector('[data-testid="starter-tile"]')).not.toBeNull();

    // The positive twin: an enabled tile on the same shelf does navigate.
    await click(control(starterTile('chess')));
    expect(container!.querySelector('[data-testid="run-route"]')).not.toBeNull();
  });

  it('the runner whose sign-in port was taken: the OAuth starters go, the key-based ones stay', async () => {
    const harness = await fresh(runner({ oauthRedirect: false }));
    await renderHub(harness);
    expect(blockedStarters()).toEqual(['gmail', 'hue', 'spotify', 'whatsapp']);
    expect(reason(starterTile('gmail'))).toBe('needs a provider sign-in');
    expect(isBlocked(starterTile('weather'))).toBe(false);
  });

  it('a degraded runner never sends its user to "your agent’s plugin" — they are already in it', async () => {
    // `runsIn` names host CLASSES that run the app when nothing is wrong with them, and a
    // healthy runner does run Gmail. This one's sign-in port was taken, so the tile is
    // blocked HERE — and "runs in … your agent's plugin" would point at the host that just
    // said no. The places left are the ones that are somewhere else.
    const harness = await fresh(runner({ oauthRedirect: false }));
    await renderHub(harness);
    const runsIn = starterTile('gmail').querySelector('[data-testid="tile-runs-in"]')?.textContent;
    expect(runsIn).toBe('runs in Snug for Mac · the web playground');
    expect(runsIn).not.toContain('your agent’s plugin');
    // The device starters were never the runner's: nothing to drop, and the desktop stays.
    expect(starterTile('hue').querySelector('[data-testid="tile-runs-in"]')?.textContent).toBe('runs in Snug for Mac');
  });

  it('an artifact: every connected starter is disabled with its reason; the four keepers play', async () => {
    const harness = await fresh(hostFixture());
    await renderHub(harness);
    const reasons = Object.fromEntries(CONNECTED.map((name) => [name, reason(starterTile(name))]));
    expect(reasons).toEqual({
      github: 'needs live connections',
      gmail: 'needs live connections',
      hue: 'needs your home network',
      ledger: 'needs live connections',
      spotify: 'needs live connections',
      'trade copilot': 'needs live connections',
      weather: 'needs live connections',
      whatsapp: 'needs the phone helper',
    });
    for (const name of KEEPERS) expect(isBlocked(starterTile(name)), name).toBe(false);
    // Trade Copilot's provider refuses browsers, so "the web playground" is not among its places.
    expect(starterTile('trade copilot').querySelector('[data-testid="tile-runs-in"]')?.textContent).toBe('runs in Snug for Mac · your agent’s plugin');
    expect(starterTile('weather').querySelector('[data-testid="tile-runs-in"]')?.textContent).toBe(
      'runs in Snug for Mac · your agent’s plugin · the web playground',
    );
  });

  it('the desktop: nothing is blocked, nothing is annotated', async () => {
    const harness = await fresh(desktop());
    await renderHub(harness);
    expect(blockedStarters()).toEqual([]);
    expect(container!.querySelector('[data-testid="tile-blocked-reason"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-only-badge"]')).toBeNull();
  });
});

describe('S3 — installed tiles get the verdict their connection rows earn', () => {
  const coinbase = { slot: 'coinbase', provider: { name: 'Coinbase' }, kind: 'api_key', declaredApiHosts: ['api.coinbase.com'] };
  const weather = { slot: 'openweather', provider: { name: 'OpenWeather' }, kind: 'api_key', declaredApiHosts: ['api.openweathermap.org'] };
  const hue = { slot: 'hue', provider: { name: 'Philips Hue' }, kind: 'api_key', lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' } };
  // examples/spotify/connection.json, byte for byte in shape.
  const spotify = { slot: 'spotify', provider: { name: 'Spotify', docsUrl: 'https://developer.spotify.com/documentation/web-api' }, kind: 'oauth2_auth_code', declaredApiHosts: ['api.spotify.com'] };

  /** A finished sign-in, as `OAuthService` persists it: through the slot's credential store. */
  async function signInWithSpotify(db: UserDb, appId: string): Promise<void> {
    const { SlotScopedCredentialStore, UserDbCredentialStore } = await import('@snugprotocol/auth');
    const store = new SlotScopedCredentialStore(new UserDbCredentialStore(db), 'spotify');
    await store.setCredential(appId, 'access_token', 'at-from-spotify');
    await store.setCredential(appId, 'refresh_token', 'rt-from-spotify');
    await store.setConnectionState(appId, { status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 });
  }

  function install(db: UserDb, name: string, requirement?: Record<string, unknown>): string {
    const app = db.installApp({ displayName: name, html: `<p>${name}</p>` });
    if (requirement !== undefined) db.putDeclaredConnection(app.appId, requirement['slot'] as string, requirement, 'inference');
    return app.appId;
  }

  const installedTile = (name: string): HTMLElement => {
    const tile = [...(container?.querySelectorAll<HTMLElement>('[data-testid="installed-tile"]') ?? [])].find(
      (candidate) => candidate.querySelector('.tile-name')?.textContent === name,
    );
    if (tile === undefined) throw new Error(`no installed tile "${name}"`);
    return tile;
  };

  it('web: an app whose provider refuses browsers is disabled with the reason; rename and delete stay', async () => {
    const harness = await fresh();
    install(harness.db, 'Portfolio', coinbase);
    install(harness.db, 'Umbrella', weather);
    install(harness.db, 'Notes');
    await renderHub(harness);

    const blocked = installedTile('Portfolio');
    const button = blocked.querySelector<HTMLElement>('.tile-link')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.tagName, 'a blocked tile is not a link to the run route').not.toBe('A');
    expect(reason(blocked)).toBe('needs more than a browser');
    expect(container!.querySelector(`[id="${button.getAttribute('aria-describedby')}"]`)?.textContent).toContain('runs in');
    expect(blocked.querySelector('[data-testid="app-rename"]'), 'rename stays').not.toBeNull();
    expect(blocked.querySelector('[data-testid="app-delete"]'), 'delete stays').not.toBeNull();

    await click(button);
    expect(container!.querySelector('[data-testid="run-route"]')).toBeNull();

    // The positive twins: a browser-callable connection and an app with no row are links.
    for (const name of ['Umbrella', 'Notes']) {
      const tile = installedTile(name);
      expect(tile.querySelector('.tile-link')?.tagName, name).toBe('A');
      expect(tile.querySelector('[data-testid="tile-blocked-reason"]'), name).toBeNull();
    }
  });

  it('a blocked installed tile keeps a quiet "details" link to its run route — the one door to its export', async () => {
    // The run route explains the block and keeps the header (export, versions, docs, the
    // connections door — runAvailability.test.tsx), so that is where a blocked app is
    // exported from (orchestrator decision, 2026-10-03). Before this link the route was
    // reachable only by typing its URL: the tile's own control has no handler.
    const harness = await fresh(runner());
    const lights = install(harness.db, 'Lights', hue);
    install(harness.db, 'Portfolio', coinbase);
    await renderHub(harness);

    const blocked = installedTile('Lights');
    const button = blocked.querySelector<HTMLElement>('.tile-link')!;
    const details = blocked.querySelector<HTMLAnchorElement>('[data-testid="tile-blocked-details"]');
    if (details === null) throw new Error('the blocked tile has no details link');

    // A real link, so it is in the tab order and Enter follows it — nothing scripted.
    expect(details.tagName).toBe('A');
    expect(details.getAttribute('href')).toBe(`/run/${lights}`);
    expect(details.hasAttribute('tabindex'), 'never taken out of the tab order').toBe(false);
    expect(details.getAttribute('aria-disabled')).toBeNull();
    details.focus();
    expect(document.activeElement).toBe(details);
    // The visible word, and a name that says WHICH app in a list of links.
    expect(details.textContent).toBe('details');
    expect(details.getAttribute('aria-label')).toBe('details for Lights');

    // The tile itself is unchanged: still aria-disabled, still not a link, still inert —
    // and the link is its sibling, never inside the control that will not activate.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.tagName).toBe('BUTTON');
    expect(button.contains(details)).toBe(false);
    expect(blocked.querySelector('[data-testid="app-rename"]'), 'rename stays').not.toBeNull();
    expect(blocked.querySelector('[data-testid="app-delete"]'), 'delete stays').not.toBeNull();
    await click(button);
    expect(container!.querySelector('[data-testid="run-route"]')).toBeNull();

    // ONE link on the whole hub: an app this host runs opens from its tile and needs no
    // second door, and a blocked STARTER (hue and whatsapp here) has nothing to export.
    expect(installedTile('Portfolio').querySelector('.tile-link')?.tagName).toBe('A');
    expect(blockedStarters()).toEqual(['hue', 'whatsapp']);
    expect([...container!.querySelectorAll('[data-testid="tile-blocked-details"]')]).toEqual([details]);

    await click(details);
    expect(container!.querySelector('[data-testid="run-route"]'), 'the details link opens the run route').not.toBeNull();
  });

  it('the details link is still there while a delete is being confirmed — the last moment to take the app somewhere else', async () => {
    // Why it lives in the blocked note and not in the rename/delete row: that row is
    // REPLACED by the confirm ("delete for good?"), which is exactly when someone asks
    // whether the app can be exported first.
    const harness = await fresh();
    const portfolio = install(harness.db, 'Portfolio', coinbase);
    await renderHub(harness);
    const tile = installedTile('Portfolio');
    const details = (): HTMLAnchorElement | null => tile.querySelector<HTMLAnchorElement>('[data-testid="tile-blocked-details"]');
    expect(details()?.getAttribute('href')).toBe(`/run/${portfolio}`);

    await click(tile.querySelector('[data-testid="app-delete"]'));
    expect(tile.querySelector('[data-testid="app-delete-confirm"]')).not.toBeNull();
    expect(details()?.getAttribute('href')).toBe(`/run/${portfolio}`);

    await click(tile.querySelector('[data-testid="app-delete-cancel"]'));
    await click(tile.querySelector('[data-testid="app-rename"]'));
    expect(tile.querySelector('[data-testid="app-rename-input"]')).not.toBeNull();
    expect(details()?.getAttribute('href')).toBe(`/run/${portfolio}`);
  });

  it('the details link is QUIET and has a finger-sized target — the two things jsdom cannot see', () => {
    // Read from the stylesheet, because jsdom lays nothing out. Without this rule the link
    // falls back to the page's `a`: the accent colour (which on a blocked tile belongs to
    // where the app DOES run) on a 12px line with no room around it. The numbers were
    // measured in Chromium at a 375px viewport (2026-10-03, availability.css) — change them
    // there and here together, after measuring again.
    const css = readFileSync(join(process.cwd(), 'src', 'theme', 'availability.css'), 'utf8');
    const rule = /(?:^|\n)\.tile-blocked-details\s*\{([^}]*)\}/.exec(css)?.[1];
    if (rule === undefined) throw new Error('no .tile-blocked-details rule in availability.css');
    expect(rule).toMatch(/\bcolor:\s*var\(--fg-muted\)/);
    expect(rule, 'never the accent').not.toMatch(/--ember/);
    expect(rule, 'still plainly a link').toMatch(/text-decoration:\s*underline/);
    // The target: 6px above and below the text line, given back to the layout by the margin.
    expect(rule).toMatch(/\bpadding:\s*6px\b/);
    expect(rule).toMatch(/\bmargin:\s*-6px\b/);
  });

  it('declared and approved rows count; a revoked row does not', async () => {
    const harness = await fresh();
    const declared = install(harness.db, 'Declared', coinbase);
    const approved = install(harness.db, 'Approved', coinbase);
    const revoked = install(harness.db, 'Revoked', coinbase);
    harness.db.approveConnection(approved, 'coinbase');
    harness.db.approveConnection(revoked, 'coinbase');
    harness.db.revokeConnection(revoked, 'coinbase');
    expect(harness.db.getConnection(declared, 'coinbase')?.status).toBe('declared');
    await renderHub(harness);

    expect(reason(installedTile('Declared'))).toBe('needs more than a browser');
    expect(reason(installedTile('Approved'))).toBe('needs more than a browser');
    expect(installedTile('Revoked').querySelector('.tile-link')?.tagName).toBe('A');
  });

  it('the local runner: the same Coinbase app RUNS; a Hue app does not', async () => {
    const harness = await fresh(runner());
    install(harness.db, 'Portfolio', coinbase);
    install(harness.db, 'Lights', hue);
    await renderHub(harness);

    expect(installedTile('Portfolio').querySelector('.tile-link')?.tagName).toBe('A');
    expect(reason(installedTile('Lights'))).toBe('needs your home network');
  });

  it('a runner whose sign-in port was taken: an OAuth app already signed in RUNS on its tokens; one still owed its sign-in does not', async () => {
    // Gate 5 seams/F1: the redirect is needed to sign IN. Counting it for every OAuth row
    // blocked every connected Spotify/Gmail app on a runner that fell back to an ephemeral
    // port, with "that sign-in has no way back to this host" — false for an app that needs
    // no sign-in. The tokens are written by the store classes the OAuth service writes through.
    const harness = await fresh(runner({ oauthRedirect: false }));
    const rewind = install(harness.db, 'Rewind', spotify);
    const pending = install(harness.db, 'Pending', spotify);
    const declared = install(harness.db, 'Declared', spotify);
    harness.db.approveConnection(rewind, 'spotify');
    harness.db.approveConnection(pending, 'spotify');
    await signInWithSpotify(harness.db, rewind);
    await renderHub(harness);

    expect(installedTile('Rewind').querySelector('.tile-link')?.tagName, 'signed in: a link to its run route').toBe('A');
    expect(installedTile('Rewind').querySelector('[data-testid="tile-blocked-reason"]')).toBeNull();
    expect(reason(installedTile('Pending')), 'approved, never signed in').toBe('needs a provider sign-in');
    expect(reason(installedTile('Declared')), 'not even approved').toBe('needs a provider sign-in');
    expect(harness.db.getConnection(declared, 'spotify')?.status).toBe('declared');
  });

  it('reads every app’s rows in ONE listConnections() call — never one per tile', async () => {
    const harness = await fresh();
    for (const name of ['One', 'Two', 'Three', 'Four']) install(harness.db, name, coinbase);
    const spy = vi.spyOn(harness.db, 'listConnections');
    await renderHub(harness);
    await settle();

    expect(container!.querySelectorAll('[data-testid="installed-tile"]')).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0], 'the whole table, not one app’s slice').toEqual([]);
  });
});
