// access/AccessConsentSheet.tsx — the ONE place access between apps is allowed
// (TASK-20261010-cross-app-access AC18, AC20; ADR-0075 §5; D11, D12, D13, D23, D30, D34).
//
// MOUNTED ONCE, IN THE APP SHELL (beside NetConfirmDialog): an ask is opened for review from the
// run view's strip, but also from Settings and the reader's access sheet, on any route. The sheet
// renders `reviewStore`'s reader's pending ask from `pendingAccessStore` and ends with ONE answer
// through `answerAccess` (the strip's line hears it).
//
// WHAT IT SHOWS, top to bottom: who is asking — the LIBRARY name and tile with the provenance line
// the host derived (D11; the collision note inside it); "<app> says:" with the purpose as a quoted
// text node in a bidi-isolated `<q>` (skipped for an access the user started — D34); *from* — the
// ranked candidates, their tables, columns and row counts (`SourcePicker`); *for how long*
// (`DurationControl`); *where <app> can send what it reads* (`EgressNote`, derived at the call for
// the chosen source and the away box); and the acts.
//
// THE PRIMARY NAMES THE CHOICE and is ARMED only after 600 ms of visibility (disabled before — a
// tap meant for what was under the sheet cannot land on *allow*), and a pointer activation whose
// pointerdown happened BEFORE this sheet rendered is ignored (the page-wide pointerdown stamp below
// is compared with this sheet's render stamp, both on the event clock). A keyboard activation has
// no pointerdown and is judged by the arming alone.
//
// Escape and the backdrop mean *not now*; focus starts on *not now*, Tab stays inside, and focus
// goes back to *review* when the sheet closes without an answer (after an answer *review* is gone
// and the strip's outcome line takes focus). THE YIELD RULE: the sheet never shows over a network
// or link confirm — one that arrives while it is open closes it unanswered (the strip still holds
// an app's ask); an ask the USER started has no strip to reopen it from, so the yield dismisses it
// (nothing recorded) instead of parking it out of reach. An ask that renews an access starts on
// that access's own duration and away box (`renewSeedOf` — AC21's one tap). Text nodes only.

import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { AccessDuration } from '@snugprotocol/protocol';

import { netConfirmStore } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { useStore } from '../state/store.js';
import '../theme/access.css';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { dismissReview, pendingAccessStore, reviewStore, type ConsentDecision, type PendingAccessRequest } from './consent.js';
import { ACCESS_SHEET, CONSENT_SHEET, allowLabel } from './copy.js';
import { DurationControl } from './DurationControl.js';
import { EgressNote } from './EgressNote.js';
import { answerAccess } from './outcome.js';
import { isOfferable, preselectedTables, type RankedSource } from './relevance.js';
import { SourcePicker } from './SourcePicker.js';
import { renewSeedOf } from './userAsk.js';

/** How long the sheet must have been visible before *allow* can be pressed. */
export const ACCESS_ARM_MS = 600;

// ------------------------------------------------------------------- the page-wide pointer stamp

/** The event-clock stamp of the last pointerdown anywhere on the page (capture phase). */
let lastPointerDownAt: number | undefined;
const notePointerDown = (event: Event): void => {
  lastPointerDownAt = event.timeStamp;
};

/** "Now" on the event clock — whatever clock this environment stamps events with. */
const eventClockNow = (): number => new Event('access-sheet-render').timeStamp;

/** A stable key per pending ask, so a newer ask remounts the sheet (fresh render stamp, fresh arming). */
const pendingKeys = new WeakMap<PendingAccessRequest, number>();
let nextPendingKey = 0;
function keyOf(pending: PendingAccessRequest): number {
  let key = pendingKeys.get(pending);
  if (key === undefined) {
    nextPendingKey += 1;
    key = nextPendingKey;
    pendingKeys.set(pending, key);
  }
  return key;
}

// ------------------------------------------------------------------------------------ the mount

