// threadSessions.test.tsx — TASK-20260903-build-thread-continuity (ADR-0062).
//
// A turn belongs to its THREAD SESSION — a module-level registry that outlives every
// view — not to the component that started it. Before this, useBuilderChat kept the
// whole turn in component state and aborted it on unmount, so leaving /build for
// "your apps" killed a 30-minute build.
//
// AC2 (hook level) — unmounting keeps the stream alive; a remount shows the live turn,
//        then the reply; the assistant row is persisted when the stream ends.
// AC3 — stop aborts exactly its own thread.
// AC4 — two threads stream at once, each with its own state.
// AC7 — idle sessions are evicted LRU beyond MAX_IDLE_SESSIONS; a busy one never is.
// AC8 — the swap seams reset the registry (abort + drop) and a wiped session stays
//        wiped: import (afterForeignBytes) and app delete (library.delete) are the two
//        seams reachable from a healthy DB; restore/recover-fresh share the same call.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import {
  MAX_IDLE_SESSIONS,
  getThreadSession,
  listBusyThreads,
  patchThreadSession,
  peekThreadSession,
  resetThreadSessions,
  stopThread,
} from '../agent/threadSessions.js';
import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { userLibrary } from '../state/library.js';
import { modeStore } from '../state/mode.js';
import { importUserFile } from '../state/sync.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HTML = '<!DOCTYPE html><html><body>ledger</body></html>';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

interface Rendered {
  chat: (threadId: string) => BuilderChat;
  unmount: () => void;
}

