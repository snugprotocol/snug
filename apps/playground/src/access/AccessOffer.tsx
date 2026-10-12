// access/AccessOffer.tsx — a SOURCE offers itself, on its own ⋈ sheet under *what reads Ledger*
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-5; AC35; D6, D7).
//
// Shown ONLY when this app has at least one registered table, is not a sidecar-fact source, and at
// least one other app qualifies (it may use access, and holds no live access from this app) — the
// sheet decides that from the file and hands the apps in: heading `ACCESS_SHEET.offerTitle(source)`
// (a sub-heading, so the act still sits under the direction it belongs to), a picker named
// `ACCESS_SHEET.offerPick`, and the act `ACCESS_SHEET.offer(reader, source)` — never the
// reader-side creation act. The act starts the READER's ask pinned to this source, offered by it
// (`startUserAsk(reader, {source, offer: true})`): still the person's act, still read-only — the one
// consent sheet offers no write toggle on an offer, and the consent writer refuses one. The sheet
// closes only once the review is sure to open; a refusal keeps it up, with the act line saying why.

import { useId, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '../ui/Button.js';
import { AccessActLine, useAccessAct } from './AccessActLine.js';
import { ACCESS_SHEET } from './copy.js';

/** An app this source could be read by. */
export interface OfferReader {
  appId: string;
  displayName: string;
}

export interface AccessOfferProps {
  /** This app — the source that offers itself. */
  sourceAppId: string;
  sourceName: string;
  /** The apps that qualify, in the order the picker lists them — never empty (the sheet shows no offer then). */
  readers: readonly OfferReader[];
  /** Closes the ⋈ sheet before the review opens. */
  onBeforeAsk: () => void;
}

export function AccessOffer({ sourceAppId, sourceName, readers, onBeforeAsk }: AccessOfferProps): ReactElement | null {
  const act = useAccessAct();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const titleId = useId();
  const reader = readers.find((app) => app.appId === picked) ?? readers[0];
  if (reader === undefined) return null;
  return (
    <div className="access-sheet-section" role="group" aria-labelledby={titleId}>
      <h4 id={titleId} className="access-sheet-subtitle">
        {ACCESS_SHEET.offerTitle(sourceName)}
      </h4>
      <div className="access-sheet-create">
        <select
          className="access-settings-pick"
          aria-label={ACCESS_SHEET.offerPick}
          value={reader.appId}
          onChange={(event) => setPicked(event.target.value)}
          data-testid="access-offer-pick"
        >
          {readers.map((app) => (
            <option key={app.appId} value={app.appId}>
              {app.displayName}
            </option>
          ))}
        </select>
        <Button
          data-testid="access-offer"
          disabled={act.busy}
          onClick={(event) =>
            void act.start(reader.appId, { source: sourceAppId, offer: true, beforeOpen: () => flushSync(onBeforeAsk) }, sourceName, event.currentTarget)
          }
        >
          {ACCESS_SHEET.offer(reader.displayName, sourceName)}
        </Button>
      </div>
      <AccessActLine readerName={reader.displayName} settle={act.settle} onSettle={act.setSettle} />
    </div>
  );
}
