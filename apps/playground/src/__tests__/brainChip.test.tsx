// brainChip — TASK-20260826-demo-brain-clarity AC3/AC4 (ADR-0059 rules 1/4).
//
// AC3: the chip renders on every brain state, labeled from the ONE live derivation
// (state/activeBrain.ts), never disappears, and flips WITHOUT a reload when the
// feeding stores change (adding a key re-resolves the provider — the chip must
// follow). Accessible name pinned: on-screen text is an API (lessons 2026-08-18).
//
// AC4: clicking opens a popover with one honest sentence for the current brain and
// the switch affordances — settings link always; "use ollama now" ONLY when the
// probe actually found models (the DesktopWelcome rule: never offer a button that
// cannot work). The load-bearing honesty copy is byte-pinned here: the demo body
// names the mechanism, and the BYOK invitation claims exactly what the code
// vouches for — key in the user's file, sent only to the chosen provider, never to
// Snug's servers. Esc/outside-click close with focus restore (IdentityChip contract).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrainChip, BYOK_HONESTY_COPY, DEMO_BRAIN_BODY } from '../views/BrainChip.js';
import { byokKeyPresenceStore, modeStore, providerStore } from '../state/mode.js';
import * as mode from '../state/mode.js';
import { ollamaStore } from '../state/ollama.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

const chip = (): HTMLButtonElement => {
  const el = document.querySelector('[data-testid="brain-chip"]');
  if (!(el instanceof HTMLButtonElement)) throw new Error('brain chip not rendered');
  return el;
};

const menu = (): HTMLElement | null => document.querySelector('[data-testid="brain-menu"]');

beforeEach(async () => {
  // The ollama action persists the mode via the page user DB — a memory-backed
  // double keeps jsdom away from sql.js's browser wasm resolution.
  await installTestUserDb();
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  ollamaStore.set('unknown');
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe('the brain chip (AC3)', () => {
  it('names the demo brain on the zero-key default, with the demo marker', () => {
    render(<BrainChip />);
    expect(chip().textContent).toContain('demo brain');
    expect(chip().dataset.brain).toBe('demo');
    // The accessible name carries the state even when CSS compacts the label.
    expect(chip().getAttribute('aria-label')).toBe('what’s thinking: demo brain — scripted, no AI service');
  });

  it('flips to the real provider without a reload when a key lands', () => {
    render(<BrainChip />);
    expect(chip().dataset.brain).toBe('demo');
    act(() => {
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
      providerStore.set('anthropic');
    });
    expect(chip().dataset.brain).toBe('anthropic');
    expect(chip().textContent).toContain('claude');
  });

  it('renders every non-demo state without the demo marker', () => {
    render(<BrainChip />);
    act(() => modeStore.set('local'));
    expect(chip().dataset.brain).toBe('local');
    act(() => modeStore.set('subscription'));
    expect(chip().dataset.brain).toBe('subscription');
    act(() => {
      webllmFlagStore.set(true);
      webgpuStore.set('yes');
    });
    expect(chip().dataset.brain).toBe('webllm');
  });
});

describe('the brain menu (AC4)', () => {
  it('opens with the pinned demo body and the pinned BYOK honesty copy', () => {
    render(<BrainChip />);
    act(() => chip().click());
    const opened = menu();
    expect(opened).not.toBeNull();
    expect(opened!.textContent).toContain(DEMO_BRAIN_BODY);
    expect(opened!.textContent).toContain(BYOK_HONESTY_COPY);
    // The claims themselves, byte-pinned — editing them is a decision, not a tweak.
    expect(DEMO_BRAIN_BODY).toBe(
      'a tiny script inside this page fakes the AI so you can try the flow — no AI model or service is called.',
    );
    expect(BYOK_HONESTY_COPY).toBe(
      'your key is saved in your Snug file on this device and sent only to the AI provider you choose — never to Snug’s servers.',
    );
    // The overclaim this task forbids must not creep back in any spelling.
    expect(opened!.textContent!.toLowerCase()).not.toContain('never leaves your device');
  });

  it('always offers the settings route; the demo state phrases it as the key invitation', () => {
    render(<BrainChip />);
    act(() => chip().click());
    const keyLink = document.querySelector('[data-testid="brain-menu-settings"]');
    expect(keyLink).toBeInstanceOf(HTMLAnchorElement);
    expect((keyLink as HTMLAnchorElement).getAttribute('href')).toBe('/settings');
    expect(keyLink!.textContent).toContain('use your own AI key');
  });

  it('offers "use ollama now" ONLY when the probe found models, and it switches the mode', () => {
    render(<BrainChip />);
    act(() => chip().click());
    expect(document.querySelector('[data-testid="brain-menu-ollama"]')).toBeNull();

    act(() => ollamaStore.set({ running: true, models: ['llama3.2', 'qwen3'] }));
    const setModeSpy = vi.spyOn(mode, 'setMode');
    const ollamaButton = document.querySelector('[data-testid="brain-menu-ollama"]');
    expect(ollamaButton).toBeInstanceOf(HTMLButtonElement);
    expect(ollamaButton!.textContent).toContain('2 models');
    act(() => (ollamaButton as HTMLButtonElement).click());
    expect(setModeSpy).toHaveBeenCalledWith('local');
    // Acting on the menu closes it.
    expect(menu()).toBeNull();
  });

  it('closes on Escape and outside click, restoring focus to the chip', () => {
    render(<BrainChip />);
    act(() => chip().click());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());

    act(() => chip().click());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('a real-provider state gets its own honest sentence, not the demo pitch', () => {
    act(() => {
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
      providerStore.set('anthropic');
    });
    render(<BrainChip />);
    act(() => chip().click());
    const opened = menu();
    expect(opened!.textContent).not.toContain(DEMO_BRAIN_BODY);
    expect(opened!.textContent).toContain('browser-direct to Anthropic');
    // The settings route stays reachable after switching — the chip never nags,
    // but it keeps being the door.
    expect(document.querySelector('[data-testid="brain-menu-settings"]')).not.toBeNull();
  });
});
