/**
 * AuthRepairBanner — the RunView surface of the auth-shaped failure observer
 * (TASK-20260812-desktop-auth-awareness AC5; ADR-0022 §4).
 *
 * WHAT IT REPAIRS: before this banner, a provider rejecting stored credentials was
 * silent at every layer — the executor rightly returns `ok:true` for a delivered 401
 * (apps read 401 bodies; remapping would break the app contract), `onNetError` never
 * fires for it, and the user's first hint was an app quietly showing nothing. The
 * observer seat reports "this app's credentialed request was rejected" host-side, and
 * this banner is the ONE place that renders it.
 *
 * THE CTA opens the wizard on the EXACT failing (appId, slot) — never a re-derivation
 * of "which connection did they mean" — and dismisses only on a REAL open
 * (`openConnectionWizard` is synchronous and boolean; the v3 lesson about a Promise's
 * truthiness dismissing a CTA the wizard refused is pinned by test here too).
 *
 * C1 — the store carries (appId, slot, status) and nothing else; the provider NAME is
 * read from the connection row so the copy speaks the user's vocabulary, and no
 * response byte or credential can reach this component by construction.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { authShapedFailureStore, dismissAuthShapedFailure } from '../state/net.js';
import { openConnectionWizard } from '../state/connectionWizard.js';
import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';

export function AuthRepairBanner({ appId }: { appId: string }): ReactElement | null {
  const failure = useStore(authShapedFailureStore);
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
  // The row is the naming authority; the slot is the honest fallback while it loads
  // (or if the row has been deleted out from under the failure).
  const provider = providerName ?? active.slot;

  return (
    // AC10: this one IS a genuine failure — a provider actively rejected stored
    // credentials — so it keeps the danger accent, via the `is-error` variant of the
    // shared connection surface rather than the old full-bleed `.error-note`. Same
    // shape as the calm variant, different temperature.
    <div className="connection-note is-error" role="alert" data-testid="auth-repair-banner">
      <p className="connection-note-title">{provider} isn’t accepting this app’s key</p>
      <p className="connection-note-body">
        The app keeps running, but anything needing {provider} won’t work until this is sorted. The key may be wrong,
        expired, or revoked ({active.status}).
      </p>
      <div className="connection-note-actions">
        <Button
          variant="primary"
          onClick={() => {
            // Dismiss ONLY on a real open: `openConnectionWizard` refuses (false) when
            // another wizard is parked, and a banner cleared on a refusal would strand
            // the user with no route back.
            if (openConnectionWizard({ appId: active.appId, slot: active.slot, source: 'error_cta' })) {
              dismissAuthShapedFailure();
            }
          }}
        >
          check this connection
        </Button>
        <Button variant="ghost" onClick={() => dismissAuthShapedFailure()}>
          dismiss
        </Button>
      </div>
    </div>
  );
}
