// chatgptWelcome.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L5 (AC1, AC2; plan §12 L5-1;
// ADR-0078 §1, §10).
//
// The desktop Welcome's THIRD card, "use your ChatGPT plan" (owner's interview Q2/Q4). Pinned here,
// each with the mutation it catches:
//   - a platform carrying the custody seat shows THREE cards, the third holding a `ChatgptButton`
//     reading "Continue with ChatGPT"; a seatless desktop shows two (a card that cannot work is the
//     failure the Welcome exists to avoid — DesktopWelcome.tsx's header);
//   - the third card obeys the ZERO-JARGON contract (no BYOK / LLM / endpoint / OAuth / token);
//   - the button STARTS the sign-in and does not change the mode (a mode set before the sign-in
//     succeeded would leave a user who cancels on a brain that refuses every turn);
//   - while the sign-in is out, the card says where it is happening and offers a PRIMARY
//     "cancel this sign-in" (the connection wizard's precedent — AC2's visible cancel);
//   - a resolved `{ ok: true }` → `setMode('chatgpt')` + `completeDesktopFirstRun()` and the
//     person stays on the hub (no navigate to Settings — the one-time notice shows there, AC11);
//   - `{ ok: false, message }` → the sentence under the card, the mode untouched, the other two
//     cards still live;
//   - the Ollama link opens through `openExternalUrl` — never `oauth.openExternal`, which binds a
//     pending OAuth flow's loopback listener (a pre-existing seam error the L5 inventory found).
//
// Harness: desktopFirstRun.test.tsx's fresh-module pattern (the platform is set once per graph),
// plus the L4 keeper booted on a fake session (chatgptPlanTestHelper).
//
// RED until DesktopWelcome renders the third card and `state/chatgptPlan.ts` exists.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SignInResult } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import { READY, SIGNED_OUT, chatgptDesktopPlatform, fakeChatgptSession, recordingFactory, type FakeChatgptSession } from './chatgptPlanTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  db: UserDb;
  firstRun: typeof import('../desktop/firstRun.js');
  mode: typeof import('../state/mode.js');
  ollama: typeof import('../state/ollama.js');
  keeper: typeof import('../state/chatgptPlan.js');
  HubView: typeof import('../views/HubView.js')['HubView'];
}

async function fresh(platform: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const firstRun = await import('../desktop/firstRun.js');
  const mode = await import('../state/mode.js');
  const ollama = await import('../state/ollama.js');
  const keeper = await import('../state/chatgptPlan.js');
  keeper.resetChatgptPlanForTests();
  const hub = await import('../views/HubView.js');
  return { db, firstRun, mode, ollama, keeper, HubView: hub.HubView };
}

const noOllama = (): Promise<{ running: boolean; models: string[] }> => Promise.resolve({ running: false, models: [] });

