// chatLogAccessCard.test.tsx — TASK-20261010-host-broker PR-2, lane B: ChatLog mounts the
// access ask card (AC12; D-PR2-11; S-F11 — the call sites are NAMED, not "found by grep").
//
// `ChatLog` renders `<AccessCard>` for a message carrying `access`, under `allows('access')`
// only (a host without access between apps shows no card, the scheduling card's rule), and
// threads `onResolveAccess` through with the MESSAGE's id. Without the prop the card's acts
// wait — ChatLog never invents a persist path.
//
// THE SOURCE PIN: `run/RunView.tsx` and `views/BuilderView.tsx` pass `onResolveAccess` wherever
// they pass `onResolveSchedule` — read from the source text (the `proposalWriter.test.ts`
// pattern), because an omitted prop is silent: the card would simply render with dead acts in
// one of the two chats.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ACCESS_CARD } from '../access/copy.js';
import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import type { ResolveAccessCard } from '../access/AccessCard.js';
import { accessCardToMeta, stageAccessCard, type AccessCardResolution, type AccessCardState } from '../agent/accessCard.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';
import { ChatLog } from '../views/ChatLog.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.resolve(__dirname, '..');
const THREAD = 'app:chatlog-access';
const PURPOSE = 'to compare spending with the ledger';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let budget: string;

let resolved: Array<{ card: AccessCardState; messageId: number; resolution: AccessCardResolution }> = [];
const record: ResolveAccessCard = (card, messageId, resolution) => {
  resolved.push({ card, messageId, resolution });
};

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function stagedCard(): AccessCardState {
  const card = stageAccessCard({ purpose: PURPOSE, hints: { tables: ['transactions'] } }, { appId: budget, threadId: THREAD });
  const row = db.appendChatMessage(THREAD, 'assistant', 'I asked to read your ledger.', { meta: accessCardToMeta(card) });
  return { ...card, messageRowId: row.id };
}

const message = (card: AccessCardState, id = 2): ChatMessage => ({ id, role: 'agent', displayText: 'I asked to read your ledger.', access: card }) as ChatMessage;

async function renderChat(messages: ChatMessage[], options: { busy?: boolean; onResolveAccess?: ResolveAccessCard } = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props = { messages, busy: options.busy ?? false, ...(options.onResolveAccess !== undefined ? { onResolveAccess: options.onResolveAccess } : {}) };
  act(() => {
    root!.render(
      <MemoryRouter>
        <ChatLog {...(props as Parameters<typeof ChatLog>[0])} />
      </MemoryRouter>,
    );
  });
  await settle();
}

const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text);
const cardShown = (): boolean => (document.body.textContent ?? '').includes(ACCESS_CARD.lead) && document.body.querySelector('q.access-quote') !== null;

beforeEach(async () => {
  resolved = [];
  await act(async () => {
    resetAccessSession();
    db = await installTestUserDb();
  });
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>', usesDb: true }).appId;
  db.upsertThread(THREAD, { appId: budget });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  await act(async () => {
    resetAccessSession();
  });
  __setAccessDepsForTests();
});

