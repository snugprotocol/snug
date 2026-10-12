// Child-3 ACs 3,4 (TASK-20260803-versions-chat): the thread lives in the user DB —
// a fresh hook over the same DB re-renders the history (AC9) — and subscription mode
// is client-authoritative: the artifact HTML is fetched from the hub cache and written
// into the user DB as a version of the pinned target (umbrella AC13).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeApprovedWrite } from '../agent/dataTools.js';
import { useBuilderChat, type BuilderChat, type UseBuilderChatOptions } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// TASK-20261010-host-broker PR-4 (AC32a / D-PR4-6): `approveDataWrite`'s one call into the engine is
// observed through a pass-through mock — by default it IS the real `executeApprovedWrite`, so every
// row above the PR-4 describe runs exactly as before; the PR-4 rows script its answer.
vi.mock('../agent/dataTools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/dataTools.js')>();
  return { ...actual, executeApprovedWrite: vi.fn(actual.executeApprovedWrite) };
});

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

// ================================================================================================
// TASK-20261010-host-broker PR-4 — approveDataWrite (AC32a: characterised FIRST, green before
// D-PR4-6 changes its path) and the card's trust belt (D-PR4-6 / D-PR4-12).
// ================================================================================================

const executeSpy = vi.mocked(executeApprovedWrite);
type ApprovedOutcome = Awaited<ReturnType<typeof executeApprovedWrite>>;
const UNDO_ID = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b';

describe('PR-4 AC32a — approveDataWrite, characterised before D-PR4-6 changes its path', () => {
  const PROPOSAL = {
    appId: 'app-1',
    statements: ["INSERT INTO expenses (label, cents) VALUES ('lunch', 1240)"],
    params: [[]],
    summary: 'Add a £12.40 lunch',
    previewed: [1],
  };

  beforeEach(() => {
    executeSpy.mockReset();
  });

  async function staged(threadId: string, meta: Record<string, unknown> = { dataWrite: PROPOSAL }) {
    const db = await installTestUserDb();
    db.upsertThread(threadId, { appId: 'app-1' });
    const row = db.appendChatMessage(threadId, 'assistant', 'waiting for your approval', { meta });
    const chat = renderChat(threadId);
    await settle();
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)!;
    return { db, row, chat, card };
  }

  it('the double-click guard: two approvals of one card inside the await window reach executeApprovedWrite ONCE', async () => {
    executeSpy.mockResolvedValue({ ok: true, executed: [1] } as ApprovedOutcome);
    const { row, chat, card } = await staged('app:aw1');
    act(() => {
      chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id);
      chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id);
    });
    await settle();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]![1]).toMatchObject({ appId: 'app-1', statements: PROPOSAL.statements, previewed: [1] });
    chat.unmount();
  });

  it.each([
    ['applied', { ok: true, executed: [1] }, { outcome: 'applied', executed: [1] }],
    ['drifted', { ok: false, reason: 'drifted', previewed: [1], current: [2] }, { outcome: 'drifted' }],
    ['failed', { ok: false, reason: 'failed', message: 'no such table' }, { outcome: 'failed' }],
  ] as const)('the outcome mapping — %s: the live card AND the persisted row carry it', async (_label, answer, expected) => {
    executeSpy.mockResolvedValue(answer as unknown as ApprovedOutcome);
    const { db, row, chat, card } = await staged(`app:aw-${_label}`);
    act(() => chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    expect(chat.chat().messages.find((m) => m.id === card.id)?.dataWrite).toMatchObject(expected);
    const stored = db.listChatMessages(`app:aw-${_label}`).find((m) => m.id === row.id)?.meta as { dataWrite?: Record<string, unknown> };
    expect(stored.dataWrite).toMatchObject(expected);
    if (expected.outcome !== 'applied') expect(stored.dataWrite).not.toHaveProperty('executed');
    chat.unmount();
  });

  it('the meta merge: an approval resolves the card and keeps a co-existing artifact card on the same row — after a reload', async () => {
    executeSpy.mockResolvedValue({ ok: true, executed: [1] } as ApprovedOutcome);
    const { row, chat, card } = await staged('app:aw-merge', { artifact: { appId: 'app-1', displayName: 'Ledger', version: 2 }, dataWrite: PROPOSAL });
    act(() => chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    chat.unmount();
    const reloaded = renderChat('app:aw-merge');
    await settle();
    const message = reloaded.chat().messages.find((m) => m.dataWrite !== undefined);
    expect(message?.artifact).toBeDefined();
    expect(message?.dataWrite).toMatchObject({ outcome: 'applied', executed: [1] });
    reloaded.unmount();
  });
});

