// The Settings surface of the feedback channel: the same three routes the header
// menu offers, laid out as a card for the person who goes LOOKING for a feedback
// button rather than stumbling on an error. Same preview-confirm as every path.

import { useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
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

export function FeedbackCard(): ReactElement {
  const [pending, setPending] = useState<PendingReport | null>(null);
  return (
    <Card className="settings-group">
      <p>
        found something broken, missing, or great? it lands on our GitHub (a GitHub account is needed to post) —
        you&apos;ll see exactly what gets prefilled first, and nothing is posted until you submit there.
      </p>
      <div className="feedback-card-actions">
        <Button
          onClick={() =>
            setPending({ report: buildBlankBugReport(reportEnvironment()), destination: 'a new GitHub issue' })
          }
        >
          report a bug
        </Button>
        <Button onClick={() => setPending({ report: buildFeatureRequest(), destination: 'a new GitHub issue' })}>
          request a feature
        </Button>
        <Button onClick={() => setPending({ report: buildFeedbackDiscussion(), destination: 'GitHub Discussions' })}>
          share feedback
        </Button>
      </div>
      {pending !== null ? (
        <div className="feedback-card-preview">
          <ReportPreviewPopover
            report={pending.report}
            destination={pending.destination}
            onClose={() => setPending(null)}
          />
        </div>
      ) : null}
    </Card>
  );
}