/** Mount one hook per thread id in a single tree — the parallel-threads harness. */
function renderChats(threadIds: string[]): Rendered {
  const holders = new Map<string, BuilderChat>();
  function Probe({ id }: { id: string }): ReactElement {
    holders.set(id, useBuilderChat(id));
    return <span />;
  }
  function Harness(): ReactElement {
    return (
      <>
        {threadIds.map((id) => (
          <Probe key={id} id={id} />
        ))}
      </>
    );
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return {
    chat: (threadId) => {
      const chat = holders.get(threadId);
      if (chat === undefined) throw new Error(`hook for ${threadId} not rendered`);
      return chat;
    },
    unmount: () => {
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    },
  };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** One captured /invoke call: which thread asked, its signal, and (if streaming) its feed. */
interface Captured {
  threadId: string;
  signal: AbortSignal | undefined;
  controller?: ReadableStreamDefaultController<Uint8Array>;
}
let captured: Captured[] = [];

const captureFor = (threadId: string): Captured => {
  const hit = captured.find((c) => c.threadId === threadId);
  if (hit === undefined) throw new Error(`no /invoke seen for ${threadId}`);
  return hit;
};

/** /invoke never resolves; the promise rejects on abort — the stop/abort harness. */
function hangingFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const body = JSON.parse(String(init?.body)) as { threadId?: string };
        captured.push({ threadId: body.threadId ?? '?', signal: init?.signal ?? undefined });
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
}

/** /invoke resolves at once with an OPEN SSE stream the test finishes later. */
function streamingFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { threadId?: string };
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    captured.push({ threadId: body.threadId ?? '?', signal: init?.signal ?? undefined, controller });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

function finish(threadId: string, text: string): void {
  const hit = captureFor(threadId);
  if (hit.controller === undefined) throw new Error('not a streaming capture');
  hit.controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ text })}\n\n`));
  hit.controller.close();
}

beforeEach(async () => {
  captured = [];
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

describe('the turn outlives the view (AC2, hook level)', () => {
  it('keeps streaming after unmount; a remount shows the live turn, then the reply; the row persists', async () => {
    streamingFetch();
    const first = renderChats(['thr-a']);
    act(() => first.chat('thr-a').send('build me a haiku machine'));
    await settle();
    expect(captured).toHaveLength(1);

    first.unmount();
    await settle();
    expect(captureFor('thr-a').signal?.aborted, 'unmount must not abort the turn').toBe(false);
    expect(listBusyThreads()).toEqual(['thr-a']);

    // Coming back mid-stream: the same in-flight turn, not an empty hydration.
    const second = renderChats(['thr-a']);
    await settle();
    expect(second.chat('thr-a').busy).toBe(true);
    expect(second.chat('thr-a').messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(second.chat('thr-a').messages[0]?.displayText).toBe('build me a haiku machine');

    finish('thr-a', 'here is your haiku machine');
    await settle(10);
    expect(second.chat('thr-a').busy).toBe(false);
    expect(second.chat('thr-a').messages.find((m) => m.role === 'agent')?.displayText).toBe('here is your haiku machine');
    expect(db.listChatMessages('thr-a').map((m) => [m.role, m.content])).toEqual([
      ['user', 'build me a haiku machine'],
      ['assistant', 'here is your haiku machine'],
    ]);
    expect(listBusyThreads()).toEqual([]);
  });

  it('a stream that ends while NO view is mounted still persists the reply', async () => {
    streamingFetch();
    const r = renderChats(['thr-a']);
    act(() => r.chat('thr-a').send('build me a haiku machine'));
    await settle();
    r.unmount();

    finish('thr-a', 'built while you were away');
    await settle(10);

    expect(db.listChatMessages('thr-a').map((m) => m.content)).toEqual([
      'build me a haiku machine',
      'built while you were away',
    ]);
    const again = renderChats(['thr-a']);
    await settle();
    expect(again.chat('thr-a').messages.find((m) => m.role === 'agent')?.displayText).toBe('built while you were away');
  });
});

describe('parallel threads (AC3/AC4)', () => {
  it('two threads stream at once with independent state; stop aborts only its own', async () => {
    hangingFetch();
    const r = renderChats(['thr-a', 'thr-b']);
    act(() => r.chat('thr-a').send('first idea'));
    await settle();
    act(() => r.chat('thr-b').send('second idea'));
    await settle();

    expect(r.chat('thr-a').busy).toBe(true);
    expect(r.chat('thr-b').busy).toBe(true);
    expect(listBusyThreads().sort()).toEqual(['thr-a', 'thr-b']);
    expect(r.chat('thr-a').messages[0]?.displayText).toBe('first idea');
    expect(r.chat('thr-b').messages[0]?.displayText).toBe('second idea');
    expect(r.chat('thr-a').messages).toHaveLength(2);

    act(() => r.chat('thr-a').stop());
    await settle();
    expect(captureFor('thr-a').signal?.aborted).toBe(true);
    expect(captureFor('thr-b').signal?.aborted, 'stop must not reach the other thread').toBe(false);
    expect(r.chat('thr-a').busy).toBe(false);
    expect(r.chat('thr-b').busy).toBe(true);

    // The module-level stop is the same affordance the sidebar's badge will use.
    stopThread('thr-b');
    await settle();
    expect(captureFor('thr-b').signal?.aborted).toBe(true);
    expect(listBusyThreads()).toEqual([]);
  });
});

describe('memory stays bounded (AC7)', () => {
  it('evicts idle sessions LRU beyond MAX_IDLE_SESSIONS, never a busy one', () => {
    for (let i = 0; i < MAX_IDLE_SESSIONS; i++) getThreadSession(`thr-idle-${i}`);
    // The OLDEST session is busy — it must survive every eviction below.
    patchThreadSession('thr-idle-0', { busy: true });
    getThreadSession('thr-extra-1');
    expect(peekThreadSession('thr-idle-1'), 'exactly MAX idle sessions is within budget').toBeDefined();
    getThreadSession('thr-extra-2');
    expect(peekThreadSession('thr-idle-0'), 'a busy session is never evicted').toBeDefined();
    expect(peekThreadSession('thr-idle-1'), 'the oldest IDLE session is the one evicted').toBeUndefined();
    expect(peekThreadSession('thr-idle-2')).toBeDefined();
    expect(peekThreadSession('thr-extra-2')).toBeDefined();
  });

  it('reading a session refreshes its recency', () => {
    for (let i = 0; i < MAX_IDLE_SESSIONS; i++) getThreadSession(`thr-idle-${i}`);
    getThreadSession('thr-idle-0'); // touched: now the newest
    getThreadSession('thr-extra-1');
    expect(peekThreadSession('thr-idle-0')).toBeDefined();
    expect(peekThreadSession('thr-idle-1')).toBeUndefined();
  });
});

describe('swap seams reset the registry (AC8)', () => {
  it('resetThreadSessions aborts in-flight turns, drops the session, and a remount starts clean', async () => {
    hangingFetch();
    const r = renderChats(['thr-a']);
    act(() => r.chat('thr-a').send('build'));
    await settle();
    expect(peekThreadSession('thr-a')?.store.get().busy).toBe(true);

    act(() => resetThreadSessions());
    expect(captureFor('thr-a').signal?.aborted, 'a swap aborts the turn').toBe(true);
    await settle();
    // The mounted hook re-resolves a FRESH session: not busy, no streaming placeholder.
    expect(r.chat('thr-a').busy).toBe(false);
    expect(r.chat('thr-a').messages.some((m) => m.streaming === true)).toBe(false);
  });

  it('resetThreadSessions({ appId }) drops only the sessions pinned to that app', () => {
    getThreadSession('thr-x');
    patchThreadSession('thr-x', { threadAppId: 'app-1' });
    getThreadSession('thr-y');
    resetThreadSessions({ appId: 'app-1' });
    expect(peekThreadSession('thr-x')).toBeUndefined();
    expect(peekThreadSession('thr-y')).toBeDefined();
  });

  it('importing a user file resets the registry (seam: afterForeignBytes)', async () => {
    getThreadSession('thr-x');
    await db.flush();
    const bytes = await db.exportUserDb();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await importUserFile({ arrayBuffer: async () => copy.buffer });
    expect(peekThreadSession('thr-x')).toBeUndefined();
  });

  it('deleting an app drops the sessions pinned to it and no other (seam: library.delete)', async () => {
    const app = db.installApp({ displayName: 'Pocket Ledger', html: HTML });
    getThreadSession('thr-x');
    patchThreadSession('thr-x', { threadAppId: app.appId });
    getThreadSession('thr-y');
    await userLibrary().delete(app.appId);
    expect(peekThreadSession('thr-x')).toBeUndefined();
    expect(peekThreadSession('thr-y')).toBeDefined();
  });
});
