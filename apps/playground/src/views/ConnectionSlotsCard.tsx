/**
 * ConnectionSlotsCard — Settings → Connections, slot-aware (TASK-20260810-p3-wizard,
 * plan §6; P3-AC7).
 *
 * ONE ROW PER (app, SLOT), never per app. That is the R6 keying reaching the UI: the same
 * provider connected inside two different apps is TWO independent grants with two frozen
 * ceilings, and collapsing them into one row would let one app's approval appear to speak
 * for another's — the user would revoke "Coinbase" believing they had cut off both.
 *
 * THE PILL IS DERIVED, ALWAYS. Three statuses persist (`declared`/`approved`/`revoked`);
 * "needs re-approval" is computed at render from `approved + pendingRequirement` (fold
 * B2) and is never a fourth stored value. That is not a stylistic preference: a fourth
 * status would mean a stage-time write MOVES A ROW OUT OF `approved`, silently
 * de-authorizing a grant the user never touched and stopping an app that was working.
 * The pending column exists precisely so a proposed change cannot do that, and a derived
 * pill is what keeps the screen honest about it.
 *
 * C1 — this card reads rows and renders status. It never reads a credential value.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { CONNECTION_STATUS } from '@snugprotocol/protocol';
import type { ConnectionRow } from '@snugprotocol/db';

import { getUserDb } from '../state/userdb.js';
import { invalidateNetGrants } from '../state/net.js';
import { resetSidecarIdentitySession } from '../state/sidecarIdentity.js';
import { useStore } from '../state/store.js';
import {
  connectionWizardRevisionStore,
  needsReapproval,
  openConnectionWizard,
} from '../state/connectionWizard.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';

/**
 * Plain-words status. The persisted value is a protocol literal; what the user needs is
 * a claim about their own account, so `declared` becomes "not connected yet" rather than
 * leaking a state-machine term nobody outside this repo has a model for.
 */
function pillCopy(row: ConnectionRow): string {
  if (needsReapproval(row)) return 'needs re-approval';
  switch (row.status) {
    case CONNECTION_STATUS.approved:
      return 'connected';
    case CONNECTION_STATUS.revoked:
      return 'revoked';
    case CONNECTION_STATUS.declared:
      return 'not connected yet';
  }
}

/** Plain-words kind, matching the wizard's review vocabulary rather than the enum. */
function kindCopy(row: ConnectionRow): string {
  switch (row.requirement.kind) {
    case 'oauth2_auth_code':
      return 'sign-in';
    case 'oauth2_client_creds':
      return 'app-to-app keys';
    case 'basic_auth':
      return 'username and secret';
    case 'bearer_token':
      return 'secret token';
    case 'api_key':
      return 'API keys';
    case 'linked_device':
      return 'linked device';
    case 'none':
      return 'no credentials';
  }
}

/**
 * The row's primary action, chosen from the DERIVED state so the button and the pill can
 * never disagree — a row reading "needs re-approval" beside a button saying "connect"
 * would be two different claims about one grant.
 */
function actionCopy(row: ConnectionRow): string {
  if (needsReapproval(row)) return 'review the changes';
  switch (row.status) {
    case CONNECTION_STATUS.approved:
      return 'manage this connection';
    case CONNECTION_STATUS.revoked:
      return 'connect it again';
    case CONNECTION_STATUS.declared:
      return 'set up this connection';
  }
}

