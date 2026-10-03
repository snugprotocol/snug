// wizardWalls.test.tsx — TASK-20261003 R3 S4 (ADR-0072 §4): the connection wizard's walls
// read the same offers the shelf and the run route do.
//
// The browser-wall disclosure ("this provider does not accept requests sent from a web
// browser") used to be `getPlatform().kind !== 'desktop'` — so the local runner, whose Node
// process carries the request and has no such wall, told the user their Coinbase connection
// "may fail here", and a shell named `desktop` without the transport would have said nothing.
// It is derived now: the row needs `native-fetch`, and the host either offers it (`fetchImpl`)
// or it does not. Copy and test ids are unchanged.
//
// The two DEVICE walls read the same table: the linked-device wall is the `helper` offer and
// the LAN wall is the `lan` offer — on every shell shape, the half seams included, so the
// tile, the run route and the wizard cannot disagree about the same row.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupWellKnownProvider, requirementFromRegistryEntry } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import { HOST_OFF_CAPABILITIES, hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Every test cold-imports the wizard sheet after `vi.resetModules()`. Under turbo's parallel
// load that is CPU-bound well past vitest's 5000 ms default (the 2026-08-26 db-load flake
// class; `lanWizardFlow`, the same shape, lost a test to it in the 2026-10-03 root run): the
// budget is the fix, not a retry — `appUpdate.test.tsx` is the precedent.
vi.setConfig({ testTimeout: 20_000 });

const APP = 'app-wizard-walls';
const seat = (async () => new Response('')) as never;

/** The local runner: a process carries the request; no LAN seats, no helper seats. */
const runner = (): SnugPlatform =>
  hostFixture({ binding: 'local-host', fetchImpl: seat, capabilities: { ...HOST_OFF_CAPABILITIES, connections: true, appExport: true } });

const bareDesktop = (): SnugPlatform => ({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } });

const bareHue = { slot: 'hue', kind: 'api_key' as const, provider: { name: 'Philips Hue' }, lanHost: { class: 'rfc1918-ipv4-literal' as const, label: 'Bridge IP address' } };
const bareWhatsapp = { slot: 'whatsapp', kind: 'linked_device' as const, provider: { name: 'WhatsApp' }, declaredApiHosts: ['whatsapp.sidecar.localhost'] };

interface Harness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
  Sheet: typeof import('../connections/ConnectionWizardSheet.js')['ConnectionWizardSheet'];
  /** The turn this harness was built in — see `turn`. */
  turn: number;
}

/**
 * Whose turn it is to render. A test that hits its timeout is not cancelled: vitest reports
 * it and starts the next one while the first is still inside its cold `await import(...)`.
 * When that lands, the abandoned body goes on to render and settle — it repoints the
 * module-level `container`/`root`, and the `act()` scope it holds open (React keeps ONE act
 * queue per process) stops the next test's own render from committing. One timeout then
 * reads as a run of unrelated failures (the 2026-10-03 root run, in the two files of this
 * shape that were hit; `hubAvailability.test.tsx` records the reproduction).
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
  const platformModule = await import('../platform/platform.js');
  stillMyTurn(mine);
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  stillMyTurn(mine);
  const db = await helper.installTestUserDb();
  stillMyTurn(mine);
  db.installApp({ appId: APP, displayName: 'Walls', html: '<p>x</p>' });
  const wizard = await import('../state/connectionWizard.js');
  stillMyTurn(mine);
  wizard.__resetConnectionWizardForTests();
  const sheet = await import('../connections/ConnectionWizardSheet.js');
  stillMyTurn(mine);
  return { db, wizard, Sheet: sheet.ConnectionWizardSheet, turn: mine };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function unmount(): Promise<void> {
  if (root !== undefined) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
}

afterEach(async () => {
  turn++;
  await unmount();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(harness: Harness): Promise<void> {
  stillMyTurn(harness.turn);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<harness.Sheet />);
  });
  await settle();
}

const testId = (id: string): HTMLElement | null => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const button = (name: RegExp): HTMLButtonElement | undefined =>
  [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

async function click(name: RegExp): Promise<void> {
  const target = button(name);
  if (target === undefined) throw new Error(`no button matching ${String(name)} — rendered: ${container?.textContent?.slice(0, 300) ?? ''}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** A Coinbase row (registry: `browserCallable: false`), walked to the credentials screen. */
async function coinbaseCredentials(platform?: SnugPlatform): Promise<Harness> {
  const harness = await fresh(platform);
  const requirement = requirementFromRegistryEntry(lookupWellKnownProvider('Coinbase')!, 'Coinbase', 'coinbase');
  harness.db.putDeclaredConnection(APP, 'coinbase', requirement, 'registry' as never);
  harness.db.approveConnection(APP, 'coinbase');
  harness.wizard.openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
  await render(harness);
  await click(/approve this connection/i);
  if (button(/got my credentials/i) !== undefined) await click(/got my credentials/i);
  expect(harness.wizard.connectionWizardStepStore.get()).toBe('credentials');
  return harness;
}

describe('the browser-wall disclosure reads the native-fetch OFFER, never the platform’s kind', () => {
  it('web: discloses, in the words it always used', async () => {
    await coinbaseCredentials();
    const line = testId('browser-callable-disclosure');
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe(
      'one thing to know first: Coinbase does not accept requests sent from a web browser, so this connection may fail here even with the right credentials. It works in the Snug desktop app.',
    );
  });

  it('the local runner: NO disclosure — the process carries the request, so the wall does not exist', async () => {
    await coinbaseCredentials(runner());
    expect(testId('browser-callable-disclosure')).toBeNull();
  });

  it('a shell that CALLS itself desktop but carries no fetchImpl still discloses — a name is not a transport', async () => {
    await coinbaseCredentials(bareDesktop());
    expect(testId('browser-callable-disclosure')).not.toBeNull();
  });

  it('the desktop, with its transport: no disclosure', async () => {
    await coinbaseCredentials({ ...bareDesktop(), fetchImpl: seat });
    expect(testId('browser-callable-disclosure')).toBeNull();
  });
});

