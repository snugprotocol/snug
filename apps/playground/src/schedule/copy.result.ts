// schedule/copy.result.ts — the sentences of ONE RESULT, opened (TASK-20261009-scheduling-
// framework U4, U9; ADR-0074 §5–§6): the detail's lines, the pending *changes waiting for your
// OK* and their outcomes, the dot's tone per status. Pure strings and small pure functions,
// no React, no store.
//
// `copy.ts` is the ONE home of the feature's shared vocabulary — the status WORDS
// (`RESULT_STATUS_WORD`, `STEP_STATUS_WORD`), `aiCalls`, `needsYou`, `noHandler`, `capped`,
// `stepLabel` — and this module never respells a word it already decides; the tone here is
// the dot's colour class, never the signal (U9). Relative and absolute time are
// `pageModel.ts`'s (`relativeTime`, `absoluteTime`), one clock for every surface. The
// vocabulary scan in `scheduleCopy.test.ts` reads this file too.

import type { ScheduleRun, RunStatus, StepResultStatus } from '@snugprotocol/protocol';

import { aiCalls } from './copy.js';

// ---------------------------------------------------------------------------------------------
// The dot's tone (U9) — the class the CSS colours; the word (`copy.ts`) carries the meaning
// ---------------------------------------------------------------------------------------------

export type StatusTone = 'ok' | 'warn' | 'danger' | 'muted';

export function resultTone(status: RunStatus): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'failed':
    case 'interrupted':
      return 'danger';
    case 'needs-you':
    case 'capped':
    case 'no-handler':
      return 'warn';
    case 'pending':
    case 'running':
    case 'skipped':
      return 'muted';
    default: {
      const never: never = status;
      return never;
    }
  }
}

export function stepTone(status: StepResultStatus): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'refused':
    case 'no-handler':
      return 'warn';
    case 'skipped':
      return 'muted';
    default: {
      const never: never = status;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The header lines
// ---------------------------------------------------------------------------------------------

/** "ran Oct 9, 2026, 12:05 PM · 3 minutes ago" */
export function ranLine(absolute: string, relative: string): string {
  return `ran ${absolute} · ${relative}`;
}

/** A result that never started (missed, skipped): when it was due. */
export function dueLine(absolute: string, relative: string): string {
  return `due ${absolute} · ${relative}`;
}

/** Which shell ran it, from the row's recorded host (E9) — in words a person would use. */
export function hostWord(host: ScheduleRun['host']): string {
  switch (host.kind) {
    case 'web':
      return 'a browser tab';
    case 'desktop':
      return 'Snug for Mac';
    case 'host':
      return host.binding === 'artifact' ? 'an artifact page' : host.binding === 'local' ? 'your agent’s plugin' : 'another host';
    default: {
      const never: never = host.kind;
      return never;
    }
  }
}

export function onHost(host: ScheduleRun['host']): string {
  return `on ${hostWord(host)}`;
}

/** "2 AI calls · 1 network call" — or that nothing was spent. */
export function callsLine(calls: { ai: number; net: number }): string {
  if (calls.ai === 0 && calls.net === 0) return 'no AI or network calls';
  const parts: string[] = [];
  if (calls.ai > 0) parts.push(aiCalls(calls.ai));
  if (calls.net > 0) parts.push(`${calls.net} network ${calls.net === 1 ? 'call' : 'calls'}`);
  return parts.join(' · ');
}

/** The heading over the steps. */
export const STEPS_HEADING = 'what ran';

/** Why a result stopped short, from the engine's reason word (queue.ts), in the user's terms. */
export function interruptedWhy(reason: string | undefined): string {
  switch (reason) {
    case 'cancelled':
      return 'you cancelled it';
    case 'timeout':
      return 'it took too long and was stopped';
    case 'stale claim':
      return 'Snug closed while it was running';
    case 'paused':
      return 'all schedules were paused';
    case 'file swap':
      return 'your file changed underneath it';
    case undefined:
      return 'it was interrupted';
    default:
      return reason;
  }
}

/**
 * The verb for `needsYou` when the step did not say what it tried (PR-A has no *Run [app]*
 * step yet, so no app has named its verb): "Snug doesn’t make changes while you’re away".
 */
export const NEEDS_YOU_FALLBACK_VERB = 'make changes';

/** The one ceiling PR-A's queue enforces (an *ask the AI* step counts against the AI ceiling). */
export const CAPPED_WHAT = 'AI call';

// ---------------------------------------------------------------------------------------------
// The pending data changes (ADR-0074 §6: never executed by the engine; re-dry-run on approval)
// ---------------------------------------------------------------------------------------------

/** Who wrote the statement — said on every item, because it is SQL the AI composed. */
export const AI_WROTE = 'written by the AI from your data';

/** "would change 2 rows" — the dry-run count the user is agreeing to. */
export function wouldChange(changes: number | undefined): string {
  if (changes === undefined) return 'row count unknown';
  return `would change ${changes} ${changes === 1 ? 'row' : 'rows'}`;
}

export const CHANGE_ACTIONS = {
  apply: 'apply to my data',
  decline: 'decline',
} as const;

/** "applied — 2 rows changed" — the RE-VALIDATED count `executeApprovedWrite` answers, never the preview. */
export function applied(executed: readonly number[]): string {
  const total = executed.reduce((sum, count) => sum + count, 0);
  return `applied — ${total} ${total === 1 ? 'row' : 'rows'} changed`;
}

/** The drift halt: the affected-row count moved between the preview and the approval. */
export const DRIFTED = 'the data moved — review again';

export function couldNotApply(message: string): string {
  return `couldn’t apply — ${message}`;
}

export const DECLINED = 'declined — nothing was changed';

/** The whole batch is past its seven days (`proposals.expiresAt`). */
export const EXPIRED = 'these suggestions expired';

/** The item names no app, so there is nothing to apply the statement to — it is never offered. */
export const NO_APP_FOR_CHANGES = 'these changes have no app to apply to';

export function openApp(appName: string): string {
  return `open ${appName}`;
}

/**
 * Under *run now and review* on a result whose schedule runs an app (S2): the act opens the app
 * FIRST and delivers the manual run to that live frame — the engine never runs a manual run
 * hidden, because the point of the act is that the user is there to answer the gate.
 */
export function openingToRun(appName: string): string {
  return `opening ${appName} to run it with you`;
}

/** The empty state when the route names a result the file no longer holds. */
export const RESULT_MISSING = {
  title: 'no such result',
  lesson: 'it may have been cleared from history, or its schedule deleted.',
  back: 'all schedules',
} as const;

export const RESULT_LOADING = 'opening…';
