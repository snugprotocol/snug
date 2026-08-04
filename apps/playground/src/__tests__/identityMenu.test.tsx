// identityMenu — TASK-20260804-hub-polish Phase D.
// Covers AC1 (chip opens a menu containing sign out, wired to signOut() from
// state/sync.ts — never bare logout(), per review F14), AC2 (Escape + outside
// click close, focus returns to the trigger, aria-expanded/aria-haspopup,
// keyboard reachable), AC3 (settings no longer renders a sign-out control while
// the identity line remains), AC6 (avatar <img> when `picture` is present, initial
// fallback when absent OR when the image errors) and AC7 (referrerPolicy).
//
// The sign-out wiring is asserted at the module boundary: `signOut` is what
// sequences logout() -> initSync(), so a chip that called the bare logout() would
// leave the sync provider holding a stale CSRF token. The spy therefore has to be
// on state/sync.js, and a spy on state/auth.js's logout must NOT be what fires.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountCard } from '../views/SettingsView.js';
import { IdentityChip } from '../App.js';
import { authStore, type AuthState } from '../state/auth.js';
import * as sync from '../state/sync.js';
import * as auth from '../state/auth.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: ReactElement, state: AuthState): void {
  authStore.set(state);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

const signedIn: AuthState = { state: 'signed-in', user: { userId: 'u-1', name: 'Ada' } };

function trigger(): HTMLButtonElement {
  const el = container?.querySelector<HTMLButtonElement>('button.identity-chip');
  if (el === null || el === undefined) throw new Error('identity chip trigger not found');
  return el;
}

/** The menu is queried by role so the test fails if the ARIA contract is dropped. */
function menu(): HTMLElement | null {
  return container?.querySelector<HTMLElement>('.identity-menu') ?? null;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function itemNamed(name: string): HTMLElement {
  const items = [...(container?.querySelectorAll<HTMLElement>('.identity-menu-item') ?? [])];
  const found = items.find((el) => (el.textContent ?? '').includes(name));
  if (found === undefined) throw new Error(`no menu item matching "${name}" (saw: ${items.map((i) => i.textContent).join(', ')})`);
  return found;
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
  vi.restoreAllMocks();
});

describe('IdentityChip menu (AC1, AC2)', () => {
  it('renders a menu trigger button, not a bare settings link, once signed in', () => {
    render(<IdentityChip />, signedIn);
    const el = trigger();
    // 'true', not 'menu': role="menu" was dropped because its APG keyboard contract
    // (arrow navigation, roving focus) was never implemented — see App.tsx. The trigger
    // still announces that it opens something.
    expect(el.getAttribute('aria-haspopup')).toBe('true');
    expect(el.getAttribute('aria-expanded')).toBe('false');
    // Closed by default — no menu in the tree until it is opened.
    expect(menu()).toBeNull();
  });

  it('opens the menu on click and flips aria-expanded', () => {
    render(<IdentityChip />, signedIn);
    click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const open = menu();
    expect(open).not.toBeNull();
    expect(open?.textContent).toContain('Ada');
    expect(open?.textContent).toContain('sign out');
  });

  it('keeps a route to account & sync settings so the affordance is not lost', () => {
    render(<IdentityChip />, signedIn);
    click(trigger());
    const settings = itemNamed('settings');
    expect(settings.getAttribute('href')).toBe('/settings');
  });

  it('every menu item is keyboard reachable (no tabindex=-1 traps, real controls)', () => {
    render(<IdentityChip />, signedIn);
    click(trigger());
    const items = [...(container?.querySelectorAll<HTMLElement>('.identity-menu-item') ?? [])];
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      // A link with href or a button is natively focusable; an explicit -1 would remove it.
      expect(item.getAttribute('tabindex')).not.toBe('-1');
      const focusable = item.tagName === 'BUTTON' || (item.tagName === 'A' && item.hasAttribute('href'));
      expect(focusable).toBe(true);
    }
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<IdentityChip />, signedIn);
    click(trigger());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on an outside click and returns focus to the trigger', () => {
    render(<IdentityChip />, signedIn);
    click(trigger());
    expect(menu()).not.toBeNull();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    outside.remove();
  });

  it('does NOT close when the click lands inside the menu', () => {
    render(<IdentityChip />, signedIn);
    click(trigger());
    const open = menu();
    act(() => {
      open?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
  });
});

