// RunHeaderActions.tsx — the per-app controls in the run header: which model this app
// uses, its connections, and the .sqlite export.
//
// Extracted from RunView so the cluster can be tested as a unit (RunView itself needs a
// route, a user DB, a runner and an iframe to render at all). RunView keeps the
// workspace-level controls — theme and the think rail — because those are preferences
// that belong to the window rather than to this app.
//
// ICONS, NOT WORDS (owner ask). Two rules make that safe rather than merely tidy:
//
//   1. A glyph is not a name. `🔌` announces as "electric plug" or as nothing, so each
//      button carries an explicit `aria-label` — which is also what test and e2e
//      locators find (`e2e/starters.spec.ts` looks up the export control by the
//      accessible name "export .sqlite", so that string is load-bearing, not cosmetic).
//   2. `title` is the hover tooltip and NOTHING else. A title alone would leave the
//      control unnamed to a screen reader — the same distinction the rail toggle in
//      RunView already documents.
//
// The glyphs are MONOCHROME, matching the rail tabs' existing vocabulary (`✎ ◍ ✧ ⧉`)
// rather than introducing emoji here. Emoji render in their own fixed colour — the plug
// (🔌) came out as a faint outline that ignored `currentColor`, so it read as disabled
// next to its neighbours and did not restyle with the theme. A geometric glyph inherits
// the button's colour and hover state like every other control in this header.

import type { ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { ModelSelect } from './ModelSelect.js';

export interface RunHeaderActionsProps {
  /** The library id of the app whose header this is. */
  appId: string;
  /** A read-only bundled starter, not yet owned by the user. */
  isStarter: boolean;
  /** How many connection rows this app has, connected or not. */
  connectionSlots: number;
  /** Whether this app has touched its database (the export moment has been earned). */
  canExport: boolean;
  onManageConnections: () => void;
  onExport: () => void;
}

export function RunHeaderActions({
  appId,
  isStarter,
  connectionSlots,
  canExport,
  onManageConnections,
  onExport,
}: RunHeaderActionsProps): ReactElement {
  return (
    <>
      {/*
        The model selector leads the cluster (owner ask: swapped with connections).
        It is the widest control and the only non-button, so it reads as a setting the
        app carries rather than as one more action — and the two icon buttons then sit
        together as a pair instead of being split by a dropdown.

        Starters are excluded: a read-only starter has no app row to key a pick to, and
        the pick would be lost the moment it was installed (install mints a new id).
      */}
      {!isStarter ? <ModelSelect appId={appId} /> : null}
      {/*
        AC9 (TASK-20260813) — the connections door, in the ONE place the owner asked for
        it: the app's own header. Shown whenever this app has connection rows, connected
        or not; Settings keeps the cross-app list. Starters are excluded because their
        declaration is a bundled manifest with no persisted rows yet — a control here
        would open an empty wizard.
      */}
      {connectionSlots > 0 && !isStarter ? (
        <Button
          variant="ghost"
          onClick={onManageConnections}
          className="btn-icon"
          data-testid="manage-connections"
          aria-label="connections"
          title="review, reconnect, or disconnect what this app connects to"
        >
          ⚯
        </Button>
      ) : null}
      {canExport ? (
        <Button
          variant="ghost"
          onClick={onExport}
          className="btn-icon"
          data-testid="export-sqlite"
          // Kept verbatim: two e2e specs locate this button by this exact name.
          aria-label="export .sqlite"
          title="download this app’s database as a real .sqlite file"
        >
          ⤓
        </Button>
      ) : null}
    </>
  );
}
