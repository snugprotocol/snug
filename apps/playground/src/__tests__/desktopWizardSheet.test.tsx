// Desktop wizard surface (TASK-20260812 W2a; P0 amendment 7, AC6 refusal, advisory
// disclosure). Component tests for the FOUR sheet-level behaviors the platform seam
// changes: (b) no blank pre-open when the platform owns the opener, (c) the register
// screen's redirect URI drawn from the SAME platform source the service uses,
// (d) unsupported postures get a refusal screen BEFORE credentials, (e) the
// `browserCallable:false` disclosure on the web wizard — and the explicit cancel
// affordance while a desktop sign-in is awaited.
//
// Platform is set-once, so every case takes a fresh module registry and imports the
// sheet + stores dynamically from that generation.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupWellKnownProvider, requirementFromRegistryEntry } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-desktop-sheet';

const fakeIdpRequirement = {
  slot: 'fake-idp',
  provider: { name: 'Fake IdP' },
  kind: 'oauth2_auth_code',
  endpoints: {
    authorizeUrl: 'https://idp.example/authorize',
    tokenUrl: 'https://idp.example/token',
  },
  pkce: true,
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text', required: true }],
  declaredApiHosts: ['api.fake-idp.example'],
} as const satisfies Record<string, unknown>;

interface FakeDesktop {
  platform: SnugPlatform;
  opened: string[];
  redirectUriFor: ReturnType<typeof vi.fn>;
}

