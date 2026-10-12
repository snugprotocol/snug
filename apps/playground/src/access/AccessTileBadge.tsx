// access/AccessTileBadge.tsx — ONE line per Hub tile about access between apps
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-6, D-PR5-6a, D-PR5-7; D2, D3, F16, S11).
//
// THE ACCESS LINE (`AccessTileBadge`): a small muted line in normal flow after `.tile-sub`, inside
// the tile's face — the link branch and the blocked branch alike — the ⋈ glyph hidden from
// assistive tech, then the VISIBLE words `HUB_TILE.accessWords(reads, readBy)`, which so become
// part of the link's name. Never absolutely positioned (the owned tile's hover delete sits top
// right); no line at 0. Report-only: no act of its own.
//
// THE *COULD READ* SIBLING (`AccessTileCouldRead`): when the app has no live access but a pair
// names it as the reader, a button BESIDE the link (never inside it — a button in an <a> would
// navigate) with `HUB_TILE.couldRead` and the name `HUB_TILE.couldReadName`, the source's name in a
// `<bdi>`; host words only, never the app's purpose. Its tap starts the declared ask pinned to that
// source, and its act line sits beside it — it stays mounted for the tile, so the line outlives
// the button an allow takes away (the tile then carries its access line instead).
//
// THE DATA is read ONCE per shelf, in `HubHome`, through `useHubAccess` — gated by the host's
// access surface, refreshed on the access and library revisions and by ONE timer at the nearest
// expiry (at most a day, re-armed when it fires, cleared on unmount), never per tile; the file's
// grants are read once per refresh and shared by the counts, the pairs and the timer (Gate-5 IB-7).
// The clock is the wall clock read at the call: an expiry is a moment on it, like every date on
// the shelf. A pair whose access is paused or expired is no *could read* (G5-14): *allow again* on
// that row is the act. The sibling is disabled while its ask is in flight (IB-5).

import { useEffect, useState, type ReactElement } from 'react';

import type { AccessWants } from '@snugprotocol/protocol';

import { useLibraryRevision } from '../platform/signals.js';
import { HUB_TILE } from './copy.js';
import { AccessActLine, isolateNames, useAccessAct } from './AccessActLine.js';
import { accessCountsByApp, accessDeps, expiresAtOf, foundGrants, isLive, useAccessRevision, type AccessCounts } from './grants.js';
import { listPairSuggestions } from './pairs.js';

/** Distinct other apps joined to this one by live access, each way. */
export type AccessTileCounts = AccessCounts;

/** The reader's best pair, for its tile: the source and the declared want it would start the ask from. */
export interface TileCouldRead {
  sourceAppId: string;
  sourceName: string;
  want: AccessWants[number];
}

/** What the shelf knows about access, by app id — an app absent from a map has nothing to say. */
export interface HubAccess {
  counts: ReadonlyMap<string, AccessTileCounts>;
  couldRead: ReadonlyMap<string, TileCouldRead>;
}

export const NO_HUB_ACCESS: HubAccess = Object.freeze({ counts: new Map(), couldRead: new Map() });

/** The longest the shelf waits before reading again: an access with no end, or none at all, still ages. */
const RECHECK_MAX_MS = 24 * 60 * 60 * 1000;

/** The shelf's ONE read of access between apps; `enabled: false` (the host offers no access) reads nothing. */
export function useHubAccess(enabled: boolean): HubAccess {
  const revision = useAccessRevision();
  const library = useLibraryRevision();
  /** Bumped by the expiry timer — the read runs again when the nearest access ends. */
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<HubAccess>(NO_HUB_ACCESS);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const now = Date.now();
        // The file's grants read ONCE (IB-7): the counts, the pairs and the timer share them.
        const found = foundGrants(db);
        const couldRead = new Map<string, TileCouldRead>();
        // Best first (pairs.ts's order): each reader's FIRST pair is its best.
        for (const pair of listPairSuggestions(db, now, { found })) {
          if (!couldRead.has(pair.readerAppId)) couldRead.set(pair.readerAppId, { sourceAppId: pair.sourceAppId, sourceName: pair.sourceName, want: pair.want });
        }
        setData({ counts: accessCountsByApp(db, now, found), couldRead });
        // ONE timer: the nearest end of a live access, never more than a day away (F16).
        const ends = found
          .filter((entry) => isLive(entry.grant, now, db))
          .map((entry) => expiresAtOf(entry.grant))
          .flatMap((at) => (at === undefined ? [] : [Date.parse(at) - now]))
          .filter((left) => left > 0);
        timer = setTimeout(() => setTick((value) => value + 1), Math.min(RECHECK_MAX_MS, ...ends));
      })
      .catch(() => {
        // the file is not open (a swap in flight): the shelf keeps what it last read
      });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, revision, library, tick]);

  return enabled ? data : NO_HUB_ACCESS;
}

// ------------------------------------------------------------------------------- the line

export interface AccessTileBadgeProps {
  counts: AccessTileCounts | undefined;
}

export function AccessTileBadge({ counts }: AccessTileBadgeProps): ReactElement | null {
  const words = counts === undefined ? '' : HUB_TILE.accessWords(counts.reads, counts.readBy);
  if (words === '') return null;
  return (
    <span className="tile-access-line">
      <span aria-hidden="true">⋈</span> {words}
    </span>
  );
}

// ---------------------------------------------------------------------------- the sibling

export interface AccessTileCouldReadProps {
  readerAppId: string;
  readerName: string;
  /** The reader's best pair, when the tile has no live access to show instead. */
  pair: TileCouldRead | undefined;
}

export function AccessTileCouldRead({ readerAppId, readerName, pair }: AccessTileCouldReadProps): ReactElement | null {
  const act = useAccessAct();
  if (pair === undefined && act.settle === undefined) return null;
  return (
    <div className="tile-could-read-slot">
      {pair !== undefined ? (
        <button
          type="button"
          className="btn btn-ghost tile-could-read"
          data-testid="tile-could-read"
          aria-label={HUB_TILE.couldReadName(readerName, pair.sourceName)}
          disabled={act.busy}
          onClick={(event) => void act.start(readerAppId, { declared: pair.want, source: pair.sourceAppId }, pair.sourceName, event.currentTarget)}
        >
          {isolateNames(HUB_TILE.couldRead, pair.sourceName)}
        </button>
      ) : null}
      <AccessActLine readerName={readerName} settle={act.settle} onSettle={act.setSettle} triggerGone={pair === undefined} />
    </div>
  );
}
