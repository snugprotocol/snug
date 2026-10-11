// access/TableChooser.tsx — the chosen app's tables on the consent sheet (TASK-20261010-cross-app-
// access AC18; D23): each table a checkbox with its row count and, on the DEFAULT path, its
// columns as inert chips (at most eight, then "+n more") — the 1.1 markup, byte for byte, whatever
// the options say. A credential-named column is a chip marked *never shared* — listed so the
// person sees it exists, never part of what is allowed — and a table with nothing BUT such
// columns can never be ticked. Text nodes only: every name here was written by an app.
//
// TASK-20261010-host-broker PR-3 (D-PR3-23; DS5, DS6, DS18; contract v2.1 U-Q14, U-Q15) adds,
// on every TICKED row:
//   - *choose columns…* (`access-columns-<app>-<t>`), a disclosure that swaps the chips for
//     pre-ticked per-column boxes (`access-column-<app>-<t>-<c>`): a sensitive column a DISABLED
//     unticked box reading *never shared*; past the eighth, *show all N columns* inside. A column
//     left unticked is WITHHELD on the record (D-PR3-2) — the sheet lists it in the source's order.
//   - while the sheet's *more options…* is open, the write toggle (`access-write-<app>-<t>`, *can
//     also change rows*) — OFF until the person ticks it, never by the app's ask — with the one-
//     breath undo note under it once ticked: the bound, where the changes are listed, that each
//     can be undone.
// An UNTICKED row keeps the 1.1 look: the choices belong to a table that is allowed at all.

import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '../ui/Button.js';
import { CONSENT_SHEET, CONSENT_UI } from './copy.js';
import { isOfferable, type RankedSource, type SourceColumn, type SourceTable } from './relevance.js';

/** Chips (and column boxes) shown per table before the rest collapse into "+n more" / *show all*. */
const CHIPS_MAX = 8;

/** One ticked table's choices (D-PR3-23): the non-sensitive columns left ticked, and the write toggle. */
export interface TableTick {
  /** The ticked columns, in any order — the sheet emits the source's order when it answers. */
  columns: readonly string[];
  write: boolean;
}

export interface TableChooserProps {
  source: RankedSource;
  /** The asking app's library name — the undo note names it. */
  readerName: string;
  /** The ticked tables with their choices; a table absent here is unticked. */
  ticked: Readonly<Record<string, TableTick>>;
  /** The sheet's *more options…* is open: each ticked row shows its write toggle. */
  optionsOpen: boolean;
  onToggle: (table: string, on: boolean) => void;
  onColumn: (table: string, column: string, on: boolean) => void;
  onWrite: (table: string, on: boolean) => void;
}

/** The chip for one column — a text node; a sensitive column carries the *never shared* mark. */
function Chip({ column }: { column: SourceColumn }): ReactElement {
  return (
    <li className={column.sensitive ? 'access-chip is-sensitive' : 'access-chip'} data-column={column.name} {...(column.sensitive ? { 'data-sensitive': 'true' } : {})}>
      {column.name}
      {column.sensitive ? <span className="access-chip-mark"> · {CONSENT_SHEET.neverShared}</span> : null}
    </li>
  );
}

/** The 1.1 chips: at most eight, then "+n more". */
function Chips({ id, table }: { id: string; table: SourceTable }): ReactElement {
  const shown = table.columns.slice(0, CHIPS_MAX);
  const more = table.columns.length - shown.length;
  return (
    <ul className="access-chips" aria-label={CONSENT_UI.columnsOf(table.name)} data-testid={`access-chips-${id}-${table.name}`}>
      {shown.map((column) => (
        <Chip key={column.name} column={column} />
      ))}
      {more > 0 ? (
        <li className="access-chip is-more" data-testid={`access-chips-more-${id}-${table.name}`}>
          {CONSENT_SHEET.moreColumns(more)}
        </li>
      ) : null}
    </ul>
  );
}

interface ColumnBoxesProps {
  id: string;
  table: SourceTable;
  tick: TableTick;
  onColumn: (column: string, on: boolean) => void;
}

