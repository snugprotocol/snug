// builderModelSelect.test.tsx — TASK-20260821-ui-polish AC12: the build page carries the
// same model selector every app header has.
//
// Two states, three claims:
//   (1) a FRESH thread renders the pending-pick selector, and a pick lands in the
//       session store that routes the build turns (the agent memo keys on it);
//   (2) with a thread ATTACHED to an app, the control IS the app's own ModelSelect —
//       one row, shared with the run header;
//   (3) the pick TRANSFERS on install: driven through the REAL product path (a build in
//       BuilderView that installs an app), because the transfer lives in
//       useBuilderChat's install callback and a test that called the transfer function
//       directly would leave that wire untested (lessons.md 2026-08-17).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { BuilderModelSelect } from '../run/BuilderModelSelect.js';
import { BuilderView } from '../views/BuilderView.js';
import { appModelStore, appProviderStore, resolveModelForApp, resolveProviderForApp, setAppPin } from '../state/appModel.js';
import { applyBuilderPickToApp, builderPickStore, setBuilderPick } from '../state/builderModel.js';
import {
  byokKeyPresenceStore,
  modeStore,
  modelStore,
  providerChoiceStore,
  providerModelsStore,
  providerStore,
} from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The L4 keeper, imported by a NON-literal specifier in the chatgpt blocks so Vite's import analysis cannot fail this whole file (and its existing tests) while `state/chatgptPlan.ts` does not exist yet. */
const KEEPER_MODULE = '../state/chatgptPlan.js';

const APP_HTML = '<!DOCTYPE html><html><head><title>Haiku Machine</title></head><body></body></html>';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  appModelStore.set({});
  appProviderStore.set({});
  builderPickStore.set(undefined);
  modeStore.set('byok');
  providerStore.set('anthropic');
  providerChoiceStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: true, openai: true });
  providerModelsStore.set({});
  modelStore.set(undefined);
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  db = await installTestUserDb();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function mount(element: Parameters<Root['render']>[0]): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const builderSelect = (): HTMLSelectElement | null =>
  (container?.querySelector('[data-testid="builder-model-select"]') as HTMLSelectElement | null) ?? null;
const appSelect = (): HTMLSelectElement | null =>
  (container?.querySelector('[data-testid="app-model-select"]') as HTMLSelectElement | null) ?? null;

