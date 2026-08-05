// builderObservability.test.tsx — TASK-20260804-hub-polish, Phase F.
//
// AC13 — BuilderView renders the LLM round-trip surface, fed the same way RunView
//        feeds it (onLlmEvent + onTurnStart passed into useBuilderChat). Today
//        BuilderView calls useBuilderChat(threadId) with NO options, so round trips
//        are silently DROPPED — that is the item-10 bug.
// AC14 — nothing from the round-trip surface reaches the user DB, localStorage or
//        sessionStorage, asserted at the BYTE level with a round trip fed through the
//        reducer FOR REAL (the sibling llmInspectorPersistence test was found vacuous
//        in the previous task because subscription mode never fires onLlmEvent).
// AC15 — the round-trip surface AND the docs panel say WHY they are empty in a mode
//        that cannot produce their data, and what to switch to. The copy branches on
//        the MODE VALUE, not a hardcoded string (task R4).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { DocsPanel } from '../run/DocsPanel.js';
import { LlmInspectorPanel } from '../run/LlmInspectorPanel.js';
import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from '../run/llmInspector.js';
import { modeStore, type PlaygroundMode } from '../state/mode.js';
import { BuilderView } from '../views/BuilderView.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A marker that only ever exists inside round-trip request/response bodies. */
const BUILDER_MARKER = 'ZZBUILDERTRIPMARKERZZ';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

function mount(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function mountBuilder(): HTMLDivElement {
  return mount(
    <MemoryRouter initialEntries={['/build']}>
      <BuilderView />
    </MemoryRouter>,
  );
}

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

async function settle(ms = 5): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('byok');
  db = await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

// ------------------------------------------------------- AC13: the surface exists

describe('BuilderView round-trip surface (AC13)', () => {
  it('renders the round-trip surface', () => {
    const el = mountBuilder();
    expect(el.querySelector('[data-testid="builder-llm"]')).not.toBeNull();
  });

  it('feeds useBuilderChat an onLlmEvent AND an onTurnStart handler', async () => {
    // The item-10 bug, asserted at the seam: BuilderView must pass BOTH callbacks. A
    // spy on the hook proves it, since the handlers are otherwise unobservable until a
    // real round trip flows.
    const hook = await import('../agent/useBuilderChat.js');
    const spy = vi.spyOn(hook, 'useBuilderChat');
    mountBuilder();
    expect(spy).toHaveBeenCalled();
    const options = spy.mock.calls[0]?.[1];
    expect(options, 'BuilderView called useBuilderChat with no options object').toBeDefined();
    expect(typeof options?.onLlmEvent).toBe('function');
    expect(typeof options?.onTurnStart).toBe('function');
  });

  it('keeps the handlers referentially stable across re-renders', async () => {
    // useBuilderChat's send() dep array includes them: inline arrows would recreate
    // send() every render and churn every consumer.
    const hook = await import('../agent/useBuilderChat.js');
    const spy = vi.spyOn(hook, 'useBuilderChat');
    const el = mountBuilder();
    const first = spy.mock.calls.at(-1)?.[1];
    // Force a re-render through real UI state (the composer's draft).
    const textarea = el.querySelector('textarea');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'a new idea');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const latest = spy.mock.calls.at(-1)?.[1];
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(latest?.onLlmEvent).toBe(first?.onLlmEvent);
    expect(latest?.onTurnStart).toBe(first?.onTurnStart);
  });

  it('renders round trips the handler receives, and clears them on the next turn', async () => {
    const hook = await import('../agent/useBuilderChat.js');
    const spy = vi.spyOn(hook, 'useBuilderChat');
    const el = mountBuilder();
    const options = spy.mock.calls[0]?.[1];

    act(() => {
      options?.onLlmEvent?.({
        type: 'round_trip',
        index: 0,
        request: { system: 'you are snug', messages: [{ role: 'user', content: 'hi' }] },
        response: { ok: true, text: 'hello', toolCalls: [], stopReason: 'end' },
        durationMs: 30,
      });
    });
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]')).toHaveLength(1);

    act(() => {
      options?.onTurnStart?.();
    });
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]')).toHaveLength(0);
  });
});

// --------------------------------------------- AC14: nothing reaches any storage

