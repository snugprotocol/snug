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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelSelect } from '../run/ModelSelect.js';
import {
  appModelStore,
  appProviderStore,
  resolveModelForApp,
  resolveProviderForApp,
  setAppModel,
  setAppPin,
} from '../state/appModel.js';
import {
  byokKeyPresenceStore,
  modeStore,
  modelStore,
  providerChoiceStore,
  providerModelsStore,
  providerStore,
} from '../state/mode.js';
import { ollamaStore } from '../state/ollama.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The L4 keeper, imported by a NON-literal specifier in the chatgpt blocks so Vite's import analysis cannot fail this whole file (and its existing tests) while `state/chatgptPlan.ts` does not exist yet. */
const KEEPER_MODULE = '../state/chatgptPlan.js';

const APP = 'app-model-select';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  appModelStore.set({});
  appProviderStore.set({});
  modelStore.set(undefined);
  modeStore.set('byok');
  providerStore.set('anthropic');
  providerChoiceStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: true, openai: false });
  providerModelsStore.set({});
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

  it('offers the pinned popular models for each KEYED byok provider', async () => {
    await renderSelect();
    // The frontier catalog under provider-prefixed values (TASK-20260821): only
    // anthropic has a key here, so only its group renders.
    expect(optionValues()).toContain('anthropic:claude-sonnet-5');
    expect(optionValues().some((v) => v.startsWith('openai:'))).toBe(false);
    // Bounded by the owner's "up to 5" per provider, plus the inherited-default entry.
    expect(optionValues().length).toBeLessThanOrEqual(6);
  });

  it('shows the inherited default as a distinct, labelled option (AC3 on screen)', async () => {
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    await renderSelect();
    // The user must be able to SEE that this app is following the Settings default
    // rather than pinned — and must be able to get back to that state after picking.
    expect(optionLabels().join(' ').toLowerCase()).toContain('default');
  });
});

describe('AC1 — picking writes the choice (state, not just render)', () => {
  it('stores the pick — model AND provider — so it resolves for this app', async () => {
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
    await renderSelect();

    const el = select();
    expect(el).not.toBeNull();
    await act(async () => {
      el!.value = 'anthropic:claude-opus-5';
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // Assert the RESOLUTION, not the element's own value: an onChange that updated local
    // component state and wrote nothing would pass a `el.value` assertion perfectly.
    expect(resolveModelForApp(APP)).toBe('claude-opus-5');
    // A pin is a PIN (review finding 10): the provider row rides with the model row.
    expect(resolveProviderForApp(APP)).toBe('anthropic');
  });

  it('un-pins back to the inherited default', async () => {
    // MIGRATED (TASK-20260821): the byok inherited default is per-provider now.
    providerModelsStore.set({ anthropic: 'claude-sonnet-5' });
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
    // The provider row clears with it — inheriting is an absence of BOTH.
    expect(appProviderStore.get()[APP]).toBeUndefined();
  });

  it('shows the app’s current pick as the selected option on open', async () => {
    setAppPin(APP, { provider: 'anthropic', model: 'claude-opus-5' });
    await flush();
    await renderSelect();
    expect(select()?.value).toBe('anthropic:claude-opus-5');
  });

  it('a legacy model-only pin (no provider row) displays under the default provider', async () => {
    // ADR-0036-era rows have no appProvider sibling; they route on the resolved default,
    // and the selector must show them exactly there.
    setAppModel(APP, 'claude-opus-5');
    await flush();
    await renderSelect();
    expect(select()?.value).toBe('anthropic:claude-opus-5');
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
    expect(optionValues()).toContain('anthropic:some-retired-model-id');
    expect(select()?.value).toBe('anthropic:some-retired-model-id');
  });
});

describe('AC13 (TASK-20260821) — both keyed providers render as labelled groups', () => {
  it('groups both catalogs and picking the OTHER provider’s model pins provider + model', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: true });
    await renderSelect();

    const groups = Array.from(container?.querySelectorAll('optgroup') ?? []).map((g) => g.label);
    expect(groups).toEqual(['Anthropic', 'OpenAI']);
    expect(optionValues()).toContain('anthropic:claude-opus-5');
    expect(optionValues()).toContain('openai:gpt-4o-mini');

    const el = select();
    await act(async () => {
      el!.value = 'openai:gpt-4o-mini';
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(resolveProviderForApp(APP)).toBe('openai');
    expect(resolveModelForApp(APP)).toBe('gpt-4o-mini');
  });

  it('names the resolved default — provider and model — on the inherit row', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: true });
    providerStore.set('openai');
    providerModelsStore.set({ openai: 'gpt-4o-mini' });
    await renderSelect();

    const inherit = Array.from(select()?.options ?? []).find((o) => o.value === '');
    expect(inherit?.textContent).toContain('OpenAI');
    expect(inherit?.textContent).toContain('GPT-4o mini');
  });

  it('a pin whose key is GONE stays visible, marked, and selected — never silently re-routed', async () => {
    setAppPin(APP, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    await renderSelect();

    expect(select()?.value).toBe('openai:gpt-4o-mini');
    const groups = Array.from(container?.querySelectorAll('optgroup') ?? []).map((g) => g.label);
    expect(groups).toContain('OpenAI (key missing)');
  });
});

