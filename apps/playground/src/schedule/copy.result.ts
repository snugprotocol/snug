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

import {
  ACCESS_WRITE_MAX_ROWS,
  type RunStatus,
  type ScheduleHeldReason,
  type ScheduleRun,
  type ScheduleStep,
  type StepResult,
  type StepResultStatus,
  type StepTools,
  type StepToolsUnavailableReason,
} from '@snugprotocol/protocol';

import { FETCH_FIRST, OWN_UNDO_NO_LONGER, listWords, rowsWord } from '../access/copy.js';
import { WORDS, aiCalls, changedOnItsOwn, changedRows } from './copy.js';

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

/**
 * The needs-you card's title (TASK-20261010-host-broker PR-1): the app's name and the ask, with
 * the step's own sentence as the body — a declined dialog on the open app is not "while you’re
 * away", so the card no longer composes that tail itself.
 */
export function needsYouTitle(appName: string): string {
  return `${appName} needs your OK`;
}

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

// ---------------------------------------------------------------------------------------------
// What it made, and what it held (TASK-20261010-host-broker PR-4; ADR-0076 §9; D-PR4-11, D-PR4-18)
// ---------------------------------------------------------------------------------------------

/**
 * Why an armed schedule did not make a change it suggested — ONE line per held item, above its
 * acts, keyed by the protocol's held reasons so a new reason is a type error here, never a missing
 * line. Each is a function of the app's name (the busy one says it) and of the schedule's undo
 * bucket's LIVE count, read when the page renders (`full` says it — PR-4 Gate 5, U14: the bucket
 * refused at its cap, but entries age out, so the cap would overstate what is still waiting).
 */
export const HELD_WHY: Readonly<Record<ScheduleHeldReason, (appName: string, live: number) => string>> = {
  busy: (appName) => `not made — ${appName} was in the middle of a change`,
  changed: () => 'not made — the data moved since the AI looked',
  'cannot-undo': () => 'not made — it couldn’t be undone, so it waits for you (applying it here can’t be undone either)',
  full: (_appName, live) => `not made — ${live} earlier ${live === 1 ? 'change' : 'changes'} can still be undone; it will make changes again as they age out`,
  failed: () => 'not made — something went wrong; nothing was changed',
  'over-limit': () => `not made — it would pass the ${ACCESS_WRITE_MAX_ROWS} rows this schedule may change each time`,
  stopped: () => 'not made — it was stopped from making changes on its own',
};

/**
 * The first section's lines (`WORDS.changesMade`): a schedule's group, or the user's own apply —
 * each followed by ` · ` and its undo, or by what says there is none. The undo's words are
 * `access/copy.ts`'s `OWN_UNDO` (the ⋈ sheet's, reused).
 */
export const MADE = {
  /** "changed 12 rows in Ledger on its own" */
  onItsOwn: changedOnItsOwn,
  /** "you applied this — 2 rows changed" — persisted, so a reload keeps it. */
  youApplied: (n: number): string => `you applied this — ${rowsWord(n)} changed`,
  cannotUndo: 'can’t be undone',
  /** The journal holds it no longer, and the change is past its seven days. */
  undoEnded: 'undo ended after seven days',
  /**
   * The journal holds it no longer, though the change is younger than seven days — undone and gone,
   * or given way early in its bucket (PR-4 Gate 5, U2). The chat card's words, ONE home.
   */
  noLonger: OWN_UNDO_NO_LONGER,
} as const;

/** ONCE, under the header's when-line, on a schedule that makes changes on its own — with its one act. */
export const RESULT_ON_ITS_OWN = {
  line: 'this schedule makes changes on its own',
  stop: 'stop',
} as const;

/**
 * The link from a result to its schedule's changes list, where an undo stays findable for seven days —
 * named by what the list HOLDS (PR-4 Gate 5, U6): the schedule's own changes still undoable, never
 * the user's approvals, an undone one or one past its seven days.
 */
export const CHANGES_LINK = 'this schedule’s changes you can still undo';

// ---------------------------------------------------------------------------------------------
// The host's facts (D-PR4-18; D8, D18, R-88) — what the host knows, said after the AI's words
// ---------------------------------------------------------------------------------------------

/** What a step's facts name besides the step: its app, and a connection slot by the name the user knows it by. */
export interface StepFactNames {
  app: string;
  connection: (slot: string) => string;
}

/** Up to this many shared tables are named; more fold into a count. */
const SAW_NAMED_MAX = 2;

const TOOLS_UNAVAILABLE: Readonly<Record<StepToolsUnavailableReason, (appName: string) => string>> = {
  brain: () => 'answered without looking things up — this brain can’t use them',
  sidecar: (appName) => `answered without looking things up — ${appName} talks to a helper on this device`,
};

