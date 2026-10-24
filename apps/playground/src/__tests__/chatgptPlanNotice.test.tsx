// chatgptPlanNotice.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L5 (AC11; plan §3 L5,
// §11 L4-10 accessors; OpenAI's required one-time notice, copy byte-pinned).
//
// `views/ChatgptPlanNotice.tsx` — after the first successful sign-in on this file, once:
//   heading "You're using your ChatGPT plan",
//   body    "Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.",
//   button  "Got it" → `markChatgptNoticeShown()` (the `chatgptNoticeShown` settings row), gone for good.
// The `demoCallout.test.tsx` precedent: a latch in the user file, a surface that reads it. Pinned,
// each with the mutation it catches:
//   - it appears when the plan is in use (mode chatgpt, signed in, plan granted) and the row is unset
//     — including the moment a sign-in completes (the status flip), not only at mount;
//   - "Got it" writes the row and the notice disappears; a remount (a reload) never shows it again;
//   - a file already carrying the row never shows it;
//   - it never shows while the plan is NOT what thinks (signed out, plan not granted, another
//     mode) — "Eligible usage in this app uses your ChatGPT plan" would be untrue there.
//     (The last two are this lane's reading of AC11; flagged in the Gate-3 report.)
// Also: the notice is MOUNTED somewhere in the app (a component nobody renders passes every test above).
//
// Pinned test id: `chatgpt-plan-notice`.
// RED until `views/ChatgptPlanNotice.tsx`, `state/chatgptPlan.ts` and the notice accessors exist.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatgptPlanStatus } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import { NOT_GRANTED, READY, SIGNED_OUT, chatgptDesktopPlatform, fakeChatgptSession, recordingFactory, type FakeChatgptSession } from './chatgptPlanTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HEADING = "You're using your ChatGPT plan";
const BODY = 'Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.';
const SRC = path.resolve(__dirname, '..');

interface Harness {
  db: UserDb;
  mode: typeof import('../state/mode.js');
  session: FakeChatgptSession;
  Notice: typeof import('../views/ChatgptPlanNotice.js')['ChatgptPlanNotice'];
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

async function graph(status: ChatgptPlanStatus, opts: { mode?: 'chatgpt' | 'byok'; rowAlreadySet?: boolean } = {}): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(chatgptDesktopPlatform());
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  if (opts.rowAlreadySet === true) db.setSetting('chatgptNoticeShown', true);
  const mode = await import('../state/mode.js');
  mode.hydrateSettings(db);
  const keeper = await import('../state/chatgptPlan.js');
  keeper.resetChatgptPlanForTests();
  const session = fakeChatgptSession(status);
  await keeper.bootChatgptPlan(recordingFactory(session).create);
  mode.setMode(opts.mode ?? 'chatgpt');
  const view = await import('../views/ChatgptPlanNotice.js');
  return { db, mode, session, Notice: view.ChatgptPlanNotice };
}

async function mount(harness: Harness): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <harness.Notice />
      </MemoryRouter>,
    );
  });
}

const notice = (): HTMLElement | null => container?.querySelector<HTMLElement>('[data-testid="chatgpt-plan-notice"]') ?? null;
const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

describe('the one-time notice (AC11)', () => {
  it('shows with the byte-pinned heading, body and "Got it" while the plan is in use and the row is unset', async () => {
    const harness = await graph(READY);
    expect(harness.mode.chatgptNoticeShown()).toBe(false);
    await mount(harness);

    const shown = notice();
    expect(shown).not.toBeNull();
    const heading = [...shown!.querySelectorAll('*')].find((el) => el.textContent === HEADING);
    expect(heading, 'the heading is its own element, byte-pinned').toBeDefined();
    expect(collapse(shown!.textContent)).toContain(BODY);
    const gotIt = [...shown!.querySelectorAll('button')].find((b) => b.textContent === 'Got it');
    expect(gotIt).toBeDefined();
  });

  it('appears the moment a sign-in completes — the status flip, not only at mount', async () => {
    const harness = await graph(SIGNED_OUT);
    await mount(harness);
    expect(notice()).toBeNull();
    await act(async () => {
      harness.session.setStatus(READY);
    });
    expect(notice()).not.toBeNull();
  });

  it('"Got it" calls markChatgptNoticeShown(): the row is written, the notice is gone, and a remount never shows it again', async () => {
    const harness = await graph(READY);
    await mount(harness);
    const gotIt = [...(notice()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Got it');
    await act(async () => {
      gotIt!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(notice()).toBeNull();
    expect(harness.mode.chatgptNoticeShown()).toBe(true);
    expect(harness.db.getSetting('chatgptNoticeShown')).toBe(true);

    act(() => root?.unmount());
    container?.remove();
    await mount(harness);
    expect(notice(), 'never twice').toBeNull();
  });

  it('a file that already carries the row never shows it', async () => {
    const harness = await graph(READY, { rowAlreadySet: true });
    expect(harness.mode.chatgptNoticeShown()).toBe(true);
    await mount(harness);
    expect(notice()).toBeNull();
  });

  it.each([
    ['signed out', SIGNED_OUT, 'chatgpt'],
    ['plan not granted', NOT_GRANTED, 'chatgpt'],
    ['another mode (byok) while signed in', READY, 'byok'],
  ] as const)('never while the plan is not what thinks: %s', async (_name, status, mode) => {
    const harness = await graph(status, { mode });
    await mount(harness);
    expect(notice()).toBeNull();
    expect(harness.db.getSetting('chatgptNoticeShown'), 'not shown → not latched').toBeUndefined();
  });
});

describe('the notice is mounted in the app', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== '__tests__') walk(full, out);
      } else if (/\.tsx$/.test(name)) out.push(full);
    }
    return out;
  }

  it('some source file other than its own renders <ChatgptPlanNotice', () => {
    const mounts = walk(SRC).filter((file) => !file.endsWith('ChatgptPlanNotice.tsx') && readFileSync(file, 'utf8').includes('<ChatgptPlanNotice'));
    expect(mounts.length, 'a notice nobody renders is a notice nobody sees').toBeGreaterThan(0);
  });
});
