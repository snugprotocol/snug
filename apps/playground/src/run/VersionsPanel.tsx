// VersionsPanel — the app's history inside the run rail (child 3, umbrella AC7):
// every chat edit is a version; revert copy-forwards the chosen HTML as a NEW version
// (history is never rewritten), then the frame remounts on the reverted code.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { AppVersionMeta } from '@snugprotocol/db';

import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';

export interface VersionsPanelProps {
  appId: string;
  /** Bumped by the parent whenever a new version lands — triggers a reload. */
  refreshToken: number;
  /** Called after a successful revert so the parent reloads the frame. */
  onReverted: (version: number) => void;
}

export function VersionsPanel({ appId, refreshToken, onReverted }: VersionsPanelProps): ReactElement {
  const [versions, setVersions] = useState<AppVersionMeta[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      setVersions(db.listAppVersions(appId));
      setCurrentVersion(db.getApp(appId)?.currentVersion);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, refreshToken]);

  const revert = useCallback(
    (version: number): void => {
      setError(undefined);
      void getUserDb()
        .then((db) => {
          const meta = db.revertApp(appId, version);
          setVersions(db.listAppVersions(appId));
          setCurrentVersion(db.getApp(appId)?.currentVersion);
          onReverted(meta.version);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [appId, onReverted],
  );

  if (versions.length === 0) {
    return <EmptyState glyph="⧉" title="no versions yet" lesson="chat edits create versions — ask for a change and it lands here." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {error !== undefined ? (
        <div className="error-note" role="alert">
          revert failed — {error}
        </div>
      ) : null}
      {versions.map((version) => (
        <div
          key={version.version}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-m)',
            background: version.version === currentVersion ? 'var(--surface-2)' : 'transparent',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>
              v{version.version}
              {version.version === currentVersion ? ' · current' : ''}
            </div>
            <div className="run-desc">
              {new Date(version.createdAt).toLocaleString()}
              {version.note !== undefined ? ` — ${version.note}` : ''}
            </div>
          </div>
          {version.version !== currentVersion ? (
            <Button onClick={() => revert(version.version)} title={`make v${version.version} the current version`}>
              revert
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
