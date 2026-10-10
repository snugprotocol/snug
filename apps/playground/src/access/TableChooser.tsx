// access/TableChooser.tsx — the chosen app's tables on the consent sheet (TASK-20261010-cross-app-
// access AC18; D23): each table a checkbox with its row count, its columns as chips (at most
// eight, then "+n more"). A credential-named column is a chip marked *never shared* — listed so
// the person sees it exists, never part of what is allowed — and a table with nothing BUT such
// columns can never be ticked. Text nodes only: every name here was written by an app.

import type { ReactElement } from 'react';

import { CONSENT_SHEET, CONSENT_UI } from './copy.js';
import { isOfferable, type RankedSource } from './relevance.js';

/** Chips shown per table before the rest collapse into "+n more". */
const CHIPS_MAX = 8;

export interface TableChooserProps {
  source: RankedSource;
  /** The ticked table names. */
  chosen: readonly string[];
  onToggle: (table: string, on: boolean) => void;
}

export function TableChooser({ source, chosen, onToggle }: TableChooserProps): ReactElement {
  const id = source.appId;
  return (
    <ul className="access-tables">
      {source.tables.map((table) => {
        const offerable = isOfferable(table);
        const shown = table.columns.slice(0, CHIPS_MAX);
        const more = table.columns.length - shown.length;
        return (
          <li key={table.name} data-testid={`access-table-row-${id}-${table.name}`}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={offerable && chosen.includes(table.name)}
                disabled={!offerable}
                data-testid={`access-table-${id}-${table.name}`}
                onChange={(event) => onToggle(table.name, event.target.checked)}
              />
              <span>{CONSENT_UI.tableRows(table.name, table.rowCount)}</span>
            </label>
            <ul className="access-chips" aria-label={CONSENT_UI.columnsOf(table.name)} data-testid={`access-chips-${id}-${table.name}`}>
              {shown.map((column) => (
                <li
                  key={column.name}
                  className={column.sensitive ? 'access-chip is-sensitive' : 'access-chip'}
                  data-column={column.name}
                  {...(column.sensitive ? { 'data-sensitive': 'true' } : {})}
                >
                  {column.name}
                  {column.sensitive ? <span className="access-chip-mark"> · {CONSENT_SHEET.neverShared}</span> : null}
                </li>
              ))}
              {more > 0 ? (
                <li className="access-chip is-more" data-testid={`access-chips-more-${id}-${table.name}`}>
                  {CONSENT_SHEET.moreColumns(more)}
                </li>
              ) : null}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
