// The LAN-class wizard journey (ADR-0023 D1/D2/D4; TASK-20260812 P5-flow).
//
// THE BINDING ORDER IS THE SUBJECT OF THIS FILE, and it is structural rather
// than advisory (P5-shape journaled why): a pre-collection LAN row derives an
// EMPTY ceiling from `deriveConnectionAllowedHosts`, so pairing fired before
// approval would have no ceiling to run against. Hence
//
//     collect the bridge address → approve the row (ceiling freezes) → pair
//
// and every test below asserts one link of that chain by OUTCOME (lesson
// 2026-08-04), never by a proxy such as "a screen rendered".
//
// C1 IS THE OTHER SUBJECT. The minted application key is created by the device
// and never typed, so the only surface that ever holds it is the pairing step.
// It must go straight to `snug_secrets` and appear NOWHERE else: not in a
// store, not in the DOM, not in an error string. Those are the negatives at the
// bottom of this file, and they scan rather than assert-by-inspection.
//
// WHAT IS DELIBERATELY *NOT* TESTED HERE: the Rust host-class check, the pin
// verifier, and the executor's routing. Those live in `apps/desktop` and
// `packages/auth` and are complete there. This file owns the WIZARD.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-lan-wizard';
const SLOT = 'hue';
const BRIDGE = '192.168.1.50';
const PIN = 'b'.repeat(64);
const MINTED = 'JqZ8-minted-application-key-9xQ';

/**
 * The BARE hue declaration — no `fields`, no `request`, and NO
 * `declaredApiHosts` yet, which is the pre-collection LAN row the schema's
 * required-XOR-lanHost rule exists to make representable. Admission substitutes
 * the registry's pinned seats; the address is the one thing the registry cannot
 * supply, because it is the user's.
 */
const bareHue = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Philips Hue' },
  lanHost: { class: 'rfc1918-ipv4-literal' as const, label: 'Bridge IP address' },
};

interface PairCall {
  url: string;
  init: { method: string; body?: string; headers?: Record<string, string> };
}

interface LanFetchCall {
  url: string;
  init: RequestInit;
  pin: string;
}

interface FakeDesktop {
  platform: SnugPlatform;
  pairCalls: PairCall[];
  fetchCalls: string[];
  /** Every PINNED request — the verify probe rides here (ADR-0025). */
  lanFetchCalls: LanFetchCall[];
  /** What the next `lanPair` resolves to (or throws, when set to an Error). */
  pairResult: { status: number; body: string; pin?: { fingerprint: string; cn: string } } | Error;
  /** What the next pinned `lanFetch` answers (or throws, when set to an Error). */
  lanFetchResult: { status: number } | Error;
  discoveryBody: string;
}

function fakeDesktop(): FakeDesktop {
  const state: FakeDesktop = {
    pairCalls: [],
    fetchCalls: [],
    lanFetchCalls: [],
    pairResult: {
      status: 200,
      body: JSON.stringify([{ success: { username: MINTED, clientkey: 'ENTERTAINMENT-KEY' } }]),
      pin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' },
    },
    lanFetchResult: { status: 200 },
    discoveryBody: JSON.stringify([{ id: 'ecb5faff', internalipaddress: BRIDGE }]),
    platform: {
      kind: 'desktop',
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
      fetchImpl: async (url) => {
        state.fetchCalls.push(url);
        return new Response(state.discoveryBody, { status: 200 });
      },
      lanFetch: async (url, init, pin) => {
        state.lanFetchCalls.push({ url, init, pin });
        if (state.lanFetchResult instanceof Error) throw state.lanFetchResult;
        // The verify probe must never read the body — an empty one keeps that honest.
        return new Response('', { status: state.lanFetchResult.status });
      },
      lanPair: async (url, init) => {
        state.pairCalls.push({ url, init });
        if (state.pairResult instanceof Error) throw state.pairResult;
        return state.pairResult;
      },
    },
  };
  return state;
}

function webPlatform(): SnugPlatform {
  return { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };
}

interface Harness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
  Sheet: typeof import('../connections/ConnectionWizardSheet.js')['ConnectionWizardSheet'];
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  db.installApp({ appId: APP, displayName: 'Lights', html: '<p>lights</p>' });
  db.putDeclaredConnection(APP, SLOT, bareHue, 'inference');
  const wizard = await import('../state/connectionWizard.js');
  wizard.__resetConnectionWizardForTests();
  const sheet = await import('../connections/ConnectionWizardSheet.js');
  return { db, wizard, Sheet: sheet.ConnectionWizardSheet };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function settleUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !done(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await settle();
}

