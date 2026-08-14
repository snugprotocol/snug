// RailDivider — the drag handle between the app stage and the "watch it think" rail
// (TASK-20260813 AC4).
//
// Pointer events rather than mouse events, so a trackpad, a touchscreen and a pen all
// work from one code path; `setPointerCapture` keeps the drag alive when the cursor
// outruns the 6px handle, which is the difference between a splitter that feels solid
// and one that keeps dropping the drag.
//
// Keyboard-operable on purpose: a separator that only responds to dragging is unusable
// without a mouse, and this one controls whether a panel is legible at all. Arrow keys
// nudge, Home/End jump to the bounds — the standard `role="separator"` contract, so a
// screen reader announces the live width via aria-valuenow.

import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent, type ReactElement } from 'react';

import { RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN, railWidthMax, setRailWidth, useRailWidth } from '../state/railLayout.js';

/** One arrow press. Coarse enough to cross the range quickly, fine enough to aim. */
const STEP = 24;

export function RailDivider(): ReactElement {
  const width = useRailWidth();
  const dragging = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    // Only the primary button starts a drag — a right-click here should open the
    // context menu, not silently resize the panel.
    if (event.button !== 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Mark the layout mid-drag: the CSS then disables pointer events on the app iframe.
    // Without this the cross-origin frame swallows the pointer as soon as the cursor
    // crosses the stage, and the drag dies halfway — the classic splitter-over-iframe
    // bug. Pointer capture alone does not save us, because the iframe is a separate
    // document.
    event.currentTarget.closest('.run-layout')?.classList.add('is-resizing');
    event.preventDefault();
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    // The rail is anchored to the RIGHT edge, so its width is the distance from the
    // pointer to that edge — not the pointer's x, and not a delta that would drift.
    setRailWidth(window.innerWidth - event.clientX);
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    // Cleared FIRST and unconditionally: if this class survives a drag the app iframe
    // stays permanently unclickable, which is far worse than a resize that ends early.
    event.currentTarget.closest('.run-layout')?.classList.remove('is-resizing');
    // Releasing capture can throw if the pointer is already gone (window blur, tab
    // switch mid-drag). The drag is over either way, so failure here is not an error.
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // Left grows the rail because the rail sits on the right: dragging the divider
      // leftward is what makes it wider, and the keys must match the gesture.
      const next =
        event.key === 'ArrowLeft'
          ? width + STEP
          : event.key === 'ArrowRight'
            ? width - STEP
            : event.key === 'Home'
              ? railWidthMax()
              : event.key === 'End'
                ? RAIL_WIDTH_MIN
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      setRailWidth(next);
    },
    [width],
  );

  return (
    <div
      className="rail-divider"
      data-testid="rail-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="resize the watch it think panel"
      aria-valuenow={width}
      aria-valuemin={RAIL_WIDTH_MIN}
      aria-valuemax={railWidthMax()}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      // Double-click restores the default width — the conventional escape hatch after
      // a drag goes wrong, and cheaper than aiming for 340px by hand.
      onDoubleClick={() => setRailWidth(RAIL_WIDTH_DEFAULT)}
    >
      <span className="rail-divider-grip" aria-hidden="true" />
    </div>
  );
}
