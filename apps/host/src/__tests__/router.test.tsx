// router.test.tsx — TASK-20261003 K3 (ADR-0072 §2): the kit's router is picked by a guarded
// CAPABILITY probe, never by origin.
//
// `HashRouter` navigates with `history.pushState(state, '', '#/…')`. At an opaque origin — a
// chat artifact is an `about:srcdoc` document, origin `null` — the History API refuses every
// URL (plan review, 2026-10-03), so a hash router cannot navigate there. Asking "what origin
// is this?" would be guessing which hosts behave that way; trying the one call the router
// needs, once, is the fact itself.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KitRouter, entryFromHash, pickRouter, type RouterWindow } from '../router.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A window whose History API accepts a hash URL — every origin with a real one. */
const working = (hash: string): { win: RouterWindow; replaced: unknown[][] } => {
  const replaced: unknown[][] = [];
  return { replaced, win: { location: { hash }, history: { state: { idx: 3 }, replaceState: (...args: unknown[]) => void replaced.push(args) } } };
};

/** A window whose History API refuses every URL — an opaque-origin document. */
const opaque = (hash: string): RouterWindow => ({
  location: { hash },
  history: {
    state: null,
    replaceState: () => {
      throw new DOMException("Failed to execute 'replaceState' on 'History': A history state object with URL 'about:srcdoc#/' cannot be created in a document with origin 'null' and URL 'about:srcdoc'.", 'SecurityError');
    },
  },
});

describe('pickRouter — a capability probe, not an origin check', () => {
  // The three shapes the kit has always run in keep HashRouter, exactly as today.
  it.each([
    ['file://', '#/settings'],
    ['the https artifact origin', '#/run/abc'],
    ['loopback http (the runner, a static server)', '#/'],
  ])('%s keeps HashRouter', (_where, hash) => {
    const { win, replaced } = working(hash);
    expect(pickRouter(win)).toEqual({ kind: 'hash' });
    // The probe is the router's own first act: the same state, the same hash — no new entry,
    // nothing the user could see or go "back" to.
    expect(replaced).toEqual([[{ idx: 3 }, '', hash]]);
  });

  it('an address with no hash is probed with the route the router would normalise to', () => {
    const { win, replaced } = working('');
    expect(pickRouter(win)).toEqual({ kind: 'hash' });
    expect(replaced).toEqual([[{ idx: 3 }, '', '#/']]);
  });

  it('where the History API refuses a hash URL → a memory router seeded from the hash', () => {
    expect(pickRouter(opaque('#/settings'))).toEqual({ kind: 'memory', initialEntries: ['/settings'] });
    expect(pickRouter(opaque(''))).toEqual({ kind: 'memory', initialEntries: ['/'] });
    expect(pickRouter(opaque('#/run/starter--chess?x=1'))).toEqual({ kind: 'memory', initialEntries: ['/run/starter--chess?x=1'] });
  });

  it('a `history` that cannot even be READ is a memory router too — the probe never throws', () => {
    const win = { location: { hash: '#/build' } } as RouterWindow;
    Object.defineProperty(win, 'history', {
      get(): never {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(pickRouter(win)).toEqual({ kind: 'memory', initialEntries: ['/build'] });
  });
});

describe('entryFromHash', () => {
  it('is the route inside the fragment, and the hub for anything that is not a route', () => {
    expect(entryFromHash('#/settings')).toBe('/settings');
    expect(entryFromHash('')).toBe('/');
    expect(entryFromHash('#')).toBe('/');
    // A fragment that is not a route (a stale launch token, an anchor) lands on the hub.
    expect(entryFromHash(`#token=${'a'.repeat(64)}`)).toBe('/');
    expect(entryFromHash('#section-2')).toBe('/');
  });
});

// ---- a kit that boots where the History API refuses every URL -------------------------

function Where(): JSX.Element {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function Shell(): JSX.Element {
  return (
    <>
      <nav>
        <Link to="/" data-testid="to-hub">
          your apps
        </Link>
        <Link to="/settings" data-testid="to-settings">
          settings
        </Link>
      </nav>
      <Where />
      <Routes>
        <Route path="/" element={<h1>hub</h1>} />
        <Route path="/settings" element={<h1>settings</h1>} />
      </Routes>
    </>
  );
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

const click = (testId: string): void => {
  const el = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (el == null) throw new Error(`no ${testId}`);
  act(() => el.click());
};
const where = (): string => container?.querySelector('[data-testid="where"]')?.textContent ?? '';

describe('boots with a history that refuses every URL, and navigates', () => {
  it('hub → settings → hub with no error — the opaque-origin document', () => {
    // The REAL window's History API, refusing as an `about:srcdoc` document's does.
    const refuse = (): never => {
      throw new DOMException("A history state object with URL 'about:srcdoc#/' cannot be created in a document with origin 'null'.", 'SecurityError');
    };
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(refuse);
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(refuse);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent): void => void errors.push(event.error);
    window.addEventListener('error', onError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));

    try {
      const choice = pickRouter(window);
      expect(choice.kind).toBe('memory');
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(
          <KitRouter choice={choice}>
            <Shell />
          </KitRouter>,
        );
      });
      expect(where()).toBe('/');
      click('to-settings');
      expect(where()).toBe('/settings');
      expect(container.querySelector('h1')?.textContent).toBe('settings');
      click('to-hub');
      expect(where()).toBe('/');
      expect(container.querySelector('h1')?.textContent).toBe('hub');
      expect(errors).toEqual([]);
      // The memory router never touched the History API after the probe's one attempt.
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('error', onError);
      consoleError.mockRestore();
    }
  });

  it('the negative twin: HashRouter under that same history DOES reach for pushState — and is refused', () => {
    // What the memory router is chosen to avoid. (react-router answers a refused pushState
    // with `location.assign` — its rescue for iOS's pushState quota — which is a navigation
    // of the document itself; jsdom follows it as a fragment change, an `about:srcdoc` frame
    // has no such luck. The claim here is only the one this suite can see: the call is made.)
    const refuse = (): never => {
      throw new DOMException('refused', 'SecurityError');
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <KitRouter choice={{ kind: 'hash' }}>
          <Shell />
        </KitRouter>,
      );
    });
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(refuse);
    click('to-settings');
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(String(pushState.mock.calls[0]![2])).toBe('#/settings');
  });

  it('where the History API works the kit mounts HashRouter and the address bar carries the route, as today', () => {
    window.location.hash = '#/';
    const choice = pickRouter(window);
    expect(choice).toEqual({ kind: 'hash' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <KitRouter choice={choice}>
          <Shell />
        </KitRouter>,
      );
    });
    click('to-settings');
    expect(where()).toBe('/settings');
    expect(window.location.hash).toBe('#/settings');
    click('to-hub');
    expect(window.location.hash).toBe('#/');
  });
});