function testId(id: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

async function click(el: HTMLElement | undefined | null): Promise<void> {
  expect(el, 'the element to click must exist').toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

// ---------------------------------------------------------------------------
// The address step (ADR-0023 D1)
// ---------------------------------------------------------------------------

describe('collecting the bridge address', () => {
  it('a pre-collection LAN row shows the address step BEFORE the review approve button', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    // The address step OWNS the screen — the approve button belongs to the review
    // that comes after it, and offering both would let a user approve a row with
    // an empty ceiling (which refuses everything, silently).
    expect(testId('lan-host-step'), 'the address step renders for a lanHost requirement').not.toBeNull();
    expect(button(/approve this connection/i), 'approve is not reachable before the address exists').toBeUndefined();
  });

  it('refuses a non-RFC-1918 address in the user\'s own words, and writes nothing', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    const input = testId('lan-host-input') as HTMLInputElement;
    await type(input, '8.8.8.8');
    await click(button(/^use this address$/i));

    const error = testId('lan-host-error');
    expect(error?.textContent ?? '').toMatch(/home network/i);
    // The OUTCOME, not the copy: nothing reached the row.
    expect(harness.db.getConnection(APP, SLOT)?.requirement.declaredApiHosts).toBeUndefined();
  });

  it.each([
    ['a DNS name', 'bridge.local'],
    ['loopback', '127.0.0.1'],
    ['link-local', '169.254.10.1'],
    ['IPv6', 'fd00::1'],
    ['a URL rather than an address', 'https://192.168.1.50'],
    ['an address with a port', '192.168.1.50:443'],
  ])('refuses %s', async (_label, value) => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    await type(testId('lan-host-input') as HTMLInputElement, value);
    await click(button(/^use this address$/i));

    expect(testId('lan-host-error'), `${value} must be refused`).not.toBeNull();
    expect(harness.db.getConnection(APP, SLOT)?.requirement.declaredApiHosts).toBeUndefined();
  });

  it('an accepted address lands in declaredApiHosts and the review then freezes it into the ceiling', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    await type(testId('lan-host-input') as HTMLInputElement, BRIDGE);
    await click(button(/^use this address$/i));

    // Link 1: the address is on the ROW (still `declared` — nothing frozen yet).
    const afterCollect = harness.db.getConnection(APP, SLOT);
    expect(afterCollect?.requirement.declaredApiHosts).toEqual([BRIDGE]);
    expect(afterCollect?.status).toBe('declared');
    // The user entered it themselves, so the row is `user`-provenance from here on.
    expect(afterCollect?.provenance).toBe('user');

    // Link 2: the review screen now renders, and approving freezes the ceiling.
    await click(button(/approve this connection/i));
    const approved = harness.db.getConnection(APP, SLOT);
    expect(approved?.status).toBe('approved');
    expect(approved?.allowedHosts).toEqual([BRIDGE]);
  });

  it('a whitespace-padded address is accepted (a pasted value carries spaces)', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    await type(testId('lan-host-input') as HTMLInputElement, `  ${BRIDGE}  `);
    await click(button(/^use this address$/i));

    expect(harness.db.getConnection(APP, SLOT)?.requirement.declaredApiHosts).toEqual([BRIDGE]);
  });
});

// ---------------------------------------------------------------------------
// Discovery (ADR-0023 D4) — desktop only, skippable, manual entry primary
// ---------------------------------------------------------------------------

