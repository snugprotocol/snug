// schedule/ScheduleRow.tsx — one schedule on the page (TASK-20261009-scheduling-framework U2;
// design F12, the row anatomy). At 375 px line 1 is the title and a 44 px `role="switch"`;
// line 2 is the when ("Weekdays at 8:00 AM"), "next tomorrow", and the apps collapsed to their
// emoji (the name is the accessible name, and shows again on a wide screen); a 44 px kebab
// opens run now · edit · history · delete, where delete arms the tiles' inline confirm
// ("delete for good?" · delete · keep) — no window.confirm. An attention line, when the
// schedule has one, carries its ONE act: resume (paused), review (imported), run now and
// review (needs you).
//
// AN IMPORTED SCHEDULE HAS ONE WAY ON (C4; security F10): the consent panel in its editor.
// The row's switch never enables it directly — the engine refuses that too — so on an
// imported row the switch's click is the same act as *review*: it opens the editor. Any
// refusal the engine answers (a deleted app, a read-only file) is rendered inline, in words.
//
// MAKING CHANGES ON ITS OWN (TASK-20261010-host-broker PR-4; D-PR4-8, D-PR4-10, D-PR4-18; D5, D6):
// shown wherever the schedule is. Line 2 carries the chip *makes changes on its own* — a glyph
// whose accessible name is the words, the words beside it on a wide screen; the kebab gains *stop
// making changes on its own*, which says what it did in the row; a disarm the user did not perform
// is an attention line with *review*; a delete that would end live undos says so in its confirm.
// THE HISTORY opens with the schedule's changes list (`ScheduleChanges` — read from its own undo
// bucket, so an undo stays findable whatever was pruned), and each result's line carries the
// host's facts after the AI's words (`resultFacts`, as of the page's clock — an expired batch waits
// for nothing, U10), with no empty words before them (U13). ARRIVING FROM A RESULT'S LINK
// (`?history=<id>`, U6) opens this row's history AND lands on it: scrolled into view and focused
// (`tabIndex={-1}` — focusable without joining the tab order), never the top of the page with the
// focus on <body>.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { useDismissableMenu } from '../ui/useDismissableMenu.js';
import { disarmTask } from './acts.js';
import { RESULT_STATUS_WORD, disarmed, imported, needsYou, paused, type StateCopy } from './copy.js';
import { ROW } from './copy.page.js';
import { resultFacts } from './copy.result.js';
import { describeSpec } from './cron.js';
import { appRunAppOf, attentionOf, nextFor, relativeTime, runsNewestFirst, type AppIndex, type Attention } from './pageModel.js';
import { HISTORY_PARAM, editHref } from './routes.js';
import { ScheduleChanges, readScheduleChanges } from './ScheduleChanges.js';
import { pausedRow } from './ScheduleStates.js';
import { deleteTask, runNow, setTaskEnabled } from './scheduler.js';
import { appIdsOf } from './taskShape.js';

/** The glyph of the *makes changes on its own* chip; the words are its accessible name. */
const ON_ITS_OWN_GLYPH = '✎';

/** The attention line's copy, with its one act's handler. */
function attentionCopy(attention: Attention, item: ScheduledTask, apps: AppIndex): { copy: StateCopy; act: 'resume' | 'review' | 'open-app' } {
  switch (attention.kind) {
    case 'paused':
      // Paused by an update that also ended making changes on its own: `pausedRow` says resuming won't bring that back.
      if (attention.reason === 'app-updated') return { copy: pausedRow({ ...item, pausedReason: attention.reason }) ?? paused(attention.reason), act: 'resume' };
      return { copy: paused(attention.reason, attention.reason === 'failures' ? item.consecutiveFailures : item.unseenResults), act: 'resume' };
    case 'disarmed':
      return { copy: disarmed(attention.reason), act: 'review' };
    case 'imported':
      return { copy: imported, act: 'review' };
    case 'needs-you': {
      const firstApp = appIdsOf(item.steps)[0];
      return { copy: needsYou(firstApp === undefined ? item.title : apps.name(firstApp), attention.run.reason ?? 'change anything'), act: 'open-app' };
    }
    default: {
      const never: never = attention;
      return never;
    }
  }
}

export interface ScheduleRowProps {
  item: ScheduledTask;
  runs: readonly ScheduleRun[] | undefined;
  apps: AppIndex;
  now: Date;
  attention?: Attention | undefined;
}

