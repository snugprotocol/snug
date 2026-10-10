// access/SourcePicker.tsx — *from*: the user's apps ranked for the ask (TASK-20261010-cross-app-
// access AC16, AC18). A radiogroup: the matched candidates first (at most five), the rest behind
// *more apps…*; the chosen app opens into its tables (`TableChooser`), every other one is a
// one-line summary of what it holds. The apps that cannot be offered are ONE footer sentence
// (`excludedFooter`). The ranking is the host's, shown to the person and never to the app.

import type { ReactElement } from 'react';

import { CONSENT_SHEET, CONSENT_UI, excludedFooter } from './copy.js';
import { isOfferable, type RankedSource, type RankedSources } from './relevance.js';
import { TableChooser } from './TableChooser.js';
import { Button } from '../ui/Button.js';

export interface SourcePickerProps {
  candidates: RankedSources;
  /** The chosen app's id, if one is chosen. */
  chosenAppId: string | undefined;
  /** The ticked tables of an app. */
  tablesOf: (appId: string) => readonly string[];
  onChoose: (appId: string) => void;
  onToggle: (appId: string, table: string, on: boolean) => void;
  showMore: boolean;
  onShowMore: () => void;
  /** The radio group's `name` and the id of the section title that labels it. */
  groupName: string;
  labelledBy: string;
}

function summary(source: RankedSource): string {
  return source.tables
    .filter(isOfferable)
    .map((table) => CONSENT_UI.tableRows(table.name, table.rowCount))
    .join(' · ');
}

export function SourcePicker({ candidates, chosenAppId, tablesOf, onChoose, onToggle, showMore, onShowMore, groupName, labelledBy }: SourcePickerProps): ReactElement {
  const shown = showMore ? [...candidates.matched, ...candidates.rest] : candidates.matched;
  const footer = excludedFooter(candidates.excluded);
  return (
    <>
      <div className="access-sources" role="radiogroup" aria-labelledby={labelledBy} data-testid="access-sources">
        {shown.map((source) => {
          const chosen = source.appId === chosenAppId;
          return (
            <div key={source.appId} className={chosen ? 'access-source is-chosen' : 'access-source'} data-testid={`access-source-row-${source.appId}`}>
              <label className="check-label">
                <input
                  type="radio"
                  name={groupName}
                  value={source.appId}
                  checked={chosen}
                  data-testid={`access-source-${source.appId}`}
                  onChange={() => onChoose(source.appId)}
                />
                <span aria-hidden="true">{source.iconEmoji ?? '⬡'}</span>
                <span className="access-source-name">{source.displayName}</span>
              </label>
              {chosen ? (
                <TableChooser source={source} chosen={tablesOf(source.appId)} onToggle={(table, on) => onToggle(source.appId, table, on)} />
              ) : (
                <p className="access-source-summary">{summary(source)}</p>
              )}
            </div>
          );
        })}
      </div>
      {!showMore && candidates.rest.length > 0 ? (
        <Button variant="ghost" onClick={onShowMore} data-testid="access-more-apps">
          {CONSENT_SHEET.moreApps}
        </Button>
      ) : null}
      {footer !== '' ? (
        <p className="access-excluded" data-testid="access-excluded">
          {footer}
        </p>
      ) : null}
    </>
  );
}
