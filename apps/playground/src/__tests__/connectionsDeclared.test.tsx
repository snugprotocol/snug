// connectionsDeclared.test.tsx — TASK-20260807-connection-reachability §V2-6 (breadth).
//
// The Settings surface for an app that DECLARES a connection but has no auth row yet.
//
// Why this surface has to exist at all: `ConnectionsCard` renders `db.listAuthSpecs()`,
// which is empty until something writes a row — and for a chat-less app nothing ever
// could. So the panel showed "no connections yet" while an installed app sat there
// unable to reach the network, and the user had no route to fix it. The CTA path closes
// the app-timed half; this closes the user-initiated half.
//
// It also carries the honest reporting of a MISMATCH: an installed app whose code no
// longer matches its starter withdraws its declaration, and the fidelity check (C1)
// established that withdrawing SILENTLY drops the user back into the empty wizard this
// task exists to eliminate.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ConnectionsCard } from '../views/SettingsView.js';
import { __resetWizardStateForTests, openWizardForNetError, wizardStore } from '../state/wizard.js';
import {
  __setDeclarationManifestsForTests,
  __resetDeclarationManifestsForTests,
} from '../starter/starterDeclaration.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DEMO_FOLDER = 'connection-demo';
const DEMO_SOURCE = `starter:${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';
const BUNDLED_HTML = '<!doctype html>\n<html><body><script>const app = 1;</script></body></html>\n';

const VALID_MANIFEST = JSON.stringify({
  kindHint: 'api_key',
  providerName: 'Example API',
  declaredApiHosts: [DECLARED_HOST],
});

let container: HTMLDivElement;
let root: Root;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderCard(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionsCard />);
  });
  await settle();
  await settle();
}

const declaredRow = (): HTMLElement | null => container.querySelector('[data-testid="connection-declared-row"]');
const text = (): string => container.textContent ?? '';

beforeEach(async () => {
  __resetWizardStateForTests();
  db = await installTestUserDb();
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: VALID_MANIFEST, html: BUNDLED_HTML },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  __resetWizardStateForTests();
  __resetDeclarationManifestsForTests();
  vi.restoreAllMocks();
});

function installDemo(html: string = BUNDLED_HTML): string {
  return db.installApp({ displayName: 'connection demo', html, installSource: DEMO_SOURCE }).appId;
}

describe('an installed declaring app is reachable from Settings', () => {
  it('lists it as declared — not connected', async () => {
    installDemo();
    await renderCard();

    expect(declaredRow(), 'a declared app must be listed even with no auth row').not.toBeNull();
    expect(text()).toContain('Example API');
  });

  it('does not claim "no connections yet" when a declared app is present', async () => {
    // The exact wrong state: an app sits installed and unable to reach the network while
    // the panel reports there is nothing to see.
    installDemo();
    await renderCard();

    expect(text()).not.toContain('no connections yet');
  });

  it('offers a control that opens the wizard with the declaration prefilled', async () => {
    const appId = installDemo();
    await renderCard();

    const button = declaredRow()?.querySelector('button');
    expect(button, 'the row must be actionable').not.toBeNull();
    await act(async () => {
      button!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    const session = wizardStore.get();
    expect(session?.appId).toBe(appId);
    expect(session?.source, 'a user-initiated open is a settings open').toBe('settings');
    expect(session?.declaration?.declaredApiHosts, 'the review must open prefilled').toEqual([DECLARED_HOST]);
  });

  it('an app with NO manifest is not listed as declared', async () => {
    // The control: only apps that really declare may appear, or the panel becomes noise.
    db.installApp({ displayName: 'chess', html: '<html>c</html>', installSource: 'starter:chess' });
    await renderCard();

    expect(declaredRow()).toBeNull();
    expect(text()).toContain('no connections yet');
  });

  it('an app that already has an auth row is NOT duplicated as declared', async () => {
    // Once a row exists the normal connections list owns it. Showing both would offer
    // two different controls for one connection.
    const appId = installDemo();
    db.putAuthSpec(appId, {
      kind: 'api_key',
      provider: { name: 'Example API' },
      fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
      declaredApiHosts: [DECLARED_HOST],
    });
    await renderCard();

    expect(declaredRow(), 'a connected app is not a declared-only app').toBeNull();
  });
});

describe('the revoke ACTION records the note (§V2-5 wiring)', () => {
  it('revoking from Settings makes the app’s next CTA unprefilled', async () => {
    // Found by mutation M29: the whole post-revoke rule was tested against
    // `noteAuthSpecRevoked` called directly, so deleting the CALL SITE in the revoke
    // button left everything green — the rule worked and nothing ever triggered it.
    // This drives the real button and then asks the real CTA path what it sees.
    const appId = installDemo();
    db.putAuthSpec(appId, {
      kind: 'api_key',
      provider: { name: 'Example API' },
      fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
      declaredApiHosts: [DECLARED_HOST],
    });
    await renderCard();

    const revoke = [...container.querySelectorAll('button')].find((b) => /revoke/i.test(b.textContent ?? ''));
    expect(revoke, 'the connected row must offer revoke').toBeDefined();
    await act(async () => {
      revoke!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();

    expect(db.listAuthSpecs(), 'the revoke really happened').toHaveLength(0);
    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);
    expect(
      wizardStore.get()?.declaration,
      'after a real revoke, the app’s own retry must not be prefilled',
    ).toBeUndefined();
  });
});

describe('a withdrawn declaration is REPORTED, never silent (fidelity check C1)', () => {
  it('an app whose code no longer matches its starter says so', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installDemo('<html>edited by someone else</html>');
    await renderCard();

    expect(text().toLowerCase(), 'a silent withdrawal drops the user into the empty wizard').toContain(
      'no longer matches',
    );
  });

  it('the mismatch notice is not shown for an app that simply never declared', async () => {
    // Collapsing "withdrawn" into "never declared" would put a scary banner on every
    // ordinary app in the library.
    db.installApp({ displayName: 'chess', html: '<html>c</html>', installSource: 'starter:chess' });
    await renderCard();

    expect(text().toLowerCase()).not.toContain('no longer matches');
  });
});
