// schedule/ResultDetail.tsx — one result, opened (TASK-20261009-scheduling-framework U4, the
// detail half; ADR-0074 §5–§6). Route `/schedule/:id/result/:dueAt` (the siblings' route table
// renders this).
//
// WHAT IT SHOWS. The status word with its dot and one sentence; the schedule's title (a link
// to its editor); when it ran and on which host (every row records `host` — E9); what it
// spent; each step with its kind label, its app, its summary — PLAIN TEXT, never HTML: the
// summary is the AI's or the app's words, scrubbed before it was stored, and rendered as a
// text node here, nothing more — and its status; then the pending *changes waiting for your
// OK*, each statement VERBATIM in a `<pre>` with the dry-run count and the line "written by the
// AI from your data"; and for the states with one act, that act (`needs-you` → *run now and
// review*; `no-handler` → *open <app>*; `capped` has none).
//
// THE CHANGES (ADR-0074 §6). *apply to my data* builds a `PendingWriteProposal` — the step's
// app, `[sql]`, no params, the stored count as the drift baseline — and hands it to
// `executeApprovedWrite`, the ONE path from a proposed statement to real data; the re-dry-run
// and the drift check happen inside it. Applied: the item leaves the row (an applied change
// that still offers *apply* invites a second execution); drifted: the row's count becomes the
// current one and the item stays, with "the data moved — review again"; failed: the message,
// the item stays. *decline* removes the item from the row: there is no scheduler act for that —
// it is written straight through `db.putScheduleRun` (the upsert by `(taskId, dueAt)`) and the
// revision is bumped so every view re-reads. The batch has one expiry; past it nothing is
// offered. The app the statement applies to is the schedule's *ask the AI* step's app — PR-A's
// steps are independent and one *ask* step per schedule is the shape the editor builds; with
// several, the first one's app (a statement against the wrong app fails its dry run, which is
// reported, never applied).
//
// OPENING IS A GESTURE (E7): `markSeen(taskId, dueAt)` once per open — the only thing that
// ever stamps `seenAt`.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router';

import type { ScheduleProposalItem, ScheduleRun, ScheduledTask, StepResult } from '@snugprotocol/protocol';

import { sanitizeCardText } from '../agent/cards.js';
import { executeApprovedWrite, type PendingWriteProposal } from '../agent/dataTools.js';
import { bumpScheduleRevision, useLibraryRevision } from '../platform/signals.js';
import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';
import { WORDS, capped, needsYou, noHandler, stepLabel } from './copy.js';
import {
  AI_WROTE,
  CAPPED_WHAT,
  CHANGE_ACTIONS,
  DECLINED,
  DRIFTED,
  EXPIRED,
  NEEDS_YOU_FALLBACK_VERB,
  NO_APP_FOR_CHANGES,
  RESULT_LOADING,
  RESULT_MISSING,
  STEPS_HEADING,
  absoluteTime,
  applied,
  callsLine,
  couldNotApply,
  dueLine,
  interruptedWhy,
  onHost,
  openApp,
  ranLine,
  relativeTime,
  wouldChange,
} from './copy.bits.js';
import { ResultStatus, StepStatus, appNameOf, type AppName } from './ScheduleStates.js';
import { markSeen, runNow, useScheduler } from './scheduler.js';

const sameOccurrence = (row: ScheduleRun, dueAt: string): boolean => row.dueAt === dueAt || Date.parse(row.dueAt) === Date.parse(dueAt);

/** The app a pending change applies to — see the header. */
export function changesAppId(task: Pick<ScheduledTask, 'steps'>): string | undefined {
  const think = task.steps.find((step) => step.kind === 'app-think');
  return think !== undefined && think.kind === 'app-think' ? think.appId : undefined;
}

/** The step whose refusal or block made the result `needs-you`, for the sentence's app name. */
function needsYouStep(task: ScheduledTask, run: ScheduleRun): number {
  const at = run.steps.findIndex((step) => step.status === 'refused' || step.status === 'blocked');
  return at === -1 ? task.steps.findIndex((step) => step.kind !== 'notify') : at;
}