describe('the "find my bridge" button', () => {
  it('offers each returned internalipaddress as a choice that fills the input', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    await click(button(/find my bridge/i));
    await settleUntil(() => testId('lan-discovery-choice-0') !== null);

    expect(desktop.fetchCalls).toEqual(['https://discovery.meethue.com']);
    const choice = testId('lan-discovery-choice-0');
    expect(choice?.textContent).toContain(BRIDGE);

    // A choice FILLS the box — it never submits on the user's behalf, because the
    // address is the thing being consented to.
    await click(choice);
    expect((testId('lan-host-input') as HTMLInputElement).value).toBe(BRIDGE);
    expect(harness.db.getConnection(APP, SLOT)?.requirement.declaredApiHosts).toBeUndefined();
  });

  it('an empty discovery answer says so honestly and leaves manual entry working', async () => {
    const desktop = fakeDesktop();
    desktop.discoveryBody = '[]';
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    await click(button(/find my bridge/i));
    await settleUntil(() => testId('lan-discovery-note') !== null);

    expect(testId('lan-discovery-note')?.textContent ?? '').toMatch(/didn't find|couldn't find|no bridge/i);
    expect(testId('lan-host-input'), 'manual entry survives a failed discovery').not.toBeNull();
  });

  it('is absent on web — discovery is a desktop capability', async () => {
    const harness = await fresh(webPlatform());
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    expect(button(/find my bridge/i)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pairing (ADR-0023 D2) — after approval, against the frozen ceiling
// ---------------------------------------------------------------------------

async function collectAndApprove(harness: Harness): Promise<void> {
  await type(testId('lan-host-input') as HTMLInputElement, BRIDGE);
  await click(button(/^use this address$/i));
  await click(button(/approve this connection/i));
}

describe('the pairing step', () => {
  it('renders the link-button precondition BEFORE firing anything', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    expect(testId('lan-pair-step'), 'the pairing step follows approval').not.toBeNull();
    // The registry's own copy, verbatim — it is the difference between a working
    // pairing and an unexplained failure.
    expect(testId('lan-pair-precondition')?.textContent ?? '').toMatch(/link button/i);
    expect(desktop.pairCalls, 'nothing is sent until the user says they pressed it').toEqual([]);
  });

  it('runs the exchange against the FROZEN ceiling host and writes key + pin in one step', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => desktop.pairCalls.length > 0);

    // The URL is built from the approved row's own ceiling host + the registry's
    // pinned path — never from anything typed at pairing time.
    expect(desktop.pairCalls[0]?.url).toBe(`https://${BRIDGE}/api`);
    expect(desktop.pairCalls[0]?.init.method).toBe('POST');
    expect(JSON.parse(desktop.pairCalls[0]?.init.body ?? '{}')).toEqual({
      devicetype: 'snug#hub',
      generateclientkey: true,
    });

    await settleUntil(() => harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`) !== undefined);

    // BOTH writes, in one step — a key with no pin is a connection that fails every
    // later request, and a pin with no key is a paired device nothing can talk to.
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBe(MINTED);
    const state = JSON.parse(harness.db.getSecret(`auth:${APP}:${SLOT}:_connection`) ?? '{}');
    expect(state.lanPin).toEqual({ fingerprint: PIN, cn: 'ECB5FAFFFE123456' });
  });

  it('refuses to record when the exchange captured NO pin — absent, never fabricated', async () => {
    const desktop = fakeDesktop();
    desktop.pairResult = {
      status: 200,
      body: JSON.stringify([{ success: { username: MINTED } }]),
      // no `pin` — the verifier never ran
    };
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    // NEITHER is written: a key stored against no pin would fail every request
    // afterwards with a handshake error pointing nowhere near here.
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBeUndefined();
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:_connection`)).toBeUndefined();
  });

  it('names the link-button failure distinctly (Hue error type 101)', async () => {
    const desktop = fakeDesktop();
    desktop.pairResult = {
      status: 200,
      body: JSON.stringify([{ error: { type: 101, address: '', description: 'link button not pressed' } }]),
      pin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' },
    };
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    const message = testId('lan-pair-error')?.textContent ?? '';
    expect(message).toMatch(/round button/i);
    expect(message).toMatch(/try again/i);
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBeUndefined();
  });

  it('names an unreachable bridge distinctly from a refused link button (no swallowing)', async () => {
    const desktop = fakeDesktop();
    desktop.pairResult = new Error('lan_fetch: request failed: connection refused');
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    const message = testId('lan-pair-error')?.textContent ?? '';
    expect(message).toMatch(/couldn't reach|could not reach/i);
    // DISTINCT from the link-button copy — the P1 lesson: three causes, three sentences.
    expect(message).not.toMatch(/round button/i);
  });

  it('never echoes the device response body into the error copy (C1)', async () => {
    const desktop = fakeDesktop();
    desktop.pairResult = {
      status: 200,
      // A hostile/odd device answering with something that LOOKS like a credential.
      body: JSON.stringify([{ error: { type: 7, description: `leaked-${MINTED}` } }]),
      pin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' },
    };
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    expect(container?.textContent ?? '').not.toContain(MINTED);
    expect(container?.textContent ?? '').not.toContain('leaked-');
  });

  it('pairing is unreachable before approval — the store refuses, not just the screen', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    // Drive the STORE directly, past every screen: a `declared` row has no frozen
    // ceiling, so there is nothing for the exchange to run against.
    const outcome = await harness.wizard.runLanPairing();
    expect(outcome.ok).toBe(false);
    expect(desktop.pairCalls).toEqual([]);
  });

  /**
   * THE STATUS GUARD, DRIVEN DIRECTLY — added because deleting it left the whole
   * file green (the lane's own recurring lesson, third instance).
   *
   * The test above CANNOT kill that mutant: a pre-collection row has no host
   * either, so the host guard beside the status guard refuses it first and the
   * status guard's deletion is masked. The discriminating input is a row with a
   * COLLECTED address that is not yet approved — the exact state a user is in
   * between typing the address and pressing approve, and the one state in which
   * a stray pairing call would run against an UNFROZEN ceiling.
   *
   * (P5-shape journaled this shape as "when you add a guard AND a null-safe
   * accessor in the same edit, mutate them SEPARATELY". Here it is two guards
   * rather than a guard and an accessor, and the masking is identical: whichever
   * one runs first makes the other look load-bearing.)
   */
  it('a COLLECTED-but-unapproved row is refused by the STATUS guard specifically', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    // Collect the address, then STOP — do not approve.
    await type(testId('lan-host-input') as HTMLInputElement, BRIDGE);
    await click(button(/^use this address$/i));
    const row = harness.db.getConnection(APP, SLOT);
    expect(row?.requirement.declaredApiHosts, 'the host guard must now be SATISFIED').toEqual([BRIDGE]);
    expect(row?.status).toBe('declared');

    const outcome = await harness.wizard.runLanPairing();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/approve this connection/i);
    // The OUTCOME, not the message: no exchange ran against an unfrozen ceiling.
    expect(desktop.pairCalls).toEqual([]);
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBeUndefined();
  });

  /**
   * THE HOST GUARD IS DEFENCE IN DEPTH, AND THIS TEST SAYS SO RATHER THAN
   * PRETENDING OTHERWISE — recorded because the honest version of this finding is
   * worth more than a test that cannot fail.
   *
   * The first draft asserted the pairing seat's own host check by approving a
   * LAN row around a public host. Admission REFUSED the fixture — correctly
   * (amendment 10c), and a probe over every channel × three off-class ceilings
   * (public host, two private hosts, private+public) confirmed there is NO
   * production path to an approved LAN row whose ceiling is not exactly one
   * RFC-1918 literal. So the guard inside `runLanPairing` cannot be reached from
   * any state the system can produce, and a mutation test for it would have to
   * forge a row the db itself will not write.
   *
   * That makes it belt to admission's braces, kept deliberately (the pairing
   * seat states its own precondition rather than trusting an earlier gate), and
   * what this test pins is the BRACES — the guard that is actually load-bearing,
   * asserted at the altitude where the decision is made (lesson 2026-08-05).
   */
  it('admission — not the pairing seat — is what stops an off-class LAN ceiling existing at all', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    for (const hosts of [['api.example.com'], [BRIDGE, '192.168.1.51'], [BRIDGE, 'api.example.com']]) {
      expect(() =>
        harness.db.putDeclaredConnection(
          APP,
          'hue-offclass',
          { ...bareHue, slot: 'hue-offclass', declaredApiHosts: hosts },
          'user',
        ),
      ).toThrow(/LAN-class provider/);
    }
    expect(harness.db.getConnection(APP, 'hue-offclass')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C1 negatives — the minted key never leaves snug_secrets
// ---------------------------------------------------------------------------

describe('C1 — the minted key is invisible everywhere but snug_secrets', () => {
  it('never appears in the DOM, in any store, or in the row', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);
    await click(button(/i pressed the button/i));
    await settleUntil(() => harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`) !== undefined);
    await settle();

    // DOM scan — text AND every attribute value (a key parked in a data-* or a
    // `value` would be just as leaked as one in a text node).
    expect(document.body.textContent ?? '').not.toContain(MINTED);
    for (const el of document.body.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.value, `${attr.name} must not carry the minted key`).not.toContain(MINTED);
      }
      if (el instanceof HTMLInputElement) expect(el.value).not.toContain(MINTED);
    }

    // STORE scan — every exported wizard store, serialized.
    const stores = Object.entries(harness.wizard).filter(
      ([name, value]) =>
        name.endsWith('Store') && typeof (value as { get?: unknown }).get === 'function',
    );
    expect(stores.length, 'the scan must actually find stores to scan').toBeGreaterThan(3);
    for (const [name, store] of stores) {
      const snapshot = JSON.stringify((store as { get: () => unknown }).get() ?? null);
      expect(snapshot, `${name} must not carry the minted key`).not.toContain(MINTED);
    }

    // The ROW — the surface that syncs and exports.
    expect(JSON.stringify(harness.db.getConnection(APP, SLOT))).not.toContain(MINTED);
  });

  it('the Entertainment clientkey is NOT stored (unused at v1 — nothing keeps what it does not use)', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);
    await click(button(/i pressed the button/i));
    await settleUntil(() => harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`) !== undefined);

    const secrets = harness.db.listSecretKeys().filter((key) => key.startsWith(`auth:${APP}:${SLOT}:`));
    expect(secrets.sort()).toEqual([`auth:${APP}:${SLOT}:_connection`, `auth:${APP}:${SLOT}:application_key`]);
    for (const key of secrets) {
      expect(harness.db.getSecret(key) ?? '').not.toContain('ENTERTAINMENT-KEY');
    }
  });
});

