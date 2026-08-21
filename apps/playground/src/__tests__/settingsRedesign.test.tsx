// settingsRedesign.test.tsx — TASK-20260821-ui-polish AC8/AC9/AC11/AC14 (rendered).
//
// The redesign's CONTRACT, pinned: five labelled sections; the multi-provider BYOK
// rows (both keys editable side-by-side, per-provider default models, the
// default-provider control with the demo brain as a first-class choice); the standalone
// "model" card GONE in byok mode while local keeps its picker (desktopSettingsView pins
// those five states) and subscription keeps a default-model field; and the mode
// segment's accessible name carried verbatim for the e2e lane CI does not run.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { SettingsView } from '../views/SettingsView.js';
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

beforeEach(async () => {
  localStorage.clear();
  modeStore.set('byok');
  providerStore.set('mock');
  providerChoiceStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  providerModelsStore.set({});
  modelStore.set(undefined);
  ollamaStore.set('unknown');
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
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SettingsView />);
  });
  await act(async () => {
    await flush();
  });
}

function input(id: string): HTMLInputElement | null {
  return container?.querySelector<HTMLInputElement>(`#${id}`) ?? null;
}

/** Type into a CONTROLLED input: the native setter defeats React's value-tracker dedupe. */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('structure (AC14)', () => {
  it('renders the five labelled sections', async () => {
    await render();
    const labels = [...(container?.querySelectorAll('.settings-section-label') ?? [])].map((n) => n.textContent);
    expect(labels).toEqual(['brain', 'account', 'your file', 'connections', 'appearance']);
  });

  it('keeps the mode segment’s accessible name and three labels verbatim (the e2e pin)', async () => {
    await render();
    const label = [...(container?.querySelectorAll('label') ?? [])].find(
      (n) => n.textContent === 'where the agent runs',
    );
    expect(label).toBeDefined();
    const group = container?.querySelector(`[aria-labelledby="${label!.id}"]`);
    const buttons = [...(group?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(buttons).toEqual(['bring your own key', 'local model', 'hub subscription']);
  });

  it('byok mode has NO standalone model field — the per-provider defaults replaced it (AC11)', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    providerStore.set('anthropic');
    await render();
    expect(input('model-id')).toBeNull();
    expect(container?.querySelector('#model-select')).toBeNull();
  });

  it('subscription keeps a default-model field', async () => {
    modeStore.set('subscription');
    await render();
    expect(input('model-id')).not.toBeNull();
  });
});

describe('multi-provider BYOK (AC8/AC9)', () => {
  it('shows BOTH provider key rows at once, and typing a key stores it per provider', async () => {
    await render();
    const anthropic = input('byok-key-anthropic');
    const openai = input('byok-key-openai');
    expect(anthropic).not.toBeNull();
    expect(openai).not.toBeNull();

    await act(async () => {
      typeInto(anthropic!, 'sk-ant-test');
    });
    await act(async () => {
      typeInto(openai!, 'sk-openai-test');
    });
    await act(async () => {
      await flush();
    });

    expect(db.getSecret('byok:anthropic')).toBe('sk-ant-test');
    expect(db.getSecret('byok:openai')).toBe('sk-openai-test');
    // The saved-state chips follow.
    expect(container?.querySelector('[data-testid="provider-key-state-anthropic"]')?.textContent).toBe('key saved');
  });

  it('a keyed provider grows its default-model select, and a pick persists per provider', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: true });
    providerStore.set('anthropic');
    await render();

    const select = container?.querySelector<HTMLSelectElement>('[data-testid="provider-model-anthropic"]');
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = 'claude-opus-5';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await flush();
    });

    expect(db.getSetting('providerModel:anthropic')).toBe('claude-opus-5');
    expect(db.getSetting('providerModel:openai')).toBeUndefined();
  });

  it('a keyless provider offers no model select — there is nothing it could route', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    providerStore.set('anthropic');
    await render();
    expect(container?.querySelector('[data-testid="provider-model-openai"]')).toBeNull();
  });

  it('the default-provider control disables keyless providers, keeps the demo brain, and a pick persists', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: true });
    providerStore.set('anthropic');
    await render();

    const seg = container?.querySelector('[data-testid="default-provider-seg"]');
    const buttons = [...(seg?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(['Anthropic', 'OpenAI', 'demo brain']);
    expect(buttons.every((b) => !b.disabled)).toBe(true);

    await act(async () => {
      buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await flush();
    });

    expect(providerStore.get()).toBe('openai');
    expect(db.getSetting('providerChoice')).toBe('openai');
  });

  it('a provider without a key cannot be chosen as the default', async () => {
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    providerStore.set('anthropic');
    await render();
    const seg = container?.querySelector('[data-testid="default-provider-seg"]');
    const openaiButton = [...(seg?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'OpenAI');
    expect(openaiButton?.disabled).toBe(true);
  });
});
