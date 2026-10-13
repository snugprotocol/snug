// chatCrossAppTurn.test.tsx — TASK-20261010-host-broker PR-5, lane T-C (AC39a; contract v2 D-PR5-11
// (8) ONE card per turn across own and cross-app · D-PR5-13 the data_write turn's DDL mark; F21).
//
// AT THE HOOK, where the seat is built and the one-card rule lives: the classifier is stubbed to
// `data_write`, the chat brain is the LOCAL route (so the chat door opens — `chatDoorOpen`), and the
// direct builder is a recorder that DRIVES `data_propose_write` inside the turn. Budget holds a real
// grant that lets it change Ledger's `transactions`; the real Access Service materialises it (the
// INLINE worker — the real responder), so the seat the hook builds — `recordRead` with its counting
// option and `planWrite` bound by `agent/laneTools.ts` to `access/chatWrite.ts` — is the production one.
//
//  - one card per turn ACROSS both keys: an own change staged first leaves a cross-app proposal NOT
//    staged, and the reverse; two cross-app proposals stage one;
//  - the cross-app card lands on the agent message under `accessWrite` (never `dataWrite`), for the
//    THREAD's app, naming the grant and its `grantedAt`, and persists in the row's `meta.accessWrite`
//    with its row id;
//  - the turn's context marks the writable table `· can be changed` and closes on `CHAT_DOOR.changes`.
//
// Red until D-PR5-10…13 land (no `onAccessWriteProposal`, no seat `planWrite`, no `accessWrite` slot).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { NO_ACCESS_ASKS_KEY, collectSources } from '../access/consent.js';
import { CHAT_DOOR, rowsWord } from '../access/copy.js';
import { __setAccessDepsForTests, createGrantFromDecision, findAccessGrant, resetAccessSession, type AnyAccessGrant, type CreateGrantInput } from '../access/grants.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import type { BuildHandlers, BuilderTurn } from '../agent/builder.js';
import { resetThreadSessions } from '../agent/threadSessions.js';
import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { writeFlag } from '../state/browserFlags.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const THREAD = 'app:cross-turn';

/** What the stubbed classifier answers. */
let intent = 'data_write';

vi.mock('../agent/inferrerAdapter.js', () => ({
  completeWithAdapter: () => async () => ({ ok: true as const, text: '{}' }),
  liveInferenceAdapter: async () => ({
    ok: true as const,
    adapter: {
      complete: async () => ({ ok: true as const, text: `{"intent":"${intent}","confidence":0.9}`, toolCalls: [], stopReason: 'end' as const }),
    },
  }),
}));

/** The turns the recorder saw, and what it runs INSIDE each turn with the tools it was sent. */
const sends: Array<{ tools: AgentTool[] | undefined; contextBlock?: string | undefined }> = [];
let drive: ((tools: AgentTool[] | undefined, handlers: BuildHandlers) => Promise<void>) | undefined;

vi.mock('../agent/builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/builder.js')>();
  return {
    ...actual,
    createDirectBuilder: () => ({
      send: async (turn: string | BuilderTurn, handlers: BuildHandlers) => {
        const tools = typeof turn === 'string' ? undefined : turn.tools;
        sends.push({ tools, contextBlock: typeof turn === 'string' ? undefined : turn.contextBlock });
        await drive?.(tools, handlers);
        return { ok: true as const, text: 'done' };
      },
    }),
  };
});

let db: UserDb;
let budget: string;
let ledger: string;
let grant: AnyAccessGrant;
let container: HTMLDivElement | undefined;
let root: Root | undefined;
let seq = 0;

function inlineWorkers(): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        void (async () => {
          const answer = await respond(msg);
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        })();
      },
      terminate() {},
    };
    return worker;
  };
}

async function exec(appId: string, sql: string): Promise<void> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `x-${++seq}`, instanceId: 'frame', op: 'exec', sql });
  if (!result.ok) throw new Error(`exec failed: ${JSON.stringify(result)}`);
}

function renderChat(): { chat: () => BuilderChat } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat(THREAD, { pinnedAppId: budget });
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
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

async function sendAndSettle(text: string): Promise<BuilderChat> {
  const { chat } = renderChat();
  await act(async () => {
    chat().send(text);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await settle();
    if (!chat().busy) return chat();
  }
  throw new Error('the turn never settled');
}

const propose = async (tools: AgentTool[] | undefined, statement: string, summary: string): Promise<string> => {
  const tool = tools?.find((t) => t.def.name === 'data_propose_write');
  if (tool === undefined) throw new Error('the data_write turn holds no data_propose_write');
  return String(await tool.run({ statements: [statement], summary }));
};

const OWN = "INSERT INTO expenses (id, cents) VALUES (9, 1240)";
const CROSS = "UPDATE ledger__transactions SET category = 'groceries' WHERE category = 'food'";

type AgentMessage = BuilderChat['messages'][number] & { accessWrite?: Record<string, unknown> };
const agentOf = (chat: BuilderChat): AgentMessage => chat.messages.find((m) => m.role === 'agent') as AgentMessage;
const storedMeta = (): Record<string, unknown> => (db.listChatMessages(THREAD).find((m) => m.role === 'assistant')?.meta ?? {}) as Record<string, unknown>;

beforeEach(async () => {
  sends.length = 0;
  drive = undefined;
  intent = 'data_write';
  modeStore.set('local');
  writeFlag(NO_ACCESS_ASKS_KEY, false);
  resetAccessSession();
  resetScopedReadForTests();
  db = await installTestUserDb();
  resetThreadSessions({ threadId: THREAD });
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>', usesDb: true }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>', usesDb: true }).appId;
  await db.applyAppDdl(budget, ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, cents INTEGER)']);
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT)']);
  await exec(ledger, "INSERT INTO transactions (id, amount, category) VALUES (1, 1200, 'food'), (2, 800, 'food'), (3, 5000, 'rent')");
  configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() } });
  const ranked = await collectSources(db, budget);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
  grant = await createGrantFromDecision(db, {
    readerAppId: budget,
    source,
    tables: [{ name: 'transactions', withheld: [], write: true }],
    duration: 'day',
    unattended: false,
    purpose: 'to tidy my spending',
    provenance: 'user',
    now: Date.now(),
  } as unknown as CreateGrantInput);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  modeStore.set('byok');
  writeFlag(NO_ACCESS_ASKS_KEY, false);
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  vi.restoreAllMocks();
});

