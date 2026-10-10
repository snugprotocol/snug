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

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1, Gate-5 folds F-4 and F-5.
//
// F-4 (security MINOR) THE DIALOG RESOLVES ITS OWN ENTRY, never the store head. Withdrawals now
// move the queue head WITHOUT a user act (a scheduled ask withdrawn when its run ends or its
// minute passes, `denyParkedConfirmByRequest`), so between the render the user is looking at and
// the click, the head can become a DIFFERENT entry. A click must reach only the entry the dialog
// rendered (or be dropped if that one is gone) — it must never grant the entry that slid under
// the user's pointer. The pins move the head WITHOUT a re-render (inside one `act`, so React
// commits nothing between the move and the click) and prove the DOM still showed the first entry
// when the button was pressed, so a red here is the decision's routing, not a re-render.
//
// F-5 (security MINOR) the scheduled bodies DELIMIT the app name — `“<appName>”`, like the
// schedule's title — so an app's display name cannot read as part of the host's sentence.
// ---------------------------------------------------------------------------------------------

describe('NetConfirmDialog — the decision reaches the entry it rendered (TASK-20261010-host-broker PR-1, fold F-4)', () => {
  type Decision = { granted: boolean; rememberSession?: boolean };
  const FIRST = { appId: 'app-1', host: 'api.example.com', method: 'POST' as const, url: 'https://api.example.com/v1/first' };
  const SECOND = { appId: 'app-2', host: 'bank.example.com', method: 'POST' as const, url: 'https://bank.example.com/v1/transfer?to=someone' };

  const button = (name: RegExp): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((b) => name.test((b.textContent ?? '').trim()));
    if (found === undefined) throw new Error(`no button ${String(name)}`);
    return found as HTMLButtonElement;
  };

  for (const variant of ['ordinary', 'scheduled'] as const) {
    it(`${variant}: the head moves under the click (withdrawn, no re-render) → the SECOND entry never receives the grant; only the rendered entry is answered`, () => {
      mount();
      const first = vi.fn<(d: Decision) => void>();
      const second = vi.fn<(d: Decision) => void>();
      const tag = variant === 'scheduled' ? { scheduled: { title: 'Morning post', appName: 'Notes', runId: 'run-1' } } : {};
      act(() => {
        netConfirmStore.set({ request: FIRST, resolve: first, ...tag });
      });
      expect(container.textContent ?? '').toContain(FIRST.url);
      const allow = button(variant === 'scheduled' ? new RegExp(`^${DELEGATED_CONFIRM.allow}$`) : /^allow$/);

      let urlShownAtClick = '';
      act(() => {
        // The first entry is withdrawn out from under the dialog: the queue head is now the second.
        netConfirmStore.set({ request: SECOND, resolve: second, ...tag });
        urlShownAtClick = container.querySelector('.net-confirm-url')?.textContent ?? '';
        allow.click();
      });

      expect(urlShownAtClick, 'harness: the dialog still showed the FIRST entry when the button was pressed').toBe(FIRST.url);
      expect(second, 'the entry that slid under the click was never granted').not.toHaveBeenCalled();
      expect(first.mock.calls.every(([decision]) => decision.granted === true)).toBe(true);
    });
  }

  it('through the REAL queue: two scheduled confirms parked by the page’s own gate; the rendered head withdrawn by reference (`denyParkedConfirmByRequest`), then *allow once* → the second is NOT granted, nothing is sent for it, and it stays parked', async () => {
    const net = await import('../state/net.js');
    const { getUserDb } = await import('../state/userdb.js');
    const { installTestUserDb } = await import('./userdbTestHelper.js');
    const { beginDelegatedRun, endDelegatedRun, clearTouchedGeneration } = await import('../schedule/runPlacement.js');
    net.__resetNetStateForTests();
    await installTestUserDb();
    const db = await getUserDb();
    const requirement = {
      slot: 'example',
      kind: 'api_key' as const,
      provider: { name: 'Example' },
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
      declaredApiHosts: ['api.example.com'],
    };
    for (const appId of ['f4-a', 'f4-b']) {
      db.installApp({ appId, displayName: appId, html: '<p>x</p>' });
      db.setSecret(`auth:${appId}:example:api_key`, 'stored-key');
      db.putDeclaredConnection(appId, 'example', requirement, 'inference');
      db.approveConnection(appId, 'example');
    }
    const fetched: string[] = [];
    const handler = net.createNetHandlerFor({
      fetchImpl: async (url) => {
        fetched.push(url);
        return new Response('{}', { status: 200 });
      },
    });
    const post = (appId: string, path: string) =>
      handler.handle(appId, { v: 1, type: 'snug:net-request', requestId: `r-${appId}`, instanceId: 'ins-1', url: `https://api.example.com${path}`, method: 'POST', body: '{}' });
    // A delegated run in flight for each app: the run-scoped gate (the frame path's default) parks a `scheduled` ask for each.
    expect(beginDelegatedRun({ appId: 'f4-a', appName: 'Notes', runId: 'run-a', taskId: 't1', title: 'Morning post', generation: 0 }).ok).toBe(true);
    expect(beginDelegatedRun({ appId: 'f4-b', appName: 'Bank', runId: 'run-b', taskId: 't2', title: 'Evening sweep', generation: 0 }).ok).toBe(true);
    try {
      mount();
      const a = post('f4-a', '/v1/first');
      await vi.waitFor(() => expect(net.netConfirmStore.get()?.request.appId).toBe('f4-a'));
      let bSettled = false;
      const b = post('f4-b', '/v1/transfer').then((result) => {
        bSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20)); // the second ask parks BEHIND the head
      act(() => undefined); // the dialog renders the head
      const head = net.netConfirmStore.get()!;
      expect(head.request.appId).toBe('f4-a');
      expect(container.textContent ?? '').toContain('https://api.example.com/v1/first');
      const allow = button(new RegExp(`^${DELEGATED_CONFIRM.allow}$`));

      let headAtClick: string | undefined;
      let urlShownAtClick = '';
      act(() => {
        net.denyParkedConfirmByRequest(head.request); // withdrawn without a user act: the head is now f4-b's entry
        headAtClick = net.netConfirmStore.get()?.request.appId;
        urlShownAtClick = container.querySelector('.net-confirm-url')?.textContent ?? '';
        allow.click();
      });
      expect(headAtClick, 'harness: the queue head moved to the second entry before the click').toBe('f4-b');
      expect(urlShownAtClick, 'harness: the dialog still showed the FIRST entry when the button was pressed').toBe('https://api.example.com/v1/first');
      expect(await a).toMatchObject({ ok: false }); // the withdrawn ask answered no
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetched, 'nothing was sent for the entry that slid under the click').toEqual([]);
      expect(bSettled, 'the second ask is still waiting for its own answer').toBe(false);
      expect(net.netConfirmStore.get()?.request.appId, 'the second entry is still parked').toBe('f4-b');
      endDelegatedRun('f4-b', 'run-b'); // its run ends: withdrawn
      expect(await b).toMatchObject({ ok: false });
    } finally {
      endDelegatedRun('f4-a', 'run-a');
      endDelegatedRun('f4-b', 'run-b');
      clearTouchedGeneration('f4-a', 0);
      clearTouchedGeneration('f4-b', 0);
      net.__resetNetStateForTests();
    }
  });
});

describe('NetConfirmDialog — the scheduled bodies delimit the app name (TASK-20261010-host-broker PR-1, fold F-5)', () => {
  const REQUEST = { appId: 'app-1', host: 'api.example.com', method: 'POST' as const, url: 'https://api.example.com/v1/items' };

  it('the run body and the after-run body both render the app name in typographic quotes — “Weather”', () => {
    mount();
    act(() => {
      netConfirmStore.set({ request: REQUEST, resolve: () => undefined, scheduled: { title: 'Morning forecast', appName: 'Weather', runId: 'run-1' } });
    });
    expect(container.textContent ?? '').toContain('“Weather”');
    expect(DELEGATED_CONFIRM.body('Morning forecast', 'Weather', 'POST', 'api.example.com')).toContain('“Weather”');

    act(() => {
      netConfirmStore.set({ request: REQUEST, resolve: () => undefined, scheduled: { afterRun: true, appName: 'Weather' } });
    });
    expect(container.textContent ?? '').toContain('“Weather”');
    expect(DELEGATED_CONFIRM.afterRunBody('Weather', 'POST', 'api.example.com')).toContain('“Weather”');
  });
});
