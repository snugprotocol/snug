// access/AccessHistory.tsx — the SOURCE's history, in words (TASK-20261010-cross-app-access AC19;
// ADR-0075 §6; Q14, D15). The host keeps it on the source's own row; this renders it on the
// source's ⋈ sheet.
//
// Each row is WHO, then the copy module's `historyLine` ("read transactions · 412 rows · 2 min
// ago · while you were here"); a read that carries its statement keeps it behind a *what it
// asked* disclosure — the statement is the reading app's text, so it is a text node in a <code>,
// never markup. Entries that arrived with an imported file sit under their own heading (AC10: the
// user did not see them happen here). When nothing has been read, changed or fetched yet the
// history says so, beside the lines that record when access began or ended.
//
// TASK-20261010-host-broker PR-3 (ADR-0076 §5; D-PR3-6/24; DS7, DS12, DS14, S18; contract v2.1
// U-Q1, U-Q2, U-Q9, U-Q10, U-Q17; E1-Q2): the `wrote`, `undone` and `refreshed` rows.
//   - THE WHO: the reader's name for an act of the app, its chat or a schedule; "you" for the
//     user's own act from host chrome (`via: 'user'` — an undo), where the reader's name moves
//     INTO the sentence (`historyLine` is handed the row's reader and the sheet's app).
//   - A `wrote` row keeps its statement behind *what it changed* (the `whatItAsked` twin).
//   - *UNDO* (`access-history-undo`) on a `wrote` row whose journal entry is LIVE (`undoable`,
//     from the sheet's `listAccessUndo`), behind the inline armed confirm the Settings card's
//     *clear history* uses (`access-undo-confirm`, a named group: the question, *yes, undo*,
//     *keep*) — the first press only arms; *yes* calls `onUndo` ONCE and leaves ONE outcome line
//     (`access-history-undo-outcome`): *undone*, or the engine's reason worded by copy.ts. A
//     `wrote` row whose entry is gone, and every other kind, offers nothing — an undo is never
//     itself undoable. The act is the sheet's (host chrome): this component only shows it. Focus
//     fell to the page with the confirm it answered (*yes, undo* is gone): the outcome line is
//     focusable (`tabIndex=-1`) and catches it once rendered — the `AccessStrip` outcome line's
//     recipe (Gate-5 UI-2).

import type { ReactElement } from 'react';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { AccessLogEntry } from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { ACCESS_SHEET, historyLine, type UndoFailureReason } from './copy.js';

/** What the undo act answers (E1-Q2): done, or why not — the engine's token, worded here by copy.ts; its own message is the same sentence. */
export type UndoOutcome = { ok: true } | { ok: false; reason: UndoFailureReason; message: string };

/** The one outcome line, kept on the row it answers. */
interface UndoLine {
  undoId: string;
  text: string;
}

interface UndoState {
  /** The `undoId` whose confirm is armed. */
  armed: string | undefined;
  arm: (undoId: string | undefined) => void;
  busy: boolean;
  confirm: (undoId: string) => void;
  line: UndoLine | undefined;
  /** The one outcome line's element, so focus can land on it (UI-2). */
  lineRef: RefObject<HTMLParagraphElement>;
}

interface HistoryRowsProps {
  entries: readonly AccessLogEntry[];
  now: number;
  sourceName: string;
  /** Whether a `wrote` row's entry may be undone here. */
  offersUndo: (entry: AccessLogEntry) => boolean;
  undo: UndoState;
}

