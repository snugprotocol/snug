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

function desktopWithSidecar(opts: { linked?: boolean } = {}): SnugPlatform {
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
      // `linked` scripts the SCANNED case: the poll mints a token and the verify read
      // passes. The default stays 'waiting', which is what the screens-and-copy tests want.
      if (opts.linked === true && pathAndQuery === '/pair/status') {
        return { status: 200, body: JSON.stringify({ state: 'linked', token: 'minted-token' }) };
      }
      if (opts.linked === true && pathAndQuery === '/session/status') {
        return { status: 200, body: JSON.stringify({ state: 'linked' }) };
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
  vi.useRealTimers();
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

  /**
   * THE QR MUST BE SCANNABLE (owner report, 2026-08-17).
   *
   * The first implementation rendered the payload as TEXT in a `<pre>`, with a comment
   * explaining that "the desktop surface draws it" — a surface that does not exist. The
   * owner clicked "start linking", saw a long URL, and had nothing to point a phone at.
   * A pairing flow whose QR cannot be scanned is not a pairing flow.
   *
   * These assert the SVG is really there and really encodes something, rather than that some
   * element exists: an empty or one-module SVG would satisfy a mere presence check while
   * being just as unscannable as the text was.
   */
  it('renders the QR as a scannable SVG, not as a payload string', async () => {
    const { wizard, Sheet } = await fresh(desktopWithSidecar());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));
    await act(async () => {
      await wizard.advanceFromReview();
    });
    await settle();

    // Click "start linking" — found by its label, since the button carries no testid.
    const startButton = [...document.querySelectorAll('button')].find((b) =>
      /start linking/i.test(b.textContent ?? ''),
    );
    expect(startButton, 'the start-linking button is on screen').toBeDefined();
    await act(async () => {
      startButton?.click();
    });
    await settle();

    const qr = testId('linked-device-qr');
    expect(qr, 'the QR panel is on screen once linking has started').not.toBeNull();

    const svg = qr?.querySelector('svg');
    expect(svg, 'the QR is drawn as an SVG a camera can read').not.toBeNull();
    // A real QR for a WhatsApp-sized payload is a large grid. One or two elements would mean
    // an empty render that still passes a presence check.
    const modules = svg?.querySelectorAll('rect, path') ?? [];
    expect(modules.length, 'the SVG carries a real module grid').toBeGreaterThan(1);

    // And the raw payload must NOT be dumped as text beside it — that was the bug.
    expect(qr?.textContent ?? '', 'the payload is not printed as a string').not.toContain('2@');
  });

  /**
   * ONE CLICK MUST BE ENOUGH (owner report, 2026-08-18).
   *
   * On a cold helper the QR does not exist yet when `/pair/qr` is first asked — WhatsApp's
   * handshake delivers it 1–3 s after `startLink` returns. The old flow asked once, got
   * nothing, and rendered the waiting copy with NO code and NO error; the second click
   * happened to win the race. This drives the real sheet against a helper whose first two
   * answers carry no QR, clicks ONCE, and asserts the code appears — structure, not copy.
   *
   * The same platform script then rotates the payload, pinning that the on-screen QR keeps
   * up while the user is still fumbling for their phone (WhatsApp rotates ~20 s server-side;
   * a stale code scans as expired).
   */
  function desktopWithSlowRotatingQr(): SnugPlatform {
    let qrAsks = 0;
    return {
      kind: 'desktop',
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
      sidecarCtl: async () => ({ running: true, nonce: 'spawn-nonce' }),
      sidecarFetch: async () => ({ status: 200, body: '{}' }),
      sidecarWizardFetch: async (_method, pathAndQuery) => {
        if (pathAndQuery === '/pair/qr') {
          qrAsks += 1;
          // Asks 1–2: the handshake has not delivered a QR yet. Ask 3: the first code.
          // Every later ask: the rotated code.
          if (qrAsks <= 2) return { status: 200, body: JSON.stringify({ state: 'waiting' }) };
          const payload = qrAsks === 3 ? '2@FIRST-QR-PAYLOAD' : '2@ROTATED-QR-PAYLOAD';
          return { status: 200, body: JSON.stringify({ state: 'waiting', qr: payload }) };
        }
        return { status: 200, body: JSON.stringify({ state: 'waiting' }) };
      },
    };
  }

  it('shows the QR after ONE click even when the helper needs a moment', async () => {
    const { wizard, Sheet } = await fresh(desktopWithSlowRotatingQr());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));
    await act(async () => {
      await wizard.advanceFromReview();
    });
    await settle();

    vi.useFakeTimers();
    const startButton = [...document.querySelectorAll('button')].find((b) =>
      /start linking/i.test(b.textContent ?? ''),
    );
    expect(startButton, 'the start-linking button is on screen').toBeDefined();
    await act(async () => {
      startButton?.click();
    });
    // Long enough for the flow's own re-asks to reach the third answer; nobody clicks twice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const qr = testId('linked-device-qr');
    expect(qr, 'one click produces the QR panel').not.toBeNull();
    expect(qr?.querySelector('svg'), 'and it is drawn, not described').not.toBeNull();
  });

  it('keeps the on-screen QR current while waiting for the scan', async () => {
    const { wizard, Sheet } = await fresh(desktopWithSlowRotatingQr());
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));
    await act(async () => {
      await wizard.advanceFromReview();
    });
    await settle();

    vi.useFakeTimers();
    const startButton = [...document.querySelectorAll('button')].find((b) =>
      /start linking/i.test(b.textContent ?? ''),
    );
    await act(async () => {
      startButton?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const before = testId('linked-device-qr')?.innerHTML;
    expect(before, 'the first code is on screen').toBeTruthy();

    // A rotation interval later, the frame holds a DIFFERENT drawing — the rotated payload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    const after = testId('linked-device-qr')?.innerHTML;
    expect(after, 'the frame still holds a code').toBeTruthy();
    expect(after, 'the drawing follows the rotated payload').not.toBe(before);
  });

  it('completes in ONE click against an already-linked helper — no code, no hang', async () => {
    // The autostarted, boot-resumed helper (ADR-0037) is linked before the wizard opens;
    // `/pair/qr` withholds the code. One click of "start linking" must run the same
    // verify+mint+store path the scan button drives, and land the wizard on done.
    const { db, wizard, Sheet } = await fresh({
      kind: 'desktop',
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
      sidecarCtl: async () => ({ running: true, nonce: 'spawn-nonce' }),
      sidecarFetch: async () => ({ status: 200, body: '{}' }),
      sidecarWizardFetch: async (_method, pathAndQuery) => {
        if (pathAndQuery === '/pair/qr') return { status: 200, body: JSON.stringify({ state: 'linked' }) };
        if (pathAndQuery === '/pair/status') {
          return { status: 200, body: JSON.stringify({ state: 'linked', token: 'minted-token' }) };
        }
        return { status: 200, body: JSON.stringify({ state: 'linked' }) };
      },
    });
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));
    await act(async () => {
      await wizard.advanceFromReview();
    });
    await settle();

    const startButton = [...document.querySelectorAll('button')].find((b) =>
      /start linking/i.test(b.textContent ?? ''),
    );
    expect(startButton, 'the start-linking button is on screen').toBeDefined();
    await act(async () => {
      startButton?.click();
    });
    await settle();

    const dbmod = await import('@snugprotocol/db');
    expect(
      db.getSecret(dbmod.authConnectionCredentialSecretKey(APP, SLOT, 'sidecar_token')),
      'the token landed without any QR ever rendering',
    ).toBe('minted-token');
    expect(wizard.connectionWizardStepStore.get(), 'the wizard advances to done').toBe('done');
  });

  /**
   * THE MINTED TOKEN MUST BE STORED (owner report, 2026-08-17).
   *
   * The owner scanned the QR, the phone showed the linked device, and the wizard then asked
   * them to type a "helper access token" — a value no human has or could obtain: it is minted
   * by the helper and handed back over the socket.
   *
   * `completeDeviceLink` verified the link and RETURNED the token correctly. Nothing stored
   * it. The sheet's `onLinked` only set a local boolean, so the row still had no credential
   * and the wizard fell through to the generic credentials screen — a text box for a secret
   * that cannot be typed. Exactly the failure the LAN screens avoid by minting INTO the store
   * (`runLanPairingAttempt` writes the secret and the connection state together), which is
   * the pattern this now follows.
   */
  it('stores the minted token and never shows a credentials box for it', async () => {
    const { db, wizard, Sheet } = await fresh(desktopWithSidecar({ linked: true }));
    const React = await import('react');
    await act(async () => {
      await wizard.openConnectionWizardForApp(APP, 'settings');
    });
    await renderNode(React.createElement(Sheet));
    await act(async () => {
      await wizard.advanceFromReview();
    });
    await settle();

    const startButton = [...document.querySelectorAll('button')].find((b) =>
      /start linking/i.test(b.textContent ?? ''),
    );
    await act(async () => {
      startButton?.click();
    });
    await settle();

    const scanned = [...document.querySelectorAll('button')].find((b) =>
      /scanned/i.test(b.textContent ?? ''),
    );
    expect(scanned, 'the "I\'ve scanned it" control is on screen').toBeDefined();
    await act(async () => {
      scanned?.click();
    });
    await settle();

    // THE CREDENTIAL LANDED. Read through the same key the executor injects from, so a test
    // passing here means the connection can actually authenticate.
    const dbmod = await import('@snugprotocol/db');
    const stored = db.getSecret(dbmod.authConnectionCredentialSecretKey(APP, SLOT, 'sidecar_token'));
    expect(stored, 'the minted token is written to the credential store').toBe('minted-token');

    // AND THE WIZARD MOVES ON. Storing the token was only half the fix: the step was still
    // `credentials`, so `linkNeedsPairing` going false dropped the user straight onto the
    // generic credentials screen — a text box for a secret only the helper can produce.
    //
    // Asserted on the STEP and on the absence of a text input, not on the phrase "Helper
    // access token": that phrase is the field's LABEL, and the first version of this test
    // passed while the box was on screen because the heading reads differently. A test that
    // can be satisfied by the wrong screen is not a test of this bug.
    expect(wizard.connectionWizardStepStore.get(), 'the wizard advances to done').toBe('done');
    expect(
      container?.querySelector('input[type="password"], input[type="text"]'),
      'no credential input is rendered — nothing here is typeable',
    ).toBeNull();
  });
});
