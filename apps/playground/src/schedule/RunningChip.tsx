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

import type { ReactElement } from 'react';

import { useStore } from '../state/store.js';
import { RUNNING_CHIP, WORDS } from './copy.js';
import { cancelName } from './copy.page.js';
import { delegatedRunStore } from './runPlacement.js';
import { cancelRunning, useScheduler } from './scheduler.js';

export function RunningChip(): ReactElement | null {
  const view = useScheduler();
  const delegated = useStore(delegatedRunStore);
  const running = view.running;
  if (running === undefined) return null;
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
