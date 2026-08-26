/**
 * HelperInstallCard — the ONE consent surface for the on-demand helper download (ADR-0060 §6).
 * Rendered at the three moments a helper is wanted (install landing, pairing, the header
 * chip when a linked session is on disk). Names the size and the source BEFORE the click;
 * never downloads on its own. Web: renders nothing (no seat).
 */
import { useEffect } from 'react';
import type { ReactElement } from 'react';

import { getPlatform } from '../platform/platform.js';
import {
  formatMegabytes,
  helperNeedsInstall,
  installHelper,
  refreshHelperStatus,
  useHelperInstall,
} from '../state/helperInstall.js';
import { Button } from '../ui/Button.js';

export function HelperInstallCard({
  name,
  appName,
  onInstalled,
  onDismiss,
}: {
  name: string;
  /** What the user is trying to use — "Telepath needs…". */
  appName: string;
  onInstalled?: () => void;
  onDismiss?: () => void;
}): ReactElement | null {
  const state = useHelperInstall(name);
  useEffect(() => {
    if (state.phase === 'unknown') void refreshHelperStatus(name);
  }, [name, state.phase]);

  if (getPlatform().helperStatus === undefined) return null;
  if (state.phase === 'unknown') return null;
  const status = state.phase === 'error' ? state.status : state.status;
  if (state.phase === 'ready' && !helperNeedsInstall(status)) return null;

  const updating = status?.installed === true;
  const size = formatMegabytes(status?.downloadBytes ?? 0);
  const onDisk = formatMegabytes(status?.unpackedBytes ?? 0);

  return (
    <div className="connection-note" role="alert" data-testid="helper-install-card">
      <p className="connection-note-title">
        {updating ? `${appName}'s WhatsApp helper needs an update` : `${appName} needs the WhatsApp helper`}
      </p>
      <p className="connection-note-body">
        {updating
          ? `This version of Snug works with helper v${status?.requiredVersion ?? '?'}; you have v${status?.installedVersion ?? '?'}. `
          : 'It runs on this computer and holds your linked WhatsApp session — nothing goes through Snug’s servers. '}
        A {size} download from GitHub ({onDisk} on disk), signed by the same key as Snug updates. Installing is your call.
      </p>
      {state.phase === 'installing' ? (
        <p className="hint" data-testid="helper-install-progress">
          {state.progress === undefined
            ? 'starting download…'
            : state.progress.phase === 'downloading'
              ? `downloading ${Math.round((state.progress.received / Math.max(1, state.progress.total)) * 100)}%`
              : state.progress.phase === 'verifying'
                ? 'verifying signature…'
                : state.progress.phase === 'installing'
                  ? 'installing…'
                  : state.progress.phase === 'starting'
                    ? 'starting the helper…'
                    : 'done'}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <p className="error-note" role="alert" data-testid="helper-install-error">
          {state.message}
        </p>
      ) : null}
      <div className="connection-note-actions">
        <Button
          variant="primary"
          data-testid="helper-install-button"
          disabled={state.phase === 'installing'}
          onClick={() => {
            void installHelper(name)
              .then(() => onInstalled?.())
              .catch(() => {
                /* surfaced in the store */
              });
          }}
        >
          {state.phase === 'installing' ? 'installing…' : updating ? 'update the helper' : 'download & install'}
        </Button>
        {onDismiss !== undefined ? (
          <Button variant="ghost" onClick={onDismiss}>
            not now
          </Button>
        ) : null}
      </div>
    </div>
  );
}
