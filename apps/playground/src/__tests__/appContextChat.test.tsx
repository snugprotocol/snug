// Child-3 (TASK-20260803-app-context-chat): the chat attaches to the app.
// AC2 — enhance turns carry the app's code + schema + docs + history (capped, marked).
// AC3 — durable thread→app pin (review F10): a resumed builder thread versions the
//        SAME app instead of installing a duplicate.
// AC4/AC5 — the bootstrap turn is the one that produced v1 (review F9), pinned in the
//        DB even when chatter turns precede the build; artifact cards rehydrate.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAppTurnContext, CONTEXT_CAPS, TRUNCATION_MARKER } from '../agent/appContext.js';
import { createServerBuilder } from '../agent/builder.js';
import { useBuilderChat, type BuilderChat, type UseBuilderChatOptions } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_HTML = '<!DOCTYPE html><html><head><title>Portfolio</title></head><body></body></html>';

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

async function settle(ms = 5): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
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

describe('buildAppTurnContext (AC2)', () => {
  it('includes app identity, schema DDL, docs, code, and capped history', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ appId: 'p-1', displayName: 'Portfolio', html: APP_HTML });
    await db.applyAppDdl('p-1', ['CREATE TABLE trades (id INTEGER PRIMARY KEY, qty REAL)']);
    db.putAppDoc('p-1', 'vision', { content: 'track my equities' });
    db.appendChatMessage('app:p-1', 'user', 'build a portfolio app');
    db.appendChatMessage('app:p-1', 'assistant', 'built it');

    const context = await buildAppTurnContext(db, app.appId, 'app:p-1');
    expect(context.contextBlock).toContain('Name: Portfolio');
    expect(context.contextBlock).toContain('CREATE TABLE trades');
    expect(context.contextBlock).toContain('track my equities');
    expect(context.contextBlock).toContain(APP_HTML);
    expect(context.history).toEqual([
      { role: 'user', content: 'build a portfolio app' },
      { role: 'assistant', content: 'built it' },
    ]);
  });

  it('caps oversized sections with an explicit marker and bounds history', async () => {
    const db = await installTestUserDb();
    const bigHtml = `<!DOCTYPE html><html><body>${'x'.repeat(CONTEXT_CAPS.html + 5_000)}</body></html>`;
    db.installApp({ appId: 'big', displayName: 'Big', html: bigHtml });
    for (let i = 0; i < 50; i++) {
      db.appendChatMessage('app:big', 'user', `message ${i} ${'y'.repeat(400)}`);
    }
    const context = await buildAppTurnContext(db, 'big', 'app:big');
    expect(context.contextBlock).toContain(TRUNCATION_MARKER);
    expect(context.contextBlock!.length).toBeLessThan(CONTEXT_CAPS.html + 40_000);
    const historyBytes = context.history.reduce((sum, m) => sum + m.content.length, 0);
    expect(historyBytes).toBeLessThanOrEqual(CONTEXT_CAPS.history);
    // newest survive, chronological order preserved
    expect(context.history.at(-1)?.content).toContain('message 49');
  });

  it('yields history-only for an unattached thread', async () => {
    const db = await installTestUserDb();
    db.appendChatMessage('thr-fresh', 'user', 'hello');
    const context = await buildAppTurnContext(db, undefined, 'thr-fresh');
    expect(context.contextBlock).toBeUndefined();
    expect(context.history).toHaveLength(1);
  });
});

