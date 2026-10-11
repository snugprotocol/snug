// access/AccessCard.tsx — the brain's ASK card in the chat rail (TASK-20261010-host-broker PR-2
// AC12; ADR-0076 §2; D-PR2-11; DS-2, DS-5, DS-8, DS-9, DS-16; S10). What `access_propose`
// staged on the agent's message — the lead line FIRST (*the agent asks:* — the anti-imitation
// line every model-authored card carries, so a card styled to read like a host surface still
// opens with the one line a host surface never does), then the exact title the sheet its
// *review* opens shows (`CONSENT_SHEET.userTitle` with the THREAD's app's library name), the
// AI's purpose as a text node inside the bidi-isolated `<q>` (the strip's rule: quoted, never
// trusted, never markup), and two acts.
//
// THE CARD IS UI, NEVER A GATE: *review* calls `startUserAsk(<the thread's app>, { ask })` — the
// ONE recipe — which parks the ask anew as the user's, in the AI's words, and opens the host's
// own sheet; only the user's act THERE allows anything. The sheet's answer comes back through
// `settle` and becomes ONE outcome line (`role="status"`, focus taken only when it had fallen
// to the page — the strip's rule), handed to `onResolve`; a dismissal (the yield rule: a network
// or link confirm is up — `'answer-other-first'`) is NOT an answer: the card says so and keeps
// its acts — and the dismissal's own `settle` only returns the acts from the sheet-up phase, so
// whenever it lands it never erases that note (Gate-5 SEC-5). *Not now* answers without asking
// anyone. The CARD NEVER WRITES THE CHAT ROW: the hook
// that staged it persists the answer and patches its message (the schedule card's path); with no
// `onResolve`, or while the turn is in flight, the acts wait.
//
// THE THREAD'S APP IS THE ADDRESS (S10): the app, its name and the review all come from the
// thread row, never from the card; a card whose app is not the thread's is stale. THE ROW IS THE
// TRUTH on a remount (`readAccessCardRow`). Mounted by `ChatLog` under the agent's message, in
// both chats, where the host allows access between apps.

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import { readAccessCardRow, type AccessCardResolution, type AccessCardState } from '../agent/accessCard.js';
import { getUserDb } from '../state/userdb.js';
import '../theme/access.css';
import { Card } from '../ui/Card.js';
import type { ConsentOutcome } from './consent.js';
import { ACCESS_CARD, CONSENT_SHEET, CONSENT_UI, STRIP_OUTCOME } from './copy.js';
import { startUserAsk } from './userAsk.js';

/**
 * The resolve path the chat hook hands `ChatLog` (`onResolveAccess`): the card as rendered (its
 * thread and row ids), the message it sits on, and the answer. The hook persists it; the card
 * only reports it.
 */
export type ResolveAccessCard = (card: AccessCardState, messageId: number, resolution: AccessCardResolution) => void;

export interface AccessCardProps {
  card: AccessCardState;
  /** The chat message the card sits on — what the hook keys its persist on. */
  messageId: number;
  /** The turn is in flight: the row does not exist yet, so an answer could not persist — the acts wait. */
  busy: boolean;
  /** Absent ⇒ the acts render disabled: an answer with nowhere to go asks nobody. */
  onResolve?: ResolveAccessCard | undefined;
}

/** The card's own phase around the sheet: idle, the sheet is up, or another question must be answered first. */
type Phase = 'idle' | 'waiting' | 'answer-other-first';

/** The sheet's outcome as the card records it — or nothing, when it was no answer (B-Q3). */
function resolutionOf(outcome: ConsentOutcome): AccessCardResolution | undefined {
  switch (outcome.kind) {
    case 'allowed':
      return { kind: 'allowed', sourceName: outcome.sourceName, tables: outcome.tables, duration: outcome.duration };
    case 'not-now':
      return { kind: 'not-now' };
    case 'declined':
      return { kind: 'declined' };
    case 'failed':
      return { kind: 'failed' };
    case 'dismissed':
    case 'muted':
      return undefined;
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

function OutcomeLine({ resolution, readerName }: { resolution: AccessCardResolution; readerName: string }): ReactElement {
  const lineRef = useRef<HTMLDivElement>(null);

  // Focus fell to the page with the acts it answered: the line catches it (the strip's rule).
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) lineRef.current?.focus();
  }, []);

  const words = ((): string => {
    switch (resolution.kind) {
      case 'allowed':
        return STRIP_OUTCOME.allowed(readerName, resolution.sourceName, resolution.tables, resolution.duration);
      case 'not-now':
        return ACCESS_CARD.notNowLine;
      case 'declined':
        return ACCESS_CARD.declined;
      case 'failed':
        return CONSENT_UI.nothingAllowed;
      default: {
        const never: never = resolution;
        return never;
      }
    }
  })();

  return (
    <div ref={lineRef} tabIndex={-1} className="hint" role="status" data-testid="access-card-outcome" data-outcome={resolution.kind}>
      {words}
    </div>
  );
}

