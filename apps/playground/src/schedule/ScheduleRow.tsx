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

import { useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';

import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { useDismissableMenu } from '../ui/useDismissableMenu.js';
import { RESULT_STATUS_WORD, imported, needsYou, paused, type StateCopy } from './copy.js';
import { ROW } from './copy.page.js';
import { describeSpec } from './cron.js';
import { attentionOf, nextFor, relativeTime, runsNewestFirst, type AppIndex, type Attention } from './pageModel.js';
import { editHref } from './routes.js';
import { deleteTask, runNow, setTaskEnabled } from './scheduler.js';
import { appIdsOf } from './taskShape.js';

/** The attention line's copy, with its one act's handler. */
function attentionCopy(attention: Attention, item: ScheduledTask, apps: AppIndex): { copy: StateCopy; act: 'resume' | 'review' | 'open-app' } {
  switch (attention.kind) {
    case 'paused':
      return { copy: paused(attention.reason, attention.reason === 'failures' ? item.consecutiveFailures : attention.reason === 'ignored' ? item.unseenResults : undefined), act: 'resume' };
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** One confirm = one delete, even for two clicks in the same tick (the tiles' latch). */
  const deleteLatch = useRef(false);

  const next = nextFor(item, now);
  const appIds = appIdsOf(item.steps);
  const historyId = `schedule-history-${item.id}`;
  /** The one enable path for an imported schedule is its editor's consent panel. */
  const reviewFirst = (attention ?? attentionOf(item, runs))?.kind === 'imported';

  const toggle = async (): Promise<void> => {
    setError(undefined);
    if (reviewFirst) {
      navigate(editHref(item.id));
      return;
    }
    const result = await setTaskEnabled(item.id, !item.enabled);
    if (!result.ok) setError(result.reason);
  };

  const run = async (): Promise<void> => {
    setError(undefined);
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

  const attentionLine = attention === undefined ? undefined : attentionCopy(attention, item, apps);
  const onAttentionAct = (): void => {
    if (attentionLine === undefined) return;
    if (attentionLine.act === 'resume') void setTaskEnabled(item.id, true).then((result) => (result.ok ? undefined : setError(result.reason)));
    else if (attentionLine.act === 'review') navigate(editHref(item.id));
    else {
      const firstApp = appIds[0];
      if (firstApp !== undefined) navigate(`/run/${firstApp}`);
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
              <button
                type="button"
                className="schedule-menu-item is-danger"
                onClick={() => {
                  menu.close(true);
                  setError(undefined);
                  setArmed(true);
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
      {armed ? (
        <div className="tile-confirm schedule-confirm" role="group" aria-label={`${ROW.delete} ${item.title}?`}>
          <span className="tile-confirm-copy">{ROW.deleteConfirm}</span>
          <Button variant="danger" data-testid="schedule-delete-confirm" disabled={busy} onClick={() => void confirmDelete()}>
            {busy ? ROW.deleting : ROW.deleteYes}
          </Button>
          <Button variant="ghost" data-testid="schedule-delete-cancel" onClick={() => setArmed(false)}>
            {ROW.deleteKeep}
          </Button>
        </div>
      ) : null}
      {historyOpen ? (
        <ul className="schedule-history" id={historyId} data-testid="schedule-history">
          {runsNewestFirst(runs).length === 0 ? (
            <li className="schedule-hint">{ROW.historyEmpty}</li>
          ) : (
            runsNewestFirst(runs).map((entry) => (
              <li key={`${entry.id}:${entry.dueAt}`} className="schedule-history-entry" data-status={entry.status}>
                <span className="schedule-history-status">{RESULT_STATUS_WORD[entry.status]}</span>
                <span className="schedule-history-when">{relativeTime(new Date(entry.finishedAt ?? entry.dueAt), now)}</span>
                {entry.steps[0]?.summary !== undefined ? <span className="schedule-history-summary">{entry.steps[0].summary}</span> : entry.reason !== undefined ? <span className="schedule-history-summary">{entry.reason}</span> : null}
              </li>
            ))
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