describe('ChatLog mounts the access card under the agent’s message (AC12)', () => {
  it('renders the card for a message carrying access — the lead line and the quoted purpose', async () => {
    await renderChat([{ id: 1, role: 'user', displayText: 'compare this with my ledger' }, message(stagedCard())]);
    expect(cardShown()).toBe(true);
    expect(document.body.querySelector('q.access-quote')?.textContent).toContain(PURPOSE);
  });

  it('no access on the message, no card', async () => {
    await renderChat([{ id: 1, role: 'user', displayText: 'hi' }, { id: 2, role: 'agent', displayText: 'hello' }]);
    expect(cardShown()).toBe(false);
    expect(buttonNamed(ACCESS_CARD.review)).toBeUndefined();
  });

  it('threads onResolveAccess through with the MESSAGE’s id', async () => {
    const card = stagedCard();
    await renderChat([{ id: 1, role: 'user', displayText: 'compare this with my ledger' }, message(card, 2)], { onResolveAccess: record });
    await act(async () => {
      buttonNamed(ACCESS_CARD.notNow)!.click();
    });
    await settle();
    expect(resolved).toEqual([{ card: expect.objectContaining({ threadId: THREAD, messageRowId: card.messageRowId }), messageId: 2, resolution: { kind: 'not-now' } }]);
  });

  it('without the prop the card’s acts wait — ChatLog never invents a persist path', async () => {
    await renderChat([message(stagedCard())]);
    expect(buttonNamed(ACCESS_CARD.review)?.disabled).toBe(true);
    expect(buttonNamed(ACCESS_CARD.notNow)?.disabled).toBe(true);
  });

  it('the acts wait while the turn is busy', async () => {
    await renderChat([message(stagedCard())], { busy: true, onResolveAccess: record });
    expect(buttonNamed(ACCESS_CARD.review)?.disabled).toBe(true);
    expect(buttonNamed(ACCESS_CARD.notNow)?.disabled).toBe(true);
  });

  it('is gated on allows("access") — ChatLog renders no card where the host has no access between apps', async () => {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, access: false } });
    const helper = await import('./userdbTestHelper.js');
    const fresh = await helper.installTestUserDb();
    const id = fresh.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    fresh.upsertThread(THREAD, { appId: id });
    const { ChatLog: FreshChatLog } = await import('../views/ChatLog.js');
    const { stageAccessCard: stage } = await import('../agent/accessCard.js');
    const { ACCESS_CARD: FRESH_CARD } = await import('../access/copy.js');
    const card = stage({ purpose: PURPOSE }, { appId: id, threadId: THREAD });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <FreshChatLog {...({ messages: [{ id: 2, role: 'agent', displayText: 'hi', access: card }] } as Parameters<typeof FreshChatLog>[0])} />
        </MemoryRouter>,
      );
    });
    await settle();
    expect(typeof FRESH_CARD.lead).toBe('string');
    expect(document.body.textContent).not.toContain(FRESH_CARD.lead);
    expect(document.body.querySelector('q.access-quote')).toBeNull();
  });
});

// ------------------------------------------------------------------------------- the source pin

/** Comments out, so a note that mentions a prop is not mistaken for passing it. */
const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const count = (code: string, pattern: RegExp): number => (code.match(pattern) ?? []).length;

describe('S-F11 — both chats pass onResolveAccess wherever they pass onResolveSchedule', () => {
  for (const rel of [path.join('run', 'RunView.tsx'), path.join('views', 'BuilderView.tsx')]) {
    it(`${rel}: every onResolveSchedule has its onResolveAccess twin`, () => {
      const code = stripComments(readFileSync(path.join(SRC, rel), 'utf8'));
      const schedule = count(code, /\bonResolveSchedule\b/g);
      expect(schedule, `${rel} still passes the schedule card's resolve path (the pin's anchor)`).toBeGreaterThan(0);
      expect(count(code, /\bonResolveAccess\b/g), `${rel}: one onResolveAccess per onResolveSchedule`).toBe(schedule);
      // The hook's resolve reaches the prop at every place the schedule's does.
      const scheduleFromHook = count(code, /onResolveSchedule=\{\s*chat\.resolveSchedule\s*\}/g);
      expect(count(code, /onResolveAccess=\{\s*chat\.resolveAccess\s*\}/g), `${rel}: chat.resolveAccess wired beside chat.resolveSchedule`).toBe(scheduleFromHook);
      // A prop threaded through (RunView's RailChat) is forwarded to ChatLog the same way.
      const forwardedSchedule = count(code, /\{\.\.\.\(onResolveSchedule !== undefined \? \{ onResolveSchedule \} : \{\}\)\}/g);
      expect(count(code, /onResolveAccess !== undefined \? \{ onResolveAccess \}/g), `${rel}: the forward to ChatLog`).toBe(forwardedSchedule);
    });
  }

  it('the pin can fail: a file with the schedule prop and no access prop reds', () => {
    const planted = `<ChatLog onResolveSchedule={chat.resolveSchedule} />`;
    expect(count(stripComments(planted), /\bonResolveSchedule\b/g)).toBe(1);
    expect(count(stripComments(planted), /\bonResolveAccess\b/g)).toBe(0);
    // and a comment naming the access prop does not satisfy it
    expect(count(stripComments(`${planted}\n// onResolveAccess={chat.resolveAccess}`), /\bonResolveAccess\b/g)).toBe(0);
  });
});
