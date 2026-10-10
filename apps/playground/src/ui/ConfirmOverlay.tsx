/**
 * ConfirmOverlay — the `net-confirm-overlay` / `net-confirm-card` pair, ALWAYS portaled to
 * `<body>` (TASK-20260826 AC1). `.shell-header` carries `backdrop-filter`, which makes it the
 * containing block for `position: fixed` descendants (WebKit and Chromium alike): an overlay
 * rendered in place from a header chip is the size of the header, and its card sits
 * "chopped off at the top centre" — the owner's report, reproduced by screenshot. No CSS on
 * the card can fix a containing block; only rendering outside the header can, so the portal
 * lives HERE, once, rather than as a convention at every call site.
 *
 * OPT-IN ACCESSIBILITY (TASK-20261010-cross-app-access AC18). A sheet that asks for them gets:
 *  - `onDismiss` — Escape, or a press that starts AND ends on the backdrop (a text selection
 *    dragged out of the card is not a dismissal), calls it;
 *  - `labelledBy` — the dialog is named by its own title (`aria-labelledby`) instead of `ariaLabel`;
 *  - `initialFocusRef` — that element takes focus when the overlay opens;
 *  - `trapFocus` — Tab and Shift+Tab cycle inside the card, and when the overlay closes focus goes
 *    back to whatever held it when it opened (if that is still on the page).
 * A sheet that passes none of them behaves exactly as before: no key handling, no focus moves.
 */
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode, RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** The card's focusable controls in DOM order, minus unchecked radios of a group whose checked one is there (Tab lands on the checked radio). */
function focusablesIn(card: HTMLElement): HTMLElement[] {
  const all = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const checkedGroups = new Set(
    all.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === 'radio' && element.checked).map((radio) => radio.name),
  );
  return all.filter(
    (element) => !(element instanceof HTMLInputElement && element.type === 'radio' && !element.checked && element.name !== '' && checkedGroups.has(element.name)),
  );
}

/**
 * How the dialog is named — EXACTLY one of the two, so no caller can ship an unnamed modal:
 * `ariaLabel` (a string), or `labelledBy` (the id of the element that names it — its title).
 */
export type ConfirmOverlayNaming = { ariaLabel: string; labelledBy?: undefined } | { labelledBy: string; ariaLabel?: undefined };

export type ConfirmOverlayProps = ConfirmOverlayNaming & {
  cardClassName?: string;
  children: ReactNode;
  /** Escape and a backdrop press call this. Absent: neither does anything. */
  onDismiss?: () => void;
  /** Focused when the overlay opens. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Tab cycles inside the card; focus returns where it was when the overlay closes. */
  trapFocus?: boolean;
  'data-testid'?: string;
};

export function ConfirmOverlay({
  ariaLabel,
  labelledBy,
  cardClassName,
  children,
  onDismiss,
  initialFocusRef,
  trapFocus = false,
  'data-testid': testId,
}: ConfirmOverlayProps): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  // The latest callback, read at the event — the listener below is subscribed once per mount.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismissable = onDismiss !== undefined;

  // Focus in, and (trapFocus) back out. A layout effect: the element that held focus is read
  // before anything inside the card could take it.
  useLayoutEffect(() => {
    const previous = trapFocus && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocusRef?.current?.focus();
    return () => {
      if (previous !== null && previous.isConnected) previous.focus();
    };
    // Mount and unmount only: a re-render must never pull focus back to the initial element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dismissable && !trapFocus) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && dismissRef.current !== undefined) {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== 'Tab' || !trapFocus) return;
      const card = cardRef.current;
      if (card === null) return;
      const focusables = focusablesIn(card);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !card.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dismissable, trapFocus]);

  const backdropHandlers = dismissable
    ? {
        onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
          pressStartedOnBackdrop.current = event.target === event.currentTarget;
        },
        onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
          const startedHere = pressStartedOnBackdrop.current;
          pressStartedOnBackdrop.current = false;
          if (startedHere && event.target === event.currentTarget) dismissRef.current?.();
        },
      }
    : {};

  const naming = labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : { 'aria-label': ariaLabel };
  return createPortal(
    <div className="net-confirm-overlay" role="dialog" aria-modal="true" {...naming} data-testid={testId} {...backdropHandlers}>
      <div ref={cardRef} className={cardClassName === undefined ? 'net-confirm-card' : `net-confirm-card ${cardClassName}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
