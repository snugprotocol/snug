/**
 * TASK-20260811-lean-runtime-data-chat, P3 — the router stage's TURN-LIFECYCLE
 * obligations (fold F-M4).
 *
 * The router's routing rules are tested in `chatRouter.test.ts`. This file tests the
 * things a new stage inside `send()` can break that have nothing to do with routing:
 *
 *  (a) ABORT — the classifier takes the turn's signal, so stop cancels it (unmount no
 *      longer does — ADR-0062: the turn belongs to the thread session, not the view).
 *  (b) SETTLEMENT + PERSISTENCE — the clarify path settles the already-rendered streaming
 *      placeholder AND persists the exchange. A stage that returns early without doing
 *      both leaves a forever-spinner that also vanishes on reload.
 *  (c) ERROR LANE — a thrown classifier error routes to clarify, never to the outer
 *      TURN_FAILED catch, so a routing bug never masquerades as a model failure.
 *
 * These are asserted at the HOOK because that is where the obligations live.
 */

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

const HTML = '<!DOCTYPE html><html><body>ledger</body></html>';
const THREAD = 'app:router-lifecycle';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: Awaited<ReturnType<typeof installTestUserDb>>;
let appId: string;

/** What the stubbed classifier adapter should do on its next call. */
let classifierBehavior: 'clarify' | 'throw' | 'hang' | 'provider_read' | 'provider_write' = 'clarify';
let sawSignal: AbortSignal | undefined;

/**
 * Call-site spy for the provider lane's tool builder (TASK-20260815). The module's own
 * suite proves the tools; THIS file proves the hook actually builds them for a provider
 * route with the right write posture — "logic is correct" and "logic runs" are separate
 * claims (lesson 2026-08-08). Returns [] so the turn proceeds tool-free; the assertion
 * is the CALL and its arguments, not the turn outcome.
 */
const buildProviderToolsSpy = vi.fn<(options: unknown) => unknown[]>(() => []);
vi.mock('../agent/providerTools.js', () => ({
  buildProviderTools: (options: unknown) => buildProviderToolsSpy(options),
  PROVIDER_REQUEST_TOOL_NAME: 'provider_request',
}));

