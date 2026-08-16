import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { parseBuildPrompt } from '../agent/chips.js';
import { DesktopWelcome } from '../desktop/DesktopWelcome.js';
import { useDesktopFirstRun } from '../desktop/firstRun.js';
import { getPlatform } from '../platform/platform.js';
import { refreshAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { userLibrary, type LibraryEntry } from '../state/library.js';
import { listStarterApps, starterInstallSource } from '../starter/starterApps.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Chip } from '../ui/Chip.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';

const STARTER_LOOKS: Readonly<Record<string, { emoji: string; color: string; blurb: string; desktopOnly?: boolean }>> = {
  // The keepers (owner curation, TASK-20260815-starter-apps-rebuild).
  chess: { emoji: '♞', color: '#8b5cf6', blurb: 'play an opponent with opinions — no server needed' },
  'flying-pig': { emoji: '🐷', color: '#ec4899', blurb: 'tap to keep a pig airborne — pure offline arcade' },
  'adventure-quest': { emoji: '🐉', color: '#7c3aed', blurb: 'the agent tells the tale — your pack lives in a real file' },
  'quiz-me': { emoji: '🧠', color: '#0284c7', blurb: 'pick any topic, take a five-question quiz, watch scores climb' },
  'trivia-night': { emoji: '🎉', color: '#d97706', blurb: 'pass one device around — game night with zero setup' },
  // The gold-standard connected five (TASK-20260815-starter-apps-rebuild, ADR-0031):
  // each complements its provider's own app rather than cloning it, and each teaches
  // the provider chat lane. Desktop-only where the transport demands it: Coinbase has
  // no browser CORS (native fetch carries it), and the Hue bridge lives on your LAN.
  'trade-copilot': { emoji: '📈', color: '#f59e0b', blurb: 'a copilot grounded in your real Coinbase portfolio — it thinks, you decide', desktopOnly: true },
  spotify: { emoji: '🎧', color: '#10b981', blurb: 'your listening, understood — portraits and trends Spotify forgets' },
  hue: { emoji: '🌗', color: '#e11d48', blurb: 'light as mood — the agent is your lighting designer', desktopOnly: true },
  weather: { emoji: '🌦️', color: '#3b82f6', blurb: 'forecasts turned into decisions — run, ride, water, or wait' },
  github: { emoji: '🗞️', color: '#64748b', blurb: 'what needs you today, before you ask — your queue as a briefing' },
};

type LoadState = { phase: 'loading' } | { phase: 'ready'; entries: LibraryEntry[] } | { phase: 'error'; message: string };

/**
 * The hub route. On a desktop first run (TASK-20260812 P3 item 1) the welcome takes the
 * whole screen — one idea per screen — and the shelf waits until the person has chosen
 * (or skipped). A wrapper component rather than an early return so the two branches
 * keep their own hook lists.
 */
export function HubView(): ReactElement {
  const firstRun = useDesktopFirstRun();
  return firstRun ? <DesktopWelcome /> : <HubHome />;
}

function HubHome(): ReactElement {
  const navigate = useNavigate();
  const metaMap = useAppMetaMap();
  const prompt = useMemo(() => parseBuildPrompt(), []);
  const starters = useMemo(listStarterApps, []);
  const [idea, setIdea] = useState('');
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  /** Which tile is showing its inline confirm — no window.confirm (design contract, AC22). */
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined);
  /** In-flight latch for delete: one confirm = one delete. */
  const [deleting, setDeleting] = useState<string | undefined>(undefined);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  /**
   * Irreversible: cascades the app's data, schema, docs, versions and chat. The latch is
   * a ref rather than the `deleting` state because two clicks in the SAME tick both read
   * the pre-render state value and would each start a delete (AC22).
   */
  const deleteLatch = useRef<string | undefined>(undefined);
  const confirmDelete = useCallback(async (appId: string): Promise<void> => {
    if (deleteLatch.current !== undefined) return;
    deleteLatch.current = appId;
    setDeleting(appId);
    setDeleteError(undefined);
    try {
      await userLibrary().delete(appId);
      setLoad((current) =>
        current.phase === 'ready' ? { phase: 'ready', entries: current.entries.filter((e) => e.id !== appId) } : current,
      );
      setConfirmingDelete(undefined);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      deleteLatch.current = undefined;
      setDeleting(undefined);
    }
  }, []);

  /** Which starters are already in the user's file — the tile becomes "open" (AC8). */
  const installedBySource = useMemo(() => {
    if (load.phase !== 'ready') return new Map<string, string>();
    const map = new Map<string, string>();
    for (const entry of load.entries) {
      if (entry.installSource !== undefined) map.set(entry.installSource, entry.id);
    }
    return map;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading' });
    void refreshAppMeta();
    userLibrary()
      .list()
      .then((entries) => {
        if (!cancelled) setLoad({ phase: 'ready', entries });
      })
      .catch(() => {
        if (!cancelled) setLoad({ phase: 'error', message: 'could not open your snug file.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startBuild = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    navigate(`/build?idea=${encodeURIComponent(trimmed)}`);
  };

  // Starter "install" is find-or-open now (AC8): the starter's identity travels as
  // `install_source`, so clicking an installed tile opens the EXISTING app — the
  // duplicate-copies bug is dead at the UI, the store, and the DB unique index.
  /**
   * Open a starter WITHOUT installing it (owner-reported: clicking a starter did
   * nothing but install). If the user already has their own copy, go straight there —
   * the install_source map is the single identity rule, so a starter can never be
   * opened twice into two different apps. Otherwise open the read-only starter route,
   * which offers Install from inside the run view.
   *
   * THE HUB HAS NO INSTALL PATH, DELIBERATELY. A local `installStarter` used to live here
   * — dead since AC18 made installing an explicit act inside the run view — and it saved
   * the app HTML and navigated, FULL STOP: no `installStarterConnections`, no
   * `installStarterRuntimeContract`. Rewiring a tile to it would have shipped a connected
   * starter with no connection row and no runtime contract, i.e. an app whose connect card
   * never appears and whose credential is never injected. Deleted in P4 of
   * TASK-20260812-desktop-auth-awareness rather than left as a loaded gun. The ONE install
   * act is RunView's button (`RunView.tsx`), which copies HTML, connection manifest and
   * runtime contract together; keep it that way.
   */
  const openStarter = (starterId: string): void => {
    const source = starterInstallSource(starterId);
    const existing = installedBySource.get(source);
    navigate(existing !== undefined ? `/run/${existing}` : `/run/${starterId}`);
  };

  const onIdeaKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') startBuild(idea);
  };

  return (
    <div>
      <div className="hub-hero">
        <h1>
          talk. build. <span style={{ color: 'var(--ember)' }}>run.</span>
        </h1>
        <p>describe a tiny app and the agent writes it — then run it in a sandbox you can watch think.</p>
      </div>

      <div className="create-bar">
        <input
          value={idea}
          placeholder="build something… a chess coach, a habit tracker, a quiz host"
          aria-label="describe the app to build"
          onChange={(event) => setIdea(event.target.value)}
          onKeyDown={onIdeaKeyDown}
        />
        <Button variant="primary" onClick={() => startBuild(idea)} disabled={idea.trim() === ''}>
          build
        </Button>
      </div>
      <div className="chip-row" aria-label="suggestions">
        {prompt.chips.map((chip) => (
          <Chip key={chip} onClick={() => startBuild(chip)}>
            {chip}
          </Chip>
        ))}
      </div>

      <h2 className="section-title">your apps</h2>
      {deleteError !== undefined ? (
        <div className="error-note" role="alert">
          delete failed — {deleteError}
        </div>
      ) : null}
      {load.phase === 'loading' ? (
        <div className="tile-grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="140px" style={{ borderRadius: 'var(--radius-l)' }} />
          ))}
        </div>
      ) : load.phase === 'error' ? (
        <EmptyState glyph="◌" title="can’t reach your apps" lesson={load.message} />
      ) : load.entries.length === 0 ? (
        <EmptyState
          glyph="✦"
          title="nothing here yet"
          lesson="type an idea above — your first app takes about a minute."
        />
      ) : (
        <div className="tile-grid">
          {load.entries.map((entry) => {
            const meta = metaMap[entry.id];
            // --tile-glow derives from --tile-color in app.css (color-matched hover glow).
            const style = { '--tile-color': meta?.iconColor ?? 'var(--ember)' } as CSSProperties;
            const name = meta?.displayName !== undefined && meta.displayName !== '' ? meta.displayName : entry.displayName;
            const armed = confirmingDelete === entry.id;
            // The Card CONTAINS the Link (rather than the Link wrapping the Card) so the
            // delete action is a sibling of the navigation, not nested inside it — a
            // button inside an <a> would navigate into the app on click (AC22).
            return (
              <Card key={entry.id} interactive className="app-tile" style={style} data-testid="installed-tile">
                <Link to={`/run/${entry.id}`} className="tile-link" style={{ color: 'inherit' }}>
                  <span className="tile-emoji" aria-hidden="true">
                    {meta?.iconEmoji ?? '⬡'}
                  </span>
                  <span className="tile-name">{name}</span>
                  <span className="tile-sub">{meta?.description ?? new Date(entry.createdAt).toLocaleDateString()}</span>
                </Link>
                {armed ? (
                  <div className="tile-confirm" role="group" aria-label={`delete ${name}?`}>
                    <span className="tile-confirm-copy">delete for good?</span>
                    <Button
                      variant="danger"
                      data-testid="app-delete-confirm"
                      disabled={deleting !== undefined}
                      onClick={() => void confirmDelete(entry.id)}
                      title={`permanently delete ${name} and all of its data`}
                    >
                      {deleting === entry.id ? 'deleting…' : 'delete'}
                    </Button>
                    <Button
                      variant="ghost"
                      data-testid="app-delete-cancel"
                      onClick={() => setConfirmingDelete(undefined)}
                    >
                      keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    className="tile-delete"
                    data-testid="app-delete"
                    onClick={() => {
                      setDeleteError(undefined);
                      setConfirmingDelete(entry.id);
                    }}
                    title={`delete ${name}`}
                    aria-label={`delete ${name}`}
                  >
                    delete
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <h2 className="section-title">starter apps</h2>
      {starters.length === 0 ? (
        <EmptyState glyph="⬡" title="no starters bundled" lesson="the examples/ folder ships curated apps in the full build." />
      ) : (
        <div className="tile-grid">
          {starters.map((starter) => {
            const look =
              STARTER_LOOKS[starter.name.replace(/ /g, '-')] ??
              ({ emoji: '⬡', color: 'var(--ember)', blurb: 'curated example — runs without a server' } as const);
            const style = { '--tile-color': look.color } as CSSProperties;
            const source = starterInstallSource(starter.id);
            const installed = installedBySource.has(source);
            // P3 item 5: a desktopOnly starter is LOCKED on web (its device lives on the
            // user's LAN, unreachable from a page) and simply enabled on the desktop
            // shell — where the badge would be a limitation that no longer exists.
            const locked = look.desktopOnly === true && getPlatform().kind !== 'desktop';
            // AC18: installing is now an EXPLICIT act. The tile itself no longer
            // installs on click — an uninstalled starter offers "install", an installed
            // one offers "open" and routes to the user's OWN copy. Clicking a starter
            // must never quietly write into the user's snug file.
            return (
              <Card
                key={starter.id}
                interactive
                className="app-tile"
                style={style}
                data-testid="starter-tile"
                data-starter-name={starter.name}
              >
                {installed ? <span className="tile-installed-badge">installed</span> : null}
                {/*
                  HARVESTED from AL-09 with its bug fix intact. Its OWN class,
                  deliberately — not a reuse of `.tile-installed-badge`. These two badges
                  mean opposite things ("you own this" vs "you cannot run this here"), and
                  sharing the class made `.tile-installed-badge` ambiguous:
                  `dedup.spec.ts` asserts that selector is visible to prove a starter
                  installed exactly once, and a permanently-present desktop badge turned
                  that into a strict-mode violation (two elements). Found by the full
                  Playwright run on the parked branch, 2026-08-08.
                */}
                {locked ? (
                  <span className="tile-desktop-badge" data-testid="desktop-only-badge" title="this starter's device lives on your home network, which a web page cannot reach — the free Snug desktop app can">
                    needs the desktop app — free download
                  </span>
                ) : null}
                {/*
                  The CARD is the control (AC1), matching the installed-app tiles above —
                  a separate "open" button on a card that already looks clickable was two
                  affordances for one action. A <button> rather than a <div> so it is
                  focusable, Enter/Space-activated and announced, for free.

                  Opening a starter is BROWSING, not installing (owner: "it should open
                  the starter app without installing and also show Install button when
                  opened on the UI"). An installed starter routes to the user's own copy
                  via install_source, so re-opening never mints a second app; an
                  uninstalled one opens the read-only starter route, which offers Install
                  from inside the run view.
                */}
                <button
                  type="button"
                  className="tile-link tile-card-button"
                  data-testid={installed ? 'starter-open' : 'starter-open-card'}
                  disabled={locked}
                  onClick={() => openStarter(starter.id)}
                  // An explicit name: the card's own text is the blurb, which reads as
                  // a description rather than an action. "open chess" says what the
                  // control DOES, which is what a screen reader (and the E2E) needs.
                  aria-label={`open ${starter.name}`}
                  title={
                    locked
                      ? `${starter.name} needs the free desktop app — a web page cannot reach your home network`
                      : installed
                        ? `open your copy of ${starter.name}`
                        : `open ${starter.name} — it stays read-only until you install it`
                  }
                >
                  <span className="tile-emoji" aria-hidden="true">
                    {look.emoji}
                  </span>
                  <span className="tile-name">{starter.name}</span>
                  <span className="tile-sub">
                    {installed
                      ? `${look.blurb} — already in your snug file, opens your copy`
                      : `${look.blurb} — try it first, install it if you like it`}
                  </span>
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
