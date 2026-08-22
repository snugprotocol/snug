// webSurfaceWizard.test.tsx — TASK-20260822-gmail-dual-mode (ADR-0049 §1).
//
// The RUNTIME decides which registration walkthrough the register screen renders:
// on web (`getPlatform().oauth === undefined` — the same predicate that already picks
// the origin-literal redirect display, so walkthrough and displayed URI cannot
// disagree) a provider that declares the web seats gets its `webRegistration` copy; on
// desktop, and for every provider without the seats, the row's own persisted
// registration renders exactly as today. Nothing is persisted: the override is
// RENDER-TIME registry data in `desktopRedirectPosture`'s ADR-0021 §1 class, and the
// anti-phishing property survives because the substituted copy is still sourced
// exclusively from the human-reviewed registry (AL-04 D5).
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

const APP = 'app-web-surface';

function fakeDesktop(): SnugPlatform {
  return {
    kind: 'desktop',
    oauth: {
      redirectUriFor: vi.fn(async () => 'http://127.0.0.1:49152/callback'),
      openExternal: async () => undefined,
      channelFor: () => ({ onmessage: null, close: () => undefined }),
      cancel: async () => undefined,
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
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
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await Promise.resolve();
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

async function click(name: RegExp): Promise<void> {
  const target = [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? ''));
  if (target === undefined) {
    throw new Error(`no button matching ${String(name)} — rendered: ${container?.textContent?.slice(0, 400) ?? ''}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

function declare(db: UserDb, requirement: Record<string, unknown>): void {
  db.installApp({ appId: APP, displayName: 'Web Surface App', html: '<p>x</p>' });
  db.putDeclaredConnection(APP, requirement['slot'] as string, requirement, 'registry' as never);
  db.approveConnection(APP, requirement['slot'] as string);
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

function gmailRequirement(): Record<string, unknown> {
  const gmail = lookupWellKnownProvider('Gmail')!;
  return requirementFromRegistryEntry(gmail, 'Gmail', 'gmail') as unknown as Record<string, unknown>;
}

// --------------------------------------------------- the resolver, as a table

describe('webSurfaceRegistrationFor — the runtime picks the walkthrough, never the user', () => {
  it('web + gmail: the Web-application walkthrough, from the registry', async () => {
    const { wizard } = await fresh();
    const registration = wizard.webSurfaceRegistrationFor(gmailRequirement() as never);
    expect(registration).toBeDefined();
    expect(registration?.instructions?.join('\n')).toContain('"Web application"');
    // And it is the REGISTRY's block, not the row's: the persisted row carries the
    // desktop walkthrough (emitter test in packages/auth pins that). The marker is the
    // desktop walkthrough's own step-5 phrasing — the web copy also NAMES "Desktop
    // app" (as the type NOT to choose), so the bare name is not a discriminator.
    expect(registration?.instructions?.join('\n')).not.toContain('type "Desktop app"');
  });

  it('desktop + gmail: undefined — the row renders its own (desktop) walkthrough', async () => {
    const { wizard } = await fresh(fakeDesktop());
    expect(wizard.webSurfaceRegistrationFor(gmailRequirement() as never)).toBeUndefined();
  });

  it('web + spotify (no web seats): undefined — providers without the seats are untouched', async () => {
    const { wizard } = await fresh();
    const spotify = lookupWellKnownProvider('Spotify')!;
    const requirement = requirementFromRegistryEntry(spotify, 'Spotify', 'spotify');
    expect(wizard.webSurfaceRegistrationFor(requirement as never)).toBeUndefined();
  });

  it('web + unknown provider: undefined — no registry entry, no substitution source', async () => {
    const { wizard } = await fresh();
    const requirement = {
      slot: 'idp',
      provider: { name: 'Some Private IdP' },
      kind: 'oauth2_auth_code',
      endpoints: { authorizeUrl: 'https://idp.example/a', tokenUrl: 'https://idp.example/t' },
      pkce: true,
      declaredApiHosts: ['api.idp.example'],
    };
    expect(wizard.webSurfaceRegistrationFor(requirement as never)).toBeUndefined();
  });

  it('web + a row that borrowed the gmail NAME with a different kind: undefined — the walkthrough describes an OAuth client, and only the default flow', async () => {
    const { wizard } = await fresh();
    const requirement = { ...gmailRequirement(), kind: 'api_key' };
    expect(wizard.webSurfaceRegistrationFor(requirement as never)).toBeUndefined();
  });
});

// ------------------------------------------------- the register screen renders

describe('the gmail register screen branches by runtime (AC1/AC2)', () => {
  it('web: the "Web application" walkthrough renders, with the origin-literal redirect to paste', async () => {
    const { db, wizard, Sheet } = await fresh();
    declare(db, gmailRequirement());

    wizard.openConnectionWizard({ appId: APP, slot: 'gmail', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);
    await settle();

    const text = container!.textContent ?? '';
    expect(text).toContain('"Web application"');
    // The desktop walkthrough's step-5 phrasing must be gone; the bare name "Desktop
    // app" is not a discriminator (the web copy names it as the type NOT to choose).
    expect(text).not.toContain('type "Desktop app"');
    const code = container!.querySelector('[data-testid="register-redirect-uri"]');
    expect(code?.textContent).toBe(`${window.location.origin}/oauth/callback`);
  });

  it('desktop: the "Desktop app" walkthrough renders unchanged (regression pin)', async () => {
    const { db, wizard, Sheet } = await fresh(fakeDesktop());
    declare(db, gmailRequirement());

    wizard.openConnectionWizard({ appId: APP, slot: 'gmail', source: 'settings' });
    await render(<Sheet />);
    await click(/approve this connection/i);
    await settle();

    const text = container!.textContent ?? '';
    expect(text).toContain('"Desktop app"');
    expect(text).not.toContain('"Web application"');
  });
});
