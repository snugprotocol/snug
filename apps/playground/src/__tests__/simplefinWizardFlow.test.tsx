// TASK-20260818-ledger-starter A4 (ADR-0038): the token-claim wizard family.
//
// THE CONSTRAINT THIS FILE EXISTS TO ENFORCE (review SF4): a token-claim row's kind is
// plain `basic_auth` — shared with genuinely typed providers — so nothing about the ROW
// alone distinguishes it. Routing keys on the resolved registry pairing seat
// (`tokenClaimPairingFor`, the `lanPairingExchangeFor` single-resolution rule), and the
// three consequences are each pinned here:
//
//   1. the sheet renders the PASTE screen where the typed credentials screen would be,
//      and never two boxes nothing can fill;
//   2. `saveConnectionCredentials` REFUSES the family (with its positive twin: the
//      claim path still writes — a refusal that is total refuses its own callers,
//      lessons 2026-08-17);
//   3. a custom user-authored basic_auth provider keeps the typed screen.
//
// C1: the tests assert the minted pair lands in `snug_secrets` and NOWHERE else — no
// result object, no rendered copy, no store.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionRequirement } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '@snugprotocol/db';

import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import { createMemoryBackend, openUserDb } from '@snugprotocol/db';
import { admitConnectionRequirement } from '@snugprotocol/auth';

import {
  __resetConnectionWizardForTests,
  claimConnectionVerified,
  migrateConnectionRegistryDrift,
  connectionWizardStepStore,
  isTokenClaimRequirement,
  openConnectionWizard,
  runTokenClaim,
  saveConnectionCredentials,
  tokenClaimPairingFor,
} from '../state/connectionWizard.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';
import { resetUserDbForTests, setUserDbForTests } from '../state/userdb.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-simplefin-wizard';

/**
 * The BARE manifest shape — exactly what `examples/ledger/connection.json` ships
 * (review N9). Guard 2b REFUSES authored `fields`/`registration`/`testRequest` beside
 * the borrowed SimpleFIN brand (the first draft of this fixture proved that by being
 * refused), so the declaration carries only identity + kind + host, and admission
 * substitutes the registry's pinned seats on the borrow hit.
 */
const simplefinRequirement: ConnectionRequirement = {
  slot: 'simplefin',
  provider: { name: 'SimpleFIN' },
  kind: 'basic_auth',
  declaredApiHosts: ['beta-bridge.simplefin.org'],
};

/** A registry-unknown basic_auth provider — must keep the ordinary typed flow. */
const customBasicRequirement: ConnectionRequirement = {
  slot: 'portal',
  provider: { name: 'My Bank Portal' },
  kind: 'basic_auth',
  fields: [
    { key: 'username', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'secret' },
  ],
  declaredApiHosts: ['portal.example'],
};

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/tok-1';
const ACCESS_URL = 'https://u1:p1@beta-bridge.simplefin.org/simplefin';
const setupToken = btoa(CLAIM_URL);