// NOT spread from importOriginal: the real module resolves a live adapter from the
// settings ladder, and on the first call in a fresh module graph it answered `ok:false`
// (no key configured), so the router silently skipped. The stub is total and
// deterministic — this file tests the LIFECYCLE, and the ladder has its own tests.
vi.mock('../agent/inferrerAdapter.js', () => {
  return {
    completeWithAdapter: () => async () => ({ ok: true as const, text: '{}' }),
    liveInferenceAdapter: async () => ({
      ok: true as const,
      adapter: {
        complete: async (request: { signal?: AbortSignal }) => {
          sawSignal = request.signal;
          if (classifierBehavior === 'throw') throw new Error('classifier exploded');
          if (classifierBehavior === 'hang') {
            return await new Promise((_resolve, reject) => {
              request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
          }
          if (classifierBehavior === 'provider_read' || classifierBehavior === 'provider_write') {
            return {
              ok: true as const,
              text: `{"intent":"${classifierBehavior}","confidence":0.9}`,
              toolCalls: [],
              stopReason: 'end' as const,
            };
          }
          return {
            ok: true as const,
            // A clarification is the cheapest lane to assert: it settles inside the
            // router stage without running a builder turn at all.
            text: '{"intent":"data_write","confidence":0.9,"clarification":"Rows or feature?"}',
            toolCalls: [],
            stopReason: 'end' as const,
          };
        },
      },
    }),
  };
});

function renderChat(): { chat: () => BuilderChat; unmount: () => void } {
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
    unmount: () => {
      act(() => root?.unmount());
      root = undefined;
    },
  };
}

/** Let queued microtasks and effects flush. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  classifierBehavior = 'clarify';
  sawSignal = undefined;
  buildProviderToolsSpy.mockClear();
  modeStore.set('byok');
  db = await installTestUserDb();
  const app = db.installApp({ displayName: 'Pocket Ledger', html: HTML });
  appId = app.appId;
  await db.applyAppDdl(appId, ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, cents INTEGER)']);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe('F-M4b — the clarify path settles the placeholder AND persists', () => {
  it('renders the clarifying question and stops spinning', async () => {
    const { chat } = renderChat();

    act(() => chat().send('drop the gym habit'));
    await settle();

    const agentMessage = chat().messages.find((message) => message.role === 'agent');
    expect(agentMessage?.displayText).toBe('Rows or feature?');
    expect(agentMessage?.streaming, 'a settled message must not still be streaming').toBeFalsy();
    expect(chat().busy, 'the turn must not stay busy').toBe(false);
  });

  it('persists BOTH sides, so the exchange survives a reload', async () => {
    const { chat } = renderChat();

    act(() => chat().send('drop the gym habit'));
    await settle();

    const persisted = db.listChatMessages(THREAD);
    expect(persisted.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(persisted[1]?.content).toBe('Rows or feature?');
  });

  it('runs NO builder turn — clarifying must not cost a rebuild', async () => {
    const { chat } = renderChat();

    act(() => chat().send('drop the gym habit'));
    await settle();

    // A builder turn would have produced steps and/or an artifact.
    expect(chat().steps).toHaveLength(0);
    expect(chat().lastArtifact).toBeUndefined();
  });
});

describe('F-M4a — the classifier takes the turn’s abort signal', () => {
  it('passes a live signal into the classifier turn', async () => {
    const { chat } = renderChat();

    act(() => chat().send('how much did I spend?'));
    await settle();

    expect(sawSignal, 'the classifier must receive the turn signal').toBeDefined();
    expect(sawSignal?.aborted).toBe(false);
  });

  it('stop() aborts a classifier still in flight', async () => {
    classifierBehavior = 'hang';
    const { chat } = renderChat();

    act(() => chat().send('how much did I spend?'));
    await settle();
    expect(sawSignal?.aborted).toBe(false);

    act(() => chat().stop());
    await settle();

    expect(sawSignal?.aborted, 'stop must reach the classifier').toBe(true);
  });

  /**
   * INVERTED by ADR-0062 (TASK-20260903-build-thread-continuity): the turn — classifier
   * included — belongs to the thread session, not to the view. Leaving the view leaves the
   * request RUNNING; the explicit stop (through the session) is what cancels it.
   */
  it('unmounting does NOT abort a classifier still in flight — stop does (ADR-0062)', async () => {
    classifierBehavior = 'hang';
    const { chat, unmount } = renderChat();

    act(() => chat().send('how much did I spend?'));
    await settle();

    unmount();
    await settle();

    expect(sawSignal?.aborted, 'leaving the view must not cancel the turn').toBe(false);
    stopThread(THREAD);
    expect(sawSignal?.aborted, 'the explicit stop must still reach the classifier').toBe(true);
  });

  /**
   * R-M3 (2026-08-11): the adapters collapse a user abort into the same `ok:false` a model
   * failure produces, and `routeChatMessage` maps every `ok:false` to the clarify lane —
   * which PERSISTS both sides. So cancelling a turn wrote a canned assistant reply the
   * model never produced, attributed to it, and durable.
   *
   * Second-order and worse: that fabricated pair becomes real history, so it steers the
   * NEXT turn's classifier and the app-turn context. A cancelled turn must leave no trace
   * beyond the settled placeholder — which is exactly how every other cancellation in this
   * hook behaves.
   *
   * The assertion is on what was PERSISTED, not on signal propagation (the test above
   * already covers that) — persistence is where the defect actually lived.
   */
  it('a turn cancelled DURING classification persists nothing (R-M3)', async () => {
    classifierBehavior = 'hang';
    const { chat } = renderChat();

    act(() => chat().send('how much did I spend on food?'));
    await settle();
    act(() => chat().stop());
    await settle();

    expect(
      db.listChatMessages(THREAD),
      'a cancelled turn must not invent an assistant reply',
    ).toHaveLength(0);
  });

  it('stops spinning when cancelled during classification (no forever-placeholder)', async () => {
    classifierBehavior = 'hang';
    const { chat } = renderChat();

    act(() => chat().send('how much did I spend on food?'));
    await settle();
    act(() => chat().stop());
    await settle();

    expect(chat().messages.some((m) => m.streaming === true)).toBe(false);
  });
});

describe('TASK-20260815 — a provider route WIRES the provider tools with the right posture', () => {
  it('provider_read builds the tools read-only, bound to the pinned app', async () => {
    classifierBehavior = 'provider_read';
    const { chat } = renderChat();
    await act(async () => {
      chat().send('which song did I play most last week?');
    });
    await settle();
    expect(buildProviderToolsSpy).toHaveBeenCalledTimes(1);
    expect(buildProviderToolsSpy.mock.calls[0]?.[0]).toMatchObject({ appId, allowWrites: false });
  });

  it('provider_write unlocks mutating methods and threads the turn abort signal', async () => {
    classifierBehavior = 'provider_write';
    const { chat } = renderChat();
    await act(async () => {
      chat().send('make a playlist from my top tracks');
    });
    await settle();
    expect(buildProviderToolsSpy).toHaveBeenCalledTimes(1);
    const options = buildProviderToolsSpy.mock.calls[0]?.[0] as
      | { allowWrites?: boolean; signal?: AbortSignal }
      | undefined;
    expect(options?.allowWrites).toBe(true);
    // The abort seam must be THIS turn's signal — it is what lets a cancelled turn deny
    // its own parked confirm (AC6); an absent signal disables that silently.
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('F-M4c — a thrown classifier error routes to clarify, not to TURN_FAILED', () => {
  it('shows a clarifying reply rather than a turn-failure error', async () => {
    classifierBehavior = 'throw';
    const { chat } = renderChat();

    act(() => chat().send('how much did I spend?'));
    await settle();

    const agentMessage = chat().messages.find((message) => message.role === 'agent');
    expect(agentMessage?.error, 'a routing failure must not render as a model failure').toBeUndefined();
    expect(agentMessage?.displayText).toMatch(/data|app/i);
    expect(agentMessage?.streaming).toBeFalsy();
    expect(chat().busy).toBe(false);
  });
});