// ---------------------------------------------------------------------------
// Platform portability (ADR-0023 D1) — web DISCLOSES, never refuses or destroys
// ---------------------------------------------------------------------------

describe('a LAN row opened on the web platform', () => {
  it('discloses "needs the desktop app" BEFORE the user does any work', async () => {
    const harness = await fresh(webPlatform());
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    const wall = testId('lan-desktop-wall');
    expect(wall, 'the disclosure lands before the address box').not.toBeNull();
    expect(wall?.textContent ?? '').toMatch(/desktop app/i);
    expect(wall?.textContent ?? '').toMatch(/home network|own network/i);
  });

  it('leaves the row completely intact — a desktop-minted LAN row is never refused or destroyed on web', async () => {
    const harness = await fresh(webPlatform());
    // A row that was already collected + approved on desktop, now opened on web.
    harness.db.putDeclaredConnection(
      APP,
      'hue2',
      { ...bareHue, slot: 'hue2', declaredApiHosts: [BRIDGE] },
      'user',
    );
    harness.db.approveConnection(APP, 'hue2');
    const before = JSON.stringify(harness.db.getConnection(APP, 'hue2'));

    harness.wizard.openConnectionWizard({ appId: APP, slot: 'hue2', source: 'settings' });
    await render(<harness.Sheet />);
    await settle();

    expect(JSON.stringify(harness.db.getConnection(APP, 'hue2'))).toBe(before);
    expect(harness.db.getConnection(APP, 'hue2')?.status).toBe('approved');
    expect(testId('lan-desktop-wall')).not.toBeNull();
  });

  it('offers no pairing affordance at all on web (a button that cannot work is worse than none)', async () => {
    const harness = await fresh(webPlatform());
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);

    expect(button(/i pressed the button/i)).toBeUndefined();
    expect(button(/^use this address$/i), 'no address collection either — it could never be paired').toBeUndefined();
  });

  it('the wizard store REFUSES pairing on web even when driven directly (not just hidden)', async () => {
    const harness = await fresh(webPlatform());
    harness.db.putDeclaredConnection(
      APP,
      'hue3',
      { ...bareHue, slot: 'hue3', declaredApiHosts: [BRIDGE] },
      'user',
    );
    harness.db.approveConnection(APP, 'hue3');
    harness.wizard.openConnectionWizard({ appId: APP, slot: 'hue3', source: 'settings' });

    const outcome = await harness.wizard.runLanPairing();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/desktop app/i);
  });
});

