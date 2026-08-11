// connectionSettings.test.tsx — P3 (TASK-20260810-p3-wizard, parent plan §6): the
// slot-aware Settings → Connections surface, the re-approval DIFF journey, the
// reconnect-after-revoke disclosure, and the P2 inferrer-rewire carry-forward.
//
// These four ACs share a file because they share a claim: what Settings SHOWS about a
// connection must be DERIVED from the v4 row, never from a parallel state the UI
// invents. Every drift between the row and the pill is a lie told to the only person who
// can act on it.
//
// C1 — nothing here writes or reads a credential VALUE.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONNECTION_STATUSES } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { ConnectionSlotsCard } from '../views/ConnectionSlotsCard.js';
import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import {
  __resetConnectionWizardForTests,
  connectionWizardStepStore,
  openConnectionWizard,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p3-settings';
const OTHER_APP = 'app-p3-settings-2';

const coinbaseRequirement = {
  slot: 'coinbase',
  provider: { name: 'Meridian Exchange' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API key', type: 'secret', required: true },
    { key: 'api_secret', label: 'API secret', type: 'secret', required: true },
  ],
  declaredApiHosts: ['api.meridian-exchange.example'],
} as const satisfies Record<string, unknown>;

const weatherRequirement = {
  slot: 'openweather',
  provider: { name: 'Zephyr Weather' },
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
  declaredApiHosts: ['api.zephyr-weather.example'],
} as const satisfies Record<string, unknown>;

let container: HTMLDivElement;
let root: Root;
let db: UserDb;

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
    root.render(node);
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

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="connection-slot-row"]')];
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
});

// ---------------------------------------------------------------------------
// P3-AC7 — Settings slot rows
// ---------------------------------------------------------------------------

