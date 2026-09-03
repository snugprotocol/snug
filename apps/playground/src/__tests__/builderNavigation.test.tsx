// builderNavigation.test.tsx — TASK-20260903-build-thread-continuity (ADR-0062).
//
// AC1 — an idea typed on "your apps" starts a build on /build exactly once, on a FRESH
//        thread (never the tab's previous, possibly app-pinned one) — under StrictMode,
//        whose simulated unmount used to fire the hook's abort cleanup and kill the
//        handed-over turn (next-steps 2026-08-06).
// AC2 — leaving /build for "your apps" and coming back keeps the build running: the
//        request's signal is never aborted, the same messages and the live status line
//        are shown on return, and when the stream ends AFTER the return the reply lands
//        and the assistant row (with its artifact meta + bootstrap pin) is persisted.
// AC6 — the round-trip inspector is retained across the navigation and across a thread
//        switch — in memory — and AC14 still holds at the byte level: nothing from it
//        reaches the user DB, localStorage or sessionStorage.

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTurnEvent } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';

import { dispatchLlmEvent, resetThreadSessions } from '../agent/threadSessions.js';
import { activeBuildThreadStore, setActiveBuildThread } from '../state/buildThread.js';
import { modeStore } from '../state/mode.js';
import { BuilderView } from '../views/BuilderView.js';
import { HubView } from '../views/HubView.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_HTML = '<!DOCTYPE html><html><head><title>Haiku Machine</title></head><body></body></html>';
/** A marker that only ever exists inside round-trip request/response bodies. */
const MARKER = 'ZZNAVTRIPMARKERZZ';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

interface Mounted {
  el: HTMLDivElement;
  navigate: (to: string) => void;
}

/** The two routes under test plus a probe that hands the test the router's navigate. */
function mountApp(initial: string, opts: { strict?: boolean } = {}): Mounted {
  let nav: NavigateFunction | undefined;
  function NavProbe(): null {
    nav = useNavigate();
    return null;
  }
  const tree = (
    <MemoryRouter initialEntries={[initial]}>
      <NavProbe />
      <Routes>
        <Route path="/" element={<HubView />} />
        <Route path="/build" element={<BuilderView />} />
      </Routes>
    </MemoryRouter>
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(opts.strict === true ? <StrictMode>{tree}</StrictMode> : (tree as ReactElement));
  });
  return {
    el: container,
    navigate: (to) => {
      if (nav === undefined) throw new Error('navigate not captured');
      const go = nav;
      act(() => go(to));
    },
  };
}

async function settle(ms = 5): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function sseResponse(blocks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function typeInComposer(el: HTMLElement, text: string): void {
  const textarea = el.querySelector('textarea');
  if (textarea === null) throw new Error('no composer on this page');
  setInputValue(textarea, text);
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

const chatText = (el: HTMLElement): string => el.querySelector('.chat-log')?.textContent ?? '';
const roundTrips = (el: HTMLElement): number => el.querySelectorAll('[data-testid="llm-round-trip"]').length;

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  db = await installTestUserDb();
  resetThreadSessions();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  resetThreadSessions();
  vi.restoreAllMocks();
});

