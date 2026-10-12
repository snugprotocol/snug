// access/AccessSheet.tsx — the run header's ⋈ sheet (TASK-20261010-cross-app-access AC19;
// ADR-0075 §7; D20, D34). For ONE app, both directions: what it reads, what reads it (each
// through the ONE `GrantRow`), the history the app keeps as a source, the asks the user turned
// down for it, and the ONE creation act — *let Budget read another app…* — which always names
// THIS app as the one that reads.
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
// THE DATA is the engine's view of the file, re-read on every access and library revision:
// `grantsForApp` (every status, both directions, persisted and session), the source's history, the
// declines, the reader's best pair and the apps the source could offer itself to.
// `useHasAccessState` is the ⋈'s own rule — since PR-5 a door that opens on more than state (below).
//
// TASK-20261010-host-broker PR-3 (ADR-0076 §5; D-PR3-7/15/24; DS12, S18): the data gains the
// UNDOABLE set — the ids of the live journal entries the file holds for this app as a target
// (`listAccessUndo`) — and the sheet carries out *undo* on a `wrote` row (`AccessHistory` shows
// the act behind its armed confirm): the engine's `undoBrokeredWrite`, an act of host chrome
// (`via: 'user'`), reached at the call — no module under access/ reaches another at its top level.
// The engine bumps the access revision on EVERY outcome (Gate-5 ENG-4), so this sheet's re-read
// follows it — the row loses its *undo* and the `undone` line appears without a reopen — and the
// sheet never bumps on its own. A write access's row carries its badge through `GrantRow`.
//
// TASK-20261010-host-broker PR-5 (ADR-0076 §7; D-PR5-4, D-PR5-5, D-PR5-14; D6, F17). A SOURCE may
// now offer itself, so the sheet is laid out by DIRECTION, each heading drawn whenever its act is:
// under *Budget reads* — its rows, the reader's best pair act (`AccessPairAct`, when its declaration
// meets another app's registered table) and the creation act, always; under *what reads Budget* —
// its rows and the offer (`AccessOffer`, when this app has a registered table, holds no WhatsApp
// fact, and some other app could read it). Both acts open the person's ask, never an app's, and
// close this sheet only once the review is sure to open. The ⋈ itself WIDENS (reversing D20, which
// hid the door on an app with nothing behind it): it shows on an owned app with access state OR
// whenever the file holds another app that may use access — the offer and the creation act live
// behind it — and re-reads on the library revision too. The chat's cross-app card opens this sheet
// IN PLACE on the change's source with `focus="history"`: focus moves to the history, where the
// change and its undo are listed.
//
// Gate-5 fold (G5-13…G5-15). One app's registry row this file cannot read never empties the sheet
// (its grants and their *stop* are what matter most here): the pair and the offer each drop only the
// app they cannot read. A reader joined to this source by ANY access not stopped — paused or expired
// included — is not offered (*allow again* on its row is the act). The ⋈'s own rule answers the
// cheap widening first, so a brokered read's revision bump reads no grants in a file of several apps.

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

import type { AccessDecline, UserDb } from '@snugprotocol/db';
import type { AccessLogEntry } from '@snugprotocol/protocol';

import '../theme/access.css';
import '../theme/access-sheet.css';
import { useLibraryRevision } from '../platform/signals.js';
import { appMayUseAccess } from '../run/appCapabilityRules.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { AccessPairAct } from './AccessActLine.js';
import { AccessHistory, type UndoOutcome } from './AccessHistory.js';
import { AccessOffer, type OfferReader } from './AccessOffer.js';
import { pendingAccessStore } from './consent.js';
import { ACCESS_SHEET, CONSENT_SHEET } from './copy.js';
import { GrantRow } from './GrantRow.js';
import { accessDeps, foundGrants, grantsForApp, useAccessRevision, type LiveGrantRow } from './grants.js';
import { listPairSuggestions, type PairSuggestion } from './pairs.js';
import { isOfferable, registryTables } from './relevance.js';
import { startUserAsk } from './userAsk.js';

// ------------------------------------------------------------------------------------- data

