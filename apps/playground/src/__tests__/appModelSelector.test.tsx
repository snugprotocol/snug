// appModelSelector.test.tsx — TASK-20260817-per-app-model-selector AC1/AC7/AC10/AC11.
//
// The control the owner asked for: a model selector on the hub, on the header of every
// opened app, beside 🔌 connections and export .sqlite.
//
// These tests RENDER the component rather than scanning its source. A source scan can
// only prove a string exists in a file; it cannot tell whether the element reached the
// screen, which option is selected, or whether a click writes anything (lessons.md
// 2026-08-17: assert STATE and STRUCTURE, not return values and copy — a test asserting
// a returned value passed while nothing stored it).
//
// AC1  the control exists, in the app header's action cluster
// AC7  it renders NOTHING under the webllm/demo brain or the mock provider — the brain
//      overrides the configured mode entirely (ADR-0015), so offering a frontier model
//      picker there would be a lie on screen
// AC10 local mode lists the Ollama-detected models, reusing the Settings precedent, and
//      says so honestly when the probe found none
// AC11 a stored model absent from the current catalog is still SHOWN, never silently
//      dropped — the user must be able to see what their app is actually running on

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelSelect } from '../run/ModelSelect.js';
import { appModelStore, resolveModelForApp, setAppModel } from '../state/appModel.js';
import { modeStore, modelStore, providerStore } from '../state/mode.js';
import { ollamaStore } from '../state/ollama.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-model-select';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  appModelStore.set({});
  modelStore.set(undefined);
  modeStore.set('byok');
  providerStore.set('anthropic');
  ollamaStore.set('unknown');
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  await installTestUserDb();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

async function renderSelect(appId = APP): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ModelSelect appId={appId} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const select = (): HTMLSelectElement | null =>
  (container?.querySelector('[data-testid="app-model-select"]') as HTMLSelectElement | null) ?? null;

const optionValues = (): string[] =>
  Array.from(select()?.options ?? []).map((o) => o.value);

const optionLabels = (): string[] =>
  Array.from(select()?.options ?? []).map((o) => o.textContent ?? '');

describe('AC1 — the control renders for an opened app', () => {
  it('renders a selector with the agreed test id', async () => {
    await renderSelect();
    expect(select()).not.toBeNull();
  });

  it('offers the pinned popular models for the active byok provider', async () => {
    await renderSelect();
    // The frontier catalog, not the Ollama list: this is byok/anthropic.
    expect(optionValues()).toContain('claude-sonnet-5');
    // Bounded by the owner's "up to 5", plus the inherited-default entry.
    expect(optionValues().length).toBeLessThanOrEqual(6);
  });

  it('shows the inherited default as a distinct, labelled option (AC3 on screen)', async () => {
    modelStore.set('claude-sonnet-5');
    await renderSelect();
    // The user must be able to SEE that this app is following the Settings default
    // rather than pinned — and must be able to get back to that state after picking.
    expect(optionLabels().join(' ').toLowerCase()).toContain('default');
  });
});

describe('AC1 — picking writes the choice (state, not just render)', () => {
  it('stores the pick so it resolves for this app', async () => {
    modelStore.set('claude-sonnet-5');
    await renderSelect();

    const el = select();
    expect(el).not.toBeNull();
    await act(async () => {
      el!.value = 'claude-opus-5';
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // Assert the RESOLUTION, not the element's own value: an onChange that updated local
    // component state and wrote nothing would pass a `el.value` assertion perfectly.
    expect(resolveModelForApp(APP)).toBe('claude-opus-5');
  });

  it('un-pins back to the inherited default', async () => {
    modelStore.set('claude-sonnet-5');
    setAppModel(APP, 'claude-opus-5');
    await flush();
    await renderSelect();

    const el = select();
    await act(async () => {
      el!.value = '';
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(resolveModelForApp(APP)).toBe('claude-sonnet-5');
    expect(appModelStore.get()[APP]).toBeUndefined();
  });

  it('shows the app’s current pick as the selected option on open', async () => {
    setAppModel(APP, 'claude-opus-5');
    await flush();
    await renderSelect();
    expect(select()?.value).toBe('claude-opus-5');
  });
});

describe('AC7 — hidden where a model choice would be a lie', () => {
  it('renders nothing for the mock provider', async () => {
    providerStore.set('mock');
    await renderSelect();
    expect(select()).toBeNull();
  });

  it('renders nothing under the webllm brain', async () => {
    // ADR-0015: the webllm brain OVERRIDES the configured mode entirely and the engine
    // always loads its own pinned model — the `model` setting is a different namespace
    // and is deliberately ignored (adapter.ts). Offering a picker here would imply a
    // routing that cannot happen.
    //
    // Driven through the STORES the brain actually resolves from, not through the URL:
    // the `?webllm=1` flag is read once at boot into `webllmFlagStore`, so setting the
    // URL at render time would leave the brain untouched and the test would pass for
    // the wrong reason (rendering nothing because nothing changed).
    webllmFlagStore.set(true);
    webgpuStore.set('yes');
    await renderSelect();
    expect(select()).toBeNull();
  });

  it('renders nothing under the demo fallback brain', async () => {
    // The no-WebGPU fallback: same override, same reason. Asserting it separately means
    // a gate written as `kind === 'webllm'` (rather than `!== 'settings'`) still reds.
    webllmFlagStore.set(true);
    webgpuStore.set('no');
    await renderSelect();
    expect(select()).toBeNull();
  });
});

describe('AC10 — local mode offers the detected Ollama models', () => {
  it('lists the probe’s models rather than the frontier catalog', async () => {
    modeStore.set('local');
    ollamaStore.set({ running: true, models: ['llama3.2', 'qwen2.5'] });
    await renderSelect();

    expect(optionValues()).toContain('llama3.2');
    expect(optionValues()).toContain('qwen2.5');
    // A local endpoint cannot serve a frontier model; offering one would produce a
    // confusing provider-side failure with nothing on screen explaining it.
    expect(optionValues()).not.toContain('claude-sonnet-5');
  });

  it('says so honestly when the probe found no models', async () => {
    // The Settings precedent (SettingsView.tsx): running-but-empty is its OWN state —
    // the install succeeded, only a model is missing. An empty dropdown with no words
    // is the ambiguity lessons.md (2026-08-17) calls the defect itself.
    modeStore.set('local');
    ollamaStore.set({ running: true, models: [] });
    await renderSelect();

    const rendered = container?.textContent ?? '';
    expect(rendered.trim()).not.toBe('');
    expect(optionValues().filter((v) => v !== '')).toHaveLength(0);
  });
});

describe('AC11 — an unknown stored model is shown, never silently dropped', () => {
  it('renders the stored id as the selected option even though it is not in the catalog', async () => {
    setAppModel(APP, 'some-retired-model-id');
    await flush();
    await renderSelect();

    // If the control only rendered catalog entries, the browser would coerce the select
    // to its first option — the app would appear to be on the default while its turns
    // still went to the stored model. Showing it is what keeps the screen honest.
    expect(optionValues()).toContain('some-retired-model-id');
    expect(select()?.value).toBe('some-retired-model-id');
  });
});
