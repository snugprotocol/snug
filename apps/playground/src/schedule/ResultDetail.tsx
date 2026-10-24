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
//
// TASK-20261010-host-broker PR-4 (ADR-0076 §9; D-PR4-6, D-PR4-15, D-PR4-18; D2, D7, D8, D13, D18,
// D19; contract v2.1 N1):
//   - TWO SECTIONS, IN ORDER. *changes it made* first: the schedule's own group (the run's
//     `applied` — *changed 12 rows in Ledger on its own*) and each change the user applied here
//     (the run's `approved` — *you applied this — 2 rows changed*), each saying what is TRUE of its
//     undo (PR-4 Gate 5, U2), read from the journal with its undone entries (`listOwnUndo(…, {
//     includeUndone: true })`, the task's bucket or the approval bucket): *undo* while live; *undone*
//     once undone — here, elsewhere, or before a reload; *can't be undone* when it was never
//     captured; and for an id the journal no longer holds, *undo ended after seven days* only once
//     the run finished that long ago — before then it gave way early in its bucket, and reads *can no
//     longer be undone*. Then *changes waiting for your OK*, an item the schedule held carrying ONE
//     line (`HELD_WHY`) above its acts — a *full* bucket named by its live count when the page reads
//     it (U14). *apply to my data* goes through `executeApprovedWrite(…, { via: 'user' })` and is
//     PERSISTED as an `approved` entry (no SQL), so a reload keeps it; the in-session settled line
//     stays beside it.
//   - THE ONE *stop*, under the when-line, on a schedule that makes changes on its own — answered in
//     place by a focused status line, since the act goes with the authority (U7); and a link to the
//     schedule's changes list, where an undo stays findable for its whole seven days — shown only
//     when that list can hold something of this result's: the schedule makes changes on its own, or
//     this run made its own (`applied`). The user's approvals live in the approval bucket, which the
//     list never shows (U6).
//   - A CAPPED run says WHICH daily limit it reached, read back from its reason (`cappedWhatOf`, U14).
//   - EACH STEP'S ONE HOST LINE (`stepFacts`): where it ran (never the word *background*), what it
//     read with the user's leave (R-88), what it looked up and through which connection.
//   - A step no brain could answer here (`blockedBy: 'brain'` — the demo, or a key not set) is its
//     own state with the one act *open Settings*, never *needs your OK*.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES } from '@snugprotocol/adapters';
import { OWN_UNDO_APPROVAL_BUCKET, type UserDb } from '@snugprotocol/db';
import {
  ACCESS_UNDO_TTL_MS,
  SCHEDULE_PROPOSALS_PER_RUN,
  type OwnUndoEntry,
  type ScheduleProposalItem,
  type ScheduleRun,
  type ScheduleRunApproved,
  type ScheduledTask,
  type StepResult,
} from '@snugprotocol/protocol';

import { ManageUsageLink } from '../ui/ManageUsageLink.js';
import { OwnUndoAct } from '../access/OwnUndoAct.js';
import type { UndoOutcome } from '../access/writeBroker.js';
import { sanitizeCardText } from '../agent/cards.js';
import { executeApprovedWrite, type PendingWriteProposal } from '../agent/dataTools.js';
import { bumpScheduleRevision, useLibraryRevision, useScheduleRevision } from '../platform/signals.js';
import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';
import { disarmTask } from './acts.js';
import { WORDS, brainBlocked, capped, cappedWhatOf, needsYou, noHandler, stepLabel } from './copy.js';
import { ROW } from './copy.page.js';
import {
  AI_WROTE,
  CHANGE_ACTIONS,
  CHANGES_LINK,
  DECLINED,
  DRIFTED,
  EXPIRED,
  HELD_WHY,
  MADE,
  RESULT_ON_ITS_OWN,
  NEEDS_YOU_FALLBACK_VERB,
  needsYouTitle,
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
  openingToRun,
  ranLine,
  stepFacts,
  wouldChange,
} from './copy.result.js';
import { absoluteTime, appRunAppOf, relativeTime, useNow } from './pageModel.js';
import { SETTINGS_HREF, editHref, historyHref } from './routes.js';
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

