// useBuilderChatLanes.test.tsx — TASK-20261009-scheduling-framework P2 (ADR-0074 §4; feasibility
// F2): the lane tool selection in `useBuilderChat` is ONE EXHAUSTIVE SWITCH over the route's lane
// (`laneToolsFor`), and the `schedule` lane sees exactly ONE tool — `schedule_propose` — never
// `artifact_write`, never a data tool, never the choice card. The else-chain this replaces let a
// lane it did not name fall through to the full builder set: the mutation this file reds on.
//
// At the HOOK, because that is where the selection is wired: the classifier adapter is stubbed
// per route (the lifecycle suite's pattern), and the direct builder is replaced by a recorder that
// captures the `tools` each turn is sent and can DRIVE one of them — so the schedule lane's tool
// is seen staging its suggestion on the message, and the card persisting in the row's meta.
//
// TASK-20261010-host-broker PR-2 (lane B; AC10, AC12; D-PR2-10, D-PR2-11): the `data` and
// `answer` lanes also hold `access_propose` under the offer rule (an owned app, the Settings
// switch off, the reader not muted); the `schedule` lane never. A data-lane turn beside an app
// whose chat brain is a keyed or local route materialises the shared set ONCE (spied through
// `__setAccessServiceForTests`); the other lanes and the webllm / demo / host brains never. The
// ask card lands on the message with the thread's app, persists in `meta.access` with its row
// id, `resolveAccess` merges the row's meta, and a persisted card for another app is not
// rehydrated. The two exact-list pins above that the offer rule moves are compared as SETS.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '@snugprotocol/adapters';

import type { BuildHandlers, BuilderTurn } from '../agent/builder.js';
import { laneToolsFor as laneToolsFromHome } from '../agent/laneTools.js';
import { metaToScheduleCard } from '../agent/scheduleCard.js';
import { SCHEDULE_PROPOSE_TOOL_NAME } from '../agent/scheduleProposeTool.js';
import { SCHEDULE_PROPOSE_TOOL_NAME as NAME_VIA_TOOLS } from '../agent/tools.js';
import { laneToolsFor, useBuilderChat, type BuilderChat, type LaneToolDeps } from '../agent/useBuilderChat.js';
import { NO_ACCESS_ASKS_KEY } from '../access/consent.js';
import { noteReaderGeneration, resetAccessSession } from '../access/grants.js';
import { writeFlag } from '../state/browserFlags.js';
import { modeStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HTML = '<!doctype html><html><body>ledger</body></html>';
const THREAD = 'app:lanes';

let db: Awaited<ReturnType<typeof installTestUserDb>>;
let appId: string;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

/** What the stubbed classifier answers on the next call. */
let intent = 'schedule';

vi.mock('../agent/inferrerAdapter.js', () => ({
  completeWithAdapter: () => async () => ({ ok: true as const, text: '{}' }),
  liveInferenceAdapter: async () => ({
    ok: true as const,
    adapter: {
      complete: async () => ({ ok: true as const, text: `{"intent":"${intent}","confidence":0.9}`, toolCalls: [], stopReason: 'end' as const }),
    },
  }),
}));

// The platform-pinned HOST brain, switchable per row (the scheduleCard suite's gate): a stable
// object, so the hook's memo keyed on the brain does not churn.
const brainGate = vi.hoisted(() => ({ host: false, brain: { kind: 'host', label: 'Claude', streaming: true, tools: false } as const }));
vi.mock('../state/webllm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/webllm.js')>();
  return {
    ...original,
    useBrain: () => (brainGate.host ? brainGate.brain : original.useBrain()),
    currentBrain: () => (brainGate.host ? brainGate.brain : original.currentBrain()),
  };
});

// The provider lane's builder is a spy returning [] (its own suite proves the tools).
vi.mock('../agent/providerTools.js', () => ({
  buildProviderTools: () => [],
  PROVIDER_REQUEST_TOOL_NAME: 'provider_request',
}));

/** The turns the recorder saw: the tools each was sent, and the handlers (for the builder set's hook). */
const sends: Array<{ tools: AgentTool[] | undefined; handlers: BuildHandlers; contextBlock?: string | undefined }> = [];
/** Runs INSIDE the turn, with the tools it was sent — how a test drives `schedule_propose`. */
let drive: ((tools: AgentTool[] | undefined, handlers: BuildHandlers) => Promise<void>) | undefined;

