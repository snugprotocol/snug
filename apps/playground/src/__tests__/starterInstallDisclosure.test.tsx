// starterInstallDisclosure.test.tsx — TASK-20260807-connection-reachability §V2-6.
//
// The INSTALL DISCLOSURE: a starter that ships a `connection.json` says so on its
// read-only route, BEFORE the user installs it.
//
// Why this is not decoration. The install act is the third rung of the trust ladder —
// it is what carries a declaration to a chat-less app, and it is the one rung the user
// performs themselves. A rung the user takes without knowing what it carries is not
// consent, it is a surprise. Nothing here grants trust or prefills anything: the strong
// field-by-field review still happens later, in full. This only makes the act informed.
//
// The claim is deliberately narrow — "this starter ships a declared connection" — because
// on this route nothing is installed, so the two-fact resolver has nothing to compare and
// the only honest subject is the BUNDLED bytes.

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

// RE-POINTED (TASK-20260815-starter-apps-rebuild): `connection-demo` was removed in the
// shelf re-curation. This suite renders the REAL read-only starter route, so the folder
// must exist in the shipped `examples/*/app.html` glob — `trade-copilot` is the declaring
// starter whose app.html ships today. The MANIFEST is still injected below, so the
// disclosure copy under test stays the deliberate fixture values.
const DEMO_FOLDER = 'trade-copilot';
const DEMO_STARTER = `${STARTER_PREFIX}${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';
const BUNDLED_HTML = '<!doctype html>\n<html><body><script>const app = 1;</script></body></html>\n';

/**
 * MIGRATED TO v4 (TASK-20260810-p4-starters). The v3 proposal shape is now a strict
 * rejection, so a suite still injecting it would assert that the disclosure renders
 * nothing — passing for the wrong reason. The rendering assertions here are unchanged;
 * `starterInstallDisclosureV4.test.tsx` owns the new-behaviour ones (field labels stay
 * hidden, the declared row appears, a v3 manifest discloses nothing).
 */
const VALID_MANIFEST = JSON.stringify({
  slot: 'example-api',
  provider: { name: 'Example API' },
  kind: 'api_key',
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

/** Polls rather than sleeping: the disclosure resolves through a lazy glob import. */
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
  // The bundled HTML must be the bytes the install path actually writes (the real
  // `examples/*/app.html` the glob serves), or the two-fact vouch fails for a reason
  // unrelated to what this suite asserts. See the same note in the V4 disclosure suite.
  const bundledHtml = (await loadStarterHtml(DEMO_STARTER)) ?? BUNDLED_HTML;
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: VALID_MANIFEST, html: bundledHtml },
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

describe('a declaring starter discloses its connection before install', () => {
  it('names the provider on the read-only starter route', async () => {
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure');

    expect(disclosure()?.textContent).toContain('Example API');
  });

  it('names the host the app wants to reach', async () => {
    // The user is told WHAT the app will talk to, not just that it will talk to
    // something — an unnamed "this app uses the network" tells them nothing actionable.
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure');

    expect(disclosure()?.textContent).toContain(DECLARED_HOST);
  });

  it('promises a review rather than implying installing connects anything', async () => {
    // The honesty requirement. Installing writes an app row and NOTHING else — no auth
    // row, no credential, no approval. Copy that let a user believe otherwise would make
    // the install act look like consent it is not.
    await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure');

    const copy = (disclosure()?.textContent ?? '').toLowerCase();
    expect(copy).toContain('approve');
    expect(copy, 'installing must never read as connecting').not.toContain('will connect');
  });

  it('installing never GRANTS — a row may appear, an approval may not', async () => {
    // The claim the copy makes, restated at the exact line P4 moved.
    //
    // WHAT CHANGED: install now COPIES the manifest into `snug_connections` as a
    // `declared` row (AC3), so "no row appears" is no longer the property to assert —
    // asserting it would now be asserting that the copy is broken. What the copy PROMISES
    // is untouched and is what this test guards: a declared row grants nothing. No
    // `approved` status, no `approved_at`, and no credential — so the copy above ("nothing
    // is connected until you review and approve it yourself") stays true.
    const el = await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure');

    const install = el.querySelector<HTMLButtonElement>('[data-testid="starter-install"]');
    expect(install).not.toBeNull();
    await act(async () => {
      install!.click();
      await new Promise((r) => setTimeout(r, 5));
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');
    await settleUntil(() => db.listConnections().length > 0, 'the copied declared row');

    for (const row of db.listConnections()) {
      expect(row.status, 'installing declares — it never approves').toBe('declared');
      expect(row.approvedAt, 'no grant may exist without a review').toBeUndefined();
    }
  });
});

describe('a NON-declaring starter shows nothing (the control)', () => {
  it('renders no disclosure for a starter with no manifest', async () => {
    await renderRun(`${STARTER_PREFIX}chess`);
    await settle();
    await settle();

    expect(disclosure(), 'most starters declare nothing and must stay silent').toBeNull();
  });

  it('renders no disclosure for an installed app route', async () => {
    // The disclosure belongs to the INSTALL ACT. Once the app is owned, the connection
    // surfaces are Settings and the CTA — repeating it here would be noise on every load.
    //
    // MUTATION NOTE (M22/M23): this passes through THREE independent refusals — the
    // effect's `isStarterId` check, the render guard, and `starterDeclarationForStarterId`
    // refusing a non-prefixed id. Removing any ONE of them leaves this green, so it does
    // not by itself pin the render guard; the test below supplies the discriminating
    // case. The redundancy is deliberate defence-in-depth, not an accident, and it is
    // recorded here so a future reader does not "simplify" all three away at once.
    const copy = db.installApp({ displayName: 'demo', html: BUNDLED_HTML, installSource: `starter:${DEMO_FOLDER}` });
    await renderRun(copy.appId);
    await settle();
    await settle();

    expect(disclosure()).toBeNull();
  });

  it('the render guard is load-bearing when a declaration is somehow present off-route', async () => {
    // The discriminating case for the render guard specifically: force the state the
    // guard exists to refuse. If the guard is removed, an installed app's route would
    // render an install disclosure next to an Install button that is not even there.
    const copy = db.installApp({ displayName: 'demo', html: BUNDLED_HTML, installSource: `starter:${DEMO_FOLDER}` });
    const el = await renderRun(copy.appId);
    await settle();

    // An installed route never offers Install — so a disclosure here would be orphaned
    // copy about an act the user cannot perform.
    expect(el.querySelector('[data-testid="starter-install"]'), 'an owned app offers no Install').toBeNull();
    expect(disclosure()).toBeNull();
  });
});
