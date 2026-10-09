// schedule/MissedCard.tsx — the catch-up card (TASK-20261009-scheduling-framework U4; design
// F5; ADR-0074 §5). It READS the persisted `pending` rows — the planner wrote one candidate per
// schedule, collapsed, so a closed tab loses nothing and the card is the same on the hub
// (below the create bar, after `ProtectionOffer`, which wins when both want the slot) and at
// the top of `/schedule`.
//
// One line: "3 schedules were missed while Snug was closed · 2 AI calls" · run them · skip ·
// details. Details are per-schedule rows — the plain-words when, "missed 4 times → runs once",
// the cost, run now / skip. *Run them* queues every candidate and the card shows "running 2
// of 4…" with cancel, then each row's done/failed until *ok* lets the card leave.
//
// UNDO. A skip is permanent once written (the row is `skipped`, reason `user`, and nothing
// re-creates a candidate), so *skip* (all) does not write at once: it arms a short delay
// (`SKIP_UNDO_MS`) with an *undo* that cancels it, and the write lands when the delay runs
// out — or at once if the card unmounts first (the user's decision is kept, not lost). A
// per-row skip in the details is immediate, like the engine's act.
//
// When the card leaves (nothing pending, no batch to report) focus moves to the page's
// heading, so a keyboard user is not dropped where a region used to be. `role="status"`,
// `aria-live="polite"`: the headline is announced, never barged in.

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { allows } from '../platform/platform.js';
import { Button } from '../ui/Button.js';
import { MISSED_ACTIONS, missedHeadline, missedRow, runningProgress } from './copy.js';
import { MISSED, aiCallsWord, statusWord } from './copy.page.js';
import { describeSpec } from './cron.js';
import { aiStepsOf, pendingAiCalls, pendingRows, runsNewestFirst } from './pageModel.js';
import { cancelRunning, runAllPending, runPending, skipAllPending, skipPending, useScheduler } from './scheduler.js';

/** How long *skip* waits before it writes, so *undo* has a moment. */
export const SKIP_UNDO_MS = 5000;

interface Batch {
  /** `taskId:dueAt` of every candidate *run them* queued, in order. */
  keys: string[];
  total: number;
}

export interface MissedCardProps {
  /** Where focus goes when the card leaves; the page's first heading by default. */
  focusTarget?: () => HTMLElement | null;
  /** The *skip* delay (a test seam; `SKIP_UNDO_MS` in the product). */
  undoMs?: number;
}

const defaultFocusTarget = (): HTMLElement | null => document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1');