vi.mock('../agent/builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/builder.js')>();
  return {
    ...actual,
    createDirectBuilder: () => ({
      send: async (turn: string | BuilderTurn, handlers: BuildHandlers) => {
        const tools = typeof turn === 'string' ? undefined : turn.tools;
        sends.push({ tools, handlers, contextBlock: typeof turn === 'string' ? undefined : turn.contextBlock });
        await drive?.(tools, handlers);
        return { ok: true as const, text: 'done' };
      },
    }),
  };
});

/**
 * The PR-2 modules this EXTENDED suite reaches are loaded through a variable specifier so the
 * file still transforms (and its existing rows still run) before they exist; a row that needs
 * one is red on its own load. The type is the module's own.
 */
const lazy = <T,>(spec: string): Promise<T> => import(/* @vite-ignore */ spec) as Promise<T>;
const serviceModule = (): Promise<typeof import('../access/service.js')> => lazy('../access/service.js');
const accessCardModule = (): Promise<typeof import('../agent/accessCard.js')> => lazy('../agent/accessCard.js');

const names = (tools: AgentTool[] | undefined): string[] | undefined => tools?.map((tool) => tool.def.name);
/** The tool names as a SET (sorted) — what a lane may reach, not the order it is offered in. */
const nameSet = (tools: AgentTool[] | undefined): string[] | undefined => names(tools)?.slice().sort();

function renderChat(): { chat: () => BuilderChat } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat(THREAD, { pinnedAppId: appId });
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

/** Until the turn settles (the data lane imports its tools lazily, so one tick is not enough). */
async function settleUntilIdle(chat: () => BuilderChat): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await settle();
    if (!chat().busy) return;
  }
  throw new Error('the turn never settled');
}

async function sendAndSettle(text: string): Promise<BuilderChat> {
  const { chat } = renderChat();
  await act(async () => {
    chat().send(text);
  });
  await settleUntilIdle(chat);
  return chat();
}

beforeEach(async () => {
  sends.length = 0;
  drive = undefined;
  intent = 'schedule';
  modeStore.set('byok');
  brainGate.host = false;
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  writeFlag(NO_ACCESS_ASKS_KEY, false);
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Pocket Ledger', html: HTML, usesDb: true }).appId;
  await db.applyAppDdl(appId, ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, cents INTEGER)']);
});

afterEach(async () => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  modeStore.set('byok');
  brainGate.host = false;
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  writeFlag(NO_ACCESS_ASKS_KEY, false);
  resetAccessSession();
  // The access service seam (PR-2): restored when the module exists; absent until it lands.
  try {
    const service = await serviceModule();
    service.__setAccessServiceForTests();
  } catch {
    // not there yet — the rows that need it are red on their own import
  }
});