describe('the device walls stand wherever the seats are missing — the runner included', () => {
  it('the local runner: a linked-device row gets the wall (no helper seats)', async () => {
    const harness = await fresh(runner());
    harness.db.putDeclaredConnection(APP, 'whatsapp', bareWhatsapp, 'starter');
    harness.wizard.openConnectionWizard({ appId: APP, slot: 'whatsapp', source: 'settings' });
    await render(harness);
    expect(testId('linked-device-wall')).not.toBeNull();
  });

  it('the local runner: a LAN row gets the wall (no LAN seats)', async () => {
    const harness = await fresh(runner());
    harness.db.putDeclaredConnection(APP, 'hue', bareHue, 'inference');
    harness.wizard.openConnectionWizard({ appId: APP, slot: 'hue', source: 'settings' });
    await render(harness);
    expect(testId('lan-desktop-wall')).not.toBeNull();
  });
});

describe('each device wall IS its offer — on every shell shape, the half seams included', () => {
  const desktopWith = (seats: Partial<SnugPlatform>): SnugPlatform => ({ ...bareDesktop(), fetchImpl: seat, ...seats });

  /**
   * What each shell can do, as LITERALS (never read back from `offersOf`, so a slip in the
   * derivation cannot make both sides of the comparison wrong together).
   *
   * The half seams are the point. No shell ships one today — but the linked-device wall once
   * tested two of its three seats and advertised a flow that died at its first step, and a
   * LAN wall that asked for the pairing seat alone would let someone pair a device this host
   * can never run an app against, under a tile that says "needs your home network".
   */
  const shells: Record<string, { platform: SnugPlatform | undefined; lan: boolean; helper: boolean }> = {
    web: { platform: undefined, lan: false, helper: false },
    'the local runner': { platform: runner(), lan: false, helper: false },
    'an artifact': { platform: hostFixture(), lan: false, helper: false },
    'the desktop, every seat': {
      platform: desktopWith({ lanFetch: seat, lanPair: seat, sidecarCtl: seat, sidecarFetch: seat, sidecarWizardFetch: seat }),
      lan: true,
      helper: true,
    },
    'half a helper: lifecycle + the app door, no wizard door': {
      platform: desktopWith({ lanFetch: seat, lanPair: seat, sidecarCtl: seat, sidecarFetch: seat }),
      lan: true,
      helper: false,
    },
    'half a helper: lifecycle + the wizard door, no app door': {
      platform: desktopWith({ lanFetch: seat, lanPair: seat, sidecarCtl: seat, sidecarWizardFetch: seat }),
      lan: true,
      helper: false,
    },
    'half a helper: both doors, nothing to start it': {
      platform: desktopWith({ lanFetch: seat, lanPair: seat, sidecarFetch: seat, sidecarWizardFetch: seat }),
      lan: true,
      helper: false,
    },
    'half a LAN seam: it can pair, but has no pinned transport': {
      platform: desktopWith({ lanPair: seat, sidecarCtl: seat, sidecarFetch: seat, sidecarWizardFetch: seat }),
      lan: false,
      helper: true,
    },
    'half a LAN seam: the pinned transport, but it cannot pair': {
      platform: desktopWith({ lanFetch: seat, sidecarCtl: seat, sidecarFetch: seat, sidecarWizardFetch: seat }),
      lan: false,
      helper: true,
    },
  };

  it.each(Object.entries(shells))('%s', async (_name, { platform, lan, helper }) => {
    const harness = await fresh(platform);
    const { offersOf } = await import('../platform/availability.js');
    const { getPlatform } = await import('../platform/platform.js');
    const offers = offersOf(getPlatform());
    expect({ lan: offers.lan, helper: offers.helper }, 'the offer').toEqual({ lan, helper });
    expect(harness.wizard.canPairLanDevice(), 'the LAN wall’s question').toBe(lan);
    expect(harness.wizard.canLinkDevice(), 'the linked-device wall’s question').toBe(helper);

    // What the user MEETS: the wall stands exactly where the offer is missing.
    harness.db.putDeclaredConnection(APP, 'whatsapp', bareWhatsapp, 'starter');
    harness.db.putDeclaredConnection(APP, 'hue', bareHue, 'inference');
    harness.wizard.openConnectionWizard({ appId: APP, slot: 'whatsapp', source: 'settings' });
    await render(harness);
    expect(testId('linked-device-wall') !== null, 'the linked-device wall is rendered').toBe(!helper);
    expect(testId('lan-desktop-wall'), 'a linked-device row never gets the LAN wall').toBeNull();

    await unmount();
    harness.wizard.closeConnectionWizard();
    harness.wizard.openConnectionWizard({ appId: APP, slot: 'hue', source: 'settings' });
    await render(harness);
    expect(testId('lan-desktop-wall') !== null, 'the LAN wall is rendered').toBe(!lan);
    expect(testId('linked-device-wall'), 'a LAN row never gets the linked-device wall').toBeNull();
    // Behind a LAN wall nothing is offered that could not pay off: no address box, no pair button.
    expect(testId('lan-host-step') !== null, 'the address step').toBe(lan);
  });
});