function HistoryRows({ entries, now, sourceName, offersUndo, undo }: HistoryRowsProps): ReactElement {
  return (
    <ul className="access-history-list">
      {entries.map((entry, index) => {
        const undoId = entry.kind === 'wrote' && offersUndo(entry) ? entry.undoId : undefined;
        return (
          <li key={`${entry.at}-${entry.grantId}-${entry.kind}-${index}`} className="access-history-row" data-testid="access-history-row" data-kind={entry.kind}>
            <span className="access-history-who" data-testid="access-history-who">
              {/* The user's own act is theirs (DS7); the sentence then names the app. */}
              {entry.via === 'user' ? ACCESS_SHEET.you : entry.readerName}
            </span>{' '}
            <span className="access-history-words" data-testid="access-history-words">
              {historyLine(entry, now, entry.readerName, sourceName)}
            </span>
            {entry.sql !== undefined ? (
              <details className="access-history-asked" data-testid="access-history-asked">
                <summary>{entry.kind === 'wrote' ? ACCESS_SHEET.whatItChanged : ACCESS_SHEET.whatItAsked}</summary>
                <code className="access-history-sql">{entry.sql}</code>
              </details>
            ) : null}
            {undoId !== undefined ? (
              undo.armed === undoId ? (
                <div className="access-confirm" role="group" aria-label={ACCESS_SHEET.undo} data-testid="access-undo-confirm">
                  <span className="hint">{ACCESS_SHEET.undoArm(entry.tables?.[0] ?? '', entry.changes ?? 0, sourceName)}</span>
                  <Button variant="danger" onClick={() => undo.confirm(undoId)} disabled={undo.busy} data-testid="access-undo-yes">
                    {ACCESS_SHEET.undoYes}
                  </Button>
                  <Button variant="ghost" onClick={() => undo.arm(undefined)} data-testid="access-undo-keep">
                    {ACCESS_SHEET.undoKeep}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" className="access-history-undo" onClick={() => undo.arm(undoId)} disabled={undo.busy} data-testid="access-history-undo">
                  {ACCESS_SHEET.undo}
                </Button>
              )
            ) : null}
            {undo.line !== undefined && undo.line.undoId === entry.undoId && entry.kind === 'wrote' ? (
              <p ref={undo.lineRef} tabIndex={-1} className="hint access-undo-outcome" role="status" data-testid="access-history-undo-outcome">
                {undo.line.text}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface AccessHistoryProps {
  /** The source's history, newest first (the db's order). */
  entries: readonly AccessLogEntry[];
  now: number;
  /** The sheet's app — the source whose history this is; the undo question and the `refreshed` line name it. */
  sourceName: string;
  /** The ids of the journal entries that are LIVE: a `wrote` row whose `undoId` is among them offers *undo*. Absent: none does. */
  undoable?: ReadonlySet<string>;
  /** The undo act — host chrome's, carried out by the sheet. Absent: no row offers it. */
  onUndo?: (undoId: string) => Promise<UndoOutcome>;
}

/** Whether a row's words count as something that happened: a read, a change or a fetch (DS21). */
const isEvent = (entry: AccessLogEntry): boolean => entry.kind === 'read' || entry.kind === 'wrote' || entry.kind === 'refreshed';

export function AccessHistory({ entries, now, sourceName, undoable, onUndo }: AccessHistoryProps): ReactElement {
  const [armed, setArmed] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<UndoLine | undefined>(undefined);
  const lineRef = useRef<HTMLParagraphElement>(null);
  /** Set by `confirm` once it has answered: the next commit that shows the line unarmed moves focus to it (UI-2). */
  const focusLine = useRef(false);

  // Focus fell to the page with the confirm it answered (*yes, undo* is gone with the arm): the
  // outcome line catches it — on the commit that rendered it and unarmed the row, whether React
  // batched the two updates into one commit or not.
  useEffect(() => {
    if (!focusLine.current || line === undefined || armed !== undefined) return;
    focusLine.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) lineRef.current?.focus();
  }, [line, armed]);

  const here = entries.filter((entry) => entry.imported !== true);
  const imported = entries.filter((entry) => entry.imported === true);
  const nothingYet = !here.some(isEvent);

  const offersUndo = (entry: AccessLogEntry): boolean => onUndo !== undefined && undoable !== undefined && entry.undoId !== undefined && undoable.has(entry.undoId);

  const confirm = async (undoId: string): Promise<void> => {
    if (onUndo === undefined) return;
    setBusy(true);
    try {
      const answer = await onUndo(undoId);
      setLine({ undoId, text: answer.ok ? ACCESS_SHEET.undone : ACCESS_SHEET.undoFailed(answer.reason, sourceName) });
    } catch {
      // The act never reached the engine: nothing was put back.
      setLine({ undoId, text: ACCESS_SHEET.undoFailed('failed', sourceName) });
    } finally {
      setBusy(false);
      setArmed(undefined);
      focusLine.current = true;
    }
  };

  const undo: UndoState = { armed, arm: setArmed, busy, confirm: (undoId) => void confirm(undoId), line, lineRef };

  return (
    <section className="access-sheet-section access-history" data-testid="access-history">
      <h3 className="access-sheet-section-title">{ACCESS_SHEET.history}</h3>
      {nothingYet ? (
        <p className="hint" data-testid="access-history-empty">
          {ACCESS_SHEET.noHistory}
        </p>
      ) : null}
      {here.length > 0 ? <HistoryRows entries={here} now={now} sourceName={sourceName} offersUndo={offersUndo} undo={undo} /> : null}
      {imported.length > 0 ? (
        <div className="access-history-imported" data-testid="access-history-imported">
          <h4 className="access-sheet-subtitle">{ACCESS_SHEET.historyImported}</h4>
          <HistoryRows entries={imported} now={now} sourceName={sourceName} offersUndo={offersUndo} undo={undo} />
        </div>
      ) : null}
    </section>
  );
}