export function AccessConsentSheet(): ReactElement | null {
  const reviewing = useStore(reviewStore);
  const pendings = useStore(pendingAccessStore);
  const netPending = useStore(netConfirmStore);
  const openUrlPending = useStore(openUrlConfirmStore);
  const otherConfirmOpen = netPending !== null || openUrlPending !== null;

  // Always listening while the shell is up, so a press that began before a sheet existed is known.
  useEffect(() => {
    window.addEventListener('pointerdown', notePointerDown, true);
    return () => window.removeEventListener('pointerdown', notePointerDown, true);
  }, []);

  // The yield rule: a network or link confirm closes the sheet, unanswered. An app's ask stays on
  // its strip; the user's own ask has no strip, so it is dismissed rather than left out of reach
  // (while parked it would answer the app's own asks ACCESS_PENDING).
  useEffect(() => {
    if (!otherConfirmOpen || reviewing === undefined) return;
    const parked = pendingAccessStore.get()[reviewing];
    if (parked !== undefined && parked.provenance === 'user') void answerAccess(parked, { kind: 'dismissed' });
    else dismissReview();
  }, [otherConfirmOpen, reviewing]);

  const pending = reviewing === undefined ? undefined : pendings[reviewing];
  if (pending === undefined || otherConfirmOpen) return null;
  return <ConsentSheetBody key={keyOf(pending)} pending={pending} />;
}

// ------------------------------------------------------------------------------------- the sheet

function inSourceOrder(source: RankedSource, tables: readonly string[]): string[] {
  return source.tables.filter((table) => isOfferable(table) && tables.includes(table.name)).map((table) => table.name);
}

