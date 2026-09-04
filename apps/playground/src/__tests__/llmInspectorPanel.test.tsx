// Phase D of TASK-20260804-observability-caching: the round-trip surface's RENDER layer.
// The reducer half is llmInspectorLive.test.ts; this asserts what the user actually sees.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { LlmInspectorPanel } from '../run/LlmInspectorPanel.js';
import {
  initialLlmInspectorState,
  llmInspectorReduce,
  type LlmInspectorState,
} from '../run/llmInspector.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const state = (events: Parameters<typeof llmInspectorReduce>[1][]): LlmInspectorState =>
  events.reduce<LlmInspectorState>((s, e) => llmInspectorReduce(s, e), initialLlmInspectorState as LlmInspectorState);

const completed = (overrides: Record<string, unknown> = {}): Parameters<typeof llmInspectorReduce>[1] =>
  ({
    type: 'round_trip',
    index: 0,
    request: { system: 'SYSTEM PROMPT', messages: [{ role: 'user', content: 'hello' }] },
    response: { ok: true, text: 'a reply', toolCalls: [], stopReason: 'end' },
    durationMs: 1200,
    ...overrides,
  }) as Parameters<typeof llmInspectorReduce>[1];

function expandFirst(el: HTMLElement): void {
  const head = el.querySelector<HTMLButtonElement>('.llm-entry-head');
  act(() => head?.click());
}

describe('AC4 — the model name is shown', () => {
  it('renders the model the provider reported', () => {
    const el = mount(
      <LlmInspectorPanel
        state={state([
          completed({ response: { ok: true, text: 't', toolCalls: [], stopReason: 'end', model: 'claude-opus-5' } }),
        ])}
        mode="byok"
      />,
    );
    expect(el.textContent).toContain('claude-opus-5');
  });

  it('shows no model line at all when the provider did not report one — never a guess', () => {
    const el = mount(<LlmInspectorPanel state={state([completed()])} mode="byok" />);
    expect(el.querySelector('[data-testid="llm-model"]')).toBeNull();
  });
});

describe('AC8 — in-flight calls are visible with a live timer', () => {
  it('renders a pending round trip before any response exists', () => {
    const el = mount(
      <LlmInspectorPanel
        state={state([{ type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } }])}
        mode="byok"
      />,
    );
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="llm-pending"]')).not.toBeNull();
  });

  it('drops the pending marker once the round trip settles', () => {
    const el = mount(
      <LlmInspectorPanel
        state={state([
          { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
          completed(),
        ])}
        mode="byok"
      />,
    );
    expect(el.querySelector('[data-testid="llm-pending"]')).toBeNull();
    expect(el.textContent).toContain('1.2s');
  });
});