describe('context reaches the wire (AC2)', () => {
  it('subscription mode prepends the context block to the /invoke message', async () => {
    const fetchSpy = vi.fn(async () => sseResponse(['event: done\ndata: {"text":"ok"}\n\n']));
    const builder = createServerBuilder('thr-1', fetchSpy);
    await builder.send(
      { message: 'add a fee column', contextBlock: '## The app you are working on\nName: Portfolio' },
      {},
      new AbortController().signal,
    );
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { message: string };
    expect(body.message).toContain('Name: Portfolio');
    expect(body.message.endsWith('add a fee column')).toBe(true);
  });

  it('an enhance turn from a pinned chat carries the app code + schema on the wire', async () => {
    const db = await installTestUserDb();
    db.installApp({ appId: 'p-1', displayName: 'Portfolio', html: APP_HTML });
    await db.applyAppDdl('p-1', ['CREATE TABLE trades (id INTEGER PRIMARY KEY)']);
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/invoke') {
        bodies.push(String(init?.body));
        return sseResponse(['event: done\ndata: {"text":"done"}\n\n']);
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    const r = renderChat('app:p-1', { pinnedAppId: 'p-1' });
    await settle();
    act(() => {
      r.chat().send('add a fee column to trades');
    });
    await settle();
    const sent = JSON.parse(bodies[0]!) as { message: string };
    expect(sent.message).toContain(APP_HTML);
    expect(sent.message).toContain('CREATE TABLE trades');
    r.unmount();
  });
});

describe('durable thread→app pin (AC3, review F10)', () => {
  it('a resumed builder thread versions the SAME app — no duplicate install', async () => {
    const db = await installTestUserDb();
    let artifactSeq = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/invoke') {
        artifactSeq += 1;
        return sseResponse([
          `event: artifact\ndata: {"artifactId":"srv-${artifactSeq}","displayName":"Portfolio"}\n\n`,
          'event: done\ndata: {"text":"done"}\n\n',
        ]);
      }
      if (url.startsWith('/artifacts/')) return new Response(APP_HTML, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const first = renderChat('thr-resume');
    await settle();
    act(() => {
      first.chat().send('build a portfolio app');
    });
    await settle(20);
    const installedId = db.listApps()[0]?.appId;
    expect(installedId).toBeDefined();
    expect(db.getThread('thr-resume')?.appId).toBe(installedId);
    first.unmount();

    // "new session": fresh hook over the same thread id
    const second = renderChat('thr-resume');
    await settle();
    expect(second.chat().attachedAppId).toBe(installedId);
    act(() => {
      second.chat().send('now add dark mode');
    });
    await settle(20);
    expect(db.listApps()).toHaveLength(1);
    expect(db.getApp(installedId!)?.currentVersion).toBe(2);
    second.unmount();
  });
});

describe('bootstrap pinning (AC4/AC5, review F9)', () => {
  it('pins the v1-artifact turn even when chatter precedes the build; cards rehydrate from meta', async () => {
    const db = await installTestUserDb();
    let turn = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/invoke') {
        turn += 1;
        if (turn === 1) return sseResponse(['event: done\ndata: {"text":"sounds good — what should it track?"}\n\n']);
        return sseResponse([
          'event: artifact\ndata: {"artifactId":"srv-9","displayName":"Portfolio"}\n\n',
          'event: done\ndata: {"text":"built it"}\n\n',
        ]);
      }
      if (url.startsWith('/artifacts/')) return new Response(APP_HTML, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const r = renderChat('thr-boot');
    await settle();
    act(() => {
      r.chat().send('I want a portfolio app'); // chatter turn — NOT the bootstrap
    });
    await settle(20);
    act(() => {
      r.chat().send('ok build it'); // the v1-artifact turn — THE bootstrap
    });
    await settle(20);

    const stored = db.listChatMessages('thr-boot');
    expect(stored.map((m) => [m.role, m.pinned])).toEqual([
      ['user', false],
      ['assistant', false],
      ['user', true],
      ['assistant', true],
    ]);
    const withMeta = stored.find((m) => m.meta !== undefined);
    expect(withMeta?.role).toBe('assistant');
    r.unmount();

    // pruning can never remove the bootstrap
    db.pruneChatMessages('thr-boot', 0);
    expect(db.listChatMessages('thr-boot')).toHaveLength(2);

    // rehydration renders the artifact card from meta
    const again = renderChat('thr-boot');
    await settle();
    const card = again.chat().messages.find((m) => m.artifact !== undefined);
    expect(card?.artifact?.displayName).toBe('Portfolio');
    expect(card?.artifact?.version).toBe(1);
    again.unmount();
  });
});
