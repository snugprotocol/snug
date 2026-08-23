// The review-before-opening panel (ADR-0052 §3). A prefilled GitHub URL transmits
// its query string the moment it is opened, so the confirm gate sits BEFORE any
// navigation and the fields shown are the builder's own — byte-equal to the URL's
// params (pinned in githubReport.test.ts). On desktop the confirm rides the
// platform's system-browser opener (the WebsiteLink pattern — a bare window.open
// would target the Tauri webview); on web it is a synchronous window.open inside
// the click gesture so no popup blocker refuses it.

import { useEffect, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { getPlatform } from '../platform/platform.js';
import type { PreparedReport } from './githubReport.js';

function openReportUrl(url: string): void {
  const opener = getPlatform().oauth?.openExternal;
  if (opener !== undefined) {
    void opener(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export interface ReportPreviewPopoverProps {
  report: PreparedReport;
  /** Where the confirm lands, for the heading — "a new GitHub issue", "GitHub Discussions". */
  destination: string;
  onClose(): void;
}

export function ReportPreviewPopover({ report, destination, onClose }: ReportPreviewPopoverProps): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="report-preview" data-testid="report-preview" role="dialog" aria-label={`review before opening ${destination}`}>
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
      <div className="report-preview-actions">
        <Button variant="primary" data-testid="report-confirm" onClick={() => {
          openReportUrl(report.url);
          onClose();
        }}>
          open on GitHub ↗
        </Button>
        <Button variant="ghost" data-testid="report-cancel" onClick={() => onClose()}>
          cancel
        </Button>
      </div>
    </div>
  );
}