// ---------------------------------------------------------------------------
// ADR-0025 — verify before claiming, and the routes that could lie
// (TASK-20260814-hue-pairing-e2e; the owner's hardware report)
// ---------------------------------------------------------------------------

/** The pre-fix state shape the old code wrote: connected, pinned, never verified. */
function seedLegacyPairedState(harness: Harness): void {
  harness.db.setSecret(`auth:${APP}:${SLOT}:application_key`, MINTED);
  harness.db.setSecret(
    `auth:${APP}:${SLOT}:_connection`,
    JSON.stringify({ status: 'connected', lanPin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' } }),
  );
}

function connState(harness: Harness): Record<string, unknown> {
  return JSON.parse(harness.db.getSecret(`auth:${APP}:${SLOT}:_connection`) ?? '{}') as Record<string, unknown>;
}

describe('the verify read (ADR-0025 §1-2) — pairing proves the key it minted', () => {
  it('fires the registry verify GET at the frozen host with the minted key and the captured pin, then claims verified', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => desktop.lanFetchCalls.length > 0);

    // The probe: registry path on the CEILING host, GET, the entry's own header
    // carrying the just-minted value, over the pin captured seconds earlier.
    const probe = desktop.lanFetchCalls[0]!;
    expect(probe.url).toBe(`https://${BRIDGE}/clip/v2/resource/bridge`);
    expect(probe.init.method).toBe('GET');
    expect((probe.init.headers as Record<string, string>)['hue-application-key']).toBe(MINTED);
    expect(probe.pin).toBe(PIN);

    await settleUntil(() => connState(harness)['status'] === 'connected');
    const state = connState(harness);
    expect(typeof state['lanVerifiedAt'], 'the marker only the verify step writes').toBe('number');
    expect(state['lanPin']).toEqual({ fingerprint: PIN, cn: 'ECB5FAFFFE123456' });

    // AC6 — the done copy names the PROVEN fact and the device it was proven against.
    await settleUntil(() => /paired and verified/i.test(container?.textContent ?? ''));
    expect(container?.textContent ?? '').toContain(BRIDGE);
  });

  it('a verify REFUSAL keeps key + pin + pending, stays on the pair screen, and says the device did not accept the key', async () => {
    const desktop = fakeDesktop();
    desktop.lanFetchResult = { status: 403 };
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    // The mint is kept (the device DID create it; re-pairing overwrites)…
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBe(MINTED);
    // …but the claim is not: pending, no verified marker, and NO lastError in the
    // synced KV (a verify failure is a wizard-screen fact, not a durable one).
    const state = connState(harness);
    expect(state['status']).toBe('pending');
    expect(state['lanVerifiedAt']).toBeUndefined();
    expect(state['lastError']).toBeUndefined();

    expect(testId('lan-pair-step'), 're-pair is offered, not a done screen').not.toBeNull();
    expect(testId('lan-pair-error')?.textContent ?? '').toMatch(/didn't accept|did not accept/i);
    expect(container?.textContent ?? '').not.toMatch(/paired and verified/i);
    // C1 — the failure path surfaces no credential.
    expect(container?.textContent ?? '').not.toContain(MINTED);
  });

  it('a verify TRANSPORT failure is named distinctly from a refusal, and claims nothing', async () => {
    const desktop = fakeDesktop();
    desktop.lanFetchResult = new Error('lan_fetch: request failed: connection reset');
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    const message = testId('lan-pair-error')?.textContent ?? '';
    expect(message).toMatch(/couldn't reach the device to check|could not reach the device to check/i);
    expect(message).not.toMatch(/didn't accept|did not accept/i);
    expect(connState(harness)['status']).toBe('pending');
    expect(container?.textContent ?? '').not.toMatch(/paired and verified/i);
  });

  it('a platform whose shell ships lanPair but no lanFetch cannot claim connected', async () => {
    const desktop = fakeDesktop();
    delete (desktop.platform as { lanFetch?: unknown }).lanFetch;
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    await click(button(/i pressed the button/i));
    await settleUntil(() => testId('lan-pair-error') !== null);

    expect(connState(harness)['status']).toBe('pending');
    expect(connState(harness)['lanVerifiedAt']).toBeUndefined();
    expect(container?.textContent ?? '').not.toMatch(/paired and verified/i);
  });
});

describe('LAN routing (ADR-0025 §4) — register/credentials are pairing-owned', () => {
  it("nextStep for a LAN requirement goes review → done — the walkthrough renders on the host screen, the credential is minted", async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    const requirement = harness.db.getConnection(APP, SLOT)!.requirement;
    expect(harness.wizard.isLanRequirement(requirement), 'the fixture must actually be LAN-class').toBe(true);
    expect(harness.wizard.nextStep('review', requirement)).toBe('done');
  });

  it('advanceFromRegister REFUSES a LAN row when driven directly', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    const outcome = await harness.wizard.advanceFromRegister();
    expect(outcome.ok).toBe(false);
  });

  it('saveConnectionCredentials REFUSES a LAN row and writes nothing — the key is minted, never typed', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);

    const outcome = await harness.wizard.saveConnectionCredentials({ application_key: 'typed-by-hand' });
    expect(outcome.ok).toBe(false);
    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBeUndefined();
  });
});

