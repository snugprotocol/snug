// Review 2026-08-06 finding 3: the run-rail empty states branched on the RAW mode,
// which the webllm brain override makes lie — subscription-flavored copy ("switch to
// byok…") while webllm turns were feeding the very same surfaces. The fix is ONE
// derivation (resolveTurnMode) consumed by every such surface; these tests pin the
// derivation table AND that each panel's webllm copy actually reaches the DOM.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DocsPanel } from '../run/DocsPanel.js';
import { LlmInspectorPanel } from '../run/LlmInspectorPanel.js';
import { initialLlmInspectorState, type LlmInspectorState } from '../run/llmInspector.js';
import { resolveTurnMode } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('resolveTurnMode — the one effective-turn derivation (review F3)', () => {
  it('settings brain passes the configured mode through', () => {
    expect(resolveTurnMode({ kind: 'settings' }, 'subscription')).toBe('subscription');
    expect(resolveTurnMode({ kind: 'settings' }, 'byok')).toBe('byok');
    expect(resolveTurnMode({ kind: 'settings' }, 'local')).toBe('local');
  });

  it('the webllm brain overrides EVERY configured mode', () => {
    expect(resolveTurnMode({ kind: 'webllm', model: 'm' }, 'subscription')).toBe('webllm');
    expect(resolveTurnMode({ kind: 'webllm', model: 'm' }, 'byok')).toBe('webllm');
    expect(resolveTurnMode({ kind: 'webllm', model: 'm' }, 'local')).toBe('webllm');
  });

  it('the demo fallback reports as byok (mock adapter through the byok path)', () => {
    expect(resolveTurnMode({ kind: 'demo', reason: 'no-webgpu' }, 'subscription')).toBe('byok');
    expect(resolveTurnMode({ kind: 'demo', reason: 'probing' }, 'local')).toBe('byok');
  });
});

describe('LlmInspectorPanel empty copy in webllm mode', () => {
  it('says the model runs in-tab — never the subscription "switch modes" lie', () => {
    const el = mount(<LlmInspectorPanel state={initialLlmInspectorState as LlmInspectorState} mode="webllm" />);
    expect(el.textContent).toContain('inside this tab');
    expect(el.textContent).not.toContain('subscription');
  });
});

describe('DocsPanel empty copy in webllm mode', () => {
  beforeEach(async () => {
    await installTestUserDb();
  });

  it('says the tool-free in-browser model cannot write a wiki', async () => {
    const el = mount(<DocsPanel appId="app-x" refreshToken={0} mode="webllm" />);
    await settle();
    expect(el.textContent).toContain('no wiki in webllm mode');
    expect(el.textContent).toContain('without tools');
    expect(el.textContent).not.toContain('the pages appear');
  });
});
