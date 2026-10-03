import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { parseBuildPrompt } from '../agent/chips.js';
import { ProtectionOffer } from '../vault/ProtectionOffer.js';
import { DesktopWelcome } from '../desktop/DesktopWelcome.js';
import { useDesktopFirstRun } from '../desktop/firstRun.js';
import { availabilityOf, needsOfConnections, needsOfRequirement, offersOf, type AppNeed } from '../platform/availability.js';
import { getPlatform } from '../platform/platform.js';
import { useLibraryRevision } from '../platform/signals.js';
import { refreshAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { mintBuildThread } from '../state/buildThread.js';
import { userLibrary, type LibraryEntry } from '../state/library.js';
import { listStarterApps, starterInstallSource } from '../starter/starterApps.js';
import { starterLook } from '../starter/starterLooks.js';
import { starterUpdateStatus } from '../starter/starterUpdate.js';
import { getUserDb } from '../state/userdb.js';
import { SharedShelf } from '../share/SharedShelf.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Chip } from '../ui/Chip.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';
import { TileBlockedNote, keepsWebDesktopBadge } from './AvailabilityNote.js';

/**
 * `needs` rides the list it describes (TASK-20261003 S3): what each installed app asks of
 * its host, resolved in the SAME step as the entries, so a tile's first paint already knows
 * whether this host runs it. An app absent from the map has no connection row and needs
 * nothing.
 */
type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; entries: LibraryEntry[]; needs: ReadonlyMap<string, readonly AppNeed[]> }
  | { phase: 'error'; message: string };

/**
 * The hub route. ONE full-screen gate sits in front of the shelf: the desktop welcome
 * (TASK-20260812 P3 item 1), which asks a question the hub cannot work without.
 *
 * The protection offer (TASK-20260820, D3) is deliberately NOT a second gate. It was
 * one for about an hour, and the e2e suite caught what that costs: 24 specs timed out
 * waiting for a starter tile, because a brand-new profile met a full-screen "protect
 * this file?" and never reached the shelf. The product defect underneath the test
 * failure is the real one — asking someone to protect a file before they have seen a
 * single app is asking them to value something they have not been shown. So the offer
 * renders as a dismissible banner INSIDE the hub (`ProtectionOffer`), where it is
 * visible without being a wall.
 *
 * A wrapper component rather than early returns so each branch keeps its own hook list.
 */
