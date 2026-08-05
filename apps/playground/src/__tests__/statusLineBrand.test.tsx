// Phase E of TASK-20260804-observability-caching: brand polish (AC1-AC3) and the
// rotating status line that replaces the last-write-wins pill (AC9-AC11).
//
// Per D0/Q1 the pill is REPLACED, not simply deleted: the factual record of what ran
// survives as the tools nested under each round trip (AC5, Phase D). Only the duplicate
// always-visible surface goes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusLine, pickStatusMessages } from '../views/StatusLine.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

/** Drive `prefers-reduced-motion`, which jsdom does not implement on its own. */
function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AC10 — status copy is phase-appropriate and differs between build and edit', () => {
  // Asserted at the COPY SELECTION level, not by scraping the DOM for specific strings:
  // the messages are editable copy, and a test that pins exact wording would break on
  // every rewrite while proving nothing about phase-appropriateness.
  it('offers different messages for a first build than for editing an existing app', () => {
    const first = pickStatusMessages('build');
    const edit = pickStatusMessages('edit');
    expect(first).not.toEqual(edit);
    expect(first.length).toBeGreaterThan(1); // there is something to rotate THROUGH
    expect(edit.length).toBeGreaterThan(1);
  });

  it('uses creation language for a first build and adjustment language for an edit', () => {
    // A weak but real semantic check: the two sets must not merely differ, they must
    // read as the phase they belong to.
    const first = pickStatusMessages('build').join(' ').toLowerCase();
    const edit = pickStatusMessages('edit').join(' ').toLowerCase();
    expect(/planning|designing|building|sketching|drafting/.test(first)).toBe(true);
    expect(/adjust|refin|updat|revis|tweak/.test(edit)).toBe(true);
  });

  it('never returns an empty set for either phase', () => {
    expect(pickStatusMessages('build').length).toBeGreaterThan(0);
    expect(pickStatusMessages('edit').length).toBeGreaterThan(0);
  });
});

describe('AC9 — one rotating status line replaces the pill', () => {
  it('renders a single status line, not a list of steps', () => {
    stubReducedMotion(false);
    const el = mount(<StatusLine phase="build" active />);
    expect(el.querySelectorAll('[data-testid="status-line"]')).toHaveLength(1);
    expect(el.querySelector('.reasoning-pill')).toBeNull();
  });

  it('renders nothing when the turn is not active', () => {
    stubReducedMotion(false);
    const el = mount(<StatusLine phase="build" active={false} />);
    expect(el.querySelector('[data-testid="status-line"]')).toBeNull();
  });

  it('rotates to a different message over time', () => {
    stubReducedMotion(false);
    vi.useFakeTimers();
    const el = mount(<StatusLine phase="build" active />);
    const first = el.querySelector('[data-testid="status-line"]')?.textContent;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const later = el.querySelector('[data-testid="status-line"]')?.textContent;
    expect(first).toBeTruthy();
    expect(later).not.toBe(first);
  });
});

describe('AC11 — prefers-reduced-motion is honored', () => {
  it('does NOT rotate messages when reduced motion is requested', () => {
    stubReducedMotion(true);
    vi.useFakeTimers();
    const el = mount(<StatusLine phase="build" active />);
    const first = el.querySelector('[data-testid="status-line"]')?.textContent;
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(el.querySelector('[data-testid="status-line"]')?.textContent).toBe(first);
  });

  it('marks the line as non-animated when reduced motion is requested', () => {
    stubReducedMotion(true);
    const el = mount(<StatusLine phase="build" active />);
    const line = el.querySelector('[data-testid="status-line"]');
    expect(line?.getAttribute('data-animated')).toBe('false');
  });

  it('animates by default when reduced motion is NOT requested', () => {
    stubReducedMotion(false);
    const el = mount(<StatusLine phase="build" active />);
    expect(el.querySelector('[data-testid="status-line"]')?.getAttribute('data-animated')).toBe('true');
  });

  it('still shows a message under reduced motion — the information is not lost', () => {
    stubReducedMotion(true);
    const el = mount(<StatusLine phase="build" active />);
    expect((el.querySelector('[data-testid="status-line"]')?.textContent ?? '').length).toBeGreaterThan(0);
  });
});
