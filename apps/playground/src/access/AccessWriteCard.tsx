// access/AccessWriteCard.tsx — the chat's card for a change to ANOTHER app's table
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-14, D-PR5-14a and its v2.1 answer TC-Q11;
// D8, D9, F15, SC14), rendered by `views/ChatLog.tsx` for a message that carries `accessWrite`.
//
// Anatomy, in order: the HOST line, the count as a host fact, the AI's summary quoted, the
// statement in the source's names, the acts *apply to Ledger* / *cancel*. Every word is
// `agent/copy.dataWrite.ts`'s; the walk of the access vocabulary scan reads this file. Swapped
// out of the kit by `apps/host/src/stubs/AccessWriteCard.tsx` (D-PR5-16).
//
// THE CARD NEVER APPLIES ANYTHING: its acts hand the card to the hook (`approveAccessWrite`,
// `declineAccessWrite`), which runs the apply and persists the answer. What the card reads itself
// is the file AS IT IS NOW: both apps' library names (the source's may have been renamed since the
// card was staged; each is bidi-isolated wherever it sits in a sentence) and, once applied, the
// LIVE state of its undo in the source's journal — *live* (the act that opens the source's ⋈ sheet,
// IN PLACE, on its history), *undone*, or *no longer* (absent or past its seven days) — re-read on
// the access and library revisions. A card whose source or reader left the library says nothing:
// no name is guessed. *busy* and *waiting* sit above the acts, which stay (D-PR5-14a); *waiting*
// also offers the access act, where the waiting changes can be undone.
//
// Gate-5 fold G5-16: the lead promises an undo only while one is live — pending, or applied with
// its undo still live — and opens on the plain lead otherwise (ii-9); the statement is shown
// left-to-right and bidi-isolated, so no literal in it can reorder what the user reads (SB-6); and
// closing the sheet hands focus back to the access act, or — when an undo made there took the act
// away — to the card's own line, never to the page (ii-12).

import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { UserDb } from '@snugprotocol/db';

import type { AccessWriteCardState, AccessWriteFailedWhy } from '../agent/accessWriteCard.js';
import { DATA_WRITE_CARD, type CrossUndoState } from '../agent/copy.dataWrite.js';
import { useLibraryRevision } from '../platform/signals.js';
import '../theme/access.css';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { AccessSheet } from './AccessSheet.js';
import { CONSENT_SHEET } from './copy.js';
import { accessDeps, useAccessRevision } from './grants.js';

export interface AccessWriteCardProps {
  card: AccessWriteCardState;
  /** The chat message the card rides on — the hook's acts are addressed by it. */
  messageId: number;
  /** A turn is in flight: the acts wait. */
  busy: boolean;
  /** *apply to Ledger* — absent, the card offers no act. */
  onApply?: (card: AccessWriteCardState, messageId: number) => void;
  /** *cancel* — nothing was changed. */
  onCancel?: (card: AccessWriteCardState, messageId: number) => void;
}

/** What the card reads from the file: both names, and the undo's live state. */
interface LiveFacts {
  sourceName: string;
  readerName: string;
  undo: CrossUndoState;
}

/** The private-use marks a sentence is composed around, so each app's name can be isolated where the words put it. */
const SOURCE_MARK = '';
const READER_MARK = '';
const MARKS = /([])/u;

/** The two names a sentence may carry, by their marks. */
interface NameMarks {
  source: string;
  reader: string;
}

/** A sentence composed with the marks, rendered with each app's name in its own `<bdi>` — the text is the sentence's, byte for byte. */
function withNames(compose: (marks: NameMarks) => string, names: NameMarks): ReactNode[] {
  return compose({ source: SOURCE_MARK, reader: READER_MARK })
    .split(MARKS)
    .map((part, index) => (part === SOURCE_MARK ? <bdi key={index}>{names.source}</bdi> : part === READER_MARK ? <bdi key={index}>{names.reader}</bdi> : part));
}

/** The applied change's undo, as the source's journal holds it NOW (F15): live, undone, or no longer undoable. */
function undoStateOf(db: UserDb, sourceAppId: string, undoId: string | undefined): CrossUndoState {
  if (undoId === undefined) return 'ended';
  const entry = db.listAllAccessUndo(sourceAppId).find((candidate) => candidate.id === undoId);
  if (entry === undefined) return 'ended';
  if (entry.undoneAt !== undefined) return 'undone';
  return Date.parse(entry.expiresAt) <= accessDeps().now() ? 'ended' : 'live';
}

