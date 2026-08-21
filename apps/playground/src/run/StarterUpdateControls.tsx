// StarterUpdateControls — the run header's starter-version cluster
// (TASK-20260820-starter-updates, ADR-0045 §3/§7/§8): the version chip and "release
// notes" link for EVERY installed starter, plus the update button when the bundle is
// ahead. Renders nothing for apps that are not installed starters, so RunView mounts it
// unconditionally.
//
// THE ONE WRITE ACT here is the update button — the hub tile only reports (the
// hub-never-writes doctrine stands, HubView). An UNEDITED copy updates in one click; an
// EDITED copy gets exactly one confirm first (§7): the user re-authored their copy, and
// while nothing is ever lost (the edited version stays in the panel, revertable), a
// silent swap of running code they wrote would be the clobber next-steps warned about.
//
// Extracted from RunView for the RunHeaderActions reason: testable without a route, a
// runner or an iframe. Same label rules as that file: every control carries an explicit
// `aria-label` (locator-load-bearing), `title` is hover-only.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getUserDb } from '../state/userdb.js';
import { applyStarterUpdate, starterUpdateStatus, type StarterUpdateStatus } from '../starter/starterUpdate.js';
import { Button } from '../ui/Button.js';
import { ReleaseNotesSheet } from './ReleaseNotesSheet.js';

export interface StarterUpdateControlsProps {
  appId: string;
  /** Bumped by the parent whenever app content changes — triggers a status reload. */
  refreshToken: number;
  /** Called after a successful update so the parent reloads the frame (contentEpoch). */
  onUpdated: (version: number) => void;
}

export function StarterUpdateControls({ appId, refreshToken, onUpdated }: StarterUpdateControlsProps): ReactElement | null {
  const [status, setStatus] = useState<StarterUpdateStatus | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setStatus(undefined);
    void getUserDb()
      .then(async (db) => {
        const next = await starterUpdateStatus(db, appId);
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        /* an unversioned or missing starter simply shows no chrome */
      });
    return () => {
      cancelled = true;
    };
  }, [appId, refreshToken]);

  const apply = useCallback((): void => {
    setConfirmOpen(false);
    setBusy(true);
    setError(undefined);
    void getUserDb()
      .then(async (db) => {
        const result = await applyStarterUpdate(db, appId);
        setBusy(false);
        if (result.status === 'unavailable') {
          setError('the starter is no longer bundled');
          return;
        }
        const next = await starterUpdateStatus(db, appId);
        setStatus(next);
        onUpdated(result.version);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [appId, onUpdated]);

  if (status === undefined) return null;

  const updateLabel = `update this app to v${status.latestVersion}`;

  return (
    <>
      <span className="run-version-chip" data-testid="starter-version-chip">
        v{status.installedVersion}
      </span>
      <Button
        variant="ghost"
        aria-label="show release notes"
        title="what changed in each version of this starter"
        onClick={() => setSheetOpen(true)}
      >
        release notes
      </Button>
      {status.updateAvailable ? (
        <Button
          variant="primary"
          data-testid="starter-update"
          aria-label={updateLabel}
          disabled={busy}
          title="update your copy — your data, credentials and connections stay"
          onClick={() => (status.edited ? setConfirmOpen(true) : apply())}
        >
          {busy ? 'updating…' : `update to v${status.latestVersion}`}
        </Button>
      ) : null}
      {error !== undefined ? (
        <span className="error-note" role="alert" style={{ padding: '2px 8px' }}>
          update failed — {error}
        </span>
      ) : null}
      {sheetOpen ? <ReleaseNotesSheet status={status} onClose={() => setSheetOpen(false)} /> : null}
      {confirmOpen ? (
        <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="confirm updating an edited app">
          <div className="net-confirm-card">
            <h2 className="net-confirm-title">you’ve customized this app</h2>
            <p className="net-confirm-body">
              Updating replaces your edited version with starter v{status.latestVersion}. Nothing is lost — your
              current version stays in the versions panel and you can revert to it any time. Your data, credentials
              and connections are untouched either way.
            </p>
            <div className="net-confirm-actions">
              <Button variant="primary" aria-label="update and keep my edits in history" onClick={apply}>
                update anyway
              </Button>
              <Button aria-label="keep my version" onClick={() => setConfirmOpen(false)}>
                keep my version
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