export function MissedCard({ focusTarget = defaultFocusTarget, undoMs = SKIP_UNDO_MS }: MissedCardProps): ReactElement | null {
  const view = useScheduler();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [batch, setBatch] = useState<Batch | undefined>(undefined);
  const [skipArmed, setSkipArmed] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const rows = pendingRows(view.tasks, view.runsByTask);
  const working = view.running !== undefined || view.queued > 0;
  const batchAlive = batch !== undefined;
  const visible = allows('schedule') && view.ready && (rows.length > 0 || batchAlive);

  // Focus to the heading when the card LEAVES (visible → not), never on unmount.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (wasVisible.current && !visible) {
      const target = focusTarget();
      if (target !== null) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus();
      }
    }
    wasVisible.current = visible;
  }, [visible, focusTarget]);

  // A batch is done when nothing runs and nothing waits; the outcomes stay until *ok*.
  const batchDone = batchAlive && !working;

  // An armed skip-all writes when its delay runs out — or when the card unmounts first.
  useEffect(() => {
    return () => {
      if (skipTimer.current !== undefined) {
        clearTimeout(skipTimer.current);
        skipTimer.current = undefined;
        void skipAllPending();
      }
    };
  }, []);

  if (!visible) return null;

  const armSkipAll = (): void => {
    setError(undefined);
    setSkipArmed(rows.length);
    skipTimer.current = setTimeout(() => {
      skipTimer.current = undefined;
      setSkipArmed(undefined);
      void skipAllPending();
    }, undoMs);
  };
  const undoSkipAll = (): void => {
    if (skipTimer.current !== undefined) clearTimeout(skipTimer.current);
    skipTimer.current = undefined;
    setSkipArmed(undefined);
  };
  const runThem = async (): Promise<void> => {
    setError(undefined);
    const keys = rows.map((row) => `${row.run.taskId}:${row.run.dueAt}`);
    const queued = await runAllPending();
    if (queued === 0) {
      setError('nothing could be queued — all schedules are paused');
      return;
    }
    setBatch({ keys, total: queued });
  };
  const act = async (result: Promise<{ ok: true } | { ok: false; reason: string }>): Promise<void> => {
    setError(undefined);
    const answer = await result;
    if (!answer.ok) setError(answer.reason);
  };

  const outcomeOf = (key: string): string => {
    const [taskId, dueAt] = key.split(/:(.+)/) as [string, string];
    const run = runsNewestFirst(view.runsByTask[taskId]).find((entry) => entry.dueAt === dueAt || Date.parse(entry.dueAt) === Date.parse(dueAt));
    if (run === undefined) return statusWord('skipped');
    if (run.status === 'ok') return MISSED.done;
    return statusWord(run.status);
  };
  const titleOf = (key: string): string => view.tasks.find((item) => item.id === key.split(':')[0])?.title ?? '';

  const progress = batchAlive && working ? runningProgress(Math.max(1, Math.min(batch.total, batch.total - view.queued)), batch.total) : undefined;

  return (
    <div className="connection-note missed-card" role="status" aria-live="polite" data-testid="missed-card" data-pending={rows.length}>
      {progress !== undefined ? (
        <div className="missed-progress" data-testid="missed-progress">
          <span className="connection-note-title">{progress}</span>
          <div className="connection-note-actions">
            <Button variant="ghost" onClick={() => cancelRunning()} data-testid="missed-cancel">
              {MISSED_ACTIONS.cancel}
            </Button>
          </div>
        </div>
      ) : batchDone ? (
        <div className="missed-outcomes" data-testid="missed-outcomes">
          <ul className="missed-rows">
            {batch.keys.map((key) => (
              <li key={key} className="missed-row" data-testid="missed-outcome">
                <span className="missed-row-title">{titleOf(key)}</span>
                <span className="missed-row-outcome">{outcomeOf(key)}</span>
              </li>
            ))}
          </ul>
          <div className="connection-note-actions">
            <Button variant="primary" onClick={() => setBatch(undefined)} data-testid="missed-ok">
              {MISSED.ok}
            </Button>
          </div>
        </div>
      ) : skipArmed !== undefined ? (
        <div className="missed-undo" data-testid="missed-undo">
          <span className="connection-note-title">{MISSED.skippingSoon(skipArmed)}</span>
          <div className="connection-note-actions">
            <Button variant="primary" onClick={undoSkipAll} data-testid="missed-undo-act">
              {MISSED_ACTIONS.undo}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="connection-note-title" data-testid="missed-headline">
            {missedHeadline(rows.length, pendingAiCalls(rows))}
          </p>
          <div className="connection-note-actions">
            <Button variant="primary" onClick={() => void runThem()} data-testid="missed-run-all">
              {MISSED_ACTIONS.runAll}
            </Button>
            <Button onClick={armSkipAll} data-testid="missed-skip-all">
              {MISSED_ACTIONS.skipAll}
            </Button>
            <Button variant="ghost" aria-expanded={detailsOpen} aria-controls="missed-details" onClick={() => setDetailsOpen((open) => !open)} data-testid="missed-details">
              {MISSED_ACTIONS.details}
            </Button>
          </div>
          {detailsOpen ? (
            <ul className="missed-rows" id="missed-details" data-testid="missed-detail-rows">
              {rows.map(({ run, item }) => (
                <li key={`${run.taskId}:${run.dueAt}`} className="missed-row" data-testid="missed-row">
                  <span className="missed-row-title">{item.title}</span>
                  <span className="missed-row-when">{missedRow(describeSpec(item.spec), run.collapsedCount)}</span>
                  <span className="missed-row-cost">{aiCallsWord(aiStepsOf(item.steps))}</span>
                  <span className="missed-row-acts">
                    <Button variant="ghost" onClick={() => void act(runPending(run.taskId, run.dueAt))} data-testid="missed-row-run">
                      {MISSED_ACTIONS.run}
                    </Button>
                    <Button variant="ghost" onClick={() => void act(skipPending(run.taskId, run.dueAt))} data-testid="missed-row-skip">
                      {MISSED_ACTIONS.skip}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {error !== undefined ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
