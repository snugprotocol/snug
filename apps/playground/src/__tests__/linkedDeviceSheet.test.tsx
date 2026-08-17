// TASK-20260816-whatsapp-twin Phase D (ADR-0032): the wizard SHEET's linked-device routing.
//
// `linkedDeviceWizard.test.ts` proves the predicates and the flow. This file proves the
// SHEET routes a linked-device row to the right screens — a separate claim, and the one that
// reaches a user. A correct predicate nothing renders is a feature that does not exist.
//
// Asserted by OUTCOME through the real sheet (never by reaching into module internals — the
// screens are private because the sheet owns its routing), in order of how badly a
// regression would hurt:
//   1. A linked-device row never reaches the LAN screens — the constraint the phase exists
//      for, since the LAN pairing path demands a TLS pin a unix socket cannot produce.
//   2. Web discloses rather than dead-ending.
//   3. The consent copy is on the screen where the user acts, not buried upstream.

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

const APP = 'app-linked-device';
const SLOT = 'whatsapp';

/** The declaration the install act supplies — the registry substitutes the pinned seats. */
const bareWhatsapp = {
  slot: SLOT,
  kind: 'linked_device' as const,
  provider: { name: 'WhatsApp' },
  declaredApiHosts: ['whatsapp.sidecar.localhost'],
};

function desktopWithSidecar(): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    sidecarCtl: async () => ({ running: true, nonce: 'spawn-nonce' }),
    // Present because `canLinkDevice` requires all three seats; the pairing screens drive
    // the wizard door, so a call arriving here would be the defect this split prevents.
    sidecarFetch: async () => ({ status: 200, body: '{}' }),
    sidecarWizardFetch: async (_method, pathAndQuery) => {
      if (pathAndQuery === '/pair/qr') {
        return { status: 200, body: JSON.stringify({ state: 'waiting', qr: 'QR-PAYLOAD-XYZ' }) };
      }
      return { status: 200, body: JSON.stringify({ state: 'waiting' }) };
    },
  };
}

function desktopWithoutSidecar(): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}

function webPlatform(): SnugPlatform {
  return { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };
}

interface Harness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
  Sheet: (typeof import('../connections/ConnectionWizardSheet.js'))['ConnectionWizardSheet'];
}

async function fresh(platform: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  db.installApp({ appId: APP, displayName: 'Twin', html: '<p>twin</p>' });
  db.putDeclaredConnection(APP, SLOT, bareWhatsapp, 'starter');
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

async function renderNode(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await settle();
}

const testId = (id: string): HTMLElement | null =>
  (container?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null) ?? null;

describe('the sheet routes a linked-device row away from the LAN screens', () => {
  it('never renders a LAN screen for a linked-device row on desktop', async () => {
    // THE PHASE'S CONSTRAINT, asserted at the surface. If routing ever sent this row to the
    // LAN family it would land in a pairing path that hard-requires a 64-hex certificate
    // pin, and fail somewhere far from any screen that could explain why.
    const { wizard, Sheet } = await fresh(desktopWithSidecar());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));

    expect(testId('lan-desktop-wall'), 'a linked-device row is not a LAN row').toBeNull();
    expect(testId('lan-host-step'), 'there is no address for the user to type').toBeNull();
    expect(testId('lan-pair-step'), 'the LAN pairing path demands a TLS pin this cannot produce').toBeNull();

    // AND A POSITIVE CLAIM, because absences alone are a weak instrument: a blank sheet
    // satisfies all three. This pins that the row is rendered and named at all.
    expect(testId('connection-wizard'), 'the wizard must actually render this row').not.toBeNull();
    expect(
      container?.textContent ?? '',
      'the review must name the provider — a blank sheet passes every absence check',
    ).toMatch(/WhatsApp/i);

    // HONEST LIMIT OF THIS TEST, measured rather than assumed. Disabling the linked-device
    // family entirely still leaves this test green: a `linked_device` row carries no
    // `lanHost`, so the LAN screens stay absent either way, and the review still renders.
    // What this test proves is "never LAN", which is the constraint it is named for. That
    // the linked-device screens are actually REACHED is proven by the three tests below,
    // each of which does go red under that mutation. Stated here so a reader does not credit
    // this test with a guarantee it cannot give (lessons.md 2026-07-31: a weaker instrument
    // says so).
  });

  it('discloses the desktop-only wall on web, naming the real reason', async () => {
    const { wizard, Sheet } = await fresh(webPlatform());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));

    const wall = testId('linked-device-wall');
    expect(wall, 'web must disclose rather than present a flow that cannot work').not.toBeNull();
    // The REASON, not merely the refusal: a browser cannot talk to a program on your machine.
    expect(wall?.textContent ?? '').toMatch(/helper|computer/i);
    expect(testId('lan-desktop-wall'), 'the LAN wall is the wrong disclosure').toBeNull();
  });

  it('discloses on a DESKTOP shell that lacks the sidecar seats', async () => {
    // An older shell, or one built without the helper: disclose rather than offer a flow
    // whose transport is absent. Distinct from the web case, same posture.
    const { wizard, Sheet } = await fresh(desktopWithoutSidecar());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));

    expect(testId('linked-device-wall')).not.toBeNull();
  });
});

describe('the linking screen carries its consent copy where the user acts', () => {
  it('states what the link can do, what Snug never gets, and how to undo it', async () => {
    const { wizard, Sheet } = await fresh(desktopWithSidecar());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));

    // Advance past the review so the linking screen is the one on show.
    await act(async () => {
      await wizard.advanceFromReview();
    });
    await settle();

    const panel = testId('linked-device-link');
    expect(panel, 'the linking screen replaces the credentials screen for a minted token').not.toBeNull();
    const text = panel?.textContent ?? '';
    // Each clause is a distinct promise, so each is asserted separately: a copy edit that
    // dropped one would otherwise pass on the strength of the others.
    expect(text, 'must say it can read and send').toMatch(/read and send/i);
    expect(text, 'must say sign-in details never reach Snug').toMatch(/never given to Snug/i);
    expect(text, 'must say the user can unlink from their phone').toMatch(/unlink/i);
  });
});
