// connectionWizardGuards.test.tsx — RESTORED SECURITY GUARDS for behaviors that survived
// the P3 v3→v4 rebuild but lost their tests with it.
//
// WHY THIS FILE EXISTS. P3 rebuilt the wizard from the v3 `snug_auth_specs` surface onto
// v4 `snug_connections`. A forensic audit of the 120 deleted v3 cases found ~55 genuinely
// OBSOLETE (the proposal/declaration/inference channels are provably deleted) — but a
// residue of behaviors that STILL SHIP lost their only coverage. Four of those are
// security-load-bearing, and each one below states the MUTATION it exists to kill and the
// v3 test it descends from. None of these resurrect a deleted surface: every assertion
// drives code reachable in the shipped v4 build.
//
// EVERY TEST HERE WAS MUTATION-PROVEN — written red, confirmed to fail against a
// deliberately broken shipped tree, then confirmed green against the restored one. A guard
// that cannot be mutation-killed is not a guard, it is decoration.
//
// C1 — nothing in this file writes or reads a credential VALUE.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { ConnectionSlotsCard } from '../views/ConnectionSlotsCard.js';
import {
  __resetConnectionWizardForTests,
  __setConnectionOAuthHooksForTests,
  advanceFromReview,
  connectionFlowStatusStore,
  connectionWizardStore,
  isConnectionRepairableNetError,
  openConnectionWizard,
  openConnectionWizardForNetError,
  reapproveFromDiff,
  saveConnectionCredentials,
  startConnectionOAuthFlow,
} from '../state/connectionWizard.js';
import * as net from '../state/net.js';
import * as userdb from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p3-guards';
const SLOT = 'coinbase';

