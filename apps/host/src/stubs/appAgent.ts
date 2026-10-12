// The kit's `schedule/appAgent.ts` (TASK-20261010-host-broker PR-4, D-PR4-15): the scheduled
// *Ask <App>'s AI* that can look things up — one agent turn over the data tools, the fetch tool and
// the gated adapter. The kit runs the scheduler, but the executors' brain gates send every kit brain
// away before this module is reached: the DEMO brain is refused by name (`blockedBy: 'brain'`), and
// the HOST brain — composed `tools: false` — opens no data lane (`chatDoorOpen` is false for it), so a
// step that may look things up degrades to the tool-free step. The executors reach the real module
// through a lazy import, which `apps/host/vite.config.ts` resolves here; reaching it is a wiring
// defect, never a feature gap, so it names the call. `kitDeadLanes.test.ts` pins the swap, the
// invariant and this surface; the playground and the desktop keep the real module.

import type { AppThinkStep } from '@playground/schedule/appThink.js';
import type { StepContext, StepOutcome } from '@playground/schedule/engine-types.js';

import { noDataLane } from './noDataLane.js';

export function executeAppAgent(_step: AppThinkStep, _ctx: StepContext): Promise<StepOutcome> {
  return Promise.reject(noDataLane('appAgent.executeAppAgent'));
}
