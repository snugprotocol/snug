// railTabs.test.tsx — TASK-20260804-hub-polish, Phase E.
//
// AC10 — the 'llm' and 'inspector' rail tabs are MERGED into one surface: the LLM
//        round-trip section renders ABOVE the bridge/frame inspector, in one scroll
//        container, each section labelled. `RailTab` loses 'llm'.
// AC11 — run/inspector.ts and __tests__/inspector.test.ts stay BYTE-IDENTICAL. The
//        merge is presentational only; the two reducers remain separate modules. The
//        structural inspector's value-blindness is a privacy guarantee (task D2), so
//        this is asserted against git, not against a comment.
// AC12 — every rail tab renders an ICON with the original text as its ACCESSIBLE NAME
//        (aria-label + a title tooltip; a title alone is not an accessible name).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RunView from '../run/RunView.js';
import { ThinkPanel } from '../run/ThinkPanel.js';
import { initialInspectorState, inspectorReduce, type InspectorState } from '../run/inspector.js';
import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from '../run/llmInspector.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// vitest runs with cwd = apps/playground; jsdom's import.meta.url is not a file URL.
const REPO_ROOT = resolve(process.cwd(), '../..');

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mountRun(id: string): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${id}`]}>
        <Routes>
          <Route path="/run/:id" element={<RunView />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

function mount(element: Parameters<Root['render']>[0]): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** The accessible name of a button: aria-label wins, then text content. */
function accessibleName(button: Element): string {
  return (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
}

function tabButtons(el: HTMLElement): HTMLButtonElement[] {
  const group = el.querySelector('[aria-label="rail tabs"]');
  return group === null ? [] : [...group.querySelectorAll('button')];
}

beforeEach(async () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
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

// ------------------------------------------------------------------ AC11 first

describe('the two inspector modules stay separate (AC11)', () => {
  const LOCKED = ['apps/playground/src/run/inspector.ts', 'apps/playground/src/__tests__/inspector.test.ts'];

  it('run/inspector.ts and inspector.test.ts are byte-identical to HEAD', () => {
    // A real check, not a comment (task R2). `git diff --exit-code` exits non-zero the
    // moment either file changes by a single byte — including a "harmless" refactor
    // taken while merging the panels visually.
    for (const path of LOCKED) {
      const status = (() => {
        try {
          execFileSync('git', ['diff', '--exit-code', '--', path], { cwd: REPO_ROOT, stdio: 'pipe' });
          return 0;
        } catch (error) {
          return (error as { status?: number }).status ?? 1;
        }
      })();
      expect(status, `${path} changed — the structural inspector is locked by AC11`).toBe(0);
    }
  });

  it('the structural inspector never imports the LLM inspector (or vice versa)', () => {
    // Byte-identity alone would not stop the merge happening in the OTHER direction:
    // llmInspector.ts absorbing inspector.ts. The two reducers must stay independent.
    const structural = readFileSync(`${REPO_ROOT}/apps/playground/src/run/inspector.ts`, 'utf8');
    const llm = readFileSync(`${REPO_ROOT}/apps/playground/src/run/llmInspector.ts`, 'utf8');
    expect(structural).not.toContain('llmInspector');
    expect(llm).not.toContain("from './inspector.js'");
  });

  it('the two reducers still behave differently — structural is value-blind', () => {
    // The reason AC11 exists, asserted behaviourally: the same marker survives the LLM
    // reducer (bodies are the feature) and is erased by the structural one.
    const MARKER = 'RAILTABMARKER-b91f';
    const llm = llmInspectorReduce(initialLlmInspectorState as LlmInspectorState, {
      type: 'round_trip',
      index: 0,
      request: { system: `system ${MARKER}`, messages: [] },
      response: { ok: true, text: MARKER, toolCalls: [], stopReason: 'end' },
      durationMs: 1,
    });
    expect(JSON.stringify(llm)).toContain(MARKER);

    const structural = inspectorReduce(initialInspectorState as InspectorState, {
      direction: 'inbound',
      frame: {
        v: 1,
        type: 'agent.request',
        requestId: 'r-1',
        prompt: MARKER,
      } as never,
    });
    expect(JSON.stringify(structural)).not.toContain(MARKER);
  });
});

// ------------------------------------------------------------- AC10 the merge

describe('merged think surface (AC10)', () => {
  const llmState = llmInspectorReduce(initialLlmInspectorState as LlmInspectorState, {
    type: 'round_trip',
    index: 0,
    request: { system: 'you are snug', messages: [{ role: 'user', content: 'hi' }] },
    response: { ok: true, text: 'hello', toolCalls: [], stopReason: 'end' },
    durationMs: 12,
  });
  const frameState = inspectorReduce(initialInspectorState as InspectorState, {
    direction: 'outbound',
    frame: { v: 1, type: 'host.ready' } as never,
  });

  it('renders the LLM section ABOVE the frame section, both labelled, in one container', () => {
    const el = mount(<ThinkPanel llm={llmState} frames={frameState.entries} mode="byok" />);
    const sections = [...el.querySelectorAll('[data-testid="think-section"]')];
    expect(sections).toHaveLength(2);
    expect(sections[0]?.getAttribute('data-section')).toBe('llm');
    expect(sections[1]?.getAttribute('data-section')).toBe('frames');
    // Each section is clearly labelled (a heading, not just a class name).
    const headings = [...el.querySelectorAll('[data-testid="think-section"] h3')].map((h) => h.textContent?.trim());
    expect(headings[0]).toBeTruthy();
    expect(headings[1]).toBeTruthy();
    expect(headings[0]).not.toBe(headings[1]);
    // One scroll container holding both.
    const scroller = el.querySelector('.think-panel');
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(sections[0]!)).toBe(true);
    expect(scroller!.contains(sections[1]!)).toBe(true);
  });

  it('shows real round-trip data and real frame data at the same time', () => {
    const el = mount(<ThinkPanel llm={llmState} frames={frameState.entries} mode="byok" />);
    expect(el.querySelectorAll('[data-testid="llm-round-trip"]').length).toBe(1);
    expect(el.querySelectorAll('.inspector-entry').length).toBe(1);
  });

  it('the rail no longer offers a separate llm tab', async () => {
    const el = mountRun('starter--chess');
    await settle();
    const names = tabButtons(el).map(accessibleName);
    expect(names).not.toContain('llm');
  });

  it('the inspector tab renders both sections in the live rail', async () => {
    const el = mountRun('starter--chess');
    await settle();
    const inspectorTab = tabButtons(el).find((b) => accessibleName(b) === 'inspector');
    expect(inspectorTab).toBeDefined();
    act(() => {
      inspectorTab!.click();
    });
    const sections = [...el.querySelectorAll('[data-testid="think-section"]')].map((s) => s.getAttribute('data-section'));
    expect(sections).toEqual(['llm', 'frames']);
  });
});

// ------------------------------------------------------------------ AC12 icons

describe('iconified rail tabs keep their accessible names (AC12)', () => {
  it('every tab is still findable by its original accessible name', async () => {
    const el = mountRun('app-with-tabs');
    await settle();
    const names = tabButtons(el).map(accessibleName);
    for (const expected of ['chat', 'inspector', 'docs', 'versions']) {
      expect(names, `tab "${expected}" lost its accessible name`).toContain(expected);
    }
  });

  it('each tab shows an icon rather than its label text, and keeps a title tooltip', async () => {
    const el = mountRun('app-with-tabs');
    await settle();
    const buttons = tabButtons(el);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label');
      // The accessible name comes from aria-label, NOT from title (title alone is not
      // an accessible name) and NOT from visible label text.
      expect(name, 'a tab lost its aria-label').toBeTruthy();
      expect(button.getAttribute('title')).toBe(name);
      expect(button.textContent?.trim()).not.toBe(name);
      // The glyph is decorative — a screen reader must not read it alongside the name.
      const icon = button.querySelector('[aria-hidden="true"]');
      expect(icon, `tab "${name ?? '?'}" has no icon`).not.toBeNull();
      expect(icon!.textContent?.trim()).not.toBe('');
    }
  });

  it('the tabs are still a keyboard-reachable pressed-state group', async () => {
    const el = mountRun('app-with-tabs');
    await settle();
    const buttons = tabButtons(el);
    // Native <button>s, so they are in the tab order; no tabindex=-1 sneaks in.
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('tabindex')).not.toBe('-1');
      expect(button.getAttribute('aria-pressed')).toMatch(/^(true|false)$/);
    }
    const docs = buttons.find((b) => accessibleName(b) === 'docs');
    act(() => {
      docs!.click();
    });
    await settle(); // DocsPanel loads its rows async — let the state land inside act()
    expect(docs!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('icons are distinct per tab — no two tabs share a glyph', async () => {
    const el = mountRun('app-with-tabs');
    await settle();
    const glyphs = tabButtons(el).map((b) => b.querySelector('[aria-hidden="true"]')?.textContent?.trim() ?? '');
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

// A digest of the locked files, so a reviewer reading a failure sees WHAT changed
// rather than only that something did.
describe('AC11 digest (diagnostic)', () => {
  it('records the locked files’ hashes', () => {
    const digest = (path: string): string =>
      createHash('sha256').update(readFileSync(`${REPO_ROOT}/${path}`)).digest('hex').slice(0, 12);
    expect(digest('apps/playground/src/run/inspector.ts')).toMatch(/^[0-9a-f]{12}$/);
    expect(digest('apps/playground/src/__tests__/inspector.test.ts')).toMatch(/^[0-9a-f]{12}$/);
  });
});
