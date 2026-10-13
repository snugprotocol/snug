// schedule/ScheduleCard.tsx — the schedule SUGGESTION card in the chat rail (TASK-20261009 P1;
// ADR-0074 §4; ADR-0031 §3; the `ScheduleOffer` precedent — M3). What `schedule_propose` staged on
// the agent's message — the provenance line, the title, the steps in words, the when and the next
// time — with three acts. *Schedule it* opens the ONE consent surface inside the card and the
// user's act there calls the ONE writer (`enableProposedTask`); *edit…* opens the editor route
// prefilled with the proposal and the way back; *not now* answers it.
//
// THE CARD IS UI, NEVER A GATE: nothing on it can enable anything by itself. And THE CARD NEVER
// WRITES THE CHAT ROW: an answer — scheduled (with what it became) or declined — goes out through
// `onResolve`, and the chat hook that staged the card persists it on the row and patches its
// message (the data-write card's path). With no `onResolve` the acts render disabled (the inline
// choice card's rule: a surface with no send path offers nothing), because a schedule created
// from an answer that cannot persist would be offered again on the next load.
//
// THE ROW IS THE TRUTH on a remount: a card rendered again after an answer given elsewhere (the
// other view, an earlier mount) reads the row back; the same read names the app and notices it
// is gone — a card whose app was deleted, or whose one time has passed, is stale.
//
// MOUNTED BY `ChatLog` under the agent's message, in both chats (the builder view and the run
// rail); `ChatLog` threads the message id and the hook's resolve path through.
//
// A SUGGESTION NEVER ARMS (TASK-20261010-host-broker PR-4, D-PR4-8): the consent's tick *make
// changes on its own* mounts OFF here, every time — a proposal cannot carry an authority (the
// writer re-parses it strictly) and nothing on the card seeds one. Only the user's tick arms, after
// the one writer created the schedule (`armIfTicked`). Nor does a suggestion ever ask other apps to
// fetch new data first (PR-5, D-PR5-19; S15): the card shows, consents to and hands the writer the
// proposal WITHOUT that seat (`withoutUserOnlySeats`) — what the consent shows is what is written.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import { readScheduleCardRow, type ScheduleCardState } from '../agent/scheduleCard.js';
import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { blockedAppsOf } from './askBrain.js';
import { SCHEDULE_CARD, stepWords } from './copy.js';
import { describeSpec, nextOccurrence, resolveZone } from './cron.js';
import { approvedHostsByApp, lookUpNamesByApp, type LookUpNamesByApp } from './editorModel.js';
import { EnableConsent, armIfTicked, type EnableChoice } from './EnableConsent.js';
import { enableProposedTask, withoutUserOnlySeats } from './enableProposedTask.js';
import { formatOccurrence, nextWords, pageClock } from './pageModel.js';
import { editHref, newScheduleHref } from './routes.js';

/** How the user answered a card — what `onResolve` carries. `stale` is derived on render, never answered. */
export type ScheduleCardAnswer = 'scheduled' | 'declined';

/**
 * The resolve path the chat hook hands `ChatLog` (`onResolveSchedule`): the card as rendered (its
 * thread and row ids), the message it sits on, the answer, and — for `scheduled` — the id of the
 * schedule it became. The hook persists it and patches its message; the card only reports it.
 */
export type ResolveScheduleCard = (card: ScheduleCardState, messageId: number, resolution: ScheduleCardAnswer, taskId?: string) => void;

export interface ScheduleCardProps {
  card: ScheduleCardState;
  /** The chat message the card sits on — what the hook keys its persist on. */
  messageId: number;
  /** The turn is in flight: the row does not exist yet, so an answer could not persist — the acts wait (the choice card's rule). */
  busy: boolean;
  /** Absent ⇒ the acts render disabled: an answer with nowhere to go must not create anything. */
  onResolve?: ResolveScheduleCard | undefined;
}