/** The per-column boxes behind *choose columns…*: the eight-cut as *show all N columns* (the chips' "+n more" twin). */
function ColumnBoxes({ id, table, tick, onColumn }: ColumnBoxesProps): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? table.columns : table.columns.slice(0, CHIPS_MAX);
  return (
    <>
      <ul className="access-column-list" aria-label={CONSENT_UI.columnsOf(table.name)}>
        {shown.map((column) => (
          <li key={column.name}>
            <label className="check-label access-column">
              <input
                type="checkbox"
                checked={!column.sensitive && tick.columns.includes(column.name)}
                disabled={column.sensitive}
                data-testid={`access-column-${id}-${table.name}-${column.name}`}
                onChange={(event) => onColumn(column.name, event.target.checked)}
              />
              <span className={column.sensitive ? 'access-column-name is-sensitive' : 'access-column-name'}>
                {column.name}
                {column.sensitive ? <span className="access-chip-mark"> · {CONSENT_SHEET.neverShared}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {shown.length < table.columns.length ? (
        <Button variant="ghost" className="access-show-all" onClick={() => setShowAll(true)}>
          {CONSENT_SHEET.showAllColumns(table.columns.length)}
        </Button>
      ) : null}
    </>
  );
}

interface TableRowProps {
  id: string;
  sourceName: string;
  readerName: string;
  table: SourceTable;
  /** The row's choices — `undefined` for an unticked (or unofferable) table. */
  tick: TableTick | undefined;
  optionsOpen: boolean;
  onToggle: (on: boolean) => void;
  onColumn: (column: string, on: boolean) => void;
  onWrite: (on: boolean) => void;
}

function TableRow({ id, sourceName, readerName, table, tick, optionsOpen, onToggle, onColumn, onWrite }: TableRowProps): ReactElement {
  const offerable = isOfferable(table);
  const [columnsOpen, setColumnsOpen] = useState(false);
  // The chooser belongs to a ticked table; an unticked row keeps the 1.1 chips (and forgets an open chooser).
  const chooser = tick !== undefined;
  const toggle = (on: boolean): void => {
    if (!on) setColumnsOpen(false);
    onToggle(on);
  };
  return (
    <li data-testid={`access-table-row-${id}-${table.name}`}>
      <label className="check-label">
        <input
          type="checkbox"
          checked={offerable && tick !== undefined}
          disabled={!offerable}
          data-testid={`access-table-${id}-${table.name}`}
          onChange={(event) => toggle(event.target.checked)}
        />
        <span>{CONSENT_UI.tableRows(table.name, table.rowCount)}</span>
      </label>
      {!chooser || !columnsOpen ? <Chips id={id} table={table} /> : null}
      {chooser ? (
        <details
          className="access-disclosure access-columns"
          data-testid={`access-columns-${id}-${table.name}`}
          open={columnsOpen}
          onToggle={(event) => setColumnsOpen((event.target as HTMLDetailsElement).open)}
        >
          <summary>{CONSENT_SHEET.chooseColumns}</summary>
          {columnsOpen ? <ColumnBoxes id={id} table={table} tick={tick} onColumn={onColumn} /> : null}
        </details>
      ) : null}
      {chooser && optionsOpen ? (
        <div className="access-write">
          <label className="check-label">
            <input type="checkbox" checked={tick.write} data-testid={`access-write-${id}-${table.name}`} onChange={(event) => onWrite(event.target.checked)} />
            <span>{CONSENT_SHEET.canChange}</span>
          </label>
          {tick.write ? <p className="hint access-undo-note">{CONSENT_SHEET.undoNote(sourceName, table.name, readerName)}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function TableChooser({ source, readerName, ticked, optionsOpen, onToggle, onColumn, onWrite }: TableChooserProps): ReactElement {
  const id = source.appId;
  return (
    <ul className="access-tables">
      {source.tables.map((table) => (
        <TableRow
          key={table.name}
          id={id}
          sourceName={source.displayName}
          readerName={readerName}
          table={table}
          tick={isOfferable(table) ? ticked[table.name] : undefined}
          optionsOpen={optionsOpen}
          onToggle={(on) => onToggle(table.name, on)}
          onColumn={(column, on) => onColumn(table.name, column, on)}
          onWrite={(on) => onWrite(table.name, on)}
        />
      ))}
    </ul>
  );
}
