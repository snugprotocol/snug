// The three general feedback routes, single-homed (Gate-5 review): the header
// menu and the Settings card render the same list, so a route or destination
// rename cannot drift between them.

import {
  buildBlankBugReport,
  buildFeatureRequest,
  buildFeedbackDiscussion,
  type PreparedReport,
} from './githubReport.js';
import { reportEnvironment } from './environment.js';

export interface PendingReport {
  report: PreparedReport;
  /** Where the confirm lands, for the preview heading. */
  destination: string;
}

export interface FeedbackRoute {
  label: string;
  make(): PendingReport;
}

export const FEEDBACK_ROUTES: FeedbackRoute[] = [
  {
    label: 'report a bug',
    make: () => ({ report: buildBlankBugReport(reportEnvironment()), destination: 'a new GitHub issue' }),
  },
  {
    label: 'request a feature',
    make: () => ({ report: buildFeatureRequest(), destination: 'a new GitHub issue' }),
  },
  {
    label: 'share feedback',
    make: () => ({ report: buildFeedbackDiscussion(), destination: 'GitHub Discussions' }),
  },
];
