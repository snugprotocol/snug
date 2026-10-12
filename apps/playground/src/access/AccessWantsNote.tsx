// access/AccessWantsNote.tsx — the data an app says it wants from the person's other apps (its
// access-wants meta), said on the SHARED install preview before it is installed or has asked anything
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-3 and its v2.1 answer TB-Q14; D5, SC10).
//
// Over `extractAccessWants(html)` — the bundle's HTML in memory, read by the same pure reader the
// file derives its row with: ONE sentence `ACCESS_WANTS.preview`, then ONE line
// `ACCESS_WANTS.forWhat` before the FIRST want's purpose, quoted in a bidi-isolated `<q>` (a text
// node, never markup). No declaration, no note. Host words around the app's; every word is
// `copy.ts`'s — this file spells none of the sentence.
//
// THE NAMES are the data the wants point at: the union of their hint TABLES in declaration order,
// each once — or, when no want names a table, their hint WORDS — the first three, then how many
// more. No hint anywhere: the may-ask form, which names nothing.

import { useMemo, type ReactElement } from 'react';

import { extractAccessWants } from '@snugprotocol/db';
import type { AccessWants } from '@snugprotocol/protocol';

import '../theme/access.css';
import { ACCESS_WANTS, CONSENT_SHEET } from './copy.js';

/** How many names the sentence says before *and N more*. */
const NAMES_SHOWN = 3;

export interface AccessWantsNoteProps {
  /** The app's name as the preview shows it. */
  appName: string;
  /** The bundle's HTML, never installed — the note extracts the declaration itself. */
  html: string;
}

/** The union of the wants' hint tables (else their words), each once, in the order declared. */
function namesOf(wants: AccessWants): string[] {
  const union = (pick: (hints: NonNullable<AccessWants[number]['hints']>) => readonly string[] | undefined): string[] => [
    ...new Set(wants.flatMap((want) => (want.hints === undefined ? [] : [...(pick(want.hints) ?? [])]))),
  ];
  const tables = union((hints) => hints.tables);
  return tables.length > 0 ? tables : union((hints) => hints.words);
}

export function AccessWantsNote({ appName, html }: AccessWantsNoteProps): ReactElement | null {
  const wants = useMemo(() => extractAccessWants(html), [html]);
  if (wants === undefined) return null;
  const [first] = wants;
  const names = namesOf(wants);
  return (
    // Spaced like the preview's own disclosure line it sits under (RunView's inline margin).
    <div className="hint access-wants-note" data-testid="access-wants-note" style={{ margin: 'var(--space-2) var(--space-4) 0' }}>
      <p className="access-says">{ACCESS_WANTS.preview(appName, names.slice(0, NAMES_SHOWN), Math.max(0, names.length - NAMES_SHOWN))}</p>
      {first !== undefined ? (
        <p className="access-says">
          {ACCESS_WANTS.forWhat(appName)}{' '}
          <q className="access-quote">{CONSENT_SHEET.quote(first.purpose)}</q>
        </p>
      ) : null}
    </div>
  );
}
