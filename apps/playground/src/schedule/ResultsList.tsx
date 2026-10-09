// schedule/ResultsList.tsx — the results feed (TASK-20261009-scheduling-framework U2; design
// F9): every result across every schedule, newest first. A row is one line of what happened,
// then the schedule · the apps · when; an unread row carries a dot AND the word "unread"
// beside its status word (never colour alone, U9 — the word is `copy.RESULT_STATUS_WORD`'s,
// the same table the detail and the missed card read). The row is a link to the result detail
// (`routes.resultHref`; `ResultDetail` renders it); a *needs you* row carries its one act
// beside the link. *Mark all read* is one gesture.

import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';

import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { RESULT_STATUS_WORD, capped, needsYou, noHandler } from './copy.js';
import { RESULTS } from './copy.page.js';
import { relativeTime, type AppIndex, type ResultRow } from './pageModel.js';
import { resultHref } from './routes.js';
import { markAllSeen } from './scheduler.js';
import { appIdsOf } from './taskShape.js';

/** The one line a result reads as: the first step's summary, else the status's own sentence. */
export function resultSummary(run: ScheduleRun, item: ScheduledTask, apps: AppIndex): string {
  const fromStep = run.steps.find((step) => step.summary !== undefined && step.summary !== '')?.summary;
  if (fromStep !== undefined) return fromStep;
  const firstApp = appIdsOf(item.steps)[0];
  const appName = firstApp === undefined ? item.title : apps.name(firstApp);
  switch (run.status) {
    case 'needs-you':
      return needsYou(appName, run.reason ?? 'change anything').text;
    case 'no-handler':
      return noHandler(appName).text;
    case 'capped':
      return capped(run.reason?.includes('net') === true ? 'network call' : 'AI call');
    default:
      return run.reason ?? RESULT_STATUS_WORD[run.status];
  }
}

export interface ResultsListProps {
  rows: readonly ResultRow[];
  apps: AppIndex;
  now: Date;
}

export function ResultsList({ rows, apps, now }: ResultsListProps): ReactElement {
  const navigate = useNavigate();
  const unread = rows.filter((row) => row.run.seenAt === undefined).length;
  return (
    <section className="schedule-results" aria-labelledby="schedule-results-heading" data-testid="schedule-results">
      <div className="schedule-section-head">
        <h2 className="section-title" id="schedule-results-heading">
          {RESULTS.heading}
          {unread > 0 ? <span className="schedule-count"> · {unread} {RESULTS.unread}</span> : null}
        </h2>
        {unread > 0 ? (
          <Button variant="ghost" onClick={() => void markAllSeen()} data-testid="results-mark-all-read">
            {RESULTS.markAllRead}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="schedule-hint">{RESULTS.none}</p>
      ) : (
        <ul className="schedule-result-list">
          {rows.map(({ run, item, at }) => {
            const unseen = run.seenAt === undefined;
            const appIds = appIdsOf(item.steps);
            const names = appIds.map((appId) => apps.name(appId));
            const firstApp = appIds[0];
            const needs = run.status === 'needs-you' ? needsYou(firstApp === undefined ? item.title : apps.name(firstApp), run.reason ?? 'change anything') : undefined;
            const word = RESULT_STATUS_WORD[run.status];
            return (
              <li
                key={`${run.taskId}:${run.dueAt}`}
                className={`schedule-result${unseen ? ' is-unread' : ''}`}
                data-testid="schedule-result"
                data-status={run.status}
                data-unread={unseen ? 'true' : 'false'}
              >
                <Link to={resultHref(run.taskId, run.dueAt)} className="schedule-result-link">
                  <span className="schedule-result-status">
                    {unseen ? <span className="schedule-dot" aria-hidden="true" /> : null}
                    <span className="schedule-result-word">{unseen ? `${RESULTS.unread} · ${word}` : word}</span>
                  </span>
                  <span className="schedule-result-summary">{resultSummary(run, item, apps)}</span>
                  <span className="schedule-result-meta">
                    {[item.title, ...(names.length > 0 ? [names.join(', ')] : []), relativeTime(new Date(at), now)].join(' · ')}
                  </span>
                </Link>
                {needs !== undefined && firstApp !== undefined ? (
                  <Button variant="ghost" className="schedule-result-act" onClick={() => navigate(`/run/${firstApp}`)} data-testid="result-needs-you-act">
                    {needs.action}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
