import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { parseBuildPrompt } from '../agent/chips.js';
import { refreshAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { userLibrary, type LibraryEntry } from '../state/library.js';
import { listStarterApps, loadStarterHtml, STARTER_PREFIX } from '../starter/starterApps.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Chip } from '../ui/Chip.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';

const STARTER_LOOKS: Readonly<Record<string, { emoji: string; color: string; blurb: string }>> = {
  chess: { emoji: '♞', color: '#8b5cf6', blurb: 'play an opponent with opinions — no server needed' },
  'flying-pig': { emoji: '🐷', color: '#ec4899', blurb: 'tap to keep a pig airborne — pure offline arcade' },
  'habit-tracker': { emoji: '✅', color: '#22c55e', blurb: 'track streaks in a real sqlite file you can export' },
};

type LoadState = { phase: 'loading' } | { phase: 'ready'; entries: LibraryEntry[] } | { phase: 'error'; message: string };

export function HubView(): ReactElement {
  const navigate = useNavigate();
  const metaMap = useAppMetaMap();
  const prompt = useMemo(() => parseBuildPrompt(), []);
  const starters = useMemo(listStarterApps, []);
  const [idea, setIdea] = useState('');
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  const [installError, setInstallError] = useState<string | undefined>(undefined);
  /** In-flight latch: a double-click must not race two installs (AC8). */
  const [installing, setInstalling] = useState<string | undefined>(undefined);

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
  const installStarter = (starterId: string, name: string): void => {
    if (installing !== undefined) return;
    const source = `starter:${starterId.slice(STARTER_PREFIX.length)}`;
    const existing = installedBySource.get(source);
    if (existing !== undefined) {
      navigate(`/run/${existing}`);
      return;
    }
    setInstallError(undefined);
    setInstalling(starterId);
    void loadStarterHtml(starterId)
      .then(async (html) => {
        if (html === undefined) throw new Error('starter not bundled');
        const entry = await userLibrary().save(html, name, source);
        navigate(`/run/${entry.id}`);
      })
      .catch((err: unknown) => {
        setInstallError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setInstalling(undefined));
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
            return (
              <Link key={entry.id} to={`/run/${entry.id}`} style={{ color: 'inherit', display: 'block' }}>
                <Card interactive className="app-tile" style={style}>
                  <span className="tile-emoji" aria-hidden="true">
                    {meta?.iconEmoji ?? '⬡'}
                  </span>
                  <span className="tile-name">{meta?.displayName !== undefined && meta.displayName !== '' ? meta.displayName : entry.displayName}</span>
                  <span className="tile-sub">{meta?.description ?? new Date(entry.createdAt).toLocaleDateString()}</span>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <h2 className="section-title">starter apps</h2>
      {installError !== undefined ? (
        <div className="error-note" role="alert">
          install failed — {installError}
        </div>
      ) : null}
      {starters.length === 0 ? (
        <EmptyState glyph="⬡" title="no starters bundled" lesson="the examples/ folder ships curated apps in the full build." />
      ) : (
        <div className="tile-grid">
          {starters.map((starter) => {
            const look =
              STARTER_LOOKS[starter.name.replace(/ /g, '-')] ??
              ({ emoji: '⬡', color: 'var(--ember)', blurb: 'curated example — runs without a server' } as const);
            const style = { '--tile-color': look.color } as CSSProperties;
            const source = `starter:${starter.id.slice(STARTER_PREFIX.length)}`;
            const installed = installedBySource.has(source);
            return (
              <button
                key={starter.id}
                type="button"
                onClick={() => installStarter(starter.id, starter.name)}
                disabled={installing !== undefined && installing !== starter.id}
                style={{ all: 'unset', display: 'block', cursor: 'pointer', position: 'relative' }}
                aria-label={installed ? `open ${starter.name}` : `install ${starter.name}`}
              >
                <Card interactive className="app-tile" style={style}>
                  {installed ? <span className="tile-installed-badge">installed</span> : null}
                  <span className="tile-emoji" aria-hidden="true">
                    {look.emoji}
                  </span>
                  <span className="tile-name">{starter.name}</span>
                  <span className="tile-sub">
                    {installed
                      ? `${look.blurb} — already in your snug file, opens your copy`
                      : installing === starter.id
                        ? 'installing…'
                        : `${look.blurb} — installs into your snug file`}
                  </span>
                </Card>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
