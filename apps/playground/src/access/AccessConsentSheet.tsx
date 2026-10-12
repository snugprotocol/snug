// access/AccessConsentSheet.tsx — the ONE place access between apps is allowed
// (TASK-20261010-cross-app-access AC18, AC20; ADR-0075 §5; D11, D12, D13, D23, D30, D34).
//
// MOUNTED ONCE, IN THE APP SHELL (beside NetConfirmDialog): an ask is opened for review from the
// run view's strip, but also from Settings and the reader's access sheet, on any route. The sheet
// renders `reviewStore`'s reader's pending ask from `pendingAccessStore` and ends with ONE answer
// through `answerAccess` (the strip's line hears it).
//
// WHAT IT SHOWS, top to bottom: who is asking — the LIBRARY name and tile with the provenance line
// the host derived (D11; the collision note inside it); the says-line, THREE-WAY (DS-15): an ask
// the chat's AI made (`askedIn: 'chat'`, TASK-20261010-host-broker PR-2) reads "asked in <app>'s
// chat:" with the AI's purpose as a quoted text node in a bidi-isolated `<q>`; an app's ask reads
// "<app> says:" with its purpose quoted the same way; an access the user started shows the host's
// own sentence and no quote (D34); *from* — the ranked candidates, their tables, columns and row
// counts (`SourcePicker`); *for how long* (`DurationControl`); *where <app> can send what it
// reads* (`EgressNote`, derived at the call for the chosen source and the away box); and the acts
// — *don't allow* offered for an app's ask and for the chat's (it records the ask's hash, so the
// tool's "won't ask this again" is true), never for an ask the user started themselves.
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
// (nothing recorded) instead of parking it out of reach. An ask that carries a seed starts on it
// (`sheetSeedOf`): a renewal on that access's own duration and away box (AC21's one tap), the
// chat's ask reviewed while the reader is closed on a day (D-PR2-3). Text nodes only.
//
// THE SHEET v2 (TASK-20261010-host-broker PR-3; ADR-0076 §4; D-PR3-4/23; DS2–DS6, DS18, DS23;
// contract v2.1 U-Q7, U-Q12, U-Q14). The chips stay on the default path; what a ticked table's
// row adds — *choose columns…* and, under *more options…*, the write toggle — lives in
// `TableChooser`, and the options row (*settings & notes*, *fetch new data first*) in
// `SourcePicker`. This sheet owns the state they show: per app, the ticked tables with their
// ticked columns and write toggle, and the two options; and whether *more options…* is open —
// OPEN at once when the ask carried `access: 'write'` (`wantsWrite`: the title says "— and change
// —" and the toggle is on screen, still OFF: the app never pre-ticks it) or when a renewal's seed
// carries a write, kv or refresh (the old scope back in one tap, nothing clicked). A table whose
// every column is unticked cannot be allowed (*choose at least one column*, the `pickATable`
// twin). The egress block gains NO line for a write or a fetch; its closing says *reads and
// changes* exactly while a write is ticked (`canChange` passed only then). The allow answers the
// decision v2: per table `{ name, withheld, write }` — the unticked columns in the source's order
// — and `kv` / `refresh` as ticked.
//
// PR-5 (TASK-20261010-host-broker; contract v2 D-PR5-3/5/15; D4, D7, D17). The says-line gains a
// FOURTH branch: an ask the person started from what the app says it would like to read
// (`askedIn: 'declared'`) reads "what Budget says it's for:" with the app's purpose quoted and
// isolated like an app's — never "would like to: “to …”" — under the person's own title, and
// offers *don't allow* only when the want had hints (`declinable`: it records that want's no). A
// SOURCE's offer (`offeredBy: 'source'`) is the same one sheet, pinned to that source and titled
// for what the person lets happen ("let Budget read Ledger's data"); it is READ-ONLY by
// construction — `canChange={false}` flows to `SourcePicker` and `TableChooser`, so no write toggle
// exists anywhere, *more options…* describes only settings & notes and the fetch, and the allow
// answers every table unwritten (the consent writer refuses a write on an offer too). The chat's
// ask that wanted to change rows is titled for it ("let Budget read and change another app's data").
// Gate-5 G5-15 (IB-6, S10): on a declared ask (`tableTierOnly`), ANY source the person picks starts
// with only its TABLE-tier tables for the want's hints ticked — never a column match or every table.

