// connectionWizard.test.tsx — P3 (TASK-20260810-p3-wizard, parent plan §6): the
// GRANDMA WIZARD's step machine and its screens, driven against v4 `snug_connections`
// rows written by the P0 accessors.
//
// WHY A NEW FILE RATHER THAN AN EXTENSION OF authWizard.test.tsx. That suite pins the
// v3 `snug_auth_specs` sheet, whose deletion is THIS phase's named exit item (fold B1).
// Keeping the two side by side during the cutover is deliberate: the v3 suite must stay
// green until its surface is deleted, and a v4 assertion mixed into it would go green
// for the wrong reason the moment the shared sheet renders either shape.
//
// WHAT IS UNDER TEST is a SURFACE, not a line number (fold T-mn2): the component
// `ConnectionWizardSheet` and the store seam `apps/playground/src/state/connectionWizard.ts`.
// Every assertion below reads the rendered DOM the user actually sees — copy, ordering,
// affordance presence/absence — because every AC here is a claim about what a
// non-technical person is shown before they paste a secret.
//
// C1 — no test in this file writes a credential VALUE anywhere the requirement channel
// can see it. The requirement is credential-FREE by construction; the credentials step
// writes only through `UserDbCredentialStore`, and the negative tests assert the review
// screens never render a value.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionRequirement } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import { DEMO_STARTER_REQUIREMENTS } from '../agent/demoRequirement.js';
import { authShapedFailureStore } from '../state/net.js';
import {
  __resetConnectionWizardForTests,
  connectionFlowStatusStore,
  connectionWizardSlotStore,
  connectionWizardStepStore,
  connectionWizardStore,
  openConnectionWizard,
  openConnectionWizardForFailure,
  saveConnectionCredentials,
  testConnection,
  type ConnectionWizardStep,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { registerAppHost, __resetAppHostsForTest } from '../state/appHosts.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p3-wizard';

// ---------------------------------------------------------------------------
// Requirement fixtures — the four shapes the ACs name, all credential-FREE.
// ---------------------------------------------------------------------------

/**
 * The multi-field static requirement from the parent plan's motivating
 * defect: three fields, an HMAC-signed header template, a registration walkthrough. This
 * is the fixture P3-AC2 exists for — every one of these seats must reach the screen.
 */
const coinbaseRequirement = {
  slot: 'coinbase',
  provider: { name: 'Meridian Exchange', docsUrl: 'https://docs.meridian-exchange.example/' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API key', type: 'secret', description: 'the key id from your API settings page', required: true },
    { key: 'api_secret', label: 'API secret', type: 'secret', description: 'shown once when you create the key', required: true },
    { key: 'passphrase', label: 'Passphrase', type: 'secret', description: 'the passphrase you chose at key creation', required: true },
  ],
  registration: {
    consoleUrl: 'https://portal.cdp.coinbase.com/access/api',
    instructions: [
      'sign in to your Meridian Exchange account',
      'open API settings and choose new API key',
      'copy the key, the secret, and the passphrase',
    ],
  },
  request: {
    headerTemplate: {
      'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
      'CB-ACCESS-SIGN':
        '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
    },
  },
  declaredApiHosts: ['api.meridian-exchange.example', 'api.eu.meridian-exchange.example'],
} as const satisfies Record<string, unknown>;

const bearerRequirement = {
  slot: 'openweather',
  provider: { name: 'Zephyr Weather' },
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
  declaredApiHosts: ['api.zephyr-weather.example'],
} as const satisfies Record<string, unknown>;

const oauthRequirement = {
  slot: 'spotify',
  provider: { name: 'Tunecast' },
  kind: 'oauth2_auth_code',
  endpoints: {
    authorizeUrl: 'https://accounts.tunecast.example/authorize',
    tokenUrl: 'https://accounts.tunecast.example/api/token',
  },
  pkce: true,
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text', required: true }],
  registration: {
    consoleUrl: 'https://developer.tunecast.example/dashboard',
    instructions: ['create an app in the Tunecast developer dashboard', 'paste the redirect uri below into it'],
  },
  declaredApiHosts: ['api.tunecast.example'],
} as const satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderSheet(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionWizardSheet />);
  });
  await settle();
}

const text = (): string => container.textContent ?? '';

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

