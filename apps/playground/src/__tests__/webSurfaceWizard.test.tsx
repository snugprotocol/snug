// webSurfaceWizard.test.tsx — TASK-20260822-gmail-dual-mode (ADR-0049 §1).
//
// The RUNTIME decides which registration walkthrough the wizard renders: on web
// (`getPlatform().oauth === undefined` — the same predicate that already picks the
// origin-literal redirect display, so walkthrough and displayed URI cannot disagree) a
// provider that declares the web seats gets its `webRegistration` copy on BOTH the
// review screen's "how you get them" and the register screen; on desktop, and for
// every provider without the seats, the row's own persisted registration renders
// exactly as today. Nothing is persisted: the override is RENDER-TIME registry data in
// `desktopRedirectPosture`'s ADR-0021 §1 class, and the anti-phishing property
// survives because the substituted copy is still sourced exclusively from the
// human-reviewed registry (AL-04 D5) — and because the override BINDS TO THE ROW'S
// ENDPOINTS, not its name (the Gate-5 review's R-4 finding, pinned below).
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionRequirement } from '@snugprotocol/protocol';

import { lookupWellKnownProvider, requirementFromRegistryEntry } from '@snugprotocol/auth';

import {
  cleanupSheet,
  clickSheetButton,
  declareSheetConnection,
  fakeDesktopPlatform,
  freshWizardSheet,
  renderSheet,
  settleSheet,
  sheetContainer,
} from './wizardSheetHarness.js';

const APP = 'app-web-surface';

afterEach(cleanupSheet);

function gmailRequirement(): ConnectionRequirement {
  return requirementFromRegistryEntry(lookupWellKnownProvider('Gmail')!, 'Gmail', 'gmail');
}

// --------------------------------------------------- the resolver, as a table

describe('webSurfaceRegistrationFor — the runtime picks the walkthrough, never the user', () => {
  it('web + gmail: the Web-application walkthrough, from the registry', async () => {
    const { wizard } = await freshWizardSheet();
    const registration = wizard.webSurfaceRegistrationFor(gmailRequirement());
    expect(registration).toBeDefined();
    expect(registration?.instructions?.join('\n')).toContain('"Web application"');
    // And it is the REGISTRY's block, not the row's: the persisted row carries the
    // desktop walkthrough (emitter test in packages/auth pins that). The marker is the
    // desktop walkthrough's own step-5 phrasing — the web copy also NAMES "Desktop
    // app" (as the type NOT to choose), so the bare name is not a discriminator.
    expect(registration?.instructions?.join('\n')).not.toContain('type "Desktop app"');
  });

  it('web + a BRAND-ADJACENT gmail row: still the web walkthrough — resolution follows admission, not exact keys', async () => {
    // The hue lesson (display names are not registry keys): a borrow-admitted row named
    // "Gmail Premium" carried the gmail entry's SUBSTITUTED desktop walkthrough and
    // endpoints; an exact-key miss here would render those desktop steps on web beside
    // a web redirect URI. `resolveRegistryEntryByName`'s brand-adjacent rung must
    // resolve it exactly as `consoleUrlIsClickable` and admission substitution do.
    const { wizard } = await freshWizardSheet();
    const requirement = { ...gmailRequirement(), provider: { name: 'Gmail Premium' } };
    expect(wizard.webSurfaceRegistrationFor(requirement)?.instructions?.join('\n')).toContain('"Web application"');
  });

  it('web + a row NAMED Gmail whose endpoints are NOT the pinned ones: undefined — the override binds to endpoints, not names', async () => {
    // The R-4 channel (imported rows, where substitution never re-ran): a provider
    // NAME is a claim any row can make. Dressing an attacker-endpointed row in Snug's
    // pinned Google walkthrough would lend wizard-grade legitimacy to a flow that
    // sends the pasted client_secret to the row's own endpoints. Endpoints are where
    // the credential GOES, so they are the seat the override binds to; the mismatched
    // row keeps its own registration under the existing copy-only honesty rules.
    const { wizard } = await freshWizardSheet();
    const requirement: ConnectionRequirement = {
      ...gmailRequirement(),
      endpoints: {
        authorizeUrl: 'https://accounts.evil.example/authorize',
        tokenUrl: 'https://accounts.evil.example/token',
      },
    };
    expect(wizard.webSurfaceRegistrationFor(requirement)).toBeUndefined();
  });

  it('desktop + gmail: undefined — the row renders its own (desktop) walkthrough', async () => {
    const { wizard } = await freshWizardSheet(fakeDesktopPlatform().platform);
    expect(wizard.webSurfaceRegistrationFor(gmailRequirement())).toBeUndefined();
  });

  it('web + spotify (no web seats): undefined — providers without the seats are untouched', async () => {
    const { wizard } = await freshWizardSheet();
    const spotify = lookupWellKnownProvider('Spotify')!;
    expect(wizard.webSurfaceRegistrationFor(requirementFromRegistryEntry(spotify, 'Spotify', 'spotify'))).toBeUndefined();
  });

  it('web + unknown provider: undefined — no registry entry, no substitution source', async () => {
    const { wizard } = await freshWizardSheet();
    const requirement = {
      slot: 'idp',
      provider: { name: 'Some Private IdP' },
      kind: 'oauth2_auth_code',
      endpoints: { authorizeUrl: 'https://idp.example/a', tokenUrl: 'https://idp.example/t' },
      pkce: true,
      declaredApiHosts: ['api.idp.example'],
    } as ConnectionRequirement;
    expect(wizard.webSurfaceRegistrationFor(requirement)).toBeUndefined();
  });

  it('web + a row that borrowed the gmail NAME with a different kind: undefined — the walkthrough describes an OAuth client', async () => {
    const { wizard } = await freshWizardSheet();
    const requirement = { ...gmailRequirement(), kind: 'api_key' } as unknown as ConnectionRequirement;
    expect(wizard.webSurfaceRegistrationFor(requirement)).toBeUndefined();
  });
});

