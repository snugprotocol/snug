// AvailabilityNote.tsx — how a "this host can't run that app" verdict LOOKS (TASK-20261003
// S2/S3, ADR-0072 §4). The verdict itself is `platform/availability.ts`'s; nothing here
// decides anything. Three renderings share one grammar:
//
//   the web shelf's badge   — the `desktop` tag the web hub has always shown (unchanged)
//   the tile note           — the reason as visible text under a blocked tile, and where it runs
//                             (an installed app's note also carries a `details` door to its run route)
//   the run-route panel     — the same, with room for the whole sentence
//
// A blocked app must read as "this exists, and here is what it needs" — never as an error.
// So: no red, no "unsupported", the app's own emoji and name stay legible, the reason is a
// quiet pill led by a small glyph for the need, and where the app DOES run is the one thing
// styled as a link.

import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { RUNS_IN_LABEL, type AppNeed, type AvailabilityBlocker, type RunsIn } from '../platform/availability.js';
import { getPlatform } from '../platform/platform.js';

/**
 * Does the WEB shelf keep its `desktop` badge for this verdict?
 *
 * Presentation of a verdict already taken, and the one place the shelf reads the platform's
 * kind: the web hub has shown a `desktop` tag linking to /download since TASK-20260821, the
 * e2e suite clicks it by coordinates, and ADR-0072 §4 keeps it ("the web shelf's `desktop`
 * badge is unchanged") — only the reason in its title becomes the true one. Every other host
 * (and any web verdict the desktop would not fix) gets the visible tile note instead.
 */
export function keepsWebDesktopBadge(blocker: AvailabilityBlocker): boolean {
  return getPlatform().kind === 'web' && blocker.runsIn.includes('desktop');
}

const PLUG = (
  <>
    <path d="M6 1.75v3M10 1.75v3" />
    <path d="M4 4.75h8v2.5a4 4 0 0 1-8 0z" />
    <path d="M8 11.25v3" />
  </>
);

/** One 16-unit line drawing per need: a plug for a connection, a key, a house, a phone. */
const NEED_GLYPH_PATHS: Readonly<Record<AppNeed, ReactElement>> = {
  network: PLUG,
  'native-fetch': PLUG,
  oauth: (
    <>
      <circle cx="5" cy="8" r="2.75" />
      <path d="M7.75 8h6.5M12 8v2.5" />
    </>
  ),
  lan: (
    <>
      <path d="M2 7.5 8 2.25l6 5.25" />
      <path d="M3.75 6.5v7h8.5v-7" />
    </>
  ),
  helper: (
    <>
      <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" />
      <path d="M7.25 12h1.5" />
    </>
  ),
};

/** The need, as a 14px line glyph that takes the text colour (an emoji would not restyle with the theme). */
function NeedGlyph({ need }: { need: AppNeed }): ReactElement {
  return (
    <svg className="need-glyph" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {NEED_GLYPH_PATHS[need]}
    </svg>
  );
}

/**
 * One place an app runs, as the most honest affordance this host can offer for it. The
 * desktop is a real action — the /download route exists on every host. The runner and the
 * web playground are text: there is no link from a page to "your agent", and a hosted URL
 * opened from inside someone else's artifact frame is a promise this page cannot keep.
 */
function RunsInTarget({ host }: { host: RunsIn }): ReactElement {
  if (host === 'desktop') {
    return (
      <Link to="/download" className="runs-in-link" data-testid="runs-in-desktop">
        {RUNS_IN_LABEL.desktop}
      </Link>
    );
  }
  return <span className="runs-in-text">{RUNS_IN_LABEL[host]}</span>;
}

/**
 * The places worth sending someone, from where they ARE.
 *
 * A blocker's `runsIn` names host CLASSES — each runs the app when nothing is wrong with it.
 * The runner is the one class that can be degraded while the user is inside it (its fixed
 * sign-in port was taken; another product holds the file), and there the list would say
 * "runs in … your agent's plugin" to someone reading it in their agent's plugin, about the
 * host that just said no (the round-1 verifier's finding, 2026-10-03). So that class is left
 * out when this page IS the runner. Presentation of a verdict already taken, like the web
 * badge above; the derivation stays a pure table. The list cannot empty: the desktop meets
 * every need and is never the class dropped.
 */
function elsewhere(runsIn: readonly RunsIn[]): readonly RunsIn[] {
  // `local-host` is how presentation recognises the runner; a later range (K2) makes that binding mean ONLY a real runner (a loopback static page becomes file-class).
  return getPlatform().binding === 'local-host' ? runsIn.filter((host) => host !== 'runner') : runsIn;
}

