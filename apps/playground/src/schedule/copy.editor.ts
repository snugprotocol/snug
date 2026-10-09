// schedule/copy.editor.ts — the EDITOR's own sentences (TASK-20261009-scheduling-framework U3,
// U5, U8; ADR-0074 §5). `copy.ts` holds the feature's shared vocabulary and the sentences every
// surface repeats (the policies, the cost line, the consent heading, the honesty line); this
// module holds what only the editor route, the run-header sheet and the consent panel say —
// labels for the controls, the refusals in words, the template names. The same voice:
// lowercase-leading, plain words, the typographic apostrophe, one act per state. The same
// vocabulary scan (`scheduleCopy.test.ts`) covers this file: a person reads *schedule*,
// *result*, *suggestion* — never the engine's words.

import { SCHEDULE_APP_INPUT_MAX_BYTES, SCHEDULE_DAILY_CEILINGS, SCHEDULE_MAX_STEPS, SCHEDULE_TITLE_MAX_CHARS } from '@snugprotocol/protocol';

import { CONSENT, SCHEDULED_NEXT, aiCalls, stepLabel } from './copy.js';

/** The route's heading, by mode. */
export const EDITOR_HEADING = { new: 'new schedule', edit: 'edit schedule' } as const;

/** The sentence box (the placeholder itself is `copy.EMPTY.createPlaceholder`). */
export const SENTENCE = {
  label: 'describe what and when',
  /** `?text=` or a typed sentence carried no readable time — the controls below are the way. */
  cannotRead: 'I couldn’t read a time in that — pick one below',
  /** The sheet has no controls below; the one act is the full editor. */
  cannotReadSheet: 'I couldn’t read a time in that — open more options to pick one',
} as const;

export const TITLE = {
  label: 'title',
  required: 'give it a title',
  tooLong: `a title is at most ${SCHEDULE_TITLE_MAX_CHARS} characters`,
} as const;

/** The six chips, in order. */
export const KIND_LABELS = {
  once: 'once',
  every: 'every…',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  custom: 'custom',
} as const;

export const WHEN = {
  legend: 'when',
  date: 'date',
  time: 'time',
  every: 'every',
  unit: { minutes: 'minutes', hours: 'hours', days: 'days' } as const,
  /** The day stride's optional time — absent, the stride keeps the wall time it was saved at. */
  daysTimeHint: 'without a time, an every-N-days schedule keeps the time you save it',
  on: 'on',
  onDay: 'day of the month',
  onNth: 'a weekday of the month',
  onLast: 'the last day',
  dayNumber: 'day',
  nth: 'which',
  nthWords: ['first', 'second', 'third', 'fourth'] as const,
  weekday: 'weekday',
  days: 'days',
  presets: { everyDay: 'every day', weekdays: 'weekdays', weekends: 'weekends' } as const,
  cron: 'cron — minute hour day month weekday',
  cronInvalid: 'that isn’t a cron I can read — five fields: minute hour day month weekday',
  /** The custom cron, read back as a preset when it maps to one. */
  cronReadsAs: (whenWords: string): string => `reads as ${whenWords}`,
  until: 'ends',
  untilNone: 'never',
  untilDate: 'on a date',
  untilCount: 'after a number of times',
  untilDateLabel: 'last day',
  untilCountLabel: 'times',
} as const;

export const ZONE = {
  label: 'time zone',
  follows: (zone: string): string => `${zone} · follows this device`,
  pinned: (zone: string): string => `${zone} · pinned`,
  pin: 'pin to a zone',
  device: 'follow this device',
} as const;