// TASK-20260813 AC7/AC8 — the render half of the stuck-timer bug.
//
// The adapters half (packages/adapters observability.test.ts) guarantees every started
// round trip gets a terminal event. These assert the PANEL does the right thing with
// it: the ticker must stop, and it must belong to the entry it started on.
//
// The existing AC8 tests above pass props built by hand and never re-render the same
// tree, so they could not see either defect. These drive one MOUNTED component through
// a real state transition — the lifecycle is the subject (docs/lessons.md 2026-08-05:
// "component tests that construct props by hand never exercise lifecycle").
describe('AC7/AC8 — the live timer belongs to its round trip and stops when it settles', () => {
  const start = (index: number): Parameters<typeof llmInspectorReduce>[1] =>
    ({ type: 'round_trip_start', index, request: { system: 's', messages: [] } }) as Parameters<
      typeof llmInspectorReduce
    >[1];

  it('AC7 — a settled entry stops ticking in a tree that stays mounted', () => {
    // The bug shape: the panel re-renders when the next call starts, and the PREVIOUS
    // entry keeps its live ticker. Render the same root twice, as the app does.
    const pending = state([start(0)]);
    const el = mount(<LlmInspectorPanel state={pending} mode="byok" />);
    expect(el.querySelectorAll('[data-testid="llm-pending"]')).toHaveLength(1);

    // Round trip 0 settles and round trip 1 opens — the exact moment described as
    // "it moves to the next llm call" while the old timer keeps running.
    const settledAndNext = state([start(0), completed({ index: 0 }), start(1)]);
    act(() => {
      root!.render(<LlmInspectorPanel state={settledAndNext} mode="byok" />);
    });

    // Exactly ONE ticker: the new call. The settled entry shows its frozen duration.
    const tickers = el.querySelectorAll('[data-testid="llm-pending"]');
    expect(tickers, 'a settled round trip must not keep a live timer').toHaveLength(1);
    expect(el.textContent).toContain('1.2s');
  });

  it('AC7 — an entry settled by a THROWN call stops ticking too', () => {
    // The adapter now reports a rejection as ok:false; the panel must treat that as
    // settled, not as still-running. Before the adapters fix this event never arrived.
    const el = mount(<LlmInspectorPanel state={state([start(0)])} mode="byok" />);
    expect(el.querySelectorAll('[data-testid="llm-pending"]')).toHaveLength(1);

    const crashed = state([
      start(0),
      completed({
        index: 0,
        response: { ok: false, code: 'HOST_ERROR', message: 'adapter threw: boom', retryable: false },
      }),
    ]);
    act(() => {
      root!.render(<LlmInspectorPanel state={crashed} mode="byok" />);
    });

    // The ticker is gone and the entry is marked failed. The collapsed head shows the
    // CODE; the thrown message lives in the expanded body, so assert each where it is.
    expect(el.querySelector('[data-testid="llm-pending"]')).toBeNull();
    expect(el.querySelector('.llm-entry.is-error')).not.toBeNull();
    expect(el.textContent).toContain('HOST_ERROR');
    expandFirst(el);
    expect(el.textContent).toContain('adapter threw: boom');
  });

  it('AC7 — the ticker measures the CALL, not its own mount, across a remount', () => {
    // The rail's tab strip unmounts this subtree. A mount-relative clock restarted a
    // long call's elapsed display at 0 every time the user switched tabs and came back,
    // which reads as "the timer is wrong" just as much as one that never stops.
    const pending = state([start(0)]);
    // Backdate the start by a wide margin so the rendered figure is unambiguous.
    const longRunning: LlmInspectorState = {
      ...pending,
      entries: pending.entries.map((e) => ({ ...e, startedAt: performance.now() - 90_000 })),
    };

    const el = mount(<LlmInspectorPanel state={longRunning} mode="byok" />);
    const first = el.querySelector('[data-testid="llm-pending"]')?.textContent ?? '';
    expect(first, 'a 90s call must not render as a fresh one').not.toMatch(/^\d+ms$/);

    // Unmount and remount the panel — the tab-switch the user actually performs.
    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => {
      root!.render(<LlmInspectorPanel state={longRunning} mode="byok" />);
    });

    const afterRemount = el.querySelector('[data-testid="llm-pending"]')?.textContent ?? '';
    expect(afterRemount, 'the ticker restarted at zero on remount').not.toMatch(/^\d+ms$/);
    // Still counting from the same origin: ~90s, not ~0s.
    expect(Number.parseFloat(afterRemount)).toBeGreaterThan(89);
  });

  it('AC8 — entries are keyed by round-trip identity, not array position', () => {
    // WHY THIS MATTERS: RoundTrip was keyed `${entry.index}-${arrayPosition}`. evict()
    // drops the oldest entries and SHIFTS every survivor's position, so an unchanged
    // entry silently changed key — React then reuses or remounts LiveTimer across
    // identity boundaries and a timer can end up under the wrong round trip.
    //
    // Asserted structurally rather than by counting renders: the key is not observable
    // from the DOM, so the guard is that a settled entry and a pending one keep their
    // own state when the list shifts underneath them.
    const many = state([start(0), completed({ index: 0 }), start(1), completed({ index: 1 }), start(2)]);
    const el = mount(<LlmInspectorPanel state={many} mode="byok" />);

    // Only round trip 2 is in flight.
    expect(el.querySelectorAll('[data-testid="llm-pending"]')).toHaveLength(1);
    const rows = el.querySelectorAll('[data-testid="llm-round-trip"]');
    expect(rows).toHaveLength(3);
    // The pending marker sits on the row of the round trip that actually started —
    // the NEWEST, which renders FIRST since TASK-20260903 AC13 (newest on top).
    expect(rows[0].querySelector('[data-testid="llm-pending"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-testid="llm-pending"]')).toBeNull();
    expect(rows[2].querySelector('[data-testid="llm-pending"]')).toBeNull();
  });

  it('AC8 — a pending entry keeps its ticker when an OLDER entry is dropped from the list', () => {
    // Simulates what evict() does: the same pending round trip, at a different array
    // position. Under the positional key this changed identity; under an identity key
    // it is the same element and its timer survives intact.
    const before = state([start(0), completed({ index: 0 }), start(1)]);
    const el = mount(<LlmInspectorPanel state={before} mode="byok" />);
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]')).toHaveLength(2);

    // Drop the oldest entry, keeping the pending one — now at position 0, not 1.
    const evicted: LlmInspectorState = { ...before, entries: before.entries.slice(1) };
    act(() => {
      root!.render(<LlmInspectorPanel state={evicted} mode="byok" />);
    });

    const rows = el.querySelectorAll('[data-testid="llm-round-trip"]');
    expect(rows).toHaveLength(1);
    // Still pending, still exactly one ticker — not transplanted, not duplicated.
    expect(el.querySelectorAll('[data-testid="llm-pending"]')).toHaveLength(1);
    expect(rows[0].querySelector('[data-testid="llm-pending"]')).not.toBeNull();
  });
});