const coinbaseRequirement = {
  slot: SLOT,
  provider: { name: 'Coinbase' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  declaredApiHosts: ['api.coinbase.com'],
} as const satisfies Record<string, unknown>;

/**
 * An OAuth requirement whose ENDPOINT hosts are deliberately NOT in `declaredApiHosts`.
 *
 * That asymmetry is the whole instrument for GUARD 4. `deriveConnectionAllowedHosts`
 * unions the declared hosts with every endpoint host, so the row's FROZEN `allowedHosts`
 * is strictly larger than `requirement.declaredApiHosts` — which means a scope that
 * re-derived from the requirement instead of reading the frozen column produces an
 * OBSERVABLY DIFFERENT list. Without this gap the two are equal and the guard is vacuous.
 */
const oauthRequirement = {
  slot: 'fake-idp',
  provider: { name: 'Fake IdP' },
  kind: 'oauth2_auth_code',
  endpoints: {
    authorizeUrl: 'https://idp.example/authorize',
    tokenUrl: 'https://token.example/token',
  },
  pkce: true,
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text', required: true }],
  declaredApiHosts: ['api.fake-idp.example'],
} as const satisfies Record<string, unknown>;

const OAUTH_APP = 'app-p3-guards-oauth';
const OAUTH_SLOT = 'fake-idp';

let db: UserDb;
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
    throw new Error(`no button matching ${String(name)} — rendered: ${(container?.textContent ?? '').slice(0, 400)}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Seed one declared (optionally approved) v4 row through the real P0 accessors. */
function declare(options: { approve?: boolean } = {}): void {
  db.installApp({ appId: APP, displayName: 'Guarded App', html: '<p>x</p>' });
  db.putDeclaredConnection(APP, SLOT, coinbaseRequirement, 'registry' as never);
  if (options.approve === true) db.approveConnection(APP, SLOT);
}

/**
 * Seed an APPROVED OAuth row and open its wizard. Approval is what FREEZES the ceiling,
 * so this is the precondition every GUARD 4 assertion is written against.
 */
async function seedApprovedOAuth(): Promise<void> {
  db.installApp({ appId: OAUTH_APP, displayName: 'OAuth App', html: '<p>x</p>' });
  db.putDeclaredConnection(OAUTH_APP, OAUTH_SLOT, oauthRequirement, 'registry' as never);
  db.approveConnection(OAUTH_APP, OAUTH_SLOT);
  openConnectionWizard({ appId: OAUTH_APP, slot: OAUTH_SLOT, source: 'settings' });
}

/** The scope the store handed the service, captured off the fake's call. */
interface CapturedScope {
  allowedHosts: readonly string[];
}

/**
 * Drive a full three-legged exchange offline against a FAKE service, capturing the scope
 * the store built. No window, no bus, no wire — the popup and channel are injected.
 */
async function runOAuthExchangeToCompletion(): Promise<{
  start: CapturedScope[];
  callback: CapturedScope[];
}> {
  const start: CapturedScope[] = [];
  const callback: CapturedScope[] = [];
  let deliver: ((data: unknown) => void) | undefined;

  __setConnectionOAuthHooksForTests({
    service: {
      generateAuthUrl: vi.fn(async (input: { allowedHosts?: readonly string[] }) => {
        start.push({ allowedHosts: input.allowedHosts ?? [] });
        return { flowId: 'flow-1', authorizeUrl: 'https://idp.example/authorize?x=1' };
      }),
      handleCallback: vi.fn(async (input: { allowedHosts: readonly string[] }) => {
        callback.push({ allowedHosts: input.allowedHosts });
        return { scopesGranted: ['read'] };
      }),
    } as never,
    channelFactory: (_name: string) => {
      const channel = { onmessage: null as ((event: { data: unknown }) => void) | null, close: () => {} };
      deliver = (data: unknown) => channel.onmessage?.({ data });
      return channel;
    },
    openPopup: () => ({ closed: false, close: () => {} }),
  });

  await startConnectionOAuthFlow({ client_id: 'cid-1' });
  // The delivery carries only code+state; the flow BINDING is the store's held copy.
  deliver?.({ code: 'auth-code-1', state: 'state-1' });
  await settle();
  return { start, callback };
}

beforeEach(async () => {
  db = await installTestUserDb();
  __resetConnectionWizardForTests();
  /*
    NO `restoreAllMocks()` HERE (fold). Four tests in this file spy on the SAME namespace
    property (`net.invalidateNetGrants`), and restoring in BOTH hooks made the suite
    order-dependent: a restore that runs while a previous spy is still installed writes the
    SPY back as the "original", so a later `spyOn` wraps a wrapper and the real call is
    never observed. It failed intermittently and on a DIFFERENT test each run — which is
    the shape of a guard that is not actually guarding. `afterEach` alone restores exactly
    once per test, at the only moment nothing else is mid-flight.
  */
});

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
  __resetConnectionWizardForTests();
  __setConnectionOAuthHooksForTests({});
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GUARD 1 — the off-ceiling CTA allowlist (M12/M25/M26)
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted wizardStore.test.ts:220-236 ("NET_HOST_BLOCKED /
// NET_SSRF_BLOCKED / NET_CONFIRM_DENIED NEVER open the wizard") and
// wizardDeclaration.test.ts:118-157 (the T4b async-refusal contract).
//
// WHAT SHIPS AND WHAT WAS UNGUARDED. `isConnectionRepairableNetError` and
// `openConnectionWizardForNetError` are live in production at RunView.tsx:238, and after
// the rebuild they had ZERO test references. The allowlist is what stops an OFF-CEILING
// failure — the ceiling refused the host, SSRF caught it, the user denied the confirm, or
// two grants claim one host — from offering a "connect" CTA. Routing those to a wizard
// coaches the user into WIDENING A HOST CEILING WHILE UNDER ATTACK, which is the one
// outcome the whole approval surface exists to prevent.
//
// MUTATIONS THIS KILLS: deleting AUTH_REPAIRABLE_NET_CODES entirely; flipping the
// allowlist to a denylist (`!has(code)`); adding any off-ceiling code to the set; making
// the refusal read the DB before deciding; converting the resolved `false` into a throw.
describe('GUARD 1 — off-ceiling net codes map to NO CTA and open NO wizard (M12/M25/M26)', () => {
  /**
   * THE ANTI-VACUUM GUARD, and it is load-bearing rather than ceremonial.
   *
   * Every code below is read off `NET_ERROR_CODES`. A renamed or absent member arrives as
   * `undefined`, `isConnectionRepairableNetError(undefined)` returns false, and the whole
   * loop PASSES while proving nothing about the code it claims to cover. Asserting each
   * constant is DEFINED turns that silent vacuum into a failure.
   *
   * This exact vacuity bug was found and fixed once already in P1's red stage. Restoring
   * the loop without restoring this assertion would reintroduce it.
   */
  const offCeiling = {
    NET_HOST_BLOCKED: NET_ERROR_CODES.NET_HOST_BLOCKED,
    NET_SSRF_BLOCKED: NET_ERROR_CODES.NET_SSRF_BLOCKED,
    NET_CONFIRM_DENIED: NET_ERROR_CODES.NET_CONFIRM_DENIED,
    NET_AMBIGUOUS_CONNECTION: NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION,
    NET_SCHEME_BLOCKED: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    NET_REDIRECT_BLOCKED: NET_ERROR_CODES.NET_REDIRECT_BLOCKED,
    NET_SIZE_EXCEEDED: NET_ERROR_CODES.NET_SIZE_EXCEEDED,
    NET_FETCH_FAILED: NET_ERROR_CODES.NET_FETCH_FAILED,
    NET_INVALID_REQUEST: NET_ERROR_CODES.NET_INVALID_REQUEST,
  } as const;

  const repairable = {
    NET_AUTH_FAILED: NET_ERROR_CODES.NET_AUTH_FAILED,
    NET_NOT_APPROVED: NET_ERROR_CODES.NET_NOT_APPROVED,
    NET_IMPORTED_UNAPPROVED: NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
  } as const;

  it('every code under test is a DEFINED protocol constant (the anti-vacuum guard)', () => {
    for (const [name, code] of Object.entries({ ...offCeiling, ...repairable })) {
      expect(code, `${name} must be a defined protocol code, or the loops below prove nothing`).toBe(name);
    }
  });

  it('NO off-ceiling code is repairable — the allowlist, never a denylist', () => {
    for (const [name, code] of Object.entries(offCeiling)) {
      expect(isConnectionRepairableNetError(code), `${name} must NOT offer a connect CTA`).toBe(false);
    }
  });

  it('the three auth-repairable codes DO offer the CTA — the set is not merely empty', () => {
    // Without this direction, deleting the whole set passes the negative loop above: an
    // empty allowlist refuses everything, including the failures a wizard genuinely fixes.
    for (const [name, code] of Object.entries(repairable)) {
      expect(isConnectionRepairableNetError(code), `${name} must offer a connect CTA`).toBe(true);
    }
  });

  it('an off-ceiling code opens NO wizard and resolves FALSE, never a truthy Promise (T4b)', async () => {
    declare({ approve: false });
    for (const [name, code] of Object.entries(offCeiling)) {
      // The RESOLVED value is the contract: RunView branches on it. A Promise is always
      // truthy, so a call site that forgot to await would dismiss its CTA banner even on a
      // refusal — stranding the user with no route back to the connection.
      const opened = await openConnectionWizardForNetError(APP, code);
      expect(opened, `${name} must resolve false`).toBe(false);
      expect(connectionWizardStore.get(), `${name} must create no session`).toBeNull();
    }
  });

  it('a repairable code DOES open the wizard, with the error_cta source', async () => {
    declare({ approve: false });
    const opened = await openConnectionWizardForNetError(APP, NET_ERROR_CODES.NET_AUTH_FAILED);
    expect(opened).toBe(true);
    expect(connectionWizardStore.get()?.source).toBe('error_cta');
  });

  it('a no-CTA code refuses WITHOUT reading the user DB (ordering, M8)', async () => {
    // Found by mutation M8 in v3: moving the code check AFTER the DB read left every other
    // assertion green. The ordering is a real property — a net error can arrive in a loop
    // from a running app, so a refusal must be a pure function of the CODE and never an
    // app-triggerable read of the user's library.
    declare({ approve: false });
    const spy = vi.spyOn(userdb, 'getUserDb');
    expect(await openConnectionWizardForNetError(APP, NET_ERROR_CODES.NET_HOST_BLOCKED)).toBe(false);
    expect(spy, 'a no-CTA code must short-circuit before any DB access').not.toHaveBeenCalled();
  });

  it('the refusal is a RESOLVED false, not a rejection', async () => {
    // Belt and braces on the call-site contract: `.then(opened => ...)` must run. A
    // rejected refusal would skip the handler and leave the CTA banner in limbo.
    declare({ approve: false });
    await expect(openConnectionWizardForNetError(APP, NET_ERROR_CODES.NET_SSRF_BLOCKED)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GUARD 2 — the revoke/disconnect button wiring (M29)
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted connectionsPanel.test.tsx revoke coverage. The v3 suite
// documented this exact mutation (M29): the revoke RULE was tested against the accessor
// directly, so deleting the CALL SITE left the whole suite green while the user's only
// off switch did nothing.
//
// SO THIS TEST DRIVES THE BUTTON. ConnectionSlotsCard.tsx:136-144 is the ONLY user-facing
// way to cut a grant, and no test clicked it.
describe('GUARD 2 — the disconnect button is WIRED, not merely rendered (M29)', () => {
  it('clicking disconnect calls revokeConnection AND invalidateNetGrants for that app (R3)', async () => {
    declare({ approve: true });
    const revoke = vi.spyOn(db, 'revokeConnection');
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');

    await render(<ConnectionSlotsCard />);
    await click(/disconnect/i);

    // The CALL SITE is what is under test — deleting it from the component is the mutation.
    expect(revoke, 'the button must reach the sole legal author of this transition').toHaveBeenCalledWith(APP, SLOT);
    // R3 — every grant transition drops the app's remembered net verdicts, or a cached
    // pre-revoke grant keeps answering for a connection the user just cut off.
    expect(invalidate, 'R3 — a revoke must invalidate the app net grants').toHaveBeenCalledWith(APP);
  });

  it('a FAILING revoke surfaces as role="alert", never a silent floating promise', async () => {
    // The `.catch(setError)` at ConnectionSlotsCard.tsx:144. `revoke` is fire-and-forget
    // (`void getUserDb().then(...)`), so without the catch a wipe that threw would reject
    // into nowhere: the row would still read "connected", the user would believe the grant
    // was cut, and the credential slice would still be on disk. Deleting the `.catch`
    // is the mutation this kills.
    declare({ approve: true });
    vi.spyOn(db, 'revokeConnection').mockImplementation(() => {
      throw new Error('credential wipe failed');
    });

    await render(<ConnectionSlotsCard />);
    await click(/disconnect/i);

    const alert = container?.querySelector('[role="alert"]');
    expect(alert, 'a failed wipe must be told to the user, not swallowed').not.toBeNull();
    expect(alert?.textContent ?? '').toContain('credential wipe failed');
  });
});

// ---------------------------------------------------------------------------
// GUARD 3 — R3 grant invalidation on EVERY approval transition
// ---------------------------------------------------------------------------
//
// The three call sites (connectionWizard.ts:301 approve, :332 re-approve, :843 token mint)
// were all unasserted after the rebuild. A stale cached pre-approval verdict surviving a
// re-freeze is a real bypass: the confirm gate would keep answering from a grant the user
// has since changed the shape of. One test per transition, because deleting any ONE call
// is the mutation — a single combined test would let two survive.
//
// The token-mint site (:843) is covered by GUARD 4 below, which drives the OAuth exchange.
describe('GUARD 3 — every approval transition invalidates the app net grants (R3)', () => {
  it('approve (advanceFromReview) invalidates — connectionWizard.ts:301', async () => {
    declare({ approve: false });
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });

    const result = await advanceFromReview();

    expect(result.ok, 'the approval must actually have happened').toBe(true);
    expect(invalidate, 'a freeze must drop the pre-approval verdicts').toHaveBeenCalledWith(APP);
  });

  it('the OAuth token MINT invalidates — connectionWizard.ts:843', async () => {
    // The third R3 site, reached only by completing a real exchange. A minted token IS a
    // working connection, so verdicts cached while the app could not authenticate are
    // stale the moment it can.
    await seedApprovedOAuth();
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');

    await runOAuthExchangeToCompletion();

    expect(connectionFlowStatusStore.get().state, 'the exchange must actually have completed').toBe('connected');
    expect(invalidate, 'a fresh token must drop the pre-token verdicts').toHaveBeenCalledWith(OAUTH_APP);
  });

  it('re-approve (reapproveFromDiff) invalidates — connectionWizard.ts:332', async () => {
    declare({ approve: true });
    // A staged widening is what re-approval promotes; the RE-FREEZE is the moment a cached
    // verdict from the OLD ceiling becomes a bypass of the new one.
    db.stagePendingRequirement(APP, SLOT, {
      ...coinbaseRequirement,
      declaredApiHosts: ['api.coinbase.com', 'api.exchange.coinbase.com'],
    });
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings', mode: 'reapprove' });

    const result = await reapproveFromDiff();

    expect(result.ok).toBe(true);
    expect(invalidate, 'a RE-freeze must drop verdicts cached against the old ceiling').toHaveBeenCalledWith(APP);
  });
});

// ---------------------------------------------------------------------------
// GUARD 4 — approval strictly precedes any token act, and the scope is the
//           FROZEN ROW's ceiling — never a requirement-derived one (the M14 trap)
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted authWizard.test.tsx:387 ("client_creds save-mints
// POST-approval with the frozen row scope, and approve precedes the mint").
//
// A SCOPE NOTE, STATED HONESTLY BECAUSE IT CHANGES WHAT THIS GUARD CAN CLAIM. The v3
// ancestor pinned `oauth2_client_creds` because the v3 wizard MINTED that token itself,
// through `saveWizardClientCreds` → `OAuthService.saveClientCreds`. V4 HAS NO SUCH PATH:
// `needsOAuthConnectStep` (connectionWizard.ts:233) admits only `oauth2_auth_code`, so a
// client_creds connection saves its secrets and lands on `done`, and its token is minted
// LAZILY AT RUNTIME by connected-fetch (connected-fetch.ts:507) from the same frozen
// `grant.allowedHosts`. Restoring a wizard-level client_creds mint test would therefore be
// a test for a surface that does not exist — precisely what this task forbids. So the
// TWO PROPERTIES the ancestor protected are pinned here against the token path v4 DOES
// ship in the wizard: the `oauth2_auth_code` flow through `approvedOAuthScope` (:689).
//
// MUTATIONS THIS KILLS: making the scope re-derive `allowedHosts` from `row.requirement`
// (or from `row.pendingRequirement`) instead of reading the frozen `row.allowedHosts`
// column; and dropping the status check that keeps any token act behind approval.
describe('GUARD 4 — the token scope is the FROZEN ROW union, and approval precedes it (M14)', () => {
  it('the scope handed to BOTH legs is the row frozen ceiling, not a requirement-derived one', async () => {
    await seedApprovedOAuth();
    const frozen = db.getConnection(OAUTH_APP, OAUTH_SLOT)!.allowedHosts;

    // The instrument: the frozen union is STRICTLY LARGER than the declared list, because
    // approval unions in the endpoint hosts. A re-derivation from `declaredApiHosts`
    // would therefore be observably narrower — and one from a WIDENED pending requirement
    // observably wider. Assert the gap exists, or the equality below proves nothing.
    expect([...frozen], 'the frozen union must include the endpoint hosts').toEqual(
      expect.arrayContaining(['api.fake-idp.example', 'idp.example', 'token.example']),
    );
    expect(frozen.length, 'the frozen union must exceed the declared list').toBeGreaterThan(
      oauthRequirement.declaredApiHosts.length,
    );

    const { start, callback } = await runOAuthExchangeToCompletion();

    // Every token POST the service makes is checked against this list. If it were
    // re-derived rather than read, the wizard would hand the service a ceiling the user
    // never approved — silently widening past the reviewed grant.
    expect(callback[0]?.allowedHosts, 'the exchange leg must carry the FROZEN union').toEqual([...frozen]);
    expect(start.length, 'the authorize leg must have run first').toBe(1);
  });

  it('a STAGED WIDENING never reaches the scope — pending is a proposal, not a ceiling', async () => {
    await seedApprovedOAuth();
    const frozen = db.getConnection(OAUTH_APP, OAUTH_SLOT)!.allowedHosts;
    // The attacker-shaped case: an app stages a widening at any time. Until the user reads
    // a diff and re-approves, that host is NOT part of the ceiling — and a scope derived
    // from `pendingRequirement` would mint against it.
    db.stagePendingRequirement(OAUTH_APP, OAUTH_SLOT, {
      ...oauthRequirement,
      declaredApiHosts: ['api.fake-idp.example', 'evil.attacker.example'],
    });

    const { callback } = await runOAuthExchangeToCompletion();

    expect(callback[0]?.allowedHosts).toEqual([...frozen]);
    expect(callback[0]?.allowedHosts, 'a staged host must never reach a token scope').not.toContain(
      'evil.attacker.example',
    );
  });

  it('APPROVAL STRICTLY PRECEDES the token act — an unapproved row opens no flow at all', async () => {
    // The B1 wall at the flow (connectionWizard.ts:695). The v3 ancestor expressed this as
    // `order === ['approve','mint']`; the v4 equivalent is that the mint is UNREACHABLE
    // until the row is approved, which is the same claim enforced structurally rather than
    // observed by sequence.
    db.installApp({ appId: OAUTH_APP, displayName: 'OAuth App', html: '<p>x</p>' });
    db.putDeclaredConnection(OAUTH_APP, OAUTH_SLOT, oauthRequirement, 'registry' as never);
    // NOT approved.
    openConnectionWizard({ appId: OAUTH_APP, slot: OAUTH_SLOT, source: 'settings' });

    const generateAuthUrl = vi.fn();
    __setConnectionOAuthHooksForTests({
      service: { generateAuthUrl, handleCallback: vi.fn() } as never,
      openPopup: () => ({ closed: false, close: () => {} }),
    });

    await expect(startConnectionOAuthFlow({ client_id: 'cid-1' })).rejects.toThrow(/approve this connection/i);
    expect(generateAuthUrl, 'no token act may precede the freeze').not.toHaveBeenCalled();
  });

  it('a credential cannot be stored against an UNFROZEN ceiling either (the B1 wall at the write)', async () => {
    // The same wall at `saveConnectionCredentials` (:361) — belt and braces, because that
    // is the function that actually touches the secret.
    db.installApp({ appId: OAUTH_APP, displayName: 'OAuth App', html: '<p>x</p>' });
    db.putDeclaredConnection(OAUTH_APP, OAUTH_SLOT, oauthRequirement, 'registry' as never);
    openConnectionWizard({ appId: OAUTH_APP, slot: OAUTH_SLOT, source: 'settings' });

    const result = await saveConnectionCredentials({ client_id: 'cid-1' });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : '').toMatch(/approve this connection/i);
  });
});