describe('builder round trips reach no storage (AC14)', () => {
  it('a round trip fed through the builder surface for real leaves no bytes anywhere', async () => {
    const hook = await import('../agent/useBuilderChat.js');
    const spy = vi.spyOn(hook, 'useBuilderChat');
    const el = mountBuilder();
    const options = spy.mock.calls[0]?.[1];
    expect(typeof options?.onLlmEvent).toBe('function');

    act(() => {
      options!.onLlmEvent!({
        type: 'round_trip',
        index: 0,
        request: {
          system: `system ${BUILDER_MARKER}`,
          messages: [{ role: 'user', content: `build ${BUILDER_MARKER}` }],
        },
        response: { ok: true, text: `built ${BUILDER_MARKER}`, toolCalls: [], stopReason: 'end' },
        durationMs: 7,
      });
    });
    // It really was ingested and rendered — otherwise the negatives below are vacuous.
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]')).toHaveLength(1);
    act(() => {
      el.querySelector<HTMLButtonElement>('.llm-entry-head')?.click();
    });
    expect(el.textContent).toContain(BUILDER_MARKER);

    await settle();
    await db.flush();
    const text = new TextDecoder().decode(await db.exportUserDb({ includeSecrets: true }));
    expect(text).not.toContain(BUILDER_MARKER);
    expect(JSON.stringify(localStorage)).not.toContain(BUILDER_MARKER);
    expect(JSON.stringify(sessionStorage)).not.toContain(BUILDER_MARKER);
  });

  it('a builder turn persists its chat text but not the round-trip bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      sseResponse([`event: done\ndata: {"text":"visible builder reply"}\n\n`]),
    );
    modeStore.set('subscription');
    const hook = await import('../agent/useBuilderChat.js');
    const spy = vi.spyOn(hook, 'useBuilderChat');
    const el = mountBuilder();
    const options = spy.mock.calls[0]?.[1];

    const textarea = el.querySelector('textarea');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'build me a thing');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('.composer button')?.click();
    });
    await settle(20);

    // The round trip arrives through the handler the same way a direct-mode turn would.
    act(() => {
      options!.onLlmEvent!({
        type: 'round_trip',
        index: 0,
        request: { system: BUILDER_MARKER, messages: [] },
        response: { ok: true, text: BUILDER_MARKER, toolCalls: [], stopReason: 'end' },
        durationMs: 3,
      });
    });
    await settle();
    await db.flush();

    const text = new TextDecoder().decode(await db.exportUserDb({ includeSecrets: true }));
    expect(text).toContain('build me a thing'); // the export is not simply empty
    expect(text).not.toContain(BUILDER_MARKER);
  });

  it('adds no round-trip table to the builder’s schema', async () => {
    await db.flush();
    const text = new TextDecoder().decode(await db.exportUserDb());
    for (const forbidden of ['snug_llm_round_trips', 'snug_builder_inspector', 'snug_round_trips']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

// ------------------------------------------------- AC15: mode-aware empty states

const ALL_MODES: PlaygroundMode[] = ['byok', 'local', 'subscription'];

describe('mode-aware empty states (AC15)', () => {
  it('the round-trip empty state no longer claims every call shows up here', () => {
    // The old copy is false in subscription mode: the server forwards tool name+phase
    // only and keeps round_trip server-side (invoke.ts).
    for (const mode of ALL_MODES) {
      const el = mount(<LlmInspectorPanel state={initialLlmInspectorState as LlmInspectorState} mode={mode} />);
      expect(el.textContent).not.toContain('every call to the model shows up here');
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    }
  });

  it('in subscription mode the round-trip empty state says WHY and what to switch to', () => {
    const el = mount(<LlmInspectorPanel state={initialLlmInspectorState as LlmInspectorState} mode="subscription" />);
    const text = el.textContent ?? '';
    expect(text.toLowerCase()).toContain('subscription');
    // It names an alternative mode the user can switch to.
    expect(/byok|local|your own key/i.test(text)).toBe(true);
  });

  it('in a direct mode the round-trip empty state promises data instead of explaining absence', () => {
    for (const mode of ['byok', 'local'] as const) {
      const el = mount(<LlmInspectorPanel state={initialLlmInspectorState as LlmInspectorState} mode={mode} />);
      const text = (el.textContent ?? '').toLowerCase();
      expect(text).not.toContain('subscription mode');
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    }
  });

  it('the copy BRANCHES on the mode value — the three modes are not all the same string', () => {
    // R4: if subscription later gains round trips, the wrong copy must not silently
    // persist. A hardcoded string would make all three identical.
    const texts = ALL_MODES.map((mode) => {
      const el = mount(<LlmInspectorPanel state={initialLlmInspectorState as LlmInspectorState} mode={mode} />);
      const text = el.textContent ?? '';
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
      return text;
    });
    expect(new Set(texts).size).toBeGreaterThan(1);
  });

  it('the docs empty state explains that subscription mode cannot write docs', () => {
    const el = mount(<DocsPanel appId="app-1" refreshToken={0} mode="subscription" />);
    const text = el.textContent ?? '';
    expect(text).not.toBe('');
    expect(text.toLowerCase()).toContain('subscription');
    expect(/byok|local|your own key/i.test(text)).toBe(true);
  });

  it('the docs empty state differs between subscription and a direct mode', () => {
    const el = mount(<DocsPanel appId="app-1" refreshToken={0} mode="subscription" />);
    const subscription = el.textContent ?? '';
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;

    const el2 = mount(<DocsPanel appId="app-1" refreshToken={0} mode="byok" />);
    const byok = el2.textContent ?? '';
    expect(byok).not.toBe(subscription);
    expect(byok.toLowerCase()).not.toContain('subscription mode');
  });

  it('a populated surface shows data, never the empty copy, in any mode', () => {
    const populated = llmInspectorReduce(initialLlmInspectorState as LlmInspectorState, {
      type: 'round_trip',
      index: 0,
      request: { system: 's', messages: [] },
      response: { ok: true, text: 't', toolCalls: [], stopReason: 'end' },
      durationMs: 1,
    });
    const el = mount(<LlmInspectorPanel state={populated} mode="subscription" />);
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]')).toHaveLength(1);
    expect((el.textContent ?? '').toLowerCase()).not.toContain('nothing to show');
  });
});

/**
 * ADVERSARIAL-REVIEW FIX (2026-08-04) — the R4 hole, one level up.
 *
 * Every AC15 test above passes `mode` as a LITERAL straight into the leaf component,
 * so nothing asserted that the real views pass the LIVE mode. The reviewer hardcoded
 * `mode="byok"` at all three call sites (BuilderView's LlmInspectorPanel, RunView's
 * ThinkPanel and DocsPanel) and the whole suite stayed GREEN.
 *
 * That is exactly R4: a refactor drops the `useMode()` wiring and a subscription user
 * is told "your browser calls the model directly in byok mode" — the misleading copy
 * AC15 exists to delete. A wrong literal is as silent as a wrong default, so the seam
 * itself needs a test, not just the leaf.
 */
describe('the live mode reaches the empty-state copy through the real view (AC15 seam, R4)', () => {
  it('BuilderView renders SUBSCRIPTION copy when the mode store says subscription', async () => {
    modeStore.set('subscription' as PlaygroundMode);
    const el = mount(
      <MemoryRouter>
        <BuilderView />
      </MemoryRouter>,
    );
    await act(async () => { await Promise.resolve(); });
    const text = (el.textContent ?? '').toLowerCase();
    // The subscription copy explains the hub keeps round trips server-side; the byok
    // copy claims the browser calls the model directly. Asserting the ABSENCE of the
    // byok claim is what catches a hardcoded mode= at the call site.
    expect(text).toContain('subscription');
    expect(text, 'byok copy in subscription mode is the exact R4 regression').not.toContain(
      'your browser calls the model directly',
    );
  });

  it('BuilderView renders BYOK copy when the mode store says byok (the other direction)', async () => {
    modeStore.set('byok' as PlaygroundMode);
    const el = mount(
      <MemoryRouter>
        <BuilderView />
      </MemoryRouter>,
    );
    await act(async () => { await Promise.resolve(); });
    const text = (el.textContent ?? '').toLowerCase();
    // Both directions matter: a call site hardcoded to 'subscription' would pass the
    // test above and fail here, and vice versa. One direction alone is half a guard.
    expect(text).not.toContain('only your hub sees them');
  });
});