// =============================================================================================
// TASK-20261023-siwc-chatgpt-plan Gate 3, L5 — the selector on the ChatGPT plan (AC8; plan §1 D6,
// §11 L4-4 + amendment, §3 L5; ADR-0078 §6 — pins are scoped to the mode family that made them).
//
// Rules 1–3 above, applied to the third mode:
//   - chatgpt mode lists the ACCOUNT's models (the keeper's list, server order, display names) —
//     never a hardcoded catalogue, never the BYOK groups;
//   - a pick writes `setAppPin(appId, { provider: 'chatgpt', model })` (BOTH rows); inherit clears both;
//   - Rule 3: a chatgpt pin the plan no longer lists stays SHOWN and SELECTED, "<id> (not on your plan)";
//   - a pin from ANOTHER family is ignored for routing (L4) and SAID (`appPinFamily`): in chatgpt
//     mode a BYOK pin reads "pinned for bring your own key — not used here"; in byok mode a chatgpt
//     pin reads "pinned for my ChatGPT plan — not used here" — and the select shows what actually
//     routes (the inherited default), never the foreign pin as if it applied.
// The byok/local/subscription rows above run unchanged (they are the "behaviour unchanged" proof).
// Fresh module graph on the seat platform, LAST in the file; the keeper booted on a fake READY session.
// RED until `state/chatgptPlan.ts` and ModelSelect's chatgpt branch exist.
// =============================================================================================

describe('ModelSelect on the ChatGPT plan (AC8, L5)', () => {
  interface Graph {
    appModel: typeof import('../state/appModel.js');
    mode: typeof import('../state/mode.js');
    Select: typeof import('../run/ModelSelect.js')['ModelSelect'];
  }

  async function graph(): Promise<Graph> {
    vi.resetModules();
    const helperModule = await import('./chatgptPlanTestHelper.js');
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform(helperModule.chatgptDesktopPlatform());
    const dbHelper = await import('./userdbTestHelper.js');
    await dbHelper.installTestUserDb();
    const mode = await import('../state/mode.js');
    const appModel = await import('../state/appModel.js');
    const keeper = (await import(/* @vite-ignore */ KEEPER_MODULE)) as typeof import('../state/chatgptPlan.js');
    keeper.resetChatgptPlanForTests();
    await keeper.bootChatgptPlan(helperModule.recordingFactory(helperModule.fakeChatgptSession(helperModule.READY)).create);
    const view = await import('../run/ModelSelect.js');
    return { appModel, mode, Select: view.ModelSelect };
  }

  async function renderIn(g: Graph): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<g.Select appId={APP} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  const pick = async (label: string): Promise<void> => {
    const el = select();
    const option = Array.from(el?.options ?? []).find((o) => o.textContent === label);
    if (el === null || option === undefined) throw new Error(`no option labelled ${label}`);
    await act(async () => {
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  };

  it('lists the account’s models in server order by display name — no BYOK group, no hardcoded catalogue', async () => {
    const g = await graph();
    g.mode.setMode('chatgpt');
    await renderIn(g);
    expect(select()).not.toBeNull();
    const listed = Array.from(select()!.options).filter((o) => o.value !== '');
    expect(listed.map((o) => o.textContent)).toEqual(['GPT-6.1 Sol', 'GPT-6.1 mini']);
    expect(container?.querySelectorAll('optgroup')).toHaveLength(0);
  });

  it('a pick writes setAppPin(appId, { provider: "chatgpt", model }); inherit clears both rows', async () => {
    const g = await graph();
    g.mode.setMode('chatgpt');
    await renderIn(g);

    await pick('GPT-6.1 mini');
    expect(g.appModel.appModelStore.get()[APP]).toBe('gpt-6.1-mini');
    expect(g.appModel.appProviderStore.get()[APP]).toBe('chatgpt');

    const inherit = Array.from(select()!.options).find((o) => o.value === '');
    expect(inherit, 'inheriting is a visible, labelled option (Rule 1)').toBeDefined();
    await pick(inherit!.textContent ?? '');
    expect(g.appModel.appModelStore.get()[APP]).toBeUndefined();
    expect(g.appModel.appProviderStore.get()[APP]).toBeUndefined();
  });

  it('a chatgpt pin the plan does not list stays visible and selected, labelled "<id> (not on your plan)"', async () => {
    const g = await graph();
    g.mode.setMode('chatgpt');
    g.appModel.setAppPin(APP, { provider: 'chatgpt', model: 'gpt-5-retired' });
    await flush();
    await renderIn(g);
    expect(select()!.selectedOptions[0]?.textContent).toBe('gpt-5-retired (not on your plan)');
  });

  it('chatgpt mode, a BYOK pin: "pinned for bring your own key — not used here", and the select shows the inherited default', async () => {
    const g = await graph();
    g.mode.setMode('chatgpt');
    g.appModel.setAppPin(APP, { provider: 'anthropic', model: 'claude-opus-5' });
    await flush();
    await renderIn(g);
    expect(container?.textContent).toContain('pinned for bring your own key — not used here');
    expect(select()!.value).toBe('');
    expect(Array.from(select()!.options).some((o) => (o.textContent ?? '').includes('claude-opus-5')), 'the foreign pin is not offered as a plan model').toBe(false);
  });

  it('byok mode, a chatgpt pin: "pinned for my ChatGPT plan — not used here", and the select shows the inherited default', async () => {
    const g = await graph();
    g.mode.setMode('byok');
    g.mode.byokKeyPresenceStore.set({ anthropic: true, openai: false });
    g.mode.providerStore.set('anthropic');
    g.appModel.setAppPin(APP, { provider: 'chatgpt', model: 'gpt-6.1-mini' });
    await flush();
    await renderIn(g);
    expect(container?.textContent).toContain('pinned for my ChatGPT plan — not used here');
    expect(select()!.value).toBe('');
    expect(Array.from(select()!.options).some((o) => (o.textContent ?? '').includes('gpt-6.1-mini')), 'never shown as an Anthropic "(not listed)" pin').toBe(false);
  });
});