describe('IdentityChip sign out wiring (AC1 / review F14)', () => {
  it('calls signOut() from state/sync.ts, which rebuilds the sync loop', () => {
    const signOut = vi.spyOn(sync, 'signOut').mockResolvedValue(undefined);
    render(<IdentityChip />, signedIn);
    click(trigger());
    click(itemNamed('sign out'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('does NOT call the bare logout() from state/auth.ts (stale CSRF trap)', () => {
    // signOut is the only sanctioned path; it is stubbed so the real logout()
    // inside it cannot fire and mask a direct call from the component.
    vi.spyOn(sync, 'signOut').mockResolvedValue(undefined);
    const logout = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);
    render(<IdentityChip />, signedIn);
    click(trigger());
    click(itemNamed('sign out'));
    expect(logout).not.toHaveBeenCalled();
  });

  it('closes the menu after signing out', () => {
    vi.spyOn(sync, 'signOut').mockResolvedValue(undefined);
    render(<IdentityChip />, signedIn);
    click(trigger());
    click(itemNamed('sign out'));
    expect(menu()).toBeNull();
  });
});

describe('IdentityChip avatar (AC6, AC7)', () => {
  const withPicture: AuthState = {
    state: 'signed-in',
    user: { userId: 'u-1', name: 'Ada', picture: 'https://lh3.googleusercontent.com/a/abc123' },
  };

  it('renders an <img> avatar when `picture` is present', () => {
    render(<IdentityChip />, withPicture);
    const img = container?.querySelector<HTMLImageElement>('img.identity-avatar');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://lh3.googleusercontent.com/a/abc123');
  });

  it('carries referrerPolicy="no-referrer" and attaches no credentials (AC7)', () => {
    render(<IdentityChip />, withPicture);
    const img = container?.querySelector<HTMLImageElement>('img.identity-avatar');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    // crossOrigin would turn this into a credentialed/CORS fetch — it must be absent.
    expect(img?.hasAttribute('crossorigin')).toBe(false);
  });

  it('falls back to the initial-letter circle when `picture` is absent', () => {
    render(<IdentityChip />, signedIn);
    expect(container?.querySelector('img.identity-avatar')).toBeNull();
    const span = container?.querySelector('span.identity-avatar');
    expect(span?.textContent).toBe('A');
  });

  it('falls back to the initial-letter circle when the image fails to load (onError)', () => {
    render(<IdentityChip />, withPicture);
    const img = container?.querySelector<HTMLImageElement>('img.identity-avatar');
    expect(img).not.toBeNull();
    act(() => {
      img?.dispatchEvent(new Event('error', { bubbles: false }));
    });
    expect(container?.querySelector('img.identity-avatar')).toBeNull();
    expect(container?.querySelector('span.identity-avatar')?.textContent).toBe('A');
  });
});

describe('AccountCard (AC3)', () => {
  it('no longer renders a sign-out control', () => {
    render(<AccountCard />, signedIn);
    const text = container?.textContent ?? '';
    expect(text).not.toContain('sign out');
    const controls = [...(container?.querySelectorAll('button, a') ?? [])];
    expect(controls.some((el) => (el.textContent ?? '').toLowerCase().includes('sign out'))).toBe(false);
  });

  it('keeps the signed-in identity line', () => {
    render(<AccountCard />, signedIn);
    expect(container?.textContent).toContain('signed in as Ada');
  });

  it('keeps the "sync to this hub" affordance when no origin is set', () => {
    render(<AccountCard />, signedIn);
    const controls = [...(container?.querySelectorAll('button') ?? [])];
    expect(controls.some((el) => (el.textContent ?? '').includes('sync to this hub'))).toBe(true);
  });
});
