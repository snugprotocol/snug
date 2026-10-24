// chatgptUsageLimit.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L5 (AC7; plan §1 D5, §12
// L5-8; ADR-0078 §5 — "the limit message's primary action is Manage usage everywhere it renders").
//
// `ui/UsageLimitMessage.tsx` — the AC7 sentence (single-homed: `CHATGPT_ERROR_SENTENCES` in
// adapters, imported, never retyped) with **Manage usage** as the PRIMARY action, an `ExternalLink`
// to https://chatgpt.com/settings/usage. Rendered:
//   - by `ChatLog` (the builder and the run rail) for `message.error.code === CHATGPT_USAGE_LIMIT`,
//     the ordinary error note for every other code (the mutation: a generic "— try again." note
//     whose only act is a bug report — the user cannot act on a limit there);
//   - by RunView as a banner fed by the frame's `onLlmEvent` round trips (the `net-auth-cta`
//     precedent: a calm note, one primary act, a dismiss) — an app's own envelope error is the
//     app's to render, so the HOST says what the person can do;
//   - by `ResultDetail` per L5-3 (pinned in resultDetail.test.tsx).
//
// Pinned test ids: `usage-limit-message` (the component's root), `chatgpt-usage-limit-banner` (RunView).
// RED until `ui/UsageLimitMessage.tsx` exists and ChatLog/RunView render it.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES, type AgentTurnEvent } from '@snugprotocol/adapters';

import type { ChatMessage } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
import { ChatLog } from '../views/ChatLog.js';
import { installTestUserDb } from './userdbTestHelper.js';

/** Non-literal, so Vite's import analysis does not fail the whole file while the component is missing. */
const MESSAGE_MODULE = '../ui/UsageLimitMessage.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
const LIMIT_SENTENCE = CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_LIMIT];

/** The frame transport's LLM feed, captured from RunView's composeAppRuntime call. */
const captured = vi.hoisted(() => ({ onLlmEvent: undefined as undefined | ((event: unknown) => void) }));

vi.mock('../run/appRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../run/appRuntime.js')>();
  return {
    ...actual,
    composeAppRuntime: (options: Parameters<typeof actual.composeAppRuntime>[0]) => {
      captured.onLlmEvent = options.onLlmEvent as ((event: unknown) => void) | undefined;
      return actual.composeAppRuntime(options);
    },
  };
});

// No iframe in jsdom: the frame is a probe (the sharedConsentGate.test.tsx pattern).
vi.mock('@snugprotocol/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snugprotocol/runner')>();
  const Probe = (): ReactElement => <div data-testid="frame-probe" />;
  return { ...actual, SnugAppFrame: Probe };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  modeStore.set('byok');
  captured.onLlmEvent = undefined;
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function mount(node: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  await settle();
  return container;
}

/** The Manage usage act inside `scope`: present, the href pinned, the PRIMARY act, and the FIRST act. */
function expectManageUsagePrimary(scope: Element | null | undefined): void {
  expect(scope, 'the limit surface rendered').toBeTruthy();
  const acts = [...scope!.querySelectorAll<HTMLElement>('a, button')];
  const manage = acts.find((el) => el.textContent === 'Manage usage') as HTMLAnchorElement | undefined;
  expect(manage, 'a Manage usage act').toBeDefined();
  expect(manage!.getAttribute('href')).toBe(MANAGE_USAGE_URL);
  expect(manage!.classList.contains('btn-primary'), 'Manage usage is the PRIMARY action').toBe(true);
  expect(acts[0], 'and it comes first').toBe(manage);
}

const errorMessage = (code: string, message: string, retryable = false): ChatMessage =>
  ({ id: 7, role: 'agent', displayText: '', error: { code, message, retryable } }) as ChatMessage;

