// schedule/copy.ts — the scheduling feature's shared VOCABULARY and the sentences every
// surface repeats, in ONE module (TASK-20261009-scheduling-framework C8; ADR-0074 §5, §6;
// Q8 / design F13, F14). The other copy modules each name one surface and compose from here:
// `copy.page.ts` (the page, the hub section, the Settings card, the chat offer),
// `copy.editor.ts` (the editor, the sheet, the consent panel), `copy.result.ts` (one result).
//
// Pure strings and small pure functions, no React, no store: each arm is pinned
// byte-for-byte in `scheduleCopy.test.ts`, and the same file's vocabulary scan refuses an
// internal word spelled inside a string literal anywhere else under `schedule/` or in a
// `views/Schedule*.tsx`.
//
// THE VOCABULARY. The engine says task · run · proposal · catch-up to itself. A person reads
// a *schedule* (the item), a *result* (one execution), *missed* (what catch-up found), a
// *suggestion* (what an app or the builder proposes) and *changes waiting for your OK* (the
// data-write proposals an *ask the AI* step may leave). "run" is the APP VERB and nothing
// else — "run Ledger", "run now", "runs while this tab is open" — never the noun for an
// execution. "routine" and "automation" read as someone else's product and are not used.
//
// THE UNIONS ARE THE PROTOCOL'S. The policies, the alert kinds, the pause reasons, the step
// kinds and the host kinds are imported (types only) from `@snugprotocol/protocol`, and the
// pause thresholds from `protection.ts` — nothing here restates a set the engine owns, so a
// new arm there is a type error here, not a sentence that silently never shows.
//
// THE VOICE. Lowercase-leading labels like the rest of the playground, plain words, no
// exclamation marks, the typographic apostrophe of the other copy modules. Every state has
// ONE action (F14), and the honesty line is written where the user decides (F6): the editor,
// the empty page, the consent surface — not only Settings.

import type { AlertKind, MissedPolicy, PausedReason, RunStatus, ScheduleHostKind, ScheduleStep, StepResultStatus } from '@snugprotocol/protocol';

import { PAUSE_AFTER_FAILURES, PAUSE_AFTER_UNSEEN } from './protection.js';

/** The user-facing nouns (Q8). Views compose sentences from these rather than respelling them. */
export const WORDS = {
  item: 'schedule',
  items: 'schedules',
  result: 'result',
  results: 'results',
  missed: 'missed',
  suggestion: 'suggestion',
  changesWaiting: 'changes waiting for your OK',
} as const;

/** The three step kinds, as the engine names them (`scheduleStepSchema`, C1). */
export type StepKind = ScheduleStep['kind'];

/**
 * A step's label: "remind me" / "run <app>" / "ask <app>’s AI". Without a name (the step's
 * app was deleted — see `appMissing`) the label still reads as a sentence.
 */