function appOfStep(task: ScheduledTask, index: number): string | undefined {
  const step = task.steps[index];
  return step === undefined || step.kind === 'notify' ? undefined : step.appId;
}

/** The pending change's shape for the one write path (`agent/dataTools.ts`). */
export function proposalFor(appId: string, item: ScheduleProposalItem): PendingWriteProposal {
  return {
    appId,
    statements: [item.sql],
    params: [[]],
    summary: item.summary ?? '',
    previewed: [item.counts?.changes ?? 0],
  };
}

type Settled = { sql: string; summary: string | undefined; line: string };

export function ResultDetail(): ReactElement {
  const params = useParams<{ id: string; dueAt: string }>();
  const taskId = params.id ?? '';
  const dueAt = params.dueAt ?? '';
  const view = useScheduler();
  const libraryRevision = useLibraryRevision();

  const task = view.tasks.find((entry) => entry.id === taskId);
  const run = (view.runsByTask[taskId] ?? []).find((row) => sameOccurrence(row, dueAt));

  const [apps, setApps] = useState<readonly AppName[]>([]);
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [settled, setSettled] = useState<readonly Settled[]>([]);
  const [busySql, setBusySql] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [runNowNote, setRunNowNote] = useState<string | undefined>(undefined);

  // The app names, read once per library revision — the one db read of this view.
  useEffect(() => {
    let cancelled = false;
    void getUserDb()
      .then((db) => {
        if (!cancelled) setApps(db.listApps().map(({ appId, displayName }) => ({ appId, displayName })));
      })
      .catch(() => {
        // Names are garnish on a result that renders without them ("this app").
      });
    return () => {
      cancelled = true;
    };
  }, [libraryRevision]);

  // Opening the detail is the gesture that stamps `seenAt` — once per (schedule, occurrence).
  const seenFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (taskId === '' || dueAt === '') return;
    const key = `${taskId}@${dueAt}`;
    if (seenFor.current === key) return;
    seenFor.current = key;
    void markSeen(taskId, dueAt);
  }, [taskId, dueAt]);

  if (!view.ready && (task === undefined || run === undefined)) {
    return (
      <div className="schedule-result" aria-busy="true" aria-label={RESULT_LOADING}>
        <Skeleton height="48px" />
        <Skeleton height="160px" />
      </div>
    );
  }

  if (task === undefined || run === undefined) {
    return (
      <EmptyState
        glyph="🗓"
        title={RESULT_MISSING.title}
        lesson={RESULT_MISSING.lesson}
        action={
          <Link to="/schedule" className="btn">
            {RESULT_MISSING.back}
          </Link>
        }
      />
    );
  }

  const nowMs = Date.now();
  const ranAt = run.finishedAt ?? run.startedAt;
  const whenLine =
    ranAt !== undefined
      ? ranLine(absoluteTime(Date.parse(ranAt)), relativeTime(Date.parse(ranAt), nowMs))
      : dueLine(absoluteTime(Date.parse(run.dueAt)), relativeTime(Date.parse(run.dueAt), nowMs));

  const changeApp = changesAppId(task);
  const changeAppName = changeApp === undefined ? undefined : appNameOf(changeApp, apps);
  const proposals = run.proposals;
  const expired = proposals !== undefined && Date.parse(proposals.expiresAt) <= nowMs;

  /** Rewrite the row with the given items (none → no batch at all) and tell every view. */
  const writeItems = async (items: readonly ScheduleProposalItem[]): Promise<void> => {
    const db = await getUserDb();
    const current = db.listScheduleRuns(taskId).find((row) => sameOccurrence(row, dueAt));
    if (current === undefined) throw new Error('this result is gone');
    const { proposals: _batch, ...rest } = current;
    db.putScheduleRun(
      items.length === 0 || current.proposals === undefined ? rest : { ...rest, proposals: { items: [...items], expiresAt: current.proposals.expiresAt } },
    );
    bumpScheduleRevision();
  };

  const without = (sql: string): ScheduleProposalItem[] => (proposals?.items ?? []).filter((item) => item.sql !== sql);

  const approve = async (item: ScheduleProposalItem): Promise<void> => {
    if (changeApp === undefined || busySql !== undefined) return;
    setBusySql(item.sql);
    setError(undefined);
    try {
      const db = await getUserDb();
      const outcome = await executeApprovedWrite(db, proposalFor(changeApp, item));
      if (outcome.ok) {
        await writeItems(without(item.sql));
        setSettled((list) => [...list, { sql: item.sql, summary: item.summary, line: applied(outcome.executed) }]);
      } else if (outcome.reason === 'drifted') {
        const current = outcome.current[0] ?? 0;
        await writeItems((proposals?.items ?? []).map((entry) => (entry.sql === item.sql ? { ...entry, counts: { changes: current } } : entry)));
        setNotes((map) => ({ ...map, [item.sql]: DRIFTED }));
      } else {
        setNotes((map) => ({ ...map, [item.sql]: couldNotApply(outcome.message) }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySql(undefined);
    }
  };

  const decline = async (item: ScheduleProposalItem): Promise<void> => {
    if (busySql !== undefined) return;
    setBusySql(item.sql);
    setError(undefined);
    try {
      await writeItems(without(item.sql));
      setSettled((list) => [...list, { sql: item.sql, summary: item.summary, line: DECLINED }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySql(undefined);
    }
  };

  const runNowAndReview = async (): Promise<void> => {
    setRunNowNote(undefined);
    const result = await runNow(taskId);
    if (!result.ok) setRunNowNote(result.reason);
  };

  const needsYouApp = appOfStep(task, needsYouStep(task, run));
  const needsYouCopy = needsYou(needsYouApp === undefined ? task.title : (appNameOf(needsYouApp, apps) ?? 'this app'), NEEDS_YOU_FALLBACK_VERB);
  const noHandlerAt = run.steps.findIndex((step) => step.status === 'no-handler');
  const noHandlerApp = appOfStep(task, noHandlerAt === -1 ? task.steps.findIndex((step) => step.kind !== 'notify') : noHandlerAt);
  const noHandlerCopy = noHandler(noHandlerApp === undefined ? task.title : (appNameOf(noHandlerApp, apps) ?? 'this app'));

  return (
    <div className="schedule-result" data-testid="schedule-result-detail">
      <header className="schedule-result-head">
        <ResultStatus status={run.status} />
        <h1 className="schedule-result-title">
          <Link to={`/schedule/${encodeURIComponent(taskId)}`} data-testid="schedule-result-title">
            {task.title}
          </Link>
        </h1>
        <p className="hint" data-testid="schedule-result-when">
          {whenLine} · {onHost(run.host)} · {callsLine(run.calls)}
        </p>
      </header>

      {run.status === 'needs-you' ? (
        <StateCard
          text={needsYouCopy.text}
          detail={run.reason}
          testId="schedule-result-needs-you"
          action={
            <Button variant="primary" onClick={() => void runNowAndReview()}>
              {needsYouCopy.action}
            </Button>
          }
          note={runNowNote}
        />
      ) : run.status === 'no-handler' ? (
        <StateCard
          text={noHandlerCopy.text}
          testId="schedule-result-no-handler"
          action={
            noHandlerApp !== undefined ? (
              <Link to={`/run/${encodeURIComponent(noHandlerApp)}`} className="btn btn-primary">
                {noHandlerCopy.action}
              </Link>
            ) : undefined
          }
        />
      ) : run.status === 'capped' ? (
        <StateCard text={capped(CAPPED_WHAT)} testId="schedule-result-capped" />
      ) : run.status === 'interrupted' ? (
        <StateCard text={interruptedWhy(run.reason)} testId="schedule-result-interrupted" />
      ) : run.status === 'failed' && run.reason !== undefined ? (
        <StateCard text={sanitizeCardText(run.reason)} testId="schedule-result-failed" />
      ) : null}

      {run.steps.length > 0 ? (
        <section className="schedule-result-steps" aria-labelledby="schedule-result-steps-heading">
          <h2 id="schedule-result-steps-heading" className="settings-section-label">
            {STEPS_HEADING}
          </h2>
          <ol className="schedule-result-step-list">
            {run.steps.map((result, index) => (
              <StepRow key={`${run.id}-step-${index}`} task={task} index={index} result={result} apps={apps} />
            ))}
          </ol>
        </section>
      ) : null}

      {proposals !== undefined || settled.length > 0 ? (
        <section className="schedule-result-changes" aria-labelledby="schedule-result-changes-heading" data-testid="schedule-result-changes">
          <h2 id="schedule-result-changes-heading" className="settings-section-label">
            {WORDS.changesWaiting}
          </h2>
          {expired ? (
            <p className="hint" role="status" data-testid="schedule-changes-expired">
              {EXPIRED}
            </p>
          ) : changeApp === undefined && (proposals?.items.length ?? 0) > 0 ? (
            <p className="hint" role="status">
              {NO_APP_FOR_CHANGES}
            </p>
          ) : null}
          {!expired
            ? (proposals?.items ?? []).map((item) => (
                <Card key={item.sql} className="schedule-change" data-testid="schedule-change">
                  {item.summary !== undefined && item.summary !== '' ? <span className="artifact-name">{sanitizeCardText(item.summary)}</span> : null}
                  <pre className="schedule-result-sql">{item.sql}</pre>
                  <span className="hint">
                    {wouldChange(item.counts?.changes)}
                    {changeAppName !== undefined ? ` in ${changeAppName}` : ''} · {AI_WROTE}
                  </span>
                  {notes[item.sql] !== undefined ? (
                    <span className="hint" role="status" data-testid="schedule-change-note">
                      {notes[item.sql]}
                    </span>
                  ) : null}
                  <div className="schedule-change-actions">
                    {changeApp !== undefined ? (
                      <Button variant="primary" onClick={() => void approve(item)} disabled={busySql !== undefined}>
                        {CHANGE_ACTIONS.apply}
                      </Button>
                    ) : null}
                    <Button onClick={() => void decline(item)} disabled={busySql !== undefined}>
                      {CHANGE_ACTIONS.decline}
                    </Button>
                  </div>
                </Card>
              ))
            : null}
          {settled.map((entry) => (
            <Card key={`settled-${entry.sql}`} className="schedule-change is-settled" data-testid="schedule-change-settled">
              {entry.summary !== undefined && entry.summary !== '' ? <span className="artifact-name">{sanitizeCardText(entry.summary)}</span> : null}
              <pre className="schedule-result-sql">{entry.sql}</pre>
              <span className="hint" role="status">
                {entry.line}
              </span>
            </Card>
          ))}
          {error !== undefined ? (
            <div className="error-note" role="alert">
              {error}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function StepRow({ task, index, result, apps }: { task: ScheduledTask; index: number; result: StepResult; apps: readonly AppName[] }): ReactElement {
  const step = task.steps[index];
  const appId = step === undefined || step.kind === 'notify' ? undefined : step.appId;
  const appName = appId === undefined ? undefined : appNameOf(appId, apps);
  const label = step === undefined ? stepLabel('app-run') : stepLabel(step.kind, appName);
  return (
    <li className="schedule-result-step" data-testid="schedule-result-step">
      <div className="schedule-result-step-head">
        <span className="schedule-result-step-label">{label}</span>
        {appId !== undefined ? (
          <Link to={`/run/${encodeURIComponent(appId)}`} className="schedule-result-step-app">
            {openApp(appName ?? 'this app')}
          </Link>
        ) : null}
        <StepStatus status={result.status} />
      </div>
      {result.summary !== undefined && result.summary !== '' ? <p className="schedule-result-step-summary">{sanitizeCardText(result.summary)}</p> : null}
      {result.appMissing === true ? <span className="hint">{stepLabel(step?.kind ?? 'app-run')} — this app was deleted</span> : null}
    </li>
  );
}

function StateCard({ text, detail, action, note, testId }: { text: string; detail?: string | undefined; action?: ReactElement | undefined; note?: string | undefined; testId: string }): ReactElement {
  return (
    <div className="connection-note" role="status" data-testid={testId}>
      <p className="connection-note-title">{text}</p>
      {detail !== undefined ? <p className="connection-note-body">{sanitizeCardText(detail)}</p> : null}
      {action !== undefined ? <div className="connection-note-actions">{action}</div> : null}
      {note !== undefined ? (
        <p className="connection-note-body" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
