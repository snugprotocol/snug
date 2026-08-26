/**
 * HelperSurface — the header whisper for the autostart moment (TASK-20260826 AC15).
 * The shell autostarts the helper when a linked session is on disk; if that helper is
 * absent or mismatched, the launch-time failure was silent by design (sidecar.rs). This
 * chip is what makes it not silent: same pattern as the update chip, renders only on
 * desktop AND only when a linked session wants a helper that is not there.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { HelperInstallCard } from '../connections/HelperInstallCard.js';
import { getPlatform } from '../platform/platform.js';
import { WHATSAPP_HELPER, helperNeedsInstall, refreshHelperStatus, useHelperInstall } from '../state/helperInstall.js';

export function HelperSurface(): ReactElement | null {
  const state = useHelperInstall(WHATSAPP_HELPER);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (getPlatform().helperStatus !== undefined) void refreshHelperStatus(WHATSAPP_HELPER);
  }, []);
  if (getPlatform().helperStatus === undefined) return null;
  const status = state.phase === 'ready' || state.phase === 'installing' ? state.status : undefined;
  if (status === undefined || !status.linkedSessionOnDisk || !helperNeedsInstall(status)) return null;
  return (
    <>
      <button
        type="button"
        className="auth-repair-chip app-update-chip"
        data-testid="helper-chip"
        onClick={() => setOpen(true)}
        title="your linked WhatsApp session needs its helper"
      >
        WhatsApp helper needed
      </button>
      {open ? (
        <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="WhatsApp helper">
          <div className="net-confirm-card">
            <HelperInstallCard name={WHATSAPP_HELPER} appName="Your linked WhatsApp" onInstalled={() => setOpen(false)} onDismiss={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
