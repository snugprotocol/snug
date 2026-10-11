// sharedDdl.test.ts — TASK-20261010-host-broker PR-2 (ADR-0076 §1–§3; contract v2 `agent/sharedDdl.ts`,
// D-PR2-12/13; DS-11/F14): `renderSharedDdl(set, now)` is the ONE renderer both doors call — the
// chat's data-lane block (`intentContext.ts`) and the scheduled *Ask [app]'s AI* context
// (`appThink.ts`). It renders the host's framing of the materialised tables and NEVER their rows:
//
//   - per source, `CHAT_DOOR.heading(sourceName, duration, expiresAt, now)` — the three duration
//     forms (while it's open · until <date> · until you stop it);
//   - one `CHAT_DOOR.tableLine(…)` per table under its source — the types, the row count, the
//     truncation the dump made;
//   - `CHAT_DOOR.rule` ONCE, after the LAST source;
//   - one `CHAT_DOOR.unreadable(sourceName)` note per skip;
//   - an EMPTY set → `''` (so a context with no shared tables is byte-identical to today's);
//   - a column name verbatim when it is a plain identifier, else "double-quoted".
//
// Every expected sentence comes from `access/copy.ts`'s `CHAT_DOOR`, never a retyped literal
// (`accessCopy.test.ts` pins the literals). RED until `agent/sharedDdl.ts` and `CHAT_DOOR` land.
import { describe, expect, it } from 'vitest';

import { CHAT_DOOR, shortDate } from '../access/copy.js';
import type { MaterialisedSet, MaterialisedTable } from '../access/service.js';
import { renderSharedDdl } from '../agent/sharedDdl.js';

// Local-time fixtures (copy.ts's dates are local), so the pins hold in any timezone.
const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime(); // Oct 12, 3 pm
const EXPIRES = new Date(2026, 9, 13, 15, 0, 0).toISOString(); // a day later

function table(over: Partial<MaterialisedTable> & Pick<MaterialisedTable, 'table'>): MaterialisedTable {
  const alias = over.alias ?? 'ledger';
  return {
    grantId: 'g-ledger',
    sourceAppId: 'ledger-app',
    sourceName: 'Ledger',
    alias,
    name: `${alias}__${over.table}`,
    columns: ['id', 'amount', 'note'],
    types: ['INTEGER', 'REAL', 'TEXT'],
    rows: [
      [1, 12.5, 'coffee'],
      [2, 900, 'rent'],
    ],
    truncated: false,
    duration: 'always',
    ...over,
  };
}

const TRANSACTIONS = table({ table: 'transactions' });
const ACCOUNTS = table({ table: 'accounts', columns: ['id', 'label'], types: ['INTEGER', 'TEXT'], rows: [[1, 'checking']] });
const PANTRY_ITEMS = table({
  grantId: 'g-pantry',
  sourceAppId: 'pantry-app',
  sourceName: 'Pantry',
  alias: 'pantry',
  table: 'items',
  columns: ['name', 'qty'],
  types: ['TEXT', 'INTEGER'],
  rows: [['rice', 2]],
  duration: 'day',
  expiresAt: EXPIRES,
});

function set(tables: MaterialisedTable[], skipped: MaterialisedSet['skipped'] = []): MaterialisedSet {
  return { tables, skipped, readOnlyTables: tables.map((t) => t.name).sort() };
}

/** The line the renderer is expected to write for one table, through the copy module. */
const lineFor = (t: MaterialisedTable): string => CHAT_DOOR.tableLine(t.name, t.columns, t.types, t.rows.length, t.truncated, t.totalRows);

const linesOf = (text: string): string[] => text.split('\n');

describe('renderSharedDdl — the empty set', () => {
  it('an empty set renders the empty string (a context with no shared tables is byte-identical to today’s)', () => {
    expect(renderSharedDdl({ tables: [], skipped: [], readOnlyTables: [] }, NOW)).toBe('');
  });
});

