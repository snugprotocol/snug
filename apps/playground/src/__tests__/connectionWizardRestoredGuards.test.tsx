// connectionWizardRestoredGuards.test.tsx — the NON-SECURITY-CRITICAL half of the P3
// restoration (items 5-11 + 13 of the migration audit). Its sibling
// `connectionWizardGuards.test.tsx` holds the four security-load-bearing losses; this file
// holds the rest, and the split is by OWNERSHIP rather than by importance — two agents
// restoring in parallel must not edit one file.
//
// WHY THIS FILE EXISTS. P3 rebuilt the wizard from the v3 `snug_auth_specs` surface onto
// v4 `snug_connections`: 120 v3 cases were deleted against 74 new ones. A forensic audit
// classified all 120 — ~55 are genuinely OBSOLETE (the proposal/declaration/inference
// channels are provably deleted) and the OAuth port is faithful — but a residue of
// behaviors that STILL SHIP in v4 lost their only coverage. Every test below drives code
// reachable in the shipped build; none resurrects a deleted surface (no
// `resolveWizardIntent`, no `session.declaration`, no run-time inference seam, no
// `imported_unapproved`, no v3 accessors — those are correctly gone).
//
// EVERY GUARD HERE WAS MUTATION-PROVEN: written, then the SHIPPED line it guards was
// deliberately broken and the test confirmed RED, then the code was restored and the test
// confirmed GREEN. Each describe states the mutation it kills and the v3 test it descends
// from. A guard that cannot be mutation-killed is decoration, not a guard.
//
// C1 — the two credential-echo tests below are the only ones that put a VALUE anywhere,
// and they exist precisely to prove the value never comes back out.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authConnectionCredentialSecretKey, type UserDb } from '@snugprotocol/db';

