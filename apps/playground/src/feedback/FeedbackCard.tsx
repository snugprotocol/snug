// The Settings surface of the feedback channel: the same shared routes the header
// menu offers (routes.ts — single-homed so the two surfaces cannot drift), laid
// out as a card for the person who goes LOOKING for a feedback button rather than
// stumbling on an error. Same preview-confirm as every path.

import { useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { FEEDBACK_ROUTES, type PendingReport } from './routes.js';
import { ReportPreviewPopover } from './ReportPreviewPopover.js';

export function FeedbackCard(): ReactElement {
  const [pending, setPending] = useState<PendingReport | null>(null);
  return (
    <Card className="settings-group">
      <p>
        found something broken, missing, or great? it lands on our GitHub (a GitHub account is needed to post) —
        you&apos;ll see exactly what gets prefilled first, and nothing is posted until you submit there.
      </p>
      <div className="feedback-card-actions">
        {FEEDBACK_ROUTES.map((route) => (
          <Button key={route.label} onClick={() => setPending(route.make())}>
            {route.label}
          </Button>
        ))}
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
