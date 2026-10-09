// schedule/SuggestionStrip.tsx — "<app> suggests: <when>" in the run header's strip slot
// (TASK-20261009 P3; ADR-0074 §4; design F2: a STRIP, never a modal). Renders the pending
// suggestion `scheduleRequest.ts` accepted for this app — the app's name, the when in words,
// the steps in words — with three acts: *schedule it* opens the ONE consent surface inside the
// strip (U8) and the user's act there calls the one writer; *not now* records the decline (two
// mute the app); *stop suggestions from this app* mutes it at once. After the act the strip
// says what happened in one line — scheduled with the next time (and *open*), declined, or
// muted — and nothing runs until the consent said so.
//
// `.connection-note.is-strip`, like "your agent updated this app" (K6), which it is ranked
// after in `RunView`: the strip costs the app a strip of height and none of its width.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { ScheduleStep } from '@snugprotocol/protocol';

import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';
import { SUGGESTION_ACTIONS, SUGGESTION_OUTCOME, stepWords, suggestionStrip } from './copy.js';
import { describeSpec } from './cron.js';
import { approvedHostsByApp } from './editorModel.js';
import { EnableConsent } from './EnableConsent.js';
import { nextWords, pageClock, useNow } from './pageModel.js';
import { editHref } from './routes.js';
import { acceptSuggestion, declineSuggestion, muteSuggestions, suggestionStore } from './scheduleRequest.js';

export interface SuggestionStripProps {
  appId: string;
}

/** The steps in words, one line: "remind me: Water — the ferns · run Weather" — each step through `copy.stepWords` (M6). */
export function suggestionStepsLine(steps: readonly ScheduleStep[], appName: string): string {
  return steps.map((step) => stepWords(step, appName)).join(' · ');
}

type Outcome = { kind: 'scheduled'; whenWords: string; taskId: string } | { kind: 'declined' } | { kind: 'muted'; appName: string };

export function SuggestionStrip({ appId }: SuggestionStripProps): ReactElement | null {
  const pending = useStore(suggestionStore)[appId];
  const [consent, setConsent] = useState<Record<string, string[]> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const now = useNow();

  // A new suggestion replaces the last outcome line; leaving the app clears both with the mount.
  useEffect(() => {
    if (pending !== undefined) {
      setOutcome(undefined);
      setConsent(undefined);
      setError(undefined);
    }
  }, [pending]);

  if (pending === undefined) {
    if (outcome === undefined) return null;
    return (
      <div className="connection-note is-strip" role="status" data-testid="schedule-suggestion-outcome" data-outcome={outcome.kind}>
        <div className="connection-note-lead">
          <p className="connection-note-title">
            {outcome.kind === 'scheduled' ? (
              <>
                {SUGGESTION_OUTCOME.scheduled(outcome.whenWords)}{' '}
                <Link to={editHref(outcome.taskId)} data-testid="schedule-suggestion-open">
                  {SUGGESTION_OUTCOME.open}
                </Link>
              </>
            ) : outcome.kind === 'declined' ? (
              SUGGESTION_OUTCOME.declined
            ) : (
              SUGGESTION_OUTCOME.muted(outcome.appName)
            )}
          </p>
        </div>
      </div>
    );
  }

  const { proposal, appName } = pending;
  const openConsent = async (): Promise<void> => {
    const db = await getUserDb();
    setError(undefined);
    setConsent(approvedHostsByApp(db, [appId]));
  };
  const enable = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await acceptSuggestion(appId);
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setConsent(undefined);
    setOutcome({ kind: 'scheduled', whenWords: nextWords(result.task.spec, pageClock.now(), new Date(result.task.createdAt)), taskId: result.task.id });
  };
  const decline = async (): Promise<void> => {
    const answer = await declineSuggestion(appId);
    setOutcome(answer === 'muted' ? { kind: 'muted', appName } : { kind: 'declined' });
  };
  const mute = async (): Promise<void> => {
    await muteSuggestions(appId);
    setOutcome({ kind: 'muted', appName });
  };

  return (
    <div className="connection-note is-strip" role="status" data-testid="schedule-suggestion" data-app={appId}>
      <div className="connection-note-lead">
        <p className="connection-note-title" data-testid="schedule-suggestion-title">
          {suggestionStrip(appName, describeSpec(proposal.spec))}
        </p>
        <p className="connection-note-body" data-testid="schedule-suggestion-steps">
          {suggestionStepsLine(proposal.steps, appName)}
        </p>
      </div>
      {consent !== undefined ? (
        <EnableConsent
          steps={proposal.steps}
          spec={proposal.spec}
          now={now}
          appNames={{ [appId]: appName }}
          hostsByApp={consent}
          busy={busy}
          {...(error !== undefined ? { error } : {})}
          onEnable={() => void enable()}
          onNotNow={() => setConsent(undefined)}
        />
      ) : (
        <div className="connection-note-actions">
          <Button variant="primary" onClick={() => void openConsent()} data-testid="schedule-suggestion-accept">
            {SUGGESTION_ACTIONS.accept}
          </Button>
          <Button variant="ghost" onClick={() => void decline()} data-testid="schedule-suggestion-decline">
            {SUGGESTION_ACTIONS.decline}
          </Button>
          <Button variant="ghost" onClick={() => void mute()} data-testid="schedule-suggestion-mute">
            {SUGGESTION_ACTIONS.mute}
          </Button>
        </div>
      )}
    </div>
  );
}