/** Each app's approved connections by slot → the name the user knows it by (a step's look-ups name them). */
type ConnectionNames = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** What the journal still says of an undo id: offered, or undone and kept until it expires. An id it no longer holds has no state. */
type UndoState = 'live' | 'undone';

/** What this result reads from the journal: each undo id its changes name, and each held app's live count in the schedule's bucket. */
interface JournalRead {
  undo: ReadonlyMap<string, UndoState>;
  /** App id → the live entries in this schedule's bucket for that app — what a *full* line names (U14). */
  live: ReadonlyMap<string, number>;
}

/**
 * The journal's word on this result's changes (U2, U14): a schedule's group lives in its task's
 * bucket, the user's own applies in the app's approval bucket — each read WITH its undone entries,
 * so an undo already made reads *undone* after a reload, never as if its seven days were over.
 */
function readJournal(db: UserDb, taskId: string, run: ScheduleRun | undefined): JournalRead {
  const undo = new Map<string, UndoState>();
  const note = (entries: readonly OwnUndoEntry[]): void => {
    for (const entry of entries) undo.set(entry.id, entry.undoneAt === undefined ? 'live' : 'undone');
  };
  if (run?.applied !== undefined) note(db.listOwnUndo(run.applied.appId, { taskId }, { includeUndone: true }));
  for (const appId of new Set((run?.approved ?? []).map((entry) => entry.appId))) note(db.listOwnUndo(appId, { bucket: OWN_UNDO_APPROVAL_BUCKET }, { includeUndone: true }));
  const live = new Map<string, number>();
  for (const appId of fullAppIds(run)) live.set(appId, db.listOwnUndo(appId, { taskId }).length);
  return { undo, live };
}

/** The apps whose items this run held because the schedule's bucket was full — the ones a *full* line counts for. */
const fullAppIds = (run: ScheduleRun | undefined): string[] => [...new Set((run?.proposals?.items ?? []).filter((item) => item.held === 'full').map((item) => item.appId))];

/** The user's undo of one own change — through the bucket that holds it, as the user's act. */
async function undoOwnChange(appId: string, bucket: string, undoId: string): Promise<UndoOutcome> {
  const [db, { undoOwnWrite }] = await Promise.all([getUserDb(), import('../access/writeBroker.js')]);
  return undoOwnWrite(db, appId, bucket, undoId, { via: 'user' });
}

