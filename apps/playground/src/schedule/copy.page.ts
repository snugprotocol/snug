// schedule/copy.page.ts — the sentences of the schedule PAGE, its rows, the results feed, the
// hub section, the missed card's own chrome and the templates (TASK-20261009-scheduling-
// framework U1, U2, U4; design F9, F11, F12). `copy.ts` holds the engine-facing sentences
// (states, policies, the missed headline, the honesty line) and is never edited from here;
// this module only COMPOSES the page's labels from its nouns, so the vocabulary scan in
// `scheduleCopy.test.ts` covers both and a person reads one set of words.
//
// Same voice: lowercase-leading labels, plain words, the typographic apostrophe.

import type { RunStatus } from '@snugprotocol/protocol';

import { WORDS } from './copy.js';

// --------------------------------------------------------------------------- the page

export const PAGE = {
  /** The page heading, the hub section title and the header icon's accessible name. */
  heading: WORDS.item,
  /** The create bar's textbox name (the placeholder is `EMPTY.createPlaceholder`). */
  createLabel: 'describe what and when',
  /** The create bar's button — it opens the prefilled editor, where *schedule it* is the enable. */
  createSubmit: 'set it up',
  newSchedule: `new ${WORDS.item}`,
  /** `allows('schedule') === false`: the page is a refusal, never an empty main region. */
  unavailableTitle: `no ${WORDS.items} here`,
  unavailableLesson: 'this host can’t run anything on a schedule — open Snug in a browser tab or in Snug for Mac.',
  errorTitle: `can’t reach your ${WORDS.items}`,
  emptyTitle: `no ${WORDS.items} yet`,
  /** The global-pause banner's one act (`copy.globalPaused` is the line). */
  resumeAll: 'resume',
} as const;

// --------------------------------------------------------------------- the results feed

export const RESULTS = {
  heading: WORDS.results,
  none: `no ${WORDS.results} yet — the first one lands here`,
  markAllRead: 'mark all read',
  /** Printed WITH the status word on an unread row — never colour alone (U9). */
  unread: 'unread',
} as const;

/** The one-word status beside a result (the dot is decoration; this is the signal). */
export function statusWord(status: RunStatus): string {
  switch (status) {
    case 'ok':
      return 'done';
    case 'failed':
      return 'failed';
    case 'needs-you':
      return 'needs you';
    case 'capped':
      return 'capped';
    case 'no-handler':
      return 'not supported';
    case 'interrupted':
      return 'interrupted';
    case 'pending':
      return 'waiting';
    case 'running':
      return 'running';
    case 'skipped':
      return 'skipped';
    default: {
      const never: never = status;
      return never;
    }
  }
}

/** "2 AI calls" / "1 AI call" / "no AI calls" — the cost of a candidate or a template. */
export function aiCallsWord(n: number): string {
  if (n === 0) return 'no AI calls';
  return `${n} AI ${n === 1 ? 'call' : 'calls'}`;
}

// ---------------------------------------------------------------------- the groups

export const GROUPS = {
  attention: 'needs your attention',
  today: 'today',
  upcoming: 'upcoming',
  paused: 'paused',
} as const;

// ------------------------------------------------------------------------- a row

export const ROW = {
  /** "next tomorrow", "next in 2 hours" — the second line's tail. */
  next: (relative: string): string => `next ${relative}`,
  nothingComing: 'nothing coming up',
  /** The kebab's accessible name. */
  menu: (title: string): string => `more for ${title}`,
  runNow: 'run now',
  edit: 'edit',
  history: 'history',
  delete: 'delete',
  /** The tiles' armed inline confirm, word for word. */
  deleteConfirm: 'delete for good?',
  deleteYes: 'delete',
  deleteKeep: 'keep',
  deleting: 'deleting…',
  historyEmpty: `no ${WORDS.results} yet`,
  /** The switch's state words for a screen reader (`aria-checked` carries the truth). */
  on: 'on',
  off: 'off',
} as const;

// --------------------------------------------------------------------- the hub section

export const HUB = {
  heading: WORDS.item,
  all: `all ${WORDS.items}`,
  unread: (n: number): string => `${n} unread`,
  /** A template that fits, offered from the hub when there is nothing scheduled yet. */
  setUp: 'set it up',
} as const;

// ----------------------------------------------------------------------- the templates

export const TEMPLATES = {
  heading: 'start from a template',
  use: 'use this',
  /** "add Weather, then schedule it" — the app is not installed; the link opens its starter. */
  addThen: (appName: string): string => `add ${appName}, then schedule it`,
} as const;

// ---------------------------------------------------------------------- the missed card

export const MISSED = {
  /** The undo strip while a *skip* waits out its delay. */
  skippingSoon: (n: number): string => `skipping ${n === 1 ? `1 ${WORDS.item}` : `${n} ${WORDS.items}`}…`,
  done: 'done',
  /** Dismisses the per-row outcomes once a batch has finished (the card then leaves). */
  ok: 'ok',
} as const;
