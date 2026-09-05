// AgentUpdateControls — the run header's door to a newer version the user's AGENT handed in
// for an app the user EDITED (TASK-20260905-binding-a-artifacts AC8, ADR-0045 §7). An
// unedited copy takes the hand-in at boot; an edited copy is never superseded silently, so
// the act lives here behind exactly one confirm — the same words the starter update uses:
// nothing is lost, the edited version stays in the panel, revertable. Renders nothing
// without a platform hand-in seat or without a pending entry for this app, so RunView
// mounts it unconditionally for owned apps.

import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';

import { getPlatform } from '../platform/platform.js';
import { Button } from '../ui/Button.js';

export interface AgentUpdateControlsProps {
  appId: string;
  /** Called after a successful update so the parent reloads the frame (contentEpoch). */
  onUpdated: (version: number) => void;
}

export function AgentUpdateControls({ appId, onUpdated }: AgentUpdateControlsProps): ReactElement | null {
  const seat = getPlatform().agentHandIns;
  const pending = useSyncExternalStore(
    seat?.pending.subscribe ?? (() => () => undefined),
    () => seat?.pending.get(),
    () => seat?.pending.get(),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const entry = pending?.find((p) => p.appId === appId);

  const apply = useCallback((): void => {
    if (seat === undefined) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(undefined);
    seat
      .apply(appId)
      .then((result) => {
        setBusy(false);
        onUpdated(result.version);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [seat, appId, onUpdated]);

  if (seat === undefined || entry === undefined) return null;

  return (
    <>
      <Button
        variant="primary"
        data-testid="agent-update"
        aria-label="update this app from your agent"
        disabled={busy}
        title="your agent handed in a new version — your data, chats and docs stay; your edited version stays revertable"
        onClick={() => setConfirmOpen(true)}
      >
        {busy ? 'updating…' : 'update from your agent'}
      </Button>
      {error !== undefined ? (
        <span className="error-note" role="alert" style={{ padding: '2px 8px' }}>
          update failed — {error}
        </span>
      ) : null}
      {confirmOpen ? (
        <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="confirm updating an edited app from your agent">
          <div className="net-confirm-card">
            <h2 className="net-confirm-title">you’ve customized this app</h2>
            <p className="net-confirm-body">
              Your agent handed in a new version of {entry.displayName}. Updating replaces your edited version with it. Nothing
              is lost — your current version stays in the versions panel and you can revert to it any time. Your data, chats
              and docs are untouched either way.
            </p>
            <div className="field-row net-confirm-actions">
              <Button variant="ghost" data-testid="agent-update-cancel" onClick={() => setConfirmOpen(false)}>
                keep my version
              </Button>
              <Button variant="primary" data-testid="agent-update-confirm" onClick={apply}>
                update · keeps your data
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
