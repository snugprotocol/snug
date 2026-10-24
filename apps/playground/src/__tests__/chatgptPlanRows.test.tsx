// chatgptPlanRows.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L5 (AC1, AC2, AC3, AC4, AC8,
// AC9; plan §3 L5, §1 D5/D6/D7/D9, §12 L5-1; ADR-0078 §5–§7, §9).
//
// Settings' ChatGPT-plan card (`ChatgptPlanRows`, rendered under "where the agent runs" when the
// mode is `chatgpt`) and the Protection card's custody line. Driven through the real SettingsView
// in a fresh module graph on the seat platform, with the L4 keeper booted on a fake session —
// so what is pinned is what a person sees and what each control reaches:
//   - the mode hint names the plan (the mutation: the hub sentence as the else-branch);
//   - SIGNED OUT: a `ChatgptButton` "Continue with ChatGPT" that signs in (no consent prompt, the
//     mode untouched — Settings' segment already chose it), a visible cancel while the browser is
//     open (AC2), and a consent band (`role="note"`) that says *preview*, carries the D9 data-use
//     sentence VERBATIM and says the ChatGPT sign-in sits OUTSIDE the passphrase-protected file;
//   - SIGNED IN + GRANTED: the account e-mail, "Using ChatGPT plan", a Manage usage link opened
//     through the house opener (`ExternalLink` → `openExternalUrl`), the default-model select over
//     the account's models in SERVER ORDER (display names, ids as values) writing
//     `setChatgptModel`, a level select ONLY when the chosen model has levels (ADR-0070's Haiku
//     rule) writing `setChatgptEffort`, and "Sign out of ChatGPT" → the pointer to ChatGPT →
//     Settings (surviving the status flip a real sign-out causes) and, when the revocation was
//     not confirmed, a sentence saying so (D7: never claim a revocation that did not happen);
//   - "forget this registration" → `forgetChatgptRegistration()` where a registration exists;
//   - SIGNED IN + NOT GRANTED: "allow plan usage" → `signInToChatgpt({ prompt: 'consent' })`, the
//     alternatives (a key, a local model) named;
//   - opening Settings refreshes the account's model list (AC8: "refreshed … on Settings open");
//   - the Protection card says the ChatGPT sign-in sits outside the passphrase-protected file, in
//     BOTH protection states, only where the platform carries the seat.
//
// Pinned test ids (L5 builds to them): `chatgpt-plan-rows`, `chatgpt-consent-band`,
// `chatgpt-model-select`, `chatgpt-effort-select`, `chatgpt-revocation-unconfirmed`.
//
// RED until `state/chatgptPlan.ts`, the chatgpt accessors in `state/mode.ts` and `ChatgptPlanRows` exist.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SignInResult } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import { SETTING_PROTECTION_ENABLED } from '../vault/protectOffer.js';
import {
  D9_DATA_USE,
  NOT_GRANTED,
  READY,
  SIGNED_OUT,
  chatgptDesktopPlatform,
  fakeChatgptSession,
  recordingFactory,
  type FakeChatgptSession,
} from './chatgptPlanTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
const POINTER = 'to remove Snug from your account entirely, disconnect it in ChatGPT → Settings.';
/** "the ChatGPT sign-in sits OUTSIDE the passphrase-protected file" — one sentence, in that order. */
const OUTSIDE_THE_FILE = /ChatGPT sign-in[^.]*outside[^.]*passphrase/i;

interface Harness {
  db: UserDb;
  mode: typeof import('../state/mode.js');
  keeper: typeof import('../state/chatgptPlan.js');
  SettingsView: typeof import('../views/SettingsView.js')['SettingsView'];
}

