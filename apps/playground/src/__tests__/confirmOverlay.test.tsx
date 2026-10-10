// confirmOverlay.test.tsx — the shared overlay's OPT-IN accessibility (TASK-20261010-cross-app-access
// AC18): `onDismiss` (Escape and a backdrop press), `labelledBy`, `initialFocusRef`, and
// `trapFocus` (Tab cycles inside the card; focus goes back where it was when the overlay closes).
//
// Every row is paired with its "not asked for" twin: the sheets that pass none of the new props
// (share, schedule, the update confirms, the helper) keep exactly the behaviour they had — no
// Escape, no backdrop dismissal, no focus moves.

import { act, useRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let outside: HTMLButtonElement | undefined;

beforeEach(() => {
  outside = document.createElement('button');
  outside.textContent = 'outside';
  document.body.appendChild(outside);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  outside?.remove();
  container = undefined;
  outside = undefined;
});

interface Opts {
  onDismiss?: () => void;
  labelled?: boolean;
  focusSecond?: boolean;
  trapFocus?: boolean;
  /** A radio pair (the second checked) BEFORE the buttons — the card's first focusable stop. */
  radios?: boolean;
}

function Harness({ onDismiss, labelled, focusSecond, trapFocus, radios }: Opts): ReactElement {
  const second = useRef<HTMLButtonElement>(null);
  return (
    <ConfirmOverlay
      {...(labelled === true ? { labelledBy: 'probe-title' } : { ariaLabel: 'probe sheet' })}
      {...(onDismiss !== undefined ? { onDismiss } : {})}
      {...(focusSecond === true ? { initialFocusRef: second } : {})}
      {...(trapFocus === true ? { trapFocus: true } : {})}
      data-testid="probe"
    >
      <h2 id="probe-title">probe title</h2>
      {radios === true ? (
        <div role="radiogroup" aria-label="probe choice">
          <input type="radio" name="probe-choice" value="a" data-testid="radio-a" readOnly checked={false} />
          <input type="radio" name="probe-choice" value="b" data-testid="radio-b" readOnly checked />
        </div>
      ) : null}
      <button data-testid="first">first</button>
      <button data-testid="second" ref={second}>
        second
      </button>
      <button data-testid="disabled" disabled>
        disabled
      </button>
      <button data-testid="last">last</button>
    </ConfirmOverlay>
  );
}

const overlay = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="probe"]')!;
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.querySelector<T>(`[data-testid="${id}"]`)!;
const key = (target: EventTarget, init: KeyboardEventInit): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
};

function render(opts: Opts = {}): void {
  act(() => root!.render(<Harness {...opts} />));
}

describe('ConfirmOverlay — onDismiss (Escape and the backdrop), only when asked for', () => {
  it('Escape calls onDismiss once', () => {
    const onDismiss = vi.fn();
    render({ onDismiss });
    key(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a press that starts AND ends on the backdrop calls onDismiss; one inside the card never does', () => {
    const onDismiss = vi.fn();
    render({ onDismiss });
    act(() => {
      byId('first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      byId('first').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).not.toHaveBeenCalled();
    // A drag that began in the card and ended on the backdrop is not a dismissal either.
    act(() => {
      byId('first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('without onDismiss, Escape and the backdrop do nothing (the other sheets are unchanged)', () => {
    render();
    key(document.body, { key: 'Escape' });
    act(() => {
      overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(overlay()).not.toBeNull();
  });
});

describe('ConfirmOverlay — the dialog is named', () => {
  it('labelledBy names the dialog by its title (aria-labelledby, no aria-label)', () => {
    render({ labelled: true });
    expect(overlay().getAttribute('role')).toBe('dialog');
    expect(overlay().getAttribute('aria-modal')).toBe('true');
    expect(overlay().getAttribute('aria-labelledby')).toBe('probe-title');
    expect(overlay().hasAttribute('aria-label')).toBe(false);
  });

  it('the type demands EXACTLY one name — an unnamed dialog, or one named twice, does not compile', () => {
    // @ts-expect-error — no name: a role=dialog with no accessible name
    const unnamed = <ConfirmOverlay>{null}</ConfirmOverlay>;
    // @ts-expect-error — two names: which one is meant?
    const twice = <ConfirmOverlay ariaLabel="probe sheet" labelledBy="probe-title">{null}</ConfirmOverlay>;
    expect([unnamed, twice]).toHaveLength(2);
  });

  it('without labelledBy the aria-label stays exactly as before', () => {
    render();
    expect(overlay().getAttribute('aria-label')).toBe('probe sheet');
    expect(overlay().hasAttribute('aria-labelledby')).toBe(false);
  });
});

describe('ConfirmOverlay — focus, only when asked for', () => {
  it('initialFocusRef focuses that element when the overlay opens', () => {
    render({ focusSecond: true });
    expect(document.activeElement).toBe(byId('second'));
  });

  it('with no initialFocusRef focus does not move', () => {
    outside!.focus();
    render();
    expect(document.activeElement).toBe(outside);
  });

  it('trapFocus: Tab from the last control goes to the first, Shift+Tab from the first goes to the last (disabled ones skipped)', () => {
    render({ trapFocus: true });
    byId('last').focus();
    key(byId('last'), { key: 'Tab' });
    expect(document.activeElement).toBe(byId('first'));
    key(byId('first'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(byId('last'));
  });

  it('trapFocus: a radio group is ONE stop at its checked radio — Tab from the last control wraps to the checked radio, never the unchecked one', () => {
    render({ trapFocus: true, radios: true });
    expect(byId<HTMLInputElement>('radio-b').checked).toBe(true);
    byId('last').focus();
    key(byId('last'), { key: 'Tab' });
    expect(document.activeElement).toBe(byId('radio-b'));
    expect(document.activeElement).not.toBe(byId('radio-a'));
    key(byId('radio-b'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(byId('last'));
  });

  it('trapFocus: focus that sits outside the card is brought back in on Tab', () => {
    render({ trapFocus: true });
    outside!.focus();
    key(outside!, { key: 'Tab' });
    expect(document.activeElement).toBe(byId('first'));
  });

  it('without trapFocus Tab is left to the browser', () => {
    render();
    byId('last').focus();
    key(byId('last'), { key: 'Tab' });
    expect(document.activeElement).toBe(byId('last'));
  });

  it('trapFocus: closing the overlay returns focus to what had it when it opened', () => {
    outside!.focus();
    render({ trapFocus: true, focusSecond: true });
    expect(document.activeElement).toBe(byId('second'));
    act(() => root!.render(<></>));
    expect(document.activeElement).toBe(outside);
  });

  it('without trapFocus closing leaves focus alone', () => {
    outside!.focus();
    render({ focusSecond: true });
    act(() => root!.render(<></>));
    expect(document.activeElement).not.toBe(outside);
  });
});
