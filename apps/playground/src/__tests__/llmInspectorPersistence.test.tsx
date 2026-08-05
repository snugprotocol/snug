// llmInspectorPersistence.test.tsx — AC14's hard half: the LLM inspector is
// IN-MEMORY ONLY. The owner explicitly ruled out persisting audit/inspector data,
// so this asserts at the BYTE level — a turn's round-trip bodies must not appear
// anywhere in the exported user DB, and no new table may hold them.
//
// The sibling reducer tests (llmInspector.test.ts) cover the ring buffer and
// redaction; this one covers "it never reaches disk".

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from '../run/llmInspector.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A marker that only ever exists inside round-trip request/response bodies. */
const ROUND_TRIP_MARKER = 'ZZINSPECTORONLYMARKERZZ';

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
let db: UserDb;

function renderChat(): { chat: () => BuilderChat } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat('thr-inspector');
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  db = await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('LLM inspector persistence boundary (AC14)', () => {
  it('writes nothing from a turn’s round trips into the user DB bytes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        `event: step\ndata: {"phase":"start","tool":"snug_knowledge"}\n\n`,
        `event: delta\ndata: {"text":"visible reply"}\n\n`,
        `event: done\ndata: {"text":"visible reply"}\n\n`,
      ]),
    );
    const r = renderChat();
    act(() => {
      // The marker rides in the WIRE text only — never the display bubble.
      r.chat().send('build it', `build it ${ROUND_TRIP_MARKER}`);
    });
    await settle();
    await db.flush();

    const bytes = await db.exportUserDb({ includeSecrets: true });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(ROUND_TRIP_MARKER);
    // The legitimate chat content DID persist — proving the export is not simply empty.
    expect(text).toContain('visible reply');
  });

  it('a round trip fed through the inspector still reaches no storage', async () => {
    // The tests above run in subscription mode, where onRoundTrip never fires at all —
    // so on their own they would pass even against an inspector that wrote every round
    // trip to disk. This one feeds a round trip through the reducer directly, with the
    // marker in the request body, and then checks every storage surface.
    const state = llmInspectorReduce(initialLlmInspectorState as LlmInspectorState, {
      type: 'round_trip',
      index: 0,
      request: { system: `system ${ROUND_TRIP_MARKER}`, messages: [{ role: 'user', content: ROUND_TRIP_MARKER }] },
      response: { ok: true, text: ROUND_TRIP_MARKER, toolCalls: [], stopReason: 'end' },
      durationMs: 5,
    });
    expect(state.entries).toHaveLength(1); // it really was ingested

    await db.flush();
    const text = new TextDecoder().decode(await db.exportUserDb({ includeSecrets: true }));
    expect(text).not.toContain(ROUND_TRIP_MARKER);
    expect(JSON.stringify(localStorage)).not.toContain(ROUND_TRIP_MARKER);
    expect(JSON.stringify(sessionStorage)).not.toContain(ROUND_TRIP_MARKER);
  });

  it('adds no inspector table to the schema', async () => {
    await db.flush();
    const bytes = await db.exportUserDb();
    const text = new TextDecoder().decode(bytes);
    for (const forbidden of ['snug_llm_round_trips', 'snug_inspector', 'snug_round_trips', 'snug_llm_inspector']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('does not grow chat message meta with round-trip data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([`event: done\ndata: {"text":"ok"}\n\n`]),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('hello', `hello ${ROUND_TRIP_MARKER}`);
    });
    await settle();

    const persisted = db.listChatMessages('thr-inspector');
    expect(persisted.length).toBeGreaterThan(0);
    for (const message of persisted) {
      expect(JSON.stringify(message.meta ?? {})).not.toContain(ROUND_TRIP_MARKER);
      expect(JSON.stringify(message.meta ?? {})).not.toContain('roundTrip');
    }
  });
});