describe('the exhaustive lane switch — what each lane may reach', () => {
  it('a schedule route sees ONLY schedule_propose — never artifact_write, never a data tool, never the card', async () => {
    intent = 'schedule';
    await sendAndSettle('every morning at 8, sum up yesterday');
    expect(sends).toHaveLength(1);
    expect(names(sends[0]?.tools)).toEqual([SCHEDULE_PROPOSE_TOOL_NAME]);
    expect(names(sends[0]?.tools)).not.toContain('artifact_write');
  });

  it('data_read sees the read tool and the card, never the write tool; the feature lane keeps the builder set (no override)', async () => {
    intent = 'data_read';
    await sendAndSettle('how much did I spend?');
    // PR-2: the offer rule adds `access_propose` beside the card (an owned app, asks on, not muted).
    expect(nameSet(sends[0]?.tools)).toEqual(['access_propose', 'data_query', 'present_card']);
    expect(names(sends[0]?.tools)).not.toContain('data_propose_write');
    sends.length = 0;
    act(() => root?.unmount());
    intent = 'app_change';
    await sendAndSettle('make the total bold');
    expect(sends[0]?.tools, 'the feature lane passes no override — the builder set').toBeUndefined();
  });

  it('the answer lane sees the card and the ask (PR-2); the provider lane its tool plus the card', async () => {
    intent = 'app_question';
    await sendAndSettle('what does this app do?');
    expect(nameSet(sends[0]?.tools)).toEqual(['access_propose', 'present_card']);
    sends.length = 0;
    act(() => root?.unmount());
    intent = 'provider_read';
    await sendAndSettle('what did I listen to most?');
    expect(names(sends[0]?.tools)).toEqual(['present_card']);
  });

  it('laneToolsFor is exhaustive over the routed lanes — a lane the switch does not name cannot answer the builder set', async () => {
    const deps: LaneToolDeps = {
      db,
      contextTarget: appId,
      threadId: THREAD,
      signal: new AbortController().signal,
      presentCardTool: { def: { name: 'present_card', description: 'x', inputSchema: { type: 'object' } }, run: () => 'x' },
      onDataProposal: () => true,
      onProviderFailureCode: () => undefined,
      onScheduleProposal: () => true,
      onAccessProposal: () => true,
    };
    expect(names(await laneToolsFor({ lane: 'schedule', intent: 'schedule' }, deps))).toEqual([SCHEDULE_PROPOSE_TOOL_NAME]);
    expect(await laneToolsFor({ lane: 'feature', intent: 'app_change' }, deps)).toBeUndefined();
    expect(await laneToolsFor(undefined, deps)).toBeUndefined();
    expect(nameSet(await laneToolsFor({ lane: 'answer', intent: 'other' }, deps))).toEqual(['access_propose', 'present_card']);
    // The `never` default: a lane the type system does not know is not silently the builder set.
    const bogus = await laneToolsFor({ lane: 'bogus', intent: 'other' } as unknown as Parameters<typeof laneToolsFor>[0], deps);
    expect(bogus).not.toBeUndefined();
    expect(Array.isArray(bogus)).toBe(false);
  });

  it('S10: a ROUTED non-feature lane with no contextTarget runs tool-free ([]) — never the builder set; the feature lane and an unrouted turn keep it', async () => {
    const deps: LaneToolDeps = {
      db,
      contextTarget: undefined,
      threadId: THREAD,
      signal: new AbortController().signal,
      presentCardTool: { def: { name: 'present_card', description: 'x', inputSchema: { type: 'object' } }, run: () => 'x' },
      onDataProposal: () => true,
      onProviderFailureCode: () => undefined,
      onScheduleProposal: () => true,
      onAccessProposal: () => true,
    };
    expect(await laneToolsFor({ lane: 'schedule', intent: 'schedule' }, deps)).toEqual([]);
    expect(await laneToolsFor({ lane: 'data', intent: 'data_read' }, deps)).toEqual([]);
    expect(await laneToolsFor({ lane: 'provider', intent: 'provider_read' }, deps)).toEqual([]);
    expect(await laneToolsFor({ lane: 'answer', intent: 'other' }, deps)).toEqual([]);
    expect(await laneToolsFor({ lane: 'feature', intent: 'app_change' }, deps)).toBeUndefined();
    expect(await laneToolsFor(undefined, deps)).toBeUndefined();
  });

  it('M4/M17: the lane switch lives in agent/laneTools.ts (the hook re-exports it) and the propose tool in agent/scheduleProposeTool.ts (tools.ts re-exports its name)', () => {
    expect(laneToolsFor).toBe(laneToolsFromHome);
    expect(NAME_VIA_TOOLS).toBe(SCHEDULE_PROPOSE_TOOL_NAME);
  });
});

