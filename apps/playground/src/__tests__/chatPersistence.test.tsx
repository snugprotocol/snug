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

/**
 * R-M5 (2026-08-11): a staged write proposal lived in React state only, so a reload left
 * the assistant's persisted "waiting for your approval" text with no card and no route
 * back to it — the chat making a durable claim the UI could not honor.
 *
 * Persisting it needs a staleness rule, which is why it was queued rather than rushed: the
 * preview was computed against data that may have moved. The rule here is to rehydrate the
 * card only as an UNRESOLVED proposal and let the existing execute-time drift guard do the
 * deciding — the counts are re-validated against live data at approve, and a proposal whose
 * data moved halts there exactly as it would have without a reload.
 */
describe('R-M5 — a staged write proposal survives a reload', () => {
  const PROPOSAL = {
    appId: 'app-1',
    statements: ["INSERT INTO expenses (label, cents) VALUES ('lunch', 1240)"],
    params: [[]],
    summary: 'Add a £12.40 lunch',
    previewed: [1],
  };

  it('rehydrates the approval card from the persisted message', async () => {
    const db = await installTestUserDb();
    db.upsertThread('app:m5', { appId: 'app-1' });
    db.appendChatMessage('app:m5', 'user', 'add a lunch expense');
    db.appendChatMessage('app:m5', 'assistant', 'I have proposed a change; it is waiting for your approval.', {
      meta: { dataWrite: PROPOSAL },
    });

    const chat = renderChat('app:m5');
    await settle();

    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite;
    expect(card, 'the card the assistant text promises must come back').toBeDefined();
    expect(card?.statements).toEqual(PROPOSAL.statements);
    expect(card?.summary).toBe(PROPOSAL.summary);
    expect(card?.outcome, 'it comes back UNRESOLVED — still awaiting approval').toBeUndefined();
    chat.unmount();
  });

  it('rehydrates a RESOLVED proposal as settled, so an applied change cannot be re-applied', async () => {
    const db = await installTestUserDb();
    db.upsertThread('app:m5b', { appId: 'app-1' });
    db.appendChatMessage('app:m5b', 'assistant', 'Applied.', {
      meta: { dataWrite: { ...PROPOSAL, outcome: 'applied', executed: [1] } },
    });

    const chat = renderChat('app:m5b');
    await settle();

    expect(chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite?.outcome).toBe('applied');
    chat.unmount();
  });

  it('persists the RESOLUTION, so an applied change is not re-offered after a reload', async () => {
    const db = await installTestUserDb();
    db.upsertThread('app:m5d', { appId: 'app-1' });
    const row = db.appendChatMessage('app:m5d', 'assistant', 'waiting', {
      meta: { dataWrite: PROPOSAL },
    });

    const chat = renderChat('app:m5d');
    await settle();
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)!;
    act(() => chat.chat().declineDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    chat.unmount();

    // A SECOND mount reads only what the DB holds — the true reload oracle.
    const reloaded = renderChat('app:m5d');
    await settle();
    expect(
      reloaded.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite?.outcome,
      'the decline must survive the reload',
    ).toBe('declined');
    reloaded.unmount();
  });

  it('keeps a co-existing artifact card when a data write resolves', async () => {
    // `updateChatMessageMeta` replaces the whole meta blob, so resolving a proposal must
    // MERGE rather than overwrite — one message can carry both cards.
    const db = await installTestUserDb();
    db.upsertThread('app:m5e', { appId: 'app-1' });
    const row = db.appendChatMessage('app:m5e', 'assistant', 'built and proposed', {
      meta: { artifact: { appId: 'app-1', displayName: 'Ledger', version: 2 }, dataWrite: PROPOSAL },
    });

    const chat = renderChat('app:m5e');
    await settle();
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)!;
    act(() => chat.chat().declineDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    chat.unmount();

    const reloaded = renderChat('app:m5e');
    await settle();
    const message = reloaded.chat().messages.find((m) => m.dataWrite !== undefined);
    expect(message?.artifact, 'the artifact card must not be collateral damage').toBeDefined();
    expect(message?.dataWrite?.outcome).toBe('declined');
    reloaded.unmount();
  });

  it('drops a structurally invalid persisted proposal rather than rendering a broken card', async () => {
    // Same rule the artifact and directive seats follow: re-validated on every read, so an
    // imported or corrupted row renders as no card at all rather than a card that lies.
    const db = await installTestUserDb();
    db.upsertThread('app:m5c', { appId: 'app-1' });
    db.appendChatMessage('app:m5c', 'assistant', 'waiting', {
      meta: { dataWrite: { appId: 'app-1', summary: 'no statements' } },
    });

    const chat = renderChat('app:m5c');
    await settle();

    expect(chat.chat().messages.find((m) => m.dataWrite !== undefined)).toBeUndefined();
    chat.unmount();
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
