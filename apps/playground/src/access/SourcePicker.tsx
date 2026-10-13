// access/SourcePicker.tsx — *from*: the user's apps ranked for the ask (TASK-20261010-cross-app-
// access AC16, AC18). A radiogroup: the matched candidates first (at most five), the rest behind
// *more apps…*; the chosen app opens into its tables (`TableChooser`), every other one is a
// one-line summary of what it holds. The apps that cannot be offered are ONE footer sentence
// (`excludedFooter`). The ranking is the host's, shown to the person and never to the app.
//
// TASK-20261010-host-broker PR-3 (D-PR3-23; DS6, DS23): under the chosen app's tables sits ONE
// *more options…* disclosure (`access-options-more`) — the sheet owns whether it is open, because
// what it reveals is in two places: the write toggle on each ticked table row (`TableChooser`),
// and the options row here — `access-kv` (*<Source>'s settings & notes*: its `snug_kv` joins the
// copy, through the one credential walk) and `access-refresh` (*may ask <Source> to fetch new data
// before reading it*), each with its hint. The disclosure starts OPEN when the ask carried
// `access: 'write'` or a renewal's seed turned a write, kv or refresh on (the sheet decides), so
// a renewal shows its ticks without a click; otherwise CLOSED — the default path is the 1.1 sheet.
//
// TASK-20261010-host-broker PR-5 (D-PR5-5; D7): `canChange={false}` — a source's offer — reaches
// every table row, so no write toggle is drawn, and the disclosure's description then names only
// what it still holds (settings & notes, and fetching first): it never says "change".

import { useId, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { CONSENT_SHEET, CONSENT_UI, excludedFooter } from './copy.js';
import { isOfferable, type RankedSource, type RankedSources } from './relevance.js';
import { TableChooser, type TableTick } from './TableChooser.js';

/** The chosen source's options (D-PR3-23): its settings & notes, and fetch-first. */
export interface SourceOptions {
  kv: boolean;
  refresh: boolean;
}

export interface SourcePickerProps {
  candidates: RankedSources;
  /** The chosen app's id, if one is chosen. */
  chosenAppId: string | undefined;
  /** The asking app's library name — the undo note under a ticked write names it. */
  readerName: string;
  /** The ticked tables of an app, with their choices. */
  tickedOf: (appId: string) => Readonly<Record<string, TableTick>>;
  /** An app's options row, as ticked. */
  optionsOf: (appId: string) => SourceOptions;
  /** Whether *more options…* is open — the sheet's state, read by the table rows too. */
  optionsOpen: boolean;
  onOptionsOpen: (open: boolean) => void;
  onChoose: (appId: string) => void;
  onToggle: (appId: string, table: string, on: boolean) => void;
  onColumn: (appId: string, table: string, column: string, on: boolean) => void;
  onWrite: (appId: string, table: string, on: boolean) => void;
  onOption: (appId: string, option: keyof SourceOptions, on: boolean) => void;
  showMore: boolean;
  onShowMore: () => void;
  /** The radio group's `name` and the id of the section title that labels it. */
  groupName: string;
  labelledBy: string;
  /** PR-5 (D-PR5-5): `false` on a source's offer — no table may be changed, so no write toggle. Default `true`. */
  canChange?: boolean;
}

function summary(source: RankedSource): string {
  return source.tables
    .filter(isOfferable)
    .map((table) => CONSENT_UI.tableRows(table.name, table.rowCount))
    .join(' · ');
}

interface SourceOptionsRowProps {
  source: RankedSource;
  options: SourceOptions;
  onOption: (option: keyof SourceOptions, on: boolean) => void;
}

/** The two options under the chosen source, each a box with its sentence and its hint (the sentences are pinned by text, U-Q15). */
function SourceOptionsRow({ source, options, onOption }: SourceOptionsRowProps): ReactElement {
  const name = source.displayName;
  return (
    <div className="access-options">
      <div className="access-option">
        <label className="check-label">
          <input type="checkbox" checked={options.kv} data-testid="access-kv" onChange={(event) => onOption('kv', event.target.checked)} />
          <span>{CONSENT_SHEET.settingsAndNotes(name)}</span>
        </label>
        <p className="hint">{CONSENT_SHEET.settingsAndNotesHint(name)}</p>
      </div>
      <div className="access-option">
        <label className="check-label">
          <input type="checkbox" checked={options.refresh} data-testid="access-refresh" onChange={(event) => onOption('refresh', event.target.checked)} />
          <span>{CONSENT_SHEET.fetchFirst(name)}</span>
        </label>
        <p className="hint">{CONSENT_SHEET.fetchFirstHint(name)}</p>
      </div>
    </div>
  );
}

export function SourcePicker({
  candidates,
  chosenAppId,
  readerName,
  tickedOf,
  optionsOf,
  optionsOpen,
  onOptionsOpen,
  onChoose,
  onToggle,
  onColumn,
  onWrite,
  onOption,
  showMore,
  onShowMore,
  groupName,
  labelledBy,
  canChange = true,
}: SourcePickerProps): ReactElement {
  /** The *more options…* summary's description (UI-2): one id per picker, suffixed by the chosen source. */
  const optionsHintId = useId();
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
                <>
                  <TableChooser
                    source={source}
                    readerName={readerName}
                    ticked={tickedOf(source.appId)}
                    optionsOpen={optionsOpen}
                    canChange={canChange}
                    onToggle={(table, on) => onToggle(source.appId, table, on)}
                    onColumn={(table, column, on) => onColumn(source.appId, table, column, on)}
                    onWrite={(table, on) => onWrite(source.appId, table, on)}
                  />
                  {/* The summary's description for a screen reader (UI-2): opening it also puts a change toggle on each ticked table above — except on an offer, which has none (D7). */}
                  <span id={`${optionsHintId}-${source.appId}`} className="visually-hidden">
                    {canChange ? CONSENT_SHEET.moreOptionsHint : CONSENT_SHEET.moreOptionsOfferHint}
                  </span>
                  <details
                    className="access-disclosure access-options-more"
                    data-testid="access-options-more"
                    open={optionsOpen}
                    onToggle={(event) => onOptionsOpen((event.target as HTMLDetailsElement).open)}
                  >
                    <summary aria-describedby={`${optionsHintId}-${source.appId}`}>{CONSENT_SHEET.moreOptions}</summary>
                    <SourceOptionsRow source={source} options={optionsOf(source.appId)} onOption={(option, on) => onOption(source.appId, option, on)} />
                  </details>
                </>
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
