// schedule/ScheduleChanges.tsx — THE SCHEDULE'S CHANGES LIST (TASK-20261010-host-broker PR-4,
// D-PR4-18, D-PR4-3; design D2): at the top of a schedule's history, every change it made on its
// own that can still be undone, each with its undo — *changed 12 rows in Ledger · 3 hours ago ·
// undo*.
//
// READ FROM THE JOURNAL, NEVER FROM THE RUNS. A schedule's own changes live in its own undo bucket
// (`ownUndo:<appId>:<taskId>`, `listOwnUndo(appId, { taskId })` — live entries only) for seven
// days, while its results are pruned at fifty and *clear history* drops what is dealt with: so an
// undo stays findable for its whole seven days whatever became of the result that reported it,
// and a schedule stopped from making changes still lists the ones it made. The bucket is read
// under every app the file holds (the delete sweep's rule): an armed schedule names one app, but
// an edit may have moved it since. The user's own approvals are the approval bucket's and never
// listed here.
//
// An entry undone HERE stays on the list with its outcome line (the line took the focus — it must
// not vanish under it); one undone elsewhere, or past its seven days, leaves at the next read.
// The list is the history's FIRST ENTRY (an `<li>` holding its own list, inside the row's history
// `<ul>`); nothing live: nothing rendered — the history reads exactly as before.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import type { OwnUndoEntry } from '@snugprotocol/protocol';

import { OwnUndoAct } from '../access/OwnUndoAct.js';
import type { UndoOutcome } from '../access/writeBroker.js';
import { useLibraryRevision, useScheduleRevision } from '../platform/signals.js';
import { getUserDb } from '../state/userdb.js';
import { CHANGES_LIST } from './copy.page.js';
import { relativeTime } from './pageModel.js';

/** One live change of the schedule's, with the app whose rows it changed. */
export interface ScheduleChange {
  appId: string;
  appName: string;
  entry: OwnUndoEntry;
}

/** The rows an entry captured — what it changed, and what its undo would put back. */
export function rowsOf(entry: Pick<OwnUndoEntry, 'steps'>): number {
  return entry.steps.reduce((sum, step) => sum + step.rows.length, 0);
}

/** The schedule's live changes across the file's apps, newest first. Never throws: a journal that cannot be read lists nothing. */
export async function readScheduleChanges(taskId: string): Promise<ScheduleChange[]> {
  try {
    const db = await getUserDb();
    const changes = db.listApps().flatMap((app) => db.listOwnUndo(app.appId, { taskId }).map((entry) => ({ appId: app.appId, appName: app.displayName, entry })));
    return changes.sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at));
  } catch {
    return [];
  }
}

/** The user's undo of one of the schedule's own changes — through its own bucket, as the user's act. */
async function undoChange(taskId: string, change: ScheduleChange): Promise<UndoOutcome> {
  const [db, { undoOwnWrite }] = await Promise.all([getUserDb(), import('../access/writeBroker.js')]);
  return undoOwnWrite(db, change.appId, taskId, change.entry.id, { via: 'user' });
}

export interface ScheduleChangesProps {
  taskId: string;
  now: Date;
}

export function ScheduleChanges({ taskId, now }: ScheduleChangesProps): ReactElement | null {
  const scheduleRevision = useScheduleRevision();
  const libraryRevision = useLibraryRevision();
  const [changes, setChanges] = useState<readonly ScheduleChange[]>([]);
  /** The entries undone on this list — kept on it with their outcome line. */
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void readScheduleChanges(taskId).then((live) => {
      if (cancelled) return;
      setChanges((shown) => {
        const liveIds = new Set(live.map((change) => change.entry.id));
        const kept = shown.filter((change) => answeredHere.has(change.entry.id) && !liveIds.has(change.entry.id));
        return [...live, ...kept].sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, scheduleRevision, libraryRevision, answeredHere]);

  if (changes.length === 0) return null;
  return (
    <li className="schedule-history-changes">
      <ul className="schedule-changes" aria-label={CHANGES_LIST.heading} data-testid="schedule-changes">
        {changes.map((change) => {
          const rows = rowsOf(change.entry);
          return (
            <li key={change.entry.id} className="schedule-changes-entry field-row field-row-wrap" data-testid="schedule-changes-entry">
              <span>{CHANGES_LIST.entry(rows, change.appName)}</span>
              {' · '}
              <span className="schedule-changes-when">{relativeTime(new Date(change.entry.at), now)}</span>
              {' · '}
              <OwnUndoAct
                rows={rows}
                appName={change.appName}
                offered
                onUndo={async () => {
                  const outcome = await undoChange(taskId, change);
                  setAnsweredHere((ids) => new Set(ids).add(change.entry.id));
                  return outcome;
                }}
              />
            </li>
          );
        })}
      </ul>
    </li>
  );
}