describe('resolving the card through the hook (the ChatLog contract: `onResolveSchedule`)', () => {
  it('`resolveSchedule` patches the message and persists the answer by MERGING the row’s meta — the task id rides along, the other meta keys survive', async () => {
    intent = 'schedule';
    drive = async (tools) => {
      const tool = tools?.find((t) => t.def.name === SCHEDULE_PROPOSE_TOOL_NAME);
      await tool?.run({ title: 'nudge', when: 'every day at 8', steps: [{ kind: 'notify', title: 'hi', body: 'there' }] });
    };
    const { chat } = renderChat();
    await act(async () => {
      chat().send('remind me every day at 8');
    });
    await settleUntilIdle(chat);
    const agent = chat().messages.find((m) => m.role === 'agent');
    const card = agent?.schedule;
    expect(card?.messageRowId).toBeDefined();
    const rowId = card!.messageRowId!;
    const before = db.listChatMessages(THREAD).find((m) => m.id === rowId)!;
    db.updateChatMessageMeta(rowId, { ...(before.meta as object), wireText: 'kept across the resolution' });

    act(() => {
      chat().resolveSchedule(card!, agent!.id, 'scheduled', 'task-9');
    });
    await settle();

    const after = chat().messages.find((m) => m.id === agent!.id)?.schedule;
    expect(after).toMatchObject({ resolution: 'scheduled', taskId: 'task-9', messageRowId: rowId });
    const stored = db.listChatMessages(THREAD).find((m) => m.id === rowId)!;
    expect(metaToScheduleCard(stored.meta)).toMatchObject({ resolution: 'scheduled', taskId: 'task-9', channel: 'chat' });
    expect((stored.meta as { wireText?: string }).wireText).toBe('kept across the resolution');
    expect(db.listScheduledTasks(), 'resolving a card never creates a task — the writer does').toHaveLength(0);
  });

  it('a declined card persists `declined` with no task id', async () => {
    intent = 'schedule';
    drive = async (tools) => {
      const tool = tools?.find((t) => t.def.name === SCHEDULE_PROPOSE_TOOL_NAME);
      await tool?.run({ title: 'nudge', when: 'every day at 8', steps: [{ kind: 'notify', title: 'hi', body: 'there' }] });
    };
    const { chat } = renderChat();
    await act(async () => {
      chat().send('remind me every day at 8');
    });
    await settleUntilIdle(chat);
    const agent = chat().messages.find((m) => m.role === 'agent')!;
    act(() => {
      chat().resolveSchedule(agent.schedule!, agent.id, 'declined');
    });
    await settle();
    expect(chat().messages.find((m) => m.id === agent.id)?.schedule?.resolution).toBe('declined');
    const stored = db.listChatMessages(THREAD).find((m) => m.id === agent.schedule!.messageRowId)!;
    const persisted = metaToScheduleCard(stored.meta);
    expect(persisted?.resolution).toBe('declined');
    expect(persisted?.taskId).toBeUndefined();
  });
});