function ConsentSheetBody({ pending }: { pending: PendingAccessRequest }): ReactElement {
  const { candidates, preselect, readerName } = pending;
  const all = useMemo(() => [...candidates.matched, ...candidates.rest], [candidates]);
  const sourceOf = (appId: string | undefined): RankedSource | undefined => (appId === undefined ? undefined : all.find((source) => source.appId === appId));

  const preselected = sourceOf(preselect?.appId);
  const [chosenAppId, setChosenAppId] = useState<string | undefined>(preselected?.appId);
  const [ticked, setTicked] = useState<Readonly<Record<string, readonly string[]>>>(() =>
    preselected !== undefined && preselect !== undefined ? { [preselected.appId]: inSourceOrder(preselected, preselect.tables) } : {},
  );
  const [showMore, setShowMore] = useState(() => candidates.matched.length === 0 || (preselected !== undefined && candidates.rest.includes(preselected)));
  // The session is the default (D13) — unless this ask renews an access: then that access's own choice.
  const [seed] = useState(() => renewSeedOf(pending));
  const [duration, setDuration] = useState<AccessDuration>(seed?.duration ?? 'session');
  const [away, setAway] = useState(seed?.unattended ?? false);
  const [armed, setArmed] = useState(false);
  const [renderedAt] = useState(eventClockNow);
  const answered = useRef(false);
  const notNowRef = useRef<HTMLButtonElement>(null);

  const titleId = useId();
  const fromId = useId();
  const howLongId = useId();
  const egressId = useId();
  const sourcesName = useId();
  const durationsName = useId();

  // Armed after ACCESS_ARM_MS of VISIBILITY: a hidden page disarms, and showing again starts over.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      setArmed(false);
      if (document.visibilityState === 'hidden') return;
      timer = setTimeout(() => setArmed(true), ACCESS_ARM_MS);
    };
    start();
    document.addEventListener('visibilitychange', start);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', start);
    };
  }, []);

  const chosen = sourceOf(chosenAppId);
  const tables = chosen === undefined ? [] : inSourceOrder(chosen, ticked[chosen.appId] ?? []);
  const ready = chosen !== undefined && tables.length > 0;
  // A memory access is never usable while away (D30): the box is not even offered then.
  const unattended = duration !== 'session' && away;

  const sourceName = chosen?.displayName;
  const lines = useMemo(() => {
    if (sourceName !== undefined) return pending.egressFor({ unattended, sourceName });
    // No app chosen yet: every line but the closing one, which names the app that keeps the history.
    return pending.egressFor({ unattended, sourceName: '' }).filter((line) => line.kind !== 'closing');
  }, [pending, unattended, sourceName]);

  const answer = (decision: ConsentDecision): void => {
    if (answered.current) return;
    answered.current = true;
    void answerAccess(pending, decision);
  };
  const notNow = (): void => answer({ kind: 'not-now' });

  const choose = (appId: string): void => {
    setChosenAppId(appId);
    const source = sourceOf(appId);
    if (source !== undefined && ticked[appId] === undefined) setTicked({ ...ticked, [appId]: preselectedTables(source) });
  };
  const toggle = (appId: string, table: string, on: boolean): void => {
    const current = ticked[appId] ?? [];
    setTicked({ ...ticked, [appId]: on ? [...current.filter((name) => name !== table), table] : current.filter((name) => name !== table) });
  };

  const allow = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (!armed || !ready || chosen === undefined) return;
    // A pointer activation (detail > 0) whose press began before this sheet existed is not consent.
    if (event.detail > 0 && lastPointerDownAt !== undefined && lastPointerDownAt < renderedAt) return;
    answer({ kind: 'allow', sourceAppId: chosen.appId, tables, duration, unattended });
  };

  const tileStyle = { '--tile-color': pending.readerIcon?.color ?? 'var(--ember)' } as CSSProperties;

  return (
    <ConfirmOverlay labelledBy={titleId} onDismiss={notNow} initialFocusRef={notNowRef} trapFocus cardClassName="release-notes-card access-sheet" data-testid="access-consent-sheet">
      <div className="access-sheet-head">
        <span className="access-tile" style={tileStyle} aria-hidden="true" data-testid="access-sheet-tile">
          {pending.readerIcon?.emoji ?? '⬡'}
        </span>
        <div>
          <h2 id={titleId} className="net-confirm-title" data-testid="access-sheet-title">
            {/* An ask the USER started is theirs — never a want put in the app's mouth (W6 finding 35). */}
            {pending.provenance === 'user' ? CONSENT_SHEET.userTitle(readerName) : CONSENT_SHEET.title(readerName)}
          </h2>
          <p className="access-provenance" data-testid="access-sheet-provenance">
            {pending.readerProvenance}
          </p>
        </div>
      </div>

      <div className="release-notes-scroll access-sheet-body">
        {pending.provenance === 'app' ? (
          <p className="access-says" data-testid="access-sheet-says">
            {CONSENT_SHEET.says(readerName)}{' '}
            <q className="access-quote" data-testid="access-sheet-quote">
              {CONSENT_SHEET.quote(pending.purpose)}
            </q>
          </p>
        ) : (
          <p className="access-says" data-testid="access-sheet-user">
            {/* The host's own sentence (D34), never the pending's text: nothing an app wrote is ever shown unquoted. */}
            {ACCESS_SHEET.userPurpose(readerName)}
          </p>
        )}

        <section className="access-section" aria-labelledby={fromId}>
          <h3 id={fromId} className="access-section-title">
            {CONSENT_SHEET.from}
          </h3>
          <SourcePicker
            candidates={candidates}
            chosenAppId={chosenAppId}
            tablesOf={(appId) => ticked[appId] ?? []}
            onChoose={choose}
            onToggle={toggle}
            showMore={showMore}
            onShowMore={() => setShowMore(true)}
            groupName={sourcesName}
            labelledBy={fromId}
          />
        </section>

        <DurationControl readerName={readerName} duration={duration} onDuration={setDuration} away={away} onAway={setAway} groupName={durationsName} titleId={howLongId} />

        <EgressNote readerName={readerName} lines={lines} titleId={egressId} />
      </div>

      <div className="access-sheet-actions">
        {!ready ? (
          <p className="access-pick-table" data-testid="access-pick-table">
            {/* No app chosen means no table on screen to tick: ask for the app first (W6 finding 41). */}
            {chosen === undefined ? CONSENT_SHEET.pickAnApp : CONSENT_SHEET.pickATable}
          </p>
        ) : null}
        {pending.provenance === 'app' ? (
          <Button variant="ghost" onClick={() => answer({ kind: 'dont-allow' })} data-testid="access-dont-allow">
            {CONSENT_SHEET.dontAllow}
          </Button>
        ) : null}
        {/* A plain button: `ui/Button` does not forward a ref, and focus starts here. */}
        <button type="button" ref={notNowRef} className="btn" onClick={notNow} data-testid="access-not-now">
          {CONSENT_SHEET.notNow}
        </button>
        <Button variant="primary" disabled={!armed || !ready} onClick={allow} data-testid="access-allow">
          {allowLabel(duration)}
        </Button>
      </div>
    </ConfirmOverlay>
  );
}
