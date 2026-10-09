// schedule/copy.page.ts — the sentences of the schedule PAGE and the surfaces that hang off it:
// the page itself, its rows, the results feed, the hub section, the missed card's own chrome,
// the templates, the Settings card, the running chip's act and the chat offer's chrome
// (TASK-20261009-scheduling-framework U1, U2, U4, U6, U10, E10; design F9, F11, F12).
// `copy.ts` holds the vocabulary and the engine-facing sentences (the states, the status
// words, the policies, the missed headline, the honesty line) and is never edited from here;
// this module only COMPOSES the page's labels from its nouns, so the vocabulary scan in
// `scheduleCopy.test.ts` covers both and a person reads one set of words.
//
// Same voice: lowercase-leading labels, plain words, the typographic apostrophe.

import { WORDS } from './copy.js';
import type { TemplateName } from './editorModel.js';

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

/**
 * This tab was promoted to leader over a copy that had gone stale (another tab ran the
 * schedules in between): the rows on screen may be behind the file, and the one act is a
 * reload (E2). Shown on the page and in the hub section.
 */
export const RELOAD = {
  note: `another tab was running your ${WORDS.items} — reload to continue here`,
  act: 'reload',
} as const;

// --------------------------------------------------------------------- the results feed

export const RESULTS = {
  heading: WORDS.results,
  none: `no ${WORDS.results} yet — the first one lands here`,
  markAllRead: 'mark all read',
  /** Printed WITH the status word on an unread row — never colour alone (U9). */
  unread: 'unread',
} as const;

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
  /**
   * One line under each card's title. The WHEN is never restated here — the card prints it
   * from the template's own spec (`editorModel.templateFill`), so a blurb cannot promise a
   * different time than the editor opens with.
   */
  blurb: {
    nudge: 'a reminder in Snug — change the words and the time to taste',
    'spend-review': 'Ledger’s AI sums the week by category against your budgets and flags what looks off',
    'friday-review': 'Ledger on the money and Standup on the work — two short briefings, one result',
    'morning-weather': 'Should I? fetches the forecast and a notification tells you the call',
  } satisfies Readonly<Record<TemplateName, string>>,
} as const;

// ---------------------------------------------------------------------- the missed card

export const MISSED = {
  /**
   * The undo strip while a *skip* waits out its delay. The decision is kept, not lost: if the
   * card leaves the page before the delay runs out, the skip lands at once (`MissedCard`).
   */
  skippingSoon: (n: number): string => `skipping ${n === 1 ? `1 ${WORDS.item}` : `${n} ${WORDS.items}`}…`,
  /** Dismisses the per-row outcomes once a batch has finished (the card then leaves). */
  ok: 'ok',
} as const;

// --------------------------------------------------------------------- the Settings card (U6)

export const SETTINGS = {
  pauseAll: `pause all ${WORDS.items}`,
  pauseHint: `nothing runs until you turn this off — what was due comes back as ${WORDS.missed}`,
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
  notifyHint: `a ${WORDS.item} set to tell you “with a notification” will use them; everything still lands in Snug`,
  clearHistory: 'clear history',
  clearArm: `clear every ${WORDS.result}? what is still waiting for you stays`,
  clearConfirm: 'clear',
  clearKeep: 'keep',
  cleared: 'history cleared',
  /** The switch the suggestion strip's intake reads (`ScheduleSettingsCard.NO_SUGGESTIONS_KEY`). */
  noSuggestions: `never let apps suggest ${WORDS.items}`,
  noSuggestionsHint: `you can still ${WORDS.item} any app yourself`,
  on: 'on',
  off: 'off',
} as const;

// ------------------------------------------------ the running chip (U10) and the chat offer (E10)

/** The cancel control's accessible name names what it cancels. */
export function cancelName(title: string): string {
  return `cancel ${title}`;
}

export const OFFER = {
  dismiss: 'dismiss',
  dismissName: `dismiss this ${WORDS.item} offer`,
  /**
   * Under a platform-pinned HOST brain the chat has no classifier and no `schedule` lane
   * (TASK-20261009 P2): this deterministic offer IS the way from the chat to a schedule, and
   * the line says so instead of leaving the user to wonder why the agent never suggested one.
   */
  hostBrain: `on this brain the agent can’t suggest ${WORDS.items} itself — review is the way`,
} as const;