function fakeDesktop(redirectUri = 'http://127.0.0.1:41420/callback'): FakeDesktop {
  const opened: string[] = [];
  const redirectUriFor = vi.fn(async () => redirectUri);
  const platform: SnugPlatform = {
    kind: 'desktop',
    oauth: {
      redirectUriFor,
      openExternal: async (url) => {
        opened.push(url);
      },
      channelFor: () => ({ onmessage: null, close: () => undefined }),
      cancel: async () => undefined,
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
  return { platform, opened, redirectUriFor };
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
  const wizard = await import('../state/connectionWizard.js');
  wizard.__resetConnectionWizardForTests();
  const sheet = await import('../connections/ConnectionWizardSheet.js');
  return { db, wizard, Sheet: sheet.ConnectionWizardSheet };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
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

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

async function click(name: RegExp): Promise<void> {
  const target = button(name);
  if (target === undefined) {
    throw new Error(`no button matching ${String(name)} — rendered: ${container?.textContent?.slice(0, 400) ?? ''}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(fieldKey: string, value: string): Promise<void> {
  const input = container?.querySelector<HTMLInputElement>(`input[data-field-key="${fieldKey}"]`);
  if (input === null || input === undefined) throw new Error(`no input for declared field ${fieldKey}`);
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function declare(db: UserDb, requirement: Record<string, unknown>, approve = true): void {
  db.installApp({ appId: APP, displayName: 'Desktop App', html: '<p>x</p>' });
  db.putDeclaredConnection(APP, requirement['slot'] as string, requirement, 'registry' as never);
  if (approve) db.approveConnection(APP, requirement['slot'] as string);
}

afterEach(async () => {
  if (root !== undefined) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
  }
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

describe('(b) desktop skips the blank pre-open — the OS opener needs no gesture escape (amendment 7)', () => {
  it('the credentials-save call site opens NO window; openExternal carries the sign-in; cancel returns to idle', async () => {
    const desktop = fakeDesktop();
    const { db, wizard, Sheet } = await fresh(desktop.platform);
    declare(db, fakeIdpRequirement);
    const windowOpen = vi.spyOn(window, 'open');

    wizard.openConnectionWizard({ appId: APP, slot: 'fake-idp', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);
    await type('client_id', 'cid-1');
    await click(/connect my Fake IdP account/i);

    expect(windowOpen, 'no blank about:blank window on desktop — both pre-open sites must skip').not.toHaveBeenCalled();
    expect(desktop.opened, 'the system browser carries the sign-in').toHaveLength(1);
    expect(wizard.connectionFlowStatusStore.get().state).toBe('awaiting_callback');

    // The explicit cancel affordance — the abandonment story for a handle-less popup.
    await click(/cancel this sign-in/i);
    expect(wizard.connectionFlowStatusStore.get().state).toBe('idle');

    // The connect screen's retry is the SECOND pre-open call site: same rules. The
    // shipped retry passes no clientCreds, so the mint refuses (its error copy renders
    // with a retry — the AC8 catch) — what matters HERE is that no webview window was
    // pre-opened on the way in.
    await click(/sign in to Fake IdP/i);
    expect(windowOpen, 'the retry call site must skip the blank pre-open too').not.toHaveBeenCalled();
    expect(wizard.connectionFlowStatusStore.get().state).toBe('error');
    windowOpen.mockRestore();
  });
});

describe('(c) the register screen draws the redirect URI from the platform source', () => {
  it('desktop fixed-port: the platform URI is displayed with a copy button, resolved with the entry posture', async () => {
    const desktop = fakeDesktop();
    const { db, wizard, Sheet } = await fresh(desktop.platform);
    const spotify = lookupWellKnownProvider('Spotify')!;
    const requirement = requirementFromRegistryEntry(spotify, 'Spotify', 'spotify');
    declare(db, requirement as unknown as Record<string, unknown>);

    wizard.openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);
    await settle();

    expect(desktop.redirectUriFor).toHaveBeenCalledWith({ provider: 'Spotify', posture: 'loopback-fixed-port' });
    const code = container!.querySelector('[data-testid="register-redirect-uri"]');
    expect(code?.textContent).toBe('http://127.0.0.1:41420/callback');
    expect(button(/copy/i), 'the exact URI must be one tap to copy').toBeDefined();
    // The web literal must NOT leak onto the desktop register screen.
    expect(container!.textContent).not.toContain(`${window.location.origin}/oauth/callback`);
  });

  it('web: the register screen still shows the origin literal synchronously (the e2e contract)', async () => {
    const { db, wizard, Sheet } = await fresh();
    const spotify = lookupWellKnownProvider('Spotify')!;
    const requirement = requirementFromRegistryEntry(spotify, 'Spotify', 'spotify');
    declare(db, requirement as unknown as Record<string, unknown>);

    wizard.openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);

    const code = container!.querySelector('[data-testid="register-redirect-uri"]');
    expect(code?.textContent).toBe(`${window.location.origin}/oauth/callback`);
    expect(container!.textContent).toMatch(/register once per provider/i);
  });
});

describe('(d) unsupported postures get a refusal screen BEFORE credentials (AC6)', () => {
  it('a GitHub OAuth-app row on desktop refuses with the provider named and steers to the PAT option', async () => {
    const desktop = fakeDesktop();
    const { db, wizard, Sheet } = await fresh(desktop.platform);
    const github = lookupWellKnownProvider('GitHub')!;
    const oauthOption = (github.authOptions ?? []).find((option) => option.kind === 'oauth2_auth_code')!;
    const requirement = requirementFromRegistryEntry(github, 'GitHub', 'github', oauthOption);
    declare(db, requirement as unknown as Record<string, unknown>);

    wizard.openConnectionWizard({ appId: APP, slot: 'github', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);

    const refusal = container!.querySelector('[data-testid="desktop-oauth-refusal"]');
    expect(refusal, 'the refusal must land before any credential screen').not.toBeNull();
    expect(refusal!.textContent).toContain('GitHub');
    expect(refusal!.textContent).toMatch(/personal access token/i);
    // BEFORE credentials means literally: no credential input anywhere in the sheet.
    expect(container!.querySelector('input[data-field-key]')).toBeNull();
    // And no forward affordance into the credential half.
    expect(button(/got my credentials/i)).toBeUndefined();
  });

  it('the SAME row on web renders the normal register walk-through — no refusal', async () => {
    const { db, wizard, Sheet } = await fresh();
    const github = lookupWellKnownProvider('GitHub')!;
    const oauthOption = (github.authOptions ?? []).find((option) => option.kind === 'oauth2_auth_code')!;
    const requirement = requirementFromRegistryEntry(github, 'GitHub', 'github', oauthOption);
    declare(db, requirement as unknown as Record<string, unknown>);

    wizard.openConnectionWizard({ appId: APP, slot: 'github', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);

    expect(container!.querySelector('[data-testid="desktop-oauth-refusal"]')).toBeNull();
  });
});

describe('(e) browserCallable:false discloses on the WEB wizard before credentials are pasted', () => {
  async function walkToCredentials(harness: Harness, requirement: Record<string, unknown>): Promise<void> {
    declare(harness.db, requirement);
    harness.wizard.openConnectionWizard({ appId: APP, slot: requirement['slot'] as string, source: 'settings' });
    await render(<harness.Sheet />);
    await click(/approve this connection/i);
    if (button(/got my credentials/i) !== undefined) {
      await click(/got my credentials/i);
    }
    expect(harness.wizard.connectionWizardStepStore.get()).toBe('credentials');
  }

  it('Coinbase (browserCallable:false) shows the disclosure line on web', async () => {
    const harness = await fresh();
    const coinbase = lookupWellKnownProvider('Coinbase')!;
    const requirement = requirementFromRegistryEntry(coinbase, 'Coinbase', 'coinbase');
    await walkToCredentials(harness, requirement as unknown as Record<string, unknown>);

    const disclosure = container!.querySelector('[data-testid="browser-callable-disclosure"]');
    expect(disclosure, 'the advisory disclosure must land BEFORE credentials are pasted').not.toBeNull();
    expect(disclosure!.textContent).toMatch(/browser/i);
  });

  it('an ABSENT flag makes no claim either way', async () => {
    const harness = await fresh();
    await walkToCredentials(harness, fakeIdpRequirement);
    expect(container!.querySelector('[data-testid="browser-callable-disclosure"]')).toBeNull();
  });

  it('the SAME Coinbase row on desktop shows no disclosure — the wall does not exist there', async () => {
    const desktop = fakeDesktop();
    const harness = await fresh(desktop.platform);
    const coinbase = lookupWellKnownProvider('Coinbase')!;
    const requirement = requirementFromRegistryEntry(coinbase, 'Coinbase', 'coinbase');
    await walkToCredentials(harness, requirement as unknown as Record<string, unknown>);
    expect(container!.querySelector('[data-testid="browser-callable-disclosure"]')).toBeNull();
  });
});
