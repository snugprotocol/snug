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
//
// A STRANGER'S WORDS STAY IN THEIR BOX (Gate-5 G5-15; IB-9, SA-4). This is the most hostile surface
// PR-5 adds — a bundle nobody here built, before it is installed — so the bundle's name and every
// hint name sit in a `<bdi>` of their own (`isolateNames`: copy.ts takes the names, this surface
// wraps them), never in the host's text, and the purpose is the consent sheet's BLOCK quote
// (`.access-quote-block`): a purpose that "closes" its own quote and goes on in host-sounding words
// stays inside the app's panel.

import { useMemo, type ReactElement } from 'react';

import { extractAccessWants } from '@snugprotocol/db';
import type { AccessWants } from '@snugprotocol/protocol';

import '../theme/access.css';
import { isolateNames } from './AccessActLine.js';
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
  const shown = names.slice(0, NAMES_SHOWN);
  const more = Math.max(0, names.length - NAMES_SHOWN);
  return (
    // Spaced like the preview's own disclosure line it sits under (RunView's inline margin).
    <div className="hint access-wants-note" data-testid="access-wants-note" style={{ margin: 'var(--space-2) var(--space-4) 0' }}>
      <p className="access-says">{isolateNames((app, ...hinted) => ACCESS_WANTS.preview(app, hinted, more), appName, ...shown)}</p>
      {first !== undefined ? (
        <p className="access-says">
          {isolateNames(ACCESS_WANTS.forWhat, appName)}{' '}
          <q className="access-quote access-quote-block">{CONSENT_SHEET.quote(first.purpose)}</q>
        </p>
      ) : null}
    </div>
  );
}
