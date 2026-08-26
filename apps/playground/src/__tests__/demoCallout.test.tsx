// demoCallout — TASK-20260826-demo-brain-clarity AC6 (ADR-0059 rule 1, first contact).
//
// A NOTE, never a gate (lessons 2026-08-20: prominence that blocks is a modal with
// extra steps): the first-visit callout renders inline in the builder while the demo
// brain is active and the latch is unset, and the composer stays fully usable beside
// it. Dismissal persists INTO THE USER FILE (the firstRun.ts rule — the file is the
// identity; a reinstalled app must not re-welcome a veteran file), under its OWN key
// (the protection-offer lesson: latches never share exits). Once a real brain is
// active the callout is gone regardless of the latch — its job belongs to the chip.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { byokKeyPresenceStore, modeStore, providerStore } from '../state/mode.js';
import { demoCalloutStore, dismissDemoCallout, initDemoCallout } from '../state/demoCallout.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { BuilderView } from '../views/BuilderView.js';
import { DemoBrainCallout } from '../views/DemoBrainCallout.js';
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

const callout = (): Element | null => document.querySelector('[data-testid="demo-brain-callout"]');

beforeEach(async () => {
  await installTestUserDb();
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  demoCalloutStore.set(false);
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('the first-contact latch (AC6)', () => {
  it('arms on a fresh file, and dismissal persists into the user file', async () => {
    await initDemoCallout();
    expect(demoCalloutStore.get()).toBe(true);
    act(() => dismissDemoCallout());
    expect(demoCalloutStore.get()).toBe(false);
    await settle();
    // The same file re-initializing (a reload) must stay dismissed.
    await initDemoCallout();
    expect(demoCalloutStore.get()).toBe(false);
  });
});

describe('the callout surface (AC6)', () => {
  it('renders while the demo brain is active and the latch is armed — and not otherwise', async () => {
    await initDemoCallout();
    render(<DemoBrainCallout />);
    expect(callout()).not.toBeNull();
    // A real brain takes over the story regardless of the latch.
    act(() => {
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
      providerStore.set('anthropic');
    });
    expect(callout()).toBeNull();
  });

  it('renders nothing once dismissed', async () => {
    await initDemoCallout();
    act(() => dismissDemoCallout());
    render(<DemoBrainCallout />);
    expect(callout()).toBeNull();
  });

  it('offers the settings route (latching on the way out) and a plain dismissal', async () => {
    await initDemoCallout();
    render(<DemoBrainCallout />);
    const settingsLink = document.querySelector('[data-testid="demo-callout-settings"]');
    expect(settingsLink).toBeInstanceOf(HTMLAnchorElement);
    expect((settingsLink as HTMLAnchorElement).getAttribute('href')).toBe('/settings');
    const dismiss = document.querySelector('[data-testid="demo-callout-dismiss"]');
    expect(dismiss).toBeInstanceOf(HTMLButtonElement);
    act(() => (dismiss as HTMLButtonElement).click());
    expect(callout()).toBeNull();
    expect(demoCalloutStore.get()).toBe(false);
  });

  it('is a note, not a gate: the builder composer stays usable beside it', async () => {
    await initDemoCallout();
    render(<BuilderView />);
    await settle();
    expect(callout()).not.toBeNull();
    // No dialog semantics, no overlay — and the composer is right there.
    expect(callout()!.getAttribute('role')).not.toBe('dialog');
    const composer = document.querySelector('textarea[aria-label="describe your app"]');
    expect(composer).not.toBeNull();
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });
});
