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
import { STARTER_PREFIX } from '../starter/starterApps.js';
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

const VALID_MANIFEST = JSON.stringify({
  kindHint: 'api_key',
  providerName: 'Example API',
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
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: VALID_MANIFEST, html: BUNDLED_HTML },
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

  it('installing is still the plain act — no auth row, no credential', async () => {
    // Guards the claim the copy makes. If install ever started writing an auth row, this
    // test fails and the copy above becomes a lie.
    const el = await renderRun(DEMO_STARTER);
    await settleUntil(() => disclosure() !== null, 'the install disclosure');

    const install = el.querySelector<HTMLButtonElement>('[data-testid="starter-install"]');
    expect(install).not.toBeNull();
    await act(async () => {
      install!.click();
      await new Promise((r) => setTimeout(r, 5));
    });
    await settleUntil(() => db.listApps().length > 0, 'the starter to be installed');

    // P3: the grant surface is v4 `snug_connections`; the claim is unchanged — installing
    // is the plain act, and no grant row (let alone an approved one) may appear from it.
    expect(db.listConnections(), 'installing must not approve or create a connection').toHaveLength(0);
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