export function ConnectionSlotsCard(): ReactElement | null {
  const revision = useStore(connectionWizardRevisionStore);
  const [rows, setRows] = useState<ConnectionRow[]>([]);
  /**
   * appId → the app's display name. Read alongside the rows because THE OWNER IS PART OF
   * THE ROW'S IDENTITY on this card (fold), not decoration.
   *
   * Listing across every app is deliberate, but it means the same provider connected in
   * two apps renders two entries — and until this map existed they were visually
   * IDENTICAL, each carrying its own destructive `disconnect`, separable only by an
   * invisible `data-app-id`. That put back at the presentation layer precisely the
   * confusion the (app, slot) keying exists to prevent: a person revokes "Coinbase"
   * believing they cut off both, or cuts off the wrong app. Two independent grants must
   * READ as two independent grants.
   */
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void getUserDb().then((db) => {
      if (!alive) return;
      // No appId argument: Settings shows EVERY connection the user has granted, across
      // every app, because "what have I connected?" is a question about the person's
      // whole hub — not about whichever app they happen to be looking at.
      setRows(db.listConnections());
      setAppNames(Object.fromEntries(db.listApps().map((app) => [app.appId, app.displayName])));
    });
    return () => {
      alive = false;
    };
    // `revision` refreshes after a wizard write; `epoch` after a revoke performed here.
  }, [revision, epoch]);

  /**
   * Revoke — the user's unilateral off switch, and the one action on this card that
   * changes anything.
   *
   * `revokeConnection` is the sole legal author of this transition: it stamps the
   * tombstone, KEEPS the row (which is what lets the wizard disclose "you revoked this
   * before" on a later reconnect), and wipes the `auth:<appId>:<slot>:*` credential slice
   * slot-scoped, so a sibling slot's secrets survive. Doing the wipe inside that accessor
   * rather than here is deliberate: a revoke that deleted the grant but left the
   * credential would resume injecting the old value the moment the slot was re-declared.
   */
  const revoke = (row: ConnectionRow): void => {
    setError(undefined);
    void getUserDb()
      .then((db) => {
        db.revokeConnection(row.appId, row.slot);
        invalidateNetGrants(row.appId); // R3 — every grant transition
        // The db-level wipe may have just destroyed the persisted identity directory;
        // the session's in-memory harvest must not outlive it and re-persist the names
        // on the next poll (TASK-20260820, Gate-5 review line-scan finding 3).
        resetSidecarIdentitySession();
        setEpoch((current) => current + 1);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <Card>
      <h3>connections</h3>
      {error !== undefined ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <span className="hint">no app has asked to connect to anything yet.</span>
      ) : (
        <ul>
          {rows.map((row) => (
            <li
              key={`${row.appId}:${row.slot}`}
              data-testid="connection-slot-row"
              data-app-id={row.appId}
              data-slot={row.slot}
              data-status={row.status}
              data-needs-reapproval={needsReapproval(row) ? 'true' : 'false'}
            >
              <strong>{row.requirement.provider.name}</strong>
              {/*
                The owning app, in the user's own words for it. Falls back to the raw
                `appId` rather than rendering nothing: a connection can outlive (or precede)
                an installed app row, and a BLANK owner beside a destructive button is worse
                than an ugly identifier — the whole point is that the user can tell which
                grant they are about to cut off.
              */}
              <span className="hint" data-testid="slot-app">
                in {appNames[row.appId] ?? row.appId}
              </span>
              <span className="hint" data-testid="slot-kind">
                {kindCopy(row)}
              </span>
              <span className="chip" data-testid="slot-status-pill">
                {pillCopy(row)}
              </span>
              <Button
                /*
                  NO `mode` IS PASSED, deliberately (fold). This call site used to hand the
                  sheet `mode: 'reapprove'` so it would render the diff — which made the
                  disclosure depend on every call site REMEMBERING to derive the same thing,
                  and two shipped entry points did not. The sheet now derives the diff from
                  `needsReapproval(row)` itself, the same definition `pillCopy` above reads,
                  so passing a mode here would be a second copy of the derivation with
                  nothing keeping it honest.
                */
                onClick={() => openConnectionWizard({ appId: row.appId, slot: row.slot, source: 'settings' })}
              >
                {actionCopy(row)}
              </Button>
              {row.status !== CONNECTION_STATUS.revoked ? (
                <Button variant="danger" onClick={() => revoke(row)}>
                  disconnect
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
