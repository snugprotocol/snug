// FeedbackMenu — TASK-20260822-feedback-loop AC4: the general entry point routes
// bug / feature request / open feedback to the right prefilled destination, always
// through the same preview-confirm (one honesty rule for every path).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackMenu } from '../feedback/FeedbackMenu.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let openSpy: ReturnType<typeof vi.fn>;

function render(node: ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).click();
  });
}

function openMenuItem(label: string): void {
  click(container!.querySelector('[data-testid="feedback-menu-trigger"]'));
  const item = Array.from(container!.querySelectorAll('[data-testid="feedback-menu"] button')).find((b) =>
    (b.textContent ?? '').includes(label),
  );
  click(item ?? null);
}

beforeEach(() => {
  openSpy = vi.fn();
  vi.stubGlobal('open', openSpy);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
});

describe('FeedbackMenu (AC4)', () => {
  it('renders one quiet trigger and no menu until clicked', () => {
    render(<FeedbackMenu />);
    const trigger = container!.querySelector('[data-testid="feedback-menu-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('aria-haspopup')).toBe('menu');
    expect(container!.querySelector('[data-testid="feedback-menu"]')).toBeNull();
  });

  it('offers the three routes', () => {
    render(<FeedbackMenu />);
    click(container!.querySelector('[data-testid="feedback-menu-trigger"]'));
    const text = container!.querySelector('[data-testid="feedback-menu"]')!.textContent ?? '';
    expect(text).toContain('report a bug');
    expect(text).toContain('request a feature');
    expect(text).toContain('share feedback');
  });

  it('report a bug → preview → confirm opens the bug form with the environment prefilled', () => {
    render(<FeedbackMenu />);
    openMenuItem('report a bug');
    expect(openSpy).not.toHaveBeenCalled(); // preview first, always
    click(container!.querySelector('[data-testid="report-confirm"]'));
    const [url] = openSpy.mock.calls[0] as [string];
    expect(url).toContain('/issues/new?');
    expect(url).toContain('template=bug_report.yml');
    expect(url).toContain('environment=');
  });

  it('request a feature → confirm opens the feature form', () => {
    render(<FeedbackMenu />);
    openMenuItem('request a feature');
    click(container!.querySelector('[data-testid="report-confirm"]'));
    const [url] = openSpy.mock.calls[0] as [string];
    expect(url).toContain('template=feature_request.yml');
  });

  it('share feedback → confirm opens the General discussions composer', () => {
    render(<FeedbackMenu />);
    openMenuItem('share feedback');
    click(container!.querySelector('[data-testid="report-confirm"]'));
    const [url] = openSpy.mock.calls[0] as [string];
    expect(url).toBe('https://github.com/snugprotocol/snug/discussions/new?category=general');
  });

  it('Escape closes the menu without navigating', () => {
    render(<FeedbackMenu />);
    click(container!.querySelector('[data-testid="feedback-menu-trigger"]'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container!.querySelector('[data-testid="feedback-menu"]')).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
