// access/outcome.ts — THE way an ask is answered from host chrome, and the one line it leaves
// (TASK-20261010-cross-app-access AC18; D12). A leaf: no React, no CSS.
//
// The strip (run view) and the consent sheet (app shell) both answer through `answerAccess`: the
// pending's ONE `resolve`, then — when the outcome deserves a line — a record in
// `accessOutcomeStore` that the reader's strip renders for this visit. The record is SEQUENCED,
// so a strip never shows an outcome from before it mounted (or before the ask it is showing).
//
// A failure is recorded with the engine's message, but the strip says it only through
// `failedWords` (copy.ts): a message the engine did not word for a person goes to the console.

import { createStore, type Store } from '../state/store.js';
import type { ConsentDecision, ConsentOutcome, PendingAccessRequest } from './consent.js';

/** What a strip's line says: the engine's outcome, or the undo's own result. */
export type StripOutcome = ConsentOutcome | { kind: 'stopped'; sourceName: string; tables: string[] };

export interface RecordedOutcome {
  /** Monotonic — a strip shows only outcomes recorded after it mounted (or after its last ask). */
  seq: number;
  readerName: string;
  outcome: StripOutcome;
}

let outcomeSeq = 0;

/** The sequence number of the last outcome recorded — a strip remembers it as "since". */
export function lastOutcomeSeq(): number {
  return outcomeSeq;
}

/** Reader app id → the last answer to its ask, for the strip's one line. */
export const accessOutcomeStore: Store<Readonly<Record<string, RecordedOutcome>>> = createStore<Readonly<Record<string, RecordedOutcome>>>({});

/** Record the line the reader's strip shows next. */
export function recordOutcome(readerAppId: string, readerName: string, outcome: StripOutcome): void {
  outcomeSeq += 1;
  accessOutcomeStore.set({ ...accessOutcomeStore.get(), [readerAppId]: { seq: outcomeSeq, readerName, outcome } });
}

/** Whether an outcome deserves a line: a dismissal never does; an ask the user started says only what was allowed or failed. */
function worthALine(pending: PendingAccessRequest, outcome: ConsentOutcome): boolean {
  if (outcome.kind === 'dismissed') return false;
  return pending.provenance === 'app' || outcome.kind === 'allowed' || outcome.kind === 'failed';
}

/**
 * THE way the strip and the sheet answer an ask: the pending's ONE `resolve`, then the line the
 * reader's strip shows for it. A failure's raw message is kept for the console.
 */
export async function answerAccess(pending: PendingAccessRequest, decision: ConsentDecision): Promise<ConsentOutcome> {
  const outcome = await pending.resolve(decision);
  if (outcome.kind === 'failed') console.warn('[snug] access: the allow was not written —', outcome.message);
  if (worthALine(pending, outcome)) recordOutcome(pending.readerAppId, pending.readerName, outcome);
  return outcome;
}
