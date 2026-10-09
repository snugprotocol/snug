// views/ScheduleView.tsx — the /schedule route (TASK-20261009-scheduling-framework U2; design
// F1, F9, F11, F12) and the header's calendar item (U1). Reads the scheduler store and the
// library; writes nothing itself — every act is the engine's (`scheduler.ts`) and every
// sentence is `copy.ts` / `copy.page.ts`.
//
// The page, top to bottom: the honesty line under the heading (where the user decides, F6) ·
// the follower line when another tab is ticking · the global-pause banner · the CREATE BAR
// FIRST · the missed card · results (newest first) · the schedules grouped needs your
// attention / today / upcoming / paused · the templates, ALWAYS. Loading is a skeleton, a boot
// that failed is an `EmptyState` with the engine's one line, a host that says
// `allows('schedule') === false` gets a named refusal — never an empty main region.

import type { ReactElement, ReactNode } from 'react';
import { NavLink } from 'react-router';

import type { ScheduledTask } from '@snugprotocol/protocol';

import { allows } from '../platform/platform.js';
import { EMPTY, followerTab, globalPaused } from '../schedule/copy.js';
import { GROUPS, PAGE } from '../schedule/copy.page.js';
import { hostHonesty } from '../schedule/honesty.js';
import { MissedCard } from '../schedule/MissedCard.js';
import { attentionOf, groupTasks, resultRows, useAppIndex, useNow, type AppIndex } from '../schedule/pageModel.js';
import { ResultsList } from '../schedule/ResultsList.js';
import { ScheduleCreateBar } from '../schedule/ScheduleCreateBar.js';
import { ScheduleRow } from '../schedule/ScheduleRow.js';
import { setGlobalPause, useScheduler, type SchedulerView } from '../schedule/scheduler.js';
import { Templates } from '../schedule/Templates.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';

/** The named refusal for a host that cannot schedule (`allows('schedule') === false`). */
export function ScheduleUnavailable(): ReactElement {
  return (
    <div data-testid="schedule-unavailable">
      <EmptyState glyph="◷" title={PAGE.unavailableTitle} lesson={PAGE.unavailableLesson} />
    </div>
  );
}

/** Wraps a scheduling route: the children where the host allows it, the refusal where it does not. */
export function ScheduleGate({ children }: { children: ReactNode }): ReactElement {
  return allows('schedule') ? <>{children}</> : <ScheduleUnavailable />;
}

/** A monochrome calendar, drawn in `currentColor` so it reads like the other icon items. */
function CalendarGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.75" y="4.25" width="14.5" height="13" rx="2.5" />
      <path d="M2.75 8.5h14.5M6.75 2.5v3.5M13.25 2.5v3.5" />
      <path d="M6.5 12h2M9 12h2M11.5 12h2M6.5 14.75h2M9 14.75h2" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * The header's icon item (U1): a calendar beside the gear, named "schedule" — ", N unread"
 * appended while results wait — so the name carries the count a sighted person reads from
 * the badge. Renders nothing where the host does not allow scheduling.
 */
export function ScheduleNavItem(): ReactElement | null {
  const view = useScheduler();
  if (!allows('schedule')) return null;
  const unread = view.unseen;
  const name = unread > 0 ? `${PAGE.heading}, ${unread} unread` : PAGE.heading;
  return (
    <NavLink
      to="/schedule"
      aria-label={name}
      title={name}
      className={({ isActive }) => `nav-link nav-link-icon schedule-nav${isActive ? ' active' : ''}`}
      data-testid="schedule-nav"
    >
      <CalendarGlyph />
      {unread > 0 ? (
        <span className="schedule-nav-badge" aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </NavLink>
  );
}

export function ScheduleView(): ReactElement {
  if (!allows('schedule')) return <ScheduleUnavailable />;
  return <SchedulePage />;
}

function Group({ id, title, items, view, apps, now }: { id: keyof typeof GROUPS; title: string; items: ScheduledTask[]; view: SchedulerView; apps: AppIndex; now: Date }): ReactElement | null {
  if (items.length === 0) return null;
  const headingId = `schedule-group-${id}-heading`;
  return (
    <section className="schedule-group" aria-labelledby={headingId} data-testid={`schedule-group-${id}`}>
      <h2 className="section-title" id={headingId}>
        {title}
      </h2>
      <ul className="schedule-list">
        {items.map((item) => (
          <ScheduleRow
            key={item.id}
            item={item}
            runs={view.runsByTask[item.id]}
            apps={apps}
            now={now}
            attention={id === 'attention' ? attentionOf(item, view.runsByTask[item.id]) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

function SchedulePage(): ReactElement {
  const view = useScheduler();
  const now = useNow();
  const apps = useAppIndex(view.ready);
  const honesty = view.honesty ?? hostHonesty(view.leader);
  const results = resultRows(view.tasks, view.runsByTask);
  const grouped = groupTasks(view.tasks, view.runsByTask, now);
  const empty = view.tasks.length === 0 && results.length === 0;

  return (
    <div className="schedule-page" data-testid="schedule-page">
      <div className="settings-hero">
        <h1 className="schedule-heading" tabIndex={-1}>
          {PAGE.heading}
        </h1>
        <p className="settings-hero-sub" data-testid="schedule-honesty">
          {honesty}
        </p>
      </div>
      {view.leader?.leader === false ? (
        <p className="schedule-hint" role="status" data-testid="schedule-follower">
          {followerTab}
        </p>
      ) : null}
      {view.state?.globalPause === true ? (
        <div className="connection-note schedule-paused-banner" role="status" data-testid="schedule-global-paused">
          <p className="connection-note-title">{globalPaused}</p>
          <div className="connection-note-actions">
            <Button variant="primary" onClick={() => void setGlobalPause(false)} data-testid="schedule-resume-all">
              {PAGE.resumeAll}
            </Button>
          </div>
        </div>
      ) : null}
      <ScheduleCreateBar />
      <MissedCard />
      {!view.ready ? (
        view.lastError !== undefined ? (
          <EmptyState glyph="◌" title={PAGE.errorTitle} lesson={view.lastError} />
        ) : (
          <div className="schedule-loading" data-testid="schedule-loading" aria-busy="true">
            <Skeleton height="56px" style={{ borderRadius: 'var(--radius-m)' }} />
            <Skeleton height="56px" style={{ borderRadius: 'var(--radius-m)' }} />
            <Skeleton height="56px" style={{ borderRadius: 'var(--radius-m)' }} />
          </div>
        )
      ) : (
        <>
          {view.lastError !== undefined ? (
            <div className="error-note" role="alert" data-testid="schedule-error">
              {view.lastError}
            </div>
          ) : null}
          {empty ? (
            <EmptyState glyph="◷" title={PAGE.emptyTitle} lesson={EMPTY.page} />
          ) : (
            <>
              <ResultsList rows={results} apps={apps} now={now} />
              <Group id="attention" title={GROUPS.attention} items={grouped.attention} view={view} apps={apps} now={now} />
              <Group id="today" title={GROUPS.today} items={grouped.today} view={view} apps={apps} now={now} />
              <Group id="upcoming" title={GROUPS.upcoming} items={grouped.upcoming} view={view} apps={apps} now={now} />
              <Group id="paused" title={GROUPS.paused} items={grouped.paused} view={view} apps={apps} now={now} />
            </>
          )}
        </>
      )}
      <Templates installedBySource={apps.bySource} />
    </div>
  );
}
