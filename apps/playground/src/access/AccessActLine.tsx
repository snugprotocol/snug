// access/AccessActLine.tsx — every ask started from host chrome has a VISIBLE outcome
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-6a, D-PR5-4; D1, D3; v2.1 TB-Q5, TB-Q21).
//
// THE ACT LINE (`AccessActLine`): `role="status"`, focusable (`tabIndex={-1}`), taking focus when
// the act that started the ask has unmounted and focus fell to the page with it. Mounted beside
// the Hub tile's *could read…*, under Settings' pairs and under the reader sheet's pair act and
// the source's offer. For this visit it says how the ask settled: allowed →
// `STRIP_OUTCOME.allowed(…)` with *stop* (then what *stop* came to); a declared-form *don't allow*
// → `STRIP_OUTCOME.wontAskAgain`; not offered → `excludedFooter`; another question first →
// `CONSENT_UI.answerOtherFirst`; a failure → `failedWords`. *not now* or a dismissal says nothing —
// focus goes back to the act.
//
// WHY THE SURFACE OWNS THE SETTLE (`useAccessAct`), NOT THE LINE. The act often disappears BECAUSE
// of its answer — an allowed pair is no pair any more, so its row, its tile button, its sheet act
// go — and the line must outlive it. The surface keeps the settle where the act's removal cannot
// take it (the tile, the Settings section, the sheet's reads direction) and hands it to the line.
// The settle is heard through the ask's own `settle` (userAsk.ts), never the strip's outcome
// store: the strip records no line for a person's *don't allow* (outcome.ts `worthALine`).
//
// THE PAIR ACT (`AccessPairAct`): the reader's best pair on its own ⋈ sheet, under *Budget reads*,
// above the creation act — the declared ask pinned to that source. The sheet closes only once the
// ask is sure to open (`beforeOpen`, inside `flushSync` so the sheet is gone before the review
// mounts — otherwise its closing would hand focus back to the ⋈ from under the review); a refusal
// keeps it up, saying why.
//
// `isolateNames` puts an app's name back into a host sentence inside a `<bdi>` (D-PR5-7): the
// words stay copy.ts's, and a right-to-left name can never reorder them.

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '../ui/Button.js';
import type { ConsentOutcome } from './consent.js';
import { ACCESS_SHEET, CONSENT_UI, STRIP_OUTCOME, excludedFooter, failedWords } from './copy.js';
import { revokeAccess } from './grants.js';
import type { ExcludedReason, PairSuggestion } from './relevance.js';
import { startUserAsk, type UserAskOptions } from './userAsk.js';

type AllowedOutcome = Extract<ConsentOutcome, { kind: 'allowed' }>;

/** How an ask from host chrome settled, as its line says it. */
export type AccessActSettle =
  | { kind: 'allowed'; outcome: AllowedOutcome }
  /** *stop* on the allowed line ended it. */
  | { kind: 'stopped'; outcome: AllowedOutcome }
  | { kind: 'declined' }
  | { kind: 'not-offered'; sourceName: string; reason: ExcludedReason | 'gone' }
  | { kind: 'answer-other-first' }
  | { kind: 'failed'; message: string };

// ----------------------------------------------------------------------------- the names

/**
 * A host sentence with the app NAMES it carries bidi-isolated: `words` is called with a mark in
 * place of each name — a NUL-fenced index, which no copy sentence holds — and each mark comes back
 * as a `<bdi>` holding the name.
 */
export function isolateNames(words: (...names: string[]) => string, ...names: string[]): ReactNode[] {
  const sentence = words(...names.map((_, index) => `\u0000${index}\u0000`));
  return sentence.split(/\u0000(\d+)\u0000/).map((part, index) => (index % 2 === 1 ? <bdi key={index}>{names[Number(part)]}</bdi> : part));
}

// --------------------------------------------------------------------------- the settle

/** A surface's act: the settle its line says, and how it starts the person's ask. */
export interface AccessAct {
  settle: AccessActSettle | undefined;
  setSettle: (next: AccessActSettle) => void;
  /**
   * Start the person's ask for `readerAppId` (a PR-5 form). `sourceName` names a source the sheet
   * could not offer; `trigger` gets focus back when the answer is *not now* or a dismissal.
   */
  start: (readerAppId: string, opts: Omit<UserAskOptions, 'settle'>, sourceName: string, trigger: HTMLElement | null) => Promise<void>;
}

