// schedule/copy.bits.ts — the sentences of the result detail, the Settings card, the running
// chip, the chat offer and the row-state helpers (TASK-20261009-scheduling-framework U4, U6,
// U7, U9, U10, E10). Pure strings and small pure functions, no React, no store.
//
// `copy.ts` is the ONE home of the feature's shared vocabulary and states (C8); this module
// composes the sentences those five surfaces need on top of it and never respells a word it
// already decides — `WORDS`, `stepLabel`, `needsYou`, `noHandler`, `capped`, `appMissing`,
// `paused`, `followerTab`, `globalPaused`, `chatOffer` and `RUNNING_CHIP` are imported where
// they are used. The vocabulary scan in `scheduleCopy.test.ts` reads this file too: no string
// literal here spells the engine's words (a *result* is one execution; *changes waiting for
// your OK* are the AI's pending data changes).

import type { RunStatus, ScheduleRun, StepResultStatus } from '@snugprotocol/protocol';

// ---------------------------------------------------------------------------------------------
// The result detail (U4)
// ---------------------------------------------------------------------------------------------

/** The status word beside the dot — a result is never conveyed by colour alone (U9). */
export const RESULT_STATUS_WORD: Readonly<Record<RunStatus, string>> = {
  pending: 'missed',
  running: 'running',
  ok: 'done',
  failed: 'failed',
  skipped: 'skipped',
  'needs-you': 'needs you',
  interrupted: 'interrupted',
  capped: 'capped',
  'no-handler': 'no schedule hook',
};

/** One step's status word. */
export const STEP_STATUS_WORD: Readonly<Record<StepResultStatus, string>> = {
  ok: 'done',
  failed: 'failed',
  blocked: 'blocked',
  refused: 'refused',
  'no-handler': 'no schedule hook',
  skipped: 'skipped',
};

/** The dot's temperature per status — the class the CSS colours; the word carries the meaning. */
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

/** "ran Oct 9, 2026, 12:05 PM · 3 min ago" */
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
  if (calls.ai > 0) parts.push(`${calls.ai} AI ${calls.ai === 1 ? 'call' : 'calls'}`);
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

// The pending data changes (ADR-0074 §6: never executed by the engine; re-dry-run on approval).

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

/** No *ask the AI* step names an app, so there is nothing to apply the statement to. */
export const NO_APP_FOR_CHANGES = 'these changes have no app to apply to';

export function openApp(appName: string): string {
  return `open ${appName}`;
}

/** The empty state when the route names a result the file no longer holds. */
export const RESULT_MISSING = {
  title: 'no such result',
  lesson: 'it may have been cleared from history, or its schedule deleted.',
  back: 'all schedules',
} as const;

export const RESULT_LOADING = 'opening…';

// ---------------------------------------------------------------------------------------------
// Relative and absolute time
// ---------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** "just now" · "3 min ago" · "2 hours ago" · "yesterday" · "4 days ago" — and "in …" for the future. */
export function relativeTime(instantMs: number, nowMs: number): string {
  const delta = nowMs - instantMs;
  const abs = Math.abs(delta);
  if (abs < MINUTE_MS) return 'just now';
  const words =
    abs < HOUR_MS
      ? `${Math.round(abs / MINUTE_MS)} min`
      : abs < DAY_MS
        ? `${Math.round(abs / HOUR_MS)} ${Math.round(abs / HOUR_MS) === 1 ? 'hour' : 'hours'}`
        : abs < 2 * DAY_MS
          ? undefined
          : `${Math.round(abs / DAY_MS)} days`;
  if (words === undefined) return delta >= 0 ? 'yesterday' : 'tomorrow';
  return delta >= 0 ? `${words} ago` : `in ${words}`;
}

/** The absolute instant in the viewer's locale — date and time, medium and short. */
export function absoluteTime(instantMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instantMs));
}

// ---------------------------------------------------------------------------------------------
// The Settings card (U6)
// ---------------------------------------------------------------------------------------------

export const SETTINGS = {
  pauseAll: 'pause all schedules',
  pauseHint: 'nothing runs until you turn this off — what was due comes back as missed',
  notifyHeading: 'browser notifications',
  notifyAsk: 'turn on notifications',
  notifyOff: 'turn off',
  /** Permission `default`: the browser has not been asked — and will be only on the click. */
  notifyDefault: 'off — this browser will ask you once when you turn them on',
  /** Permission `granted`, opted in. */
  notifyOn: 'on for this browser',
  /** Permission `granted` but not opted in here. */
  notifyAllowed: 'this browser allows them — turn them on to use them',
  notifyDenied: 'blocked — change it in your browser’s site settings',
  notifyUnavailable: 'this browser has no notifications',
  notifyHint: 'a schedule set to tell you “with a notification” will use them; everything still lands in Snug',
  clearHistory: 'clear history',
  clearArm: 'clear every result? what is still waiting for you stays',
  clearConfirm: 'clear',
  clearKeep: 'keep',
  cleared: 'history cleared',
  noSuggestions: 'never let apps suggest schedules',
  noSuggestionsHint: 'you can still schedule any app yourself',
  on: 'on',
  off: 'off',
} as const;

// ---------------------------------------------------------------------------------------------
// The running chip (U10) and the chat offer (E10)
// ---------------------------------------------------------------------------------------------

/** The cancel control's accessible name names what it cancels. */
export function cancelName(title: string): string {
  return `cancel ${title}`;
}

export const OFFER = {
  dismiss: 'dismiss',
  dismissName: 'dismiss this schedule offer',
} as const;
