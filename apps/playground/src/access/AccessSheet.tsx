// access/AccessSheet.tsx — the run header's ⋈ sheet (TASK-20261010-cross-app-access AC19;
// ADR-0075 §7; D20, D34). For ONE app, both directions: what it reads, what reads it (each
// through the ONE `GrantRow`), the history the app keeps as a source, the asks the user turned
// down for it, and the ONE creation act — *let Budget read another app…* — which always names
// THIS app as the one that reads (a source never offers itself at v1: ADR-0075 §10).
//
// Through `ConfirmOverlay`, which PORTALS to <body> (the ScheduleSheet precedent — the header's
// backdrop-filter would otherwise trap a fixed overlay inside the header's box), with its opt-in
// accessibility: named BY its title (`labelledBy`), Escape and a backdrop press close it
// (`onDismiss` — the overlay owns the key, so a stacked sheet never closes twice), focus starts
// on ✕, Tab stays inside, and closing returns focus to the ⋈ that opened it. The overlay mounts
// only once the file has been read, so the dialog is never named for an app it has not read yet.
// The acts that lead to the consent sheet (*allow again*, *allow…*, the creation act) close THIS
// sheet first, so the review is the only sheet on screen — through `startUserAsk` (userAsk.ts),
// the UI's ONE recipe for the user's ask.
//
// THE DATA is the engine's view of the file, re-read on every access revision: `grantsForApp`
// (every status, both directions, persisted and session), the source's history, the declines.
// `useHasAccessState` is the ⋈'s own rule (the ⚯ rule): access either way, a pending ask, or a
// declined ask.

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

import type { AccessDecline } from '@snugprotocol/db';
import type { AccessLogEntry } from '@snugprotocol/protocol';

import '../theme/access.css';
import '../theme/access-sheet.css';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { AccessHistory } from './AccessHistory.js';
import { pendingAccessStore } from './consent.js';
import { ACCESS_SHEET, CONSENT_SHEET } from './copy.js';
import { GrantRow } from './GrantRow.js';
import { accessDeps, grantsForApp, useAccessRevision, type LiveGrantRow } from './grants.js';
import { startUserAsk } from './userAsk.js';

// ------------------------------------------------------------------------------------- data

interface SheetData {
  name: string;
  reads: LiveGrantRow[];
  readBy: LiveGrantRow[];
  history: AccessLogEntry[];
  declines: AccessDecline[];
  now: number;
}

/** The engine's view of one app's access, re-read on every revision. `undefined` until the first read lands. */
function useSheetData(appId: string): SheetData | undefined {
  const revision = useAccessRevision();
  const [data, setData] = useState<SheetData | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const now = accessDeps().now();
        const { reads, readBy } = grantsForApp(db, appId, now);
        setData({
          name: db.getApp(appId)?.displayName ?? '',
          reads,
          readBy,
          history: db.listAccessLog(appId),
          declines: db.listAccessDeclines(appId),
          now,
        });
      })
      .catch(() => {
        // the file is not open (a swap in flight): the sheet shows what it last read
      });
    return () => {
      cancelled = true;
    };
  }, [appId, revision]);
  return data;
}

/**
 * Whether the app has ACCESS STATE — access either way (any status), a pending ask, or a
 * declined ask — the ⋈'s rule. `enabled: false` reads nothing (a starter, a host without access).
 */
export function useHasAccessState(appId: string, enabled: boolean): boolean {
  const revision = useAccessRevision();
  const pending = useStore(pendingAccessStore)[appId] !== undefined;
  const [stored, setStored] = useState(false);
  // Written only on a CHANGE: the common answer is "no state", and a header that re-renders for
  // nothing on every revision is a header that flickers for nothing.
  const storedRef = useRef(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const settle = (next: boolean): void => {
      if (cancelled || storedRef.current === next) return;
      storedRef.current = next;
      setStored(next);
    };
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const { reads, readBy } = grantsForApp(db, appId, accessDeps().now());
        settle(reads.length > 0 || readBy.length > 0 || db.listAccessDeclines(appId).length > 0);
      })
      .catch(() => settle(false));
    return () => {
      cancelled = true;
    };
  }, [appId, enabled, revision]);
  return enabled && (pending || stored);
}