/** Claim-then-verify stub; fresh Response per call (one-shot-resource lesson). */
function claimFetch(options: { claimStatus?: number; verifyStatus?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    if (url.includes('/claim/')) {
      return new Response(ACCESS_URL, { status: options.claimStatus ?? 200 });
    }
    return new Response('{"accounts":[]}', { status: options.verifyStatus ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let db: UserDb;
let container: HTMLElement;
let root: Root | undefined;

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function renderSheet(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ConnectionWizardSheet />);
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
 * Fill the claim textarea THROUGH React's change pipeline: a bare `.value =` is
 * invisible to React's value tracker (the controlled-input dedupe), which leaves the
 * claim button disabled and the whole click path untested — the native setter is the
 * documented escape hatch.
 */
async function pasteToken(value: string): Promise<void> {
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="token-claim-input"]');
  expect(input, `expected the claim paste box — rendered: ${text().slice(0, 300)}`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function declare(requirement: ConnectionRequirement, opts: { approve?: boolean } = {}): void {
  db.putDeclaredConnection(APP, requirement.slot, requirement, 'starter' as never);
  if (opts.approve === true) db.approveConnection(APP, requirement.slot);
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
  root = undefined;
  __resetConnectionWizardForTests();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The routing predicate
// ---------------------------------------------------------------------------

describe('isTokenClaimRequirement — keyed on the registry seat, never on the kind', () => {
  it('claims the SimpleFIN row', () => {
    expect(isTokenClaimRequirement(simplefinRequirement)).toBe(true);
    expect(tokenClaimPairingFor(simplefinRequirement)?.kind).toBe('token-claim');
  });

  it('does NOT claim a custom basic_auth provider — the typed screen survives', () => {
    expect(isTokenClaimRequirement(customBasicRequirement)).toBe(false);
    expect(tokenClaimPairingFor(customBasicRequirement)).toBeUndefined();
  });

  it('does NOT claim undefined, LAN, or linked-device rows', () => {
    expect(isTokenClaimRequirement(undefined)).toBe(false);
    const lanRow: ConnectionRequirement = {
      slot: 'hue',
      provider: { name: 'Philips Hue' },
      kind: 'api_key',
      fields: [{ key: 'application_key', label: 'Key', type: 'secret' }],
      lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
      declaredApiHosts: ['192.168.1.50'],
    };
    expect(isTokenClaimRequirement(lanRow)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The store transitions
// ---------------------------------------------------------------------------

describe('runTokenClaim — approve → freeze → claim → verify → write-together', () => {
  it('refuses before approval — the B1 wall at the mint', async () => {
    declare(simplefinRequirement);
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl, calls } = claimFetch();
    const result = await runTokenClaim(setupToken, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/approve/i);
    expect(calls.length, 'no network before the ceiling freezes').toBe(0);
  });

  it('claims, verifies, and writes the pair + claimVerifiedAt state TOGETHER', async () => {
    declare(simplefinRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl, calls } = claimFetch();
    const result = await runTokenClaim(setupToken, fetchImpl);
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // The pair landed in snug_secrets under the declared field keys, slot-scoped.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'username'))).toBe('u1');
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'password'))).toBe('p1');
    // The connected state carries the family's OWN verify marker.
    expect(await claimConnectionVerified(db, APP, 'simplefin')).toBe(true);
    const state = JSON.parse(db.getSecret(authConnectionStateSecretKey(APP, 'simplefin')) ?? '{}') as {
      status?: string;
      claimVerifiedAt?: number;
      lanVerifiedAt?: number;
      linkVerifiedAt?: number;
    };
    expect(state.status).toBe('connected');
    expect(typeof state.claimVerifiedAt).toBe('number');
    // The sibling families' markers stay theirs — a claim proves nothing about them.
    expect(state.lanVerifiedAt).toBeUndefined();
    expect(state.linkVerifiedAt).toBeUndefined();

    // The verify rode the just-minted pair BEFORE anything durable existed.
    expect(calls[1]?.url).toContain('/simplefin/accounts');
    // And the machine landed on done.
    expect(connectionWizardStepStore.get()).toBe('done');
  });

  it('a used token (403) stores NOTHING and names the one-use nature', async () => {
    declare(simplefinRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl } = claimFetch({ claimStatus: 403 });
    const result = await runTokenClaim(setupToken, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/once|used|expired/i);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'username'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'password'))).toBeUndefined();
    expect(await claimConnectionVerified(db, APP, 'simplefin')).toBe(false);
  });

  it('a failed verify stores NOTHING (ADR-0025 order)', async () => {
    declare(simplefinRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl } = claimFetch({ verifyStatus: 401 });
    const result = await runTokenClaim(setupToken, fetchImpl);
    expect(result.ok).toBe(false);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'password'))).toBeUndefined();
    expect(await claimConnectionVerified(db, APP, 'simplefin')).toBe(false);
  });

  it('NEVER re-claims a proven row — a setup token works exactly once (AC5)', async () => {
    declare(simplefinRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl } = claimFetch();
    expect((await runTokenClaim(setupToken, fetchImpl)).ok).toBe(true);

    // Second call: the fetch is POISONED — any request is the defect.
    const poisoned = (() => {
      throw new Error('a proven row must never claim again');
    }) as unknown as typeof fetch;
    const again = await runTokenClaim('ignored-token', poisoned);
    expect(again.ok).toBe(true);
    expect(connectionWizardStepStore.get()).toBe('done');
  });
});

describe('saveConnectionCredentials — the third family refusal, with its positive twin', () => {
  it('REFUSES hand-typed values for a token-claim row', async () => {
    declare(simplefinRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const result = await saveConnectionCredentials({ username: 'typed-u', password: 'typed-p' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/setup token/i);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'username'))).toBeUndefined();
  });

  it('the POSITIVE TWIN: a custom basic_auth row still saves typed values', async () => {
    // A refusal that is total refuses its own callers (2026-08-17): the guard must key
    // on the registry seat, not on the kind, or every basic_auth provider dies with it.
    declare(customBasicRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'portal', source: 'settings' });
    const result = await saveConnectionCredentials({ username: 'me', password: 'pw' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'portal', 'username'))).toBe('me');
  });
});