/** "runs in Snug for Mac · your agent’s plugin" — every place that is somewhere else, most capable first. */
function RunsInList({ runsIn }: { runsIn: readonly RunsIn[] }): ReactElement {
  return (
    <span className="runs-in" data-testid="tile-runs-in">
      <span className="runs-in-lead">runs in </span>
      {elsewhere(runsIn).map((host, index) => (
        <span key={host}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <RunsInTarget host={host} />
        </span>
      ))}
    </span>
  );
}

export interface TileBlockedNoteProps {
  id: string;
  blocker: AvailabilityBlocker;
  /**
   * An INSTALLED app's door to its own run route: where it leads, and the app's name (the
   * link's accessible name says WHICH app, in a list of links). Absent for a starter —
   * nothing of the user's is in it yet, so there is nothing to take anywhere.
   */
  details?: { to: string; name: string };
}

/**
 * The note under a blocked tile: the first blocker's title as visible text, and where the
 * app runs. `id` is what the tile's control points `aria-describedby` at, so the reason is
 * read with the control that will not activate.
 *
 * WHY `details` LIVES HERE. The tile's control has no handler, and until this link the run
 * route of a blocked installed app was reachable only by typing its URL — yet that route is
 * the one that explains the block and keeps the header, so it is where a blocked app is
 * exported from (round-2 verifier's finding; orchestrator decision, 2026-10-03). It sits in
 * the note rather than beside rename and delete because that row is REPLACED by the delete
 * confirm, which is exactly the moment someone asks "can I take it with me first?".
 */
export function TileBlockedNote({ id, blocker, details }: TileBlockedNoteProps): ReactElement {
  return (
    <div className="tile-blocked" id={id}>
      <span className="tile-blocked-reason" data-testid="tile-blocked-reason">
        <NeedGlyph need={blocker.need} />
        {blocker.title}
      </span>
      <RunsInList runsIn={blocker.runsIn} />
      {details !== undefined ? (
        <Link
          to={details.to}
          className="tile-blocked-details"
          data-testid="tile-blocked-details"
          aria-label={`details for ${details.name}`}
          title={`why ${details.name} can’t run here, and what you can still do with it`}
        >
          details
        </Link>
      ) : null}
    </div>
  );
}

export interface RunBlockedProps {
  /** The app's own identity — it never announced, so the caller supplies what the shelf showed. */
  name: string;
  emoji: string;
  blockers: readonly AvailabilityBlocker[];
}

/**
 * What the run route shows INSTEAD of the app frame when this host cannot run the app: what
 * it needs, why this host cannot give it, where it runs. It replaces the frame, never the
 * view — the run header above it keeps export, versions, docs and the connections door, so
 * a blocked app can still be taken somewhere that runs it.
 */
export function RunBlocked({ name, emoji, blockers }: RunBlockedProps): ReactElement | null {
  const first = blockers[0];
  if (first === undefined) return null;
  return (
    <div className="run-blocked" data-testid="run-blocked" role="status">
      <div className="run-blocked-card">
        <span className="run-blocked-emoji" aria-hidden="true">
          {emoji}
        </span>
        <h2 className="run-blocked-title">{name} can’t run here</h2>
        <ul className="run-blocked-needs" aria-label={`what ${name} needs`}>
          {blockers.map((blocker) => (
            <li key={blocker.need} className="run-blocked-need" data-testid="run-blocked-need" data-need={blocker.need}>
              <span className="tile-blocked-reason">
                <NeedGlyph need={blocker.need} />
                {blocker.title}
              </span>
              <span className="run-blocked-sentence">{blocker.sentence}.</span>
            </li>
          ))}
        </ul>
        <div className="run-blocked-runs-in" data-testid="run-blocked-runs-in">
          <span className="run-blocked-runs-in-lead">it runs in</span>
          <ul>
            {elsewhere(first.runsIn).map((host) => (
              <li key={host} data-runs-in={host}>
                {host === 'desktop' ? (
                  <Link to="/download" className="btn btn-primary" data-testid="run-blocked-download">
                    {RUNS_IN_LABEL.desktop}
                  </Link>
                ) : (
                  <span className="run-blocked-place">
                    <strong>{RUNS_IN_LABEL[host]}</strong>
                    {host === 'runner' ? ' — open Snug from your agent' : ' — in a browser'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <Link to="/" className="run-blocked-back">
          back to your apps
        </Link>
      </div>
    </div>
  );
}
