// run/UpdatePausesNote.tsx — the line on an update confirm that names the schedules the update
// will pause (TASK-20261009 E8, ADR-0074 §6). One component for both confirms — the agent's
// hand-in for an edited copy and a shared bundle from the shelf — reading the engine's view
// of the file, so the sentence is true at the moment the user decides. Nothing when no
// schedule names the app.

import type { ReactElement } from 'react';

import { schedulesNamingApp, updatePausesSentence } from '../schedule/appDrift.js';
import { useScheduler } from '../schedule/scheduler.js';

export function UpdatePausesNote({ appId }: { appId: string }): ReactElement | null {
  const { tasks } = useScheduler();
  const sentence = updatePausesSentence(schedulesNamingApp(tasks, appId).map((task) => task.title));
  if (sentence === undefined) return null;
  return (
    <p className="net-confirm-body" data-testid="update-pauses-note">
      {sentence}
    </p>
  );
}