// ------------------------------------------------- the wizard screens render

describe('the gmail wizard branches by runtime (AC1/AC2) — review AND register agree', () => {
  it('web: BOTH screens carry the "Web application" walkthrough, with the origin-literal redirect to paste', async () => {
    const { db, wizard, Sheet } = await freshWizardSheet();
    declareSheetConnection(db, APP, gmailRequirement());

    wizard.openConnectionWizard({ appId: APP, slot: 'gmail', source: 'settings' });
    await renderSheet(<Sheet />);

    // The REVIEW screen's "how you get them" guidance is already the web copy — the
    // adjacent-screens contradiction (review saying "Desktop app", register saying
    // "Web application") is the exact defect the Gate-5 review caught.
    const review = sheetContainer()!.textContent ?? '';
    expect(review).toContain('"Web application"');
    expect(review).not.toContain('type "Desktop app"');

    await clickSheetButton(/approve this connection/i);
    await settleSheet();

    const register = sheetContainer()!.textContent ?? '';
    expect(register).toContain('"Web application"');
    expect(register).not.toContain('type "Desktop app"');
    const code = sheetContainer()!.querySelector('[data-testid="register-redirect-uri"]');
    expect(code?.textContent).toBe(`${window.location.origin}/oauth/callback`);
    // The console link keeps its one-tap affordance: the displayed URL is routed
    // through the SAME ADR-0029 byte-match as every other render (one mechanism).
    expect(sheetContainer()!.querySelector('[data-testid="register-console-link"] a')).not.toBeNull();
  });

  it('desktop: the "Desktop app" walkthrough renders unchanged (regression pin)', async () => {
    const { db, wizard, Sheet } = await freshWizardSheet(fakeDesktopPlatform().platform);
    declareSheetConnection(db, APP, gmailRequirement());

    wizard.openConnectionWizard({ appId: APP, slot: 'gmail', source: 'settings' });
    await renderSheet(<Sheet />);
    await clickSheetButton(/approve this connection/i);
    await settleSheet();

    const text = sheetContainer()!.textContent ?? '';
    expect(text).toContain('type "Desktop app"');
    expect(text).not.toContain('"Web application"');
  });
});