export function AccessWriteCard({ card, messageId, busy, onApply, onCancel }: AccessWriteCardProps): ReactElement | null {
  const revision = useAccessRevision();
  const library = useLibraryRevision();
  const [facts, setFacts] = useState<LiveFacts | null | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const accessActRef = useRef<HTMLButtonElement>(null);
  /** The card's count line — where focus lands when the sheet closes and the access act is gone. */
  const lineRef = useRef<HTMLSpanElement>(null);
  const { appId, undoId, outcome } = card;
  const { sourceAppId } = card.target;

  // The file as it is now: the names, and the undo's state — re-read whenever access or the library moves.
  useEffect(() => {
    let cancelled = false;
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const source = db.getApp(sourceAppId);
        const reader = db.getApp(appId);
        setFacts(source === undefined || reader === undefined ? null : { sourceName: source.displayName, readerName: reader.displayName, undo: undoStateOf(db, sourceAppId, undoId) });
      })
      .catch(() => {
        if (!cancelled) setFacts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, sourceAppId, undoId, outcome, revision, library]);

  // Not until the file is read — and never with a name guessed for an app the library no longer holds.
  if (facts === undefined || facts === null) return null;

  const names: NameMarks = { source: facts.sourceName, reader: facts.readerName };
  const { table } = card.target;
  const failedWords = (why: AccessWriteFailedWhy): ReactNode[] =>
    withNames(({ source, reader }) => DATA_WRITE_CARD.crossFailed(why, { readerName: reader, sourceName: source, table }), names);
  const closeSheet = (): void => {
    setSheetOpen(false);
    (accessActRef.current ?? lineRef.current)?.focus();
  };
  const accessAct = (
    <button type="button" className="btn" ref={accessActRef} onClick={() => setSheetOpen(true)}>
      {withNames(({ source }) => DATA_WRITE_CARD.crossOpenAccess(source), names)}
    </button>
  );

  const pending = outcome === undefined;
  /** An undo the user can still reach: the change is waiting, or applied with its undo live in the source's journal. */
  const undoLive = pending || (outcome === 'applied' && facts.undo === 'live');
  /** The line under the statement: what became of it, or — busy, waiting — why the last apply did not land. */
  const settled = ((): ReactNode[] | undefined => {
    switch (outcome) {
      case undefined:
        return card.failedWhy !== undefined ? failedWords(card.failedWhy) : undefined;
      case 'applied':
        return undefined;
      case 'declined':
        return [DATA_WRITE_CARD.declined];
      case 'drifted':
        return [DATA_WRITE_CARD.drifted];
      case 'failed':
        return failedWords(card.failedWhy ?? 'failed');
      default: {
        const never: never = outcome;
        return never;
      }
    }
  })();

  return (
    <Card className="artifact-card access-write-card" data-testid="access-write-card" data-outcome={outcome ?? 'staged'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
        <span className="hint">{withNames(({ source }) => (undoLive ? DATA_WRITE_CARD.crossLead(source, table) : DATA_WRITE_CARD.crossLeadPlain(source, table)), names)}</span>
        {outcome === 'applied' ? (
          <span className="artifact-name" role="status" ref={lineRef} tabIndex={-1}>
            {withNames(({ source }) => DATA_WRITE_CARD.crossAppliedLine(card.previewed, source, facts.undo), names)}
          </span>
        ) : (
          <span className="artifact-name" ref={lineRef} tabIndex={-1}>
            {withNames(({ source }) => DATA_WRITE_CARD.crossWould(card.previewed, source), names)}
          </span>
        )}
        {card.summary !== undefined ? <q className="access-quote">{CONSENT_SHEET.quote(card.summary)}</q> : null}
        <code dir="ltr" style={{ wordBreak: 'break-word', unicodeBidi: 'isolate' }}>
          {card.sql}
        </code>
        {settled !== undefined ? (
          <span className="hint" role="status" data-testid="access-write-card-note">
            {settled}
          </span>
        ) : null}
        {pending ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {onApply !== undefined ? (
              <Button variant="primary" disabled={busy} onClick={() => onApply(card, messageId)}>
                {withNames(({ source }) => DATA_WRITE_CARD.crossApply(source), names)}
              </Button>
            ) : null}
            {onCancel !== undefined ? (
              <Button disabled={busy} onClick={() => onCancel(card, messageId)}>
                {DATA_WRITE_CARD.cancel}
              </Button>
            ) : null}
            {card.failedWhy === 'waiting' ? accessAct : null}
          </div>
        ) : outcome === 'applied' && facts.undo === 'live' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>{accessAct}</div>
        ) : null}
      </div>
      {sheetOpen ? <AccessSheet appId={sourceAppId} focus="history" onClose={closeSheet} /> : null}
    </Card>
  );
}