export function useAccessAct(): AccessAct {
  const [settle, setSettle] = useState<AccessActSettle | undefined>(undefined);
  const start = useCallback(async (readerAppId: string, opts: Omit<UserAskOptions, 'settle'>, sourceName: string, trigger: HTMLElement | null): Promise<void> => {
    setSettle(undefined);
    const heard = (outcome: ConsentOutcome): void => {
      switch (outcome.kind) {
        case 'allowed':
          setSettle({ kind: 'allowed', outcome });
          return;
        case 'declined':
          setSettle({ kind: 'declined' });
          return;
        case 'failed':
          setSettle({ kind: 'failed', message: outcome.message });
          return;
        case 'not-now':
        case 'dismissed':
        case 'muted':
          // No line: the person is back where they asked from.
          if (trigger?.isConnected === true) trigger.focus();
          return;
      }
    };
    const answer = await startUserAsk(readerAppId, { ...opts, settle: heard });
    if (answer === 'opened') return;
    if (answer === 'answer-other-first' || (typeof answer === 'object' && answer.kind === 'answer-other-first')) {
      setSettle({ kind: 'answer-other-first' });
      return;
    }
    // `'no-app'`: the app that would read is gone — nothing could be offered.
    setSettle({ kind: 'not-offered', sourceName, reason: answer === 'no-app' ? 'gone' : answer.reason });
  }, []);
  return { settle, setSettle, start };
}

// ------------------------------------------------------------------------------- the line

export interface AccessActLineProps {
  /** The app that would read — the allowed and declined lines name it. */
  readerName: string;
  /** Nothing yet (or *not now*): no line. */
  settle: AccessActSettle | undefined;
  /** What *stop* on the allowed line came to — the surface keeps it. */
  onSettle: (next: AccessActSettle) => void;
  /** The act that started the ask is gone: the line catches focus that fell to the page with it. */
  triggerGone?: boolean;
}

export function AccessActLine({ readerName, settle, onSettle, triggerGone = false }: AccessActLineProps): ReactElement | null {
  const lineRef = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState(false);
  const shown = settle !== undefined;

  useEffect(() => {
    if (!shown || !triggerGone) return;
    const active = document.activeElement;
    if (active === null || active === document.body) lineRef.current?.focus();
  }, [shown, triggerGone]);

  if (settle === undefined) return null;

  const stop = async (outcome: AllowedOutcome): Promise<void> => {
    setStopping(true);
    try {
      await revokeAccess(outcome.grantId);
      onSettle({ kind: 'stopped', outcome });
    } finally {
      setStopping(false);
    }
  };

  const words = ((): ReactNode => {
    switch (settle.kind) {
      case 'allowed': {
        const { outcome } = settle;
        return (
          <>
            {STRIP_OUTCOME.allowed(readerName, outcome.sourceName, outcome.tables, outcome.duration, outcome.write, { notChange: outcome.notChange === true })}
            {' · '}
            <Button variant="ghost" disabled={stopping} onClick={() => void stop(outcome)}>
              {STRIP_OUTCOME.undo}
            </Button>
          </>
        );
      }
      case 'stopped':
        return CONSENT_UI.stopped(readerName, settle.outcome.sourceName, settle.outcome.tables, settle.outcome.write);
      case 'declined':
        return STRIP_OUTCOME.wontAskAgain(readerName);
      case 'not-offered':
        // `gone` — the want or the app went between the listing and the tap — has no footer clause: nothing was allowed.
        return settle.reason === 'gone' ? CONSENT_UI.changedSince : excludedFooter([{ displayName: settle.sourceName, reason: settle.reason }]);
      case 'answer-other-first':
        return CONSENT_UI.answerOtherFirst;
      case 'failed':
        return failedWords(settle.message);
    }
  })();

  return (
    <div ref={lineRef} tabIndex={-1} className="hint access-act-line" role="status" data-testid="access-act-line" data-outcome={settle.kind}>
      {words}
    </div>
  );
}

// --------------------------------------------------------------------------- the pair act

export interface AccessPairActProps {
  readerAppId: string;
  readerName: string;
  /** The reader's best pair — absent when it has none (its line may still say how the last one went). */
  pair: PairSuggestion | undefined;
  /** The sheet closes first, so the review is the only sheet on screen — unless the ask is not offered, which keeps it up. */
  onBeforeAsk: () => void;
}

export function AccessPairAct({ readerAppId, readerName, pair, onBeforeAsk }: AccessPairActProps): ReactElement | null {
  const act = useAccessAct();
  if (pair === undefined && act.settle === undefined) return null;
  return (
    <div className="access-sheet-create">
      {pair !== undefined ? (
        <Button
          variant="ghost"
          data-testid="access-pair"
          aria-label={ACCESS_SHEET.pairName(readerName, pair.sourceName, pair.matchedTables)}
          onClick={(event) =>
            void act.start(
              readerAppId,
              { declared: pair.want, source: pair.sourceAppId, beforeOpen: () => flushSync(onBeforeAsk) },
              pair.sourceName,
              event.currentTarget,
            )
          }
        >
          {isolateNames((source) => ACCESS_SHEET.pair(source, pair.matchedTables), pair.sourceName)}
        </Button>
      ) : null}
      <AccessActLine readerName={readerName} settle={act.settle} onSettle={act.setSettle} triggerGone={pair === undefined} />
    </div>
  );
}
