// run/UpdatePausesNote.tsx — the line on an update confirm that names what the update will pause
// (TASK-20261009 E8, ADR-0074 §6; TASK-20261010-cross-app-access AC21, ADR-0075 §9). One
// component for both confirms — the agent's hand-in for an edited copy and a shared bundle from
// the shelf — reading the engines' view of the file, so the sentence is true at the moment the
// user decides:
//
//   - the SCHEDULES that run this app (`updatePausesSentence`), then
//   - the ACCESS this app holds to other apps' data (`updatePausesAccess` from access/copy.ts):
//     every live access it reads through — active and not expired, persisted or for the session
//     — exactly the set `suspendAccessForAppVersion` will pause, named by the other apps.
//
// The access half is said only for an update E8's rule pauses access for (`readerUpdateSuspends`
// — a shared or an agent update; both confirms that mount this note are one of those, so the
// default is `shared`). Nothing renders when neither half has anything to name.

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { readerUpdateSuspends, type ReaderVersionSource } from '../access/appDrift.js';
import { updatePausesAccess } from '../access/copy.js';
import { accessDeps, grantsForApp, useAccessRevision } from '../access/grants.js';
import { schedulesNamingApp, updatePausesSentence } from '../schedule/appDrift.js';
import { useScheduler } from '../schedule/scheduler.js';

/** The access sentence for `appId` as a reader, re-read on every access revision — `undefined` when nothing live would pause. */
function useAccessPausing(appId: string, enabled: boolean): string | undefined {
  const revision = useAccessRevision();
  const [sentence, setSentence] = useState<string | undefined>(undefined);
  // Written only on a change — the common answer is "nothing to name".
  const current = useRef<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const settle = (next: string | undefined): void => {
      if (cancelled || current.current === next) return;
      current.current = next;
      setSentence(next);
    };
    if (!enabled) {
      settle(undefined);
      return undefined;
    }
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const live = grantsForApp(db, appId, accessDeps().now()).reads.filter((row) => row.grant.status === 'active' && !row.expired);
        const sources = [...new Set(live.map((row) => row.sourceName).filter((name) => name !== ''))].sort((a, b) => a.localeCompare(b));
        if (sources.length === 0) {
          settle(undefined);
          return;
        }
        settle(updatePausesAccess(db.getApp(appId)?.displayName ?? live[0]!.readerName, sources));
      })
      .catch(() => settle(undefined));
    return () => {
      cancelled = true;
    };
  }, [appId, enabled, revision]);
  return sentence;
}

export function UpdatePausesNote({ appId, source = 'shared' }: { appId: string; source?: ReaderVersionSource }): ReactElement | null {
  const { tasks } = useScheduler();
  const schedules = updatePausesSentence(schedulesNamingApp(tasks, appId).map((task) => task.title));
  const access = useAccessPausing(appId, readerUpdateSuspends(source));
  if (schedules === undefined && access === undefined) return null;
  return (
    <p className="net-confirm-body" data-testid="update-pauses-note">
      {schedules}
      {schedules !== undefined && access !== undefined ? ' ' : null}
      {access !== undefined ? <span data-testid="update-pauses-access">{access}</span> : null}
    </p>
  );
}
