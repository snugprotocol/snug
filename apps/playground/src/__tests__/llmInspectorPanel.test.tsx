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