interface SheetData {
  name: string;
  reads: LiveGrantRow[];
  readBy: LiveGrantRow[];
  history: AccessLogEntry[];
  /** The live journal entries this app holds as a TARGET — a `wrote` row whose `undoId` is here offers *undo*. */
  undoable: ReadonlySet<string>;
  declines: AccessDecline[];
  /** PR-5 (D-PR5-4): this app's best pair as the one that would read — absent without a declaration another app's tables meet. */
  pair: PairSuggestion | undefined;
  /** PR-5 (D-PR5-5): the apps this one could offer itself to — empty when it has no registered table or holds a WhatsApp fact. */
  offerTo: OfferReader[];
  now: number;
}

/** Whether this app has a registered table it could share — no when its registry row cannot be read (G5-13: never the sheet). */
function hasOfferableTable(db: UserDb, appId: string): boolean {
  try {
    return registryTables(db.getAppSchema(appId)).some(isOfferable);
  } catch {
    return false;
  }
}

/**
 * Who this app could offer itself to (D-PR5-5): nobody unless it has a registered table it could
 * share and holds no WhatsApp fact; otherwise every other app that may use access and holds no
 * access from it that is not stopped — live, paused or expired (G5-14: *allow again* on that row is
 * the act) — by name.
 */
function offerReaders(db: UserDb, appId: string, readBy: readonly LiveGrantRow[]): OfferReader[] {
  if (!hasOfferableTable(db, appId) || appHasSidecarFact(db, appId)) return [];
  const reading = new Set(readBy.filter((row) => row.grant.status !== 'revoked').map((row) => row.grant.readerAppId));
  return db
    .listApps()
    .filter((app) => app.appId !== appId && appMayUseAccess(app.appId) && !reading.has(app.appId))
    .map((app) => ({ appId: app.appId, displayName: app.displayName }))
    .sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0));
}

/** The engine's view of one app's access, re-read on every access and library revision. `undefined` until the first read lands. */
function useSheetData(appId: string): SheetData | undefined {
  const revision = useAccessRevision();
  const library = useLibraryRevision();
  const [data, setData] = useState<SheetData | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const now = accessDeps().now();
        // The file's grants read once (IB-7): this app's rows and its pair share them.
        const found = foundGrants(db);
        const { reads, readBy } = grantsForApp(db, appId, now, found);
        setData({
          name: db.getApp(appId)?.displayName ?? '',
          reads,
          readBy,
          history: db.listAccessLog(appId),
          undoable: new Set(db.listAccessUndo(appId).map((entry) => entry.id)),
          declines: db.listAccessDeclines(appId),
          pair: listPairSuggestions(db, now, { readerAppId: appId, found })[0],
          offerTo: offerReaders(db, appId, readBy),
          now,
        });
      })
      .catch(() => {
        // the file is not open (a swap in flight): the sheet shows what it last read
      });
    return () => {
      cancelled = true;
    };
  }, [appId, revision, library]);
  return data;
}

/**
 * Whether the ⋈ shows: the app has ACCESS STATE — access either way (any status), a pending ask,
 * or a declined ask — or, since PR-5 (D-PR5-5), the file holds ANOTHER app that may use access, so
 * the creation act and the offer have someone to name. Re-read on the access AND library revisions
 * (F17: an app installed or deleted while the header is up opens or shuts the door). `enabled:
 * false` reads nothing (a starter, a host without access). The cheap widening is answered FIRST
 * (IB-7): every brokered read bumps the access revision, and in a file of several apps the library
 * alone already says yes — the grants and declines are read only when it says no.
 */
export function useHasAccessState(appId: string, enabled: boolean): boolean {
  const revision = useAccessRevision();
  const library = useLibraryRevision();
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
        if (db.listApps().some((app) => app.appId !== appId && appMayUseAccess(app.appId))) {
          settle(true);
          return;
        }
        const { reads, readBy } = grantsForApp(db, appId, accessDeps().now());
        settle(reads.length > 0 || readBy.length > 0 || db.listAccessDeclines(appId).length > 0);
      })
      .catch(() => settle(false));
    return () => {
      cancelled = true;
    };
  }, [appId, enabled, revision, library]);
  return enabled && (pending || stored);
}

// -------------------------------------------------------------------------------------- sheet