describe('the schedule lane’s tool stages ONE suggestion on the message (P1)', () => {
  it('a schedule_propose call lands a card on the agent message with the chat provenance and the thread’s app, persisted in the row’s meta with its row id', async () => {
    intent = 'schedule';
    let answer = '';
    drive = async (tools) => {
      const tool = tools?.find((t) => t.def.name === SCHEDULE_PROPOSE_TOOL_NAME);
      answer = String(await tool?.run({ title: 'morning summary', when: 'every day at 8', steps: [{ kind: 'app-think', prompt: 'Sum up yesterday.' }] }));
    };
    const chat = await sendAndSettle('every morning at 8, sum up yesterday');
    expect(answer).toContain('Suggested (NOT scheduled');
    const agent = chat.messages.find((m) => m.role === 'agent');
    expect(agent?.schedule).toMatchObject({ channel: 'chat', appId, threadId: THREAD });
    expect(agent?.schedule?.proposal).toEqual({
      title: 'morning summary',
      steps: [{ kind: 'app-think', appId, prompt: 'Sum up yesterday.', context: { maxRows: 50 } }],
      spec: { kind: 'daily', time: '08:00', tz: 'device' },
    });
    expect(agent?.schedule?.resolution).toBeUndefined();
    const rows = db.listChatMessages(THREAD);
    const stored = rows.find((m) => m.role === 'assistant');
    expect(stored).toBeDefined();
    expect(agent?.schedule?.messageRowId).toBe(stored?.id);
    expect(metaToScheduleCard(stored?.meta)).toMatchObject({ channel: 'chat', appId, hash: agent?.schedule?.hash });
    expect(db.listScheduledTasks(), 'a suggestion never creates a task').toHaveLength(0);
  });

  it('a second proposal in the same turn is NOT staged and the model is told', async () => {
    intent = 'schedule';
    const answers: string[] = [];
    drive = async (tools) => {
      const tool = tools?.find((t) => t.def.name === SCHEDULE_PROPOSE_TOOL_NAME);
      const input = { title: 'one', when: 'every day at 8', steps: [{ kind: 'notify', title: 'hi', body: 'there' }] };
      answers.push(String(await tool?.run(input)));
      answers.push(String(await tool?.run({ ...input, title: 'two' })));
    };
    const chat = await sendAndSettle('remind me every day at 8');
    expect(answers[0]).toContain('Suggested');
    expect(answers[1]).toContain('NOT staged');
    expect(chat.messages.find((m) => m.role === 'agent')?.schedule?.proposal.title).toBe('one');
  });

  it('the builder’s own set reaches the same staging through the turn handlers, with the builder provenance', async () => {
    intent = 'app_change';
    drive = async (_tools, handlers) => {
      const staged = handlers.onScheduleProposal?.({ title: 'nudge', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'daily', time: '20:00', tz: 'device' } }, appId);
      expect(staged).toBe(true);
    };
    const chat = await sendAndSettle('make the total bold');
    expect(sends[0]?.handlers.onScheduleProposal).toBeTypeOf('function');
    expect(chat.messages.find((m) => m.role === 'agent')?.schedule).toMatchObject({ channel: 'builder', appId });
  });

  it('a reload re-renders the card from the row, re-validated', async () => {
    intent = 'schedule';
    drive = async (tools) => {
      const tool = tools?.find((t) => t.def.name === SCHEDULE_PROPOSE_TOOL_NAME);
      await tool?.run({ title: 'nudge', when: 'every day at 8', steps: [{ kind: 'notify', title: 'hi', body: 'there' }] });
    };
    await sendAndSettle('remind me every day at 8');
    act(() => root?.unmount());
    // A fresh session over the same rows (a new thread id would be a new session; here the
    // persisted rows are read through the hook's hydration on a thread with no live session).
    const { resetThreadSessions } = await import('../agent/threadSessions.js');
    resetThreadSessions({ threadId: THREAD });
    const { chat } = renderChat();
    await settle();
    await settle();
    const agent = chat().messages.find((m) => m.role === 'agent');
    expect(agent?.schedule?.proposal.title).toBe('nudge');
    expect(agent?.schedule?.messageRowId).toBeTypeOf('number');
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-2 — the chat door (lane B)
// =========================================================================================

const ACCESS_PROPOSE = 'access_propose';
const PURPOSE = 'to compare spending with the ledger';

/** A literal deps object for the offer-rule rows (the hook's own seams are exercised above). */
const depsFor = (target: string | undefined): LaneToolDeps => ({
  db,
  contextTarget: target,
  threadId: THREAD,
  signal: new AbortController().signal,
  presentCardTool: { def: { name: 'present_card', description: 'x', inputSchema: { type: 'object' } }, run: () => 'x' },
  onDataProposal: () => true,
  onProviderFailureCode: () => undefined,
  onScheduleProposal: () => true,
  onAccessProposal: () => true,
});

/** The shared set the spied service hands the data lane — a session grant, so its heading carries no date. */
const SHARED = {
  tables: [
    {
      grantId: 'g-1',
      sourceAppId: 'app-ledger',
      sourceName: 'Ledger',
      alias: 'ledger',
      name: 'ledger__transactions',
      table: 'transactions',
      columns: ['id', 'amount'],
      types: ['INTEGER', 'INTEGER'],
      rows: [[1, 100]],
      truncated: false,
      duration: 'session' as const,
    },
  ],
  skipped: [],
  readOnlyTables: ['ledger__transactions'],
};

/** Spy the ONE service (the `__setAccessDepsForTests` pattern) — materialise and recordRead. */
async function spyService(): Promise<{ materialise: ReturnType<typeof vi.fn>; recordRead: ReturnType<typeof vi.fn> }> {
  const service = await serviceModule();
  const materialise = vi.fn(async () => SHARED);
  const recordRead = vi.fn(async () => ({ recorded: ['g-1'], refused: [] }));
  service.__setAccessServiceForTests({ materialise, recordRead } as unknown as Parameters<typeof service.__setAccessServiceForTests>[0]);
  return { materialise, recordRead };
}

describe('PR-2 — access_propose under the offer rule (D-PR2-11)', () => {
  it('the data and answer lanes hold access_propose for an owned app with asks on; the schedule lane never', async () => {
    const deps = depsFor(appId);
    expect(names(await laneToolsFor({ lane: 'data', intent: 'data_read' }, deps))).toContain(ACCESS_PROPOSE);
    expect(names(await laneToolsFor({ lane: 'data', intent: 'data_write' }, deps))).toContain(ACCESS_PROPOSE);
    expect(names(await laneToolsFor({ lane: 'answer', intent: 'app_question' }, deps))).toContain(ACCESS_PROPOSE);
    expect(names(await laneToolsFor({ lane: 'schedule', intent: 'schedule' }, deps))).toEqual([SCHEDULE_PROPOSE_TOOL_NAME]);
  });

  it('not offered when the Settings switch *never let apps ask* is on', async () => {
    writeFlag(NO_ACCESS_ASKS_KEY, true);
    const deps = depsFor(appId);
    expect(names(await laneToolsFor({ lane: 'data', intent: 'data_read' }, deps))).not.toContain(ACCESS_PROPOSE);
    expect(names(await laneToolsFor({ lane: 'answer', intent: 'other' }, deps))).toEqual(['present_card']);
  });

  it('not offered for a reader the user muted', async () => {
    db.setAccessMuted(appId, true);
    const deps = depsFor(appId);
    expect(names(await laneToolsFor({ lane: 'data', intent: 'data_read' }, deps))).not.toContain(ACCESS_PROPOSE);
    expect(names(await laneToolsFor({ lane: 'answer', intent: 'other' }, deps))).toEqual(['present_card']);
  });

  it('not offered for an unowned app (a starter preview) — its chat may not ask what its frame may not', async () => {
    const deps = depsFor('starter--pocket-ledger');
    expect(names(await laneToolsFor({ lane: 'answer', intent: 'other' }, deps))).toEqual(['present_card']);
  });

  it('a routed lane with no app attached still runs tool-free — no ask without a reader', async () => {
    expect(await laneToolsFor({ lane: 'answer', intent: 'other' }, depsFor(undefined))).toEqual([]);
  });
});

describe('PR-2 — the data lane materialises ONCE, and only where the chat door opens (D-PR2-10)', () => {
  it('a data-lane turn under a local brain materialises ONCE for the chat caller, and the set reaches the context and the query tool', async () => {
    const { CHAT_DOOR } = await import('../access/copy.js');
    const { materialise, recordRead } = await spyService();
    modeStore.set('local');
    intent = 'data_read';
    const SQL = 'SELECT COUNT(*) AS n FROM ledger__transactions';
    drive = async (tools) => {
      await tools?.find((t) => t.def.name === 'data_query')?.run({ sql: SQL });
    };
    await sendAndSettle('compare this with my ledger');
    expect(materialise).toHaveBeenCalledTimes(1);
    expect(materialise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat', appId, threadId: THREAD }));
    expect((materialise.mock.calls[0]?.[0] as { liveGeneration?: number }).liveGeneration, 'the reader’s view is closed').toBeUndefined();
    // the DDL block carries the shared section (a session grant: no date in the heading)
    expect(sends[0]?.contextBlock ?? '').toContain(CHAT_DOOR.heading('Ledger', 'session', undefined, Date.now()));
    // the query tool records the read through the same service, with the chat caller and the real SQL
    expect(recordRead).toHaveBeenCalledTimes(1);
    expect(recordRead).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat', appId }),
      expect.objectContaining({ readOnlyTables: ['ledger__transactions'] }),
      expect.objectContaining({ grantIds: ['g-1'], sql: SQL }),
    );
  });

  // DOORS-3 (PR-2 Gate-5; F14): a stop that lands while the Worker dumps ends the turn before any
  // context is built — the abort re-check after materialise, with the same cleanup as the
  // classifier's (R-M3): no send, no persisted user row, nothing left spinning.
  it('a stop that lands DURING materialise ends the turn: the brain is never sent, nothing is persisted, nothing spins', async () => {
    const { materialise, recordRead } = await spyService();
    let release: (() => void) | undefined;
    materialise.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(SHARED);
        }),
    );
    modeStore.set('local');
    intent = 'data_read';
    const { chat } = renderChat();
    await act(async () => {
      chat().send('compare this with my ledger');
    });
    const deadline = Date.now() + 10_000;
    while (materialise.mock.calls.length === 0 && Date.now() < deadline) await settle();
    expect(materialise).toHaveBeenCalledTimes(1);
    act(() => chat().stop());
    await act(async () => {
      release?.();
    });
    await settleUntilIdle(chat);
    expect(sends, 'the brain is never sent a stopped turn').toHaveLength(0);
    expect(recordRead).not.toHaveBeenCalled();
    expect(chat().busy).toBe(false);
    expect(chat().messages.some((m) => m.streaming === true), 'no forever-placeholder').toBe(false);
    const agent = chat().messages.filter((m) => m.role === 'agent');
    for (const message of agent) expect(message.streaming).toBe(false);
    expect(db.listChatMessages(THREAD).filter((m) => m.role === 'user'), 'a stopped turn persists no user row').toEqual([]);
  });

  it('the chat caller carries the reader’s live generation while its view is open (D-PR2-3)', async () => {
    const { materialise } = await spyService();
    noteReaderGeneration(appId, 4);
    modeStore.set('local');
    intent = 'data_read';
    await sendAndSettle('how much did I spend?');
    expect(materialise).toHaveBeenCalledTimes(1);
    expect(materialise.mock.calls[0]?.[0]).toMatchObject({ kind: 'chat', appId, threadId: THREAD, liveGeneration: 4 });
  });

  for (const [label, routed] of [
    ['the feature lane', 'app_change'],
    ['the answer lane', 'app_question'],
    ['the schedule lane', 'schedule'],
    ['the provider lane', 'provider_read'],
  ] as const) {
    it(`${label} never materialises`, async () => {
      const { materialise, recordRead } = await spyService();
      modeStore.set('local');
      intent = routed;
      await sendAndSettle('a message');
      expect(sends).toHaveLength(1);
      expect(materialise).not.toHaveBeenCalled();
      expect(recordRead).not.toHaveBeenCalled();
    });
  }

  it('the webllm brain never materialises — the door is not open where the data lane runs on it', async () => {
    const { materialise } = await spyService();
    webllmFlagStore.set(true);
    webgpuStore.set('yes');
    intent = 'data_read';
    await sendAndSettle('how much did I spend?');
    expect(sends).toHaveLength(1);
    expect(materialise).not.toHaveBeenCalled();
  });

  it('the demo brain (byok with no key) never materialises', async () => {
    const { materialise } = await spyService();
    intent = 'data_read';
    await sendAndSettle('how much did I spend?');
    expect(sends).toHaveLength(1);
    expect(names(sends[0]?.tools)).toContain('data_query');
    expect(materialise).not.toHaveBeenCalled();
  });

  it('the host brain never materialises', async () => {
    const { materialise } = await spyService();
    brainGate.host = true;
    intent = 'data_read';
    await sendAndSettle('how much did I spend?');
    expect(sends).toHaveLength(1);
    expect(materialise).not.toHaveBeenCalled();
  });
});