export function AccessCard({ card, messageId, busy, onResolve }: AccessCardProps): ReactElement {
  const [state, setState] = useState<AccessCardState>(card);
  /** The THREAD's app — the address of the ask; `null` once read and found gone (or not the card's). */
  const [thread, setThread] = useState<{ appId: string; name: string } | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const stateRef = useRef(state);
  stateRef.current = state;

  // The row id lands after the turn finalizes; a resolution the hook rehydrated is adopted once.
  useEffect(() => {
    setState((current) => ({
      ...current,
      ...(card.messageRowId !== undefined ? { messageRowId: card.messageRowId } : {}),
      ...(card.resolution !== undefined && current.resolution === undefined ? { resolution: card.resolution } : {}),
    }));
  }, [card.messageRowId, card.resolution]);

  // THE THREAD'S APP IS THE ADDRESS (S10), and THE ROW IS THE TRUTH: one read names the app from
  // the thread row, notices a card that is not the thread's, and adopts an answer given elsewhere.
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const pinned = db.getThread(card.threadId)?.appId;
      const app = pinned === undefined ? undefined : db.getApp(pinned);
      setThread(app === undefined || pinned !== card.appId ? null : { appId: app.appId, name: app.displayName });
      if (card.messageRowId === undefined) return;
      const row = readAccessCardRow(db, card.threadId, card.messageRowId);
      const answered = row?.resolution;
      if (answered === undefined) return;
      setState((current) => (current.resolution === undefined ? { ...current, resolution: answered } : current));
    });
    return () => {
      cancelled = true;
    };
  }, [card.appId, card.messageRowId, card.threadId]);

  const stale = thread === null;
  /** No row yet, no path to persist an answer, no app to ask for, or the sheet is up: the acts wait. */
  const actsWait = busy || onResolve === undefined || thread === undefined || stale || phase === 'waiting';

  /** Record the answer here and hand it to the hook — the one place it is persisted. */
  const answer = (resolution: AccessCardResolution): void => {
    setPhase('idle');
    setState((current) => ({ ...current, resolution }));
    onResolve?.(stateRef.current, messageId, resolution);
  };

  /** The sheet's answer, through the pending's `settle`: an outcome, or no answer at all. */
  const settle = (outcome: ConsentOutcome): void => {
    const resolution = resolutionOf(outcome);
    if (resolution === undefined) {
      // No answer: the acts come back only from the sheet-up phase — a dismissal under the
      // yield rule may land after `review` wrote 'answer-other-first', and that note stands.
      setPhase((current) => (current === 'waiting' ? 'idle' : current));
      return;
    }
    answer(resolution);
  };

  const review = async (): Promise<void> => {
    if (actsWait || thread === undefined || thread === null) return;
    setPhase('waiting');
    const current = stateRef.current;
    const came = await startUserAsk(thread.appId, {
      ask: { purpose: current.purpose, ...(current.hints !== undefined ? { hints: current.hints } : {}), settle },
    });
    if (came === 'opened') return;
    if (came === 'no-app') {
      setThread(null);
      setPhase('idle');
      return;
    }
    setPhase('answer-other-first');
  };

  const readerName = thread?.name ?? '';
  const { resolution } = state;

  return (
    <Card className="artifact-card access-card" data-testid="access-card" data-resolution={resolution?.kind ?? (stale ? 'stale' : 'staged')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
        <span className="hint">{ACCESS_CARD.lead}</span>
        {thread !== undefined && thread !== null ? <span className="artifact-name">{CONSENT_SHEET.userTitle(thread.name)}</span> : null}
        <q className="access-quote" data-testid="access-card-quote">
          {CONSENT_SHEET.quote(state.purpose)}
        </q>
        {resolution !== undefined ? (
          <OutcomeLine key={resolution.kind} resolution={resolution} readerName={readerName} />
        ) : stale ? (
          <span className="hint" data-testid="access-card-stale">
            {ACCESS_CARD.stale}
          </span>
        ) : (
          <>
            {phase === 'answer-other-first' ? (
              <span className="hint" data-testid="access-card-note">
                {CONSENT_UI.answerOtherFirst}
              </span>
            ) : phase === 'waiting' ? (
              <span className="hint" data-testid="access-card-note">
                {ACCESS_CARD.waiting}
              </span>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <button type="button" className="btn btn-primary" onClick={() => void review()} disabled={actsWait} data-testid="access-card-review">
                {ACCESS_CARD.review}
              </button>
              <button type="button" className="btn" onClick={() => answer({ kind: 'not-now' })} disabled={actsWait} data-testid="access-card-not-now">
                {ACCESS_CARD.notNow}
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
