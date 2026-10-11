// schedule/RunningChip.tsx — the header whisper while a scheduled job is in flight
// (TASK-20261009-scheduling-framework U10; security F15; ADR-0074 §6).
//
// Renders NOTHING unless the engine's view says something is running; then the chip's label,
// the schedule's title and the one act — *cancel* — in the header's quiet-ember chip family
// (`.auth-repair-chip`, the update chip's precedent) on every route, so a run spending the
// user's brain while they look elsewhere is never invisible. `role="status"` with an accessible
// name that reads the whole sentence; the cancel control names what it cancels.
//
// WHERE IT RUNS (TASK-20261010-host-broker PR-1; ADR-0077 §2). A run of an OPEN app is delegated
// to that app's own frame; the placement store (`runPlacement.ts`) holds the run in flight, and
// when it is the running schedule's, the label reads *running in <app>* and the accessible name
// says the whole sentence. Nothing on a persisted row says where a run executed (D-PR1-1) — this
// chip is the one place the user sees it, while it is true.
//
// A FETCH ANOTHER APP ASKED FOR (TASK-20261010-host-broker PR-3; ADR-0076 §6; D-PR3-19, DS8, F13).
// A refresh runs the SOURCE's own code on its open frame as a delegated run with
// `posture: 'refresh'` — no schedule is running, so the scheduler's view says nothing, and the
// chip renders from the placement store instead: the label `RUNNING_CHIP.fetching(<source>)`, the
// record's own title (`REFRESH_RUN.title(<asker>)` — "Budget asked") and the accessible name
// "<source> is fetching new data — <asker> asked" (E2-Q13). NO act in PR-3: the run is bounded by
// the result timeout, and *cancel* is a rider. When the scheduler has something running, today's
// chip wins; a delegated run with the default posture and nothing running stays invisible.

import type { ReactElement } from 'react';

import { useStore } from '../state/store.js';
import { RUNNING_CHIP, WORDS } from './copy.js';
import { cancelName } from './copy.page.js';
import { delegatedRunStore, type DelegatedRun } from './runPlacement.js';
import { cancelRunning, useScheduler } from './scheduler.js';

/** The chip for a refresh in flight: the source's name, who asked, no act (D-PR3-19). */
function FetchingChip({ run }: { run: DelegatedRun }): ReactElement {
  return (
    <span
      className="auth-repair-chip app-update-chip schedule-running-chip schedule-running-chip--fetching"
      role="status"
      aria-label={`${run.appName} is fetching new data — ${run.title}`}
      data-testid="schedule-running-chip"
    >
      <span className="schedule-running-pulse" aria-hidden="true" />
      <span className="schedule-running-label">{RUNNING_CHIP.fetching(run.appName)}</span>
      <span className="schedule-running-title" title={run.title}>
        {run.title}
      </span>
    </span>
  );
}

export function RunningChip(): ReactElement | null {
  const view = useScheduler();
  const delegated = useStore(delegatedRunStore);
  const running = view.running;
  if (running === undefined) {
    const fetching = [...delegated.values()].find((run) => run.posture === 'refresh');
    return fetching === undefined ? null : <FetchingChip run={fetching} />;
  }
  const title = view.tasks.find((task) => task.id === running.taskId)?.title ?? WORDS.item;
  const inApp = [...delegated.values()].find((run) => run.taskId === running.taskId);
  const label = inApp === undefined ? RUNNING_CHIP.label : RUNNING_CHIP.inApp(inApp.appName);
  const name = inApp === undefined ? `${RUNNING_CHIP.label}: ${title}` : `${title} is running in ${inApp.appName}`;
  return (
    <span
      className={`auth-repair-chip app-update-chip schedule-running-chip${inApp === undefined ? '' : ' schedule-running-chip--in-app'}`}
      role="status"
      aria-label={name}
      data-testid="schedule-running-chip"
    >
      <span className="schedule-running-pulse" aria-hidden="true" />
      <span className="schedule-running-label">{label}</span>
      <span className="schedule-running-title" title={title}>
        {title}
      </span>
      <button type="button" className="schedule-running-cancel" aria-label={cancelName(title)} onClick={() => cancelRunning()}>
        {RUNNING_CHIP.cancel}
      </button>
    </span>
  );
}