describe('D-PR5-11 (8) — ONE card per turn, across the own key and the cross-app key', () => {
  it('a cross-app change lands under accessWrite (never dataWrite), for the thread’s app, naming the grant and its grantedAt — and persists in meta.accessWrite with its row id', async () => {
    let answer = '';
    drive = async (tools) => {
      answer = await propose(tools, CROSS, 'call food groceries');
    };
    const chat = await sendAndSettle('call my food purchases groceries in the ledger');
    expect(answer).toContain(`Proposed — it would change ${rowsWord(2)} in Ledger; it waits for the user’s OK on the card`);
    const agent = agentOf(chat);
    expect(agent.dataWrite, 'never the own key').toBeUndefined();
    expect(agent.accessWrite).toMatchObject({
      appId: budget,
      target: { grantId: grant.id, grantedAt: findAccessGrant(db, grant.id)!.grant.grantedAt, sourceAppId: ledger, table: 'transactions' },
      sql: `UPDATE "transactions" SET category = 'groceries' WHERE category = 'food'`,
      summary: 'call food groceries',
      previewed: 2,
    });
    const stored = db.listChatMessages(THREAD).find((m) => m.role === 'assistant');
    expect(agent.accessWrite?.messageRowId).toBe(stored?.id);
    const meta = storedMeta();
    expect(meta.dataWrite).toBeUndefined();
    expect(meta.accessWrite).toMatchObject({ appId: budget, previewed: 2 });
    expect(meta.accessWrite, 'the row id is the row’s own address, never written into it').not.toHaveProperty('messageRowId');
  });

  it('an OWN change staged first: the cross-app proposal in the same turn is NOT staged and the brain is told', async () => {
    const answers: string[] = [];
    drive = async (tools) => {
      answers.push(await propose(tools, OWN, 'add a lunch'));
      answers.push(await propose(tools, CROSS, 'call food groceries'));
    };
    const chat = await sendAndSettle('add a lunch and tidy the ledger');
    expect(answers[0]).toContain('Proposed (NOT applied');
    expect(answers[1]).toContain('NOT staged');
    const agent = agentOf(chat);
    expect(agent.dataWrite?.statements).toEqual([OWN]);
    expect(agent.accessWrite).toBeUndefined();
    expect(storedMeta().accessWrite).toBeUndefined();
  });

  it('a CROSS-APP change staged first: the own proposal in the same turn is NOT staged', async () => {
    const answers: string[] = [];
    drive = async (tools) => {
      answers.push(await propose(tools, CROSS, 'call food groceries'));
      answers.push(await propose(tools, OWN, 'add a lunch'));
    };
    const chat = await sendAndSettle('tidy the ledger and add a lunch');
    expect(answers[0]).toContain('Proposed — it would change');
    expect(answers[1]).toContain('NOT staged');
    const agent = agentOf(chat);
    expect(agent.accessWrite).toBeDefined();
    expect(agent.dataWrite).toBeUndefined();
    expect(storedMeta().dataWrite).toBeUndefined();
  });

  it('two cross-app proposals in one turn stage ONE card', async () => {
    const answers: string[] = [];
    drive = async (tools) => {
      answers.push(await propose(tools, CROSS, 'call food groceries'));
      answers.push(await propose(tools, "UPDATE ledger__transactions SET amount = 0 WHERE id = 3", 'zero the rent'));
    };
    const chat = await sendAndSettle('tidy the ledger twice');
    expect(answers[0]).toContain('Proposed — it would change');
    expect(answers[1]).toContain('NOT staged');
    expect(agentOf(chat).accessWrite).toMatchObject({ summary: 'call food groceries' });
  });
});

describe('D-PR5-13 — the data_write turn’s context says what may be changed (and the data_read turn’s does not)', () => {
  it('data_write: the writable table’s line ends “· can be changed”, the heading drops “read-only ·”, the block closes on CHAT_DOOR.changes', async () => {
    const changes = (CHAT_DOOR as unknown as { changes?: string }).changes;
    await sendAndSettle('change my ledger');
    const block = sends[0]?.contextBlock ?? '';
    expect(block).toContain('ledger__transactions(');
    expect(block).toMatch(/ledger__transactions\([^\n]*\) — [^\n]* · can be changed/);
    expect(block).not.toContain('### From Ledger (read-only ·');
    expect(typeof changes === 'string' && changes !== '' && block.includes(changes), 'CHAT_DOOR.changes closes the block').toBe(true);
    expect(block).not.toContain(CHAT_DOOR.rule);
  });

  it('data_read over the same grant: today’s read-only block — the rule, no “can be changed” (guard)', async () => {
    intent = 'data_read';
    await sendAndSettle('what is in my ledger?');
    const block = sends[0]?.contextBlock ?? '';
    expect(block).toContain('### From Ledger (read-only ·');
    expect(block).toContain(CHAT_DOOR.rule);
    expect(block).not.toContain('can be changed');
  });
});
