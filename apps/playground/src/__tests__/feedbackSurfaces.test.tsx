// Feedback surfaces — TASK-20260822-feedback-loop AC2 (inline error reporting is
// preview-gated: NOTHING navigates on render or on opening the preview; only the
// explicit confirm opens GitHub) + the ChatLog build-failure mount.
//
// The navigation spy is `window.open` — on web the confirm opens a new tab with
// noopener/noreferrer (the desktop system-browser path is pinned in
// feedbackDesktopOpen.test.tsx). There is no fetch anywhere in the feedback
// module by design (ADR-0052: no receiver exists), so "nothing sends" is
// equivalent to "nothing navigates".

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportErrorLink } from '../feedback/ReportErrorLink.js';
import { ChatLog } from '../views/ChatLog.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';

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

const ctx = { surface: 'build' as const, errorText: 'the model reply could not be parsed' };

describe('ReportErrorLink (AC2)', () => {
  it('renders a quiet affordance and navigates NOTHING on render', () => {
    render(<ReportErrorLink context={ctx} />);
    expect(container!.querySelector('[data-testid="report-error-link"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="report-preview"]')).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens a preview showing the prefill; still nothing navigates', () => {
    render(<ReportErrorLink context={ctx} />);
    click(container!.querySelector('[data-testid="report-error-link"]'));
    const preview = container!.querySelector('[data-testid="report-preview"]');
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain('the model reply could not be parsed');
    // The environment line travels too and the preview must show it.
    expect(preview!.textContent).toContain('web');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('confirm opens exactly the built URL in a new tab, then closes the preview', () => {
    render(<ReportErrorLink context={ctx} />);
    click(container!.querySelector('[data-testid="report-error-link"]'));
    click(container!.querySelector('[data-testid="report-confirm"]'));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0] as [string, string, string];
    expect(url).toContain('https://github.com/snugprotocol/snug/issues/new?');
    expect(url).toContain('template=bug_report.yml');
    expect(target).toBe('_blank');
    expect(features).toContain('noopener');
    expect(container!.querySelector('[data-testid="report-preview"]')).toBeNull();
  });

  it('cancel closes the preview without navigating', () => {
    render(<ReportErrorLink context={ctx} />);
    click(container!.querySelector('[data-testid="report-error-link"]'));
    click(container!.querySelector('[data-testid="report-cancel"]'));
    expect(container!.querySelector('[data-testid="report-preview"]')).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('ChatLog build-failure mount (AC2)', () => {
  it('a failed build message carries the report affordance beside its error note', () => {
    const messages: ChatMessage[] = [
      {
        id: 1,
        role: 'agent',
        displayText: '',
        error: { code: 'PARSE_FAILED', message: 'the reply could not be parsed', retryable: true },
      },
    ];
    render(<ChatLog messages={messages} />);
    expect(container!.querySelector('.error-note')).not.toBeNull();
    expect(container!.querySelector('[data-testid="report-error-link"]')).not.toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('a healthy message renders no report affordance', () => {
    const messages: ChatMessage[] = [{ id: 1, role: 'agent', displayText: 'done!' }];
    render(<ChatLog messages={messages} />);
    expect(container!.querySelector('[data-testid="report-error-link"]')).toBeNull();
  });
});