describe('P3-AC7 — one Settings row per (app, slot) with provider, kind, and a status pill', () => {
  it('renders one row per (app, slot), each naming its provider and kind', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.putDeclaredConnection(APP, 'openweather', weatherRequirement, 'starter' as never);
    db.putDeclaredConnection(OTHER_APP, 'openweather', weatherRequirement, 'starter' as never);

    await render(<ConnectionSlotsCard />);

    // THREE rows, not two: (app, slot) is the identity — the same provider in two apps is
    // two independent grants, and collapsing them would let one app's approval speak for
    // another's.
    expect(rows()).toHaveLength(3);

    const keys = rows().map((row) => `${row.dataset['appId']}:${row.dataset['slot']}`);
    expect(new Set(keys)).toEqual(new Set([`${APP}:coinbase`, `${APP}:openweather`, `${OTHER_APP}:openweather`]));

    const coinbaseRow = rows().find((row) => row.dataset['slot'] === 'coinbase')!;
    expect(coinbaseRow.textContent ?? '').toContain('Meridian Exchange');

    /**
     * THE KIND CELL IS ASSERTED BY ITS ACTUAL COPY (fold), not merely for being non-empty.
     * A `not.toBe('')` assertion is satisfied by any placeholder — replacing `kindCopy(row)`
     * with the literal 'x' left the whole suite green while the user saw 'x' as the
     * connection kind. What this cell has to do is tell a non-technical reader what will
     * happen to their account, so the test pins the plain-words copy AND pins that two
     * different kinds read differently — a wrong-kind copy is as bad as a placeholder.
     * Mirrors the AC2 discipline already used for review-kind-plain.
     */
    const kindOf = (slot: string, appId = APP): string =>
      rows()
        .find((row) => row.dataset['appId'] === appId && row.dataset['slot'] === slot)!
        .querySelector('[data-testid="slot-kind"]')?.textContent ?? '';

    expect(kindOf('coinbase')).toMatch(/api keys/i); // api_key
    expect(kindOf('openweather')).toMatch(/secret token/i); // bearer_token
    expect(kindOf('coinbase')).not.toBe(kindOf('openweather'));
    // And the raw discriminator never reaches the screen — same rule as the review kind.
    expect(text()).not.toMatch(/api_key|bearer_token|oauth2_auth_code/);
  });

  /**
   * THE HAZARD THIS CLOSES. Settings lists across every app on purpose ("what have I
   * connected?" is a question about the person's whole hub), and the same provider
   * connected inside two apps is TWO independent grants with two frozen ceilings. The rows
   * were correctly kept separate in DATA — but on screen they rendered as two visually
   * identical entries, each with its own destructive `disconnect` button, distinguishable
   * only by an invisible `data-app-id`. That reintroduces at the presentation layer exactly
   * the confusion the (app, slot) keying was designed to prevent: a user revokes one
   * believing they cut off both, or cuts off the wrong app entirely.
   */
  it('names the OWNING APP on each row, so two grants for one provider are distinguishable on screen', async () => {
    db.installApp({ appId: APP, displayName: 'my trading helper', html: '<!doctype html><body>a</body>' });
    db.installApp({ appId: OTHER_APP, displayName: 'my portfolio board', html: '<!doctype html><body>b</body>' });
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.putDeclaredConnection(OTHER_APP, 'coinbase', coinbaseRequirement, 'inference' as never);

    await render(<ConnectionSlotsCard />);

    const both = rows().filter((row) => row.dataset['slot'] === 'coinbase');
    expect(both).toHaveLength(2);
    const first = both.find((row) => row.dataset['appId'] === APP)!;
    const second = both.find((row) => row.dataset['appId'] === OTHER_APP)!;

    expect(first.textContent ?? '').toContain('my trading helper');
    expect(second.textContent ?? '').toContain('my portfolio board');
    // The load-bearing half: RENDERED TEXT distinguishes them, not just a data attribute.
    expect(first.textContent).not.toBe(second.textContent);
  });

  it('falls back to the appId when no installed app row names it — never a blank owner', async () => {
    // A connection can outlive (or precede) an installed app row; a blank owner beside a
    // destructive button is worse than an ugly identifier.
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);

    await render(<ConnectionSlotsCard />);
    const row = rows().find((r) => r.dataset['slot'] === 'coinbase')!;
    expect(row.querySelector('[data-testid="slot-app"]')?.textContent ?? '').toContain(APP);
  });

  it('shows the three persisted statuses on their pills', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.putDeclaredConnection(APP, 'openweather', weatherRequirement, 'starter' as never);
    db.approveConnection(APP, 'openweather');
    db.putDeclaredConnection(OTHER_APP, 'openweather', weatherRequirement, 'starter' as never);
    db.approveConnection(OTHER_APP, 'openweather');
    db.revokeConnection(OTHER_APP, 'openweather');

    await render(<ConnectionSlotsCard />);

    const pill = (appId: string, slot: string): string =>
      rows()
        .find((row) => row.dataset['appId'] === appId && row.dataset['slot'] === slot)!
        .querySelector('[data-testid="slot-status-pill"]')!.textContent ?? '';

    expect(pill(APP, 'coinbase')).toMatch(/declared|not connected/i);
    expect(pill(APP, 'openweather')).toMatch(/connected/i);
    expect(pill(OTHER_APP, 'openweather')).toMatch(/revoked/i);
  });

  it('"needs re-approval" is DERIVED from approved + pending — never a fourth status value', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');
    db.stagePendingRequirement(APP, 'coinbase', {
      ...coinbaseRequirement,
      declaredApiHosts: ['api.meridian-exchange.example', 'api.eu.meridian-exchange.example'],
    });

    await render(<ConnectionSlotsCard />);

    const row = rows().find((r) => r.dataset['slot'] === 'coinbase')!;
    expect(row.querySelector('[data-testid="slot-status-pill"]')!.textContent ?? '').toMatch(/needs re-approval/i);

    // THE LOAD-BEARING HALF (fold B2). The row's persisted status is still `approved`:
    // the grant keeps serving. If "needs re-approval" ever became a fourth status value,
    // a stage-time write would move a row OUT of `approved` — which is exactly the silent
    // de-authorization the pending column exists to prevent.
    const stored = db.getConnection(APP, 'coinbase')!;
    expect(stored.status).toBe('approved');
    expect(CONNECTION_STATUSES).not.toContain('needs_re_approval');
    expect(row.dataset['status']).toBe('approved');
    expect(row.dataset['needsReapproval']).toBe('true');
  });

  it('an approved row with NO pending requirement does not claim it needs re-approval', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');

    await render(<ConnectionSlotsCard />);
    const row = rows().find((r) => r.dataset['slot'] === 'coinbase')!;
    expect(row.querySelector('[data-testid="slot-status-pill"]')!.textContent ?? '').not.toMatch(/needs re-approval/i);
    expect(row.dataset['needsReapproval']).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// P3-AC8 — the re-approval diff journey
// ---------------------------------------------------------------------------

describe('P3-AC8 — a staged pending requirement renders a field-by-field old→pending diff', () => {
  const pending = {
    ...coinbaseRequirement,
    fields: [
      { key: 'api_key', label: 'API key', type: 'secret', required: true },
      { key: 'api_secret', label: 'API secret', type: 'secret', required: true },
      { key: 'passphrase', label: 'Passphrase', type: 'secret', required: true },
    ],
    declaredApiHosts: ['api.meridian-exchange.example', 'api.eu.meridian-exchange.example'],
  };

  beforeEach(async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');
    db.stagePendingRequirement(APP, 'coinbase', pending);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings', mode: 'reapprove' });
    await render(<ConnectionWizardSheet />);
  });

  it('renders the diff old→pending, marking the ADDED field and the ADDED host', () => {
    const diff = container.querySelector('[data-testid="reapproval-diff"]');
    expect(diff, 'a staged requirement must render a diff, not a bare re-approve button').not.toBeNull();

    const added = [...diff!.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent ?? '').join(' | ');
    expect(added).toContain('Passphrase');
    expect(added).toContain('api.eu.meridian-exchange.example');

    // What did NOT change must read as unchanged — a diff that flags everything teaches
    // the user to approve without reading, which is the failure this screen exists to stop.
    const unchanged = [...diff!.querySelectorAll('[data-diff="unchanged"]')].map((n) => n.textContent ?? '').join(' | ');
    expect(unchanged).toContain('api.meridian-exchange.example');
  });

  it('ONLY re-approval promotes the pending requirement — rendering the diff changes nothing', () => {
    const row = db.getConnection(APP, 'coinbase')!;
    expect(row.pendingRequirement).toBeDefined();
    expect(row.requirement.fields).toHaveLength(2);
    expect(row.allowedHosts).toEqual(['api.meridian-exchange.example']);
  });

  it('re-approving promotes pending → live and re-freezes the ceiling', async () => {
    await click(/re-approve this connection|approve these changes/i);

    const row = db.getConnection(APP, 'coinbase')!;
    expect(row.pendingRequirement).toBeUndefined();
    expect(row.requirement.fields).toHaveLength(3);
    expect(row.allowedHosts).toEqual(expect.arrayContaining(['api.meridian-exchange.example', 'api.eu.meridian-exchange.example']));
    expect(row.status).toBe('approved');
  });

  it('dismissing the diff without re-approving leaves the OLD grant serving', async () => {
    const cancel = button(/keep the current connection|not now|cancel/i);
    expect(cancel, 'the diff screen must offer a way out that does not promote').toBeDefined();
    await act(async () => cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();

    const row = db.getConnection(APP, 'coinbase')!;
    expect(row.pendingRequirement).toBeDefined();
    expect(row.allowedHosts).toEqual(['api.meridian-exchange.example']);
  });
});

// ---------------------------------------------------------------------------
// P3-AC9 — reconnect-after-revoke disclosure, keyed by PROVIDER/HOST not slot
// ---------------------------------------------------------------------------

describe('P3-AC9 — the post-revoke disclosure is keyed by provider/host and survives a slot rename', () => {
  /**
   * WHY NOT SLOT-KEYED. A slot-keyed disclosure is trivially evadable: re-declare the same
   * provider under a fresh slot name and the "you revoked this before" notice vanishes. The
   * evasion never yields silent credential REUSE — credentials are wiped at revoke and the
   * new slot lands `declared`, facing the full strong review — so this is UX HONESTY, not a
   * security boundary. It is asserted here precisely because honesty that only holds when
   * nobody tries to evade it is not honesty.
   */
  it('discloses the prior revocation when reconnecting the SAME slot, with the tombstone date', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');
    const revoked = db.revokeConnection(APP, 'coinbase');

    db.putDeclaredConnection(APP, 'coinbase-2', { ...coinbaseRequirement, slot: 'coinbase-2' }, 'inference' as never);
    openConnectionWizard({ appId: APP, slot: 'coinbase-2', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    const notice = container.querySelector('[data-testid="revoked-before-notice"]');
    expect(notice, 'a previously revoked provider must be disclosed on reconnect').not.toBeNull();
    expect(notice!.textContent ?? '').toMatch(/revoked/i);
    expect(notice!.textContent ?? '').toContain((revoked.revokedAt ?? '').slice(0, 10));
  });

  it('SURVIVES A SLOT RENAME — the same provider under a fresh slot name still discloses', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');
    db.revokeConnection(APP, 'coinbase');

    // The evasion: same provider, same hosts, brand-new slot id.
    db.putDeclaredConnection(
      APP,
      'my-trading-helper',
      { ...coinbaseRequirement, slot: 'my-trading-helper' },
      'inference' as never,
    );
    openConnectionWizard({ appId: APP, slot: 'my-trading-helper', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    expect(container.querySelector('[data-testid="revoked-before-notice"]')).not.toBeNull();
    expect(text()).toMatch(/Meridian Exchange/);
  });

  it('discloses on a HOST match even when the provider NAME was changed too', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');
    db.revokeConnection(APP, 'coinbase');

    db.putDeclaredConnection(
      APP,
      'fresh-slot',
      { ...coinbaseRequirement, slot: 'fresh-slot', provider: { name: 'Crypto Helper' } },
      'inference' as never,
    );
    openConnectionWizard({ appId: APP, slot: 'fresh-slot', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    expect(container.querySelector('[data-testid="revoked-before-notice"]')).not.toBeNull();
  });

  it('does NOT disclose for an unrelated provider with no revoked history', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    db.approveConnection(APP, 'coinbase');
    db.revokeConnection(APP, 'coinbase');

    db.putDeclaredConnection(APP, 'openweather', weatherRequirement, 'starter' as never);
    openConnectionWizard({ appId: APP, slot: 'openweather', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    expect(container.querySelector('[data-testid="revoked-before-notice"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P3-AC10 — the P2 inferrer-rewire carry-forward
// ---------------------------------------------------------------------------

describe('P3-AC10 — the wizard routes to createConnectionRequirementInferrer, and the v3 inferrer is unreachable', () => {
  /**
   * THE CARRY-FORWARD, stated honestly. P2 shipped `createConnectionRequirementInferrer`
   * with NO production caller, while the shipped wizard still dynamically imported the v3
   * `runAuthSpecInference`. Until this is rewired, P2's AC7 ("inference never sees
   * credentials") holds only BY TEST CONSTRUCTION, not on the path that actually ships.
   * These assertions read the SOURCE because the claim is about reachability, and a DOM
   * assertion cannot see a dynamic import.
   */
  const wizardSurfaces = [
    'apps/playground/src/state/connectionWizard.ts',
    'apps/playground/src/connections/ConnectionWizardSheet.tsx',
    'apps/playground/src/state/wizard.ts',
  ];

  /**
   * Repo-relative SOURCE read. Resolved from the vitest cwd (apps/playground) rather
   * than `import.meta.url`, because under vite that is an http: module URL and
   * `fileURLToPath` rejects it.
   */
  async function readRepo(relative: string): Promise<string> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return fs.readFile(path.resolve(process.cwd(), '../..', relative), 'utf8');
  }

  it('no wizard surface reaches the v3 runAuthSpecInference / inferrerAdapter seam', async () => {
    for (const relative of wizardSurfaces) {
      let source: string;
      try {
        source = await readRepo(relative);
      } catch {
        continue; // a surface deleted by this phase's cutover is trivially unreachable
      }
      expect(source, `${relative} must not reach the v3 inferrer`).not.toMatch(
        /runAuthSpecInference|inferrerAdapter/,
      );
    }
  });

  /**
   * WHY THE SOURCE-GREP THAT USED TO LIVE HERE WAS DELETED, stated so nobody restores it.
   *
   * It walked `apps/playground/src` for any non-test file whose TEXT contained
   * 'createConnectionRequirementInferrer' and asserted the hit list was non-empty. That is
   * satisfied by `connectionInferrerAdapter.ts` — the module that merely IMPORTS the
   * identifier — whether or not anything calls it. Proven by mutation: renaming the ONE
   * production wire (`recoverRequirement` in useBuilderChat's post-turn seam) to
   * `recoverRequirementDISABLED` restored P2's exact "no production caller" state and the
   * ENTIRE playground suite stayed green, 461/461. An AC written to close a carry-forward
   * that cannot observe the carry-forward regressing is not a gate.
   *
   * The replacement below drives the shipped path instead — it is in
   * `connectionRecovery.test.tsx`, because proving a production wire runs means running the
   * production surface (`useBuilderChat`), not reading it.
   */
  it('the run wizard exposes no inference entry point at all (Q5 removal, restated at the store)', async () => {
    const store = await readRepo('apps/playground/src/state/connectionWizard.ts');
    expect(store).not.toMatch(/export (async )?function run\w*Inference/);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the step machine's credentials screen is unreachable pre-approval
// ---------------------------------------------------------------------------

describe('P3 regression — the B1 order wall survives the rebuild', () => {
  it('a declared (unapproved) row can never render a credential input', async () => {
    db.putDeclaredConnection(APP, 'coinbase', coinbaseRequirement, 'inference' as never);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    expect(connectionWizardStepStore.get()).toBe('review');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(db.getConnection(APP, 'coinbase')!.status).toBe('declared');
  });
});
