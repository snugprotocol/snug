// useDismissableMenu — the shared header-popover dismissal contract (TASK-20260826).
//
// FeedbackMenu's header said it plainly: "a shared useDismissableMenu hook is queued
// in next-steps for whichever popover arrives third." The brain chip was the third,
// so this is that hook — one home for the open state, the trigger/menu refs, and the
// Escape + outside-pointer dismissal with focus restored to the trigger (so keyboard
// users are never dropped at the top of the document). Consumers: IdentityChip,
// FeedbackMenu, BrainChip. A dismissal-behavior fix now lands once.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface DismissableMenu {
  open: boolean;
  /** Trigger click handler — toggles. */
  toggle: () => void;
  /** Close; `restoreFocus` returns focus to the trigger (Escape/outside do). */
  close: (restoreFocus: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement>;
  menuRef: RefObject<HTMLDivElement>;
}

export function useDismissableMenu(): DismissableMenu {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(true);
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (
        target !== null &&
        (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true)
      ) {
        return;
      }
      close(true);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  const toggle = useCallback((): void => setOpen((prev) => !prev), []);

  return { open, toggle, close, triggerRef, menuRef };
}
