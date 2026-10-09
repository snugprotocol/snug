// schedule/ScheduleHubSection.tsx — the hub's "schedule" section (TASK-20261009-scheduling-
// framework U1). Between "your apps" and "shared with you": the next three schedules (title ·
// when · next), an "all schedules" link with the unread count, and — when nothing is scheduled
// yet but a template's app is installed — that template as a one-line offer. It renders
// NOTHING when there are no schedules and no template fits: a first-time user with no starters
// sees no schedule section at all (the templates live on the page). Reports only; every act
// lives on `/schedule`.

import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { allows } from '../platform/platform.js';
import { HUB } from './copy.page.js';
import { describeSpec } from './cron.js';
import { nextFor, relativeTime, upcomingTasks, useNow } from './pageModel.js';
import { useScheduler } from './scheduler.js';
import { SCHEDULE_TEMPLATES, templateFits, templateHref } from './Templates.js';
import { editHref } from './ScheduleRow.js';

export interface ScheduleHubSectionProps {
  /** install_source → appId, the hub's dedup map (the templates' "fits" rule reads it). */
  installedBySource: ReadonlyMap<string, string>;
}

export function ScheduleHubSection({ installedBySource }: ScheduleHubSectionProps): ReactElement | null {
  const view = useScheduler();
  const now = useNow();
  if (!allows('schedule') || !view.ready) return null;
  const fitting = SCHEDULE_TEMPLATES.filter((template) => templateFits(template, installedBySource));
  if (view.tasks.length === 0 && fitting.length === 0) return null;
  const rows = upcomingTasks(view.tasks, now, 3);
  return (
    <section className="schedule-hub" aria-labelledby="schedule-hub-heading" data-testid="schedule-hub-section">
      <div className="schedule-section-head">
        <h2 className="section-title" id="schedule-hub-heading">
          {HUB.heading}
        </h2>
        <Link to="/schedule" className="schedule-hub-all" data-testid="schedule-hub-all">
          {HUB.all}
          {view.unseen > 0 ? <span className="schedule-count"> · {HUB.unread(view.unseen)}</span> : null}
        </Link>
      </div>
      {rows.length > 0 ? (
        <ul className="schedule-hub-list">
          {rows.map((item) => {
            const next = nextFor(item, now);
            return (
              <li key={item.id} className="schedule-hub-row" data-testid="schedule-hub-row">
                <Link to={editHref(item.id)} className="schedule-hub-link">
                  <span className="schedule-hub-title">{item.title}</span>
                  <span className="schedule-hub-when">{describeSpec(item.spec)}</span>
                  {next !== undefined ? <span className="schedule-hub-next">{relativeTime(next, now)}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {view.tasks.length === 0 ? (
        <ul className="schedule-hub-list">
          {fitting.map((template) => (
            <li key={template.id} className="schedule-hub-row" data-testid="schedule-hub-template">
              <Link to={templateHref(template.id)} className="schedule-hub-link">
                <span className="schedule-hub-title">{template.title}</span>
                <span className="schedule-hub-when">{describeSpec(template.spec)}</span>
                <span className="schedule-hub-next">{HUB.setUp}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
