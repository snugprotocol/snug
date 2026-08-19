/**
 * AuthRepairChip — the quiet run-surface trace of the auth-shaped failure observer
 * (TASK-20260812-desktop-auth-awareness AC5; ADR-0022 §4; reshaped by TASK-20260819).
 *
 * WHAT IT REPAIRS: before this surface existed, a provider rejecting stored credentials
 * was silent at every layer — the executor rightly returns `ok:true` for a delivered 401
 * (apps read 401 bodies; remapping would break the app contract), `onNetError` never
 * fires for it, and the user's first hint was an app quietly showing nothing. The
 * observer seat reports "this app's credentialed request was rejected" host-side, and
 * this chip is the ONE place the run surface shows it.
 *
 * WHY A CHIP AND NOT THE OLD BANNER (owner decision D2, 2026-08-19). This was a
 * full-bleed maroon block rendered inside the running app, carrying the whole diagnosis
 * and two buttons. Two things were wrong with that. It DISPLACED the app's own UI, so a
 * working app looked broken. And because the host cannot tell an expected refusal from a
 * genuinely broken credential, it greeted the owner on every launch of a healthy Spotify
 * connection — an alarm that fires on every launch is one users learn to click past,
 * which costs exactly the failures it exists to report. The diagnosis moved into the
 * wizard's attention gate (Step 0), where a connection is already the subject; what
 * stays here is the smallest thing that keeps a failure from being invisible.
 *
 * THIS DELIBERATELY REVERSES part of TASK-20260813 AC10, which gave this surface the
 * danger accent on the reasoning that "a REJECTED credential still reads as a failure".
 * That reasoning still holds — and Step 0 still carries the danger temperature. What
 * changed is WHERE it is spent: on the screen the user opened to deal with it, not
 * across the app they were trying to use.
 *
 * C1 — the store carries (appId, slot, status) plus an OPTIONAL `detail`: a short,
 * scrubbed plain-text extract of the provider's own error reason. No credential, no URL,
 * no raw response bytes can reach this component. The chip does not render `detail` at
 * all; Step 0 does, as TEXT only — never markup, never a link.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { authShapedFailureStore } from '../state/net.js';
import { connectionWizardStore, openConnectionWizardForFailure } from '../state/connectionWizard.js';
import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';

export function AuthRepairChip({ appId }: { appId: string }): ReactElement | null {
  const failure = useStore(authShapedFailureStore);
  const wizard = useStore(connectionWizardStore);
  const active = failure !== null && failure.appId === appId ? failure : null;
  const [providerName, setProviderName] = useState<string | undefined>(undefined);

  const activeSlot = active?.slot;
  useEffect(() => {
    if (activeSlot === undefined) {
      setProviderName(undefined);
      return;
    }
    let alive = true;
    void getUserDb().then((db) => {
      if (!alive) return;
      setProviderName(db.getConnection(appId, activeSlot)?.requirement.provider.name);
    });
    return () => {
      alive = false;
    };
  }, [appId, activeSlot]);

  if (active === null) return null;
  // NEVER BOTH AT ONCE (AC10): while the wizard is open on this app it owns the failure —
  // it is holding the session copy and rendering Step 0. A chip still showing underneath
  // would be two surfaces claiming one fact, and a user who dealt with one would still be
  // staring at the other.
  if (wizard !== null && wizard.appId === appId) return null;
  // The row is the naming authority; the slot is the honest fallback while it loads (or
  // if the row has been deleted out from under the failure).
  const provider = providerName ?? active.slot;

  return (
    <button
      type="button"
      className="auth-repair-chip"
      data-testid="auth-repair-chip"
      // A status, not an alert: `alert` interrupts a screen-reader user mid-task for
      // something the app is still working around. `status` announces it politely at the
      // next opportunity, which matches what the chip is — a standing note, not an event.
      role="status"
      title={`${provider} refused this app's key — open the connection to sort it out`}
      onClick={() => {
        // The handoff and the v3 refusal lesson both live in the store seam, so this
        // handler cannot get either wrong: a refused open leaves the failure standing and
        // the chip renders on.
        openConnectionWizardForFailure(appId);
      }}
    >
      <span aria-hidden="true">⚠</span>
      <span>check this connection — {provider}</span>
    </button>
  );
}