async function click(name: RegExp): Promise<void> {
  const target = button(name);
  if (target === undefined) throw new Error(`no button matching ${String(name)} — rendered: ${text().slice(0, 400)}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/**
 * Read a repo-relative SOURCE file. Several ACs here are claims about a SURFACE
 * ("no inference seam exists", "the false custody promise appears nowhere"), and a
 * DOM assertion cannot see a screen the test never walked or an import behind a flag.
 * Resolved from this file's own path so it survives a vitest cwd that is not the repo
 * root — and via node:path rather than `new URL`, because under vite `import.meta.url`
 * is an http: module URL, not a file: one.
 */
async function readRepoSource(relative: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  // apps/playground (vitest cwd) → repo root → the requested path.
  return fs.readFile(path.resolve(process.cwd(), '../..', relative), 'utf8');
}

/** Declare a requirement row, optionally approving it, exactly as P0/P2 would have. */
function declare(requirement: Record<string, unknown>, opts: { approve?: boolean; provenance?: string } = {}): void {
  db.putDeclaredConnection(
    APP,
    requirement['slot'] as string,
    requirement,
    (opts.provenance ?? 'inference') as never,
  );
  if (opts.approve === true) db.approveConnection(APP, requirement['slot'] as string);
}

beforeEach(async () => {
  db = await installTestUserDb();
  __resetConnectionWizardForTests();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  __resetConnectionWizardForTests();
  // Module-level registry: a registration leaking into the next test would make the
  // refresh prompt appear in suites that never stood an app up.
  __resetAppHostsForTest();
});

// ---------------------------------------------------------------------------
// P3-AC1 — the step machine
// ---------------------------------------------------------------------------

describe('P3-AC1 — step machine: review → register → credentials → connect (OAuth only) → done, per slot', () => {
  it('walks a static multi-field requirement review → register → credentials → done, ONE decision per screen', async () => {
    declare(coinbaseRequirement);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();

    // Screen 1 — review. The only forward decision on it is approving.
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('review');
    await click(/approve this connection/i);

    // Screen 2 — register. `registration` exists, so the walkthrough gets its own screen.
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('register');
    await click(/i've got my credentials|i have my credentials/i);

    // Screen 3 — credentials. One masked input per declared field, no more.
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('credentials');
    const inputs = [...container.querySelectorAll('input[type="password"]')];
    expect(inputs).toHaveLength(3);

    for (const [key, value] of [
      ['api_key', 'k-not-a-real-key'],
      ['api_secret', 's-not-a-real-secret'],
      ['passphrase', 'p-not-a-real-passphrase'],
    ] as const) {
      const input = container.querySelector<HTMLInputElement>(`input[data-field-key="${key}"]`);
      expect(input, `credentials screen must render an input for declared field ${key}`).not.toBeNull();
      await act(async () => {
        input!.value = value;
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await click(/save (my )?credentials/i);

    // Screen 4 — done. A static kind NEVER visits `connect` (that is OAuth-only).
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('done');
  });

  it('SKIPS the register screen when the requirement carries no registration walkthrough', async () => {
    declare(bearerRequirement);
    openConnectionWizard({ appId: APP, slot: 'openweather', source: 'settings' });
    await renderSheet();

    await click(/approve this connection/i);
    // No `registration` seat ⇒ nothing to walk through ⇒ never make the user tap past
    // an empty screen. One decision per screen also means: no screen without a decision.
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('credentials');
  });

  it('routes an oauth2_auth_code requirement through the connect screen before done', async () => {
    declare(oauthRequirement);
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();

    await click(/approve this connection/i);
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('register');
    await click(/i've got my credentials|i have my credentials/i);
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('credentials');

    const clientId = container.querySelector<HTMLInputElement>('input[data-field-key="client_id"]');
    expect(clientId).not.toBeNull();
    await act(async () => {
      clientId!.value = 'client-id-public-value';
      clientId!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(/connect (my )?(tunecast )?account/i);
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('connect');
  });

  it('every forward button is VERB-named — no "next"/"continue"/"ok" anywhere in the machine', async () => {
    declare(coinbaseRequirement);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();

    const forbidden = /^\s*(next|continue|ok|submit|proceed)\s*$/i;
    const seen: string[] = [];
    for (let guard = 0; guard < 4; guard += 1) {
      for (const b of container.querySelectorAll('button')) seen.push(b.textContent ?? '');
      const forward = button(/approve this connection|i've got my credentials|i have my credentials|save (my )?credentials/i);
      if (forward === undefined) break;
      await act(async () => {
        forward.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();
    }
    expect(seen.filter((label) => forbidden.test(label))).toEqual([]);
  });

  it('is PER SLOT — opening slot B leaves slot A untouched and tracks the open slot', async () => {
    declare(coinbaseRequirement);
    declare(bearerRequirement);

    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();
    expect(connectionWizardSlotStore.get()).toBe('coinbase');
    await click(/approve this connection/i);

    // The other slot is untouched by the first slot's approval.
    expect(db.getConnection(APP, 'openweather')?.status).toBe('declared');
    expect(db.getConnection(APP, 'coinbase')?.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// P3-AC2 — the review screen renders EVERYTHING the requirement carries
// ---------------------------------------------------------------------------

describe('P3-AC2 — review screen renders everything the requirement carries', () => {
  beforeEach(async () => {
    declare(coinbaseRequirement, { provenance: 'inference' });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();
  });

  it('names the provider and states the kind in PLAIN WORDS, not the discriminator', () => {
    expect(text()).toContain('Meridian Exchange');
    // The whole point of the plain-words line is that a non-technical reader learns what
    // will happen. Leaking the raw enum onto the screen is the failure mode.
    expect(text()).toMatch(/uses .*(secret|value)s? from your Meridian Exchange/i);
    expect(container.querySelector('[data-testid="review-kind-plain"]')?.textContent ?? '').not.toMatch(/api_key/);
  });

  it("renders every field's LABEL and DESCRIPTION", () => {
    for (const field of coinbaseRequirement.fields) {
      expect(text(), `field label ${field.label} must be on the review screen`).toContain(field.label);
      expect(text(), `field description for ${field.key} must be on the review screen`).toContain(field.description);
    }
  });

  it('renders the registration steps in order', () => {
    const steps = [...container.querySelectorAll('[data-testid="review-registration-steps"] li')].map(
      (li) => li.textContent ?? '',
    );
    expect(steps).toEqual(coinbaseRequirement.registration.instructions.map((s) => expect.stringContaining(s)));
  });

  it('renders the header template VERBATIM inside a code box — the user sees exactly what will be sent', () => {
    const box = container.querySelector('[data-testid="review-header-template"]');
    expect(box, 'the review must carry a header-template code box').not.toBeNull();
    expect(box!.tagName === 'CODE' || box!.querySelector('code') !== null).toBe(true);
    const rendered = box!.textContent ?? '';
    for (const [header, value] of Object.entries(coinbaseRequirement.request.headerTemplate)) {
      expect(rendered).toContain(header);
      // VERBATIM: the mustache is the point. A "prettified" template hides what is signed.
      expect(rendered).toContain(value);
    }
  });

  it('renders the COMPLETE host list with the freeze copy', () => {
    const hosts = [...container.querySelectorAll('[data-testid="review-hosts"] li')].map((li) => li.textContent ?? '');
    for (const host of coinbaseRequirement.declaredApiHosts) {
      expect(hosts.some((line) => line.includes(host))).toBe(true);
    }
    expect(text()).toMatch(/freezes? at approval|frozen (when|at)/i);
  });

  it('model-inferred provenance says "a guess, not an authority"', () => {
    expect(text()).toMatch(/a guess, not an authority/i);
    expect(text()).not.toMatch(/ships with this starter/i);
  });

  it('starter provenance says "ships with this starter" and NOT the model-guess copy', async () => {
    __resetConnectionWizardForTests();
    await act(async () => root.unmount());
    container.remove();

    db = await installTestUserDb();
    declare(oauthRequirement, { provenance: 'starter' });
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();

    expect(text()).toMatch(/ships with this starter/i);
    expect(text()).not.toMatch(/a guess, not an authority/i);
  });

  it('adds the lower-confidence band below 0.7 and omits it at or above', async () => {
    // Below the threshold: the band is the calibration move — say the model was unsure.
    db = await installTestUserDb();
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never, { confidence: 0.4 });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();
    expect(container.querySelector('[data-testid="review-low-confidence"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    __resetConnectionWizardForTests();

    db = await installTestUserDb();
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never, { confidence: 0.9 });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();
    expect(container.querySelector('[data-testid="review-low-confidence"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P3-AC3 — custody copy is ADR-0014 clause 5, VERBATIM
// ---------------------------------------------------------------------------

describe('P3-AC3 — custody copy is ADR-0014 clause 5 verbatim (fold F-M1)', () => {
  /**
   * The exact clause-5 claim. It is a HUB-custody claim, and the distinction is the whole
   * reason this AC exists: the moment a user connects a personal sync origin, their file —
   * including `snug_secrets` — legitimately leaves the device. "stays in your file on this
   * device" is then simply FALSE, and a false custody promise is worse than none.
   */
  const CLAUSE_5 = 'your keys never reach our servers — your file, including keys, goes only to storage you choose';
  const FALSE_FORM = /stay(s)? in your file on this device/i;

  const normalize = (s: string): string => s.replace(/\s+/g, ' ').replace(/[—]/g, '—').trim();

  it('renders clause 5 verbatim on the credentials screen', async () => {
    declare(bearerRequirement);
    openConnectionWizard({ appId: APP, slot: 'openweather', source: 'settings' });
    await renderSheet();
    await click(/approve this connection/i);

    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('credentials');
    expect(normalize(text())).toContain(CLAUSE_5);
  });

  it('renders clause 5 verbatim wherever OAuth client credentials are collected', async () => {
    declare(oauthRequirement);
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();
    await click(/approve this connection/i);
    await click(/i've got my credentials|i have my credentials/i);

    expect(normalize(text())).toContain(CLAUSE_5);
  });

  it('the FALSE "stays in your file on this device" form appears NOWHERE in the wizard surface', async () => {
    // Asserted at the SOURCE, not only the DOM: a screen this test never walks could still
    // carry the false promise, and the claim is about the whole surface.
    const sources = await Promise.all(
      [
        'apps/playground/src/connections/ConnectionWizardSheet.tsx',
        'apps/playground/src/state/connectionWizard.ts',
      ].map((relative) => readRepoSource(relative)),
    );
    for (const source of sources) expect(source).not.toMatch(FALSE_FORM);

    // …and not in the rendered DOM of any screen the machine can reach.
    declare(coinbaseRequirement);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();
    for (const step of ['review', 'register', 'credentials'] as const) {
      expect(text(), `false custody copy must not render on ${step}`).not.toMatch(FALSE_FORM);
      const forward = button(/approve this connection|i've got my credentials|i have my credentials/i);
      if (forward === undefined) break;
      await act(async () => forward.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
    }
  });
});

// ---------------------------------------------------------------------------
// P3-AC4 — Q3 provenance branching on the register screen
// ---------------------------------------------------------------------------

// MIGRATED 2026-08-15 (TASK-20260815, ADR-0029). WAS keyed on provenance ('registry' →
// anchor, everything else → copy-only), which made the SHIPPED Spotify starter
// (provenance 'starter', every URL substituted from the registry) render copy-paste for
// an address Snug itself pinned — the owner read it as a bug, and it was one: the rule
// protected against an author the URL no longer had. NOW keyed on the fact that matters:
// the URL's BYTES match the pinned registry value for the row's resolved provider. The
// old positive case rode the unpinned fixture brand "Tunecast", which under the byte
// rule is copy-only whatever its provenance — the positive cases moved onto the REAL
// Spotify entry, which is also the shape that ships.
describe('P3-AC4 (ADR-0029) — consoleUrl clickability keys on registry-pinned bytes, not provenance', () => {
  /**
   * The shipped starter manifest, via the exported mirror whose documented job is
   * matching the shipped manifests (Gate-5 review: a retyped copy claiming
   * "byte-shaped" keeps passing after the real manifest changes) — substitution fills
   * the rest.
   */
  const spotifyStarterManifest = DEMO_STARTER_REQUIREMENTS['starter-spotify'] as unknown as Record<string, unknown>;
  const SPOTIFY_CONSOLE = 'https://developer.spotify.com/dashboard';

  async function openRegisterScreen(requirement: Record<string, unknown>, provenance: string): Promise<void> {
    declare(requirement, { provenance });
    openConnectionWizard({ appId: APP, slot: requirement['slot'] as string, source: 'settings' });
    await renderSheet();
    await click(/approve this connection/i);
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('register');
  }

  it('STARTER provenance, registry-substituted URL: a real clickable anchor — the owner complaint this task fixes', async () => {
    await openRegisterScreen(spotifyStarterManifest, 'starter');
    const anchor = container.querySelector<HTMLAnchorElement>(
      '[data-testid="register-console-link"] a, a[data-testid="register-console-link"]',
    );
    expect(anchor, 'a registry-pinned URL gets a link whatever channel carried it').not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe(SPOTIFY_CONSOLE);
  });

  it('INFERENCE provenance under a pinned brand: clickable too — the bytes are ours', async () => {
    await openRegisterScreen(spotifyStarterManifest, 'inference');
    expect(
      container.querySelector('[data-testid="register-console-link"] a, a[data-testid="register-console-link"]'),
    ).not.toBeNull();
  });

  it('REGISTRY provenance under an UNPINNED brand: copy-only — provenance alone no longer buys a link', async () => {
    await openRegisterScreen(oauthRequirement, 'registry');
    expect(container.querySelector('[data-testid="register-console"] a')).toBeNull();
    expect(text()).toContain(oauthRequirement.registration.consoleUrl);
    expect(button(/copy/i)).toBeDefined();
  });

  it('UNPINNED provider (inference): copy-only, no anchor, the FULL url visible, and the hint tells the new truth', async () => {
    await openRegisterScreen(coinbaseRequirement, 'inference');
    expect(container.querySelector('[data-testid="register-console"] a')).toBeNull();
    // Copy-only still means the user can READ where they are being sent — truncating the
    // host is what makes a copy-only affordance a phishing aid rather than a defense.
    expect(text()).toContain(coinbaseRequirement.registration.consoleUrl);
    // ADR-0029: this branch also serves user- and starter-authored URLs no model
    // proposed, so the hint says what is actually true — we haven't pinned it.
    expect(text()).toContain('we haven’t pinned it');
    expect(button(/copy/i)).toBeDefined();
  });

  it('USER_DOCS provenance under an unpinned brand: copy-only, no anchor', async () => {
    await openRegisterScreen(coinbaseRequirement, 'user_docs');
    expect(container.querySelector('[data-testid="register-console"] a')).toBeNull();
    expect(text()).toContain(coinbaseRequirement.registration.consoleUrl);
  });
});

// ---------------------------------------------------------------------------
// P3-AC5 — registration instructions are PLAIN TEXT, never links/HTML
// ---------------------------------------------------------------------------

describe('P3-AC5 — registration instructions render plain-text, never links or HTML (the phishing channel)', () => {
  /**
   * THE THREAT, stated plainly: `registration.instructions` is LLM-authored prose that the
   * user reads immediately before pasting a secret. If a step can render as a link — or as
   * live markup — then "click here to verify your account" becomes a working phishing
   * primitive inside a surface the user trusts because the platform drew it.
   */
  const hostileRequirement = {
    ...coinbaseRequirement,
    slot: 'hostile',
    registration: {
      consoleUrl: 'https://portal.cdp.coinbase.com/access/api',
      instructions: [
        'visit https://evil.example/verify and sign in with your bank password',
        '<a href="https://evil.example">click here to finish setup</a>',
        '<img src=x onerror="alert(1)">step three',
      ],
    },
  };

  beforeEach(async () => {
    declare(hostileRequirement, { provenance: 'inference' });
    openConnectionWizard({ appId: APP, slot: 'hostile', source: 'settings' });
    await renderSheet();
  });

  it('renders no anchor and no injected element from an instruction, on the REVIEW screen', () => {
    const list = container.querySelector('[data-testid="review-registration-steps"]');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('a')).toHaveLength(0);
    expect(list!.querySelectorAll('img')).toHaveLength(0);
    // The markup must be visible AS TEXT — proof it was never parsed as HTML.
    expect(list!.textContent ?? '').toContain('<a href="https://evil.example">click here to finish setup</a>');
  });

  it('renders no anchor and no injected element from an instruction, on the REGISTER screen', async () => {
    await click(/approve this connection/i);
    const list = container.querySelector('[data-testid="register-steps"]');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('a')).toHaveLength(0);
    expect(list!.querySelectorAll('img')).toHaveLength(0);
    expect(list!.textContent ?? '').toContain('<img src=x onerror="alert(1)">step three');
  });

  it('a bare url inside an instruction is never auto-linkified anywhere in the wizard', async () => {
    for (let guard = 0; guard < 3; guard += 1) {
      const anchors = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
      expect(anchors.some((href) => href.includes('evil.example'))).toBe(false);
      const forward = button(/approve this connection|i've got my credentials|i have my credentials/i);
      if (forward === undefined) break;
      await act(async () => forward.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
    }
  });
});

// ---------------------------------------------------------------------------
// P3-AC6 — run-time inference is REMOVED (Q5: a removal, not a gating)
// ---------------------------------------------------------------------------

describe('P3-AC6 — no inference affordance renders in ANY run-opened wizard session (Q5)', () => {
  const INFERENCE_AFFORDANCE = /infer from docs|paste provider docs|provider docs \(optional/i;

  it('a run-opened session (error CTA) renders NO infer-from-docs affordance', async () => {
    declare(coinbaseRequirement, { provenance: 'inference' });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'error_cta' });
    await renderSheet();

    expect(text()).not.toMatch(INFERENCE_AFFORDANCE);
    expect(container.querySelector('textarea')).toBeNull();
    expect(button(/infer/i)).toBeUndefined();
  });

  it('a run-opened session renders no inference affordance on ANY reachable step', async () => {
    declare(coinbaseRequirement, { provenance: 'inference' });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'error_cta' });
    await renderSheet();
    for (let guard = 0; guard < 4; guard += 1) {
      expect(text()).not.toMatch(INFERENCE_AFFORDANCE);
      const forward = button(/approve this connection|i've got my credentials|i have my credentials/i);
      if (forward === undefined) break;
      await act(async () => forward.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
    }
  });

  it('the wizard SURFACE carries no inference seam at all — cited by surface, not line', async () => {
    // Q5 is a REMOVAL, not a gating (fold T-mn2): hiding the button behind a flag would
    // satisfy a DOM-only assertion while the seam stayed reachable. So this reads the two
    // named surfaces directly.
    const sheet = await readRepoSource('apps/playground/src/connections/ConnectionWizardSheet.tsx');
    const store = await readRepoSource('apps/playground/src/state/connectionWizard.ts');

    for (const [name, source] of [['ConnectionWizardSheet.tsx', sheet], ['connectionWizard.ts', store]] as const) {
      expect(source, `${name} must carry no inference seam`).not.toMatch(/runWizardInference|runAuthSpecInference|infer from docs/);
    }
  });

  it('a missing row offers manual setup + the edit-chat CTA, and never guesses', async () => {
    // No row for this slot at all (legacy or misbuilt app).
    openConnectionWizard({ appId: APP, slot: 'missing', source: 'error_cta' });
    await renderSheet();

    expect(text()).toMatch(/fix this in the app's edit chat|edit chat/i);
    expect(text()).not.toMatch(INFERENCE_AFFORDANCE);
  });
});

// ---------------------------------------------------------------------------
// P3 fold — the re-approval diff is derived from the ROW, never from the session mode
// ---------------------------------------------------------------------------

describe('P3 fold — a staged widening shows its diff at EVERY entry point, not only mode:reapprove', () => {
  /**
   * THE DEFECT, stated as the user experiences it. Two shipped entry points — the run-view
   * connect CTA (RunView) and the chat directive card (BuilderView) — call
   * `openConnectionWizard` with no `mode`, which defaults to 'connect'. The sheet gated its
   * diff on `session.mode === 'reapprove'`, so a user arriving from either one was shown
   * the plain "approve this connection" review while a staged widening — a NEW HOST
   * included — sat unmentioned on the row.
   *
   * IT IS AN HONESTY DEFECT, NOT AN ESCALATION, and the second test below pins that half:
   * the frozen ceiling never widened, because `advanceFromReview` takes the already-approved
   * no-op branch and `approveConnection` discards pending regardless. So nothing was
   * granted that the user did not grant — but they were shown a screen that omitted a
   * pending request to reach `evil.attacker.example`, and a review that omits what is being
   * asked for is the one failure this whole surface exists to prevent.
   *
   * THE FIX IS STRUCTURAL: `showDiff` derives from `needsReapproval(row)` — the SAME single
   * definition the Settings pill reads — so a future entry point that forgets to pass a
   * mode cannot reintroduce this. The mode conjunct is gone, which is why this test opens
   * with the DEFAULT mode.
   */
  const widened = {
    ...coinbaseRequirement,
    declaredApiHosts: ['api.meridian-exchange.example', 'evil.attacker.example'],
  };

  beforeEach(() => {
    declare(coinbaseRequirement, { approve: true });
    db.stagePendingRequirement(APP, 'coinbase', widened);
  });

  it('opening with the DEFAULT mode (the run CTA / directive path) still renders the diff', async () => {
    // NO `mode` — exactly what RunView and BuilderView pass.
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'directive' });
    await renderSheet();

    const diff = container.querySelector('[data-testid="reapproval-diff"]');
    expect(diff, 'a staged widening must be disclosed however the wizard was opened').not.toBeNull();
  });

  it('the NEWLY REQUESTED host is named on screen — the omission that made this a lie', async () => {
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'directive' });
    await renderSheet();

    const diff = container.querySelector('[data-testid="reapproval-diff"]')!;
    const added = [...diff.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent ?? '').join(' | ');
    expect(added).toContain('evil.attacker.example');
    // And the button is the re-approval one, not the bare "approve this connection" that
    // silently no-ops on an already-approved row.
    expect(button(/approve these changes/i), 'the diff screen owns the forward decision').toBeDefined();
    expect(button(/^approve this connection$/i)).toBeUndefined();
  });

  it('an approved row with NO pending requirement renders the ordinary review, not a diff', async () => {
    // The other direction: `needsReapproval` is false, so nothing about this change makes
    // a plain manage-visit render an empty diff.
    declare(bearerRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'openweather', source: 'settings' });
    await renderSheet();

    expect(container.querySelector('[data-testid="reapproval-diff"]')).toBeNull();
    expect(button(/approve this connection/i)).toBeDefined();
  });
});


// ---------------------------------------------------------------------------
// TASK-20260819 — the attention gate (Step 0) and its precedence
// ---------------------------------------------------------------------------

describe('TASK-20260819 AC4/AC5/AC12 — the attention gate is DERIVED, and the diff outranks it', () => {
  /**
   * WHY A GATE AND NOT A STEP (owner decision D5, from the fresh-context plan review).
   *
   * The first plan proposed adding `'attention'` to `ConnectionWizardStep`. This file's
   * own subject rejects that shape ("WHY NOT NEW STEPS", ConnectionWizardSheet.tsx), and
   * it would have broken three ways at once: `showDiff` is keyed on `step === 'review'`
   * and would have gone false the moment the wizard opened on the new step; `nextStep`
   * early-returns 'done' for a LAN requirement ABOVE its switch, so a LAN row with a live
   * 403 would have skipped the review screen entirely; and three unproven-row catch-alls
   * key on `step !== 'review'`, so all of them would have fired underneath the attention
   * screen, inverting the ADR-0025 doctrine that they sit above every step-keyed branch.
   *
   * A gate derived from the SESSION's failure copy has none of those interactions — it is
   * the same "condition on the current row" shape as `showDiff`, `lanNeedsHost` and the
   * pairing gates.
   */
  const failure = { status: 403, detail: 'Insufficient client scope' } as const;

  it('AC4: ConnectionWizardStep gained NO member — the step machine is untouched', async () => {
    // A SOURCE assertion, because the whole point is the absence of a thing: a DOM test
    // cannot see an enum member that exists but is never routed to, and a type-level test
    // would pass against a union that grew a member nothing reads.
    const source = await readRepoSource('apps/playground/src/state/connectionWizard.ts');
    const union = /export type ConnectionWizardStep =([^;]*);/.exec(source)?.[1] ?? '';
    expect(union, 'the step union must still be the five-screen machine').not.toContain('attention');
    expect(union).toContain('review');
    expect(union).toContain('done');
  });

  it('AC5/AC6: a live failure with NO staged diff renders the attention screen, naming provider, status and detail', async () => {
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'error_cta', failure });
    await renderSheet();

    const screen = container.querySelector('[data-testid="connection-attention"]');
    expect(screen, 'a live failure must open on the attention screen').not.toBeNull();
    // The provider name comes from the ROW — the user's vocabulary, not the executor's.
    expect(text()).toContain('Tunecast');
    expect(text()).toContain('403');
    expect(text()).toContain('Insufficient client scope');
  });

  it('AC12 THE COLLISION: a live failure AND a staged diff — the DIFF wins, attention is suppressed', async () => {
    // THE HIGHEST-VALUE TEST IN THIS TASK. Adding a registry scope puts EVERY existing
    // Spotify user into exactly this state on their next launch: the 403 fires (old token,
    // old consent) and the drift migration stages the new scope. Owner decision D3 — the
    // diff is the CURE, so leading with the diagnosis would hand the user an unexplained
    // consent delta one tap later.
    declare(oauthRequirement, { approve: true });
    db.stagePendingRequirement(APP, 'spotify', {
      ...oauthRequirement,
      scopes: ['user-read-recently-played'],
    });

    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'error_cta', failure });
    await renderSheet();

    expect(
      container.querySelector('[data-testid="reapproval-diff"]'),
      'the staged re-approval is what fixes this failure — it must lead',
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="connection-attention"]'),
      'the diagnosis must not preempt its own cure',
    ).toBeNull();
  });

  it('AC5: no live failure means no attention screen, whatever the source', async () => {
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();

    expect(container.querySelector('[data-testid="connection-attention"]')).toBeNull();
  });

  it('AC7: the failure is HANDED OFF — copied onto the session, and the store is cleared', async () => {
    // Decision D4. Clearing without copying was the AC contradiction the plan review
    // caught: the store is the banner's channel, and a Step 0 that read it after the CTA
    // cleared it would render blank.
    declare(oauthRequirement, { approve: true });
    authShapedFailureStore.set({ appId: APP, slot: 'spotify', status: 403, detail: 'Insufficient client scope' });

    expect(openConnectionWizardForFailure(APP)).toBe(true);

    expect(connectionWizardStore.get()?.failure?.status, 'the session carries the copy').toBe(403);
    expect(authShapedFailureStore.get(), 'the store is cleared — one owner at a time').toBeNull();
  });

  it('AC9 (the v3 lesson): a REFUSED open neither copies nor clears — the user keeps their route back', async () => {
    // `openConnectionWizard` refuses when another wizard is parked. The v3 defect this
    // pins: a CTA that treated a refusal as success dismissed the only surface offering
    // the repair, stranding the user with a broken connection and no door.
    declare(oauthRequirement, { approve: true });
    declare(bearerRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'openweather', source: 'settings' });

    authShapedFailureStore.set({ appId: APP, slot: 'spotify', status: 403 });
    expect(openConnectionWizardForFailure(APP), 'one wizard at a time').toBe(false);
    expect(authShapedFailureStore.get(), 'a refused open must leave the failure standing').not.toBeNull();
  });

  it('AC11: continuing past the attention screen lands on the ordinary review, failure cleared', async () => {
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'error_cta', failure });
    await renderSheet();

    await click(/check this connection/i);

    expect(container.querySelector('[data-testid="connection-attention"]'), 'the gate closes behind you').toBeNull();
    expect(button(/approve this connection/i), 'and the ordinary review is what follows').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P3 fold — the WRITE-level B1 wall on the one function that touches a secret
// ---------------------------------------------------------------------------

describe('P3 fold — saveConnectionCredentials refuses to write against an UNFROZEN ceiling', () => {
  /**
   * THE LAYER THIS PINS, and why a UI test could not. The existing B1 regression asserts
   * REACHABILITY — that a `declared` row renders no password input. That passes whether or
   * not the write itself refuses, so the guard inside `saveConnectionCredentials` (the
   * function's own restatement of its precondition, and the last thing standing between a
   * secret and `snug_secrets`) was unpinned: deleting it left the whole suite green.
   *
   * A credential may only be stored against a FROZEN host ceiling. Stored earlier, it is a
   * secret held against a host list the app can still change — which is the exact ordering
   * inversion B1 exists to forbid. So this drives the store DIRECTLY, with no component in
   * the path, and asserts BOTH halves: the refusal, and that nothing landed.
   */
  it('a DECLARED (unapproved) row: the call refuses and no secret is persisted', async () => {
    declare(coinbaseRequirement); // declared — never approved
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });

    const result = await saveConnectionCredentials({ api_key: 'LEAKED-SECRET-should-never-land' });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : '').toMatch(/approve this connection/i);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_key'))).toBeUndefined();
  });

  it('a REVOKED row refuses too — a tombstoned grant is not a frozen ceiling', async () => {
    declare(coinbaseRequirement, { approve: true });
    db.revokeConnection(APP, 'coinbase');
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });

    const result = await saveConnectionCredentials({ api_key: 'LEAKED-SECRET-should-never-land' });

    expect(result.ok).toBe(false);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_key'))).toBeUndefined();
  });

  it('the APPROVED row is the only one that writes — the positive control', async () => {
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });

    const result = await saveConnectionCredentials({ api_key: 'value-against-a-frozen-ceiling' });

    expect(result.ok).toBe(true);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_key'))).toBe(
      'value-against-a-frozen-ceiling',
    );
  });
});

// ---------------------------------------------------------------------------
// P3 fold — the OAuth connect screen is not a dead end
// ---------------------------------------------------------------------------

describe('P3 fold — the connect screen offers a way forward and names the provider', () => {
  /**
   * THE DEFECT IN ONE SENTENCE: this screen rendered two paragraphs and no button, so an
   * OAuth user's journey ended there — permanently. One of those paragraphs promised "a
   * sign-in window will open", and nothing in the code opened one. Copy describing
   * behavior that does not exist is worse than no copy at all, because the user waits.
   *
   * These assertions are about the SCREEN. The flow itself — popup, exchange, blocked-popup
   * error, flow binding — is driven end to end against the real OAuthService in
   * connectionOauthFlow.test.ts, because a rendered status line cannot prove a token moved.
   */
  beforeEach(async () => {
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();
    // review → (registration present) register → credentials → connect
    await click(/i've got my credentials|approve this connection/i);
    await click(/i've got my credentials/i);
    const clientId = container.querySelector<HTMLInputElement>('input[data-field-key="client_id"]');
    await act(async () => {
      clientId!.value = 'client-id-public-value';
      clientId!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(/connect (my )?(tunecast )?account/i);
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('connect');
    /**
     * The flow start is genuinely ASYNC after the credential save — it awaits the DB, the
     * B1 scope read, and the authorize-URL mint (WebCrypto PKCE) before it can install a
     * flow. A single microtask flush lands mid-mint, so polling for the transition out of
     * `idle` is what makes this deterministic rather than racy. The bounded give-up keeps
     * a genuinely-stuck flow a FAILURE rather than a hang.
     */
    for (let attempt = 0; attempt < 40 && connectionFlowStatusStore.get().state === 'idle'; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  });

  it('the flow has actually STARTED — the screen is waiting on a real sign-in, not idle', () => {
    // THE ASSERTION THE DEAD END COULD NOT PASS. Arriving at `connect` used to change
    // nothing: the status stayed `idle` forever because no code path ever left it. A
    // started flow is the difference between a screen that is waiting and a screen that is
    // stuck, and only one of those is honest to show a person.
    const status = connectionFlowStatusStore.get();
    expect(status.state, `the connect step must start a flow, not sit idle (was ${status.state})`).not.toBe('idle');
    expect(status.state).toBe('awaiting_callback');
  });

  it('names the PROVIDER in its status copy, never a generic "please wait"', () => {
    const status = container.querySelector('[data-testid="connect-status"]');
    expect(status, 'the connect screen must state what is happening').not.toBeNull();
    // "waiting for Spotify sign-in" tells a person which window to look for; "please wait"
    // tells them nothing they can act on. The grammar is OProject's, ported with the flow.
    expect(status!.textContent ?? '').toMatch(/waiting for Tunecast sign-in/i);
  });

  it('an IDLE or ERRORED connect screen always offers a way forward — it is never button-less', async () => {
    // The state the dead end actually shipped in. Drive the flow into `error` (the shape a
    // blocked popup produces) and assert the screen offers a retry: a terminal screen with
    // one 'close' button is exactly what stranded every OAuth user.
    await act(async () => {
      connectionFlowStatusStore.set({ state: 'error', message: 'the sign-in window was blocked' });
    });
    await settle();

    const forward = [...container.querySelectorAll('button')]
      .map((b) => b.textContent ?? '')
      .filter((label) => !/^\s*close\s*$/i.test(label));
    expect(forward, 'an errored connect screen must offer a retry').not.toEqual([]);
    expect(button(/sign(ing)? in to Tunecast/i)).toBeDefined();
  });

  it('a BLOCKED popup surfaces its authorize URL as a real route through', async () => {
    await act(async () => {
      connectionFlowStatusStore.set({
        state: 'error',
        message: 'the sign-in window was blocked — allow popups for this site and try again',
        authorizeUrl: 'https://accounts.tunecast.example/authorize?client_id=cid&state=s',
      });
    });
    await settle();

    const link = container.querySelector<HTMLAnchorElement>('[data-testid="connect-fallback-link"]');
    expect(link, 'a blocked popup must leave the user a way to reach the provider').not.toBeNull();
    expect(link!.getAttribute('href')).toContain('accounts.tunecast.example/authorize');
  });
});

// ---------------------------------------------------------------------------
// P3 fold — Q7: the "test this connection" probe on the done screen
// ---------------------------------------------------------------------------

describe('P3 fold — Q7: the done screen probes the connection when the requirement declares a test', () => {
  /**
   * WHAT WAS MISSING. P1 shipped `executeConnectionTestRequest` — carefully: GET-only by
   * schema, `new URL(path, base)` rather than concatenation, routed through the SAME ten
   * gates as every other call — and it had ZERO production callers. The schema seat
   * (`testRequest`) existed, the executor existed, and no screen ever reached either. That
   * is verbatim the defect P2 was flagged for: a package-level seam whose security
   * properties hold by test construction because nothing ships them.
   *
   * WHY THE DONE SCREEN IS THE RIGHT PLACE. It is the only moment where a person has just
   * pasted credentials and does not yet know whether they work. Without a probe, the first
   * feedback is a NET_AUTH_FAILED inside their running app — far from the screen where the
   * fix is a two-second re-paste.
   *
   * WHY IT IS CONDITIONAL. Nothing is invented: a connection that declares no probe is not
   * probeable, because synthesizing a path would be the host guessing at a provider's API
   * surface and sending live credentials at the guess.
   */
  const probeRequirement = {
    ...bearerRequirement,
    slot: 'probe-weather',
    testRequest: { method: 'GET', pathAndQuery: '/data/2.5/weather?q=London' },
  };

  async function walkToDone(requirement: Record<string, unknown>): Promise<void> {
    declare(requirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: requirement['slot'] as string, source: 'settings' });
    await renderSheet();
    // An already-approved row still opens on `review` (the manage view); approving is a
    // no-op that simply advances. No `registration` seat ⇒ straight to credentials.
    await click(/approve this connection/i);
    const token = container.querySelector<HTMLInputElement>('input[data-field-key="token"]');
    await act(async () => {
      token!.value = 'token-value-for-the-probe';
      token!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(/save (my )?credentials/i);
    expect(connectionWizardStepStore.get()).toBe<ConnectionWizardStep>('done');
  }

  it('offers the probe ONLY when the requirement declares a testRequest', async () => {
    await walkToDone(probeRequirement);
    expect(button(/test this connection/i), 'a declared testRequest earns a probe button').toBeDefined();
  });

  it('offers NO probe when the requirement declares none — nothing is invented', async () => {
    await walkToDone({ ...bearerRequirement, slot: 'no-probe' });
    expect(button(/test this connection/i)).toBeUndefined();
  });

  /**
   * The RESULT assertions drive the store directly rather than the button, because the
   * outcome depends on a network round trip and the point being pinned is what the probe
   * RETURNS — that it went through the real executor, that a failure is reported as a
   * failure, and that no credential comes back. The injected fetch reaches the executor as
   * `fetchImpl`, so every gate above it still applies: this cannot be used to skip the
   * frozen ceiling, the confirm, or the scrub.
   */
  it('runs through the REAL executor and reports a pass, carrying no credential back (C1)', async () => {
    await walkToDone(probeRequirement);

    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const outcome = await testConnection(async (url, init) => {
      seenUrl = url;
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    expect(outcome.ok).toBe(true);
    // The probe was built from the FROZEN host and the DECLARED path — never a guess.
    expect(seenUrl).toBe('https://api.zephyr-weather.example/data/2.5/weather?q=London');
    // The credential DID reach the provider (proving this is the real injection path)…
    expect(JSON.stringify(seenHeaders)).toContain('token-value-for-the-probe');
    // …and NOTHING derived from it comes back to the caller. The outcome carries a status
    // and nothing else, so there is no seat a value could ride out through.
    expect(JSON.stringify(outcome)).not.toContain('token-value-for-the-probe');
  });

  it('a FAILED probe is reported honestly rather than swallowed into "it works"', async () => {
    await walkToDone(probeRequirement);

    const outcome = await testConnection(
      async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    // A done screen that reports success regardless is the exact dishonesty this feature
    // exists to remove: the user would leave believing a broken connection works, and
    // meet the failure later inside their running app.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('HTTP_401');
    // The copy names the status and the REPAIR — the executor's own `ok` is true here
    // (the HTTP call succeeded), so this translation is the whole reason the probe exists
    // rather than a thin echo of the executor's verdict.
    expect(outcome.message).toMatch(/rejected these credentials/i);
    // The provider's error BODY never reaches the user: it is the most likely place for a
    // credential echo and this is the worst place to print one.
    expect(outcome.message).not.toContain('unauthorized');
    expect(JSON.stringify(outcome)).not.toContain('token-value-for-the-probe');
  });

  it('the rendered result never carries a credential value into the DOM (C1)', async () => {
    await walkToDone(probeRequirement);
    await click(/test this connection/i);
    await settle();
    // Whatever the outcome in this environment, the pasted value must appear NOWHERE —
    // not in the result line, not in an error message, not in a debug echo.
    expect(container.innerHTML).not.toContain('token-value-for-the-probe');
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 AC3b (ADR-0028, plan-review blocker 2) — scopes are VISIBLE
// ---------------------------------------------------------------------------
//
// RED-FIRST against a sheet that renders scopes NOWHERE. ADR-0028's whole justification
// is "a pinned scope list is not silent because the user sees it" — these tests are what
// make that claim true rather than fiction (the protocol comment claiming "scopes is
// what the review renders" described rendering that did not exist).

describe('AC3b — scopes render on the review screen and as a reapproval delta (ADR-0028)', () => {
  const scoped = {
    ...oauthRequirement,
    scopes: ['playlist-read-private', 'user-modify-playback-state'],
  };

  it('the review screen lists every scope, in declaration order', async () => {
    declare(scoped);
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();

    const block = container.querySelector('[data-testid="review-scopes"]');
    expect(block, 'a scoped sign-in must disclose what it may do BEFORE approval').not.toBeNull();
    const items = [...block!.querySelectorAll('li')].map((node) => node.textContent ?? '');
    expect(items).toEqual(['playlist-read-private', 'user-modify-playback-state']);
  });

  it('NEGATIVE: a requirement with no scopes renders no scopes block', async () => {
    declare(oauthRequirement);
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();

    expect(container.querySelector('[data-testid="review-scopes"]')).toBeNull();
  });

  it('a scopes-ONLY staged edit renders a visible delta — never a diff whose every line reads unchanged', async () => {
    declare(oauthRequirement, { approve: true });
    db.stagePendingRequirement(APP, 'spotify', scoped);
    openConnectionWizard({ appId: APP, slot: 'spotify', source: 'settings' });
    await renderSheet();

    const diff = container.querySelector('[data-testid="reapproval-scope-diff"]');
    expect(diff, 'the scope delta IS the whole change — it must be the visible one').not.toBeNull();
    const added = [...diff!.querySelectorAll('[data-diff="added"]')].map((node) => node.textContent ?? '').join(' | ');
    expect(added).toContain('playlist-read-private');
    expect(added).toContain('user-modify-playback-state');
  });

  it('NEGATIVE: a host-widening diff with no scopes anywhere renders no scope-diff box', async () => {
    declare(coinbaseRequirement, { approve: true });
    db.stagePendingRequirement(APP, 'coinbase', {
      ...coinbaseRequirement,
      declaredApiHosts: [...coinbaseRequirement.declaredApiHosts, 'evil.attacker.example'],
    });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();

    expect(container.querySelector('[data-testid="reapproval-diff"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="reapproval-scope-diff"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TASK-20260819-inbox-copilot-fixes AC1/AC2 — the verified-connection refresh prompt
// ---------------------------------------------------------------------------

/**
 * The wizard proves a connection works and then throws that knowledge away: the probe
 * outcome dies with the sheet, and the app the user came from is still showing sample
 * data with nothing admitting it has not caught up. This suite pins the prompt that
 * closes that gap, and — more importantly — pins WHEN it may appear.
 *
 * The gate is VERIFIED, not "saved". `awaitingProbe` already encodes that distinction
 * for the heading (TASK-20260815 AC6: "connected" is earned, not declared), and the
 * prompt inherits it: offering to load real data off an unproven credential would teach
 * exactly the misplaced trust that AC6 exists to prevent.
 */
describe('TASK-20260819 — the verified-connection refresh prompt', () => {
  // A provider name that resolves to NO registry entry: a borrowed brand may not author
  // its own `fields`/`testRequest` (the registry's pinned values are substituted), and
  // this suite needs a probeable row it fully controls.
  const bearer = {
    provider: { name: 'Probe Fixture Co' },
    kind: 'bearer_token',
    declaredApiHosts: ['api.probe-fixture.example'],
    fields: [{ key: 'token', label: 'Token', type: 'password' }],
  };
  const probeRow = {
    ...bearer,
    slot: 'refresh-probe',
    testRequest: { method: 'GET', pathAndQuery: '/v1/ping' },
  };

  async function walkToDone(requirement: Record<string, unknown>): Promise<void> {
    declare(requirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: requirement['slot'] as string, source: 'settings' });
    await renderSheet();
    await click(/approve this connection/i);
    const token = container.querySelector<HTMLInputElement>('input[data-field-key="token"]');
    await act(async () => {
      token!.value = 'a-token-value';
      token!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(/save (my )?credentials/i);
  }

  it('AC1: a probeable row offers NO refresh prompt until the probe passes', async () => {
    // The load-bearing negative. Credentials are saved and the row is approved — but
    // nothing has proven the credential works, so offering to replace real data on the
    // strength of it would be the host asserting something it does not know.
    //
    // A live host is registered FIRST so this fails for the right reason: without it the
    // assertion would pass merely because there was no app to tell.
    registerAppHost(APP, () => {});
    await walkToDone(probeRow);
    expect(
      container.querySelector('[data-testid="connection-refresh-prompt"]'),
      'an unproven credential must not invite a data replacement',
    ).toBeNull();
  });

  it('AC1: an OAuth row offers the prompt on arrival — the token round trip already proved it', async () => {
    // OAuth kinds are deliberately unprobeable (a minted token IS the proof), so the
    // prompt must not wait for a probe that will never be offered. Without this branch
    // the feature would be dead for exactly the connection kind Inbox Copilot uses.
    declare(
      {
        provider: { name: 'Gmail' },
        slot: 'gmail',
        kind: 'oauth2_auth_code',
        declaredApiHosts: ['gmail.googleapis.com'],
        endpoints: {
          authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
      },
      { approve: true },
    );
    // The prompt is only offered when there IS a running app to tell — this suite must
    // stand one up, exactly as RunView does when the app is on screen.
    registerAppHost(APP, () => {});
    openConnectionWizard({ appId: APP, slot: 'gmail', source: 'settings' });
    await renderSheet();
    await act(async () => {
      connectionWizardStepStore.set('done');
    });
    await settle();

    expect(container.querySelector('[data-testid="connection-refresh-prompt"]')).not.toBeNull();
  });

  it('AC1: the prompt says what it replaces, and declining is a first-class choice', async () => {
    declare(
      {
        provider: { name: 'Gmail' },
        slot: 'gmail-copy',
        kind: 'oauth2_auth_code',
        declaredApiHosts: ['gmail.googleapis.com'],
        endpoints: {
          authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
      },
      { approve: true },
    );
    registerAppHost(APP, () => {});
    openConnectionWizard({ appId: APP, slot: 'gmail-copy', source: 'settings' });
    await renderSheet();
    await act(async () => {
      connectionWizardStepStore.set('done');
    });
    await settle();

    const prompt = container.querySelector('[data-testid="connection-refresh-prompt"]');
    expect(prompt?.textContent ?? '').toMatch(/sample|example|demo/i);
    // Declining must be a visible button, not "close the sheet and hope": a person who
    // wants to keep looking at the demo is making a legitimate choice.
    expect(button(/not now|keep|later/i), 'declining must be an explicit affordance').toBeDefined();
  });
});
