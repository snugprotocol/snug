// starterInstallDisclosureV4.test.tsx — TASK-20260810-p4-starters, P4-AC5 (RED).
//
// THE PRE-INSTALL DISCLOSURE SURVIVES, re-pointed at the v4 manifest shape.
//
// This is fold T-M3's resolution: the plan draft never said whether this surface lived
// or died through the rewrite, and the answer is that it LIVES. The reasoning is
// unchanged from when it was built — the install act is the one rung of the trust ladder
// the user performs themselves, and a rung taken without knowing what it carries is a
// surprise, not consent.
//
// WHAT CHANGES, and why it needs its own red test rather than an edit to the existing
// suite: the disclosure reads the manifest through `starterDeclarationForStarterId`,
// which P4 rewires to `connectionRequirementSchema`. Every field the disclosure renders
// moves with it — `providerName` becomes `provider.name`, and `declaredApiHosts` stays
// but now arrives from a strict v4 parse. A disclosure still reading the v3 seats would
// render EMPTY on every migrated manifest: no provider name, no host, just chrome. The
// existing suite would not catch that, because it injects a v3 manifest fixture.
//
// WHAT MUST NOT CHANGE, and is therefore asserted harder here than before: install is
// still the plain act as far as CONSENT goes. P4 makes it write `declared` rows (AC3),
// which is new — so the copy's promise ("you will be asked to approve") now has a
// stronger claim to defend, and the test below pins the exact distinction: a row may
// appear, an APPROVAL may not.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import RunView from '../run/RunView.js';
import { modeStore } from '../state/mode.js';
import { loadStarterHtml, STARTER_PREFIX } from '../starter/starterApps.js';
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
const DEMO_STARTER = `${STARTER_PREFIX}${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';
const BUNDLED_HTML = '<!doctype html>\n<html><body><script>const app = 1;</script></body></html>\n';

/** A v4 requirement — the ONLY manifest shape that exists after this phase. */
const V4_MANIFEST = JSON.stringify({
  slot: 'example-api',
  provider: { name: 'Example API', docsUrl: 'https://docs.example.com/api' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  registration: { consoleUrl: 'https://docs.example.com/console' },
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: [DECLARED_HOST],
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function renderRun(id: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${id}`]}>
        <Routes>
          <Route path="/run/:id" element={<RunView />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
  return container;
}

const disclosure = (): HTMLElement | null =>
  container?.querySelector('[data-testid="starter-install-disclosure"]') ?? null;

beforeEach(async () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  db = await installTestUserDb();
  // The fixture's HTML must be the bytes the INSTALL PATH actually writes, which is what
  // `loadStarterHtml` returns from the real `examples/*/app.html` glob — not a short
  // stand-in. The two-fact vouch compares the stored app HTML against the bundled
  // starter HTML, so a fixture that disagreed with the loader would fail the vouch for a
  // reason that has nothing to do with what these tests assert (and did, until this line:
  // the real connection-demo is ~19.9 KB and the stand-in was ~90 bytes). The MANIFEST is
  // still injected, which is the seat under test.
  const bundledHtml = (await loadStarterHtml(DEMO_STARTER)) ?? BUNDLED_HTML;
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: V4_MANIFEST, html: bundledHtml },
  });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  __resetDeclarationManifestsForTests();
  vi.restoreAllMocks();
});

describe('P4-AC5 — the disclosure survives, reading the v4 manifest shape', () => {
  it('names the provider from provider.name (not the deleted providerName seat)', async () => {
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure on a v4 manifest');

    expect(disclosure()?.textContent).toContain('Example API');
  });

  it('names the host the app wants to reach', async () => {
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure on a v4 manifest');

    expect(disclosure()?.textContent).toContain(DECLARED_HOST);
  });

  it('still promises a review rather than implying installing connects anything', async () => {
    // The honesty requirement, and it is under MORE pressure after AC3: install now
    // writes a row, so copy implying the connection is live would be closer to true and
    // therefore easier to let slide. It is still false — a `declared` row grants nothing.
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure on a v4 manifest');

    const copy = (disclosure()?.textContent ?? '').toLowerCase();
    expect(copy).toContain('approve');
    expect(copy, 'installing must never read as connecting').not.toContain('will connect');
  });

  it('does NOT render credential field labels — the disclosure is not the review', async () => {
    // The new negative, and it exists because the v4 manifest CAN now carry `fields`,
    // which the v3 proposal structurally could not. Rendering "API key" here would make
    // a pre-install teaser look like the strong field-by-field review and train the user
    // to expect a credential prompt one click later. The review happens after approval
    // is sought, in the wizard, with provenance copy — not on a shelf page.
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure on a v4 manifest');

    const copy = disclosure()?.textContent ?? '';
    expect(copy, 'a disclosure that shows credential inputs is a phishing surface').not.toContain('API key');
    expect(container?.querySelector('input[type="password"]'), 'no credential input pre-install').toBeNull();
  });

  it('installing writes a declared row and NO approval (the AC3/AC5 seam)', async () => {
    // The precise distinction the copy promises. AC3 makes a row appear — that is new
    // and correct. What must NOT appear is an approval: no `approved` status, no
    // `approved_at`, no frozen ceiling the user never saw.
    const el = await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure on a v4 manifest');

    const install = el.querySelector<HTMLButtonElement>('[data-testid="starter-install"]');
    expect(install).not.toBeNull();
    await act(async () => {
      install!.click();
      await new Promise((r) => setTimeout(r, 5));
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');
    await settleUntil(() => db.listConnections().length > 0, 'the copied declared row');

    const rows = db.listConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status, 'install declares — it never approves').toBe('declared');
    expect(rows[0]?.provenance).toBe('starter');
    expect(rows[0]?.approvedAt).toBeUndefined();
  });

  it('a v3-shaped manifest discloses NOTHING after the rewire', async () => {
    // Fails soft (P4-AC9) and therefore silently. This is the test that stops "the
    // disclosure still renders" from being mistaken for "the rewire happened": under the
    // old contract this manifest was the ONLY valid one, so a disclosure appearing here
    // proves the module is still parsing v3.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: {
        manifest: JSON.stringify({
          kindHint: 'api_key',
          providerName: 'Example API',
          declaredApiHosts: [DECLARED_HOST],
        }),
        html: BUNDLED_HTML,
      },
    });

    await renderRun(DEMO_STARTER);
    await settle();
    await settle();

    expect(disclosure(), 'a v3 manifest is no longer a manifest').toBeNull();
  });
});
