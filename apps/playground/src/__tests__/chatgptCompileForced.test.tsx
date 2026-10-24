// chatgptCompileForced.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L4 (plan §11 L4-13;
// AC4's chip label; ADR-0059's disclosure rule applied to the third brain).
//
// The UI entries the new kind FORCES at L4 (the full UI is L5). Each is a place where a missing
// arm would disclose the wrong brain — the exact failure ADR-0059 exists to forbid:
//   - the chip says `ChatGPT plan` (`BRAINS.chatgpt` via `brainChipLabel`), never "demo brain",
//     and the schedule editor's cost line names the same word (`brainChipLabel(appBrainKind(…))`);
//   - the inspector's empty state names the plan (`emptyCopy('chatgpt')`, an exhaustive switch);
//   - `DemoBrainCallout` never shows in chatgpt mode, whatever keys are (or are not) saved;
//   - `ModelSelect` / `BuilderModelSelect` never render the BYOK provider groups in chatgpt mode
//     and never write an anthropic/openai pin from it; `BuilderModelSelect` lists the ACCOUNT's
//     models there (the L4 pin "renders nothing until L5" was amended to this when L5 landed —
//     plan §12 amendments, the one Gate 3 assertion this task knowingly rewrote).
// `MODE_LABELS.chatgpt` (`my ChatGPT plan`) is pinned through Settings in chatgptModes.test.tsx.
//
// The desktop platform WITH the custody seat, set once; the keeper booted READY per test.
//
// RED until `state/chatgptPlan.ts` and the chatgpt entries exist.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { setPlatform } from '../platform/platform.js';
import { BuilderModelSelect } from '../run/BuilderModelSelect.js';
import { LlmInspectorPanel } from '../run/LlmInspectorPanel.js';
import { ModelSelect } from '../run/ModelSelect.js';
import { initialLlmInspectorState } from '../run/llmInspector.js';
import { appBrainKind } from '../schedule/editorModel.js';
import { appModelStore, appProviderStore } from '../state/appModel.js';
import { builderPickStore } from '../state/builderModel.js';
import { bootChatgptPlan, resetChatgptPlanForTests } from '../state/chatgptPlan.js';
import { demoCalloutStore, initDemoCallout } from '../state/demoCallout.js';
import { byokKeyPresenceStore, modeStore, modelStore, providerChoiceStore, providerModelsStore, providerStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { BrainChip, brainChipLabel } from '../views/BrainChip.js';
import { DemoBrainCallout } from '../views/DemoBrainCallout.js';
import { READY, chatgptDesktopPlatform, fakeChatgptSession, recordingFactory, settle } from './chatgptPlanTestHelper.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

setPlatform(chatgptDesktopPlatform());

let db: UserDb;
let appId: string;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', html: '<html>v1</html>' }).appId;
  appModelStore.set({});
  appProviderStore.set({});
  builderPickStore.set(undefined);
  providerChoiceStore.set(undefined);
  providerModelsStore.set({});
  modelStore.set(undefined);
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  // Both BYOK keys saved — the selectors would render their groups in byok mode.
  db.setSecret('byok:anthropic', 'sk-ant-api03-test-0123456789abcdefghij');
  db.setSecret('byok:openai', 'sk-proj-test-0123456789abcdefghij');
  byokKeyPresenceStore.set({ anthropic: true, openai: true });
  providerStore.set('anthropic');
  modeStore.set('chatgpt');
  resetChatgptPlanForTests();
  await bootChatgptPlan(recordingFactory(fakeChatgptSession(READY)).create);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  resetChatgptPlanForTests();
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  demoCalloutStore.set(false);
});

async function mount(node: Parameters<Root['render']>[0]): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container;
}