describe('PR-2 — the ask card on the message (AC12)', () => {
  it('an access_propose call lands a card on the agent message with the thread’s app, persisted in meta.access with its row id', async () => {
    const { metaToAccessCard } = await accessCardModule();
    intent = 'data_read';
    let answer = '';
    drive = async (tools) => {
      answer = String(await tools?.find((t) => t.def.name === ACCESS_PROPOSE)?.run({ purpose: PURPOSE, hints: { tables: ['transactions'] } }));
    };
    const chat = await sendAndSettle('compare this with my ledger');
    expect(answer).toContain('Suggested (NOT allowed');
    const agent = chat.messages.find((m) => m.role === 'agent') as (typeof chat.messages)[number] & { access?: { purpose: string; appId: string; threadId: string; messageRowId?: number } };
    expect(agent?.access).toMatchObject({ purpose: PURPOSE, hints: { tables: ['transactions'] }, appId, threadId: THREAD });
    const stored = db.listChatMessages(THREAD).find((m) => m.role === 'assistant');
    expect(stored).toBeDefined();
    expect(agent?.access?.messageRowId).toBe(stored?.id);
    expect(metaToAccessCard(stored?.meta)).toMatchObject({ purpose: PURPOSE, appId, threadId: THREAD });
  });

  it('a second ask in the same turn is NOT staged and the model is told', async () => {
    intent = 'app_question';
    const answers: string[] = [];
    drive = async (tools) => {
      const tool = tools?.find((t) => t.def.name === ACCESS_PROPOSE);
      answers.push(String(await tool?.run({ purpose: PURPOSE })));
      answers.push(String(await tool?.run({ purpose: 'to read the pantry too' })));
    };
    const chat = await sendAndSettle('what is in my ledger?');
    expect(answers[0]).toContain('Suggested');
    expect(answers[1]).toContain('NOT staged');
    expect((chat.messages.find((m) => m.role === 'agent') as { access?: { purpose: string } }).access?.purpose).toBe(PURPOSE);
  });

  it('the builder’s own set reaches the same staging through the turn handlers', async () => {
    intent = 'app_change';
    drive = async (_tools, handlers) => {
      const staged = (handlers as BuildHandlers & { onAccessProposal?: (p: { purpose: string }, appId: string) => boolean | void }).onAccessProposal?.({ purpose: PURPOSE }, appId);
      expect(staged).toBe(true);
    };
    const chat = await sendAndSettle('make the total bold');
    expect((sends[0]?.handlers as { onAccessProposal?: unknown }).onAccessProposal).toBeTypeOf('function');
    expect((chat.messages.find((m) => m.role === 'agent') as { access?: unknown }).access).toMatchObject({ purpose: PURPOSE, appId });
  });

  it('`resolveAccess` patches the message and persists the answer by MERGING the row’s meta', async () => {
    const { metaToAccessCard } = await accessCardModule();
    intent = 'data_read';
    drive = async (tools) => {
      await tools?.find((t) => t.def.name === ACCESS_PROPOSE)?.run({ purpose: PURPOSE });
    };
    const { chat } = renderChat();
    await act(async () => {
      chat().send('compare this with my ledger');
    });
    await settleUntilIdle(chat);
    const agent = chat().messages.find((m) => m.role === 'agent') as ReturnType<typeof chat>['messages'][number] & { access?: { messageRowId?: number } };
    const card = agent.access!;
    const rowId = card.messageRowId!;
    expect(rowId).toBeTypeOf('number');
    const before = db.listChatMessages(THREAD).find((m) => m.id === rowId)!;
    db.updateChatMessageMeta(rowId, { ...(before.meta as object), wireText: 'kept across the resolution' });

    act(() => {
      (chat() as BuilderChat & { resolveAccess: (card: unknown, messageId: number, resolution: unknown) => void }).resolveAccess(card, agent.id, { kind: 'not-now' });
    });
    await settle();

    const after = (chat().messages.find((m) => m.id === agent.id) as { access?: { resolution?: unknown; messageRowId?: number } }).access;
    expect(after).toMatchObject({ resolution: { kind: 'not-now' }, messageRowId: rowId });
    const stored = db.listChatMessages(THREAD).find((m) => m.id === rowId)!;
    expect(metaToAccessCard(stored.meta)?.resolution).toEqual({ kind: 'not-now' });
    expect((stored.meta as { wireText?: string }).wireText).toBe('kept across the resolution');
  });

  it('a reload re-renders the thread’s own card — and NOT a persisted card for another app (S10)', async () => {
    const { accessCardToMeta, stageAccessCard } = await accessCardModule();
    const other = db.installApp({ displayName: 'Ledger', html: HTML }).appId;
    db.upsertThread(THREAD, { appId });
    db.appendChatMessage(THREAD, 'user', 'compare this with my ledger');
    db.appendChatMessage(THREAD, 'assistant', 'own card', { meta: accessCardToMeta(stageAccessCard({ purpose: PURPOSE }, { appId, threadId: THREAD })) });
    db.appendChatMessage(THREAD, 'assistant', 'forged card', { meta: accessCardToMeta(stageAccessCard({ purpose: 'to read everything' }, { appId: other, threadId: THREAD })) });
    const { resetThreadSessions } = await import('../agent/threadSessions.js');
    resetThreadSessions({ threadId: THREAD });
    const { chat } = renderChat();
    await settle();
    await settle();
    const own = chat().messages.find((m) => m.displayText === 'own card') as { access?: { purpose: string; messageRowId?: number } } | undefined;
    const forged = chat().messages.find((m) => m.displayText === 'forged card') as { access?: unknown } | undefined;
    expect(own?.access?.purpose).toBe(PURPOSE);
    expect(own?.access?.messageRowId).toBeTypeOf('number');
    expect(forged).toBeDefined();
    expect(forged?.access).toBeUndefined();
  });
});
