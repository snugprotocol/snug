// AL-03 D5 — the mutating-call confirm dialog. Observes netConfirmStore; renders the
// (app, host, method) the app wants to call and a "remember for this session" checkbox;
// Allow/Deny resolve the parked confirm with the chosen decision (open Q1 / R3).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetConfirmDialog } from '../run/NetConfirmDialog.js';
import { netConfirmStore } from '../state/net.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<NetConfirmDialog />));
}

beforeEach(() => netConfirmStore.set(null));
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

const openConfirm = (resolve: (d: { granted: boolean; rememberSession?: boolean }) => void): void => {
  act(() => {
    netConfirmStore.set({
      request: { appId: 'app-1', host: 'api.example.com', method: 'POST', url: 'https://api.example.com/v1/items' },
      resolve,
    });
  });
};

describe('NetConfirmDialog', () => {
  it('renders nothing when no confirm is pending', () => {
    mount();
    expect(container.textContent).toBe('');
  });

  it('shows the host and method when a confirm opens', () => {
    mount();
    openConfirm(() => undefined);
    const text = container.textContent ?? '';
    expect(text).toContain('api.example.com');
    expect(text).toContain('POST');
  });

  it('Allow resolves granted:false-remember by default (plain grant, not remembered)', () => {
    mount();
    const resolve = vi.fn();
    openConfirm(resolve);
    const allow = [...container.querySelectorAll('button')].find((b) => /allow/i.test(b.textContent ?? ''));
    act(() => allow!.click());
    expect(resolve).toHaveBeenCalledWith({ granted: true, rememberSession: false });
  });

  it('the remember checkbox flows into the decision', () => {
    mount();
    const resolve = vi.fn();
    openConfirm(resolve);
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    const allow = [...container.querySelectorAll('button')].find((b) => /allow/i.test(b.textContent ?? ''));
    act(() => allow!.click());
    expect(resolve).toHaveBeenCalledWith({ granted: true, rememberSession: true });
  });

  it('Deny resolves granted:false', () => {
    mount();
    const resolve = vi.fn();
    openConfirm(resolve);
    const deny = [...container.querySelectorAll('button')].find((b) => /deny|decline|block/i.test(b.textContent ?? ''));
    act(() => deny!.click());
    expect(resolve).toHaveBeenCalledWith({ granted: false });
  });
});
