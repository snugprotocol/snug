// Hand-ins over the event stream (ADR-0068 AC8, D-B26; TASK-20261003 K6).
//
// Binding A reads its bundles from the page's own script blocks, ONCE, before the first
// paint. Here they arrive whenever the agent sends one — while the user sits on the hub, or
// while they are inside the very app being updated. The applying is the ONE core's
// (`applyAgentBundles`), the offer for an edited copy is the ONE seat's, and the sentence on
// the chip is the ONE summary's (`describeHandIn`). What this module adds is only what a
// LIVE hand-in needs on top: telling the surfaces the library changed, and telling the
// runner what became of the bundle, so the tool that sent it can answer its agent with the
// truth instead of "handed to the open runner".

import type { UserDb } from '@snugprotocol/db';

import { applyAgentBundles, describeHandIn, type HandInOutcome, type HandInSeat } from '../handin.js';
import type { HandInReport } from './client.js';

/**
 * How long a hand-in waits for the user's file. The page's `getUserDb()` does not reject
 * when the file cannot open — it never settles (the App shows its recovery surface instead)
 * — and the runner's tool waits `HAND_IN_WAIT_MS` (5 s, `apps/host-mcp` `runner.ts`) for this
 * page's report. Waited on unbounded, "your Snug file could not be opened" could never be
 * said, and the agent got "sent — not confirmed": the one answer that tells it nothing about
 * a file that is broken. So the wait ends well inside the runner's, with room for the
 * report's own round trip (a test pins the two together); a file still opening at page
 * load is over loopback and takes a fraction of this.
 */
export const HAND_IN_DB_BOUND_MS = 3_000;

export interface HandInEventDeps {
  getDb(): Promise<UserDb>;
  /** `HAND_IN_DB_BOUND_MS`, for a test that cannot wait three seconds. */
  dbBoundMs?: number;
  /** The offers for edited copies: the outcome is folded in, so an offered update can be taken in the run header. */
  handIns: Pick<HandInSeat, 'absorb'>;
  /** The hub reads its library at mount and on this signal, so a delivered app is invisible without it. */
  onLibraryChanged(): void | Promise<void>;
  /** Surfaced on the custody chip: an app that quietly did not arrive is worse than an error. */
  onNote(note: string): void;
  /** What became of the bundle, for the runner's `snug_hand_in` answer. */
  report(report: HandInReport): void | Promise<void>;
}

/** A bundle as the process pushes it, with the id its outcome is reported under. */
export interface HandInEvent {
  id?: unknown;
  bundle: unknown;
}

/**
 * One bundle's outcome, in the runner's five words. An event carries ONE bundle, so exactly
 * one of the outcome's lists has an entry.
 */
export function reportFor(outcome: HandInOutcome): Omit<HandInReport, 'id'> {
  if (outcome.installed.length > 0) return { outcome: 'installed' };
  const updated = outcome.updated[0];
  if (updated !== undefined) return { outcome: 'updated', version: updated.version };
  if (outcome.pending.length > 0) return { outcome: 'offered' };
  const refused = outcome.refused[0];
  if (refused !== undefined) return { outcome: 'refused', reason: refused.reason };
  // What is left is a skip. An explicit hand-in is never skipped as dismissed (it clears the
  // tombstone), so this is the bundle the user's copy already is.
  return { outcome: 'current' };
}

/**
 * The user's file, or a rejection once the bound has passed. A file that opens AFTER that is
 * dropped, not applied: by then the agent has been told "refused", and must not find the
 * app installed anyway.
 */
async function openWithin(getDb: () => Promise<UserDb>, boundMs: number): Promise<UserDb> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  const tooLate = new Promise<never>((_, reject) => {
    bound = setTimeout(() => reject(new Error('it did not open in time')), boundMs);
  });
  try {
    return await Promise.race([getDb(), tooLate]);
  } finally {
    clearTimeout(bound);
  }
}

/**
 * Apply one delivered bundle. The lineage is read from the bundle itself rather than trusted
 * from the envelope: the two disagreeing is exactly the case the core refuses.
 */
export async function applyHandInEvent(event: HandInEvent, deps: HandInEventDeps): Promise<HandInOutcome> {
  const json = typeof event.bundle === 'string' ? event.bundle : JSON.stringify(event.bundle);
  const lineage = (() => {
    try {
      return (JSON.parse(json) as { lineage?: unknown }).lineage;
    } catch {
      return undefined;
    }
  })();
  let outcome: HandInOutcome;
  try {
    const db = await openWithin(() => deps.getDb(), deps.dbBoundMs ?? HAND_IN_DB_BOUND_MS);
    // `explicit`: the agent is handing this in NOW, at the user's request — the one rule
    // this binding does not share with a page's embedded blocks (see `HandInOptions`).
    outcome = await applyAgentBundles(db, [{ lineage: typeof lineage === 'string' ? lineage : '', json }], { binding: 'local-host', explicit: true });
    deps.handIns.absorb(db, outcome);
  } catch (error) {
    // The user's file could not be opened (or read): nothing was applied, and both the
    // user and the agent are told why rather than left with a hand-in that went nowhere.
    outcome = { installed: [], updated: [], pending: [], skipped: [], refused: [{ lineage: typeof lineage === 'string' ? lineage : '', reason: `your Snug file could not be opened (${error instanceof Error ? error.message : String(error)})` }] };
  }
  const note = describeHandIn(outcome);
  if (note !== undefined) deps.onNote(note);
  if (typeof event.id === 'string') await deps.report({ id: event.id, ...reportFor(outcome) });
  // Always, even for a refusal: the hub's own list is cheap to re-read and a stale shelf is
  // the failure this module exists to prevent.
  try {
    await deps.onLibraryChanged();
  } catch {
    // The refresh reads the same file, so where the file is what failed, this fails too (on
    // the page it waits for the file instead; either way the outcome above is already
    // reported). It must not turn a hand-in that has its outcome into a rejection nobody
    // is awaiting — the surfaces read again on the next bump.
  }
  return outcome;
}
