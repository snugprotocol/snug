// access/AccessStrip.tsx — "<app> wants to read another app's data" above the asking app's frame
// (TASK-20261010-cross-app-access AC18; ADR-0074 §4 — an app's ask is a STRIP, never a modal;
// D12 — three distinct acts; the schedule's SuggestionStrip is the precedent).
//
// The strip renders the reader's ONE pending app ask from `pendingAccessStore`: its library name,
// "<app> says:" with the purpose as a quoted text node in a bidi-isolated `<q>`, and three acts —
// *review* opens the consent sheet (a user act on host chrome; refused while a network or link
// confirm is open, and then the strip says so), *not now* records nothing, *stop asking* mutes.
// An ask the USER started (provenance `user`) has no strip: its sheet is already open.
//
// After the act, ONE outcome line for this visit (`data-outcome`): `allowed` (with *stop* as the
// undo — `revokeAccess`), `not-now`, `declined` (*don't allow* on the sheet), `muted`, `failed`,
// and `stopped` after the undo. The sheet answers through the same `answerAccess` (outcome.ts, the
// leaf both import), so an allow made there lands here as the line. A failure is said through
// `failedWords`: the engine's own reason, or one fixed sentence — never a file's raw refusal.
//
// FOCUS. An answer removes the ask, and *review* — the element focus would go back to — with
// it. The outcome line is therefore focusable (`tabIndex=-1`) and takes focus when it appears
// while focus has fallen to the page (`<body>`), so a keyboard user's next Tab starts here, not
// at the top of the page. Focus that sits anywhere else is left alone.

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import { netConfirmStore } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { useStore } from '../state/store.js';
import '../theme/access.css';
import { Button } from '../ui/Button.js';
import { openReview, pendingAccessStore } from './consent.js';
import { CONSENT_UI, STRIP, STRIP_OUTCOME, failedWords } from './copy.js';
import { revokeAccess } from './grants.js';
import { accessOutcomeStore, answerAccess, lastOutcomeSeq, recordOutcome, type RecordedOutcome } from './outcome.js';

// ------------------------------------------------------------------------------------ the strip

export interface AccessStripProps {
  appId: string;
}

function OutcomeLine({ appId, recorded }: { appId: string; recorded: RecordedOutcome }): ReactElement | null {
  const { readerName, outcome } = recorded;
  const [stopping, setStopping] = useState(false);
  const lineRef = useRef<HTMLDivElement>(null);

  // Focus fell to the page with the ask it answered (*review* is gone): the line catches it.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) lineRef.current?.focus();
  }, []);

  const undo = async (grantId: string, sourceName: string, tables: string[]): Promise<void> => {
    setStopping(true);
    await revokeAccess(grantId);
    recordOutcome(appId, readerName, { kind: 'stopped', sourceName, tables });
  };

  const words = ((): ReactElement | string | null => {
    switch (outcome.kind) {
      case 'allowed':
        return (
          <>
            <span data-testid="access-ask-outcome-words">{STRIP_OUTCOME.allowed(readerName, outcome.sourceName, outcome.tables, outcome.duration)}</span>
            {' · '}
            <Button variant="ghost" disabled={stopping} data-testid="access-ask-undo" onClick={() => void undo(outcome.grantId, outcome.sourceName, outcome.tables)}>
              {STRIP_OUTCOME.undo}
            </Button>
          </>
        );
      case 'stopped':
        return CONSENT_UI.stopped(readerName, outcome.sourceName, outcome.tables);
      case 'not-now':
        return STRIP_OUTCOME.notNow(readerName);
      case 'declined':
        return STRIP_OUTCOME.wontAskAgain(readerName);
      case 'muted':
        return STRIP_OUTCOME.muted(readerName);
      case 'failed':
        return failedWords(outcome.message);
      case 'dismissed':
        return null;
      default: {
        const never: never = outcome;
        return never;
      }
    }
  })();
  if (words === null) return null;

  return (
    <div ref={lineRef} tabIndex={-1} className="connection-note is-strip" role="status" data-testid="access-ask-outcome" data-outcome={outcome.kind} data-app={appId}>
      <div className="connection-note-lead">
        <p className="connection-note-title">{words}</p>
      </div>
    </div>
  );
}

export function AccessStrip({ appId }: AccessStripProps): ReactElement | null {
  const pending = useStore(pendingAccessStore)[appId];
  const recorded = useStore(accessOutcomeStore)[appId];
  // Subscribed so the "answer that first" note clears the moment the other confirm does.
  const netPending = useStore(netConfirmStore);
  const openUrlPending = useStore(openUrlConfirmStore);
  const [since, setSince] = useState(lastOutcomeSeq);
  const [waiting, setWaiting] = useState(false);

  // A new ask replaces the last outcome line (the SuggestionStrip rule).
  useEffect(() => {
    if (pending !== undefined) {
      setSince(lastOutcomeSeq());
      setWaiting(false);
    }
  }, [pending]);

  if (pending === undefined || pending.provenance !== 'app') {
    if (recorded === undefined || recorded.seq <= since) return null;
    return <OutcomeLine key={recorded.seq} appId={appId} recorded={recorded} />;
  }

  const review = (): void => {
    setWaiting(!openReview(appId));
  };
  const blocked = waiting && (netPending !== null || openUrlPending !== null);

  return (
    <div className="connection-note is-strip" role="status" data-testid="access-ask" data-app={appId}>
      <div className="connection-note-lead">
        <p className="connection-note-title" data-testid="access-ask-title">
          {STRIP.title(pending.readerName)}
        </p>
        <p className="connection-note-body access-strip-says" data-testid="access-ask-says">
          {STRIP.says(pending.readerName)}{' '}
          <q className="access-quote" data-testid="access-ask-quote">
            {STRIP.quote(pending.purpose)}
          </q>
        </p>
      </div>
      <div className="connection-note-actions">
        <Button variant="primary" onClick={review} data-testid="access-ask-review">
          {STRIP.review}
        </Button>
        <Button variant="ghost" onClick={() => void answerAccess(pending, { kind: 'not-now' })} data-testid="access-ask-not-now">
          {STRIP.notNow}
        </Button>
        <Button variant="ghost" onClick={() => void answerAccess(pending, { kind: 'stop-asking' })} data-testid="access-ask-stop-asking">
          {STRIP.stopAsking}
        </Button>
      </div>
      {blocked ? (
        <p className="connection-note-body access-strip-wait" data-testid="access-ask-wait">
          {CONSENT_UI.answerOtherFirst}
        </p>
      ) : null}
    </div>
  );
}
