// access/OwnUndoAct.tsx — the undo of ONE own change, wherever it is offered (TASK-20261010-host-
// broker PR-4, D-PR4-18, D-PR4-19; D19, D20): the result page's *changes it made*, the schedule's
// changes list, and the chat's data-write card. The ⋈ sheet's undo (`AccessHistory`) is the model;
// the words are `OWN_UNDO`'s — the sheet's, reused — and only the armed question is its own.
//
// THE TAIL OF A LINE. The caller writes what was changed ("changed 12 rows in Ledger on its own",
// "applied — 2 rows changed") and puts this after its ` · `: *undo* (≥ 44 px, the `Button`'s tap
// floor) while the change can still be undone, else the caller's `ended` words. The first press
// only ARMS: the act gives way to a confirm group named by its question (`role="group"`, the
// question as its label), with *yes, undo* and *keep*, and focus moves to *keep* — the safe
// answer — so a keyboard user lands where nothing happens. *yes* calls `onUndo` ONCE and leaves
// ONE outcome line (*undone*, or the engine's reason in the sheet's words), which takes the focus
// when it renders (the `AccessStrip` outcome line's recipe: focus fell to the page with the button
// it answered). `undone` is the persisted truth — undone earlier, or on another surface — and
// reads *undone* with no act; a line answered HERE keeps its words even after the caller learns
// the same, so the focus it took is never pulled from under it.
//
// At 375 px the confirm stacks below the line it belongs to (`.own-undo` takes the rest of the
// caller's `field-row-wrap` row, and an armed confirm the row's whole width).

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../ui/Button.js';
import { OWN_UNDO } from './copy.js';
import type { UndoOutcome } from './writeBroker.js';

export interface OwnUndoActProps {
  /** The rows the change made — the armed question's count. */
  rows: number;
  /** The app whose rows they are — the armed question's place. */
  appName: string;
  /** The change can still be undone here: its entry is live. */
  offered: boolean;
  /** The act. Absent: the line is read-only — nothing is offered whatever `offered` says. */
  onUndo?: (() => Promise<UndoOutcome>) | undefined;
  /** Undone already (persisted): *undone*, no act. */
  undone?: boolean;
  /** What the tail says when nothing is offered and nothing was undone ("undo ended after seven days"); absent: nothing. */
  ended?: string | undefined;
}

export function OwnUndoAct({ rows, appName, offered, onUndo, undone = false, ended }: OwnUndoActProps): ReactElement {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string; done: boolean } | undefined>(undefined);
  const rootRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  /** Where focus goes on the next commit: *keep* when it arms, the act when *keep* backs out, the line once answered. */
  const focusNext = useRef<'keep' | 'act' | 'line' | undefined>(undefined);

  useEffect(() => {
    const target = focusNext.current;
    if (target === undefined) return;
    if (target === 'line' && (line === undefined || armed)) return;
    focusNext.current = undefined;
    if (target === 'line') lineRef.current?.focus();
    else rootRef.current?.querySelector<HTMLButtonElement>(`[data-own-undo="${target}"]`)?.focus();
  }, [armed, line]);

  const question = OWN_UNDO.arm(rows, appName);

  const arm = (next: boolean): void => {
    focusNext.current = next ? 'keep' : 'act';
    setArmed(next);
  };

  const confirm = async (): Promise<void> => {
    if (onUndo === undefined || busy) return;
    setBusy(true);
    try {
      const answer = await onUndo();
      setLine(answer.ok ? { text: OWN_UNDO.undone, done: true } : { text: OWN_UNDO.failed(answer.reason, appName), done: false });
    } catch {
      // The act never reached the engine: nothing was put back.
      setLine({ text: OWN_UNDO.failed('failed', appName), done: false });
    } finally {
      setBusy(false);
      setArmed(false);
      focusNext.current = 'line';
    }
  };

  const outcome =
    line !== undefined ? (
      <span ref={lineRef} tabIndex={-1} className="hint own-undo-outcome" role="status" data-testid="own-undo-outcome">
        {line.text}
      </span>
    ) : null;

  let tail: ReactElement | null;
  if (line?.done === true) tail = outcome;
  else if (undone) tail = <span className="own-undo-done">{OWN_UNDO.undone}</span>;
  else if (armed) {
    tail = (
      <span className="own-undo-confirm" role="group" aria-label={question} data-testid="own-undo-confirm">
        <span className="hint">{question}</span>
        <Button variant="danger" onClick={() => void confirm()} disabled={busy} data-own-undo="yes">
          {OWN_UNDO.yes}
        </Button>
        <Button variant="ghost" onClick={() => arm(false)} data-own-undo="keep">
          {OWN_UNDO.keep}
        </Button>
      </span>
    );
  } else if (offered && onUndo !== undefined) {
    tail = (
      <>
        <Button variant="ghost" className="own-undo-act" onClick={() => arm(true)} disabled={busy} data-own-undo="act" data-testid="own-undo-act">
          {OWN_UNDO.undo}
        </Button>
        {outcome}
      </>
    );
  } else {
    tail = (
      <>
        {ended !== undefined ? <span className="own-undo-ended">{ended}</span> : null}
        {outcome}
      </>
    );
  }
  return (
    <span ref={rootRef} className="own-undo">
      {tail}
    </span>
  );
}