export const STEPS = {
  legend: 'steps',
  add: 'add a step',
  remove: 'remove step',
  kind: 'what',
  remind: stepLabel('notify'),
  ask: (appName?: string): string => stepLabel('app-think', appName),
  run: (appName?: string): string => stepLabel('app-run', appName),
  app: 'which app',
  pickApp: 'choose an app',
  noApps: 'no apps to ask yet — build or add one first',
  prompt: 'what to ask',
  remindTitle: 'title',
  remindBody: 'message',
  data: 'which data?',
  dataTables: 'let the AI read the app’s tables',
  dataQueries: 'specific queries (advanced)',
  query: (n: number): string => `query ${n}`,
  queryHint: 'one read-only SELECT each — typed by you, never written by a brain',
  queryInvalid: 'each query must be one read-only SELECT',
  maxRows: 'rows per query, at most',
  /** The *run <app>* step (PR-B): an optional input the app reads at that run, and the note that the app must handle it. */
  runInput: 'input (optional)',
  runInputHint: `JSON or text the app reads when it runs — at most ${SCHEDULE_APP_INPUT_MAX_BYTES} bytes`,
  runInputTooLong: `the input must be at most ${SCHEDULE_APP_INPUT_MAX_BYTES} bytes`,
  runNote: (appName: string): string => `${appName} must handle scheduled runs — apps built after today do`,
  /** A template step whose app is not in this file. */
  appMissing: (appName: string): string => `add ${appName} first — this step is off until it’s installed`,
  /** A suggestion step naming an app this file does not hold: the name is unknown, and an id is never shown (M14). */
  unknownApp: 'that app',
  needStep: 'add at least one step',
  tooMany: `at most ${SCHEDULE_MAX_STEPS} steps`,
  needApp: 'choose an app to ask',
  needPrompt: 'say what to ask',
  needTitle: 'give the reminder a title',
  needBody: 'give the reminder a message',
} as const;

export const PREVIEW = {
  heading: 'next',
  none: 'no next time within the next 400 days — check the when',
  /** The one-line cost label; the sentence itself is `copy.costLine`. */
  cost: 'cost',
} as const;

/** The consent panel's rows beyond `copy.CONSENT` (which names the heading, the rows and the two acts). */
export const CONSENT_ROWS = {
  remind: (title: string): string => `${stepLabel('notify')}: ${title}`,
  /** No typed queries: the AI reads the tables through the host's own context. */
  tables: (appName: string): string => `the AI reads ${appName}’s tables — no queries`,
  noHosts: 'none',
  /** The bound the engine's daily ceiling enforces (E7); a reminder-only schedule spends nothing, and says so. */
  dailyBound: (calls: number): string => (calls === 0 ? aiCalls(0) : `up to ${aiCalls(calls)} a day — the daily limit is ${SCHEDULE_DAILY_CEILINGS.ai}`),
  enable: CONSENT.enable,
  notNow: CONSENT.notNow,
} as const;

export const ACTIONS = {
  /** A new schedule is created enabled, so the act reads the same as the consent act. */
  create: CONSENT.enable,
  save: 'save changes',
  cancel: 'cancel',
  moreOptions: 'more options',
  close: 'close',
  /** The sheet after its act — the one sentence every suggestion surface ends on (`copy.SCHEDULED_NEXT`). */
  scheduled: SCHEDULED_NEXT.scheduled,
} as const;

/** The editor opened from a suggestion card (`?proposal=`): where the save and cancel go back to. */
export const FROM_SUGGESTION = {
  note: 'opened from a suggestion in the chat — schedule it here, or go back',
  back: 'back to the chat',
} as const;

/** The run-header action (icon button; the label is its accessible name). */
export const RUN_HEADER_SCHEDULE = {
  label: 'schedule',
  title: 'schedule a reminder or a question for this app',
} as const;

export const SHEET = {
  heading: (appName: string): string => `schedule ${appName}`,
} as const;

export const TEMPLATE_TITLES = {
  nudge: 'nudge me',
  'spend-review': 'weekly spend review',
  'friday-review': 'friday review',
  'morning-weather': 'morning weather',
} as const;

export const STATES = {
  loading: 'loading…',
  notFound: 'no such schedule',
  unavailable: 'scheduling isn’t available in this host',
  back: 'back to schedules',
} as const;
