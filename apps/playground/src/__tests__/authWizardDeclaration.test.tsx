// authWizardDeclaration.test.tsx — TASK-20260807-connection-reachability §V2-1/V2-7.
//
// The SHEET half of the install-act channel. The declaration reaches `AuthWizardSheet`
// as its own immutable session field; this file pins that it lands the user in the STRONG
// field-by-field review and stays there.
//
// The finding that shaped this file (3-lens design review, MAJOR 2): the `spec_confirm`
// branch ships an "infer from docs" button whose `applyInferenceResult` overwrites the
// LIVE session's `provenance` and `proposal`. Gating the strong review on provenance
// alone would therefore let ONE CLICK launder a declaration into the light
// approve-as-is path — with T3 and T5 still green. Hence `session.declaration !==
// undefined` as an independent disjunct, and T3b, which drives that exact click.
//
//   T3  — a declaration session renders the strong review, prefilled
//   T3b — mid-session inference cannot reach the light path
//   T3c — a static-kind strand: infer-from-docs must not WIPE the declared hosts
//   T5  — the copy claims only what was proven ("ships with", never "you approved")

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthWizardSheet } from '../connections/AuthWizardSheet.js';
import {
  __resetWizardStateForTests,
  applyInferenceResult,
  openWizard,
  wizardStore,
} from '../state/wizard.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-declared';
const DECLARED_HOST = 'api.example.com';

/** The manifest an installed `connection-demo` would have carried onto the session. */
const DECLARATION = {
  providerName: 'Example API',
  kindHint: 'api_key',
  declaredApiHosts: [DECLARED_HOST],
};

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderSheet(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AuthWizardSheet />);
  });
  await settle();
}

function byLabel(label: string): HTMLInputElement {
  const el = container.querySelector(`[aria-label="${label}"]`);
  expect(el, `no element labeled "${label}"`).not.toBeNull();
  return el as HTMLInputElement;
}

const text = (): string => container.textContent ?? '';

/** The hosts the user is told will receive the credential. */
function disclosedHosts(): string[] {
  return [...container.querySelectorAll('[data-testid="wizard-hosts"] li')].map((li) =>
    (li.textContent ?? '').trim(),
  );
}

beforeEach(async () => {
  __resetWizardStateForTests();
  await installTestUserDb();
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Connection Demo', html: '<p>x</p>' });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  __resetWizardStateForTests();
  vi.restoreAllMocks();
});

/** Opens the CTA session the resolver would have produced for a declaring app. */
function openDeclared(): void {
  openWizard({ source: 'error_cta', appId: APP, mode: 'connect', declaration: DECLARATION });
}

describe('T3 — a declaration lands in the STRONG review, prefilled', () => {
  it('renders the field-by-field spec_confirm branch, not the light approve-as-is path', async () => {
    openDeclared();
    await renderSheet();

    // The provider-name field only exists on the spec_confirm branch.
    expect(byLabel('provider name').value).toBe('Example API');
  });

  it('prefills the declared hosts into the reviewable draft', async () => {
    openDeclared();
    await renderSheet();

    expect(byLabel('api hosts (comma-separated)').value).toContain(DECLARED_HOST);
  });

  it('discloses the declared host in the full host list the user approves', async () => {
    openDeclared();
    await renderSheet();

    expect(disclosedHosts().join(' '), 'the host disclosure is on EVERY path').toContain(DECLARED_HOST);
  });

  it('a session with NO declaration keeps today’s light path', async () => {
    // The control. Without this, every assertion above could pass because the sheet
    // renders spec_confirm unconditionally.
    openWizard({ source: 'error_cta', appId: APP, mode: 'connect' });
    await renderSheet();

    expect(container.querySelector('[aria-label="provider name"]'), 'no declaration ⇒ no strong review').toBeNull();
  });
});

describe('T3b — no mid-session action can reach the light path (MAJOR 2)', () => {
  it('running inference on a declaration session KEEPS the strong review', async () => {
    openDeclared();
    await renderSheet();

    // The laundering click, driven directly: the inferrer returns the registry rung,
    // which is exactly the provenance that does NOT force spec_confirm.
    await act(async () => {
      applyInferenceResult({
        ok: true,
        provenance: 'registry',
        proposal: { providerName: 'Example API', kindHint: 'api_key', declaredApiHosts: [DECLARED_HOST] },
        evidence: [],
        confidence: 1,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();

    expect(wizardStore.get()?.provenance, 'the inferrer really did overwrite provenance').toBe('registry');
    expect(
      container.querySelector('[aria-label="provider name"]'),
      'a declaration session must NEVER fall back to approve-as-is',
    ).not.toBeNull();
  });

  it('the declaration field itself survives the inference (it is immutable)', async () => {
    openDeclared();
    await renderSheet();

    await act(async () => {
      applyInferenceResult({
        ok: true,
        provenance: 'registry',
        proposal: { providerName: 'Something Else', kindHint: 'api_key' },
        evidence: [],
        confidence: 1,
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(wizardStore.get()?.declaration?.declaredApiHosts).toEqual([DECLARED_HOST]);
  });
});

describe('T3c — inference must not WIPE the declared hosts from the reviewed draft (C4)', () => {
  it('an inferrer proposal with NO hosts falls back to the declared ones', async () => {
    // `AuthWizardSheet` re-seeds the draft from `session.proposal` on every session
    // change. Without the fallback the user reviews a host-less form — the strong review
    // is intact but the transformer refuses it, so the declaration is silently useless.
    openDeclared();
    await renderSheet();

    await act(async () => {
      applyInferenceResult({
        ok: true,
        provenance: 'inference',
        proposal: { providerName: 'Example API', kindHint: 'api_key' }, // no declaredApiHosts
        evidence: [],
        confidence: 0.5,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();

    expect(
      byLabel('api hosts (comma-separated)').value,
      'the declared hosts must survive an inferrer that returns none',
    ).toContain(DECLARED_HOST);
    expect(disclosedHosts().join(' ')).toContain(DECLARED_HOST);
  });

  it('an inferrer that DOES return hosts wins — the user sees what they will approve', async () => {
    // The fallback is a fallback, not an override. If the inferrer found real hosts,
    // those are what the transformer will build from, so those are what must be shown.
    openDeclared();
    await renderSheet();

    await act(async () => {
      applyInferenceResult({
        ok: true,
        provenance: 'inference',
        proposal: { providerName: 'Example API', kindHint: 'api_key', declaredApiHosts: ['other.example.com'] },
        evidence: [],
        confidence: 0.5,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();

    expect(byLabel('api hosts (comma-separated)').value).toContain('other.example.com');
  });
});

describe('T5 — the copy claims only what the install act actually proved', () => {
  it('says the app SHIPS with a declared connection', async () => {
    openDeclared();
    await renderSheet();

    expect(text().toLowerCase()).toContain('ships with');
  });

  it('never claims the user already approved anything at install', async () => {
    // V2-2's corrected copy. The install act proves the app came from this repo with a
    // manifest — it proves nothing about consent, which is what this review is FOR.
    openDeclared();
    await renderSheet();

    const copy = text().toLowerCase();
    expect(copy).not.toContain('you approved');
    expect(copy).not.toContain('already approved');
    expect(copy).not.toContain('approved at install');
  });

  it('shows no declaration copy on a session that has none', async () => {
    openWizard({ source: 'error_cta', appId: APP, mode: 'connect' });
    await renderSheet();

    expect(text().toLowerCase()).not.toContain('ships with');
  });
});