/** A deferred `signIn`: the browser is "open" until the test resolves it. */
function holdSignIn(session: FakeChatgptSession): { resolve: (result: SignInResult) => void } {
  let resolve: (result: SignInResult) => void = () => undefined;
  session.signIn = (opts) => {
    session.calls.signIn.push(opts);
    return new Promise<SignInResult>((r) => {
      resolve = r;
    });
  };
  return { resolve: (result) => resolve(result) };
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** A desktop graph with the seat, the keeper booted on `session`, the first-run latch armed, the hub mounted. */
async function welcomeWith(session: FakeChatgptSession, overrides: Partial<SnugPlatform> = {}): Promise<Harness> {
  const harness = await fresh(chatgptDesktopPlatform({ probeOllama: noOllama, ...overrides }));
  await harness.keeper.bootChatgptPlan(recordingFactory(session).create);
  await harness.ollama.refreshOllama();
  await harness.firstRun.initDesktopFirstRun();
  await renderHub(harness);
  return harness;
}

async function renderHub(harness: Harness): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<harness.HubView />} />
          <Route path="/settings" element={<p data-testid="settings-route">settings</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

const welcome = (): HTMLElement | null => container?.querySelector<HTMLElement>('[data-testid="desktop-welcome"]') ?? null;
const cards = (): HTMLElement[] => [...(container?.querySelectorAll<HTMLElement>('[data-testid="desktop-welcome"] .tile-grid > .card') ?? [])];
const chatgptCard = (): HTMLElement | undefined => cards().find((card) => (card.textContent ?? '').includes('use your ChatGPT plan'));

function buttonIn(scope: ParentNode | undefined, name: RegExp): HTMLButtonElement | undefined {
  return [...(scope?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
}

async function click(target: HTMLElement | undefined, label: string): Promise<void> {
  if (target === undefined) throw new Error(`nothing to click: ${label}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe('the third card exists only where the seat is (AC1, L5-1)', () => {
  it('a desktop carrying chatgptPlan shows THREE cards; the third is "use your ChatGPT plan" with a "Continue with ChatGPT" button', async () => {
    await welcomeWith(fakeChatgptSession(SIGNED_OUT));
    expect(welcome()).not.toBeNull();
    expect(cards()).toHaveLength(3);
    const third = cards()[2];
    expect(third?.textContent).toContain('use your ChatGPT plan');
    const button = buttonIn(third, /Continue with ChatGPT/);
    expect(button, 'the third card carries the ChatgptButton').toBeDefined();
    // OpenAI's button format: the text AND the logo (decorative — the text is the name).
    const logo = button!.querySelector('img');
    expect(logo).not.toBeNull();
    expect(logo!.getAttribute('alt')).toBe('');
  });

  it('a desktop WITHOUT the seat shows two cards and never says ChatGPT', async () => {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true }, probeOllama: noOllama });
    const helper = await import('./userdbTestHelper.js');
    const db = await helper.installTestUserDb();
    const firstRun = await import('../desktop/firstRun.js');
    const mode = await import('../state/mode.js');
    const ollama = await import('../state/ollama.js');
    const keeper = await import('../state/chatgptPlan.js');
    const hub = await import('../views/HubView.js');
    await ollama.refreshOllama();
    await firstRun.initDesktopFirstRun();
    await renderHub({ db, firstRun, mode, ollama, keeper, HubView: hub.HubView });

    expect(welcome()).not.toBeNull();
    expect(cards()).toHaveLength(2);
    expect(welcome()!.textContent).not.toContain('ChatGPT');
  });

  it('the third card keeps the ZERO-JARGON contract — no BYOK, LLM, endpoint, OAuth or token — idle AND while signing in', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    holdSignIn(session);
    await welcomeWith(session);
    const jargon = [/BYOK/i, /\bLLM\b/i, /endpoint/i, /OAuth/i, /\btokens?\b/i];
    for (const word of jargon) expect(chatgptCard()?.textContent ?? '', `idle: ${String(word)}`).not.toMatch(word);

    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');
    const text = welcome()?.textContent ?? '';
    for (const word of jargon) expect(text, `pending: ${String(word)}`).not.toMatch(word);
  });
});

describe('Continue with ChatGPT starts the sign-in — it does not choose the mode yet (AC2, L5-1)', () => {
  it('a click calls signInToChatgpt() once (no consent prompt) and leaves the mode and the latch alone', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    holdSignIn(session);
    const harness = await welcomeWith(session);

    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');

    expect(session.calls.signIn).toHaveLength(1);
    expect(session.calls.signIn[0]?.prompt).toBeUndefined();
    expect(harness.db.getSetting('mode'), 'no mode is chosen before the sign-in succeeds').toBeUndefined();
    expect(harness.mode.modeStore.get()).not.toBe('chatgpt');
    expect(harness.firstRun.desktopFirstRunStore.get(), 'the Welcome stays up while the browser is open').toBe(true);
    expect(welcome()).not.toBeNull();
  });

  it('while pending: the card says the browser is open and offers a PRIMARY "cancel this sign-in" that calls cancelChatgptSignIn()', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const held = holdSignIn(session);
    const harness = await welcomeWith(session);

    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');

    expect(welcome()?.textContent).toContain("we opened your browser — finish signing in there. we're listening.");
    const cancel = buttonIn(welcome() ?? undefined, /^cancel this sign-in$/);
    expect(cancel, 'a visible cancel while the browser is open (AC2)').toBeDefined();
    expect(cancel!.classList.contains('btn-primary'), 'the cancel is the primary act while waiting').toBe(true);

    await click(cancel, 'cancel this sign-in');
    expect(session.calls.cancelSignIn).toBe(1);

    // The keeper ends the cancelled flow by name; the Welcome stays, the mode untouched.
    await act(async () => {
      held.resolve({ ok: false, code: 'sign_in_needed', message: 'You cancelled the sign-in.' });
    });
    await settle();
    expect(welcome()).not.toBeNull();
    expect(harness.db.getSetting('mode')).toBeUndefined();
    expect(buttonIn(welcome() ?? undefined, /^cancel this sign-in$/), 'the cancel goes once the flow ended').toBeUndefined();
  });

  it('a resolved { ok: true } sets the mode to chatgpt, completes the first run, and STAYS on the hub', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const held = holdSignIn(session);
    const harness = await welcomeWith(session);

    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');
    await act(async () => {
      session.setStatus(READY);
      held.resolve({ ok: true, status: READY });
    });
    await settle();

    expect(harness.mode.modeStore.get()).toBe('chatgpt');
    expect(harness.db.getSetting('mode')).toBe('chatgpt');
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
    expect(welcome(), 'the Welcome is done').toBeNull();
    expect(container?.querySelector('[data-testid="settings-route"]'), 'no navigate to Settings — the hub is where the notice shows').toBeNull();
    // Never shown again.
    await harness.firstRun.initDesktopFirstRun();
    expect(harness.firstRun.desktopFirstRunStore.get()).toBe(false);
  });

  it('{ ok: false, message } → the sentence under the card, the mode untouched, the other two cards still live', async () => {
    const failure = 'The sign-in did not finish — try again.';
    const session = fakeChatgptSession(SIGNED_OUT, { signInResult: { ok: false, code: 'network', message: failure } });
    const harness = await welcomeWith(session);

    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');

    expect(chatgptCard()?.textContent, 'the named failure is said on the card it came from').toContain(failure);
    expect(harness.db.getSetting('mode')).toBeUndefined();
    expect(harness.mode.modeStore.get()).not.toBe('chatgpt');
    expect(welcome()).not.toBeNull();

    // The other two cards still work.
    const serviceKey = buttonIn(welcome() ?? undefined, /use an AI service key/i);
    expect(serviceKey?.disabled).toBe(false);
    await click(serviceKey, 'use an AI service key');
    expect(harness.mode.modeStore.get()).toBe('byok');
  });
});

// Gate 5 G5-A9: choosing another card, or skipping, while a sign-in is out in the browser CANCELS it —
// and a completion that lands late must never set the mode over the person's later choice.
describe('another choice or the skip cancels a pending sign-in; a late completion never wins (G5-A9)', () => {
  it('"use an AI service key" while the browser is open: cancelChatgptSignIn() is called, the mode is byok, and a LATE { ok: true } leaves it byok', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const held = holdSignIn(session);
    const harness = await welcomeWith(session);
    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');
    expect(session.calls.cancelSignIn).toBe(0);

    await click(buttonIn(welcome() ?? undefined, /use an AI service key/i), 'use an AI service key');
    expect(session.calls.cancelSignIn, 'the other card cancels the sign-in it would otherwise leave open for ten minutes').toBe(1);
    expect(harness.mode.modeStore.get()).toBe('byok');

    // The keeper's promise settles anyway (a real cancel answers by name; here the browser "finished" late).
    await act(async () => {
      session.setStatus(READY);
      held.resolve({ ok: true, status: READY });
    });
    await settle();
    expect(harness.mode.modeStore.get(), 'a late completion must not override the later choice').toBe('byok');
    expect(harness.db.getSetting('mode')).toBe('byok');
  });

  it('"use your computer’s AI" cancels a pending sign-in too', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const held = holdSignIn(session);
    const harness = await welcomeWith(session, { probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2'] }) });
    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');
    await click(buttonIn(welcome() ?? undefined, /use your computer/i), 'use your computer’s AI');
    expect(session.calls.cancelSignIn).toBe(1);
    expect(harness.mode.modeStore.get()).toBe('local');
    await act(async () => held.resolve({ ok: true, status: READY }));
    await settle();
    expect(harness.mode.modeStore.get()).toBe('local');
  });

  it('the skip ("I’ll look around first") cancels a pending sign-in; a late completion sets no mode', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const held = holdSignIn(session);
    const harness = await welcomeWith(session);
    await click(buttonIn(chatgptCard(), /Continue with ChatGPT/), 'Continue with ChatGPT');
    await click(container?.querySelector<HTMLButtonElement>('[data-testid="welcome-skip"]') ?? undefined, 'skip');
    expect(session.calls.cancelSignIn).toBe(1);
    expect(welcome()).toBeNull();
    await act(async () => held.resolve({ ok: true, status: READY }));
    await settle();
    expect(harness.mode.modeStore.get()).not.toBe('chatgpt');
    expect(harness.db.getSetting('mode')).toBeUndefined();
  });
});

describe('the Ollama link opens through openExternalUrl, never the OAuth opener (L5-1)', () => {
  it('clicking ollama.com calls platform.openExternalUrl with the site and NEVER oauth.openExternal', async () => {
    const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
    const oauthOpen = vi.fn((_url: string) => Promise.resolve());
    const oauth = {
      redirectUriFor: () => Promise.resolve('http://127.0.0.1:1455/callback'),
      openExternal: oauthOpen,
      channelFor: () => ({}) as never,
      cancel: () => Promise.resolve(),
    } as unknown as NonNullable<SnugPlatform['oauth']>;
    await welcomeWith(fakeChatgptSession(SIGNED_OUT), { openExternalUrl, oauth });

    const link = container?.querySelector<HTMLAnchorElement>('[data-testid="welcome-ollama-link"]');
    expect(link?.href).toContain('ollama.com');
    await click(link ?? undefined, 'ollama.com');

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl.mock.calls[0]?.[0]).toContain('ollama.com');
    expect(oauthOpen, 'the OAuth opener binds a pending flow’s listener — never for a plain link').not.toHaveBeenCalled();
  });
});
