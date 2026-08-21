// mobileViewToggle — TASK-20260821-hardening-polish item 5 (AC5): on mobile (≤760px)
// the run view is an EITHER/OR full-view toggle — the app view or "watch it think",
// never both, never a bottom-sheet modal. The choice is deliberately NOT persisted
// (owner decision, plan: "default should always be app view"), so every mount lands
// on the app view.
//
// RunView owns the mobileView decision (local useState, plus the isMobile branch), so
// this suite mounts RunView itself — the altitude where the decision is made (lessons
// 2026-08-05), the same harness railTabs.test.tsx uses. What jsdom cannot see —
// geometry, the CSS that actually hides the iframe — is e2e/mobile.spec.ts's job.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RunView from '../run/RunView.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

function unmountRun(): void {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** The mobile app ⇄ think toggle; throws loudly when the contract is broken. */
function toggle(el: HTMLElement): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>('[data-testid="mobile-view-toggle"]');
  if (button === null) throw new Error('no mobile view toggle rendered');
  return button;
}

beforeEach(async () => {
  // The repo's matchMedia precedent (railTabs.test.tsx), pointed the other way: ONLY
  // the mobile breakpoint matches, so RunView takes its isMobile branch while every
  // other query (theme, motion) stays false.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === '(max-width: 760px)',
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
  unmountRun();
  vi.restoreAllMocks();
});

describe('mobile run view is an either/or full-view toggle (AC5)', () => {
  it('mounts on the app view: stage rendered, NO think surface, toggle honest', async () => {
    const el = mountRun('starter--chess');
    await settle();

    // The app fills the screen…
    expect(el.querySelector('[data-testid="frame-wrap"]')).not.toBeNull();
    // …and no think surface renders at all — not hidden, absent.
    expect(el.querySelector('[data-testid="mobile-think"]')).toBeNull();
    expect(el.querySelector('[aria-label="rail tabs"]')).toBeNull();
    // The bottom-sheet modal is gone from the run path — no dialog anywhere.
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const button = toggle(el);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // The accessible name mirrors the desktop rail toggle's convention.
    expect(button.getAttribute('aria-label')).toBe('show watch it think');
  });

  it('the toggle swaps to a FULL think view (app stage stays mounted) and back', async () => {
    const el = mountRun('starter--chess');
    await settle();

    act(() => {
      toggle(el).click();
    });

    // Think view: rail content (tab strip + panel) is in, as a view — not a dialog.
    const think = el.querySelector('[data-testid="mobile-think"]');
    expect(think).not.toBeNull();
    expect(think!.querySelector('[aria-label="rail tabs"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The layout class is what the 760px CSS keys the swap on.
    expect(el.querySelector('.run-layout')!.classList.contains('is-mobile-think')).toBe(true);
    // The stage is hidden by CSS, never unmounted — unmounting would destroy the
    // running app's state. jsdom proves "still mounted"; e2e proves "actually hidden".
    expect(el.querySelector('[data-testid="frame-wrap"]')).not.toBeNull();

    const pressed = toggle(el);
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.getAttribute('aria-label')).toBe('hide watch it think');

    act(() => {
      pressed.click();
    });
    expect(el.querySelector('[data-testid="mobile-think"]')).toBeNull();
    expect(el.querySelector('.run-layout')!.classList.contains('is-mobile-think')).toBe(false);
    expect(toggle(el).getAttribute('aria-pressed')).toBe('false');
  });

  it('a REMOUNT resets to the app view — the choice is never persisted', async () => {
    // Mutation check for the owner's "default should always be app view": were
    // mobileView lifted into a persisted store (the railShown pattern), the second
    // mount below would come up on the think view and this test would fail —
    // deliberately, storage is NOT cleared between the two mounts.
    const first = mountRun('starter--chess');
    await settle();
    act(() => {
      toggle(first).click();
    });
    expect(first.querySelector('[data-testid="mobile-think"]')).not.toBeNull();

    unmountRun();
    const second = mountRun('starter--chess');
    await settle();

    expect(second.querySelector('[data-testid="mobile-think"]')).toBeNull();
    expect(toggle(second).getAttribute('aria-pressed')).toBe('false');
    expect(second.querySelector('[data-testid="frame-wrap"]')).not.toBeNull();
  });
});
