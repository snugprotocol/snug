// agent/sharedDdl.ts — the ONE renderer of another app's tables as a brain is TOLD about them
// (TASK-20261010-host-broker PR-2 AC10, AC13; ADR-0076 §2; contract v2 D-PR2-12/13; DS-11, F14,
// S5; v2.1 notes B-Q5, C-Q5, C-Q6). Both doors call it: the chat's data-lane context
// (`intentContext.ts`, after the app's own DDL) and the scheduled *Ask [app]'s AI* context
// (`appThink.ts`, after its `Schema:` block, OUTSIDE the data delimiter).
//
// WHAT IT SAYS, and nothing more: per grant in set order, `CHAT_DOOR.heading` — the source's name
// and how long the access lasts, in the sheet's own words, dated on the clock it is handed — then
// one `CHAT_DOOR.tableLine` per table: its full name in the copy, its columns with the types the
// dump allowed ('' is left unsaid), and the row count or the cut the dump made. After the LAST
// source, `CHAT_DOOR.rule` ONCE (how to query them, never to change them); then one
// `CHAT_DOOR.unreadable` note per skipped source. NEVER a row — rows reach a brain only inside the
// data delimiter, through `data_query` or the step's fences. An empty set renders '' so a context
// with no shared tables is byte-identical to one built before the doors existed.
//
// A column name is written verbatim when it is a plain identifier and "double-quoted" otherwise
// (S5: app-authored names are shown, never run; the quoting keeps the signature readable as SQL).
// Every sentence is `access/copy.ts`'s — this module formats what it is given.
//
// A SOURCE'S NAME IS ONE LINE (Gate-5 SEC-1). The heading and the unreadable note are the HOST's
// sentences OUTSIDE the data delimiter, and the name in them is another app's text — a model's
// `artifact_write` title, an HTML `<title>`, a shared bundle's name: trimmed and capped, but under
// no line rule. So `oneLine` folds it first: control characters, the line and paragraph separators,
// the bidi marks, embeddings, overrides and isolates, and every whitespace run become one space;
// trimmed; cut at the protocol's display-name cap; '(unnamed app)' when nothing is left. A name can
// never add a line of its own to a brain's context. The data tools and the service fold the same
// name the same way wherever a brain reads it (`CHAT_DOOR.ended`, `.readOnly`, the reader's own
// name in a service-level skip).

import { LIMITS } from '@snugprotocol/protocol';

import { CHAT_DOOR } from '../access/copy.js';
import type { MaterialisedSet, MaterialisedTable } from '../access/service.js';

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a name may not carry into a line: C0 controls and DEL, the C1 controls (U+0080–U+009F — NEL among them, a line break to some tokenizers), U+2028/9, the bidi marks (U+200E/F), embeddings and overrides (U+202A–E) and isolates (U+2066–9). */
const FOLDED = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;
const UNNAMED = '(unnamed app)';

/** Another app's display name as ONE line of host text (the header): folded, trimmed, capped, never empty. */
export function oneLine(name: string): string {
  return name.replace(FOLDED, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.DISPLAY_NAME_CHARS) || UNNAMED;
}

/** Verbatim when plain, else "double-quoted" with its own quotes doubled — SQL's spelling. */
const columnName = (name: string): string => (PLAIN_IDENTIFIER.test(name) ? name : `"${name.replaceAll('"', '""')}"`);

/** The set's tables grouped by grant, in set order (C-Q6). */
function byGrant(tables: readonly MaterialisedTable[]): Array<{ first: MaterialisedTable; tables: MaterialisedTable[] }> {
  const groups: Array<{ first: MaterialisedTable; tables: MaterialisedTable[] }> = [];
  for (const table of tables) {
    const group = groups.find((candidate) => candidate.first.grantId === table.grantId);
    if (group === undefined) groups.push({ first: table, tables: [table] });
    else group.tables.push(table);
  }
  return groups;
}

/** The host's framing of a materialised set — see the header. '' for an empty set. */
export function renderSharedDdl(set: MaterialisedSet, now: number): string {
  const groups = byGrant(set.tables);
  const blocks: string[] = groups.map(({ first, tables }) =>
    [
      CHAT_DOOR.heading(oneLine(first.sourceName), first.duration, first.expiresAt, now),
      ...tables.map((table) => CHAT_DOOR.tableLine(table.name, table.columns.map(columnName), table.types, table.rows.length, table.truncated, table.totalRows)),
    ].join('\n'),
  );
  if (groups.length > 0) blocks.push(CHAT_DOOR.rule);
  for (const skip of set.skipped) blocks.push(CHAT_DOOR.unreadable(oneLine(skip.sourceName)));
  return blocks.join('\n\n');
}
