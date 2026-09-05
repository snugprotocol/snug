// RunHeaderActions.tsx — the per-app controls in the run header: which model this app
// uses, its connections, and the share control (TASK-20260904-app-sharing).
//
// THE PER-APP `.snug` EXPORT IS GONE (ADR-0063 §2). It was a SQLite slice of the app's
// DATA named `.snug` — byte-indistinguishable from a whole user file, so the desktop
// open path would have offered to REPLACE the recipient's file with it. Sharing an app
// is now the share sheet (code + connection shapes + docs, never data); the whole-file
// export stays in Settings. The dormant control, its flag and its two props are deleted,
// and their tests are classified in the task journal (lesson 2026-08-10).
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
//      locators find (the Settings 'export snug file' surface carries the load-bearing
//      export string; docs/lessons.md 2026-08-18 rule).
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
import { allows } from '../platform/platform.js';
import { ModelSelect } from './ModelSelect.js';
import { AuthRepairChip } from './AuthRepairChip.js';

export interface RunHeaderActionsProps {
  /** The library id of the app whose header this is. */
  appId: string;
  /** A read-only preview the user does not own yet — a bundled starter or a shared bundle. */
  isStarter: boolean;
  /** How many connection rows this app has, connected or not. */
  connectionSlots: number;
  /**
   * Linked-device sync state, pump-reported (ADR-0037 §4). Undefined for the
   * overwhelmingly common case — an app with no sidecar connection — and the capsule
   * renders only while one of its two phases (history, then names) is actually live.
   */
  syncState?: {
    progress: number;
    complete: boolean;
    needsRelink?: true;
    rosters?: { loaded: number; total: number };
    names?: number;
  };
  onManageConnections: () => void;
  /**
   * Opens the share sheet (ADR-0063). Supplied for OWNED apps only — a preview has
   * nothing of the user's to share — so absence hides the control.
   */
  onShare?: () => void;
}

export function RunHeaderActions({
  appId,
  isStarter,
  connectionSlots,
  syncState,
  onManageConnections,
  onShare,
}: RunHeaderActionsProps): ReactElement {
  return (
    <>
      {/*
        THE SYNC CAPSULE (owner ask, 2026-08-18): one quiet pill, two honest phases. While
        WhatsApp pushes history it reads "Syncing · N%"; once that completes it hands over
        to "Names · n/m" while the paced roster sweep resolves group members — the phase
        that used to be invisible, which read as "names stopped arriving". Gone entirely
        when both finish (or on a wedge — the app surface owns that story). Leads the
        cluster so it reads as a status of the app, not one more control. `role="status"`
        + aria-label because a glyph and bare numbers announce nothing (this file's own
        rule #1) — and the label is what tests locate, so it is load-bearing.
      */}
      {(() => {
        if (syncState === undefined || syncState.needsRelink === true) return null;
        const phase = !syncState.complete
          ? ('history' as const)
          : syncState.rosters !== undefined && syncState.rosters.loaded < syncState.rosters.total
            ? ('names' as const)
            : undefined;
        if (phase === undefined) return null;
        const percent = Math.round(syncState.progress);
        const rosters = syncState.rosters;
        const tooltip = [
          `history ${syncState.complete ? 100 : percent}%`,
          rosters !== undefined ? `group names ${rosters.loaded} of ${rosters.total}` : undefined,
          syncState.names !== undefined ? `${syncState.names} contacts named` : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <span
            className="run-sync-progress"
            data-testid="sidecar-sync-progress"
            role="status"
            aria-label={
              phase === 'history'
                ? `history sync ${percent}% complete`
                : `resolving names — ${rosters!.loaded} of ${rosters!.total} groups`
            }
            title={`syncing from your phone — ${tooltip}`}
          >
            <span className="run-sync-glyph" aria-hidden="true">
              ⟳
            </span>
            <span className="run-sync-text">
              {phase === 'history' ? `Syncing · ${percent}%` : `Names · ${rosters!.loaded}/${rosters!.total}`}
            </span>
          </span>
        );
      })()}
      {/*
        The model selector leads the cluster (owner ask: swapped with connections).
        It is the widest control and the only non-button, so it reads as a setting the
        app carries rather than as one more action — and the two icon buttons then sit
        together as a pair instead of being split by a dropdown.

        Starters are excluded: a read-only starter has no app row to key a pick to, and
        the pick would be lost the moment it was installed (install mints a new id).
      */}
      {!isStarter && allows('brainSettings') ? <ModelSelect appId={appId} /> : null}
      {/*
        THE FAILURE CHIP (TASK-20260819) sits immediately before the connections door it
        opens, so the standing note and the way to act on it read as one control rather
        than as an alert that happens to be near a button. It renders only when a live
        auth-shaped failure names THIS app, and hides itself while the wizard is open.
      */}
      {allows('connections') ? <AuthRepairChip appId={appId} /> : null}
      {/*
        AC9 (TASK-20260813) — the connections door, in the ONE place the owner asked for
        it: the app's own header. Shown whenever this app has connection rows, connected
        or not; Settings keeps the cross-app list. Starters are excluded because their
        declaration is a bundled manifest with no persisted rows yet — a control here
        would open an empty wizard.
      */}
      {connectionSlots > 0 && !isStarter && allows('connections') ? (
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
      {/*
        THE SHARE CONTROL (TASK-20260904, AC10) — last in the cluster, which places it
        between the connections door and RunView's theme toggle (owner ask). Owned apps
        only: `onShare` is absent for a starter or a shared preview. Glyph `⇪` — the
        share arrow, monochrome like its neighbours; the accessible name is "share".
      */}
      {onShare !== undefined && !isStarter && allows('share') ? (
        <Button
          variant="ghost"
          onClick={onShare}
          className="btn-icon"
          data-testid="share-app"
          aria-label="share"
          title="share this app — code, connection shapes and docs; never your data or keys"
        >
          ⇪
        </Button>
      ) : null}
    </>
  );
}
