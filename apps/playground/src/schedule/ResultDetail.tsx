// schedule/ResultDetail.tsx — one result, opened (TASK-20261009-scheduling-framework U4, the
// detail half; ADR-0074 §5–§6). Route `/schedule/:id/result/:dueAt` (the siblings' route table
// renders this).
//
// WHAT IT SHOWS. The status word with its dot and one sentence; the schedule's title (a link
// to its editor); when it ran and on which host (every row records `host` — E9); what it
// spent; each step with its kind label, its app, its summary — PLAIN TEXT, never HTML: the
// summary is the AI's or the app's words, scrubbed before it was stored, and rendered as a
// text node here, nothing more — and its status; then the pending *changes waiting for your
// OK*, each statement VERBATIM in a `<pre>` with the dry-run count, the app it would change
// and the line "written by the AI from your data"; and for the states with one act, that act
// (`needs-you` → *run now and review*; `no-handler` → *open <app>*; `capped` has none).
//
// THE CHANGES (ADR-0074 §6). Every item NAMES ITS APP (`appId` on the protocol's proposal
// item): the executor recorded which *ask the AI* step composed it, so a schedule that asks
// two apps applies each statement to its own data, never the first step's. *apply to my data*
// builds a `PendingWriteProposal` — the item's app, `[sql]`, no params, the stored count as the
// drift baseline — and hands it to `executeApprovedWrite`, the ONE path from a proposed
// statement to real data; the re-dry-run and the drift check happen inside it. Applied: the
// item leaves the row (an applied change that still offers *apply* invites a second
// execution); drifted: the row's count becomes the current one and the item stays, with "the
// data moved — review again"; failed: the message, the item stays. An item with no app is
// refused outright ("these changes have no app to apply to") and offers only *decline*.
// *decline* removes the item from the row: there is no scheduler act for that — it is written
// straight through `db.putScheduleRun` (the upsert by `(taskId, dueAt)`) and the revision is
// bumped so every view re-reads. The batch has one expiry; past it nothing is offered.
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
  applied,
  callsLine,
  couldNotApply,
  dueLine,
  interruptedWhy,
  onHost,
  openApp,
  ranLine,
  wouldChange,
} from './copy.result.js';
import { absoluteTime, relativeTime, useNow } from './pageModel.js';
import { editHref } from './routes.js';
import { ResultStatus, StepStatus, appNameOf, type AppName } from './ScheduleStates.js';
import { markSeen, runNow, useScheduler } from './scheduler.js';
import { sameOccurrence } from './taskShape.js';

/** One item's identity in the batch: its app and its statement (two apps may propose the same SQL). */
const itemKey = (item: ScheduleProposalItem): string => `${item.appId}:${item.sql}`;