// ---------------------------------------------------------------------------
// The rendered surface
// ---------------------------------------------------------------------------

describe('the sheet routes a token-claim row to the paste screen', () => {
  it('walks review → register → CLAIM SCREEN (never the typed credentials boxes) → done', async () => {
    declare(simplefinRequirement);
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl } = claimFetch();
    vi.stubGlobal('fetch', fetchImpl);
    await renderSheet();

    expect(connectionWizardStepStore.get()).toBe('review');
    await click(/approve this connection/i);

    // The register walkthrough renders — it is where the user goes to GET the token.
    expect(connectionWizardStepStore.get()).toBe('register');
    expect(text()).toMatch(/SimpleFIN Bridge/i);
    await click(/i've got my credentials|i have my credentials/i);

    // The claim screen replaces the credentials screen: a paste box, no typed inputs.
    const claimStep = container.querySelector('[data-testid="token-claim-step"]');
    expect(claimStep, `expected the claim screen — rendered: ${text().slice(0, 300)}`).not.toBeNull();
    expect(container.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(container.querySelector('[data-testid="token-claim-precondition"]')).not.toBeNull();

    await pasteToken(setupToken);
    await click(/claim my access key/i);

    expect(connectionWizardStepStore.get()).toBe('done');
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'simplefin', 'password'))).toBe('p1');
    // C1: the minted values reach snug_secrets and never the rendered surface.
    expect(text()).not.toContain('u1');
    expect(text()).not.toContain('p1');
  });

  it('a failed claim renders the module\'s fixed sentence and keeps the paste box', async () => {
    declare(simplefinRequirement);
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl } = claimFetch({ claimStatus: 403 });
    vi.stubGlobal('fetch', fetchImpl);
    await renderSheet();

    await click(/approve this connection/i);
    await click(/i've got my credentials|i have my credentials/i);
    await pasteToken(setupToken);
    await click(/claim my access key/i);

    const error = container.querySelector('[data-testid="token-claim-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent ?? '').toMatch(/once|used|expired/i);
    // Still on the claim screen, ready for a fresh token — an honest retry.
    expect(container.querySelector('[data-testid="token-claim-input"]')).not.toBeNull();
  });

  it('REOPENING the wizard on a claimed row lands on done — never a second paste box', async () => {
    declare(simplefinRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    const { fetchImpl } = claimFetch();
    expect((await runTokenClaim(setupToken, fetchImpl)).ok).toBe(true);
    __resetConnectionWizardForTests();

    openConnectionWizard({ appId: APP, slot: 'simplefin', source: 'settings' });
    await renderSheet();
    // Past review, the loaded claimVerified fact must keep the paste box away.
    await click(/approve this connection|looks right|continue/i).catch(() => undefined);
    expect(container.querySelector('[data-testid="token-claim-input"]')).toBeNull();
  });

  it('a CUSTOM basic_auth row keeps the ordinary typed credentials screen', async () => {
    declare(customBasicRequirement);
    openConnectionWizard({ appId: APP, slot: 'portal', source: 'settings' });
    await renderSheet();

    await click(/approve this connection/i);
    // No registration seat → straight to credentials, with real typed inputs.
    expect(container.querySelector('[data-testid="token-claim-step"]')).toBeNull();
    expect(container.querySelector('input[data-field-key="username"]')).not.toBeNull();
    expect(container.querySelector('input[data-field-key="password"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registry host drift heals (owner-found, first real walk 2026-08-18)
// ---------------------------------------------------------------------------
//
// THE DEFECT: the first registry pin used `bridge.simplefin.org` — a 302 ALIAS of the
// real serving host `beta-bridge.simplefin.org` — so every REAL token refused at the
// ceiling gate. Fixing the pin fixed fresh installs; an ALREADY-APPROVED row kept its
// frozen alias ceiling, and the drift migration's gate (fields/seats/scopes) was
// HOST-BLIND: it answered 'none' forever. These tests pin the healing path.
//
// THE FIXTURE fabricates the row the way it truly arises — approved by a build whose
// registry pinned the old host. That gate ADMITTED the old shape verbatim, so the
// fixture db wires a pass-through admission gate for the legacy write; the migration
// under test runs TODAY's real admission, which is the whole point.
describe('migrateConnectionRegistryDrift — a moved registry host reaches the diff screen', () => {
  /**
   * The gate is SWITCHABLE: permissive while the legacy row is written (yesterday's
   * registry admitted that shape verbatim), then TODAY's real gate — which is what the
   * migration's staging write runs through in production, and what substitutes the
   * moved host into the pending column.
   */
  async function installLegacyHostDb(): Promise<{ db: UserDb; endLegacyWrites: () => void }> {
    resetUserDbForTests();
    let legacyMode = true;
    const opened = await openUserDb({
      backend: createMemoryBackend(),
      locateWasm,
      persistDebounceMs: 1,
      admissionGate: (requirement, context) =>
        legacyMode
          ? { ok: true, requirement, issues: [], borrowed: false }
          : admitConnectionRequirement(requirement, { channel: context.channel as never }),
    });
    if (opened.status !== 'ok') throw new Error(`legacy fixture db open failed: ${opened.status}`);
    setUserDbForTests(opened.userDb);
    return { db: opened.userDb, endLegacyWrites: () => (legacyMode = false) };
  }

  it('stages the host move, and re-approval re-freezes the ceiling to the real host', async () => {
    const { db: legacyDb, endLegacyWrites } = await installLegacyHostDb();
    legacyDb.putDeclaredConnection(
      APP,
      'simplefin',
      { ...simplefinRequirement, declaredApiHosts: ['bridge.simplefin.org'] },
      'starter' as never,
    );
    legacyDb.approveConnection(APP, 'simplefin');
    expect(legacyDb.getConnection(APP, 'simplefin')?.allowedHosts).toEqual(['bridge.simplefin.org']);
    endLegacyWrites(); // today's build takes over — every later write meets the real gate

    const outcome = await migrateConnectionRegistryDrift(APP, 'simplefin');
    // NEVER a silent promotion — the ceiling is moving, so the user decides on the
    // diff screen the staged column renders.
    expect(outcome).toBe('staged');
    const staged = legacyDb.getConnection(APP, 'simplefin');
    expect(staged?.pendingRequirement?.declaredApiHosts).toEqual(['beta-bridge.simplefin.org']);

    legacyDb.reapproveConnection(APP, 'simplefin');
    expect(legacyDb.getConnection(APP, 'simplefin')?.allowedHosts).toEqual(['beta-bridge.simplefin.org']);
  });

  it('a row already on the real host answers none — no perpetual re-staging loop', async () => {
    declare(simplefinRequirement, { approve: true });
    expect(await migrateConnectionRegistryDrift(APP, 'simplefin')).toBe('none');
  });
});
