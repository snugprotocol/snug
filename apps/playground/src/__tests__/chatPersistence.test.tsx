// Child-3 ACs 3,4 (TASK-20260803-versions-chat): the thread lives in the user DB —
// a fresh hook over the same DB re-renders the history (AC9) — and subscription mode
// is client-authoritative: the artifact HTML is fetched from the hub cache and written
// into the user DB as a version of the pinned target (umbrella AC13).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuilderChat, type BuilderChat, type UseBuilderChatOptions } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_HTML = '<!DOCTYPE html><html><head><title>Tic Tac Toe</title></head><body></body></html>';

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

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderChat(threadId: string, options?: UseBuilderChatOptions): { chat: () => BuilderChat; unmount: () => void } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat(threadId, options);
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

beforeEach(() => {
  modeStore.set('subscription');
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('chat persistence (AC9)', () => {
  it('persists user + assistant messages and re-renders them in a fresh hook', async () => {
    const db = await installTestUserDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(['event: done\ndata: {"text":"built it"}\n\n']));
    const first = renderChat('builder:persist');
    act(() => {
      first.chat().send('a haiku generator');
    });
    await settle();
    first.unmount();

    const stored = db.listChatMessages('builder:persist');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'a haiku generator'],
      ['assistant', 'built it'],
    ]);

    const second = renderChat('builder:persist');
    await settle();
    expect(second.chat().messages.map((m) => [m.role, m.displayText])).toEqual([
      ['user', 'a haiku generator'],
      ['agent', 'built it'],
    ]);
    second.unmount();
  });
});

describe('subscription mode is client-authoritative (AC13/F4)', () => {
  it('fetches the artifact HTML from the hub cache and versions the pinned app in the user DB', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ appId: 'chess-1', displayName: 'Chess', html: '<html>v1</html>' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/invoke') {
        return sseResponse([
          'event: artifact\ndata: {"artifactId":"srv-9","displayName":"Chess"}\n\n',
          'event: done\ndata: {"text":"updated the board"}\n\n',
        ]);
      }
      if (url === '/artifacts/srv-9') return new Response(APP_HTML, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const r = renderChat('app:chess-1', { pinnedAppId: 'chess-1' });
    act(() => {
      r.chat().send('make it blue');
    });
    await settle();

    // the artifact card points at the USER-DB app, not the server cache id
    expect(r.chat().lastArtifact).toMatchObject({ artifactId: app.appId, version: 2 });
    // and the version really landed in the user DB (portable: export now contains it)
    expect(db.getApp(app.appId)?.currentVersion).toBe(2);
    expect(db.getAppHtml(app.appId)).toBe(APP_HTML);
    r.unmount();
  });
});
