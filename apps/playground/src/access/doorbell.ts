// access/doorbell.ts — three hints, ids only, to LIVE frames (TASK-20261010-host-broker PR-3;
// ADR-0076 §8; contract v2 D-PR3-20 (b)/(c)/(d); v2.1 notes E2-Q11/Q12, E1-dev; spec 1.2 §24.5
// (24) and §24.7 (29); AC24).
//
// WHAT A DOORBELL IS. A host-event into an app's live frame that says WHEN something happened and
// names nothing but one id or one table — a hint, never content (ADR-0034: host-event frames carry
// no `instanceId`, so an app could not verify a sender; they ride the ordinary frame class, where an
// oversize frame is dropped silently). Three of them:
//   · `access-source-changed { grantId }` — to every live READER of a source whose data changed: the
//     DRIVER's write signal (`subscribeWrites`: a frame's exec that modified rows, a frame's kvSet,
//     a whole-database import) through `armDoorbell`, COALESCED per source; and the Write Broker's
//     own ring after a brokered write (every other live reader — the writer knows what it wrote)
//     and after an undo (EVERY live reader — the one whose write was reversed holds the stalest
//     view, S19), uncoalesced;
//   · `access-read { grantId }` — to the SOURCE's live frame after a read: the Access Service rings
//     it after a frame's `query` is logged and after each grant a chat turn's `recordRead` recorded
//     (D-PR3-20 (d)), uncoalesced;
//   · `data-changed { table }` — to a brokered write's TARGET after a commit, and to the app's own
//     frame after its own approved write landed (D-PR3-8): the open app re-reads what another app,
//     or its chat, changed.
//
// THE COALESCING WINDOW (E2-Q12). Per SOURCE namespace: the first signal rings at once and opens a
// window of `ACCESS_DOORBELL_COALESCE_MS`; any further signal inside it is folded into exactly ONE
// more ring at the window's end; a lone signal has no trailing ring; another source's window is
// independent. The window is a timer, not a clock reading — it exists exactly while its timer
// stands — so a frozen test clock cannot pin it open. A kv-only window (every signal in it a `kv`)
// rings kv readers only: a `kv` signal concerns the source's settings & notes, which only a grant
// carrying `kv` can read; an exec or an import rings every live reader. A `brokered` signal is the
// Write Broker's to ring, with its `except` — the doorbell ignores it (E1-dev), else the writer
// would be rung for its own change.
//
// ONLY LIVE GRANTS, ONLY LIVE FRAMES. A ring walks `grantsForApp(db, source).readBy` and takes the
// rows that are live (active, unexpired, the source unrestricted) — a stopped or paused grant's
// reader hears nothing — and `notifyAppHost` answers false, silently, for a reader whose frame is
// not registered: a hidden frame is never registered and never rung; a 1.1 app simply does not
// listen. The host's OWN kv writes (`db.driver.kvSet` — the scheduler's handshake) raise no driver
// signal at all (D-PR3-20 (a)), so they reach nobody here.
//
// ARMED ONCE PER OPEN FILE, ON USE. `armDoorbell(db)` subscribes the facade's `subscribeWrites`
// (which survives `importUserDb`'s inner swap, F15) and answers the disarm; a second arm replaces
// the first, so there is always exactly one subscription (grants.ts's `armAccessListeners`
// pattern). `state/userdb.ts` arms it when a file opens and when a fresh one replaces a corrupt one.
//
// LOAD ORDER (grants.ts's rule): nothing here calls another access module at the top level. No
// string here spells the engine's internal words (copy.ts's vocabulary scan reads this file).

import { ACCESS_DOORBELL_COALESCE_MS, ACCESS_READ_EVENT, ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT } from '@snugprotocol/protocol';
import type { NamespaceWriteEvent, UserDb } from '@snugprotocol/db';

import { notifyAppHost } from '../state/appHosts.js';
import { accessDeps, grantsForApp, type LiveGrantRow } from './grants.js';

/** Which readers a coalesced ring reaches: every live one, or only those whose access carries `kv`. */
type Reach = 'all' | 'kv';