/** The app an item applies to — its own; an empty id (nothing to apply to) is refused by the view. */
export function itemAppId(item: Pick<ScheduleProposalItem, 'appId'>): string | undefined {
  return item.appId === '' ? undefined : item.appId;
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

/** The pending change's shape for the one write path (`agent/dataTools.ts`): the ITEM's app, its one statement. */
export function proposalFor(appId: string, item: ScheduleProposalItem): PendingWriteProposal {
  return {
    appId,
    statements: [item.sql],
    params: [[]],
    summary: item.summary ?? '',
    previewed: [item.counts?.changes ?? 0],
  };
}

type Settled = { key: string; sql: string; summary: string | undefined; line: string };

export function ResultDetail(): ReactElement {
  const params = useParams<{ id: string; dueAt: string }>();
  const taskId = params.id ?? '';
  const dueAt = params.dueAt ?? '';
  const view = useScheduler();
  const libraryRevision = useLibraryRevision();
  const now = useNow();

  const task = view.tasks.find((entry) => entry.id === taskId);
  const run = (view.runsByTask[taskId] ?? []).find((row) => sameOccurrence(row, dueAt));

  const [apps, setApps] = useState<readonly AppName[]>([]);
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [settled, setSettled] = useState<readonly Settled[]>([]);
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined);
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

  const ranAt = run.finishedAt ?? run.startedAt;
  const whenLine =
    ranAt !== undefined
      ? ranLine(absoluteTime(new Date(ranAt)), relativeTime(new Date(ranAt), now))
      : dueLine(absoluteTime(new Date(run.dueAt)), relativeTime(new Date(run.dueAt), now));

  const proposals = run.proposals;
  const expired = proposals !== undefined && Date.parse(proposals.expiresAt) <= now.getTime();

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

  const without = (key: string): ScheduleProposalItem[] => (proposals?.items ?? []).filter((item) => itemKey(item) !== key);

  const approve = async (item: ScheduleProposalItem): Promise<void> => {
    const appId = itemAppId(item);
    if (appId === undefined || busyKey !== undefined) return;
    const key = itemKey(item);
    setBusyKey(key);
    setError(undefined);
    try {
      const db = await getUserDb();
      const outcome = await executeApprovedWrite(db, proposalFor(appId, item));
      if (outcome.ok) {
        await writeItems(without(key));
        setSettled((list) => [...list, { key, sql: item.sql, summary: item.summary, line: applied(outcome.executed) }]);
      } else if (outcome.reason === 'drifted') {
        const current = outcome.current[0] ?? 0;
        await writeItems((proposals?.items ?? []).map((entry) => (itemKey(entry) === key ? { ...entry, counts: { changes: current } } : entry)));
        setNotes((map) => ({ ...map, [key]: DRIFTED }));
      } else {
        setNotes((map) => ({ ...map, [key]: couldNotApply(outcome.message) }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const decline = async (item: ScheduleProposalItem): Promise<void> => {
    if (busyKey !== undefined) return;
    const key = itemKey(item);
    setBusyKey(key);
    setError(undefined);
    try {
      await writeItems(without(key));
      setSettled((list) => [...list, { key, sql: item.sql, summary: item.summary, line: DECLINED }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(undefined);
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
          <Link to={editHref(taskId)} data-testid="schedule-result-title">
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
          ) : null}
          {!expired
            ? (proposals?.items ?? []).map((item) => {
                const key = itemKey(item);
                const appId = itemAppId(item);
                const appName = appId === undefined ? undefined : appNameOf(appId, apps);
                return (
                  <Card key={key} className="schedule-change" data-testid="schedule-change" data-app={appId}>
                    {item.summary !== undefined && item.summary !== '' ? <span className="artifact-name">{sanitizeCardText(item.summary)}</span> : null}
                    <pre className="schedule-result-sql">{item.sql}</pre>
                    <span className="hint" data-testid="schedule-change-count">
                      {wouldChange(item.counts?.changes)}
                      {appName !== undefined ? ` in ${appName}` : ''} · {AI_WROTE}
                    </span>
                    {appId === undefined ? (
                      <span className="hint" role="status" data-testid="schedule-change-no-app">
                        {NO_APP_FOR_CHANGES}
                      </span>
                    ) : null}
                    {notes[key] !== undefined ? (
                      <span className="hint" role="status" data-testid="schedule-change-note">
                        {notes[key]}
                      </span>
                    ) : null}
                    <div className="schedule-change-actions">
                      {appId !== undefined ? (
                        <Button variant="primary" onClick={() => void approve(item)} disabled={busyKey !== undefined}>
                          {CHANGE_ACTIONS.apply}
                        </Button>
                      ) : null}
                      <Button onClick={() => void decline(item)} disabled={busyKey !== undefined}>
                        {CHANGE_ACTIONS.decline}
                      </Button>
                    </div>
                  </Card>
                );
              })
            : null}
          {settled.map((entry) => (
            <Card key={`settled-${entry.key}`} className="schedule-change is-settled" data-testid="schedule-change-settled">
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