describe('a fresh thread (no app yet)', () => {
  it('renders the grouped pending-pick selector, and a pick lands in the session store', async () => {
    await mount(<BuilderModelSelect />);
    const el = builderSelect();
    expect(el).not.toBeNull();
    const groups = Array.from(container?.querySelectorAll('optgroup') ?? []).map((g) => g.label);
    expect(groups).toEqual(['Anthropic', 'OpenAI']);

    await act(async () => {
      el!.value = 'openai:gpt-4o-mini';
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(builderPickStore.get()).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('renders nothing under the demo brain — same rule as the app header selector', async () => {
    providerStore.set('mock');
    await mount(<BuilderModelSelect />);
    expect(builderSelect()).toBeNull();
  });
});

describe('a thread attached to an app', () => {
  it('is the app’s OWN selector — a pick writes the app rows, not the session store', async () => {
    setAppPin('app-x', { provider: 'anthropic', model: 'claude-opus-5' });
    await flush();
    await mount(<BuilderModelSelect attachedAppId="app-x" />);

    expect(builderSelect()).toBeNull();
    const el = appSelect();
    expect(el?.value).toBe('anthropic:claude-opus-5');

    await act(async () => {
      el!.value = 'openai:gpt-4o-mini';
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(resolveProviderForApp('app-x')).toBe('openai');
    expect(builderPickStore.get()).toBeUndefined();
  });
});

describe('the transfer on install (through the real build path)', () => {
  it('applyBuilderPickToApp pins the app and clears the session store', async () => {
    setBuilderPick({ provider: 'openai', model: 'gpt-4o-mini' });
    applyBuilderPickToApp('new-app');
    await flush();

    expect(resolveProviderForApp('new-app')).toBe('openai');
    expect(resolveModelForApp('new-app')).toBe('gpt-4o-mini');
    expect(builderPickStore.get()).toBeUndefined();
    expect(db.getSetting('appModel:new-app')).toBe('gpt-4o-mini');
    expect(db.getSetting('appProvider:new-app')).toBe('openai');
  });

  it('a BuilderView build that installs an app hands the pick to that app', async () => {
    // The wiring half: useBuilderChat's install callback is what must call the transfer,
    // and only the assembled product exercises it. Subscription mode gives a fully
    // mockable build (the threadContinuity precedent).
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    modeStore.set('subscription');
    setBuilderPick({ provider: 'anthropic', model: 'claude-opus-5' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/invoke') {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('event: artifact\ndata: {"artifactId":"srv-haiku","displayName":"Haiku Machine"}\n\n'));
            controller.enqueue(encoder.encode('event: done\ndata: {"text":"here is your haiku machine"}\n\n'));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/artifacts/srv-haiku') return new Response(APP_HTML, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    await mount(
      <MemoryRouter initialEntries={['/build?idea=a%20haiku%20machine']}>
        <BuilderView />
      </MemoryRouter>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const apps = db.listApps();
    expect(apps, 'the build must have installed exactly one app').toHaveLength(1);
    const appId = apps[0]!.appId;
    expect(db.getSetting(`appModel:${appId}`)).toBe('claude-opus-5');
    expect(db.getSetting(`appProvider:${appId}`)).toBe('anthropic');
    expect(builderPickStore.get()).toBeUndefined();
  });
});

// =============================================================================================
// TASK-20261023-siwc-chatgpt-plan Gate 3, L5 — a fresh build thread on the ChatGPT plan (AC8; plan
// §3 L5; ADR-0078 §6). The pending pick lists the ACCOUNT's models (server order, display names)
// and writes `setBuilderPick({ provider: 'chatgpt', model })`, which `applyBuilderPickToApp` turns
// into a chatgpt-family pin on install (L4's `BuilderPick` provider type).
//
// SUPERSEDES L4-13's interim pin: `chatgptCompileForced.test.tsx` ("BuilderModelSelect (a fresh
// thread) renders nothing in chatgpt mode — today's byok-only guard") holds only "until L5" (plan
// §11 L4-13); this block is the L5 behaviour that replaces it. Flagged to the conductor.
// Fresh module graph on the seat platform, LAST in the file. RED until the chatgpt branch exists.
// =============================================================================================

describe('BuilderModelSelect on the ChatGPT plan (AC8, L5)', () => {
  it('lists the account’s models and a pick writes setBuilderPick({ provider: "chatgpt", model })', async () => {
    vi.resetModules();
    const helperModule = await import('./chatgptPlanTestHelper.js');
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform(helperModule.chatgptDesktopPlatform());
    const dbHelper = await import('./userdbTestHelper.js');
    await dbHelper.installTestUserDb();
    const mode = await import('../state/mode.js');
    const builderModel = await import('../state/builderModel.js');
    const keeper = (await import(/* @vite-ignore */ KEEPER_MODULE)) as typeof import('../state/chatgptPlan.js');
    keeper.resetChatgptPlanForTests();
    await keeper.bootChatgptPlan(helperModule.recordingFactory(helperModule.fakeChatgptSession(helperModule.READY)).create);
    mode.setMode('chatgpt');
    const view = await import('../run/BuilderModelSelect.js');

    await mount(<view.BuilderModelSelect />);
    const el = builderSelect();
    expect(el, 'a fresh thread on the plan gets its model choice too').not.toBeNull();
    const listed = Array.from(el!.options).filter((o) => o.value !== '');
    expect(listed.map((o) => o.textContent)).toEqual(['GPT-6.1 Sol', 'GPT-6.1 mini']);
    expect(Array.from(container?.querySelectorAll('optgroup') ?? []).map((g) => g.label).filter((l) => /Anthropic|OpenAI/.test(l))).toEqual([]);

    const mini = listed.find((o) => o.textContent === 'GPT-6.1 mini')!;
    await act(async () => {
      el!.value = mini.value;
      el!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(builderModel.builderPickStore.get()).toEqual({ provider: 'chatgpt', model: 'gpt-6.1-mini' });
  });
});
