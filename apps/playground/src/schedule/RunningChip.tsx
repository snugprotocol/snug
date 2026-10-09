// schedule/RunningChip.tsx — the header whisper while a scheduled job is in flight
// (TASK-20261009-scheduling-framework U10; security F15; ADR-0074 §6).
//
// Renders NOTHING unless the engine's view says something is running; then the chip's label,
// the schedule's title and the one act — *cancel* — in the header's quiet-ember chip family
// (`.auth-repair-chip`, the update chip's precedent) on every route, so a run spending the
// user's brain while they look elsewhere is never invisible. `role="status"` with an accessible
// name that reads the whole sentence; the cancel control names what it cancels.

import type { ReactElement } from 'react';

import { RUNNING_CHIP, WORDS } from './copy.js';
import { cancelName } from './copy.page.js';
import { cancelRunning, useScheduler } from './scheduler.js';

export function RunningChip(): ReactElement | null {
  const view = useScheduler();
  const running = view.running;
  if (running === undefined) return null;
  const title = view.tasks.find((task) => task.id === running.taskId)?.title ?? WORDS.item;
  return (
    <span
      className="auth-repair-chip app-update-chip schedule-running-chip"
      role="status"
      aria-label={`${RUNNING_CHIP.label}: ${title}`}
      data-testid="schedule-running-chip"
    >
      <span className="schedule-running-pulse" aria-hidden="true" />
      <span className="schedule-running-label">{RUNNING_CHIP.label}</span>
      <span className="schedule-running-title" title={title}>
        {title}
      </span>
      <button type="button" className="schedule-running-cancel" aria-label={cancelName(title)} onClick={() => cancelRunning()}>
        {RUNNING_CHIP.cancel}
      </button>
    </span>
  );
}