// -------------------------------------------------------------------------------------- sheet

export interface AccessSheetProps {
  appId: string;
  onClose: () => void;
}

export function AccessSheet({ appId, onClose }: AccessSheetProps): ReactElement | null {
  const data = useSheetData(appId);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Not until the file is read: a dialog named "'s access" for a moment is a dialog misnamed.
  if (data === undefined) return null;
  const { name } = data;
  const heading = ACCESS_SHEET.title(name);

  /** The user's own ask for THIS app, reviewed alone: this sheet closes first. */
  const askAsUser = async (decline?: AccessDecline): Promise<void> => {
    onClose();
    await startUserAsk(appId, decline !== undefined ? { decline } : {});
  };

  const nothing = data.reads.length === 0 && data.readBy.length === 0;
  const showHistory = data.readBy.length > 0 || data.history.length > 0;

  return (
    <ConfirmOverlay
      labelledBy={titleId}
      onDismiss={onClose}
      initialFocusRef={closeRef}
      trapFocus
      cardClassName="release-notes-card access-sheet"
      data-testid="access-sheet"
    >
      <div className="release-notes-head">
        <h2 id={titleId} className="net-confirm-title">
          {heading}
        </h2>
        {/* A plain button: `ui/Button` does not forward a ref, and focus starts here. */}
        <button
          type="button"
          ref={closeRef}
          className="btn btn-ghost"
          aria-label={`${ACCESS_SHEET.close} ${heading}`}
          onClick={onClose}
          data-testid="access-sheet-close"
        >
          ✕ {ACCESS_SHEET.close}
        </button>
      </div>
      <div className="release-notes-scroll access-sheet-body">
        {nothing ? (
          <p className="hint access-sheet-nothing" data-testid="access-nothing">
            {ACCESS_SHEET.nothing(name)}
          </p>
        ) : null}

        {data.reads.length > 0 ? (
          <section className="access-sheet-section" data-testid="access-reads">
            <h3 className="access-sheet-section-title">{ACCESS_SHEET.reads(name)}</h3>
            <ul className="access-row-list">
              {data.reads.map((row) => (
                <GrantRow key={row.grant.id} row={row} side="reads" now={data.now} onBeforeReview={onClose} />
              ))}
            </ul>
          </section>
        ) : null}

        {data.readBy.length > 0 ? (
          <section className="access-sheet-section" data-testid="access-read-by">
            <h3 className="access-sheet-section-title">{ACCESS_SHEET.readBy(name)}</h3>
            <ul className="access-row-list">
              {data.readBy.map((row) => (
                <GrantRow key={row.grant.id} row={row} side="read-by" now={data.now} onBeforeReview={onClose} />
              ))}
            </ul>
          </section>
        ) : null}

        {showHistory ? <AccessHistory entries={data.history} now={data.now} /> : null}

        {data.declines.length > 0 ? (
          <section className="access-sheet-section" data-testid="access-declined">
            <h3 className="access-sheet-section-title">{ACCESS_SHEET.declinedAsks}</h3>
            <ul className="access-row-list">
              {data.declines.map((decline) => (
                <li key={decline.hash} className="access-declined-row" data-testid="access-declined-row">
                  <span className="access-sheet-quote" data-testid="access-declined-purpose">
                    {CONSENT_SHEET.quote(decline.purpose)}
                  </span>
                  <Button variant="ghost" className="access-row-act" data-testid="access-declined-allow" onClick={() => void askAsUser(decline)}>
                    {ACCESS_SHEET.allowDeclined}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="access-sheet-create">
          <Button onClick={() => void askAsUser()} data-testid="access-create">
            {ACCESS_SHEET.create(name)}
          </Button>
        </div>
      </div>
    </ConfirmOverlay>
  );
}