export function stepLabel(kind: StepKind, appName?: string): string {
  const app = appName ?? 'this app';
  switch (kind) {
    case 'notify':
      return 'remind me';
    case 'app-run':
      return `run ${app}`;
    case 'app-think':
      return `ask ${app}’s AI`;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

/** "no AI calls" · "1 AI call" · "2 AI calls" — the ONE pluraliser every cost sentence uses. */
export function aiCalls(n: number): string {
  if (n === 0) return 'no AI calls';
  return `${n} AI ${n === 1 ? 'call' : 'calls'}`;
}

// ---------------------------------------------------------------------------------------------
// Status words — the ONE word beside a result's dot, on every surface (U9)
// ---------------------------------------------------------------------------------------------

/**
 * The word a result reads as, by status — printed WITH the dot, never colour alone. The feed,
 * the row's history, the detail's header and the missed card's outcomes all read this table,
 * so a result is "missed" everywhere and never "waiting" on one page and "missed" on another.
 */
export const RESULT_STATUS_WORD: Readonly<Record<RunStatus, string>> = {
  pending: 'missed',
  running: 'running',
  ok: 'done',
  failed: 'failed',
  skipped: 'skipped',
  'needs-you': 'needs you',
  interrupted: 'interrupted',
  capped: 'capped',
  'no-handler': 'not supported',
};

/** One step's status word, the same way. */
export const STEP_STATUS_WORD: Readonly<Record<StepResultStatus, string>> = {
  ok: 'done',
  failed: 'failed',
  blocked: 'blocked',
  refused: 'refused',
  'no-handler': 'not supported',
  skipped: 'skipped',
};

// ---------------------------------------------------------------------------------------------
// Honesty — what THIS host can do, in words (ADR-0074 §5; E9)
// ---------------------------------------------------------------------------------------------

export interface HostHonestyInput {
  kind: ScheduleHostKind;
  /** The seat's subject ("this tab", "Snug for Mac", "this artifact"); the kind supplies a default. */
  hostLabel?: string;
  /** What the host can promise; absent = `page` (every host today). */
  wakeMode?: 'page' | 'background';
  /** `memory` = the working copy is gone with the page, so a result is too. */
  storageRung?: 'memory' | 'durable';
  /** `false` = no `navigator.locks` here (an opaque origin, `file://`): another tab may be ticking too. */
  canSeeSiblingTabs?: boolean;
}

const HOST_LABEL_BY_KIND: Readonly<Record<ScheduleHostKind, string>> = {
  web: 'this tab',
  desktop: 'Snug for Mac',
  host: 'this artifact',
};

/**
 * The one sentence every scheduling surface shows where the user decides: who has to be
 * open for a run to happen, whether this page keeps anything, and whether another tab
 * might be ticking too. Fed each shell's REAL platform object by `honesty.test.ts` (E9).
 */
export function hostHonesty(input: HostHonestyInput): string {
  const subject = input.hostLabel ?? HOST_LABEL_BY_KIND[input.kind];
  let line = input.wakeMode === 'background' ? `runs in the background while ${subject} is running` : `runs while ${subject} is open`;
  if (input.storageRung === 'memory') line += ' — this page keeps nothing after it closes';
  if (input.canSeeSiblingTabs === false) line += ' · other tabs can’t be seen from here';
  return line;
}

/** The "next" line under a schedule: when, with the honesty tail. */
export function nextLine(whenWords: string): string {
  return `${whenWords} — if Snug is open; otherwise it will ask when you return`;
}

// ---------------------------------------------------------------------------------------------
// Policies — the missed-run choice (Q12) and the alert choice (Q6)
// ---------------------------------------------------------------------------------------------

export function missedPolicyLabel(policy: MissedPolicy): string {
  switch (policy) {
    case 'ask':
      return 'ask me';
    case 'run-once':
      return 'run once when it opens';
    case 'skip':
      return 'skip';
    default: {
      const never: never = policy;
      return never;
    }
  }
}

/** The lead-in above the three policy choices. */
export const missedPolicySentence = 'if Snug was closed at the time:';

export function alertLabel(kind: AlertKind): string {
  switch (kind) {
    case 'inbox':
      return 'in Snug';
    case 'notification':
      return 'with a notification';
    default: {
      const never: never = kind;
      return never;
    }
  }
}

/** The lead-in above the two alert choices. */
export const alertSentence = 'tell me:';

// ---------------------------------------------------------------------------------------------
// States — each with its ONE action (design F14)
// ---------------------------------------------------------------------------------------------

/** A state line and, when there is one, the single act that answers it. */
export interface StateCopy {
  text: string;
  action?: string;
}

/**
 * The refusing gate said no to a mutating call while nobody was here (ADR-0074 §6): the
 * result is `needs-you`, and the one act opens the app visibly under the ordinary gate.
 * `verb` is what the app tried, in the app's words ("post to Notion").
 */
export function needsYou(appName: string, verb: string): StateCopy {
  return { text: `${appName} needs your OK — Snug doesn’t ${verb} while you’re away`, action: 'run now and review' };
}

/** The app has no schedule hook yet (an older bundle); the one act opens it. */
export function noHandler(appName: string): StateCopy {
  return { text: `${appName} doesn’t know how to run on a schedule yet`, action: `open ${appName}` };
}

/** This host cannot run the step at all (`availability.ts` names the reason); there is no act here. */
export function blockedHere(reason: string): StateCopy {
  return { text: `not available in this host — ${reason}` };
}

/** The step's app was deleted (C3 cascade); the one act removes the step. */
export const appMissing: StateCopy = { text: 'this app was deleted', action: 'remove step' };

/** Why the engine paused this schedule (E7, E8); `count` is the number it actually hit, the engine's threshold when none is passed. Resume is the one act. */
export function paused(reason: PausedReason, count?: number): StateCopy {
  switch (reason) {
    case 'failures':
      return { text: `paused: ${count ?? PAUSE_AFTER_FAILURES} failures in a row`, action: 'resume' };
    case 'ignored':
      return { text: `paused: nobody opened ${count ?? PAUSE_AFTER_UNSEEN} results`, action: 'resume' };
    case 'app-updated':
      return { text: 'paused: this app was updated', action: 'resume' };
    default: {
      const never: never = reason;
      return never;
    }
  }
}

/** The global daily ceiling was reached (E7); `what` names it ("AI call", "network call"). No act — tomorrow is the act. */
export function capped(what: string): string {
  return `daily ${what} limit reached — resumes tomorrow`;
}

/** Arrived disabled with an untrusted import (C4); the one act is review. */
export const imported: StateCopy = { text: 'arrived with an imported file — review before turning on', action: 'review' };

/** This tab lost the leader election (E2): another tab is ticking for this file. */
export const followerTab = 'scheduling runs in another tab';

/** The global pause is on (E7). */
export const globalPaused = 'all schedules are paused';

// ---------------------------------------------------------------------------------------------
// The missed card (E4; design F5)
// ---------------------------------------------------------------------------------------------

/** "3 schedules were missed while Snug was closed · 2 AI calls" — singular handled, the tail omitted at 0. */
export function missedHeadline(count: number, calls: number): string {
  const head = count === 1 ? `1 ${WORDS.item} was ${WORDS.missed} while Snug was closed` : `${count} ${WORDS.items} were ${WORDS.missed} while Snug was closed`;
  if (calls === 0) return head;
  return `${head} · ${aiCalls(calls)}`;
}

/** One row of the card: when, and how many occurrences collapsed into this one candidate. */
export function missedRow(whenWords: string, collapsed: number): string {
  return collapsed >= 2 ? `${whenWords} · ${WORDS.missed} ${collapsed} times → runs once` : `${whenWords} · ${WORDS.missed} once`;
}

export const MISSED_ACTIONS = {
  runAll: 'run them',
  skipAll: 'skip',
  details: 'details',
  run: 'run now',
  skip: 'skip',
  undo: 'undo',
  cancel: 'cancel',
} as const;

/** The card's progress line while the queue works through the accepted candidates. */
export function runningProgress(i: number, n: number): string {
  return `running ${i} of ${n}…`;
}

// ---------------------------------------------------------------------------------------------
// Cost (design F8) — what a schedule spends, and where the rows go
// ---------------------------------------------------------------------------------------------

export interface CostLineInput {
  /** AI calls a week, from the spec's cadence × the *ask the AI* steps. */
  perWeek: number;
  /** The brain that will answer ("Claude"). */
  brainLabel: string;
  /** The app whose rows the queries read. */
  appName: string;
  /** Whether the step's queries send rows to the provider at all. */
  sendsRows: boolean;
}

/** "≈ 7 AI calls a week on Claude · sends rows from Ledger to that provider" — the privacy half only when rows go out. */
export function costLine({ perWeek, brainLabel, appName, sendsRows }: CostLineInput): string {
  if (perWeek === 0) return aiCalls(0);
  const calls = `≈ ${aiCalls(perWeek)} a week on ${brainLabel}`;
  return sendsRows ? `${calls} · sends rows from ${appName} to that provider` : calls;
}

/** Shown in the editor when the cadence would cross the daily ceiling (E7, the 80 % line). */
export function ceilingWarning(what: string): string {
  return `this would hit the daily ${what} limit — runs will be capped`;
}

// ---------------------------------------------------------------------------------------------
// Consent (security F10) — the one surface every channel lands on
// ---------------------------------------------------------------------------------------------

export const CONSENT = {
  heading: 'what will run',
  prompt: 'prompt',
  queries: 'queries',
  input: 'input',
  hosts: 'may call',
  cost: 'daily cost',
  enable: 'schedule it',
  notNow: 'not now',
} as const;

// ---------------------------------------------------------------------------------------------
// Suggestions (ADR-0074 §4) — the run-header strip, never a modal
// ---------------------------------------------------------------------------------------------

/** "Weather suggests: every day at 7:00 AM" */
export function suggestionStrip(appName: string, whenWords: string): string {
  return `${appName} suggests: ${whenWords}`;
}

/** The strip's three acts; accept and decline read the same as the consent surface's. */
export const SUGGESTION_ACTIONS = {
  accept: CONSENT.enable,
  decline: CONSENT.notNow,
  mute: 'stop suggestions from this app',
} as const;

// ---------------------------------------------------------------------------------------------
// The chat offer (E10) — deterministic, inline, dismissible
// ---------------------------------------------------------------------------------------------

/** "looks like a schedule: every weekday at 8" — the one act opens the prefilled editor. */
export function chatOffer(phrase: string): StateCopy {
  return { text: `looks like a ${WORDS.item}: ${phrase}`, action: 'review' };
}

// ---------------------------------------------------------------------------------------------
// Empty states and the running chip
// ---------------------------------------------------------------------------------------------

export const EMPTY = {
  page: 'nothing scheduled yet — describe what and when, or start from a template',
  createPlaceholder: 'describe what and when — every weekday at 8, summarise my ledger',
} as const;

/** The chip that says a run is in flight, with its one act (security F15). */
export const RUNNING_CHIP = {
  label: `a ${WORDS.item} is running`,
  cancel: 'cancel',
} as const;
