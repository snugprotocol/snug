// authSurface — the JSX branches that consume the auth state machine (AC-item1).
//
// `authState.test.ts` covers the state machine itself (200 -> signed-in, 401 ->
// anonymous, 404/network -> unavailable). This suite covers what the machine is FOR:
// whether the Google sign-in affordance actually renders. That branch had no test,
// which is why "I don't see Google sign in" read as a missing feature rather than an
// unset SNUG_AUTH — the button is real and gated on /auth/me answering 401.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountCard } from '../views/SettingsView.js';
import { IdentityChip } from '../App.js';
import { authStore, type AuthState } from '../state/auth.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: ReactElement, auth: AuthState): string {
  authStore.set(auth);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container.textContent ?? '';
}

beforeEach(() => {
  authStore.set({ state: 'unknown' });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  authStore.set({ state: 'unknown' });
});

describe('IdentityChip', () => {
  it('offers sign-in only when the hub advertises an auth surface (401 -> anonymous)', () => {
    const text = render(<IdentityChip />, { state: 'anonymous' });
    expect(text).toContain('sign in');
  });

  it('renders nothing when the hub has no auth surface (404 -> unavailable)', () => {
    const text = render(<IdentityChip />, { state: 'unavailable' });
    expect(text).toBe('');
    expect(container?.querySelector('button')).toBeNull();
  });

  it('shows the account identity once signed in, not a sign-in button', () => {
    const text = render(<IdentityChip />, { state: 'signed-in', user: { userId: 'u-1', name: 'Ada' } });
    expect(text).toContain('Ada');
    // The chip became a menu trigger in TASK-20260804-hub-polish (AC1), so "no <button>
    // at all" no longer expresses this test's point. What must stay true is that the
    // signed-in state offers no sign-IN affordance — asserted on the label, not the tag.
    const buttons = [...(container?.querySelectorAll('button') ?? [])];
    expect(buttons.some((el) => (el.textContent ?? '').includes('sign in'))).toBe(false);
  });
});

describe('AccountCard', () => {
  it('renders the Google sign-in button when anonymous', () => {
    const text = render(<AccountCard />, { state: 'anonymous' });
    expect(text).toContain('sign in with google');
  });

  it('explains the absence instead of offering a dead button when unavailable', () => {
    const text = render(<AccountCard />, { state: 'unavailable' });
    expect(text).toContain('without an account surface');
    expect(text).not.toContain('sign in with google');
  });

  it('renders nothing until the probe resolves (no sign-in flash)', () => {
    render(<AccountCard />, { state: 'unknown' });
    expect(container?.textContent).toBe('');
  });
});