export function ScheduleCard({ card, messageId, busy, onResolve }: ScheduleCardProps): ReactElement {
  const location = useLocation();
  const [state, setState] = useState<ScheduleCardState>(card);
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  const [appMissing, setAppMissing] = useState(false);
  /** The consent panel is open: the hosts each app's approved connections may call, and the connections a step may look things up through. */
  const [consent, setConsent] = useState<{ hosts: Record<string, string[]>; lookUps: LookUpNamesByApp; blocked: readonly string[] } | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The row id lands after the turn finalizes; a resolution the hook rehydrated is adopted once.
  useEffect(() => {
    setState((current) => ({
      ...current,
      ...(card.messageRowId !== undefined ? { messageRowId: card.messageRowId } : {}),
      ...(card.resolution !== undefined && current.resolution === undefined
        ? { resolution: card.resolution, ...(card.taskId !== undefined ? { taskId: card.taskId } : {}) }
        : {}),
    }));
  }, [card.messageRowId, card.resolution, card.taskId]);

  // THE ROW IS THE TRUTH: a card remounted after an answer given elsewhere reads it back; the
  // same read names the app and notices it is gone.
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      if (card.appId !== undefined) {
        const app = db.getApp(card.appId);
        setAppMissing(app === undefined);
        if (app !== undefined) setAppNames({ [card.appId]: app.displayName });
      }
      if (card.messageRowId === undefined) return;
      const row = readScheduleCardRow(db, card.threadId, card.messageRowId);
      const answered = row?.resolution;
      if (row === undefined || answered === undefined) return;
      setState((current) => (current.resolution === undefined ? { ...current, resolution: answered, ...(row.taskId !== undefined ? { taskId: row.taskId } : {}) } : current));
    });
    return () => {
      cancelled = true;
    };
  }, [card.appId, card.messageRowId, card.threadId]);

  // The seats only the user's own act sets never ride a suggestion — not even one read back from a row.
  const proposal = withoutUserOnlySeats(state.proposal);
  const now = pageClock.now();
  const zone = resolveZone(proposal.spec.tz);
  const next = nextOccurrence(proposal.spec, now);
  const appName = state.appId !== undefined ? appNames[state.appId] : undefined;
  // Stale: the app the suggestion was for is gone, or its one time has passed (no next within the bound).
  const resolution = state.resolution === 'stale' || appMissing || next === undefined ? 'stale' : state.resolution;
  /** No row yet, or no path to persist an answer on: the acts wait. */
  const actsWait = busy || onResolve === undefined;

  /** Record the answer here and hand it to the hook — the one place it is persisted. */
  const answer = (resolved: ScheduleCardAnswer, taskId?: string): void => {
    setState((current) => ({ ...current, resolution: resolved, ...(taskId !== undefined ? { taskId } : {}) }));
    onResolve?.(state, messageId, resolved, taskId);
  };
  const openConsent = async (): Promise<void> => {
    const db = await getUserDb();
    const appIds = state.appId !== undefined ? [state.appId] : [];
    setError(undefined);
    setConsent({ hosts: approvedHostsByApp(db, appIds), lookUps: lookUpNamesByApp(db, appIds), blocked: blockedAppsOf(db, appIds) });
  };
  const enable = async (choice: EnableChoice): Promise<void> => {
    setWorking(true);
    setError(undefined);
    const result = await enableProposedTask({ proposal, provenance: state.channel, ...(state.appId !== undefined ? { ownerAppId: state.appId } : {}) });
    // The schedule exists from here on: a refused arming leaves it waiting for the user's OK — said, never retried.
    const refusal = result.ok ? await armIfTicked(result.task.id, choice) : undefined;
    setWorking(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setConsent(undefined);
    if (refusal !== undefined) setError(refusal);
    answer('scheduled', result.task.id);
  };
  const editTo = newScheduleHref({
    suggestion: JSON.stringify(proposal),
    ...(state.appId !== undefined ? { app: state.appId } : {}),
    back: `${location.pathname}${location.search}`,
  });

  return (
    <Card className={`artifact-card schedule-card${resolution === 'declined' ? ' is-declined' : ''}`} data-testid="schedule-card" data-resolution={resolution ?? 'staged'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%', ...(resolution === 'declined' ? { opacity: 0.6 } : {}) }}>
        {/* The provenance line every agent-authored card opens with (the choice card's rule). */}
        <span className="hint">{SCHEDULE_CARD.lead}</span>
        <span className="artifact-name">{proposal.title}</span>
        <ol style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
          {proposal.steps.map((step, index) => (
            <li key={`${state.hash}-${index}`} data-testid={`schedule-card-step-${index}`}>
              {stepWords(step, appName, { withInput: true })}
            </li>
          ))}
        </ol>
        <span className="hint" data-testid="schedule-card-when">
          {describeSpec(proposal.spec)} · {next === undefined ? SCHEDULE_CARD.noNext : SCHEDULE_CARD.next(formatOccurrence(next, zone))}
        </span>
        {consent !== undefined ? (
          <EnableConsent
            steps={proposal.steps}
            spec={proposal.spec}
            now={now}
            appNames={appNames}
            hostsByApp={consent.hosts}
            connectionsByApp={consent.lookUps}
            blockedApps={consent.blocked}
            busy={working}
            {...(error !== undefined ? { error } : {})}
            onEnable={(choice) => void enable(choice)}
            onNotNow={() => setConsent(undefined)}
          />
        ) : resolution === undefined ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <Button variant="primary" onClick={() => void openConsent()} disabled={actsWait} data-testid="schedule-card-accept">
              {SCHEDULE_CARD.accept}
            </Button>
            <Link to={editTo} className="btn" data-testid="schedule-card-edit">
              {SCHEDULE_CARD.edit}
            </Link>
            <Button onClick={() => answer('declined')} disabled={actsWait} data-testid="schedule-card-decline">
              {SCHEDULE_CARD.decline}
            </Button>
          </div>
        ) : (
          <span className="hint" data-testid="schedule-card-outcome">
            {resolution === 'scheduled' ? (
              <>
                {SCHEDULE_CARD.scheduled(nextWords(proposal.spec, now))}{' '}
                {state.taskId !== undefined ? (
                  <Link to={editHref(state.taskId)} data-testid="schedule-card-open">
                    {SCHEDULE_CARD.open}
                  </Link>
                ) : null}
              </>
            ) : resolution === 'declined' ? (
              SCHEDULE_CARD.declined
            ) : (
              SCHEDULE_CARD.stale
            )}
          </span>
        )}
        {consent === undefined && error !== undefined ? (
          <div className="error-note" role="alert" data-testid="schedule-card-error">
            {error}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