async function fresh(platform: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  const keeper = await import('../state/chatgptPlan.js');
  keeper.resetChatgptPlanForTests();
  const view = await import('../views/SettingsView.js');
  return { db, mode, keeper, SettingsView: view.SettingsView };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

/** Settings on the seat desktop, in chatgpt mode, with the keeper booted on `session`. */
async function settingsWith(session: FakeChatgptSession, overrides: Partial<SnugPlatform> = {}, before?: (h: Harness) => void): Promise<Harness> {
  const harness = await fresh(chatgptDesktopPlatform(overrides));
  await harness.keeper.bootChatgptPlan(recordingFactory(session).create);
  harness.mode.setMode('chatgpt');
  before?.(harness);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <harness.SettingsView />
      </MemoryRouter>,
    );
  });
  await settle();
  return harness;
}

const rows = (): HTMLElement | null => container?.querySelector<HTMLElement>('[data-testid="chatgpt-plan-rows"]') ?? null;
const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function buttonIn(scope: ParentNode | null | undefined, name: RegExp): HTMLButtonElement | undefined {
  return [...(scope?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
}

async function click(target: HTMLElement | undefined, label: string): Promise<void> {
  if (target === undefined) throw new Error(`nothing to click: ${label}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function choose(select: HTMLSelectElement | null | undefined, value: string): Promise<void> {
  if (select === null || select === undefined) throw new Error('no select to choose in');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

const modelSelect = (): HTMLSelectElement | null => container?.querySelector<HTMLSelectElement>('[data-testid="chatgpt-model-select"]') ?? null;
const effortSelect = (): HTMLSelectElement | null => container?.querySelector<HTMLSelectElement>('[data-testid="chatgpt-effort-select"]') ?? null;
const realOptions = (select: HTMLSelectElement | null): HTMLOptionElement[] => [...(select?.options ?? [])].filter((o) => o.value !== '');

/** The Protection card: the card holding the `protection` row label. */
function protectionCard(): HTMLElement | null {
  const label = [...(container?.querySelectorAll('label') ?? [])].find((l) => l.textContent === 'protection');
  return label?.closest<HTMLElement>('.card') ?? null;
}

// ---------------------------------------------------------------------------------------------

describe('the mode hint names the plan (L5)', () => {
  it('mode chatgpt: the hint under "where the agent runs" says ChatGPT plan — not the hub sentence', async () => {
    await settingsWith(fakeChatgptSession(READY));
    const group = container?.querySelector('[aria-labelledby="mode-label"]');
    const hint = group?.closest('.settings-row')?.querySelector('.hint');
    expect(hint?.textContent).toContain('ChatGPT plan');
    expect(hint?.textContent).not.toMatch(/hub server/);
  });

  it('the ChatGPT card renders only in chatgpt mode', async () => {
    const harness = await settingsWith(fakeChatgptSession(READY));
    expect(rows()).not.toBeNull();
    await act(async () => {
      harness.mode.setMode('byok');
    });
    expect(rows()).toBeNull();
  });
});

describe('signed out — the sign-in CTA and the consent band (AC2, D9)', () => {
  it('shows a "Continue with ChatGPT" button (the logo is decorative) that calls signInToChatgpt() with no consent prompt; the mode stays chatgpt', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const harness = await settingsWith(session);
    const button = buttonIn(rows(), /Continue with ChatGPT/);
    expect(button).toBeDefined();
    expect(button!.querySelector('img')?.getAttribute('alt')).toBe('');

    await click(button, 'Continue with ChatGPT');
    expect(session.calls.signIn).toHaveLength(1);
    expect(session.calls.signIn[0]?.prompt).toBeUndefined();
    expect(harness.mode.modeStore.get()).toBe('chatgpt');
  });

  it('while the browser is open the card offers "cancel this sign-in" → cancelChatgptSignIn() (AC2)', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    let resolve: (result: SignInResult) => void = () => undefined;
    session.signIn = (opts) => {
      session.calls.signIn.push(opts);
      return new Promise<SignInResult>((r) => {
        resolve = r;
      });
    };
    await settingsWith(session);
    await click(buttonIn(rows(), /Continue with ChatGPT/), 'Continue with ChatGPT');

    const cancel = buttonIn(rows(), /^cancel this sign-in$/);
    expect(cancel).toBeDefined();
    await click(cancel, 'cancel this sign-in');
    expect(session.calls.cancelSignIn).toBe(1);
    await act(async () => resolve({ ok: false, code: 'sign_in_needed', message: 'You cancelled the sign-in.' }));
    await settle();
    expect(buttonIn(rows(), /Continue with ChatGPT/), 'back to the CTA once the flow ended').toBeDefined();
  });

  it('the consent band is a note that says *preview*, carries the D9 data-use sentence VERBATIM, and says the sign-in sits outside the protected file', async () => {
    await settingsWith(fakeChatgptSession(SIGNED_OUT));
    const band = container?.querySelector<HTMLElement>('[data-testid="chatgpt-consent-band"]');
    expect(band).not.toBeNull();
    expect(band!.getAttribute('role')).toBe('note');
    const text = collapse(band!.textContent);
    expect(text).toMatch(/preview/i);
    expect(text).toContain(D9_DATA_USE);
    expect(text).toMatch(OUTSIDE_THE_FILE);
    // The claims D9 forbids (OpenAI's documents do not support them).
    expect(text).not.toMatch(/not used for training|zero[ -]retention/i);
  });
});

describe('signed in + plan granted — the account, the disclosure, the defaults, sign-out (AC4, AC8, AC9)', () => {
  it('names the account and says "Using ChatGPT plan"; no sign-in CTA', async () => {
    await settingsWith(fakeChatgptSession(READY));
    const text = rows()?.textContent ?? '';
    expect(text).toContain('ada@example.com');
    expect(text).toContain('Using ChatGPT plan');
    expect(buttonIn(rows(), /Continue with ChatGPT/)).toBeUndefined();
  });

  it('Manage usage links to chatgpt.com/settings/usage and opens through the house opener (openExternalUrl), not a bare new-tab anchor', async () => {
    const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
    await settingsWith(fakeChatgptSession(READY), { openExternalUrl });
    const link = [...(rows()?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].find((a) => a.textContent === 'Manage usage');
    expect(link, 'a Manage usage link').toBeDefined();
    expect(link!.getAttribute('href')).toBe(MANAGE_USAGE_URL);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link!.dispatchEvent(event);
    });
    expect(openExternalUrl).toHaveBeenCalledWith(MANAGE_USAGE_URL);
    expect(event.defaultPrevented, 'the webview is never navigated to chatgpt.com').toBe(true);
  });

  it('the default-model select lists the account’s models in SERVER ORDER by display name, ids as values, and writes setChatgptModel', async () => {
    const harness = await settingsWith(fakeChatgptSession(READY));
    const select = modelSelect();
    expect(select).not.toBeNull();
    expect(realOptions(select).map((o) => o.value)).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini']);
    expect(realOptions(select).map((o) => o.textContent)).toEqual(['GPT-6.1 Sol', 'GPT-6.1 mini']);

    await choose(select, 'gpt-6.1-mini');
    expect(harness.mode.chatgptModelStore.get()).toBe('gpt-6.1-mini');
    expect(harness.db.getSetting('providerModel:chatgpt')).toBe('gpt-6.1-mini');
  });

  it('the level select shows ONLY when the chosen model has levels, lists them in the model’s own words, and writes setChatgptEffort', async () => {
    const harness = await settingsWith(fakeChatgptSession(READY), {}, (h) => h.mode.setChatgptModel('gpt-6.1-sol'));
    const effort = effortSelect();
    expect(effort, 'GPT-6.1 Sol has levels').not.toBeNull();
    expect(realOptions(effort).map((o) => o.value)).toEqual(['low', 'medium', 'high', 'ultra']);

    await choose(effort, 'high');
    expect(harness.mode.chatgptEffortStore.get()).toBe('high');
    expect(harness.db.getSetting('providerEffort:chatgpt')).toBe('high');

    await choose(modelSelect(), 'gpt-6.1-mini');
    expect(effortSelect(), 'GPT-6.1 mini has no levels — a control it ignores is a dead control').toBeNull();
  });

  it('"Sign out of ChatGPT" calls signOutOfChatgpt(); afterwards the pointer to ChatGPT → Settings shows — and survives the status flip', async () => {
    const session = fakeChatgptSession(READY);
    const signOut = session.signOut.bind(session);
    session.signOut = async () => {
      const outcome = await signOut();
      session.setStatus(SIGNED_OUT); // what the real keeper does once the tokens are gone
      return outcome;
    };
    await settingsWith(session);
    expect(container?.textContent).not.toContain(POINTER);

    await click(buttonIn(rows(), /^Sign out of ChatGPT$/), 'Sign out of ChatGPT');
    expect(session.calls.signOut).toBe(1);
    expect(collapse(container?.textContent)).toContain(POINTER);
    expect(container?.querySelector('[data-testid="chatgpt-revocation-unconfirmed"]'), 'a confirmed revocation needs no warning').toBeNull();
  });

  it('an UNCONFIRMED revocation is told to the user (D7 — never claimed when it did not happen)', async () => {
    await settingsWith(fakeChatgptSession(READY, { revocation: 'unconfirmed' }));
    await click(buttonIn(rows(), /^Sign out of ChatGPT$/), 'Sign out of ChatGPT');
    const told = container?.querySelector('[data-testid="chatgpt-revocation-unconfirmed"]');
    expect(told).not.toBeNull();
    expect(told!.textContent).toMatch(/confirm/i);
    expect(collapse(container?.textContent)).toContain(POINTER);
  });

  it('opening Settings refreshes the account’s model list (AC8)', async () => {
    const session = fakeChatgptSession(READY);
    await settingsWith(session);
    expect(session.calls.listModels.length).toBeGreaterThanOrEqual(1);
  });
});

describe('"forget this registration" (AC9, D10)', () => {
  it('signed out with a kept registration: the act is there and calls forgetChatgptRegistration()', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    await settingsWith(session);
    const forget = buttonIn(rows(), /forget this registration/i);
    expect(forget, 'the way out when a ChatGPT-side disconnect deleted the client').toBeDefined();
    await click(forget, 'forget this registration');
    expect(session.calls.forgetRegistration).toBe(1);
    expect(session.calls.signOut, 'forgetting is its own act, not a sign-out').toBe(0);
  });

  it('signed out with NOTHING registered: no forget act (there is nothing to forget)', async () => {
    await settingsWith(fakeChatgptSession({ signedIn: false, registered: false }));
    expect(buttonIn(rows(), /forget this registration/i)).toBeUndefined();
  });

  it('signed IN: no forget act — the registration is in use (verifier)', async () => {
    await settingsWith(fakeChatgptSession(READY));
    expect(buttonIn(rows(), /forget this registration/i)).toBeUndefined();
    expect(rows()?.textContent).not.toMatch(/forget this registration/i);
  });

  it('the consent band says what signing out deletes — the TOKENS — and that the registration stays until it is forgotten (G5-S11)', async () => {
    await settingsWith(fakeChatgptSession(SIGNED_OUT));
    const band = collapse(container?.querySelector('[data-testid="chatgpt-consent-band"]')?.textContent);
    expect(band).toMatch(/signing out deletes (its|the) tokens/i);
    expect(band).toMatch(/registration[^.]*(stays|kept)[^.]*forget this registration/i);
    expect(band).not.toMatch(/signing out deletes it\b/i);
  });
});

describe('a remembered usage limit in Settings (G5-C3; verifier R3)', () => {
  it('the limit line renders with Manage usage as the PRIMARY act, and goes when the limit clears', async () => {
    const harness = await settingsWith(fakeChatgptSession(READY), {}, (h) => h.keeper.chatgptLimitStore.set({ at: Date.parse('2026-10-23T08:00:00.000Z'), code: 'usage_limit' }));
    const limit = container?.querySelector<HTMLElement>('[data-testid="chatgpt-settings-usage-limit"]');
    expect(limit, 'the remembered limit reaches Settings').not.toBeNull();
    const manage = [...(limit?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].find((a) => a.textContent === 'Manage usage');
    expect(manage?.getAttribute('href')).toBe(MANAGE_USAGE_URL);
    expect(manage?.classList.contains('btn-primary')).toBe(true);
    await act(async () => harness.keeper.chatgptLimitStore.set(undefined));
    await settle();
    expect(container?.querySelector('[data-testid="chatgpt-settings-usage-limit"]')).toBeNull();
  });

  it('a remembered usage_unavailable renders the adapters’ unavailable sentence, not the limit message', async () => {
    await settingsWith(fakeChatgptSession(READY), {}, (h) => h.keeper.chatgptLimitStore.set({ at: 1, code: 'usage_unavailable' }));
    const { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES } = await import('@snugprotocol/adapters');
    expect(rows()?.textContent).toContain(CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE]);
    expect(container?.querySelector('[data-testid="chatgpt-settings-usage-limit"]')).toBeNull();
  });

  it('the default-model select’s first option is the ONE default label (ST2)', async () => {
    await settingsWith(fakeChatgptSession(READY));
    expect(modelSelect()?.options[0]?.textContent).toBe('default (GPT-6.1 Sol)');
  });
});

describe('signed in + plan NOT granted — re-consent and the alternatives (AC3)', () => {
  it('"allow plan usage" re-authorizes with prompt=consent; the key and local-model alternatives are named', async () => {
    const session = fakeChatgptSession(NOT_GRANTED);
    await settingsWith(session);
    const allow = buttonIn(rows(), /allow plan usage/i);
    expect(allow).toBeDefined();
    const text = rows()?.textContent ?? '';
    expect(text).toMatch(/\bkey\b/i);
    expect(text).toMatch(/local model/i);
    expect(text, 'not granted is not "Using ChatGPT plan"').not.toContain('Using ChatGPT plan');

    await click(allow, 'allow plan usage');
    expect(session.calls.signIn).toEqual([{ prompt: 'consent' }]);
  });
});

describe('the Protection card says the ChatGPT sign-in sits outside the protected file (D2, L5)', () => {
  it('unprotected file, seat platform: the line is there', async () => {
    await settingsWith(fakeChatgptSession(READY));
    expect(collapse(protectionCard()?.textContent)).toMatch(OUTSIDE_THE_FILE);
  });

  it('protected file, seat platform: the line is there too', async () => {
    await settingsWith(fakeChatgptSession(READY), {}, (h) => h.db.setSetting(SETTING_PROTECTION_ENABLED, true));
    const text = collapse(protectionCard()?.textContent);
    expect(text).toContain('this file is protected');
    expect(text).toMatch(OUTSIDE_THE_FILE);
  });

  it('the line says signing out deletes the TOKENS, not "it" — the registration stays until forgotten (G5-S11)', async () => {
    await settingsWith(fakeChatgptSession(READY));
    const note = collapse(container?.querySelector('[data-testid="chatgpt-protection-note"]')?.textContent);
    expect(note).toMatch(/signing out[^.]*deletes (its|the) tokens/i);
    expect(note).not.toMatch(/signing out of ChatGPT deletes it\b/i);
  });

  it('a desktop WITHOUT the seat never mentions ChatGPT on the Protection card', async () => {
    const harness = await fresh({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <harness.SettingsView />
        </MemoryRouter>,
      );
    });
    await settle();
    expect(protectionCard()).not.toBeNull();
    expect(protectionCard()!.textContent).not.toContain('ChatGPT');
  });
});