/** One source's open window: its timer, whether anything arrived inside it, and what those arrivals may reach. */
interface Window {
  timer: ReturnType<typeof setTimeout>;
  pending: boolean;
  reach: Reach;
}

const windows = new Map<string, Window>();
let disarm: (() => void) | undefined;

/** The live rows that read `sourceAppId`, minus `except` — the readers a change of the source concerns. */
function liveReadersOf(db: UserDb, sourceAppId: string, except?: string): LiveGrantRow[] {
  return grantsForApp(db, sourceAppId, accessDeps().now()).readBy.filter((row) => row.live && row.grant.readerAppId !== except);
}

/** Ring `access-source-changed { grantId }` into each live reader's frame — ids only; a closed frame is silently not there. */
function ringReaders(rows: readonly LiveGrantRow[]): void {
  for (const row of rows) notifyAppHost(row.grant.readerAppId, ACCESS_SOURCE_CHANGED_EVENT, { grantId: row.grant.id });
}

/** A coalesced ring of one source: every live reader, or only those with `kv`. */
function ringCoalesced(db: UserDb, sourceAppId: string, reach: Reach): void {
  ringReaders(liveReadersOf(db, sourceAppId).filter((row) => reach === 'all' || row.grant.kv === true));
}

/** The window's end: forgotten, and rung once more when anything arrived inside it. */
function closeWindow(db: UserDb, sourceAppId: string): void {
  const window = windows.get(sourceAppId);
  if (window === undefined) return;
  windows.delete(sourceAppId);
  if (window.pending) ringCoalesced(db, sourceAppId, window.reach);
}

/** The driver's signal (D-PR3-20 (a)) as the doorbell takes it: coalesced per source; a brokered one is the broker's. */
function onWrite(db: UserDb, event: NamespaceWriteEvent): void {
  const reach: Reach | undefined = ((): Reach | undefined => {
    switch (event.kind) {
      case 'exec':
      case 'import':
        return 'all';
      case 'kv':
        return 'kv';
      case 'brokered':
        return undefined;
    }
  })();
  if (reach === undefined) return;
  const open = windows.get(event.namespace);
  if (open !== undefined) {
    open.pending = true;
    if (reach === 'all') open.reach = 'all';
    return;
  }
  ringCoalesced(db, event.namespace, reach);
  const timer = setTimeout(() => closeWindow(db, event.namespace), ACCESS_DOORBELL_COALESCE_MS);
  (timer as { unref?: () => void }).unref?.();
  windows.set(event.namespace, { timer, pending: false, reach });
}

/** Drop every open window without ringing — the file is going away, or a test is done. */
function dropWindows(): void {
  for (const window of windows.values()) clearTimeout(window.timer);
  windows.clear();
}

/**
 * Hear the file's write signal and ring its sources' live readers (D-PR3-20 (b)). Once per open
 * file: a second arm replaces the first. Answers the disarm, which also drops every open window.
 */
export function armDoorbell(db: UserDb): () => void {
  disarm?.();
  const unsubscribe = db.driver.subscribeWrites((event) => onWrite(db, event));
  const off = (): void => {
    unsubscribe();
    dropWindows();
    if (disarm === off) disarm = undefined;
  };
  disarm = off;
  return off;
}

/** The Write Broker's ring to a write's TARGET (D-PR3-20 (c)): `data-changed { table }` — the table omitted when the statement could not say. */
export function ringDataChanged(targetAppId: string, table: string | undefined): void {
  notifyAppHost(targetAppId, DATA_CHANGED_EVENT, table === undefined ? {} : { table });
}

/** The Write Broker's ring to a source's live readers, uncoalesced: every live one but `except` (the writing reader after a write; nobody after an undo). */
export function ringSourceChanged(db: UserDb, sourceAppId: string, options: { except?: string } = {}): void {
  ringReaders(liveReadersOf(db, sourceAppId, options.except));
}

/** The Access Service's ring to a SOURCE's live frame after a read (D-PR3-20 (d)): `access-read { grantId }`, uncoalesced. */
export function ringRead(sourceAppId: string, grantId: string): void {
  notifyAppHost(sourceAppId, ACCESS_READ_EVENT, { grantId });
}
