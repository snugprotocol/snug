// The ONE persistent feedback affordance (ADR-0052 §2): a quiet header item — no
// bubble, no badge, no nag — opening the shared three-route menu (routes.ts, the
// same list the Settings card renders). Every route goes through the same
// preview-confirm the inline links use: one honesty rule for every path out.
// Menu behavior (Escape + outside click close, focus back to the trigger) rides the
// shared useDismissableMenu hook — extracted when the third popover (the brain chip,
// TASK-20260826) arrived, exactly as this file's earlier comment queued.

import { useState, type ReactElement } from 'react';

import { useDismissableMenu } from '../ui/useDismissableMenu.js';
import { FEEDBACK_ROUTES, type PendingReport } from './routes.js';
import { ReportPreviewPopover } from './ReportPreviewPopover.js';

export function FeedbackMenu(): ReactElement {
  const [pending, setPending] = useState<PendingReport | null>(null);
  const { open, toggle, close, triggerRef, menuRef } = useDismissableMenu();

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
        aria-label="feedback"
        title="report a bug, request a feature, or share feedback — it lands on our GitHub"
        onClick={toggle}
      >
        💬
      </button>
      {open ? (
        <div ref={menuRef} className="feedback-menu" data-testid="feedback-menu" role="menu">
          {FEEDBACK_ROUTES.map((route) => (
            <button
              key={route.label}
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                setPending(route.make());
              }}
            >
              {route.label}
            </button>
          ))}
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
