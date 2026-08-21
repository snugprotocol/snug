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

  it('shows the full URL — the path is the field that distinguishes the request', () => {
    // WHY: threat-model R-8 rests on this dialog "naming host, method and URL on
    // every mutating call" — it is the wall behind the prompt-injection residual.
    // Host+method alone cannot distinguish `POST /notes` from `POST /transfer?to=…`,
    // which is exactly the difference an injected instruction would exploit. The
    // chat-lane card already renders the URL (ChatLog.tsx); the modal did not.
    mount();
    openConfirm(() => undefined);
    expect(container.textContent ?? '').toContain('https://api.example.com/v1/items');
  });

  it('says the session grant covers ANY path on that host — it is keyed (app, host, method)', () => {
    // The remember checkbox is honest about its own breadth or it manufactures
    // consent: `session-confirm.ts` keys grants on (appId, host, method) with NO
    // path component, so approving one benign POST authorizes every POST path on
    // that host for the session.
    mount();
    openConfirm(() => undefined);
    expect((container.textContent ?? '').toLowerCase()).toContain('any path');
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