describe("the reopen (ADR-0025 §3) — the owner's regression", () => {
  it('a paired-but-UNVERIFIED row (the pre-fix shape) reopens to RE-PAIR — never the register walk, never the credential box', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    // Collect + approve through the real screens, then transplant the legacy state —
    // the shape a pairing under the OLD code left behind: connected + pin, no marker.
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);
    seedLegacyPairedState(harness);

    // Reopen — the journey the owner actually took.
    harness.wizard.closeConnectionWizard();
    await settle();
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await settle();
    await click(button(/approve this connection/i));

    // The truth: an unverified claim is a pairing still owed.
    expect(testId('lan-pair-step'), 'an unverified row re-pairs').not.toBeNull();
    // NEVER the ghost flow: no "get your … credentials" register walk, no credential box.
    expect(container?.textContent ?? '').not.toMatch(/get your philips hue credentials/i);
    expect(testId('credentials-custody')).toBeNull();
  });

  it('a paired-and-VERIFIED row reopens to the connected summary — no re-walk, no re-pair demand', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);
    // A REAL pairing under the new code: mint, pin, verify — all through the screens.
    await click(button(/i pressed the button/i));
    await settleUntil(() => connState(harness)['status'] === 'connected');

    harness.wizard.closeConnectionWizard();
    await settle();
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await settle();
    await click(button(/approve this connection/i));

    expect(container?.textContent ?? '').toMatch(/paired and verified/i);
    expect(container?.textContent ?? '').toContain(BRIDGE);
    expect(button(/i pressed the button/i), 'a verified row owes no pairing').toBeUndefined();
    expect(container?.textContent ?? '').not.toMatch(/get your philips hue credentials/i);
    expect(testId('credentials-custody')).toBeNull();
  });

  it('approving a fresh LAN row never flashes a success claim while the row re-read is in flight (ADR-0025 §6)', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await type(testId('lan-host-input') as HTMLInputElement, BRIDGE);
    await click(button(/^use this address$/i));

    // Click approve and then poll EVERY microtask boundary: no intermediate render may
    // claim success before pairing has run.
    const approve = button(/approve this connection/i)!;
    await act(async () => {
      approve.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 25; i++) {
      expect(container?.textContent ?? '').not.toMatch(/paired and verified|is connected/i);
      await act(async () => {
        await Promise.resolve();
      });
    }
    await settle();
    expect(testId('lan-pair-step'), 'the settled screen is the pairing step').not.toBeNull();
  });
});