describe('PR-4 D-PR4-6 / D-PR4-12 — the chat card’s own-app approval and its trust belt', () => {
  const PROPOSAL = {
    appId: 'app-1',
    statements: ["UPDATE expenses SET cents = 1300 WHERE label = 'lunch'"],
    params: [[]],
    summary: 'Fix the lunch',
    previewed: [1],
  };

  beforeEach(() => {
    executeSpy.mockReset();
  });

  async function staged(threadId: string, meta: Record<string, unknown> = { dataWrite: PROPOSAL }, threadApp = 'app-1') {
    const db = await installTestUserDb();
    db.upsertThread(threadId, { appId: threadApp });
    const row = db.appendChatMessage(threadId, 'assistant', 'waiting for your approval', { meta });
    const chat = renderChat(threadId);
    await settle();
    return { db, row, chat };
  }

  it('approveDataWrite passes { via: chat } — the approval journals as the chat’s', async () => {
    executeSpy.mockResolvedValue({ ok: true, executed: [1] } as ApprovedOutcome);
    const { row, chat } = await staged('app:pv1');
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)!;
    act(() => chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]![2]).toEqual({ via: 'chat' });
    chat.unmount();
  });

  it('an applied approval’s undoId and undoable ride the card AND the persisted row — a reload keeps them', async () => {
    executeSpy.mockResolvedValue({ ok: true, executed: [1], undoId: UNDO_ID, undoable: true } as unknown as ApprovedOutcome);
    const { db, row, chat } = await staged('app:pv2');
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)!;
    act(() => chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    expect(chat.chat().messages.find((m) => m.id === card.id)?.dataWrite).toMatchObject({ outcome: 'applied', executed: [1], undoId: UNDO_ID, undoable: true });
    expect((db.listChatMessages('app:pv2').find((m) => m.id === row.id)?.meta as { dataWrite?: unknown }).dataWrite).toMatchObject({ undoId: UNDO_ID, undoable: true });
    chat.unmount();
    const reloaded = renderChat('app:pv2');
    await settle();
    expect(reloaded.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite).toMatchObject({ outcome: 'applied', undoId: UNDO_ID, undoable: true });
    reloaded.unmount();
  });

  it('an applied change that cannot be undone persists undoable: false and no undoId', async () => {
    executeSpy.mockResolvedValue({ ok: true, executed: [201], undoable: false } as unknown as ApprovedOutcome);
    const { db, row, chat } = await staged('app:pv3');
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)!;
    act(() => chat.chat().approveDataWrite({ ...card.dataWrite!, messageRowId: row.id }, card.id));
    await settle();
    const stored = (db.listChatMessages('app:pv3').find((m) => m.id === row.id)?.meta as { dataWrite?: Record<string, unknown> }).dataWrite;
    expect(stored).toMatchObject({ outcome: 'applied', undoable: false });
    expect(stored).not.toHaveProperty('undoId');
    chat.unmount();
    const reloaded = renderChat('app:pv3');
    await settle();
    expect(reloaded.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite).toMatchObject({ outcome: 'applied', undoable: false });
    reloaded.unmount();
  });

  it('the belt — outcome is re-admitted only from its enum: a planted word is no outcome (the card comes back unresolved); "undone" is admitted', async () => {
    const { chat } = await staged('app:pv4', { dataWrite: { ...PROPOSAL, outcome: 'approved-by-the-app' } });
    const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite;
    expect(card).toBeDefined();
    expect(card?.outcome).toBeUndefined();
    chat.unmount();
    const undone = await staged('app:pv4b', { dataWrite: { ...PROPOSAL, outcome: 'undone', executed: [1], undoId: UNDO_ID, undoable: true } });
    expect(undone.chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite?.outcome).toBe('undone');
    undone.chat.unmount();
  });

  it('the belt — undoId is re-admitted only as a uuid: anything else is dropped from the card', async () => {
    for (const [threadId, undoId] of [
      ['app:pv5a', 'not-a-uuid'],
      ['app:pv5b', "'; DROP TABLE expenses; --"],
      ['app:pv5c', 42],
    ] as const) {
      const { chat } = await staged(threadId, { dataWrite: { ...PROPOSAL, outcome: 'applied', executed: [1], undoId, undoable: true } });
      const card = chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite as Record<string, unknown> | undefined;
      expect(card, threadId).toBeDefined();
      expect(card?.undoId, threadId).toBeUndefined();
      chat.unmount();
    }
    const { chat } = await staged('app:pv5d', { dataWrite: { ...PROPOSAL, outcome: 'applied', executed: [1], undoId: UNDO_ID, undoable: true } });
    expect((chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite as Record<string, unknown> | undefined)?.undoId).toBe(UNDO_ID);
    chat.unmount();
  });

  it('the belt — a persisted dataWrite whose appId is not the thread’s pinned app is DROPPED on rehydrate (S10, as the access card)', async () => {
    const { chat } = await staged('app:pv6', { dataWrite: { ...PROPOSAL, appId: 'app-2' } }, 'app-1');
    expect(chat.chat().messages.find((m) => m.dataWrite !== undefined)).toBeUndefined();
    chat.unmount();
    // The passing twin: the pinned app's own card comes back.
    const own = await staged('app:pv6b', { dataWrite: PROPOSAL }, 'app-1');
    expect(own.chat.chat().messages.find((m) => m.dataWrite !== undefined)?.dataWrite?.appId).toBe('app-1');
    own.chat.unmount();
  });
});
