// buildSteps.test.tsx — the build step timeline (TASK-20260803-hub-ops AC9, AC10, AC12).
//
// Replaces the single last-write-wins `activity` pill with an ORDERED, LIVE timeline:
// a step starts, later completes, and streaming keeps flowing while steps advance.
// Covers all three layers of the seam: the builder event source (both modes), the
// useBuilderChat steps model, and the ChatLog component (which had no test at all).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerBuilder, type BuildStep } from '../agent/builder.js';
import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { modeStore } from '../state/mode.js';
import { ChatLog } from '../views/ChatLog.js';
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

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function renderChat(): { chat: () => BuilderChat } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat('thr-steps');
    return <span />;
  }
  mount(<Harness />);
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
  await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

// ------------------------------------------------------- the event source (AC11)

describe('createServerBuilder step events', () => {
  it('surfaces the server SSE step event as start/end for a named tool (AC11)', async () => {
    const fetchSpy = vi.fn(async () =>
      sseResponse([
        'event: step\ndata: {"phase":"start","tool":"snug_knowledge"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"snug_knowledge"}\n\n',
        'event: step\ndata: {"phase":"start","tool":"artifact_write"}\n\n',
        'event: done\ndata: {"text":"done"}\n\n',
      ]),
    );
    const steps: BuildStep[] = [];
    const result = await createServerBuilder('thr-1', fetchSpy).send(
      'build it',
      { onStep: (step) => steps.push(step) },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, text: 'done' });
    expect(steps).toEqual([
      { tool: 'snug_knowledge', phase: 'start' },
      { tool: 'snug_knowledge', phase: 'end' },
      { tool: 'artifact_write', phase: 'start' },
    ]);
  });

  it('ignores a malformed step event without killing the stream', async () => {
    const fetchSpy = vi.fn(async () =>
      sseResponse([
        'event: step\ndata: {"phase":"start"}\n\n', // no tool name
        'event: step\ndata: {"phase":"start","tool":"schema_apply"}\n\n',
        'event: done\ndata: {"text":"ok"}\n\n',
      ]),
    );
    const steps: BuildStep[] = [];
    await createServerBuilder('thr-1', fetchSpy).send('x', { onStep: (s) => steps.push(s) }, new AbortController().signal);
    expect(steps).toEqual([{ tool: 'schema_apply', phase: 'start' }]);
  });
});

// ------------------------------------------------- the steps model (AC9, AC10, AC12)

describe('useBuilderChat step timeline', () => {
  it('builds an ORDERED timeline instead of one last-write-wins slot (AC9)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'event: step\ndata: {"phase":"start","tool":"snug_knowledge"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"snug_knowledge"}\n\n',
        'event: step\ndata: {"phase":"start","tool":"schema_apply"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"schema_apply"}\n\n',
        'event: step\ndata: {"phase":"start","tool":"artifact_write"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"artifact_write"}\n\n',
        'event: step\ndata: {"phase":"start","tool":"app_doc_write"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"app_doc_write"}\n\n',
      ]),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('build me a chess app');
    });
    await settle();
    // Every step is retained, in order — not collapsed into the latest one.
    expect(r.chat().steps.map((s) => s.tool)).toEqual([
      'snug_knowledge',
      'schema_apply',
      'artifact_write',
      'app_doc_write',
    ]);
    expect(r.chat().steps.every((s) => s.label !== '')).toBe(true);
  });

  it('marks a step DONE on tool_result rather than ignoring it (AC10)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'event: step\ndata: {"phase":"start","tool":"snug_knowledge"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"snug_knowledge"}\n\n',
        'event: step\ndata: {"phase":"start","tool":"artifact_write"}\n\n',
      ]),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('build it');
    });
    await settle();
    const steps = r.chat().steps;
    expect(steps.find((s) => s.tool === 'snug_knowledge')?.done).toBe(true);
    // The still-running one stays open — that is what the spinner hangs off.
    expect(steps.find((s) => s.tool === 'artifact_write')?.done).toBe(false);
  });

  it('keeps streaming deltas into the message while steps advance (AC12)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'event: delta\ndata: {"text":"let me "}\n\n',
        'event: step\ndata: {"phase":"start","tool":"snug_knowledge"}\n\n',
        'event: delta\ndata: {"text":"check the docs"}\n\n',
        'event: step\ndata: {"phase":"end","tool":"snug_knowledge"}\n\n',
        'event: done\ndata: {}\n\n',
      ]),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('build it');
    });
    await settle();
    // Deltas before AND after a step both landed — a step no longer clears the stream.
    expect(r.chat().messages.find((m) => m.role === 'agent')?.displayText).toBe('let me check the docs');
    expect(r.chat().steps).toHaveLength(1);
  });

  it('clears the timeline when the next turn starts (AC9)', async () => {
    // A fresh Response per call: a ReadableStream body is single-use, so a shared
    // mockResolvedValue would hand the second turn an already-drained stream.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      sseResponse(['event: step\ndata: {"phase":"start","tool":"schema_apply"}\n\n', 'event: done\ndata: {"text":"a"}\n\n']),
    );
    const r = renderChat();
    act(() => {
      r.chat().send('first');
    });
    await settle();
    expect(r.chat().steps).toHaveLength(1);
    // The turn must have fully settled (busy released) before the next send is accepted.
    expect(r.chat().busy).toBe(false);
    act(() => {
      r.chat().send('second');
    });
    await settle();
    // One step from the SECOND turn, not two accumulated across turns.
    expect(r.chat().steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------- the component (AC9)

describe('ChatLog step timeline rendering', () => {
  const steps: BuildStep[] = [
    { tool: 'snug_knowledge', label: 'consulting the knowledge base…', done: true },
    { tool: 'schema_apply', label: 'designing the app’s database…', done: true },
    { tool: 'artifact_write', label: 'writing the app file…', done: false },
  ];

  it('renders the steps in order with completion state (AC9, AC10)', () => {
    const el = mount(
      <MemoryRouter>
        <ChatLog messages={[{ id: 1, role: 'agent', displayText: 'working', streaming: true }]} steps={steps} />
      </MemoryRouter>,
    );
    const items = [...el.querySelectorAll('[data-testid="build-step"]')];
    expect(items).toHaveLength(3);
    expect(items.map((n) => n.textContent)).toEqual([
      expect.stringContaining('knowledge base'),
      expect.stringContaining('database'),
      expect.stringContaining('app file'),
    ]);
    // Completion is visible, not just modelled.
    expect(items[0]?.getAttribute('data-done')).toBe('true');
    expect(items[2]?.getAttribute('data-done')).toBe('false');
  });

  it('renders nothing extra when there are no steps', () => {
    const el = mount(
      <MemoryRouter>
        <ChatLog messages={[{ id: 1, role: 'agent', displayText: 'hi' }]} steps={[]} />
      </MemoryRouter>,
    );
    expect(el.querySelectorAll('[data-testid="build-step"]')).toHaveLength(0);
  });

  it('renders the streamed text and the timeline at the same time (AC12)', () => {
    const el = mount(
      <MemoryRouter>
        <ChatLog messages={[{ id: 1, role: 'agent', displayText: 'let me check the docs', streaming: true }]} steps={steps} />
      </MemoryRouter>,
    );
    expect(el.textContent).toContain('let me check the docs');
    expect(el.querySelectorAll('[data-testid="build-step"]')).toHaveLength(3);
  });
});