describe('hub → build handoff (AC1)', () => {
  it('sends the idea exactly once, on a FRESH thread, under StrictMode', async () => {
    // The tab already holds a thread pinned to an app: continuing it would turn a new
    // idea into an EDIT of that app.
    const appId = db.installApp({ displayName: 'Pocket Ledger', html: APP_HTML }).appId;
    db.upsertThread('thr-old', { appId });
    db.appendChatMessage('thr-old', 'user', 'earlier build');
    setActiveBuildThread('thr-old');

    const invokes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/invoke') {
        invokes.push((JSON.parse(String(init?.body)) as { threadId: string }).threadId);
        return sseResponse(['event: done\ndata: {"text":"a chess coach, coming up"}\n\n']);
      }
      return new Response('', { status: 404 });
    });

    const { el } = mountApp('/', { strict: true });
    await settle();
    const input = el.querySelector<HTMLInputElement>('input[aria-label="describe the app to build"]');
    expect(input).not.toBeNull();
    setInputValue(input!, 'a chess coach');
    act(() => el.querySelector<HTMLButtonElement>('.create-bar button')?.click());
    await settle(20);

    expect(invokes, 'the handed-over idea must be sent exactly once').toHaveLength(1);
    expect(invokes[0]?.startsWith('thr-')).toBe(true);
    expect(invokes[0], 'the hub must mint a fresh thread, not continue the pinned one').not.toBe('thr-old');
    expect(activeBuildThreadStore.get()).toBe(invokes[0]);
    expect(chatText(el)).toContain('a chess coach');
    expect(chatText(el)).toContain('coming up');
    expect(db.listChatMessages('thr-old'), 'the old thread is untouched').toHaveLength(1);
    expect(db.listChatMessages(invokes[0]!).map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('navigation never aborts a turn (AC2)', () => {
  it('leave /build, come back: still building; the reply and its artifact land after the return', async () => {
    let signal: AbortSignal | undefined;
    let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/invoke') {
        signal = init?.signal ?? undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            feed = controller;
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/artifacts/srv-haiku') return new Response(APP_HTML, { status: 200 });
      return new Response('', { status: 404 });
    });

    const { el, navigate } = mountApp('/build');
    await settle();
    typeInComposer(el, 'a haiku machine');
    await settle();
    const threadId = activeBuildThreadStore.get();
    expect(signal, 'the turn started').toBeDefined();
    expect(el.querySelector('[data-testid="status-line"]')).not.toBeNull();

    navigate('/');
    await settle();
    expect(el.querySelector('.builder'), 'we really left the build page').toBeNull();
    expect(signal?.aborted, 'leaving the page must not abort the build').toBe(false);

    navigate('/build');
    await settle();
    expect(chatText(el)).toContain('a haiku machine');
    expect(el.querySelector('[data-testid="status-line"]'), 'the turn is still visibly in flight').not.toBeNull();
    expect(signal?.aborted).toBe(false);

    // The stream ends AFTER the return — the client-authoritative artifact write and the
    // bootstrap pin must still happen, exactly as if nobody had left.
    act(() => {
      const enc = new TextEncoder();
      feed?.enqueue(enc.encode('event: artifact\ndata: {"artifactId":"srv-haiku","displayName":"Haiku Machine"}\n\n'));
      feed?.enqueue(enc.encode('event: done\ndata: {"text":"here is your haiku machine"}\n\n'));
      feed?.close();
    });
    await settle(20);

    expect(chatText(el)).toContain('here is your haiku machine');
    expect(el.querySelector('[data-testid="status-line"]')).toBeNull();
    expect(db.listApps(), 'the build installed its app').toHaveLength(1);
    const rows = db.listChatMessages(threadId);
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rows[1]?.pinned, 'the bootstrap turn is pinned').toBe(true);
    expect(rows[1]?.meta, 'the artifact card meta persisted').toMatchObject({ artifact: { appId: db.listApps()[0]!.appId } });
    expect(db.getThread(threadId)?.appId).toBe(db.listApps()[0]!.appId);
  });
});

describe('the audit trail is retained in memory — and only in memory (AC6/AC14)', () => {
  const tripWith = (marker: string): AgentTurnEvent => ({
    type: 'round_trip',
    index: 0,
    request: { system: `system ${marker}`, messages: [{ role: 'user', content: `build ${marker}` }] },
    response: { ok: true, text: `built ${marker}`, toolCalls: [], stopReason: 'end' },
    durationMs: 7,
  });

  it('round trips survive leaving and returning, and still reach no storage', async () => {
    const { el, navigate } = mountApp('/build');
    await settle();
    const threadId = activeBuildThreadStore.get();
    act(() => dispatchLlmEvent(threadId, tripWith(MARKER)));
    expect(roundTrips(el)).toBe(1);

    navigate('/');
    await settle();
    navigate('/build');
    await settle();
    expect(roundTrips(el), 'the inspector must survive the round trip through the hub').toBe(1);
    act(() => el.querySelector<HTMLButtonElement>('.llm-entry-head')?.click());
    expect(el.textContent).toContain(MARKER);

    await db.flush();
    const text = new TextDecoder().decode(await db.exportUserDb({ includeSecrets: true }));
    expect(text).not.toContain(MARKER);
    expect(JSON.stringify(localStorage)).not.toContain(MARKER);
    expect(JSON.stringify(sessionStorage)).not.toContain(MARKER);
  });

  it('each thread keeps its own inspector across a switch in the sidebar', async () => {
    db.upsertThread('thr-a', { title: 'thread a' });
    db.appendChatMessage('thr-a', 'user', 'a');
    db.upsertThread('thr-b', { title: 'thread b' });
    db.appendChatMessage('thr-b', 'user', 'b');
    setActiveBuildThread('thr-a');
    const { el } = mountApp('/build');
    await settle();
    act(() => dispatchLlmEvent('thr-a', tripWith('A-TRIP')));
    expect(roundTrips(el)).toBe(1);

    const open = (label: string): void => {
      const row = [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].find((r) => r.textContent?.includes(label));
      act(() => row?.querySelector<HTMLButtonElement>('[data-testid="thread-open"]')?.click());
    };
    open('thread b');
    await settle();
    expect(roundTrips(el), 'thread b has no round trips of its own').toBe(0);
    open('thread a');
    await settle();
    expect(roundTrips(el), 'thread a’s round trips are still there').toBe(1);
  });
});
