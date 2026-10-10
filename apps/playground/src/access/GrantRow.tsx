// access/GrantRow.tsx — ONE row of access, in either direction (TASK-20261010-cross-app-access
// AC19; ADR-0075 §7; D20). The reading app's sheet, the source's sheet and Settings all render
// this component and nothing else, so an access reads the same wherever the user meets it.
//
// BOTH PARTIES ARE NAMED. The sentence is the copy module's own (`ACCESS_SHEET.row` — "Budget has
// access to Ledger's transactions"); on an app's own sheet the NAME the user already knows (the
// app whose sheet it is) is MUTED, so the eye lands on the other app — and on the source's sheet
// the tables stay at full weight (they are what the row tells a source). The split is found inside
// the copy's sentence (the reading app's name first; the tables phrase — "<source>'s <tables>",
// copy.ts's own possessive shape — last); a sentence that ever stops having that shape renders
// whole and unmuted rather than rebuilt.
//
// THE WORDS, THE ONE ACT AND THE LOOK come from `grantStateCopy` — the ONE derivation (AC17) —
// fed the engine's row with its duration, so a session access reads *while it's open* and never
// as permanent; a row is drawn ended exactly when its act is not *stop*. The acts: *stop* (the
// engine's `revokeAccess`), *allow again* (a prefilled ask that renews THIS access with its own
// duration, opened for review — AC21's one tap, through `startUserAsk`), *remove* (a stopped row
// leaves the list). Every value is a text node: names and table names come from the user's file.

import { useId, useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { ACCESS_SHEET, grantStateCopy, listWords, tablesPhrase, type GrantActKind, type GrantStateView } from './copy.js';
import { accessDeps, bumpAccessRevision, findAccessGrant, revokeAccess, type LiveGrantRow } from './grants.js';
import { startUserAsk } from './userAsk.js';

/** Which app's surface the row is on — that side is the known one. `every`: Settings, neither. */
export type GrantRowSide = 'reads' | 'read-by' | 'every';

/** The engine's row as the copy module's view — every seat passed, the duration always. */
export function grantRowView(row: LiveGrantRow): GrantStateView {
  return {
    status: row.grant.status,
    suspendedReason: row.grant.suspendedReason,
    expiresAt: row.expiresAt,
    revokedAt: row.grant.revokedAt,
    reads: row.grant.reads,
    lastReadAt: row.grant.lastReadAt,
    readerName: row.readerName,
    sourceName: row.sourceName,
    duration: row.duration,
  };
}

/** The copy's sentence cut at its parts, or `undefined` when its shape is not the expected one. */
interface SentenceParts {
  /** The reading app's name. */
  reading: string;
  middle: string;
  /** The tables phrase, split once more at the source's name when it has copy.ts's possessive shape. */
  read: { whole: string } | { sourceName: string; joiner: string; tables: string };
}

function sentenceParts(readerName: string, sourceName: string, tables: readonly string[]): SentenceParts | undefined {
  const sentence = ACCESS_SHEET.row(readerName, sourceName, tables);
  const phrase = tablesPhrase(sourceName, tables);
  if (readerName === '' || !sentence.startsWith(readerName) || !sentence.endsWith(phrase) || sentence.length < readerName.length + phrase.length) return undefined;
  const list = listWords(tables);
  const read =
    sourceName !== '' && phrase.startsWith(sourceName) && phrase.endsWith(list) && phrase.length > sourceName.length + list.length
      ? { sourceName, joiner: phrase.slice(sourceName.length, phrase.length - list.length), tables: list }
      : { whole: phrase };
  return { reading: readerName, middle: sentence.slice(readerName.length, sentence.length - phrase.length), read };
}

/** *allow again*: a prefilled ask that renews THIS access with its own duration, then the review (userAsk.ts). */
export async function allowAccessAgain(row: LiveGrantRow): Promise<void> {
  await startUserAsk(row.grant.readerAppId, { renew: { grant: row.grant, duration: row.duration } });
}

/** *remove*: a STOPPED access leaves the list (its history lines stay with the source). Anything else is left alone. */
export async function removeStoppedAccess(grantId: string): Promise<void> {
  const db = await accessDeps().getDb();
  const found = findAccessGrant(db, grantId);
  if (found === undefined || found.session || found.grant.status !== 'revoked') return;
  db.deleteAccessGrant(grantId);
  bumpAccessRevision();
}

export interface GrantRowProps {
  row: LiveGrantRow;
  side: GrantRowSide;
  /** The clock reading the words are derived at. */
  now: number;
  /** Called before *allow again* opens the review — a sheet closes itself so the review is alone. */
  onBeforeReview?: () => void;
}

export function GrantRow({ row, side, now, onBeforeReview }: GrantRowProps): ReactElement {
  const sentenceId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const tables = row.grant.scope.tables.map((table) => table.name);
  const parts = sentenceParts(row.readerName, row.sourceName, tables);
  const state = grantStateCopy(grantRowView(row), now);

  const carryOut = async (kind: GrantActKind): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'stop') await revokeAccess(row.grant.id);
      else if (kind === 'remove') await removeStoppedAccess(row.grant.id);
      else {
        onBeforeReview?.();
        await allowAccessAgain(row);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`access-row${state.act?.kind === 'stop' ? '' : ' is-ended'}`} data-testid="access-row" data-side={side} data-access-id={row.grant.id}>
      <p className="access-row-sentence" id={sentenceId} data-testid="access-row-sentence">
        {parts === undefined ? (
          ACCESS_SHEET.row(row.readerName, row.sourceName, tables)
        ) : (
          <>
            <span className={`access-row-party${side === 'reads' ? ' is-known' : ''}`} {...(side === 'reads' ? { 'data-known': 'true' } : {})}>
              {parts.reading}
            </span>
            {parts.middle}
            {'whole' in parts.read ? (
              <span className={`access-row-party${side === 'read-by' ? ' is-known' : ''}`} {...(side === 'read-by' ? { 'data-known': 'true' } : {})}>
                {parts.read.whole}
              </span>
            ) : (
              <span className="access-row-party">
                <span className={side === 'read-by' ? 'is-known' : undefined} {...(side === 'read-by' ? { 'data-known': 'true' } : {})}>
                  {parts.read.sourceName}
                </span>
                {parts.read.joiner}
                <span className="access-row-tables" data-testid="access-row-tables">
                  {parts.read.tables}
                </span>
              </span>
            )}
          </>
        )}
      </p>
      <div className="access-row-state">
        <span className="access-row-words" data-testid="access-row-words">
          {state.words}
        </span>
        {state.act !== undefined ? (
          <Button
            variant={state.act.kind === 'stop' ? 'ghost' : 'default'}
            className="access-row-act"
            data-testid="access-row-act"
            data-act={state.act.kind}
            aria-describedby={sentenceId}
            disabled={busy}
            onClick={() => void carryOut(state.act!.kind)}
          >
            {state.act.label}
          </Button>
        ) : null}
      </div>
      {error !== undefined ? (
        <p className="error-note" role="alert" data-testid="access-row-error">
          {error}
        </p>
      ) : null}
    </li>
  );
}