describe('AC5 — tools nest under their round trip, each with its own time', () => {
  const withTool = state([
    { type: 'round_trip_start', index: 0, request: { system: 's', messages: [] } },
    completed(),
    { type: 'tool_call', call: { id: 't1', name: 'kb_lookup', input: {} }, roundTripIndex: 0 },
    {
      type: 'tool_result',
      call: { id: 't1', name: 'kb_lookup', input: {} },
      output: 'found it',
      roundTripIndex: 0,
      durationMs: 340,
    },
  ]);

  it('renders each tool nested under the round trip that requested it', () => {
    const el = mount(<LlmInspectorPanel state={withTool} mode="byok" />);
    const entry = el.querySelector('[data-testid="llm-round-trip"]');
    const tools = entry?.querySelectorAll('[data-testid="llm-tool"]');
    expect(tools).toHaveLength(1);
    expect(tools?.[0]?.textContent).toContain('kb_lookup');
  });

  it('shows each tool its own elapsed time', () => {
    const el = mount(<LlmInspectorPanel state={withTool} mode="byok" />);
    expect(el.querySelector('[data-testid="llm-tool"]')?.textContent).toContain('340ms');
  });

  it('still shows the round trip total alongside the nested tools', () => {
    const el = mount(<LlmInspectorPanel state={withTool} mode="byok" />);
    // The round trip keeps its own wall-clock; the tool time does not replace it.
    expect(el.textContent).toContain('1.2s');
  });
});

describe('AC6 — payloads collapse by default and expand to the complete body', () => {
  const big = `HEAD${'x'.repeat(20_000)}TAIL`;
  const bigState = state([completed({ request: { system: big, messages: [] } })]);

  it('does not render the body until expanded', () => {
    const el = mount(<LlmInspectorPanel state={bigState} mode="byok" />);
    expect(el.querySelector('.llm-entry-body')).toBeNull();
  });

  it('renders the COMPLETE payload when expanded — no truncation marker', () => {
    const el = mount(<LlmInspectorPanel state={bigState} mode="byok" />);
    expandFirst(el);
    const body = el.querySelector('.llm-entry-body')?.textContent ?? '';
    expect(body).toContain('HEAD');
    expect(body).toContain('TAIL'); // the tail proves it is whole, not a prefix
    expect(body).not.toContain('truncated');
  });

  it('labels each section with its byte size', () => {
    const el = mount(<LlmInspectorPanel state={bigState} mode="byok" />);
    expandFirst(el);
    const sent = el.querySelector('[data-testid="llm-sent-size"]')?.textContent ?? '';
    expect(sent).toMatch(/KB|B/);
    expect(el.querySelector('[data-testid="llm-received-size"]')).not.toBeNull();
  });
});

describe('AC13 — cached % is shown only when the provider reported caching', () => {
  it('renders a cached percentage when cache reads were reported', () => {
    const el = mount(
      <LlmInspectorPanel
        state={state([
          completed({
            response: {
              ok: true,
              text: 't',
              toolCalls: [],
              stopReason: 'end',
              // 900 of 1000 input tokens served from cache -> 90%.
              usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 },
            },
          }),
        ])}
        mode="byok"
      />,
    );
    expect(el.querySelector('[data-testid="llm-cached"]')?.textContent).toContain('90');
  });

  it('shows NOTHING — not "0%" — when the provider did not report caching', () => {
    const el = mount(
      <LlmInspectorPanel
        state={state([
          completed({
            response: {
              ok: true,
              text: 't',
              toolCalls: [],
              stopReason: 'end',
              usage: { inputTokens: 100, outputTokens: 10 },
            },
          }),
        ])}
        mode="byok"
      />,
    );
    // The absent-not-zero rule: "0% cached" would be a claim the provider never made.
    expect(el.querySelector('[data-testid="llm-cached"]')).toBeNull();
    expect(el.textContent).not.toContain('0% cached');
  });

  it('shows 0% when the provider genuinely reported a cache write and no read', () => {
    const el = mount(
      <LlmInspectorPanel
        state={state([
          completed({
            response: {
              ok: true,
              text: 't',
              toolCalls: [],
              stopReason: 'end',
              // A cache WRITE with no read is a real, reportable 0% hit — distinct from silence.
              usage: { inputTokens: 1000, outputTokens: 10, cacheCreationTokens: 900, cacheReadTokens: 0 },
            },
          }),
        ])}
        mode="byok"
      />,
    );
    expect(el.querySelector('[data-testid="llm-cached"]')).not.toBeNull();
  });
});

describe('newest first (TASK-20260903 AC13)', () => {
  it('renders the most recent round trip at the TOP, so the latest progress is in view without scrolling', () => {
    const start = (index: number): Parameters<typeof llmInspectorReduce>[1] =>
      ({ type: 'round_trip_start', index, request: { system: 's', messages: [] } }) as Parameters<
        typeof llmInspectorReduce
      >[1];
    const el = mount(
      <LlmInspectorPanel
        state={state([start(0), completed({ index: 0, response: { ok: true, text: 'first', toolCalls: [], stopReason: 'end' } }), start(1)])}
        mode="byok"
      />,
    );
    const rows = [...el.querySelectorAll('[data-testid="llm-round-trip"]')];
    expect(rows).toHaveLength(2);
    // The pending (newest) entry is first in DOM order; the settled one below it.
    expect(rows[0]?.querySelector('[data-testid="llm-pending"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-testid="llm-pending"]')).toBeNull();
  });
});

