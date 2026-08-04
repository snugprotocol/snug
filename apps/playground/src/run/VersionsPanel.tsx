// VersionsPanel — the app's history inside the run rail (living-apps child 3):
// every chat edit is a version; revert copy-forwards the chosen HTML as a NEW version
// (history is never rewritten), then the frame remounts on the reverted code. The
// FACTORY version (v1 of the build or install) is pinned — never pruned — so "reset
// to factory" is always available (umbrella AC6).

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
  /** Called after a successful revert/reset so the parent reloads the frame. */
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

  const afterChange = useCallback(
    (version: number): void => {
      void getUserDb().then((db) => {
        setVersions(db.listAppVersions(appId));
        setCurrentVersion(db.getApp(appId)?.currentVersion);
        onReverted(version);
      });
    },
    [appId, onReverted],
  );

  const revert = useCallback(
    (version: number): void => {
      setError(undefined);
      void getUserDb()
        .then((db) => afterChange(db.revertApp(appId, version).version))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [appId, afterChange],
  );

  const resetToFactory = useCallback((): void => {
    setError(undefined);
    void getUserDb()
      .then((db) => afterChange(db.resetToFactory(appId).version))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [appId, afterChange]);

  if (versions.length === 0) {
    return <EmptyState glyph="⧉" title="no versions yet" lesson="chat edits create versions — ask for a change and it lands here." />;
  }

  const factory = versions.find((v) => v.pinned);
  const onFactory = factory !== undefined && factory.version === currentVersion;

  return (
    <div className="versions-panel">
      {error !== undefined ? (
        <div className="error-note" role="alert">
          version change failed — {error}
        </div>
      ) : null}
      {factory !== undefined && !onFactory ? (
        <div className="factory-reset">
          <div className="factory-reset-copy">
            <strong>factory default kept safe</strong>
            <span>v{factory.version} is pinned forever — reset any time.</span>
          </div>
          <Button onClick={resetToFactory} title="restore the original version of this app">
            reset to factory
          </Button>
        </div>
      ) : null}
      {versions.map((version) => (
        <div key={version.version} className={`version-row${version.version === currentVersion ? ' version-current' : ''}`}>
          <div className="version-row-main">
            <div className="version-row-title">
              v{version.version}
              {version.version === currentVersion ? <span className="version-tag">current</span> : null}
              {version.pinned ? <span className="version-tag version-tag-factory">factory</span> : null}
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