export function HubView(): ReactElement {
  const firstRun = useDesktopFirstRun();
  if (firstRun) return <DesktopWelcome />;
  return <HubHome />;
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
  /** Which tile is in rename-edit mode (TASK-20260821 AC1), and its refusal copy. */
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
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
      setLoad((current) => (current.phase === 'ready' ? { ...current, entries: current.entries.filter((e) => e.id !== appId) } : current));
      setConfirmingDelete(undefined);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      deleteLatch.current = undefined;
      setDeleting(undefined);
    }
  }, []);

  /** Commit a rename: unique-or-refuse at the library layer, entries updated in place. */
  const commitRename = useCallback(async (appId: string, name: string): Promise<void> => {
    setRenameError(undefined);
    try {
      await userLibrary().rename(appId, name);
      setLoad((current) =>
        current.phase === 'ready'
          ? { ...current, entries: current.entries.map((e) => (e.id === appId ? { ...e, displayName: name.trim().slice(0, 80) } : e)) }
          : current,
      );
      setRenaming(undefined);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'rename failed');
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

  /**
   * install_source → the version an available starter update would bring (ADR-0045).
   * REPORTING ONLY: the badge below says "update · vN", and the update act itself lives
   * in the run header — the hub-never-writes doctrine (see `openStarter`) stands. The
   * check is async (it reads the bundle lazily), so a tile renders "installed" until its
   * status resolves — a beat of the old truth, never a wrong badge.
   */
  const [updatesBySource, setUpdatesBySource] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (installedBySource.size === 0) return;
    let cancelled = false;
    void getUserDb().then(async (db) => {
      const next = new Map<string, number>();
      for (const [source, appId] of installedBySource) {
        if (!source.startsWith('starter:')) continue;
        const status = await starterUpdateStatus(db, appId).catch(() => undefined);
        if (status?.updateAvailable === true) next.set(source, status.latestVersion);
      }
      if (!cancelled) setUpdatesBySource(next);
    });
    return () => {
      cancelled = true;
    };
  }, [installedBySource]);

  // The library can change UNDERNEATH the hub: on the local runner an agent hands an app in
  // while the user is looking at this shelf (K6). The host says so by bumping this revision.
  const libraryRevision = useLibraryRevision();
  useEffect(() => {
    let cancelled = false;
    // No `setLoad({ phase: 'loading' })` here. The state STARTS as loading, which is the
    // first read's skeleton; a later read — a revision bump — replaces the list IN PLACE.
    // Going back through the loading phase would unmount every tile, and with it a rename
    // the user is in the middle of typing (its text lives in an uncontrolled input).
    void refreshAppMeta();
    userLibrary()
      .list()
      .then(async (entries) => {
        // ONE read of the whole connections table, grouped by app — never a per-tile
        // effect (S3): a shelf of forty apps would otherwise run forty queries and paint
        // forty tiles that each flip a beat later. The same db the list just read.
        const db = await getUserDb();
        const rowsByApp = new Map<string, ReturnType<typeof db.listConnections>>();
        for (const row of db.listConnections()) {
          const rows = rowsByApp.get(row.appId);
          if (rows === undefined) rowsByApp.set(row.appId, [row]);
          else rows.push(row);
        }
        const needs = new Map<string, readonly AppNeed[]>();
        for (const [appId, rows] of rowsByApp) needs.set(appId, needsOfConnections(rows));
        if (!cancelled) setLoad({ phase: 'ready', entries, needs });
      })
      .catch(() => {
        // A REFRESH that fails keeps the shelf it had: the user was reading that list, and
        // the next bump (or a reload) reads again. Only a first read that fails is an error.
        if (!cancelled) setLoad((current) => (current.phase === 'ready' ? current : { phase: 'error', message: 'could not open your snug file.' }));
      });
    return () => {
      cancelled = true;
    };
  }, [libraryRevision]);

  // What this host offers (ADR-0072 §4) — read from the platform's seats, which are set
  // once before boot, so this is the same answer on every render.
  const offers = offersOf(getPlatform());

  const startBuild = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    // A NEW app gets a NEW thread (ADR-0062 D2). Before this the idea continued whatever
    // thread the tab held — and if that thread was pinned to an app, the "new" idea
    // silently became an edit of it.
    mintBuildThread();
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
          build something that <span style={{ color: 'var(--ember)' }}>belongs to you.</span>
        </h1>
        <p>
          describe a small app and the agent writes it. run it against the host&rsquo;s intelligence,
          keep its state, and export the whole thing as a <code>.snug</code> file.
        </p>
      </div>

      <div className="create-bar">
        <input
          value={idea}
          placeholder="describe an app you wish existed… a chess coach, a habit tracker, a quiz host"
          aria-label="describe the app to build"
          onChange={(event) => setIdea(event.target.value)}
          onKeyDown={onIdeaKeyDown}
        />
        <Button variant="primary" onClick={() => startBuild(idea)} disabled={idea.trim() === ''}>
          build
        </Button>
      </div>

      {/* Below the create bar, above the shelf: seen on the way to the apps, never
          instead of them. Renders nothing once protection is on or the offer is
          declined. */}
      <ProtectionOffer />
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
          lesson="type an idea above — your first app takes about a minute. build it here, take it with you."
        />
      ) : (
        <div className="tile-grid">
          {load.entries.map((entry) => {
            const meta = metaMap[entry.id];
            // --tile-glow derives from --tile-color in app.css (color-matched hover glow).
            const style = { '--tile-color': meta?.iconColor ?? 'var(--ember)' } as CSSProperties;
            const name = meta?.displayName !== undefined && meta.displayName !== '' ? meta.displayName : entry.displayName;
            const armed = confirmingDelete === entry.id;
            // The same verdict the app's starter would get, from the rows the list
            // resolution read (S3). A blocked tile is not itself a link — opening the app is
            // the one thing this host cannot do. Rename and delete stay, and the note's quiet
            // `details` link leads to the run route: the app is still the user's, and that
            // route's header is where it is exported from.
            const verdict = availabilityOf(load.needs.get(entry.id) ?? [], offers);
            const blocker = verdict.ok ? undefined : verdict.blockers[0];
            const noteId = `tile-blocked-${entry.id}`;
            const face = (
              <>
                <span className="tile-emoji" aria-hidden="true">
                  {meta?.iconEmoji ?? '⬡'}
                </span>
                <span className="tile-name">{name}</span>
                <span className="tile-sub">{meta?.description ?? new Date(entry.createdAt).toLocaleDateString()}</span>
              </>
            );
            // The Card CONTAINS the Link (rather than the Link wrapping the Card) so the
            // delete action is a sibling of the navigation, not nested inside it — a
            // button inside an <a> would navigate into the app on click (AC22).
            return (
              <Card
                key={entry.id}
                interactive={blocker === undefined}
                className={`app-tile${blocker !== undefined ? ' is-blocked' : ''}`}
                style={style}
                data-testid="installed-tile"
              >
                {blocker === undefined ? (
                  <Link to={`/run/${entry.id}`} className="tile-link" style={{ color: 'inherit' }}>
                    {face}
                  </Link>
                ) : (
                  <>
                    {/* aria-disabled, never `disabled`: the control stays in the tab order so
                        the reason it points at is reachable by keyboard. It has no handler —
                        activating it does nothing. */}
                    <button
                      type="button"
                      className="tile-link tile-card-button"
                      aria-disabled="true"
                      aria-describedby={noteId}
                      title={`${name} can’t run here — ${blocker.sentence}`}
                    >
                      {face}
                    </button>
                    <TileBlockedNote id={noteId} blocker={blocker} details={{ to: `/run/${entry.id}`, name }} />
                  </>
                )}
                {renaming === entry.id ? (
                  <div className="tile-confirm tile-rename-editor" role="group" aria-label={`rename ${name}`}>
                    <input
                      data-testid="app-rename-input"
                      defaultValue={name}
                      autoFocus
                      aria-label={`new name for ${name}`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void commitRename(entry.id, (event.target as HTMLInputElement).value);
                        }
                        if (event.key === 'Escape') {
                          setRenameError(undefined);
                          setRenaming(undefined);
                        }
                      }}
                    />
                    <Button
                      variant="primary"
                      data-testid="app-rename-save"
                      onClick={(event) => {
                        const input = (event.currentTarget.parentElement?.querySelector('input') ?? null) as
                          | HTMLInputElement
                          | null;
                        if (input !== null) void commitRename(entry.id, input.value);
                      }}
                    >
                      save
                    </Button>
                    <Button
                      variant="ghost"
                      data-testid="app-rename-cancel"
                      onClick={() => {
                        setRenameError(undefined);
                        setRenaming(undefined);
                      }}
                    >
                      cancel
                    </Button>
                    {renameError !== undefined ? (
                      <span className="error-note" role="alert">
                        {renameError}
                      </span>
                    ) : null}
                  </div>
                ) : armed ? (
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
                  <div className="tile-actions">
                    <Button
                      variant="ghost"
                      className="tile-rename"
                      data-testid="app-rename"
                      onClick={() => {
                        setRenameError(undefined);
                        setRenaming(entry.id);
                        setConfirmingDelete(undefined);
                      }}
                      title={`rename ${name}`}
                      aria-label={`rename ${name}`}
                    >
                      rename
                    </Button>
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
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/*
        "shared with you" (TASK-20260904, ADR-0063) sits between the user's own apps and
        the starters: it is the shelf of apps other PEOPLE handed this user — not yet
        theirs, not first-party. Renders nothing when the shelf is empty (no empty-state
        noise), reports only (the install act lives in the preview's header — the
        hub-never-writes doctrine, see `openStarter`).
      */}
      <SharedShelf installedBySource={installedBySource} />

      <h2 className="section-title">starter apps</h2>
      {starters.length === 0 ? (
        <EmptyState glyph="⬡" title="no starters bundled" lesson="the examples/ folder ships curated apps in the full build." />
      ) : (
        <div className="tile-grid">
          {starters.map((starter) => {
            const look = starterLook(starter.name.replace(/ /g, '-'));
            // What the USER reads. `starter.name` is the folder (the identity every
            // downstream rule keys on); the look's optional `name` is what the app calls
            // itself. Falling back to the folder keeps an unnamed starter honest.
            const label = look.name ?? starter.name;
            const style = { '--tile-color': look.color } as CSSProperties;
            const source = starterInstallSource(starter.id);
            const installed = installedBySource.has(source);
            const updateTo = updatesBySource.get(source);
            // Can THIS host run it? (S2, ADR-0072 §4.) Derived from the connection the
            // starter declares against the seats this platform carries — synchronously, so
            // the answer is in the first paint. It used to be a `desktopOnly` flag checked
            // against `kind !== 'desktop'`: locked under the local runner where Trade
            // Copilot works, and wide open inside an artifact with no connections at all.
            const verdict = availabilityOf(needsOfRequirement(starter.requirement), offers);
            const blocker = verdict.ok ? undefined : verdict.blockers[0];
            // The WEB shelf keeps the rendering it has always had — the `desktop` tag, the
            // disabled button — and only its reason changes. Everywhere else the reason is
            // visible text under the tile.
            const webBadge = blocker !== undefined && keepsWebDesktopBadge(blocker);
            const noted = blocker !== undefined && !webBadge;
            const noteId = `tile-blocked-${starter.id}`;
            // AC18: installing is now an EXPLICIT act. The tile itself no longer
            // installs on click — an uninstalled starter offers "install", an installed
            // one offers "open" and routes to the user's OWN copy. Clicking a starter
            // must never quietly write into the user's snug file.
            return (
              <Card
                key={starter.id}
                interactive={!noted}
                className={`app-tile${noted ? ' is-blocked' : ''}`}
                style={style}
                data-testid="starter-tile"
                data-starter-name={starter.name}
              >
                {/*
                  "update · vN" REPLACES "installed" (ADR-0045) and gets its OWN class
                  for the same strict-selector reason the desktop badge documents below:
                  `dedup.spec.ts` uses `.tile-installed-badge` as a single-element proof.
                  Clicking the card still only OPENS the copy; the update button is in
                  the run header it opens.
                */}
                {installed ? (
                  updateTo !== undefined ? (
                    <span className="tile-update-badge" data-testid="starter-update-badge">
                      update · v{updateTo}
                    </span>
                  ) : (
                    <span className="tile-installed-badge">installed</span>
                  )
                ) : null}
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
                {webBadge ? (
                  // ADR-0047 (TASK-20260821): the badge is now the LINK to the /download
                  // page — it sits beside (not inside) the disabled tile button, so it
                  // stays clickable while the tile itself refuses.
                  // TASK-20260821-site-playground-polish AC3 (owner call): a plain
                  // "desktop" tag; the title keeps the full why + the free download.
                  <Link
                    to="/download"
                    className="tile-desktop-badge"
                    data-testid="desktop-only-badge"
                    title={`needs the Snug desktop app (a free download) — ${blocker.sentence}`}
                  >
                    desktop
                  </Link>
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
                  disabled={webBadge}
                  // Off the web a blocked tile is aria-disabled, never `disabled`: it stays
                  // in the tab order so the reason it points at is reachable by keyboard,
                  // and it carries no handler — activating it does nothing.
                  {...(noted ? { 'aria-disabled': true, 'aria-describedby': noteId } : { onClick: () => openStarter(starter.id) })}
                  // An explicit name: the card's own text is the blurb, which reads as
                  // a description rather than an action. "open chess" says what the
                  // control DOES, which is what a screen reader (and the E2E) needs.
                  aria-label={`open ${label}`}
                  title={
                    blocker !== undefined
                      ? webBadge
                        ? `${label} needs the free desktop app — ${blocker.sentence}`
                        : `${label} can’t run here — ${blocker.sentence}`
                      : installed
                        ? `open your copy of ${label}`
                        : `open ${label} — it stays read-only until you install it`
                  }
                >
                  <span className="tile-emoji" aria-hidden="true">
                    {look.emoji}
                  </span>
                  <span className="tile-name">{label}</span>
                  <span className="tile-sub">
                    {noted
                      ? // "try it first" would be an offer this host cannot keep.
                        look.blurb
                      : installed
                        ? updateTo !== undefined
                          ? `${look.blurb} — update available, open your copy to take it`
                          : `${look.blurb} — already in your snug file, opens your copy`
                        : `${look.blurb} — try it first, install it if you like it`}
                  </span>
                </button>
                {noted ? <TileBlockedNote id={noteId} blocker={blocker} /> : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
