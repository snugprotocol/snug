import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { parseBuildPrompt } from '../agent/chips.js';
import { useAppMetaMap } from '../state/appMeta.js';
import { libraryForMode, type LibraryEntry } from '../state/library.js';
import { useMode } from '../state/mode.js';
import { listStarterApps } from '../starter/starterApps.js';
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
  const mode = useMode();
  const navigate = useNavigate();
  const metaMap = useAppMetaMap();
  const prompt = useMemo(() => parseBuildPrompt(), []);
  const starters = useMemo(listStarterApps, []);
  const [idea, setIdea] = useState('');
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading' });
    libraryForMode(mode)
      .list()
      .then((entries) => {
        if (!cancelled) setLoad({ phase: 'ready', entries });
      })
      .catch(() => {
        if (!cancelled)
          setLoad({
            phase: 'error',
            message: mode === 'server' ? 'the local server isn’t answering — is it running on :8787?' : 'could not open your local library.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const startBuild = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    navigate(`/build?idea=${encodeURIComponent(trimmed)}`);
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
      {starters.length === 0 ? (
        <EmptyState glyph="⬡" title="no starters bundled" lesson="the examples/ folder ships curated apps in the full build." />
      ) : (
        <div className="tile-grid">
          {starters.map((starter) => {
            const look =
              STARTER_LOOKS[starter.name.replace(/ /g, '-')] ??
              ({ emoji: '⬡', color: 'var(--ember)', blurb: 'curated example — runs without a server' } as const);
            const style = { '--tile-color': look.color } as CSSProperties;
            return (
              <Link key={starter.id} to={`/run/${starter.id}`} style={{ color: 'inherit', display: 'block' }}>
                <Card interactive className="app-tile" style={style}>
                  <span className="tile-emoji" aria-hidden="true">
                    {look.emoji}
                  </span>
                  <span className="tile-name">{starter.name}</span>
                  <span className="tile-sub">{look.blurb}</span>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