describe('the chip and the editor’s cost line name the plan (BRAINS.chatgpt, L4-13)', () => {
  it('brainChipLabel("chatgpt") is "ChatGPT plan"', () => {
    expect(brainChipLabel('chatgpt')).toBe('ChatGPT plan');
  });

  it('the schedule editor’s cost line names the plan for a chatgpt app — even with a BYOK pin and keys', () => {
    expect(
      brainChipLabel(appBrainKind({ brain: { kind: 'settings' }, mode: 'chatgpt', provider: 'anthropic', pinned: 'openai', keys: { anthropic: true, openai: true } })),
    ).toBe('ChatGPT plan');
  });

  it('the mounted chip reads "ChatGPT plan" and never "demo brain"', async () => {
    const el = await mount(<BrainChip />);
    expect(el.textContent).toContain('ChatGPT plan');
    expect(el.textContent).not.toContain('demo brain');
  });
});

describe('the inspector’s empty state names the plan (emptyCopy, L4-13)', () => {
  it('mode chatgpt: non-empty copy that mentions the ChatGPT plan — not the byok wire, not the demo', async () => {
    const el = await mount(<LlmInspectorPanel state={initialLlmInspectorState} mode="chatgpt" />);
    const text = el.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('ChatGPT plan');
    expect(text).not.toContain('your browser calls the model directly in byok mode');
    expect(text).not.toContain('demo brain');
  });
});

describe('DemoBrainCallout never shows in chatgpt mode (L4-13)', () => {
  it('armed latch, chatgpt mode → nothing; the same latch under the byok demo provider → the callout (control)', async () => {
    await initDemoCallout();
    expect(demoCalloutStore.get()).toBe(true);
    db.deleteSecret('byok:anthropic');
    db.deleteSecret('byok:openai');
    byokKeyPresenceStore.set({ anthropic: false, openai: false });
    providerStore.set('mock');

    const el = await mount(<DemoBrainCallout />);
    expect(el.querySelector('[data-testid="demo-brain-callout"]')).toBeNull();

    await act(async () => {
      modeStore.set('byok');
    });
    expect(el.querySelector('[data-testid="demo-brain-callout"]')).not.toBeNull();
  });
});

describe('the model selectors in chatgpt mode never offer or write a BYOK pin (L4-13)', () => {
  const BYOK_GROUP = /Anthropic|OpenAI/;

  it('ModelSelect renders no BYOK provider group and no anthropic:/openai: option', async () => {
    const el = await mount(<ModelSelect appId={appId} />);
    const groups = [...el.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups.filter((label) => BYOK_GROUP.test(label))).toEqual([]);
    const values = [...el.querySelectorAll('option')].map((o) => o.value);
    expect(values.filter((v) => v.startsWith('anthropic:') || v.startsWith('openai:'))).toEqual([]);
  });

  it('whatever ModelSelect offers, choosing it never writes an anthropic/openai pin', async () => {
    const el = await mount(<ModelSelect appId={appId} />);
    const select = el.querySelector('select');
    for (const option of [...(select?.querySelectorAll('option') ?? [])]) {
      await act(async () => {
        select!.value = option.value;
        select!.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await settle();
    const provider = appProviderStore.get()[appId];
    expect(provider === 'anthropic' || provider === 'openai').toBe(false);
    const row = db.listAppProviders()[appId];
    expect(row === 'anthropic' || row === 'openai').toBe(false);
  });

  it('BuilderModelSelect (a fresh thread) lists the account’s models in chatgpt mode — no BYOK group, no pin written (L5 amended the L4 "renders nothing until L5" pin)', async () => {
    const el = await mount(<BuilderModelSelect />);
    const select = el.querySelector<HTMLSelectElement>('[data-testid="builder-model-select"]');
    expect(select).not.toBeNull();
    expect([...select!.options].filter((o) => o.value !== '').map((o) => o.textContent)).toEqual(['GPT-6.1 Sol', 'GPT-6.1 mini']);
    expect(el.querySelectorAll('optgroup')).toHaveLength(0);
    expect(builderPickStore.get()).toBeUndefined();
  });
});
