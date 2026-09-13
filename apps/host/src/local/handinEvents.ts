// Hand-ins over the event stream (ADR-0068 AC8, D-B26).
//
// Binding A reads its bundles from the page's own script blocks, ONCE, before the first
// paint. Here they arrive whenever the agent sends one — while the user sits on the hub, or
// while they are inside the very app being updated. That difference is the whole of this
// module: the same `handInFromPage` does the applying, and what it needs on top is a way to
// tell the surfaces that something changed.

import type { UserDb } from '@snugprotocol/db';

import { handInFromPage, type HandInOutcome } from '../handin.js';

export interface HandInEventDeps {
  getDb(): Promise<UserDb>;
  /** The hub reads its library once at mount, so a delivered app is invisible without this. */
  onLibraryChanged(): void | Promise<void>;
  /** Surfaced on the custody chip: an app that quietly did not arrive is worse than an error. */
  onNote(note: string): void;
}

/** A bundle as the process pushes it. */
export interface HandInEvent {
  bundle: unknown;
}

export function describeLocalHandIn(outcome: HandInOutcome): string | undefined {
  const parts: string[] = [];
  if (outcome.installed.length > 0) parts.push(`added ${outcome.installed.length === 1 ? 'an app' : `${outcome.installed.length} apps`}`);
  if (outcome.updated.length > 0) parts.push(`updated ${outcome.updated.length === 1 ? 'an app' : `${outcome.updated.length} apps`}`);
  if (outcome.pending.length > 0) parts.push(`${outcome.pending.length} update${outcome.pending.length === 1 ? '' : 's'} waiting for you`);
  for (const refusal of outcome.refused) parts.push(refusal.reason);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * Apply one delivered bundle. The lineage is read from the bundle itself rather than trusted
 * from the envelope: the two disagreeing is exactly the case `handInFromPage` refuses.
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
  const db = await deps.getDb();
  const outcome = await handInFromPage(db, [{ lineage: typeof lineage === 'string' ? lineage : '', json }], { binding: 'local-host' });
  const note = describeLocalHandIn(outcome);
  if (note !== undefined) deps.onNote(note);
  // Always, even for a refusal: the hub's own list is cheap to re-read and a stale shelf is
  // the failure this module exists to prevent.
  await deps.onLibraryChanged();
  return outcome;
}
