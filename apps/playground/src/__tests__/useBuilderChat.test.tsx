// useBuilderChat — Gate-5 review fixes:
//   1. displayText/wireText split: the bubble renders the raw user idea, while the
//      KB-templated wire text is what actually reaches the transport.
//   8. a `done` SSE event with empty/missing text falls back to the accumulated deltas
//      instead of wiping the streamed reply.
//   9. unmounting mid-turn does NOT abort the in-flight request (inverted by ADR-0062 —
//      the turn belongs to the thread session; only an explicit stop aborts).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stopThread } from '../agent/threadSessions.js';
import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

interface Rendered {
  chat: () => BuilderChat;
  unmount: () => void;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderChat(): Rendered {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat('thr-test');
    return <span />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return {
    chat: () => {
      if (holder.current === null) throw new Error('hook not rendered');
      return holder.current;
    },
    unmount: () => {
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    },
  };
}

async function settle(): Promise<void> {
  // Drain the microtask/stream queue inside act so state updates land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  // These are subscription-mode SSE tests — the default is the serverless byok mode.
  modeStore.set('subscription');
  // The hook persists chat into the page user DB — inject a memory one.
  await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('useBuilderChat (server mode)', () => {
  it('renders displayText in the user bubble while wireText goes to the transport (fix 1)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(sseResponse(['event: done\ndata: {"text":"built it"}\n\n']));
    const r = renderChat();
    act(() => {
      r.chat().send('a haiku generator', 'Build me a Snug app: a haiku generator — consult the KB first.');
    });
    await settle();

    const user = r.chat().messages.find((m) => m.role === 'user');
    expect(user?.displayText).toBe('a haiku generator');
    expect(user?.wireText).toBe('Build me a Snug app: a haiku generator — consult the KB first.');

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: 'Build me a Snug app: a haiku generator — consult the KB first.',
    });
  });

  it('wireText defaults to displayText when no template applies', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(sseResponse(['event: done\ndata: {"text":"ok"}\n\n']));
    const r = renderChat();
    act(() => {
      r.chat().send('make the board bigger');
    });
    await settle();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ message: 'make the board bigger' });
  });

  it('falls back to the accumulated deltas when done carries empty text (fix 8)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'event: delta\ndata: {"text":"hel"}\n\n',
        'event: delta\ndata: {"text":"lo there"}\n\n',
        'event: done\ndata: {}\n\n', // missing text — must NOT wipe the streamed reply
      ]),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('hi');
    });
    await settle();
    const agent = r.chat().messages.find((m) => m.role === 'agent');
    expect(agent?.streaming).toBe(false);
    expect(agent?.displayText).toBe('hello there');
  });

  it('still prefers the done text when it is non-empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse(['event: delta\ndata: {"text":"partial"}\n\n', 'event: done\ndata: {"text":"the full reply"}\n\n']),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('hi');
    });
    await settle();
    const agent = r.chat().messages.find((m) => m.role === 'agent');
    expect(agent?.displayText).toBe('the full reply');
  });

  /**
   * INVERTED by ADR-0062 (TASK-20260903-build-thread-continuity). Fix 9 used to abort the
   * turn on unmount ("never leave a request running headless"); React Router unmounts the
   * view on every route change, so leaving /build for "your apps" killed a 30-minute build.
   * A turn now belongs to its THREAD SESSION, which outlives every view — the only abort
   * is the user's explicit stop (or a user-DB swap seam).
   */
  it('keeps the in-flight turn alive on unmount — stop is the only abort (ADR-0062)', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('hi');
    });
    await settle();
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(false);
    r.unmount();
    await settle();
    expect(seenSignal?.aborted, 'leaving the view must NOT abort the turn').toBe(false);
    stopThread('thr-test');
    expect(seenSignal?.aborted, 'an explicit stop still aborts it').toBe(true);
  });
});
