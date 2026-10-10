// access/AccessHistory.tsx — the SOURCE's history, in words (TASK-20261010-cross-app-access AC19;
// ADR-0075 §6; Q14, D15). The host keeps it on the source's own row; this renders it on the
// source's ⋈ sheet.
//
// Each row is the app that read, then the copy module's `historyLine` ("read transactions · 412
// rows · 2 min ago · while you were here"); a read that carries its statement keeps it behind a
// *what it asked* disclosure — the statement is the reading app's text, so it is a text node in
// a <code>, never markup. Entries that arrived with an imported file sit under their own heading
// (AC10: the user did not see them happen here). When nothing has been read yet the history
// says so, beside the lines that record when access began or ended.

import type { ReactElement } from 'react';

import type { AccessLogEntry } from '@snugprotocol/protocol';

import { ACCESS_SHEET, historyLine } from './copy.js';

function HistoryRows({ entries, now }: { entries: readonly AccessLogEntry[]; now: number }): ReactElement {
  return (
    <ul className="access-history-list">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${entry.grantId}-${entry.kind}-${index}`} className="access-history-row" data-testid="access-history-row" data-kind={entry.kind}>
          <span className="access-history-who" data-testid="access-history-who">
            {entry.readerName}
          </span>{' '}
          <span className="access-history-words" data-testid="access-history-words">
            {historyLine(entry, now)}
          </span>
          {entry.sql !== undefined ? (
            <details className="access-history-asked" data-testid="access-history-asked">
              <summary>{ACCESS_SHEET.whatItAsked}</summary>
              <code className="access-history-sql">{entry.sql}</code>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export interface AccessHistoryProps {
  /** The source's history, newest first (the db's order). */
  entries: readonly AccessLogEntry[];
  now: number;
}

export function AccessHistory({ entries, now }: AccessHistoryProps): ReactElement {
  const here = entries.filter((entry) => entry.imported !== true);
  const imported = entries.filter((entry) => entry.imported === true);
  const nothingRead = !here.some((entry) => entry.kind === 'read');
  return (
    <section className="access-sheet-section access-history" data-testid="access-history">
      <h3 className="access-sheet-section-title">{ACCESS_SHEET.history}</h3>
      {nothingRead ? (
        <p className="hint" data-testid="access-history-empty">
          {ACCESS_SHEET.noHistory}
        </p>
      ) : null}
      {here.length > 0 ? <HistoryRows entries={here} now={now} /> : null}
      {imported.length > 0 ? (
        <div className="access-history-imported" data-testid="access-history-imported">
          <h4 className="access-sheet-subtitle">{ACCESS_SHEET.historyImported}</h4>
          <HistoryRows entries={imported} now={now} />
        </div>
      ) : null}
    </section>
  );
}