describe('re-approval invalidation (ADR-0025 §5) — verified never migrates to a device it was not proven against', () => {
  it('a staged HOST change downgrades the state and deletes the minted key — re-pair required at the new address', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);
    await click(button(/i pressed the button/i));
    await settleUntil(() => connState(harness)['status'] === 'connected');

    harness.db.stagePendingRequirement(APP, SLOT, { ...bareHue, declaredApiHosts: ['192.168.1.99'] });
    const outcome = await harness.wizard.reapproveFromDiff();
    expect(outcome.ok).toBe(true);

    expect(harness.db.getConnection(APP, SLOT)?.allowedHosts).toEqual(['192.168.1.99']);
    expect(
      harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`),
      "the old device's key must not ride a ceiling pointing at a new one",
    ).toBeUndefined();
    const state = connState(harness);
    expect(state['status']).toBe('pending');
    expect(state['lanPin']).toBeUndefined();
    expect(state['lanVerifiedAt']).toBeUndefined();
  });

  it('a host-identical re-approval KEEPS the verified state and the key', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    harness.wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await render(<harness.Sheet />);
    await collectAndApprove(harness);
    await click(button(/i pressed the button/i));
    await settleUntil(() => connState(harness)['status'] === 'connected');

    harness.db.stagePendingRequirement(APP, SLOT, { ...bareHue, declaredApiHosts: [BRIDGE] });
    const outcome = await harness.wizard.reapproveFromDiff();
    expect(outcome.ok).toBe(true);

    expect(harness.db.getSecret(`auth:${APP}:${SLOT}:application_key`)).toBe(MINTED);
    const state = connState(harness);
    expect(state['status']).toBe('connected');
    expect(typeof state['lanVerifiedAt']).toBe('number');
  });
});
