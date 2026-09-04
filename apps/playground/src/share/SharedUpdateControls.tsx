// SharedUpdateControls — the run header's "update · keeps your data" for an INSTALLED
// shared app whose lineage has a newer bundle on the shelf (TASK-20260904 AC12,
// ADR-0045's act generalized). Renders nothing otherwise, so RunView mounts it
// unconditionally for owned apps — the StarterUpdateControls shape.
//
// The ONE write act here is the update button (the hub tile only reports). An unedited
// copy updates in one click; an edited copy (current ≠ newest pinned) confirms first —
// nothing is lost either way (the edited version stays in the panel, revertable), but a
// silent swap of running code the user wrote is the clobber ADR-0045 §7 refuses.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { applySharedUpdate, sharedUpdateStatus, type SharedUpdateStatus } from './installShared.js';
import { sharedInboxStore } from './sharedInbox.js';

export interface SharedUpdateControlsProps {
  appId: string;
  refreshToken: number;
  onUpdated: (version: number) => void;
}

export function SharedUpdateControls({ appId, refreshToken, onUpdated }: SharedUpdateControlsProps): ReactElement | null {
  const shelf = useStore(sharedInboxStore);
  const [status, setStatus] = useState<SharedUpdateStatus | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (!cancelled) setStatus(sharedUpdateStatus(db, appId));
    });
    return () => {
      cancelled = true;
    };
  }, [appId, refreshToken, shelf]);

  const apply = useCallback((): void => {
    if (status === undefined) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(undefined);
    void applySharedUpdate(appId, status.entry.bundleId)
      .then((result) => {
        setBusy(false);
        setStatus(undefined);
        if ('version' in result) onUpdated(result.version);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [appId, status, onUpdated]);

  if (status === undefined && error === undefined) return null;

  return (
    <>
      {status !== undefined ? (
        <Button
          variant="primary"
          data-testid="shared-update"
          aria-label="update this app from the newer shared version"
          disabled={busy}
          title="update your copy from the newer shared version — your data, credentials and connections stay"
          onClick={() => (status.edited ? setConfirmOpen(true) : apply())}
        >
          {busy ? 'updating…' : 'update · keeps your data'}
        </Button>
      ) : null}
      {error !== undefined ? (
        <span className="error-note" role="alert" style={{ padding: '2px 8px' }}>
          update failed — {error}
        </span>
      ) : null}
      {confirmOpen && status !== undefined ? (
        <ConfirmOverlay ariaLabel="confirm updating an edited app">
          <h2 className="net-confirm-title">you’ve customized this app</h2>
          <p className="net-confirm-body">
            Updating replaces your edited version with the newer shared one. Nothing is lost — your current version
            stays in the versions panel and you can revert to it any time. Your data, credentials and connections are
            untouched either way.
          </p>
          <div className="field-row net-confirm-actions">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              keep mine
            </Button>
            <Button variant="primary" data-testid="shared-update-confirm" onClick={apply}>
              update anyway
            </Button>
          </div>
        </ConfirmOverlay>
      ) : null}
    </>
  );
}