export function ResultDetail(): ReactElement {
  const params = useParams<{ id: string; dueAt: string }>();
  const taskId = params.id ?? '';
  const dueAt = params.dueAt ?? '';
  const view = useScheduler();
  const libraryRevision = useLibraryRevision();
  const now = useNow();
  const navigate = useNavigate();

  const task = view.tasks.find((entry) => entry.id === taskId);
  const run = (view.runsByTask[taskId] ?? []).find((row) => sameOccurrence(row, dueAt));

  const scheduleRevision = useScheduleRevision();
  const [apps, setApps] = useState<readonly AppName[]>([]);
  const [connections, setConnections] = useState<ConnectionNames>(new Map());
  /** The journal's word on this result's changes — `undefined` until it was read, so nothing flickers as ended. */
  const [journal, setJournal] = useState<JournalRead | undefined>(undefined);
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [settled, setSettled] = useState<readonly Settled[]>([]);
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [runNowNote, setRunNowNote] = useState<string | undefined>(undefined);
  /** The one *stop* answered (U7): its line takes the place — and the focus — of the act that went with the authority. */
  const [stopped, setStopped] = useState(false);
  const [stopError, setStopError] = useState<string | undefined>(undefined);
  const stoppedRef = useRef<HTMLParagraphElement>(null);
  const onItsOwnLineId = useId();

  useEffect(() => {
    if (stopped) stoppedRef.current?.focus();
  }, [stopped]);

  // The app names and their connections' names, read once per library revision.
  useEffect(() => {
    let cancelled = false;
    void getUserDb()
      .then((db) => {
        if (cancelled) return;
        const listed = db.listApps();
        setApps(listed.map(({ appId, displayName }) => ({ appId, displayName })));
        setConnections(new Map(listed.map(({ appId }) => [appId, new Map(db.listConnections(appId).map((row) => [row.slot, row.requirement.provider.name] as const))] as const)));
      })
      .catch(() => {
        // Names are garnish on a result that renders without them ("this app").
      });
    return () => {
      cancelled = true;
    };
  }, [libraryRevision]);

  // What can still be undone, and how full the schedule's bucket is — re-read whenever a schedule
  // write lands (an approve, an undo, a walk), so a change undone elsewhere stops offering its undo here.
  const journalKey = JSON.stringify([run?.applied?.undoId, (run?.approved ?? []).map((entry) => entry.undoId), fullAppIds(run)]);
  useEffect(() => {
    let cancelled = false;
    void getUserDb()
      .then((db) => {
        if (!cancelled) setJournal(readJournal(db, taskId, run));
      })
      .catch(() => {
        if (!cancelled) setJournal({ undo: new Map(), live: new Map() });
      });
    return () => {
      cancelled = true;
    };
    // The run object changes identity on every view publish; its undo ids are what the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, journalKey, scheduleRevision]);

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

  /**
   * Rewrite the row with the given items (none → no batch at all) and, for an apply, the user's
   * `approved` entry beside what was there — then tell every view.
   */
  const writeItems = async (items: readonly ScheduleProposalItem[], approvedEntry?: ScheduleRunApproved): Promise<void> => {
    const db = await getUserDb();
    const current = db.listScheduleRuns(taskId).find((row) => sameOccurrence(row, dueAt));
    if (current === undefined) throw new Error('this result is gone');
    const { proposals: _batch, approved: earlier, ...rest } = current;
    // At most one entry per item a run can hold, so the seat's bound is the batch's; the newest win.
    const approved = approvedEntry === undefined ? earlier : [...(earlier ?? []), approvedEntry].slice(-SCHEDULE_PROPOSALS_PER_RUN);
    db.putScheduleRun({
      ...rest,
      ...(items.length === 0 || current.proposals === undefined ? {} : { proposals: { items: [...items], expiresAt: current.proposals.expiresAt } }),
      ...(approved !== undefined ? { approved } : {}),
    });
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
      const outcome = await executeApprovedWrite(db, proposalFor(appId, item), { via: 'user' });
      if (outcome.ok) {
        // PERSISTED, no SQL: what was applied, and the entry its undo lives under — or that it has none.
        const approvedEntry: ScheduleRunApproved = {
          appId,
          ...(outcome.undoId !== undefined ? { undoId: outcome.undoId } : {}),
          ...(outcome.undoable ? {} : { undoable: false as const }),
          ...(item.summary !== undefined && item.summary !== '' ? { summary: item.summary } : {}),
          changes: outcome.executed.reduce((sum, n) => sum + n, 0),
        };
        await writeItems(without(key), approvedEntry);
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

  const needsYouAt = needsYouStep(task, run);
  const needsYouApp = appOfStep(task, needsYouAt);
  // The card's TITLE is the host's own short sentence ("<app> needs your OK"); the BODY is the run's
  // reason — which, since ADR-0077, says whether the user declined, nobody answered, or the app asked
  // again (TASK-20261010-host-broker PR-1). The old fallback tail ("Snug doesn't make changes while
  // you're away") was wrong for a dialog the user themselves declined. The one act is unchanged.
  const needsYouName = needsYouApp === undefined ? task.title : (appNameOf(needsYouApp, apps) ?? 'this app');
  const needsYouCopy = { text: needsYouTitle(needsYouName), action: needsYou(needsYouName, NEEDS_YOU_FALLBACK_VERB).action };
  // The app a *run <app>* step runs — the refused step's when it is one, else the first such step.
  const refusedStep = task.steps[needsYouAt];
  const runApp = refusedStep?.kind === 'app-run' ? refusedStep.appId : appRunAppOf(task.steps);

  // *Run now and review* on a schedule that RUNS an app opens the app FIRST (S2): the engine
  // delivers a manual run only to a live frame, because the point of the act is that the user
  // is there to answer the gate. A schedule that only asks or reminds runs in place.
  const runNowAndReview = async (): Promise<void> => {
    setRunNowNote(undefined);
    if (runApp !== undefined) navigate(`/run/${encodeURIComponent(runApp)}`);
    const result = await runNow(taskId);
    if (!result.ok) setRunNowNote(result.reason);
  };
  const noHandlerAt = run.steps.findIndex((step) => step.status === 'no-handler');
  const noHandlerApp = appOfStep(task, noHandlerAt === -1 ? task.steps.findIndex((step) => step.kind !== 'notify') : noHandlerAt);
  const noHandlerCopy = noHandler(noHandlerApp === undefined ? task.title : (appNameOf(noHandlerApp, apps) ?? 'this app'));
  // No brain may answer here (the demo, a key not set — or the ChatGPT plan signed out / not allowed):
  // its own state — never *needs your OK*. The card says the FIRST blocked step's own sentence (the
  // plan's refusal names the plan; TASK-20261023 L5-4), falling back to the keyless one when a step
  // carries none; *open Settings* is the right act for every one of them.
  const brainBlockedStep = run.steps.find((step) => step.blockedBy === 'brain');
  const brainBlockedHere = brainBlockedStep !== undefined;
  const brainBlockedText =
    brainBlockedStep?.summary !== undefined && brainBlockedStep.summary !== '' ? sanitizeCardText(brainBlockedStep.summary) : brainBlocked.text;

  // Making changes on its own: the schedule's state, what this run made, and the one *stop*.
  const onItsOwn = task.writeAuthority !== undefined;
  const madeHere = run.applied !== undefined || (run.approved ?? []).length > 0;
  const appliedRows = run.applied?.items.reduce((sum, item) => sum + item.changes, 0) ?? 0;
  /** The run finished seven days ago or more: an undo the journal no longer holds ENDED; before that it gave way early (U2). */
  const undoAged = now.getTime() - Date.parse(run.finishedAt ?? run.dueAt) >= ACCESS_UNDO_TTL_MS;
  const stopOnItsOwn = async (): Promise<void> => {
    setStopError(undefined);
    const result = await disarmTask(taskId);
    if (result.ok) setStopped(true);
    else setStopError(result.reason);
  };
  /** A held item's one line — a *full* one waits for the journal, which names how many are still live (U14). */
  const heldLine = (item: ScheduleProposalItem, appName: string): string | undefined => {
    if (item.held === undefined || (item.held === 'full' && journal === undefined)) return undefined;
    return HELD_WHY[item.held](appName, journal?.live.get(item.appId) ?? 0);
  };

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
        {onItsOwn && !stopped ? (
          <p className="hint schedule-result-on-its-own" data-testid="schedule-result-on-its-own">
            <span id={onItsOwnLineId}>{RESULT_ON_ITS_OWN.line}</span> ·{' '}
            <Button variant="ghost" aria-describedby={onItsOwnLineId} onClick={() => void stopOnItsOwn()}>
              {RESULT_ON_ITS_OWN.stop}
            </Button>
          </p>
        ) : null}
        {stopped ? (
          <p className="hint schedule-result-stopped" role="status" tabIndex={-1} ref={stoppedRef} data-testid="schedule-result-stopped">
            {ROW.stoppedOnItsOwn}
          </p>
        ) : null}
        {stopError !== undefined ? (
          <div className="error-note" role="alert" data-testid="schedule-result-stop-error">
            {stopError}
          </div>
        ) : null}
        {onItsOwn || run.applied !== undefined ? (
          <p className="hint">
            <Link to={historyHref(taskId)} data-testid="schedule-result-changes-link">
              {CHANGES_LINK}
            </Link>
          </p>
        ) : null}
      </header>

      {brainBlockedHere ? (
        <StateCard
          text={brainBlockedText}
          testId="schedule-result-brain"
          action={
            <Link to={SETTINGS_HREF} className="btn btn-primary">
              {brainBlocked.action}
            </Link>
          }
        />
      ) : run.status === 'needs-you' ? (
        <StateCard
          text={needsYouCopy.text}
          detail={run.reason}
          testId="schedule-result-needs-you"
          action={
            <Button variant="primary" onClick={() => void runNowAndReview()}>
              {needsYouCopy.action}
            </Button>
          }
          hint={runApp !== undefined ? openingToRun(appNameOf(runApp, apps) ?? 'this app') : undefined}
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
        <StateCard text={capped(cappedWhatOf(run.reason))} testId="schedule-result-capped" />
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
              <StepRow key={`${run.id}-step-${index}`} task={task} index={index} result={result} apps={apps} connections={connections} />
            ))}
          </ol>
        </section>
      ) : null}

      {madeHere ? (
        <section className="schedule-result-made" aria-labelledby="schedule-result-made-heading" data-testid="schedule-result-made">
          <h2 id="schedule-result-made-heading" className="settings-section-label">
            {WORDS.changesMade}
          </h2>
          {run.applied !== undefined ? (
            <MadeLine
              line={MADE.onItsOwn(appliedRows, appNameOf(run.applied.appId, apps) ?? 'this app')}
              rows={appliedRows}
              appName={appNameOf(run.applied.appId, apps) ?? 'this app'}
              undoId={run.applied.undoId}
              captured={run.applied.undoable !== false}
              journal={journal?.undo}
              aged={undoAged}
              onUndo={(appId, undoId) => undoOwnChange(appId, taskId, undoId)}
              appId={run.applied.appId}
            />
          ) : null}
          {(run.approved ?? []).map((entry, index) => (
            <MadeLine
              key={`${entry.undoId ?? 'approved'}-${index}`}
              line={MADE.youApplied(entry.changes)}
              rows={entry.changes}
              appName={appNameOf(entry.appId, apps) ?? 'this app'}
              undoId={entry.undoId}
              captured={entry.undoable !== false}
              journal={journal?.undo}
              aged={undoAged}
              onUndo={(appId, undoId) => undoOwnChange(appId, OWN_UNDO_APPROVAL_BUCKET, undoId)}
              appId={entry.appId}
            />
          ))}
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
                const held = heldLine(item, appName ?? 'this app');
                return (
                  <Card key={key} className="schedule-change" data-testid="schedule-change" data-app={appId}>
                    {item.summary !== undefined && item.summary !== '' ? <span className="artifact-name">{sanitizeCardText(item.summary)}</span> : null}
                    <pre className="schedule-result-sql">{item.sql}</pre>
                    <span className="hint" data-testid="schedule-change-count">
                      {wouldChange(item.counts?.changes)}
                      {appName !== undefined ? ` in ${appName}` : ''} · {AI_WROTE}
                    </span>
                    {held !== undefined ? (
                      <p className="hint schedule-change-held" role="note" data-testid="schedule-change-held">
                        {held}
                      </p>
                    ) : null}
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

/**
 * One made change's line (`schedule-made-group`): what was changed, then what is true of its undo
 * (U2) — offered while the journal holds `undoId` live, *undone* once it was, and for an id the
 * journal no longer holds *undo ended after seven days* past them (`aged`), else *can no longer be
 * undone*; *can't be undone* for a change never captured. Nothing is said of the undo until the
 * journal was read.
 */
function MadeLine({
  line,
  rows,
  appId,
  appName,
  undoId,
  captured,
  journal,
  aged,
  onUndo,
}: {
  line: string;
  rows: number;
  appId: string;
  appName: string;
  undoId: string | undefined;
  /** False: the change was applied uncaptured — it never had an undo. */
  captured: boolean;
  /** The journal's word on each undo id — `undefined` until read. */
  journal: ReadonlyMap<string, UndoState> | undefined;
  /** The run finished `ACCESS_UNDO_TTL_MS` or more ago. */
  aged: boolean;
  onUndo: (appId: string, undoId: string) => Promise<UndoOutcome>;
}): ReactElement {
  const state = journal === undefined || undoId === undefined ? undefined : journal.get(undoId);
  const offered = captured && state === 'live';
  const undone = captured && state === 'undone';
  const ended = !captured ? MADE.cannotUndo : journal === undefined || state !== undefined ? undefined : aged ? MADE.undoEnded : MADE.noLonger;
  return (
    <p className="field-row field-row-wrap schedule-made-group" data-testid="schedule-made-group">
      <span>{line}</span>
      {ended !== undefined || offered || undone ? ' · ' : null}
      <OwnUndoAct rows={rows} appName={appName} offered={offered} undone={undone} onUndo={undoId === undefined ? undefined : () => onUndo(appId, undoId)} ended={ended} />
    </p>
  );
}

function StepRow({ task, index, result, apps, connections }: { task: ScheduledTask; index: number; result: StepResult; apps: readonly AppName[]; connections: ConnectionNames }): ReactElement {
  const step = task.steps[index];
  const appId = step === undefined || step.kind === 'notify' ? undefined : step.appId;
  const appName = appId === undefined ? undefined : appNameOf(appId, apps);
  const label = step === undefined ? stepLabel('app-run') : stepLabel(step.kind, appName);
  // The host's one line about this step: where it ran, what it read with leave, what it looked up.
  const facts =
    step === undefined
      ? undefined
      : stepFacts(step, result, {
          app: appName ?? 'this app',
          connection: (slot) => (appId === undefined ? undefined : connections.get(appId)?.get(slot)) ?? slot,
        });
  return (
    <li className="schedule-result-step" data-testid="schedule-result-step">
      <div className="schedule-result-step-head">
        <span className="schedule-result-step-label">{label}</span>
        {/* TASK-20261023 L5-3: `stepResultSchema` carries no code (a C3 change, queued), so the plan's usage-limit
            refusal is known by its summary being EXACTLY the single-homed sentence — compared, never retyped —
            and its one remedy, Manage usage, is the row's primary act and comes FIRST, before the app link
            (AC7; §12's rule; Gate 5 verifier R3). Not a brain-missing state. */}
        {result.status === 'refused' && result.summary === CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_LIMIT] ? (
          <ManageUsageLink className="btn btn-primary" testId="schedule-result-manage-usage" />
        ) : null}
        {appId !== undefined ? (
          <Link to={`/run/${encodeURIComponent(appId)}`} className="schedule-result-step-app">
            {openApp(appName ?? 'this app')}
          </Link>
        ) : null}
        <StepStatus status={result.status} />
      </div>
      {result.summary !== undefined && result.summary !== '' ? <p className="schedule-result-step-summary">{sanitizeCardText(result.summary)}</p> : null}
      {result.appMissing === true ? <span className="hint">{stepLabel(step?.kind ?? 'app-run')} — this app was deleted</span> : null}
      {facts !== undefined ? (
        <p className="hint schedule-result-step-facts" data-testid="schedule-result-step-facts">
          {facts}
        </p>
      ) : null}
    </li>
  );
}

function StateCard({
  text,
  detail,
  action,
  hint,
  note,
  testId,
}: {
  text: string;
  detail?: string | undefined;
  action?: ReactElement | undefined;
  /** What the act will do before it does it ("opening Ledger to run it with you"). */
  hint?: string | undefined;
  note?: string | undefined;
  testId: string;
}): ReactElement {
  return (
    <div className="connection-note" role="status" data-testid={testId}>
      <p className="connection-note-title">{text}</p>
      {detail !== undefined ? <p className="connection-note-body">{sanitizeCardText(detail)}</p> : null}
      {action !== undefined ? <div className="connection-note-actions">{action}</div> : null}
      {hint !== undefined ? (
        <p className="hint" data-testid={`${testId}-hint`}>
          {hint}
        </p>
      ) : null}
      {note !== undefined ? (
        <p className="connection-note-body" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