export interface AccessSheetProps {
  appId: string;
  onClose: () => void;
  /** PR-5 (D-PR5-14): open with focus on the history — the cross-app card's act, where the change it made is listed. Absent: on ✕. */
  focus?: 'history';
}

export function AccessSheet({ appId, onClose, focus }: AccessSheetProps): ReactElement | null {
  const data = useSheetData(appId);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loaded = data !== undefined;

  // `focus="history"`: once the file is read, the history takes focus from ✕ (the overlay's own
  // focus runs first — a child's effect). The section is the history's own; it is made focusable
  // here, by the one caller that asks for it. No history yet: focus stays on ✕.
  useEffect(() => {
    if (focus !== 'history' || !loaded) return;
    const history = bodyRef.current?.querySelector<HTMLElement>('[data-testid="access-history"]');
    if (history === null || history === undefined) return;
    history.tabIndex = -1;
    history.focus();
  }, [focus, loaded]);

  // Not until the file is read: a dialog named "'s access" for a moment is a dialog misnamed.
  if (data === undefined) return null;
  const { name } = data;
  const heading = ACCESS_SHEET.title(name);

  /** The user's own ask for THIS app, reviewed alone: this sheet closes first. */
  const askAsUser = async (decline?: AccessDecline): Promise<void> => {
    onClose();
    await startUserAsk(appId, decline !== undefined ? { decline } : {});
  };

  /**
   * *undo* on a `wrote` row: the engine's act for the user (D-PR3-15), loaded at the call (the
   * load-order rule); the engine bumps the revision on every outcome, and this sheet's re-read
   * follows — the row loses its *undo*, the `undone` line appears. The engine answers errors as
   * data; a throw is the history's to word.
   */
  const undo = async (undoId: string): Promise<UndoOutcome> => {
    const db = await accessDeps().getDb();
    const { undoBrokeredWrite } = await import('./writeBroker.js');
    return undoBrokeredWrite(db, appId, undoId, { via: 'user' });
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
      <div ref={bodyRef} className="release-notes-scroll access-sheet-body">
        {nothing ? (
          <p className="hint access-sheet-nothing" data-testid="access-nothing">
            {ACCESS_SHEET.nothing(name)}
          </p>
        ) : null}

        {/* D6: each direction under its heading, drawn whenever its act is — the creation act always is. */}
        <section className="access-sheet-section" data-testid="access-reads">
          <h3 className="access-sheet-section-title">{ACCESS_SHEET.reads(name)}</h3>
          {data.reads.length > 0 ? (
            <ul className="access-row-list">
              {data.reads.map((row) => (
                <GrantRow key={row.grant.id} row={row} side="reads" now={data.now} onBeforeReview={onClose} />
              ))}
            </ul>
          ) : null}
          {/* PR-5 (D-PR5-4): the reader's best pair, above its creation act. */}
          <AccessPairAct readerAppId={appId} readerName={name} pair={data.pair} onBeforeAsk={onClose} />
          <div className="access-sheet-create">
            <Button onClick={() => void askAsUser()} data-testid="access-create">
              {ACCESS_SHEET.create(name)}
            </Button>
          </div>
        </section>

        {data.readBy.length > 0 || data.offerTo.length > 0 ? (
          <section className="access-sheet-section" data-testid="access-read-by">
            <h3 className="access-sheet-section-title">{ACCESS_SHEET.readBy(name)}</h3>
            {data.readBy.length > 0 ? (
              <ul className="access-row-list">
                {data.readBy.map((row) => (
                  <GrantRow key={row.grant.id} row={row} side="read-by" now={data.now} onBeforeReview={onClose} />
                ))}
              </ul>
            ) : null}
            {/* PR-5 (D-PR5-5): the source's offer, under the direction it opens. */}
            {data.offerTo.length > 0 ? <AccessOffer sourceAppId={appId} sourceName={name} readers={data.offerTo} onBeforeAsk={onClose} /> : null}
          </section>
        ) : null}

        {showHistory ? <AccessHistory entries={data.history} now={data.now} sourceName={name} undoable={data.undoable} onUndo={undo} /> : null}

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
      </div>
    </ConfirmOverlay>
  );
}
