// linkedDeviceThirdPartyBand.test.tsx — TASK-20260823-legal-terms-privacy-eula AC9
// (ADR-0055 §3; threat-model R-9 / R-10).
//
// The linking screen already said the operational half (reads and sends as you; unlink
// from your phone — linkedDeviceSheet.test.tsx pins it) and R-10 rides the review
// screen's registry instructions. What was stated NOWHERE in the UI is R-9: the other
// people in the user's chats never agreed to anything, and when a thread is analysed
// its CONTENT reaches the user's model provider — names and numbers scrubbed, the words
// not. That is the strongest disclosure in the product and it belongs on the screen with
// the "start linking" button, not on a page two clicks away.
//
// Same doctrine as every band: a WARNING, never a refusal — the start button stays
// enabled. Harness: linkedDeviceSheet.test.tsx's (fresh registry, desktop platform with
// the sidecar seats, real sheet, advance past the review).

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

const APP = 'app-linked-device-band';
const SLOT = 'whatsapp';

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
    sidecarFetch: async () => ({ status: 200, body: '{}' }),
    sidecarWizardFetch: async (_method, pathAndQuery) => {
      if (pathAndQuery === '/pair/qr') {
        return { status: 200, body: JSON.stringify({ state: 'waiting', qr: 'QR-PAYLOAD-XYZ' }) };
      }
      return { status: 200, body: JSON.stringify({ state: 'waiting' }) };
    },
  };
}

interface Harness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
  Sheet: (typeof import('../connections/ConnectionWizardSheet.js'))['ConnectionWizardSheet'];
}

async function fresh(): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(desktopWithSidecar());
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  db.installApp({ appId: APP, displayName: 'Telepath', html: '<p>t</p>' });
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

const testId = (id: string): HTMLElement | null => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

async function openLinkScreen(): Promise<void> {
  const { wizard, Sheet } = await fresh();
  const React = await import('react');
  await act(async () => {
    await wizard.openConnectionWizardForApp(APP, 'settings');
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(Sheet));
  });
  await settle();
  await act(async () => {
    await wizard.advanceFromReview();
  });
  await settle();
}

describe('the R-9 third-party band on the linking screen', () => {
  it('renders BEFORE "start linking", inside the linking panel', async () => {
    await openLinkScreen();
    const panel = testId('linked-device-link');
    expect(panel, 'the linking screen is on show').not.toBeNull();
    const band = panel?.querySelector<HTMLElement>('[data-testid="linked-device-third-party-band"]') ?? null;
    expect(band).not.toBeNull();
    expect(band?.getAttribute('role')).toBe('note');
    const start = [...(panel?.querySelectorAll('button') ?? [])].find((b) => /start linking/i.test(b.textContent ?? ''));
    expect(start, 'the start button exists').toBeDefined();
    // Document order: the band precedes the button the user is about to press.
    expect(band!.compareDocumentPosition(start!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the three things: other people never agreed; content reaches the model provider; this is against the service\'s terms', async () => {
    await openLinkScreen();
    const text = testId('linked-device-third-party-band')?.textContent ?? '';
    expect(text, 'R-9: the other people').toMatch(/other people/i);
    expect(text, 'R-9: never agreed').toMatch(/never agreed|have not agreed|did not agree/i);
    expect(text, 'R-9: content reaches the provider').toMatch(/model provider/i);
    expect(text, 'R-9: scrub is a reduction, not a guarantee').toMatch(/names and numbers/i);
    expect(text, 'R-9: the words themselves go').toMatch(/the words/i);
    expect(text, 'R-9: honest class').toMatch(/anti-default, not anti-adversarial/i);
    expect(text, 'R-10: against the terms').toMatch(/against WhatsApp'?s terms/i);
    expect(text, 'R-10: bans have happened').toMatch(/banned/i);
  });

  it('warns, never refuses — the start button stays enabled', async () => {
    await openLinkScreen();
    const start = [...(testId('linked-device-link')?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
      /start linking/i.test(b.textContent ?? ''),
    );
    expect(start?.disabled).toBe(false);
  });
});
