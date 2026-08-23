// The inline "report this" affordance (ADR-0052 §2). It renders ONLY where an
// error is already showing — the caller sits it inside an existing `error-note` —
// and it is a quiet link, never a second banner. Clicking builds the report at
// that moment (environment and mode read live) and opens the preview; nothing
// navigates until the preview's confirm.

import { useState, type ReactElement } from 'react';

import { buildBugReport, type PreparedReport, type ReportSurface } from './githubReport.js';
import { reportEnvironment } from './environment.js';
import { ReportPreviewPopover } from './ReportPreviewPopover.js';

export interface ReportErrorContext {
  surface: ReportSurface;
  errorText: string;
  appName?: string;
  starterId?: string;
  starterVersion?: string;
}

export function ReportErrorLink({ context }: { context: ReportErrorContext }): ReactElement {
  const [report, setReport] = useState<PreparedReport | null>(null);
  return (
    <span className="report-error-wrap">
      <button
        type="button"
        className="report-error-link"
        data-testid="report-error-link"
        onClick={() => setReport(buildBugReport({ ...context, environment: reportEnvironment() }))}
      >
        report this ↗
      </button>
      {report !== null ? (
        <ReportPreviewPopover report={report} destination="a new GitHub issue" onClose={() => setReport(null)} />
      ) : null}
    </span>
  );
}