export function ScheduleRow({ item, runs, apps, now, attention }: ScheduleRowProps): ReactElement {
  const navigate = useNavigate();
  const menu = useDismissableMenu();
  const [armed, setArmed] = useState(false);
  // A result's link to the schedule's changes (`historyHref`) opens this row's history on arrival.
  const [search] = useSearchParams();
  const [historyOpen, setHistoryOpen] = useState(() => search.get(HISTORY_PARAM) === item.id);
  /** Arrived by that link: the first commit lands on the history it opened (U6). Read once, like the open state. */
  const landOnHistory = useRef(search.get(HISTORY_PARAM) === item.id);
  const historyRef = useRef<HTMLUListElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** What the row's own act just did, said in the row (*stop making changes on its own*). */
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  /** The armed delete would end undos still live — read when it arms, from the schedule's own bucket. */
  const [endsUndos, setEndsUndos] = useState(false);
  /** One confirm = one delete, even for two clicks in the same tick (the tiles' latch). */
  const deleteLatch = useRef(false);
  const onItsOwn = item.writeAuthority !== undefined;

  useEffect(() => {
    if (!landOnHistory.current) return;
    landOnHistory.current = false;
    const history = historyRef.current;
    if (history === null) return;
    // A page without layout (a test, a print) has no scrolling to do; the focus still moves.
    if (typeof history.scrollIntoView === 'function') history.scrollIntoView({ block: 'start' });
    history.focus();
  }, []);

  const next = nextFor(item, now);
  const appIds = appIdsOf(item.steps);
  const historyId = `schedule-history-${item.id}`;
  /**
   * The one enable path for an imported schedule is its editor's consent panel — also when its
   * attention line speaks of the authority the import took away (the `disarmed` trace ranks first).
   */
  const shown = attention ?? attentionOf(item, runs);
  const reviewFirst = shown?.kind === 'imported' || (shown?.kind === 'disarmed' && item.provenance === 'imported' && !item.enabled);

  const toggle = async (): Promise<void> => {
    setError(undefined);
    if (reviewFirst) {
      navigate(editHref(item.id));
      return;
    }
    const result = await setTaskEnabled(item.id, !item.enabled);
    if (!result.ok) setError(result.reason);
  };

  /** The app a *run <app>* step runs, when the schedule has one. */
  const runApp = appRunAppOf(item.steps);

  // *Run now* on a schedule that RUNS an app opens the app FIRST (S2): the engine delivers a
  // manual run only to a live frame — the user is there to see it and to answer the gate. A
  // schedule that only asks or reminds runs in place.
  const run = async (): Promise<void> => {
    setError(undefined);
    if (runApp !== undefined) navigate(`/run/${encodeURIComponent(runApp)}`);
    const result = await runNow(item.id);
    if (!result.ok) setError(result.reason);
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteLatch.current) return;
    deleteLatch.current = true;
    setBusy(true);
    try {
      await deleteTask(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
      deleteLatch.current = false;
      setBusy(false);
      setArmed(false);
    }
  };

  /** The kebab's act on an armed schedule: the authority goes, the schedule stays on — and the row says so. */
  const stopOnItsOwn = async (): Promise<void> => {
    setError(undefined);
    const result = await disarmTask(item.id);
    if (result.ok) setOutcome(ROW.stoppedOnItsOwn);
    else setError(result.reason);
  };

  /** Arm the delete confirm — and learn, from the journal, whether it would end undos still live. */
  const armDelete = (): void => {
    setError(undefined);
    setEndsUndos(false);
    setArmed(true);
    void readScheduleChanges(item.id).then((changes) => setEndsUndos(changes.length > 0));
  };

  const attentionLine = attention === undefined ? undefined : attentionCopy(attention, item, apps);
  const onAttentionAct = (): void => {
    if (attentionLine === undefined) return;
    if (attentionLine.act === 'resume') void setTaskEnabled(item.id, true).then((result) => (result.ok ? undefined : setError(result.reason)));
    else if (attentionLine.act === 'review') navigate(editHref(item.id));
    else if (runApp !== undefined) void run(); // *run now and review*: the app, then the manual run into it (S2)
    else {
      const firstApp = appIds[0];
      if (firstApp !== undefined) navigate(`/run/${encodeURIComponent(firstApp)}`);
    }
  };

  return (
    <li className={`schedule-row${item.enabled ? '' : ' is-off'}`} data-testid="schedule-row" data-schedule-id={item.id}>
      <div className="schedule-row-line1">
        <span className="schedule-row-title">{item.title}</span>
        <button
          type="button"
          role="switch"
          aria-checked={item.enabled}
          aria-label={item.title}
          className="schedule-switch"
          onClick={() => void toggle()}
          data-testid="schedule-switch"
          data-review-first={reviewFirst ? 'true' : undefined}
        >
          <span className="schedule-switch-track" aria-hidden="true">
            <span className="schedule-switch-knob" />
          </span>
          <span className="schedule-switch-word">{item.enabled ? ROW.on : ROW.off}</span>
        </button>
        <div className="schedule-menu-wrap">
          <button
            type="button"
            ref={menu.triggerRef}
            className="btn btn-ghost schedule-kebab"
            aria-haspopup="true"
            aria-expanded={menu.open}
            aria-label={ROW.menu(item.title)}
            title={ROW.menu(item.title)}
            onClick={menu.toggle}
            data-testid="schedule-kebab"
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {menu.open ? (
            <div className="schedule-menu" ref={menu.menuRef} aria-label={ROW.menu(item.title)} data-testid="schedule-menu">
              <button
                type="button"
                className="schedule-menu-item"
                onClick={() => {
                  menu.close(true);
                  void run();
                }}
              >
                {ROW.runNow}
              </button>
              <button
                type="button"
                className="schedule-menu-item"
                onClick={() => {
                  menu.close(false);
                  navigate(editHref(item.id));
                }}
              >
                {ROW.edit}
              </button>
              <button
                type="button"
                className="schedule-menu-item"
                aria-expanded={historyOpen}
                aria-controls={historyId}
                onClick={() => {
                  menu.close(true);
                  setHistoryOpen((open) => !open);
                }}
              >
                {ROW.history}
              </button>
              {onItsOwn ? (
                <button
                  type="button"
                  className="schedule-menu-item"
                  onClick={() => {
                    menu.close(true);
                    void stopOnItsOwn();
                  }}
                >
                  {ROW.stopOnItsOwn}
                </button>
              ) : null}
              <button
                type="button"
                className="schedule-menu-item is-danger"
                onClick={() => {
                  menu.close(true);
                  armDelete();
                }}
              >
                {ROW.delete}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="schedule-row-line2">
        <span className="schedule-row-when">{describeSpec(item.spec)}</span>
        <span className="schedule-row-sep" aria-hidden="true">
          ·
        </span>
        <span className="schedule-row-next">{next === undefined ? ROW.nothingComing : ROW.next(relativeTime(next, now))}</span>
        {onItsOwn ? (
          <span className="schedule-on-its-own-chip" role="img" aria-label={ROW.onItsOwn} title={ROW.onItsOwn} data-testid="schedule-on-its-own-chip">
            <span aria-hidden="true">{ON_ITS_OWN_GLYPH}</span>
            <span className="schedule-on-its-own-words" aria-hidden="true">
              {ROW.onItsOwn}
            </span>
          </span>
        ) : null}
        {appIds.length > 0 ? (
          <span className="schedule-apps">
            {appIds.map((appId) => {
              const name = apps.name(appId);
              return (
                <span key={appId} className="schedule-app-chip" role="img" aria-label={name} title={name} data-testid="schedule-app-chip">
                  <span className="schedule-app-emoji" aria-hidden="true">
                    {apps.emoji(appId) ?? '⬡'}
                  </span>
                  <span className="schedule-app-name" aria-hidden="true">
                    {name}
                  </span>
                </span>
              );
            })}
          </span>
        ) : null}
      </div>
      {attentionLine !== undefined ? (
        <div className="schedule-row-attention" data-testid="schedule-attention" data-kind={attention?.kind}>
          <span>{attentionLine.copy.text}</span>
          {attentionLine.copy.action !== undefined ? (
            <Button variant="ghost" onClick={onAttentionAct} data-testid="schedule-attention-act">
              {attentionLine.copy.action}
            </Button>
          ) : null}
        </div>
      ) : null}
      {outcome !== undefined ? (
        <p className="hint schedule-row-outcome" role="status" data-testid="schedule-row-outcome">
          {outcome}
        </p>
      ) : null}
      {armed ? (
        <div className="tile-confirm schedule-confirm" role="group" aria-label={`${ROW.delete} ${item.title}?`}>
          <span className="tile-confirm-copy">{endsUndos ? ROW.deleteConfirmUndo : ROW.deleteConfirm}</span>
          <Button variant="danger" data-testid="schedule-delete-confirm" disabled={busy} onClick={() => void confirmDelete()}>
            {busy ? ROW.deleting : ROW.deleteYes}
          </Button>
          <Button variant="ghost" data-testid="schedule-delete-cancel" onClick={() => setArmed(false)}>
            {ROW.deleteKeep}
          </Button>
        </div>
      ) : null}
      {historyOpen ? (
        <ul className="schedule-history" id={historyId} ref={historyRef} tabIndex={-1} data-testid="schedule-history">
          <ScheduleChanges taskId={item.id} now={now} />
          {runsNewestFirst(runs).length === 0 ? (
            <li className="schedule-hint">{ROW.historyEmpty}</li>
          ) : (
            runsNewestFirst(runs).map((entry) => {
              const line = historyLine(entry, apps, now);
              return (
                <li key={`${entry.id}:${entry.dueAt}`} className="schedule-history-entry" data-status={entry.status}>
                  <span className="schedule-history-status">{RESULT_STATUS_WORD[entry.status]}</span>
                  <span className="schedule-history-when">{relativeTime(new Date(entry.finishedAt ?? entry.dueAt), now)}</span>
                  {line !== undefined ? <span className="schedule-history-summary">{line}</span> : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
      {error !== undefined ? (
        <div className="error-note schedule-row-error" role="alert" data-testid="schedule-row-error">
          {error}
        </div>
      ) : null}
    </li>
  );
}

/** A result's one line in the history: the first step's words (or the run's reason), then the host's facts as of `now` — an empty words segment is left out, never a leading ` · `. */
function historyLine(run: ScheduleRun, apps: AppIndex, now: Date): string | undefined {
  const words = run.steps[0]?.summary ?? run.reason;
  const parts = [...(words === undefined || words === '' ? [] : [words]), ...resultFacts(run, apps.name, now)];
  return parts.length === 0 ? undefined : parts.join(' · ');
}