import { ConnectionSlotsCard } from '../views/ConnectionSlotsCard.js';
import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import {
  __resetConnectionWizardForTests,
  __setConnectionOAuthHooksForTests,
  closeConnectionWizard,
  forceCloseWizard,
  connectionFlowStatusStore,
  connectionWizardNoteStore,
  connectionWizardStepStore,
  connectionWizardStore,
  openConnectionWizard,
  startConnectionOAuthFlow,
  type ConnectionPopupLike,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p3-restored';
const OTHER_APP = 'app-p3-restored-2';

const coinbaseRequirement = {
  slot: 'coinbase',
  provider: { name: 'Coinbase' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API key', type: 'secret', required: true },
    { key: 'api_secret', label: 'API secret', type: 'secret', required: true },
  ],
  declaredApiHosts: ['api.coinbase.com', 'api.exchange.coinbase.com'],
} as const satisfies Record<string, unknown>;

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

const text = (): string => container?.textContent ?? '';

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as
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

async function type(fieldKey: string, value: string): Promise<void> {
  const input = container?.querySelector<HTMLInputElement>(`input[data-field-key="${fieldKey}"]`);
  if (input === null || input === undefined) throw new Error(`no input for declared field ${fieldKey}`);
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** Seed one v4 row through the real P0 accessors. */
function declare(
  requirement: Record<string, unknown>,
  options: { approve?: boolean; appId?: string } = {},
): void {
  const appId = options.appId ?? APP;
  db.putDeclaredConnection(appId, requirement['slot'] as string, requirement, 'registry' as never);
  if (options.approve === true) db.approveConnection(appId, requirement['slot'] as string);
}

beforeEach(async () => {
  db = await installTestUserDb();
  __resetConnectionWizardForTests();
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
// RESTORED 5 — credential NON-ECHO at the DOM, asserted as a UNIT test
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted authWizard.test.tsx:420-450 (AC10, "write-only secret fields
// — the M9 value-echo mutation"): both halves, the pre-seeded store that must not load
// back and the saved value that must not linger.
//
// WHAT SHIPS AND WHY IT WAS UNGUARDED. ConnectionWizardSheet.tsx:409 seeds the credential
// draft with a bare `useState<Record<string, string>>({})` — it NEVER reads
// `snug_secrets` — and :437 clears that state the instant the save resolves. Both are one
// line each and both are trivially "improved" away by a well-meaning UX change ("show the
// user their existing key so they can tell whether it needs re-pasting"). After the
// rebuild the ONLY non-echo assertion left in the repo was an e2e page-content probe in
// connection-wizard.spec.ts, and that probe is `test.skip`'d unless SNUG_E2E_HAS_APP === '1'
// — so it does not run in the normal suite and the property was, in practice, unguarded.
//
// MUTATIONS THIS KILLS: seeding `values` from the credential store at mount; dropping the
// `setValues({})` clear after save; rendering any stored value into a review, a hint, a
// placeholder or a `defaultValue`.
describe('RESTORED 5 — a credential VALUE is never echoed back into the field or the DOM (C1)', () => {
  it('a PRE-EXISTING stored secret is never loaded back into its input', async () => {
    declare(coinbaseRequirement, { approve: true });
    // The seed goes in through the SAME key builder the wizard writes with, so a component
    // that "helpfully" read the store back would find exactly this value.
    db.setSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_key'), 'stored-secret-987');

    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);
    expect(connectionWizardStepStore.get()).toBe('credentials');

    const input = container!.querySelector<HTMLInputElement>('input[data-field-key="api_key"]')!;
    expect(input.value, 'the field must open EMPTY — a stored secret is write-only').toBe('');
    // The DOM-wide half: not in a value, not in a placeholder, not in a hint, not in an
    // attribute. `innerHTML` is the assertion because the leak does not have to be a value.
    expect(container!.innerHTML).not.toContain('stored-secret-987');
  });

  it('a value the user just SAVED never appears in innerHTML afterwards', async () => {
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);

    await type('api_key', 'sekrit-value-123');
    await type('api_secret', 'sekrit-secret-456');
    await click(/save my credentials/i);

    // The positive control: the write really happened, so the negative below is about
    // ECHO rather than about nothing having been collected.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_key'))).toBe('sekrit-value-123');
    expect(connectionWizardStepStore.get()).toBe('done');
    expect(container!.innerHTML).not.toContain('sekrit-value-123');
    expect(container!.innerHTML).not.toContain('sekrit-secret-456');
  });

  it('a FAILED save still clears the draft — the value does not linger on the screen it failed on', async () => {
    /**
     * THE `setValues({})` AT :437 SPECIFICALLY, and the failure path is the ONLY place it
     * is observable — which is exactly why it is easy to delete by accident.
     *
     * On the SUCCESS path the machine advances to `done`, `CredentialsScreen` unmounts, and
     * its state dies with it whether or not the clear ran; a test written against that path
     * passes against a tree with the clear removed (verified by mutation — it survived).
     * On the FAILURE path the screen STAYS MOUNTED, because the clear runs BEFORE the
     * `!result.ok` branch. So this drives a refused save and asserts the typed secret is
     * gone from the still-visible field.
     *
     * The behavior matters on its own terms: a failed save is the case where the user is
     * most likely to walk away from the screen, and the secret is most likely to still be
     * on it. Revoking the row mid-flow is how a real user reaches this — a disconnect from
     * Settings in another tab, or a sync pull demoting the row underneath them.
     */
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);
    await type('api_key', 'sekrit-value-123');
    await type('api_secret', 'sekrit-secret-456');

    // Pull the row out from under the save: `saveConnectionCredentials` refuses to write
    // against anything but an approved row (the B1 wall at the write), so this returns
    // `{ ok: false }` and the component stays on the credentials screen.
    db.revokeConnection(APP, 'coinbase');
    await click(/save my credentials/i);

    // The refusal really happened — otherwise the clear below proves nothing.
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();
    expect(connectionWizardStepStore.get(), 'a refused save must not advance').toBe('credentials');

    const input = container!.querySelector<HTMLInputElement>('input[data-field-key="api_key"]')!;
    expect(input.value, 'the draft must not survive its own save, even a failed one').toBe('');
    expect(container!.innerHTML).not.toContain('sekrit-value-123');
    expect(container!.innerHTML).not.toContain('sekrit-secret-456');
  });
});

// ---------------------------------------------------------------------------
// RESTORED 6 — the popup-blocker escape: a PRE-OPENED window is NAVIGATED
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted oauthPopupFlow.test.tsx:303-356 ("popup-blocker escape (D6):
// a pre-opened gesture popup is NAVIGATED, never re-opened", plus its bail half).
//
// WHAT SHIPS AND WHY IT WAS UNGUARDED. connectionWizard.ts:762-769 keeps the escape and
// keeps the comment explaining it — but the port brought no test. The property is a pure
// ORDERING claim and therefore invisible to every other assertion in the suite: reverting
// to a post-await `window.open(authorizeUrl)` leaves the flow status, the channel, the
// exchange and the token all identical, and breaks OAuth for every user running a default
// popup blocker. A screen that reaches `awaiting_callback` with no window on it is the
// cruelest possible ending, and nothing in the v4 suite could see it.
//
// MUTATIONS THIS KILLS: replacing `preOpened.navigate(start.authorizeUrl)` with
// `openPopup(start.authorizeUrl)` (the pre-fix behavior); dropping the `preOpened?.close?.()`
// on the B1 bail so a blank window is orphaned over a refused flow.
describe('RESTORED 6 — the pre-opened popup is NAVIGATED, and CLOSED when the gate refuses', () => {
  /** The shape `openBlankConnectionOAuthPopup` returns: open already, navigable, closable. */
  function fakePreOpened(): ConnectionPopupLike & { navigated: string[]; closeCalls: number } {
    const popup = {
      closed: false,
      navigated: [] as string[],
      closeCalls: 0,
      navigate(url: string) {
        popup.navigated.push(url);
      },
      close() {
        popup.closeCalls += 1;
      },
    };
    return popup;
  }

  it('the gesture-opened window is navigated to the authorize URL — window.open is NEVER called with it', async () => {
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'fake-idp', source: 'settings' });

    // THE INSTRUMENT. `openPopup` is the seam `defaultOpenPopup` (window.open) sits behind.
    // If the code ever opens a window with the URL after its awaits, this spy trips — and
    // that is exactly the call a default blocker refuses, because the user's gesture is
    // long gone by then.
    const openPopup = vi.fn(() => ({ closed: false, close: () => {} }));
    __setConnectionOAuthHooksForTests({
      service: {
        generateAuthUrl: vi.fn(async () => ({ flowId: 'flow-1', authorizeUrl: 'https://idp.example/authorize?x=1' })),
        handleCallback: vi.fn(async () => ({ scopesGranted: [] })),
      } as never,
      channelFactory: () => ({ onmessage: null, close: () => {} }),
      openPopup,
    });

    const popup = fakePreOpened();
    await startConnectionOAuthFlow({ client_id: 'cid-1' }, popup);

    expect(popup.navigated, 'the pre-opened window must be the one that travels').toHaveLength(1);
    expect(new URL(popup.navigated[0]!).origin).toBe('https://idp.example');
    expect(openPopup, 'a post-await window.open is what the blocker kills').not.toHaveBeenCalled();
    expect(connectionFlowStatusStore.get().state).toBe('awaiting_callback');
    expect(popup.closeCalls, 'a navigated window is the live sign-in — never close it').toBe(0);
  });

  it('the B1 gate refuses an UNAPPROVED row: the blank window is CLOSED, never orphaned', async () => {
    // connectionWizard.ts:715 (`preOpened?.close?.()` on the throw path). The existing
    // suite asserts the REFUSAL — `startConnectionOAuthFlow` rejects — but nothing asserted
    // the CLOSE, so deleting it left a blank `about:blank` window sitting on the user's
    // screen over a wizard that just told them to approve first. Two separate claims;
    // only one of them had a test.
    declare(oauthRequirement); // declared, NOT approved
    openConnectionWizard({ appId: APP, slot: 'fake-idp', source: 'settings' });

    const generateAuthUrl = vi.fn();
    __setConnectionOAuthHooksForTests({
      service: { generateAuthUrl, handleCallback: vi.fn() } as never,
      channelFactory: () => ({ onmessage: null, close: () => {} }),
      openPopup: () => ({ closed: false, close: () => {} }),
    });

    const popup = fakePreOpened();
    await expect(startConnectionOAuthFlow({ client_id: 'cid-1' }, popup)).rejects.toThrow(/approve this connection/i);

    expect(popup.navigated, 'a refused flow must never navigate the window').toHaveLength(0);
    expect(popup.closeCalls, 'a bail must close the blank window it was handed').toBeGreaterThan(0);
    expect(generateAuthUrl, 'B1 — no mint may precede the freeze').not.toHaveBeenCalled();
  });

  it('a MINT failure also closes the blank window', async () => {
    // The other bail arm at :750. Same orphan, different cause: the row is approved, so the
    // B1 gate passes and the mint itself throws.
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'fake-idp', source: 'settings' });
    __setConnectionOAuthHooksForTests({
      service: {
        generateAuthUrl: vi.fn(async () => {
          throw new Error('the provider refused the authorize request');
        }),
        handleCallback: vi.fn(),
      } as never,
      channelFactory: () => ({ onmessage: null, close: () => {} }),
      openPopup: () => ({ closed: false, close: () => {} }),
    });

    const popup = fakePreOpened();
    await expect(startConnectionOAuthFlow({ client_id: 'cid-1' }, popup)).rejects.toThrow(/refused the authorize/i);
    expect(popup.closeCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RESTORED 7 — the SINGLETON wizard refusal (R2)
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted wizardStore.test.ts:63-82 ("R2 — singleton wizard, mutation
// M28"): a second open is refused with a visible note and the first session survives.
//
// WHAT SHIPS AND WHY IT MATTERS. connectionWizard.ts:126-129 is the whole rule, and after
// the rebuild it had ZERO tests. Two wizards open at once means two approvals racing for
// ONE frozen ceiling: whichever `approveConnection` lands last decides the grant, while
// the user believes they read and approved the screen still in front of them. Three
// shipped entry points can each call `openConnectionWizard` (Settings row, run-view error
// CTA, chat directive card), so a second open is not hypothetical — it is one stray click
// on a card while a sheet is already parked.
//
// MUTATIONS THIS KILLS: deleting the `!== null` early return; keeping the return but
// letting the store be overwritten first; returning `true` on the refusal (which would
// make a caller dismiss its CTA banner believing a wizard opened); dropping the note so
// the refusal is silent and the user's click appears to have done nothing.
describe('RESTORED 7 — a second open is REFUSED and the first session survives (R2/M28)', () => {
  it('refuses the second open, keeps the FIRST session object, and says so', () => {
    declare(coinbaseRequirement);
    declare(oauthRequirement, { appId: OTHER_APP });

    expect(openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' })).toBe(true);
    const first = connectionWizardStore.get();
    expect(first?.appId).toBe(APP);

    const second = openConnectionWizard({ appId: OTHER_APP, slot: 'fake-idp', source: 'directive' });

    expect(second, 'the refusal is a FALSE, so a CTA call site can branch on it').toBe(false);
    // IDENTITY, not shape: `startConnectionOAuthFlow` and `withSession` both compare the
    // session OBJECT across their awaits, so a refusal that rebuilt an equal-looking
    // session would silently invalidate every in-flight transition.
    expect(connectionWizardStore.get(), 'the parked session must not be replaced').toBe(first);
    expect(connectionWizardNoteStore.get() ?? '').toMatch(/already open/i);
  });

  it('the refused open changes NOTHING about the first session — step, slot and flow all hold', async () => {
    declare(coinbaseRequirement, { approve: true });
    declare(oauthRequirement, { appId: OTHER_APP });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);
    expect(connectionWizardStepStore.get()).toBe('credentials');

    // The stray second open, mid-flow — the shape a chat directive card produces while a
    // Settings-opened sheet is already parked.
    expect(openConnectionWizard({ appId: OTHER_APP, slot: 'fake-idp', source: 'directive' })).toBe(false);
    await settle();

    // The user is still on the screen they were on, for the app they were on. A silent
    // replacement here would swap the sheet's contents under a person mid-paste.
    expect(connectionWizardStepStore.get()).toBe('credentials');
    expect(connectionWizardStore.get()?.appId).toBe(APP);
    expect(connectionWizardStore.get()?.slot).toBe('coinbase');
    expect(text()).toContain('Coinbase');
    expect(text()).not.toContain('Fake IdP');
  });

  it('after a close, the NEXT open succeeds — the refusal is a singleton rule, not a one-shot latch', () => {
    declare(coinbaseRequirement);
    declare(oauthRequirement, { appId: OTHER_APP });
    expect(openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' })).toBe(true);
    expect(openConnectionWizard({ appId: OTHER_APP, slot: 'fake-idp', source: 'settings' })).toBe(false);

    closeConnectionWizard();

    // Without this direction, a mutation that simply made `openConnectionWizard` always
    // return false would pass every assertion above.
    expect(openConnectionWizard({ appId: OTHER_APP, slot: 'fake-idp', source: 'settings' })).toBe(true);
    expect(connectionWizardStore.get()?.appId).toBe(OTHER_APP);
    // And the stale refusal note is cleared, so it cannot be read as being about THIS open.
    expect(connectionWizardNoteStore.get()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RESTORED 8 — required-field validation on the credentials screen
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted authWizard.test.tsx:564-577 ("nonBlocking 9 — a blank required
// key never shows connected: no write, an error, the step stays").
//
// WHAT SHIPS AND WHY IT WAS UNGUARDED. ConnectionWizardSheet.tsx:425-430 computes the
// missing set and refuses — real shipped code with nothing driving it. The v4 store's
// `saveConnectionCredentials` deliberately SKIPS empty values (connectionWizard.ts:369-370)
// rather than failing, so without this component-level check a blank required field
// advances the machine to `done` and the screen says the connection is set up. The user
// then meets the failure much later as a NET_AUTH_FAILED inside their running app, in a
// vocabulary they never chose, far from the two-second repair.
//
// MUTATIONS THIS KILLS: deleting the `missing.length > 0` early return; inverting the
// `field.required !== false` default (which would make every optional field mandatory, or
// every required field optional); dropping the field LABEL from the message, leaving a
// bare "something is missing" the user cannot act on.
describe('RESTORED 8 — a blank REQUIRED field blocks the save and names the field', () => {
  it('no write, no advance, and an alert that NAMES the missing field', async () => {
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);

    // Only ONE of the two required fields is filled.
    await type('api_key', 'only-this-one-was-pasted');
    await click(/save my credentials/i);

    const alert = container!.querySelector('[role="alert"]');
    expect(alert, 'a blank required field must be told to the user, not swallowed').not.toBeNull();
    // The LABEL, not the key: 'api_secret' means nothing to the person reading the screen,
    // and a message they cannot map back to a box is a message that cannot be acted on.
    expect(alert!.textContent ?? '').toContain('API secret');

    // The step HOLDS — a false 'done' is the failure this exists to stop.
    expect(connectionWizardStepStore.get(), 'a refused save must not advance the machine').toBe('credentials');
    // And NOTHING was written, including the field that WAS filled: a half-written
    // credential set is a connection that fails at runtime with a secret already on disk.
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_key'))).toBeUndefined();
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'coinbase', 'api_secret'))).toBeUndefined();
  });

  it('whitespace is not a value — a field holding only spaces is still missing', async () => {
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);

    await type('api_key', 'real-key');
    await type('api_secret', '   ');
    await click(/save my credentials/i);

    expect(container!.querySelector('[role="alert"]')?.textContent ?? '').toContain('API secret');
    expect(connectionWizardStepStore.get()).toBe('credentials');
  });

  it('an OPTIONAL field may be left blank — the rule is `required`, not "every field"', async () => {
    // The other direction, and it is load-bearing: a mutation that made the check
    // unconditional would pass both tests above while blocking every connection whose
    // requirement carries an optional seat.
    declare(
      {
        ...coinbaseRequirement,
        slot: 'optional-seat',
        fields: [
          { key: 'api_key', label: 'API key', type: 'secret', required: true },
          { key: 'account_id', label: 'Account id', type: 'text', required: false },
        ],
      },
      { approve: true },
    );
    openConnectionWizard({ appId: APP, slot: 'optional-seat', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);

    await type('api_key', 'the-required-one');
    await click(/save my credentials/i);

    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(connectionWizardStepStore.get()).toBe('done');
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, 'optional-seat', 'api_key'))).toBe('the-required-one');
  });

  it('ALL required fields blank names ALL of them, not just the first', async () => {
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);
    await click(/save my credentials/i);

    const alert = container!.querySelector('[role="alert"]')?.textContent ?? '';
    // Naming only the first would send the user round the loop once per empty box.
    expect(alert).toContain('API key');
    expect(alert).toContain('API secret');
  });
});

// ---------------------------------------------------------------------------
// RESTORED 9 — the re-approval diff's REMOVED half
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted authWizard.test.tsx:266-283 and :302 ("an added host is
// flagged NEW, a REMOVED host is flagged, and the full list stays visible" /
// "removed by this re-approval").
//
// WHAT SHIPS AND WHAT WAS HALF-ASSERTED. `diffLines` (ConnectionWizardSheet.tsx:653-660)
// emits three states; connectionSettings.test.tsx:274-281 asserts only `added` and
// `unchanged`. The second loop — `for (const item of before) if (!afterSet.has(item))` —
// is the entire REMOVED side, and deleting it leaves every existing test green while the
// diff silently drops what is going away. That is a half-truth in the one screen whose
// only job is to be complete: a user re-approving a connection that DROPS
// `api.exchange.coinbase.com` would be shown a screen implying nothing was lost, and would
// have no way to notice that the app is about to stop reaching a host they depend on.
//
// MUTATIONS THIS KILLS: deleting the `before`-side loop in `diffLines`; dropping the
// `line.state === 'removed'` render branch (:685) so the row appears unlabeled; removing
// the removed entries from the list entirely rather than marking them.
describe('RESTORED 9 — the diff shows what is being REMOVED, not only what is added', () => {
  /**
   * The re-approval that DROPS a host and DROPS a field. The wizard's own diff reads the
   * OLD side from the frozen `allowedHosts`, so the drop has to be observable there.
   */
  const narrowed = {
    ...coinbaseRequirement,
    fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
    declaredApiHosts: ['api.coinbase.com'],
  };

  beforeEach(async () => {
    declare(coinbaseRequirement, { approve: true });
    db.stagePendingRequirement(APP, 'coinbase', narrowed);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);
  });

  it('a dropped HOST is listed and marked removed — never silently absent', () => {
    const diff = container!.querySelector('[data-testid="reapproval-diff"]');
    expect(diff, 'a staged narrowing is still a change the user must read').not.toBeNull();

    const removed = [...diff!.querySelectorAll('[data-diff="removed"]')].map((n) => n.textContent ?? '');
    const joined = removed.join(' | ');
    expect(joined, 'the host leaving the ceiling must be on screen').toContain('api.exchange.coinbase.com');
    // STILL LISTED, not deleted from the view: a host that vanishes from the list is
    // indistinguishable from a host that was never there, which is the failure mode.
    expect(diff!.textContent ?? '').toContain('api.exchange.coinbase.com');
    // And it says WHY it is there, in words. An unlabeled row reads as "unchanged".
    expect(joined).toMatch(/no longer requested|removed/i);
  });

  it('a dropped FIELD is marked removed too — the field side of the same loop', () => {
    const diff = container!.querySelector('[data-testid="reapproval-diff"]');
    const removed = [...diff!.querySelectorAll('[data-diff="removed"]')].map((n) => n.textContent ?? '').join(' | ');
    expect(removed).toContain('API secret');
  });

  it('the three states are DISTINGUISHABLE — removed is not just added under another name', () => {
    // The anti-collapse assertion. A mutation that emitted `state: 'added'` for the
    // before-side loop would satisfy "the host is on screen" while telling the user the
    // exact opposite of the truth about it.
    const diff = container!.querySelector('[data-testid="reapproval-diff"]')!;
    const byState = (state: string): string =>
      [...diff.querySelectorAll(`[data-diff="${state}"]`)].map((n) => n.textContent ?? '').join(' | ');

    expect(byState('removed')).toContain('api.exchange.coinbase.com');
    expect(byState('added'), 'a dropped host is not an addition').not.toContain('api.exchange.coinbase.com');
    expect(byState('unchanged'), 'a dropped host is not unchanged').not.toContain('api.exchange.coinbase.com');
    // The host that survives reads as unchanged, so the removal is legible AS a removal by
    // contrast rather than by the user having to remember the old list.
    expect(byState('unchanged')).toContain('api.coinbase.com');
  });
});

// ---------------------------------------------------------------------------
// RESTORED 10 — punycode host disclosure on the screen the user approves
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted authWizard.test.tsx:214-223 ("AC7 — a unicode declared host
// renders as its punycoded xn-- form before approve").
//
// WHAT SHIPS AND WHY NO V4 TEST EXISTS. `normalizeAuthHost` (auth-schema.ts:345) IDNA
// toASCII's every declared host at SCHEMA parse time, and `deriveConnectionAllowedHosts`
// freezes those normalized forms into `allowed_hosts` — so the review screen, which
// renders `row.allowedHosts` verbatim, shows the punycode. After the rebuild there is not
// one `xn--` assertion anywhere in v4.
//
// WHY IT IS A DISCLOSURE PROPERTY RATHER THAN A COSMETIC ONE. `аpi.coinbase.com` with a
// Cyrillic 'а' is a DIFFERENT host from `api.coinbase.com` and renders identically in
// every font a user will ever see. The punycode form is the only rendering in which the
// two are visibly different, and the review screen is the exact moment the user is being
// asked to freeze a ceiling that includes it. Showing the unicode form back would mean
// the platform itself had drawn the homograph for the attacker.
//
// MUTATIONS THIS KILLS: rendering a "prettified"/unicode form of the host on the review
// screen; dropping the `.transform(normalizeAuthHost)` from `declaredApiHostsSchema` so
// the raw unicode is what gets frozen and displayed.
describe('RESTORED 10 — a unicode homograph host is disclosed in its xn-- punycode form', () => {
  const homographRequirement = {
    ...coinbaseRequirement,
    slot: 'homograph',
    // ASCII provider NAME on purpose: `provider.name` has its own confusable guard that
    // refuses non-ASCII outright, so a unicode name would fail at the schema and this test
    // would never reach the HOST claim it exists to make. The two guards are different
    // mechanisms answering the same threat at different seats — names are refused, hosts
    // are normalized and disclosed — and this fixture isolates the second.
    provider: { name: 'Bucher API' },
    // A Cyrillic 'а' (U+0430) in place of the Latin 'a', plus a plainly non-ASCII host.
    // Both must reach the screen as xn-- forms, or the review is drawing the attacker's
    // disguise for them.
    declaredApiHosts: ['аpi.coinbase.com', 'bücher.example'],
  };

  it('the review screen renders the punycode form, and NOT the unicode one', async () => {
    declare(homographRequirement);
    openConnectionWizard({ appId: APP, slot: 'homograph', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    const hosts = container!.querySelector('[data-testid="review-hosts"]')?.textContent ?? '';
    expect(hosts, 'a unicode host must be disclosed as punycode').toContain('xn--');
    expect(hosts).toContain('xn--bcher-kva.example');
    // The Cyrillic homograph of api.coinbase.com — visually identical, cryptographically
    // and DNS-wise a different host entirely.
    expect(hosts).toContain('xn--pi-6kc.coinbase.com');

    // THE LOAD-BEARING NEGATIVE: the raw unicode must not be what the user reads, or the
    // punycode assertion above is satisfied by a screen that shows BOTH and still lets the
    // homograph pass as the real thing.
    expect(hosts, 'the unicode form is the disguise — it must not be the disclosure').not.toContain(
      'аpi.coinbase.com',
    );
    expect(hosts).not.toContain('bücher.example');
  });

  it('the FROZEN ceiling is the punycode form too — display and grant agree', async () => {
    // A review that displayed punycode while freezing unicode (or the reverse) would be a
    // screen telling the truth about a value that is not the one serving.
    declare(homographRequirement, { approve: true });
    const frozen = db.getConnection(APP, 'homograph')!.allowedHosts;
    expect(frozen).toContain('xn--bcher-kva.example');
    expect(frozen).toContain('xn--pi-6kc.coinbase.com');
    expect(frozen).not.toContain('bücher.example');

    openConnectionWizard({ appId: APP, slot: 'homograph', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    const hosts = container!.querySelector('[data-testid="review-hosts"]')?.textContent ?? '';
    for (const host of frozen) expect(hosts, `frozen host ${host} must be on the review screen`).toContain(host);
  });
});

// ---------------------------------------------------------------------------
// RESTORED 11 — the Settings card's FULL frozen host list, and its empty state
// ---------------------------------------------------------------------------
//
// DESCENDS FROM the deleted connectionsPanel.test.tsx (the v3 panel's host-list and
// empty-state coverage) and authWizard.test.tsx:147 ("full punycoded host list rendered
// before approve enables").
//
// WHAT SHIPS AND WHAT WAS UNASSERTED. `ConnectionSlotsCard` renders the empty-state hint
// at :156 and the wizard's done screen joins `row.allowedHosts` at :595. Neither was
// asserted on the v4 surface. The COMPLETENESS of a host list is not decoration: a list
// that silently truncates (a `.slice(0, 2)`, a "+2 more" that never expands) means the
// user approves — and later reviews — a ceiling they were never shown in full, which is
// the same omission the re-approval diff exists to prevent, one screen earlier.
//
// MUTATIONS THIS KILLS: truncating the rendered host list anywhere; replacing the
// empty-state hint with nothing (a blank card reads as a broken card, not as "you have
// connected nothing"); rendering the empty state while rows exist.
describe('RESTORED 11 — the full frozen host list, and the empty state', () => {
  it('the DONE screen names EVERY frozen host, not a truncated sample', async () => {
    const manyHosts = {
      ...coinbaseRequirement,
      slot: 'many-hosts',
      fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
      declaredApiHosts: [
        'api.coinbase.com',
        'api.exchange.coinbase.com',
        'api.prime.coinbase.com',
        'ws.coinbase.com',
        'files.coinbase.com',
      ],
    };
    declare(manyHosts, { approve: true });
    const frozen = db.getConnection(APP, 'many-hosts')!.allowedHosts;
    expect(frozen.length, 'the fixture must be long enough for a truncation to be visible').toBeGreaterThan(4);

    openConnectionWizard({ appId: APP, slot: 'many-hosts', source: 'settings' });
    await render(<ConnectionWizardSheet />);
    await click(/approve this connection/i);
    await type('api_key', 'a-value');
    await click(/save my credentials/i);
    expect(connectionWizardStepStore.get()).toBe('done');

    // "this app can now reach …" is a claim about the whole ceiling. Every host in it.
    for (const host of frozen) {
      expect(text(), `the done screen must name frozen host ${host}`).toContain(host);
    }
  });

  it('the REVIEW screen lists every declared host as its own item — the pre-approval half', async () => {
    declare(coinbaseRequirement);
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await render(<ConnectionWizardSheet />);

    const items = [...container!.querySelectorAll('[data-testid="review-hosts"] li')].map((li) => li.textContent ?? '');
    const frozenIfApproved = coinbaseRequirement.declaredApiHosts;
    expect(items, 'one list item per host — a joined string can hide a truncation').toHaveLength(
      frozenIfApproved.length,
    );
    for (const host of frozenIfApproved) expect(items.some((line) => line.includes(host))).toBe(true);
  });

  it('with NO connections the card says so in words, rather than rendering an empty shell', async () => {
    await render(<ConnectionSlotsCard />);

    expect(container!.querySelectorAll('[data-testid="connection-slot-row"]')).toHaveLength(0);
    // A card with a heading and nothing under it reads as broken. The sentence is what
    // turns "nothing here" into an answer to the question the user came with.
    expect(text()).toMatch(/no app has asked to connect|nothing connected|no connections/i);
  });

  it('the empty-state copy DISAPPEARS as soon as a row exists', async () => {
    // Without this direction, a mutation that rendered the hint unconditionally would pass
    // the test above while telling a user with three live grants that they have none.
    declare(coinbaseRequirement, { approve: true });
    await render(<ConnectionSlotsCard />);

    expect(container!.querySelectorAll('[data-testid="connection-slot-row"]')).toHaveLength(1);
    expect(text()).not.toMatch(/no app has asked to connect/i);
  });
});

// ---------------------------------------------------------------------------
// RESTORED 13 — dismissal semantics: an in-flight sign-in DEMANDS CONFIRMATION
// ---------------------------------------------------------------------------
//
// OWNER DECISION (2026-08-10): "let v4 also ask for confirmation (if the oauth is mid
// flight)". The v3 semantics are restored deliberately, and this block is now a
// RESTORATION rather than the pinning record it was written as.
//
// WHAT WAS LOST. v3's `requestCloseWizard` returned 'needs_confirm' when a flow was in
// flight — the session SURVIVED and only an explicit `forceCloseWizard()` tore it down
// (deleted wizardStore.test.ts:173, "dismiss-confirm ... (M9)"). The P3 rebuild dropped
// the gate, so one stray Esc discarded a sign-in the user was halfway through.
//
// WHAT MUST NOT CHANGE. The TEARDOWN is correct and stays exactly as it is: leaving a
// channel or a poll alive over a dismissed session means a returning callback writing
// into a flow nobody is watching, and a poll that later errors a status belonging to
// somebody else's flow. The v3 hardening at connectionWizard.ts:210-213 is right about
// why. This change adds a gate IN FRONT of that teardown; it does not weaken it.
//
// THE SHAPE. `closeConnectionWizard()` returns 'closed' | 'needs_confirm'. Idle/settled
// sessions close immediately as before (no new friction on the common path — closing a
// finished wizard must not nag). Only `awaiting_callback` and `exchanging` — the two
// genuinely mid-flight states — ask. `forceCloseWizard()` is the explicit confirm and is
// unconditional.
describe('RESTORED 13 — an in-flight sign-in is not discarded without confirmation (M9)', () => {
  async function startAFlow(): Promise<{ closeCalls: () => number }> {
    declare(oauthRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'fake-idp', source: 'settings' });
    let closeCalls = 0;
    let channelClosed = 0;
    __setConnectionOAuthHooksForTests({
      service: {
        generateAuthUrl: vi.fn(async () => ({ flowId: 'flow-1', authorizeUrl: 'https://idp.example/authorize?x=1' })),
        handleCallback: vi.fn(async () => ({ scopesGranted: [] })),
      } as never,
      channelFactory: () => ({
        onmessage: null,
        close: () => {
          channelClosed += 1;
        },
      }),
      openPopup: () => ({
        closed: false,
        close: () => {
          closeCalls += 1;
        },
      }),
    });
    await startConnectionOAuthFlow({ client_id: 'cid-1' });
    expect(connectionFlowStatusStore.get().state, 'the flow must actually be in flight').toBe('awaiting_callback');
    return { closeCalls: () => closeCalls + channelClosed };
  }

  it('a close mid-flight RETURNS needs_confirm and the session SURVIVES', async () => {
    const flow = await startAFlow();

    const outcome = closeConnectionWizard();

    expect(outcome, 'a mid-flight dismissal must ask, not act').toBe('needs_confirm');
    expect(connectionWizardStore.get(), 'the session survives an unconfirmed close').not.toBeNull();
    expect(connectionFlowStatusStore.get().state, 'the flow is still in flight').toBe('awaiting_callback');
    expect(flow.closeCalls(), 'nothing is torn down until the user confirms').toBe(0);
  });

  it('the confirm — forceCloseWizard — tears down unconditionally', async () => {
    const flow = await startAFlow();

    expect(closeConnectionWizard()).toBe('needs_confirm');
    forceCloseWizard();

    expect(connectionWizardStore.get(), 'the explicit confirm closes').toBeNull();
    expect(connectionFlowStatusStore.get().state).toBe('idle');
    expect(flow.closeCalls(), 'the popup and channel go with the session').toBeGreaterThan(0);
  });

  it('an IDLE session still closes immediately — the gate must not nag on the common path', () => {
    // Without this direction, "ask before closing" degrades into "ask every time", which
    // trains the user to dismiss the prompt and defeats the point of having one.
    declare(coinbaseRequirement, { approve: true });
    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });

    expect(connectionFlowStatusStore.get().state, 'precondition: no flow in flight').toBe('idle');
    expect(closeConnectionWizard(), 'a settled wizard closes without a prompt').toBe('closed');
    expect(connectionWizardStore.get()).toBeNull();
  });

  it('the teardown is COMPLETE — channel and popup both go with the session (the half that must stay)', async () => {
    const flow = await startAFlow();

    forceCloseWizard();

    // Whatever the owner decides about the confirm, THIS must not regress: a channel or a
    // poll outliving a dismissed session means a returning callback writing into a flow
    // nobody is watching, and a poll that later errors a status belonging to someone
    // else's flow. Deleting `teardownFlow()` from `closeConnectionWizard` is the mutation.
    expect(flow.closeCalls(), 'the popup and channel must be closed with the session').toBeGreaterThan(0);
    expect(connectionWizardStepStore.get()).toBe('review');
  });

  it('THE UI HONOURS THE GATE — the sheet shows a confirm instead of closing, and only "discard" closes', async () => {
    // The store rule is worth nothing if the component ignores the return value, which is
    // exactly the shape of mistake a `void closeConnectionWizard()` would make. This drives
    // the rendered sheet: dismiss -> prompt appears, session survives; "keep signing in" ->
    // prompt goes, session STILL survives; "discard" -> gone.
    const flow = await startAFlow();
    await render(<ConnectionWizardSheet />);

    await click(/close|dismiss|×/i);
    expect(container!.querySelector('[data-testid="discard-signin-confirm"]'), 'the confirm must render').not.toBeNull();
    expect(connectionWizardStore.get(), 'dismissing does not close a mid-flight wizard').not.toBeNull();
    expect(flow.closeCalls(), 'nothing is torn down while the prompt is up').toBe(0);

    await click(/keep signing in/i);
    expect(connectionWizardStore.get(), 'backing out of the prompt keeps the session').not.toBeNull();
    expect(connectionFlowStatusStore.get().state).toBe('awaiting_callback');

    await click(/close|dismiss|×/i);
    await click(/discard the sign-in/i);
    expect(connectionWizardStore.get(), 'the explicit confirm closes').toBeNull();
    expect(flow.closeCalls(), 'and the teardown still runs').toBeGreaterThan(0);
  });

  it('a close during an in-flight flow leaves a LATER flow able to start cleanly', async () => {
    // The consequence of a complete teardown, asserted where a user would feel it: a leaked
    // poll from flow 1 killed every later flow within 500ms of `awaiting_callback` in v3.
    await startAFlow();
    forceCloseWizard();

    openConnectionWizard({ appId: APP, slot: 'fake-idp', source: 'settings' });
    await startConnectionOAuthFlow({ client_id: 'cid-2' });
    expect(connectionFlowStatusStore.get().state).toBe('awaiting_callback');
  });
});