describe('UsageLimitMessage — the AC7 sentence with Manage usage first', () => {
  it('the sentence is the single-homed AC7 copy, byte-pinned once here', () => {
    expect(LIMIT_SENTENCE).toBe("Usage limit reached — Review your plan or this app's limit in ChatGPT settings.");
  });

  it('renders the sentence and Manage usage as the primary, first act (no props needed)', async () => {
    const { UsageLimitMessage } = (await import(/* @vite-ignore */ MESSAGE_MODULE)) as typeof import('../ui/UsageLimitMessage.js');
    const el = await mount(<UsageLimitMessage />);
    const message = el.querySelector('[data-testid="usage-limit-message"]');
    expect(message?.textContent).toContain(LIMIT_SENTENCE);
    expectManageUsagePrimary(message);
  });
});

describe('ChatLog — a usage-limit turn renders UsageLimitMessage (builder and run rail, L5-8)', () => {
  beforeEach(async () => {
    await installTestUserDb();
  });

  it('message.error.code === CHATGPT_USAGE_LIMIT → the limit message with Manage usage primary — not the generic note', async () => {
    const el = await mount(<ChatLog messages={[errorMessage(CHATGPT_ERROR_CODES.USAGE_LIMIT, LIMIT_SENTENCE)]} />);
    const message = el.querySelector('[data-testid="usage-limit-message"]');
    expect(message).not.toBeNull();
    expect(message!.textContent).toContain(LIMIT_SENTENCE);
    expectManageUsagePrimary(message);
    expect(el.textContent).not.toContain('— try again.');
  });

  it.each([
    ['HOST_ERROR', 'The model could not answer.', false],
    [CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE], true],
    [CHATGPT_ERROR_CODES.SIGN_IN_NEEDED, CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.SIGN_IN_NEEDED], false],
  ])('any other code (%s) keeps the ordinary error note — no limit message', async (code, text, retryable) => {
    const el = await mount(<ChatLog messages={[errorMessage(code, text, retryable)]} />);
    expect(el.querySelector('[data-testid="usage-limit-message"]')).toBeNull();
    const note = el.querySelector('.error-note[role="alert"]');
    expect(note?.textContent).toContain(text);
  });
});

describe('RunView — a frame round trip that hit the limit raises a banner (L5-8)', () => {
  const APP = 'limit-app';

  async function openRun(): Promise<HTMLDivElement> {
    const db = await installTestUserDb();
    db.installApp({ appId: APP, displayName: 'Limit App', html: '<!doctype html><html><body>app</body></html>' });
    const { default: RunView } = await import('../run/RunView.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={[`/run/${APP}`]}>
          <Routes>
            <Route path="/run/:id" element={<RunView />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await settleUntil(() => captured.onLlmEvent !== undefined, 'the frame runtime to be composed');
    return container;
  }

  const roundTrip = (response: unknown): AgentTurnEvent =>
    ({ type: 'round_trip', index: 0, request: { system: 's', messages: [] }, response, durationMs: 5 }) as AgentTurnEvent;

  const banner = (): HTMLElement | null => container?.querySelector<HTMLElement>('[data-testid="chatgpt-usage-limit-banner"]') ?? null;

  it('a round trip whose response.code is CHATGPT_USAGE_LIMIT raises the banner: the sentence, Manage usage primary, a dismiss', async () => {
    await openRun();
    expect(banner()).toBeNull();
    await act(async () => {
      captured.onLlmEvent!(roundTrip({ ok: false, code: CHATGPT_ERROR_CODES.USAGE_LIMIT, message: LIMIT_SENTENCE, retryable: false }));
    });
    await settle();

    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain(LIMIT_SENTENCE);
    expectManageUsagePrimary(banner());

    const dismiss = [...banner()!.querySelectorAll('button')].find((b) => /dismiss/i.test(b.textContent ?? ''));
    expect(dismiss, 'the banner can be dismissed').toBeDefined();
    await act(async () => {
      dismiss!.click();
    });
    expect(banner()).toBeNull();
  });

  it('NEGATIVE: an ordinary error round trip or a success raises no banner', async () => {
    await openRun();
    await act(async () => {
      captured.onLlmEvent!(roundTrip({ ok: false, code: 'HOST_ERROR', message: 'nope', retryable: false }));
      captured.onLlmEvent!(roundTrip({ ok: true, text: 'fine', toolCalls: [], stopReason: 'end' }));
    });
    await settle();
    expect(banner()).toBeNull();
  });
});
