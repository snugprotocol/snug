// AL-03 D5 — the mutating-call confirm dialog. Observes netConfirmStore; renders the
// (app, host, method) the app wants to call and a "remember for this session" checkbox;
// Allow/Deny resolve the parked confirm with the chosen decision (open Q1 / R3).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetConfirmDialog } from '../run/NetConfirmDialog.js';
import { DELEGATED_CONFIRM } from '../schedule/copy.js';
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

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1 — the SCHEDULED variant (ADR-0077 §3; contract v2 D-PR1-3).
//
// A delegated run's mutating call parks on the SAME queue, tagged `scheduled`. The dialog then
// speaks for the host, not the app: a host-composed title (never the schedule's own title — an
// app-authored string must not headline a consent surface), a body that quotes the schedule and
// says in one breath that the user did not click this, that *allow once* means once and that
// silence means no. The verbatim URL stays (R-8). There is NO remember box: a scheduled grant is
// never remembered, so the dialog must not offer what the gate would not honour — and the
// decision it resolves carries no `rememberSession` key at all. Every string comes from
// `schedule/copy.ts` (`DELEGATED_CONFIRM`), never a literal here.
// ---------------------------------------------------------------------------------------------

describe('NetConfirmDialog — the scheduled variant (TASK-20261010-host-broker PR-1)', () => {
  const REQUEST = { appId: 'app-1', host: 'api.example.com', method: 'POST' as const, url: 'https://api.example.com/v1/items?draft=1' };

  const openScheduled = (resolve: (d: { granted: boolean; rememberSession?: boolean }) => void): void => {
    act(() => {
      netConfirmStore.set({
        request: REQUEST,
        resolve,
        scheduled: { title: 'Morning post', appName: 'Notes', runId: 'run-1' },
      });
    });
  };

  const openAfterRun = (resolve: (d: { granted: boolean; rememberSession?: boolean }) => void): void => {
    act(() => {
      netConfirmStore.set({ request: REQUEST, resolve, scheduled: { afterRun: true, appName: 'Notes' } });
    });
  };

  const buttonNamed = (name: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === name) as HTMLButtonElement | undefined;

  it('renders the HOST-composed title — never the schedule’s own title as the heading', () => {
    mount();
    openScheduled(() => undefined);
    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe(DELEGATED_CONFIRM.title);
  });

  it('the body quotes the schedule and names the app, the method and the host — from `DELEGATED_CONFIRM.body`', () => {
    mount();
    openScheduled(() => undefined);
    const text = container.textContent ?? '';
    expect(text).toContain(DELEGATED_CONFIRM.body('Morning post', 'Notes', 'POST', 'api.example.com'));
    expect(text).toContain('Morning post');
    expect(text).toContain('Notes');
    expect(text).toContain('POST');
    expect(text).toContain('api.example.com');
  });

  it('R-8: the full URL is still shown verbatim', () => {
    mount();
    openScheduled(() => undefined);
    expect(container.textContent ?? '').toContain('https://api.example.com/v1/items?draft=1');
  });

  it('offers NO remember box — a scheduled grant is never remembered, so the dialog does not offer it', () => {
    mount();
    openScheduled(() => undefined);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect((container.textContent ?? '').toLowerCase()).not.toContain('remember for this session');
  });

  it('*allow once* resolves `{ granted: true }` — with no `rememberSession` key at all', () => {
    mount();
    const resolve = vi.fn();
    openScheduled(resolve);
    const allow = buttonNamed(DELEGATED_CONFIRM.allow);
    expect(allow).toBeDefined();
    act(() => allow!.click());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toStrictEqual({ granted: true });
  });

  it('*don’t send* resolves `{ granted: false }`', () => {
    mount();
    const resolve = vi.fn();
    openScheduled(resolve);
    const deny = buttonNamed(DELEGATED_CONFIRM.deny);
    expect(deny).toBeDefined();
    act(() => deny!.click());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toStrictEqual({ granted: false });
  });

  it('the after-run variant renders `DELEGATED_CONFIRM.afterRunBody`, the host title, the URL and no remember box', () => {
    mount();
    openAfterRun(() => undefined);
    const text = container.textContent ?? '';
    expect(container.querySelector('h2')?.textContent).toBe(DELEGATED_CONFIRM.title);
    expect(text).toContain(DELEGATED_CONFIRM.afterRunBody('Notes', 'POST', 'api.example.com'));
    expect(text).toContain('https://api.example.com/v1/items?draft=1');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('the after-run variant’s *allow once* also resolves `{ granted: true }` with no `rememberSession` key', () => {
    mount();
    const resolve = vi.fn();
    openAfterRun(resolve);
    act(() => buttonNamed(DELEGATED_CONFIRM.allow)!.click());
    expect(resolve.mock.calls[0]![0]).toStrictEqual({ granted: true });
  });

  it('an UNTAGGED confirm is unchanged: the app’s title, the remember box, allow/deny', () => {
    mount();
    openConfirm(() => undefined);
    expect(container.querySelector('h2')?.textContent).not.toBe(DELEGATED_CONFIRM.title);
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
  });
});