import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { AccessDuration, AccessScope } from '@snugprotocol/protocol';

import { netConfirmStore } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { useStore } from '../state/store.js';
import '../theme/access.css';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { dismissReview, pendingAccessStore, reviewStore, type ConsentDecision, type PendingAccessRequest } from './consent.js';
import { ACCESS_SHEET, CONSENT_SHEET, allowLabel } from './copy.js';
import { DurationControl } from './DurationControl.js';
import type { EgressOptions } from './egress.js';
import { EgressNote } from './EgressNote.js';
import type { TableChoice } from './grants.js';
import { answerAccess } from './outcome.js';
import { isOfferable, preselectedTables, tableTierTables, type RankedSource, type SourceTable } from './relevance.js';
import { SourcePicker, type SourceOptions } from './SourcePicker.js';
import type { TableTick } from './TableChooser.js';
import { sheetSeedOf } from './userAsk.js';

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

// --------------------------------------------------------------------------------- the choices

/** The ticked tables of one app, by name. */
type Ticks = Readonly<Record<string, TableTick>>;

const NO_OPTIONS: SourceOptions = { kv: false, refresh: false };

/** A table's columns the person may tick: the disclosed, non-sensitive ones, in the source's order. */
const readableColumns = (table: SourceTable): string[] => table.columns.filter((column) => !column.sensitive).map((column) => column.name);

/** A freshly ticked table: every readable column ticked, the write toggle off. */
const fullTick = (table: SourceTable): TableTick => ({ columns: readableColumns(table), write: false });

/**
 * The ticks for `names` of `source` — every readable column, minus the ones a renewal's seed held
 * WITHHELD, with its write toggle (the old scope back as it was; a column the source gained since
 * is offered ticked, as it is everywhere else on the sheet).
 */
function ticksFor(source: RankedSource, names: readonly string[], seeded?: AccessScope['tables']): Ticks {
  const ticks: Record<string, TableTick> = {};
  for (const table of source.tables) {
    if (!isOfferable(table) || !names.includes(table.name)) continue;
    const old = seeded?.find((entry) => entry.name === table.name);
    const withheld = new Set(old?.withheld ?? []);
    ticks[table.name] = { columns: readableColumns(table).filter((column) => !withheld.has(column)), write: old?.write === true };
  }
  return ticks;
}

/** A ticked table as the decision says it (D-PR3-23), with how many of its columns stayed ticked. */
interface TableAnswer {
  choice: TableChoice;
  columnsTicked: number;
}

/** The chosen app's ticked tables in the source's order, each with its withheld columns in that order too (U-Q14). */
function answersFor(source: RankedSource, ticks: Ticks): TableAnswer[] {
  return source.tables.flatMap((table) => {
    const tick = ticks[table.name];
    if (tick === undefined || !isOfferable(table)) return [];
    const on = new Set(tick.columns);
    const readable = readableColumns(table);
    const withheld = readable.filter((column) => !on.has(column));
    return [{ choice: { name: table.name, withheld, write: tick.write }, columnsTicked: readable.length - withheld.length }];
  });
}

// ------------------------------------------------------------------------------------- the sheet

