// The ONE persistent feedback affordance (ADR-0052 §2): a quiet header item — no
// bubble, no badge, no nag — opening a three-route menu (bug / feature / open
// feedback). Every route goes through the same preview-confirm the inline links
// use: one honesty rule for every path out. Menu behavior (Escape + outside click
// close, focus back to the trigger) copies the IdentityChip pattern.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import {
  buildBlankBugReport,
  buildFeatureRequest,
  buildFeedbackDiscussion,
  type PreparedReport,
} from './githubReport.js';
import { reportEnvironment } from './environment.js';
import { ReportPreviewPopover } from './ReportPreviewPopover.js';

interface PendingReport {
  report: PreparedReport;
  destination: string;
}

export function FeedbackMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingReport | null>(null);
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

  const route = (make: () => PendingReport): void => {
    close(false);
    setPending(make());
  };

  return (
    <span className="feedback-menu-wrap">
      {/* Raw button, not <Button>: the trigger needs a ref for focus restore and
          the shared Button deliberately does not forward one (IdentityChip precedent). */}
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost"
        data-testid="feedback-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="report a bug, request a feature, or share feedback — it lands on our GitHub"
        onClick={() => setOpen((v) => !v)}
      >
        feedback
      </button>
      {open ? (
        <div ref={menuRef} className="feedback-menu" data-testid="feedback-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              route(() => ({ report: buildBlankBugReport(reportEnvironment()), destination: 'a new GitHub issue' }))
            }
          >
            report a bug
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => route(() => ({ report: buildFeatureRequest(), destination: 'a new GitHub issue' }))}
          >
            request a feature
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => route(() => ({ report: buildFeedbackDiscussion(), destination: 'GitHub Discussions' }))}
          >
            share feedback
          </button>
        </div>
      ) : null}
      {pending !== null ? (
        <ReportPreviewPopover
          report={pending.report}
          destination={pending.destination}
          onClose={() => setPending(null)}
        />
      ) : null}
    </span>
  );
}
