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

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '@snugprotocol/adapters';

import type { BuildHandlers, BuilderTurn } from '../agent/builder.js';
import { metaToScheduleCard } from '../agent/scheduleCard.js';
import { SCHEDULE_PROPOSE_TOOL_NAME } from '../agent/tools.js';
import { laneToolsFor, useBuilderChat, type BuilderChat, type LaneToolDeps } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
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

// The provider lane's builder is a spy returning [] (its own suite proves the tools).
vi.mock('../agent/providerTools.js', () => ({
  buildProviderTools: () => [],
  PROVIDER_REQUEST_TOOL_NAME: 'provider_request',
}));

/** The turns the recorder saw: the tools each was sent, and the handlers (for the builder set's hook). */
const sends: Array<{ tools: AgentTool[] | undefined; handlers: BuildHandlers }> = [];
/** Runs INSIDE the turn, with the tools it was sent — how a test drives `schedule_propose`. */
let drive: ((tools: AgentTool[] | undefined, handlers: BuildHandlers) => Promise<void>) | undefined;

vi.mock('../agent/builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/builder.js')>();
  return {
    ...actual,
    createDirectBuilder: () => ({
      send: async (turn: string | BuilderTurn, handlers: BuildHandlers) => {
        const tools = typeof turn === 'string' ? undefined : turn.tools;
        sends.push({ tools, handlers });
        await drive?.(tools, handlers);
        return { ok: true as const, text: 'done' };
      },
    }),
  };
});

const names = (tools: AgentTool[] | undefined): string[] | undefined => tools?.map((tool) => tool.def.name);

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
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Pocket Ledger', html: HTML, usesDb: true }).appId;
  await db.applyAppDdl(appId, ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, cents INTEGER)']);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
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
    expect(names(sends[0]?.tools)).toEqual(['data_query', 'present_card']);
    sends.length = 0;
    act(() => root?.unmount());
    intent = 'app_change';
    await sendAndSettle('make the total bold');
    expect(sends[0]?.tools, 'the feature lane passes no override — the builder set').toBeUndefined();
  });

  it('the answer lane sees the card alone; the provider lane its tool plus the card', async () => {
    intent = 'app_question';
    await sendAndSettle('what does this app do?');
    expect(names(sends[0]?.tools)).toEqual(['present_card']);
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
    };
    expect(names(await laneToolsFor({ lane: 'schedule', intent: 'schedule' }, deps))).toEqual([SCHEDULE_PROPOSE_TOOL_NAME]);
    expect(await laneToolsFor({ lane: 'feature', intent: 'app_change' }, deps)).toBeUndefined();
    expect(await laneToolsFor(undefined, deps)).toBeUndefined();
    expect(names(await laneToolsFor({ lane: 'answer', intent: 'other' }, deps))).toEqual(['present_card']);
    // The `never` default: a lane the type system does not know is not silently the builder set.
    const bogus = await laneToolsFor({ lane: 'bogus', intent: 'other' } as unknown as Parameters<typeof laneToolsFor>[0], deps);
    expect(bogus).not.toBeUndefined();
    expect(Array.isArray(bogus)).toBe(false);
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