function ConsentSheetBody({ pending }: { pending: PendingAccessRequest }): ReactElement {
  const { candidates, preselect, readerName } = pending;
  const all = useMemo(() => [...candidates.matched, ...candidates.rest], [candidates]);
  const sourceOf = (appId: string | undefined): RankedSource | undefined => (appId === undefined ? undefined : all.find((source) => source.appId === appId));

  // The session is the default (D13) — unless the ask carries a seed: a renewal's own choice (its
  // whole scope, PR-3), or the chat's day.
  const [seed] = useState(() => sheetSeedOf(pending));
  const preselected = sourceOf(preselect?.appId);
  const [chosenAppId, setChosenAppId] = useState<string | undefined>(preselected?.appId);
  const [ticked, setTicked] = useState<Readonly<Record<string, Ticks>>>(() =>
    preselected !== undefined && preselect !== undefined ? { [preselected.appId]: ticksFor(preselected, preselect.tables, seed?.tables) } : {},
  );
  const [options, setOptions] = useState<Readonly<Record<string, SourceOptions>>>(() =>
    preselected !== undefined ? { [preselected.appId]: { kv: seed?.kv === true, refresh: seed?.refresh === true } } : {},
  );
  // *more options…* starts OPEN exactly when it matters (DS6): the ask said write, or the seed turned something on.
  const [optionsOpen, setOptionsOpen] = useState(
    () => pending.wantsWrite === true || seed?.kv === true || seed?.refresh === true || (seed?.tables?.some((table) => table.write === true) ?? false),
  );
  const [showMore, setShowMore] = useState(() => candidates.matched.length === 0 || (preselected !== undefined && candidates.rest.includes(preselected)));
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
  const answers = chosen === undefined ? [] : answersFor(chosen, ticked[chosen.appId] ?? {});
  const tables = answers.map((answer) => answer.choice);
  // A table whose every column is unticked cannot be allowed (D-PR3-23) — the sheet says so before the writer would.
  const bare = answers.some((answer) => answer.columnsTicked === 0);
  const ready = chosen !== undefined && tables.length > 0 && !bare;
  const canChange = tables.some((table) => table.write);
  const chosenOptions = chosen === undefined ? NO_OPTIONS : (options[chosen.appId] ?? NO_OPTIONS);
  // A memory access is never usable while away (D30): the box is not even offered then.
  const unattended = duration !== 'session' && away;

  // D-PR5-5: an offer can never change rows — no toggle is drawn, and none is ever answered.
  const changeOffered = pending.offeredBy !== 'source';
  /** The pinned source's name, for an offer's title (its only candidate, preselected). */
  const offeredFrom = pending.offeredBy === 'source' ? sourceOf(preselect?.appId)?.displayName : undefined;

  const sourceName = chosen?.displayName;
  const lines = useMemo(() => {
    // `canChange` only while a write is ticked (U-Q7): the closing then says *reads and changes*.
    const opts = (name: string): EgressOptions => ({ unattended, sourceName: name, ...(canChange ? { canChange: true } : {}) });
    if (sourceName !== undefined) return pending.egressFor(opts(sourceName));
    // No app chosen yet: every line but the closing one, which names the app that keeps the history.
    return pending.egressFor(opts('')).filter((line) => line.kind !== 'closing');
  }, [pending, unattended, sourceName, canChange]);

  const answer = (decision: ConsentDecision): void => {
    if (answered.current) return;
    answered.current = true;
    void answerAccess(pending, decision);
  };
  const notNow = (): void => answer({ kind: 'not-now' });

  /** The tables a source starts with when the person picks it: a declared ask's TABLE tier only (S10), else the ranking's own. */
  const startingTables = (source: RankedSource): string[] => (pending.tableTierOnly === true ? tableTierTables(source, pending.hints) : preselectedTables(source));
  const choose = (appId: string): void => {
    setChosenAppId(appId);
    const source = sourceOf(appId);
    if (source !== undefined && ticked[appId] === undefined) setTicked({ ...ticked, [appId]: ticksFor(source, startingTables(source)) });
  };
  const toggle = (appId: string, table: string, on: boolean): void => {
    const { [table]: _was, ...rest } = ticked[appId] ?? {};
    const offered = sourceOf(appId)?.tables.find((entry) => entry.name === table);
    setTicked({ ...ticked, [appId]: on && offered !== undefined ? { ...rest, [table]: fullTick(offered) } : rest });
  };
  /** One ticked table's choices, patched; an unticked table has none to patch. */
  const patchTick = (appId: string, table: string, patch: (tick: TableTick) => TableTick): void => {
    const ticks = ticked[appId] ?? {};
    const tick = ticks[table];
    if (tick === undefined) return;
    setTicked({ ...ticked, [appId]: { ...ticks, [table]: patch(tick) } });
  };
  const column = (appId: string, table: string, name: string, on: boolean): void =>
    patchTick(appId, table, (tick) => ({ ...tick, columns: on ? [...tick.columns.filter((entry) => entry !== name), name] : tick.columns.filter((entry) => entry !== name) }));
  const write = (appId: string, table: string, on: boolean): void => patchTick(appId, table, (tick) => ({ ...tick, write: on }));
  const option = (appId: string, key: keyof SourceOptions, on: boolean): void => setOptions({ ...options, [appId]: { ...(options[appId] ?? NO_OPTIONS), [key]: on } });

  const allow = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (!armed || !ready || chosen === undefined) return;
    // A pointer activation (detail > 0) whose press began before this sheet existed is not consent.
    if (event.detail > 0 && lastPointerDownAt !== undefined && lastPointerDownAt < renderedAt) return;
    const allowed = changeOffered ? tables : tables.map((table) => ({ ...table, write: false }));
    answer({ kind: 'allow', sourceAppId: chosen.appId, tables: allowed, duration, unattended, kv: chosenOptions.kv, refresh: chosenOptions.refresh });
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
            {/* An ask the USER started is theirs — never a want put in the app's mouth (W6 finding 35); a write ask says so (DS2, D-PR5-15); an offer names what the person lets happen (D-PR5-5). */}
            {offeredFrom !== undefined
              ? CONSENT_SHEET.offerTitle(readerName, offeredFrom)
              : pending.provenance === 'user'
                ? CONSENT_SHEET.userTitle(readerName, pending.wantsWrite === true)
                : CONSENT_SHEET.title(readerName, pending.wantsWrite === true)}
          </h2>
          <p className="access-provenance" data-testid="access-sheet-provenance">
            {pending.readerProvenance}
          </p>
        </div>
      </div>

      <div className="release-notes-scroll access-sheet-body">
        {pending.askedIn === 'chat' ? (
          <p className="access-says" data-testid="access-sheet-says">
            {/* The AI's words, quoted and isolated exactly as an app's would be — never the host's own line (DS-15). */}
            {CONSENT_SHEET.askedInChat(readerName)}{' '}
            <q className="access-quote" data-testid="access-sheet-quote">
              {CONSENT_SHEET.quote(pending.purpose)}
            </q>
          </p>
        ) : pending.askedIn === 'declared' ? (
          <p className="access-says" data-testid="access-sheet-says">
            {/* What the app said it would like to read — its words quoted and isolated, never "would like to: “to …”" (D4). */}
            {CONSENT_SHEET.declaredSays(readerName)}{' '}
            <q className="access-quote" data-testid="access-sheet-quote">
              {CONSENT_SHEET.quote(pending.purpose)}
            </q>
          </p>
        ) : pending.provenance === 'app' ? (
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
            readerName={readerName}
            tickedOf={(appId) => ticked[appId] ?? {}}
            optionsOf={(appId) => options[appId] ?? NO_OPTIONS}
            optionsOpen={optionsOpen}
            onOptionsOpen={setOptionsOpen}
            onChoose={choose}
            onToggle={toggle}
            onColumn={column}
            onWrite={write}
            onOption={option}
            showMore={showMore}
            onShowMore={() => setShowMore(true)}
            groupName={sourcesName}
            labelledBy={fromId}
            canChange={changeOffered}
          />
        </section>

        <DurationControl readerName={readerName} duration={duration} onDuration={setDuration} away={away} onAway={setAway} groupName={durationsName} titleId={howLongId} />

        <EgressNote readerName={readerName} lines={lines} titleId={egressId} />
      </div>

      <div className="access-sheet-actions">
        {!ready ? (
          <p className="access-pick-table" data-testid="access-pick-table">
            {/* No app chosen means no table on screen to tick: ask for the app first (W6 finding 41); then a table; then at least one column of each. */}
            {chosen === undefined ? CONSENT_SHEET.pickAnApp : tables.length === 0 ? CONSENT_SHEET.pickATable : CONSENT_SHEET.pickAColumn}
          </p>
        ) : null}
        {pending.provenance === 'app' || pending.askedIn === 'chat' || (pending.askedIn === 'declared' && pending.declinable === true) ? (
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