/** Where the step ran — nothing for a reminder, or for a step that never ran here. */
function whereFact(step: ScheduleStep, result: StepResult, app: string): string | undefined {
  if (step.kind === 'notify' || result.appMissing === true || result.blockedBy !== undefined) return undefined;
  if (result.status === 'blocked' || result.status === 'skipped') return undefined;
  if (step.kind === 'app-think') return `Snug did this itself — ${app} didn’t open`;
  return result.inOpenApp === true ? `ran in ${app} while it was open` : `ran ${app} out of sight while it was closed`;
}

/** What it read that another app let it read (R-88): each table by its app's name, or a count past two. */
function sawFact(saw: StepResult['saw']): string | undefined {
  if (saw === undefined || saw.length === 0) return undefined;
  if (saw.length <= SAW_NAMED_MAX) return `read ${listWords(saw.map((seen) => `${seen.source}’s ${seen.table}`))} (you allowed it)`;
  const apps = new Set(saw.map((seen) => seen.source)).size;
  return `read ${saw.length} tables from ${apps} ${apps === 1 ? 'app' : 'apps'} you allowed`;
}

/** What a step that may look things up did with its tools — slot names worded, never a path. */
function toolsFact(tools: StepTools | undefined, names: StepFactNames): string | undefined {
  if (tools === undefined) return undefined;
  if ('unavailable' in tools) return TOOLS_UNAVAILABLE[tools.unavailable](names.app);
  if (tools.used === 0) return 'didn’t need to look anything up';
  const times = tools.used === 1 ? 'once' : `${tools.used} times`;
  const through = tools.fetched === undefined ? '' : ` through ${listWords(tools.fetched.map((entry) => names.connection(entry.connection)))}`;
  return `looked things up ${times}${through}`;
}

/** An *ask* step that fetched new data first, when no app let it ask any more (TASK-20261010-host-broker PR-5, D-PR5-19). */
export function fetchedNone(appName: string): string {
  return `didn’t fetch first — no app lets ${appName} ask for new data any more`;
}

/**
 * What an *ask* step's *fetch new data first* came to (PR-5, D-PR5-19; D11): one fact per source,
 * in `access/copy.ts`'s `FETCH_FIRST` words — never respelled — and `none` naming the step's own app.
 */
function fetchedFacts(fetched: StepResult['fetched'], appName: string): string[] {
  if (fetched === undefined) return [];
  return fetched.map((entry) => {
    switch (entry.outcome) {
      case 'fresh':
        return FETCH_FIRST.done(entry.source);
      case 'recent':
        return FETCH_FIRST.recentUsed(entry.source);
      case 'failed':
        return FETCH_FIRST.failed(entry.source);
      case 'skipped':
        return FETCH_FIRST.skipped(entry.source);
      case 'none':
        return fetchedNone(appName);
      default: {
        const never: never = entry.outcome;
        return never;
      }
    }
  });
}

/**
 * Each step's ONE host line on the result page, its facts joined by a middle dot: where it ran
 * (the word *background* is never shown), what it fetched first (PR-5), what it read with the
 * user's leave, what it looked up. `undefined` when there is nothing the host can say.
 */
export function stepFacts(step: ScheduleStep, result: StepResult, names: StepFactNames): string | undefined {
  const facts = [whereFact(step, result, names.app), ...fetchedFacts(result.fetched, names.app), sawFact(result.saw), toolsFact(result.tools, names)].filter(
    (fact): fact is string => fact !== undefined,
  );
  return facts.length === 0 ? undefined : facts.join(' · ');
}

/**
 * The host's facts about a result, in order — what it made on its own, what the user applied, what
 * still waits — for wherever the result's one line is printed (the feed, the row's history, a
 * notification the host composes): `[summary, ...resultFacts(run, name, now)].join(' · ')`. The AI's
 * words come first and are never rewritten; an AI's claim is never a fact. A batch waits only before
 * its `expiresAt`, read against the caller's clock (PR-4 Gate 5, U10): an expired batch stays on the
 * row, but nothing in it is waiting any more.
 */
export function resultFacts(run: ScheduleRun, appName: (appId: string) => string, now: Date): string[] {
  const facts: string[] = [];
  if (run.applied !== undefined) {
    facts.push(changedOnItsOwn(run.applied.items.reduce((sum, item) => sum + item.changes, 0), appName(run.applied.appId)));
  }
  const approvedByApp = new Map<string, number>();
  for (const entry of run.approved ?? []) approvedByApp.set(entry.appId, (approvedByApp.get(entry.appId) ?? 0) + entry.changes);
  for (const [appId, changes] of approvedByApp) facts.push(`you ${changedRows(changes, appName(appId))}`);
  const waiting = run.proposals !== undefined && Date.parse(run.proposals.expiresAt) > now.getTime() ? run.proposals.items.length : 0;
  if (waiting > 0) facts.push(waiting === 1 ? '1 change waiting for your OK' : `${waiting} ${WORDS.changesWaiting}`);
  return facts;
}