describe('renderSharedDdl — one heading per source, the three duration forms', () => {
  it('a source allowed until the user stops it: "until you stop it"', () => {
    const out = renderSharedDdl(set([TRANSACTIONS]), NOW);
    expect(linesOf(out)).toContain(CHAT_DOOR.heading('Ledger', 'always', undefined, NOW));
    expect(CHAT_DOOR.heading('Ledger', 'always', undefined, NOW)).toBe('### From Ledger (read-only · access until you stop it)');
  });

  it('a source allowed for a day: "until <the short date>", the date in copy.ts’s own words', () => {
    const out = renderSharedDdl(set([PANTRY_ITEMS]), NOW);
    expect(linesOf(out)).toContain(CHAT_DOOR.heading('Pantry', 'day', EXPIRES, NOW));
    expect(CHAT_DOOR.heading('Pantry', 'day', EXPIRES, NOW)).toBe(`### From Pantry (read-only · access until ${shortDate(EXPIRES, NOW)})`);
  });

  it('a session source: "while it’s open" whatever the expiry says', () => {
    const session = table({ table: 'transactions', duration: 'session' });
    const out = renderSharedDdl(set([session]), NOW);
    expect(linesOf(out)).toContain(CHAT_DOOR.heading('Ledger', 'session', undefined, NOW));
    expect(CHAT_DOOR.heading('Ledger', 'session', undefined, NOW)).toBe("### From Ledger (read-only · access while it's open)");
  });

  it('the date the heading names depends on the `now` it is handed (the year is said only when it differs)', () => {
    const nextYear = new Date(2027, 0, 5, 12, 0, 0).toISOString();
    const far = table({ table: 'transactions', duration: 'week', expiresAt: nextYear });
    const out = renderSharedDdl(set([far]), NOW);
    expect(linesOf(out)).toContain(CHAT_DOOR.heading('Ledger', 'week', nextYear, NOW));
    expect(CHAT_DOOR.heading('Ledger', 'week', nextYear, NOW)).toContain(shortDate(nextYear, NOW));
    expect(shortDate(nextYear, NOW)).toContain('2027');
  });

  it('two tables of ONE source sit under ONE heading; a second source has its own, in the set’s order', () => {
    const out = renderSharedDdl(set([TRANSACTIONS, ACCOUNTS, PANTRY_ITEMS]), NOW);
    const lines = linesOf(out);
    const ledgerHeading = CHAT_DOOR.heading('Ledger', 'always', undefined, NOW);
    const pantryHeading = CHAT_DOOR.heading('Pantry', 'day', EXPIRES, NOW);
    expect(lines.filter((line) => line === ledgerHeading)).toHaveLength(1);
    expect(lines.filter((line) => line === pantryHeading)).toHaveLength(1);
    const order = [ledgerHeading, lineFor(TRANSACTIONS), lineFor(ACCOUNTS), pantryHeading, lineFor(PANTRY_ITEMS)].map((line) => lines.indexOf(line));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('renderSharedDdl — the table lines', () => {
  it('one line per table with its full name, columns, types and row count — through CHAT_DOOR.tableLine', () => {
    const out = renderSharedDdl(set([TRANSACTIONS, ACCOUNTS]), NOW);
    expect(linesOf(out)).toContain(lineFor(TRANSACTIONS));
    expect(linesOf(out)).toContain(lineFor(ACCOUNTS));
    expect(lineFor(TRANSACTIONS)).toBe('ledger__transactions(id INTEGER, amount REAL, note TEXT) — 2 rows');
  });

  it('a table the dump cut says so: "showing N of M rows"', () => {
    const cut = table({ table: 'transactions', rows: [[1, 1, 'a'], [2, 2, 'b'], [3, 3, 'c']], truncated: true, totalRows: 9120 });
    const out = renderSharedDdl(set([cut]), NOW);
    expect(linesOf(out)).toContain(lineFor(cut));
    expect(lineFor(cut)).toContain('showing 3 of 9120 rows');
  });

  it('a column with no allowed type is still listed (the dump answered `\'\'` for its type)', () => {
    const untyped = table({ table: 'transactions', types: ['INTEGER', '', 'TEXT'] });
    const out = renderSharedDdl(set([untyped]), NOW);
    expect(linesOf(out)).toContain(lineFor(untyped));
    expect(out).toContain('amount');
  });

  it('a column name that is not a plain identifier is "double-quoted"; a plain one is verbatim', () => {
    const odd = table({ table: 'notes', columns: ['id', 'my col', '2nd'], types: ['INTEGER', 'TEXT', 'REAL'], rows: [[1, 'x', 2]] });
    const out = renderSharedDdl(set([odd]), NOW);
    expect(out).toContain('ledger__notes(id INTEGER, "my col" TEXT, "2nd" REAL)');
    expect(out).not.toMatch(/[(,] ?my col /);
    expect(out).not.toMatch(/[(,] ?2nd /);
  });

  it('the DDL block carries names, types and counts — NEVER a row (rows reach a brain only inside the data delimiter)', () => {
    const marked = table({ table: 'transactions', rows: [[1, 1, 'ROW-VALUE-NEVER-IN-THE-DDL']] });
    const out = renderSharedDdl(set([marked]), NOW);
    expect(out).not.toContain('ROW-VALUE-NEVER-IN-THE-DDL');
    expect(out).not.toContain('<query_result>');
  });
});

describe('renderSharedDdl — the rule and the skips', () => {
  it('CHAT_DOOR.rule appears ONCE, after the LAST source’s last table line', () => {
    const out = renderSharedDdl(set([TRANSACTIONS, ACCOUNTS, PANTRY_ITEMS]), NOW);
    const lines = linesOf(out);
    expect(lines.filter((line) => line === CHAT_DOOR.rule)).toHaveLength(1);
    expect(out.split(CHAT_DOOR.rule)).toHaveLength(2);
    expect(lines.indexOf(CHAT_DOOR.rule)).toBeGreaterThan(lines.indexOf(lineFor(PANTRY_ITEMS)));
    expect(lines.indexOf(CHAT_DOOR.rule)).toBeGreaterThan(lines.indexOf(CHAT_DOOR.heading('Pantry', 'day', EXPIRES, NOW)));
  });

  it('each skip is ONE unreadable note naming its source', () => {
    const out = renderSharedDdl(
      set(
        [TRANSACTIONS],
        [
          { grantId: 'g-pantry', sourceAppId: 'pantry-app', sourceName: 'Pantry', reason: 'timeout' },
          { grantId: 'g-garden', sourceAppId: 'garden-app', sourceName: 'Garden', reason: 'drift' },
        ],
      ),
      NOW,
    );
    expect(out.split(CHAT_DOOR.unreadable('Pantry'))).toHaveLength(2);
    expect(out.split(CHAT_DOOR.unreadable('Garden'))).toHaveLength(2);
    expect(linesOf(out)).toContain(lineFor(TRANSACTIONS));
  });

  it('a set holding ONLY skips is not empty — the note is said (the turn proceeds without shared tables and the block says so)', () => {
    const out = renderSharedDdl(
      { tables: [], skipped: [{ grantId: 'g-pantry', sourceAppId: 'pantry-app', sourceName: 'Pantry', reason: 'unavailable' }], readOnlyTables: [] },
      NOW,
    );
    expect(out).toContain(CHAT_DOOR.unreadable('Pantry'));
    expect(out).not.toContain('### From Pantry');
  });
});
