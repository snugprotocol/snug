// The review-before-opening panel (ADR-0052 §3). A prefilled GitHub URL transmits
// its query string the moment it is opened, so the confirm gate sits BEFORE any
// navigation and the fields shown are the builder's own — derived from the same
// entries as the URL params. Dismissal: Escape (with stopPropagation — the wizard
// Sheet closes on the same window keydown, and dismissing a preview must never
// take the whole wizard with it) and click-away, both registered ONCE with the
// latest onClose read through a ref (callers pass inline closures; re-registering
// per parent render would churn document listeners on every streamed token).
//
// Opening: the platform's GENERIC opener seat when present (desktop system
// browser — deliberately NOT oauth.openExternal, whose pending-flow bind is an
// OAuth side effect), else a synchronous window.open inside the click gesture so
// no popup blocker refuses it. A failed or blocked open keeps the popover OPEN
// and offers the URL as a plain user-gesture anchor — silently closing on failure
// would tell the user a report happened when nothing opened.

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { getPlatform } from '../platform/platform.js';
import type { PreparedReport } from './githubReport.js';

export interface ReportPreviewPopoverProps {
  report: PreparedReport;
  /** Where the confirm lands, for the heading — "a new GitHub issue", "GitHub Discussions". */
  destination: string;
  onClose(): void;
}

export function ReportPreviewPopover({ report, destination, onClose }: ReportPreviewPopoverProps): ReactElement {
  const [openFailed, setOpenFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target !== null && rootRef.current?.contains(target) === true) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, []);

  const confirm = (): void => {
    const opener = getPlatform().openExternalUrl;
    if (opener !== undefined) {
      opener(report.url).then(
        () => closeRef.current(),
        () => setOpenFailed(true),
      );
      return;
    }
    const win = window.open(report.url, '_blank', 'noopener,noreferrer');
    if (win === null) {
      setOpenFailed(true);
      return;
    }
    onClose();
  };

  return (
    <div
      ref={rootRef}
      className="report-preview"
      data-testid="report-preview"
      role="dialog"
      aria-label={`review before opening ${destination}`}
    >
      <p className="hint">
        this opens {destination} on github.com — nothing is submitted until you choose to there.
        {report.fields.length > 0 ? ' what travels in the link:' : ' nothing is prefilled; you write it there.'}
      </p>
      {report.fields.map((field) => (
        <div key={field.label} className="report-field">
          <span className="report-field-label">{field.label}</span>
          <pre className="report-field-value">{field.value}</pre>
        </div>
      ))}
      {openFailed ? (
        <p className="error-note" role="alert" data-testid="report-open-failed">
          the browser couldn&apos;t be opened —{' '}
          <a href={report.url} target="_blank" rel="noreferrer" data-testid="report-fallback-link">
            open it in a new tab yourself
          </a>
          .
        </p>
      ) : null}
      <div className="report-preview-actions">
        <Button variant="primary" data-testid="report-confirm" onClick={confirm}>
          open on GitHub ↗
        </Button>
        <Button variant="ghost" data-testid="report-cancel" onClick={() => onClose()}>
          cancel
        </Button>
      </div>
    </div>
  );
}
