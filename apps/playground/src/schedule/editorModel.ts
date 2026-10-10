// schedule/editorModel.ts — the editor's pure model (TASK-20261009-scheduling-framework U3,
// U5, U8). No React, no store, no I/O beyond a db handle passed in: what a draft is, how a
// template fills one, how a draft becomes the protocol's steps (or a refusal in words), which
// brain an app's question would run on RIGHT NOW, which hosts its connections may call, and the
// daily bound the consent panel states. `ScheduleEditor.tsx` and `ScheduleSheet.tsx` are the
// React over this; the tests pin it directly.
//
// THE SPEC IS THE TRUTH (U3). A draft carries the `ScheduleSpec` the preview and the save read,
// plus the custom cron TEXT the user is typing — the two are reconciled by `specFromCronText`
// (a cron that maps to a preset becomes that preset, so the chips derive back) and
// `cronTextFor` (a preset shown in the custom panel starts from its compiled cron).
//
// THE WORDS BESIDE THE SCHEDULE (design F1). A sentence from the create bar, the chat offer or
// the run-header sheet is read twice over: the grammar's phrase fills the when, and `remainderOf`
// keeps what the person typed around it — "remind me to call mom at 5" → "call mom" — as the
// title and as the one step's own words (a reminder's title and message, an app's prompt), so
// the editor opens one click from *schedule it*.
//
// `app-run` (PR-B, A-UI): *run <app>* is a step like the others — the app, and an optional small
// `input` the app reads at that run (JSON when it parses, the text otherwise; ≤ 1 KiB). The
// editor notes that the app must handle scheduled runs (`STEPS.runNote`); the engine's
// `no-handler` result says so after the fact for an app that does not.
//
// A SUGGESTION (TASK-20261009 P1): `?suggestion=<JSON>` from the chat's card opens the editor
// prefilled with the proposal — read through `parseScheduleProposal`, never trusted raw — so
// *edit…* on the card is one click from the full form; the save is the user's own
// (`provenance: 'user'`), because once edited the schedule is theirs.

import { STARTER_INSTALL_SOURCE_PREFIX, type AppRecord, type UserDb } from '@snugprotocol/db';
import {
  CONNECTION_STATUS,
  SCHEDULE_APP_INPUT_MAX_BYTES,
  SCHEDULE_CONTEXT_DEFAULT_ROWS,
  SCHEDULE_CONTEXT_MAX_ROWS,
  SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS,
  SCHEDULE_DAILY_CEILINGS,
  SCHEDULE_MAX_STEPS,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_PROMPT_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
  isReadOnlySelect,
  parseScheduleProposal,
  type AlertKind,
  type MissedPolicy,
  type ScheduleProposal,
  type ScheduleSpec,
  type ScheduleStep,
} from '@snugprotocol/protocol';

import { adapterKindFor } from '../agent/adapter.js';
import { starterLook } from '../starter/starterLooks.js';
import type { ActiveBrainKind } from '../state/activeBrain.js';
import type { ByokProvider, KeyedProvider, PlaygroundMode } from '../state/mode.js';
import type { Brain } from '../state/webllm.js';
import { STEPS, TEMPLATE_TITLES } from './copy.editor.js';
import { WEEKDAY_KEYS, compileSpec, instantInZone, occurrencesBetween, pad2, parseCron, resolveZone, specFromCron, wallClockIn } from './cron.js';
import { defaultMissedPolicy } from './floors.js';
import { readSchedule } from './parseScheduleText.js';
import { appIdsOf } from './taskShape.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** The most minute-aligned instants in seven days, plus one. */
const WEEK_OCCURRENCE_LIMIT = 7 * 24 * 60 + 1;

export type SpecKind = ScheduleSpec['kind'];
export const SPEC_KINDS: readonly SpecKind[] = ['once', 'every', 'daily', 'weekly', 'monthly', 'custom'];

// ------------------------------------------------------------------------- drafts

export type StepDraft =
  | { kind: 'notify'; title: string; body: string }
  | {
      kind: 'app-think';
      appId: string;
      prompt: string;
      dataMode: 'tables' | 'queries';
      sql: string[];
      maxRows: number;
      /** A template step whose app is not installed: named here, disabled in the UI, dropped at save. */
      missingApp?: string;
    }
  | {
      kind: 'app-run';
      appId: string;
      /** The input as typed — JSON when it parses, the text otherwise (`parseRunInput`). */
      input: string;
      missingApp?: string;
    };

export interface EditorDraft {
  text: string;
  title: string;
  /** The user edited the title, so the sentence box stops defaulting it. */
  titleTouched: boolean;
  spec: ScheduleSpec;
  /**
   * The chip that is checked. Usually `spec.kind`; `custom` while the user types a cron whose
   * current reading may already be a preset — the chips derive back when the field is left.
   */
  mode: SpecKind;
  /** The custom panel's text — reconciled with `spec` by `specFromCronText` / `cronTextFor`. */
  cron: string;
  steps: StepDraft[];
  missedPolicy: MissedPolicy;
  /** The user chose a policy, so a step change stops re-deriving it. */
  missedTouched: boolean;
  alert: AlertKind;
}

/** The next full hour after `now`, as an instant — the `once` default. */
export function nextHour(now: Date): Date {
  const ms = now.getTime();
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000 + 3_600_000);
}

/** The `YYYY-MM-DD` and `HH:MM` an instant reads in a zone — the once panel's two inputs. */
export function wallParts(zone: string, instant: Date): { date: string; time: string } {
  const w = wallClockIn(zone, instant);
  return { date: `${w.year}-${pad2(w.month)}-${pad2(w.day)}`, time: `${pad2(w.hour)}:${pad2(w.minute)}` };
}

/** The instant a zone's clock reads `date` `time`, or undefined for a bad or non-existent wall time. */
export function instantOf(zone: string, date: string, time: string): Date | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return undefined;
  return instantInZone(zone, Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]));
}

/** The time a preset carries, for carrying it into the next preset. */
const timeOf = (spec: ScheduleSpec): string => ('time' in spec && spec.time !== undefined ? spec.time : '09:00');

/**
 * A fresh spec of `kind`, keeping what carries over from `from`: the zone, the `until`, and the
 * time of day between the timed presets.
 */
export function defaultSpecFor(kind: SpecKind, from: ScheduleSpec, now: Date): ScheduleSpec {
  const tz = from.tz;
  const until = from.until;
  const base = until === undefined ? { tz } : { tz, until };
  const time = timeOf(from);
  switch (kind) {
    case 'once':
      return { kind: 'once', at: nextHour(now).toISOString(), tz };
    case 'every':
      return { kind: 'every', n: 1, unit: 'hours', ...base };
    case 'daily':
      return { kind: 'daily', time, ...base };
    case 'weekly':
      return { kind: 'weekly', days: [...WEEKDAY_KEYS], time, ...base };
    case 'monthly':
      return { kind: 'monthly', on: { kind: 'day', day: 1 }, time, ...base };
    case 'custom':
      return { kind: 'custom', cron: cronTextFor(from, now), ...base };
    default: {
      const never: never = kind;
      return never;
    }
  }
}

/** What the custom panel starts from: the preset's compiled cron, or a daily default it cannot say. */
export function cronTextFor(spec: ScheduleSpec, now: Date): string {
  if (spec.kind === 'custom') return spec.cron;
  const compiled = compileSpec(spec, now);
  return compiled === undefined || compiled.startsWith('once:') ? '0 9 * * *' : compiled;
}

/**
 * The spec a typed cron means: the preset it maps to (so the chips derive back), or a `custom`
 * spec; `undefined` when the five fields do not parse. The zone and the `until` are `from`'s.
 */
export function specFromCronText(text: string, from: ScheduleSpec): ScheduleSpec | undefined {
  if (!parseCron(text)) return undefined;
  const read = specFromCron(text);
  if (read === undefined || read.kind === 'once') return undefined;
  const spec: ScheduleSpec = { ...read, tz: from.tz };
  return from.until === undefined ? spec : { ...spec, until: from.until };
}

/** The sentence box's title default: the text itself, trimmed to the protocol's bound. */
export function titleFromText(text: string): string {
  return text.trim().slice(0, SCHEDULE_TITLE_MAX_CHARS);
}

/** A title from the first step when the sentence gave none. */
export function titleFromSteps(steps: readonly StepDraft[], appNames: ReadonlyMap<string, string>): string {
  const first = steps[0];
  if (first === undefined) return '';
  if (first.kind === 'notify') return first.title.trim().slice(0, SCHEDULE_TITLE_MAX_CHARS);
  const name = first.missingApp ?? appNames.get(first.appId);
  return first.kind === 'app-think' ? STEPS.ask(name) : STEPS.run(name);
}

export const emptyNotify = (): StepDraft => ({ kind: 'notify', title: '', body: '' });
export const emptyRun = (appId = ''): StepDraft => ({ kind: 'app-run', appId, input: '' });

/** A persisted `app-run` input as the editor's text: a string verbatim, anything else as JSON. */
export const runInputText = (input: unknown): string => (input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));

export type ParsedRunInput = { ok: true; input?: Extract<ScheduleStep, { kind: 'app-run' }>['input'] } | { ok: false; reason: string };

/**
 * The typed input as the protocol's `input`: empty → none; JSON when it parses (so `{"units":
 * "metric"}` reaches the app as an object), the text itself otherwise; refused over 1 KiB
 * serialised — the kv handshake carries these bytes verbatim.
 */
export function parseRunInput(text: string): ParsedRunInput {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true };
  let value: unknown = trimmed;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Plain text is a fine input too.
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > SCHEDULE_APP_INPUT_MAX_BYTES) return { ok: false, reason: STEPS.runInputTooLong };
  return { ok: true, input: value as Extract<ScheduleStep, { kind: 'app-run' }>['input'] };
}
export const emptyThink = (appId = ''): StepDraft => ({
  kind: 'app-think',
  appId,
  prompt: '',
  dataMode: 'tables',
  sql: [''],
  maxRows: SCHEDULE_CONTEXT_DEFAULT_ROWS,
});

/** A persisted step back into a draft (the edit route). */
export function draftsFromSteps(steps: readonly ScheduleStep[]): StepDraft[] {
  return steps.map((step): StepDraft => {
    switch (step.kind) {
      case 'notify':
        return { kind: 'notify', title: step.title, body: step.body };
      case 'app-think': {
        const sql = step.context.sql ?? [];
        return {
          kind: 'app-think',
          appId: step.appId,
          prompt: step.prompt,
          dataMode: sql.length > 0 ? 'queries' : 'tables',
          sql: sql.length > 0 ? [...sql] : [''],
          maxRows: step.context.maxRows,
        };
      }
      case 'app-run':
        return { kind: 'app-run', appId: step.appId, input: runInputText(step.input) };
      default: {
        const never: never = step;
        return never;
      }
    }
  });
}

export type PreparedSteps = { ok: true; steps: ScheduleStep[] } | { ok: false; reason: string };

/**
 * The drafts as the protocol's steps, or the FIRST refusal in words. A step whose template app
 * is missing is dropped (it is disabled on screen). Lengths are cut to the protocol's bounds
 * rather than refused — the inputs cap them already, and a pasted overrun should not block a
 * save; an `app-run` input over its byte bound IS refused, because cutting JSON would corrupt it.
 */
export function prepareSteps(drafts: readonly StepDraft[]): PreparedSteps {
  const live = drafts.filter((draft) => draft.kind === 'notify' || draft.missingApp === undefined);
  if (live.length === 0) return { ok: false, reason: STEPS.needStep };
  if (live.length > SCHEDULE_MAX_STEPS) return { ok: false, reason: STEPS.tooMany };
  const steps: ScheduleStep[] = [];
  for (const draft of live) {
    if (draft.kind === 'notify') {
      const title = draft.title.trim().slice(0, SCHEDULE_TITLE_MAX_CHARS);
      const body = draft.body.trim().slice(0, SCHEDULE_NOTIFY_BODY_MAX_CHARS);
      if (title === '') return { ok: false, reason: STEPS.needTitle };
      if (body === '') return { ok: false, reason: STEPS.needBody };
      steps.push({ kind: 'notify', title, body });
      continue;
    }
    if (draft.kind === 'app-run') {
      if (draft.appId === '') return { ok: false, reason: STEPS.needApp };
      const input = parseRunInput(draft.input);
      if (!input.ok) return { ok: false, reason: input.reason };
      steps.push({ kind: 'app-run', appId: draft.appId, ...(input.input !== undefined ? { input: input.input } : {}) });
      continue;
    }
    if (draft.appId === '') return { ok: false, reason: STEPS.needApp };
    const prompt = draft.prompt.trim();
    if (prompt === '') return { ok: false, reason: STEPS.needPrompt };
    const sql = draft.dataMode === 'queries' ? draft.sql.map((q) => q.trim()).filter((q) => q !== '') : [];
    if (sql.length > SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS || sql.some((q) => !isReadOnlySelect(q))) {
      return { ok: false, reason: STEPS.queryInvalid };
    }
    const maxRows = Math.min(SCHEDULE_CONTEXT_MAX_ROWS, Math.max(1, Math.round(draft.maxRows) || SCHEDULE_CONTEXT_DEFAULT_ROWS));
    steps.push({ kind: 'app-think', appId: draft.appId, prompt, context: sql.length > 0 ? { sql, maxRows } : { maxRows } });
  }
  return { ok: true, steps };
}

/** The draft's live step kinds as protocol steps for the cost rules — a partial draft still has a cost. */
export function costSteps(drafts: readonly StepDraft[]): ScheduleStep[] {
  const steps: ScheduleStep[] = [];
  for (const draft of drafts) {
    if (draft.kind === 'notify') steps.push({ kind: 'notify', title: 'x', body: 'x' });
    else if (draft.missingApp !== undefined) continue;
    else if (draft.kind === 'app-think') steps.push({ kind: 'app-think', appId: draft.appId || 'x', prompt: 'x', context: { maxRows: 1 } });
    else steps.push({ kind: 'app-run', appId: draft.appId || 'x' });
  }
  return steps;
}

/** The catch-up default for a draft, from the same rule the engine uses (Q12). */
export function defaultPolicyFor(drafts: readonly StepDraft[]): MissedPolicy {
  return defaultMissedPolicy(costSteps(drafts));
}

// ------------------------------------------------------------ templates: the ONE registry
//
// The four templates live HERE and nowhere else: `templateFill` is what the editor opens with
// (`initialDraft`), and the cards on the page and in the hub section (`Templates.tsx`) are
// rendered FROM the same fill — the title, `describeSpec(fill.spec)` as the when, the
// starters the steps name, and which of them are missing — so a card can never promise a
// when or a step the editor then opens without.

export type TemplateName = keyof typeof TEMPLATE_TITLES;
export const TEMPLATE_NAMES: readonly TemplateName[] = ['nudge', 'spend-review', 'friday-review', 'morning-weather'];

export const isTemplateName = (value: string | null | undefined): value is TemplateName =>
  value !== null && value !== undefined && (TEMPLATE_NAMES as readonly string[]).includes(value);

/** A starter an app template names: its folder (the `starter:<folder>` install identity), the name the shelf shows for it, and the names it goes by. */
export interface TemplateApp {
  folder: string;
  name: string;
  aliases: readonly string[];
}

/** What the shelf calls a starter folder ("Ledger", "Should I?") — the one name a card, a step note and a hub row use. */
export function templateAppName(folder: string): string {
  return starterLook(folder).name ?? folder.replace(/-/g, ' ');
}

const starterApp = (folder: string, aliases: readonly string[]): TemplateApp => ({ folder, name: templateAppName(folder), aliases });

const LEDGER = starterApp('ledger', ['ledger']);
const STANDUP = starterApp('github', ['standup', 'github']);
const WEATHER = starterApp('weather', ['weather', 'should i?']);

/** The slice of an app record a template reads to find its starter: the install identity and the display name. */
export type TemplateAppCandidate = Pick<AppRecord, 'appId' | 'displayName' | 'installSource'>;

/** The installed app a template names: by install identity first, then by name. */
export function findTemplateApp<T extends TemplateAppCandidate>(apps: readonly T[], app: TemplateApp): T | undefined {
  const source = `${STARTER_INSTALL_SOURCE_PREFIX}${app.folder}`;
  const bySource = apps.find((candidate) => candidate.installSource === source);
  if (bySource !== undefined) return bySource;
  return apps.find((candidate) => app.aliases.includes(candidate.displayName.trim().toLowerCase()));
}

/** Ledger's tables (examples/ledger/app.html): `txns.posted` is epoch SECONDS, `sample` rows are demo data. */
export const LEDGER_QUERIES: readonly string[] = [
  "SELECT category, ROUND(SUM(amount), 2) AS total, COUNT(*) AS txns FROM txns WHERE sample = 0 AND pending = 0 AND posted >= strftime('%s', 'now', '-7 days') GROUP BY category ORDER BY total",
  'SELECT category, monthly FROM budgets ORDER BY category',
];

/** Standup's tables (examples/github/app.html): the watchlist and the recent briefings. */
export const STANDUP_QUERIES: readonly string[] = [
  'SELECT repo, added_at FROM standup_watchlist ORDER BY added_at',
  'SELECT at, brief, priorities, deferred_items, queue_size FROM standup_briefings ORDER BY at DESC LIMIT 5',
];

export const TEMPLATE_PROMPTS = {
  spend: 'Summarise this week’s spending by category against the budgets, name the biggest change from a usual week, and suggest one thing to look at.',
  money: 'Give me this week’s money picture in a few lines: what went out, by category, and anything unusual.',
  standup: 'From the watchlist and the recent briefings, what carried over this week and what should I close out before Monday?',
} as const;

const thinkStep = (apps: readonly TemplateAppCandidate[], app: TemplateApp, prompt: string, sql: readonly string[]): StepDraft => {
  const installed = findTemplateApp(apps, app);
  return {
    kind: 'app-think',
    appId: installed?.appId ?? '',
    prompt,
    dataMode: 'queries',
    sql: [...sql],
    maxRows: SCHEDULE_CONTEXT_DEFAULT_ROWS,
    ...(installed === undefined ? { missingApp: app.name } : {}),
  };
};

const runStep = (apps: readonly TemplateAppCandidate[], app: TemplateApp): StepDraft => {
  const installed = findTemplateApp(apps, app);
  return { kind: 'app-run', appId: installed?.appId ?? '', input: '', ...(installed === undefined ? { missingApp: app.name } : {}) };
};

export interface TemplateFill {
  title: string;
  steps: StepDraft[];
  spec: ScheduleSpec;
  alert: AlertKind;
  /** The starters the steps name, in step order — a card's apps; empty for a reminder-only template. */
  apps: readonly TemplateApp[];
  /** Those of them NOT installed, in step order — a card's "add <App>, then schedule it"; the matching steps carry `missingApp`. */
  missing: readonly TemplateApp[];
  /** The glyph for a template with no app. */
  glyph?: string;
}

/** The starters a template names, split by whether the file holds them — one lookup rule (`findTemplateApp`) for the steps and the card. */
const namedApps = (installed: readonly TemplateAppCandidate[], apps: readonly TemplateApp[]): Pick<TemplateFill, 'apps' | 'missing'> => ({
  apps,
  missing: apps.filter((app) => findTemplateApp(installed, app) === undefined),
});

/** The four templates (spec S2), filled against the installed apps. */
export function templateFill(name: TemplateName, apps: readonly TemplateAppCandidate[], tz: ScheduleSpec['tz'] = 'device'): TemplateFill {
  switch (name) {
    case 'nudge':
      return {
        title: TEMPLATE_TITLES.nudge,
        steps: [{ kind: 'notify', title: 'nudge', body: 'time to check in' }],
        spec: { kind: 'daily', time: '20:00', tz },
        alert: 'notification',
        glyph: '🔔',
        ...namedApps(apps, []),
      };
    case 'spend-review':
      return {
        title: TEMPLATE_TITLES['spend-review'],
        steps: [thinkStep(apps, LEDGER, TEMPLATE_PROMPTS.spend, LEDGER_QUERIES)],
        spec: { kind: 'weekly', days: ['fri'], time: '17:00', tz },
        alert: 'inbox',
        ...namedApps(apps, [LEDGER]),
      };
    case 'friday-review':
      return {
        title: TEMPLATE_TITLES['friday-review'],
        steps: [thinkStep(apps, LEDGER, TEMPLATE_PROMPTS.money, LEDGER_QUERIES), thinkStep(apps, STANDUP, TEMPLATE_PROMPTS.standup, STANDUP_QUERIES)],
        spec: { kind: 'weekly', days: ['fri'], time: '17:00', tz },
        alert: 'inbox',
        ...namedApps(apps, [LEDGER, STANDUP]),
      };
    case 'morning-weather':
      return {
        title: TEMPLATE_TITLES['morning-weather'],
        steps: [runStep(apps, WEATHER), { kind: 'notify', title: 'morning weather', body: 'your morning weather is ready' }],
        spec: { kind: 'daily', time: '07:00', tz },
        alert: 'notification',
        ...namedApps(apps, [WEATHER]),
      };
    default: {
      const never: never = name;
      return never;
    }
  }
}

// ------------------------------------------------------- the words beside the schedule

interface Word {
  key: string;
  /** The typed token(s) this word came from. */
  tokens: number[];
}

/**
 * A typed token as the grammar's `normalise` reads it — lowercase, "a.m." → "am", edge
 * punctuation off, "each" → "every", "everyday" → "every day" — so a phrase the grammar quotes
 * can be found again in the text as typed.
 */
const keysOf = (token: string): string[] => {
  const key = token
    .toLowerCase()
    .replace(/\b([ap])\.m\.?/g, '$1m')
    .replace(/[.,;:!?()"'[\]{}]+$/, '')
    .replace(/^[.,;!?()"'[\]{}]+/, '');
  if (key === '') return [];
  if (key === 'each') return ['every'];
  if (key === 'everyday') return ['every', 'day'];
  return [key];
};

/** The text's words, each with the token(s) it came from; "week days" / "week ends" joined as the grammar joins them. */
const wordsOf = (tokens: readonly string[]): Word[] => {
  const words: Word[] = [];
  for (const [index, token] of tokens.entries()) {
    for (const key of keysOf(token)) {
      const last = words[words.length - 1];
      if (last !== undefined && last.key === 'week' && (key === 'days' || key === 'ends')) {
        last.key = `week${key}`;
        last.tokens.push(index);
      } else words.push({ key, tokens: [index] });
    }
  }
  return words;
};

const EDGES = /^[\s,;:.!?\-–—]+|[\s,;:.!?\-–—]+$/g;
const LEADING_PLEASE = /^please\b[\s,]*/i;
const LEADING_INTENT = /^(?:remind me(?: to)?|tell me to)\b[\s,:]*/i;
const TRAILING_PLEASE = /[\s,]*\bplease$/i;

/**
 * The sentence minus the schedule the grammar read (`readSchedule(…).phrase`): the task's own
 * words, spelled as typed — "remind me to call mom at 5" → "call mom"; "every weekday at 8,
 * summarise my ledger" → "summarise my ledger"; "at 5pm" → "". The phrase's words are found as
 * one run, else in order (a phrase the task splits: "at 5 remind me every weekday"); then the
 * edges are trimmed of punctuation and whitespace, and a leading intent ("please", "remind me
 * to", "remind me", "tell me to") and a trailing "please" are each stripped once. An empty
 * phrase (nothing parsed) leaves the whole sentence minus the intent; a phrase the text does not
 * carry answers "" — the caller then keeps the whole sentence, as before.
 */
export function remainderOf(text: string, phrase: string): string {
  const tokens = text.trim().split(/\s+/).filter((token) => token !== '');
  const words = wordsOf(tokens);
  const wanted = phrase.split(' ').filter((word) => word !== '');
  const consumed = new Set<number>();
  if (wanted.length > 0) {
    const run = words.findIndex((_, start) => start + wanted.length <= words.length && wanted.every((word, offset) => words[start + offset]?.key === word));
    if (run >= 0) {
      for (let offset = 0; offset < wanted.length; offset++) for (const index of words[run + offset]?.tokens ?? []) consumed.add(index);
    } else {
      let next = 0;
      for (const word of words) {
        if (next < wanted.length && word.key === wanted[next]) {
          for (const index of word.tokens) consumed.add(index);
          next++;
        }
      }
      if (next < wanted.length) return '';
    }
  }
  const rest = tokens.filter((_, index) => !consumed.has(index)).join(' ');
  return rest.replace(EDGES, '').replace(LEADING_PLEASE, '').replace(LEADING_INTENT, '').replace(TRAILING_PLEASE, '').replace(EDGES, '');
}

/** A fresh step carrying the sentence's own words — a reminder's title and message, or an app's prompt; untouched when there are none. */
const stepFromWords = (step: StepDraft, words: string): StepDraft => {
  if (words === '' || step.kind === 'app-run') return step;
  return step.kind === 'notify'
    ? { ...step, title: words.slice(0, SCHEDULE_TITLE_MAX_CHARS), body: words.slice(0, SCHEDULE_NOTIFY_BODY_MAX_CHARS) }
    : { ...step, prompt: words.slice(0, SCHEDULE_PROMPT_MAX_CHARS) };
};

// ------------------------------------------------------------------- the initial draft

export interface InitialDraftInput {
  text?: string | null;
  template?: string | null;
  app?: string | null;
  /** `?suggestion=` — a `ScheduleProposal` as JSON, from the chat's suggestion card (TASK-20261009 P1). */
  proposal?: string | null;
  apps: readonly TemplateAppCandidate[];
  now: Date;
}

/** What fills a fresh form: a template's whole fill, or a suggestion's title, steps and spec. */
type Fill = Pick<TemplateFill, 'title' | 'steps' | 'spec'> & { alert?: AlertKind };

/** A suggestion as the editor's fill: its title, its steps as drafts, its spec. `undefined` for anything that does not parse. */
export function proposalFill(raw: string | null | undefined, apps: readonly TemplateAppCandidate[]): Fill | undefined {
  const proposal: ScheduleProposal | undefined = parseScheduleProposal(raw);
  if (proposal === undefined) return undefined;
  const known = new Set(apps.map((record) => record.appId));
  return {
    title: proposal.title,
    // A step naming an app this file no longer holds gets the same off state a template step
    // gets, so the save drops it rather than refusing by surprise — and it is named in WORDS: a
    // suggestion carries no app names, so the note says "that app", never an id (M14).
    steps: draftsFromSteps(proposal.steps).map((step) => (step.kind !== 'notify' && !known.has(step.appId) ? { ...step, missingApp: STEPS.unknownApp } : step)),
    spec: proposal.spec,
  };
}

export interface InitialDraft {
  draft: EditorDraft;
  /** `?text=` carried no readable time — its words stay as the title, the controls are the way. */
  parseFailed: boolean;
}

/**
 * The `/schedule/new` draft from the query string: a template, a sentence, a preselected app — or
 * the empty form. A sentence is read twice over: the grammar's phrase fills the when, and the
 * words beside it (`remainderOf`) become the title and the one step's own words — a reminder's
 * title and message, or the preselected app's prompt — so the create bar is one click from
 * *schedule it* (design F1). A sentence that is only a schedule keeps itself as the title and
 * leaves the step to the user; a template's steps are its own.
 */
export function initialDraft({ text, template, app, proposal, apps, now }: InitialDraftInput): InitialDraft {
  const appNames = new Map(apps.map((record) => [record.appId, record.displayName] as const));
  // A suggestion fills the form the way a template does, and wins over one.
  const fill: Fill | undefined = proposalFill(proposal, apps) ?? (isTemplateName(template) ? templateFill(template, apps) : undefined);
  const preselected = app !== null && app !== undefined && appNames.has(app) ? app : undefined;
  const sentence = text ?? '';
  const typed = sentence.trim() !== '';
  const read = typed ? readSchedule(sentence, now, 'device') : undefined;
  const words = typed ? remainderOf(sentence, read?.phrase ?? '') : '';
  const steps = fill?.steps ?? [stepFromWords(preselected !== undefined ? emptyThink(preselected) : emptyNotify(), words)];
  const spec = read?.spec ?? fill?.spec ?? { kind: 'daily', time: '09:00', tz: 'device' };
  const title = typed ? titleFromText(words || sentence) : (fill?.title ?? titleFromSteps(steps, appNames));
  return {
    draft: {
      text: sentence,
      title,
      titleTouched: false,
      spec,
      mode: spec.kind,
      cron: cronTextFor(spec, now),
      steps,
      missedPolicy: defaultPolicyFor(steps),
      missedTouched: false,
      alert: fill?.alert ?? 'inbox',
    },
    parseFailed: typed && read === undefined,
  };
}

// ------------------------------------------------------------- the brain, the hosts, the bound

export interface AppBrainInputs {
  brain: Brain;
  mode: PlaygroundMode;
  /** The RESOLVED default provider. */
  provider: ByokProvider;
  /** The app's own provider pin, as stored (`useAppProvider`); anything unknown reads as inheriting. */
  pinned: string | undefined;
  keys: Record<KeyedProvider, boolean>;
}

/**
 * The brain an app's scheduled question runs on NOW — the app transport's own route
 * (`createAppTransport`: the per-app pin over the resolved default, keyless falling through to
 * the demo brain), named as the brain chip names it, so the cost line and the chip agree.
 */
export function appBrainKind({ brain, mode, provider, pinned, keys }: AppBrainInputs): ActiveBrainKind {
  if (brain.kind === 'host') return 'host';
  if (brain.kind === 'webllm') return 'webllm';
  if (brain.kind === 'demo') return 'demo';
  if (mode === 'subscription') return 'subscription';
  const effective: ByokProvider = pinned === 'anthropic' || pinned === 'openai' || pinned === 'mock' ? pinned : provider;
  const hasKey = effective === 'anthropic' || effective === 'openai' ? keys[effective] : false;
  return adapterKindFor({ mode, provider: effective, hasKey });
}

/** The hosts each app's APPROVED connections may call — the consent panel's `may call` row. */
export function approvedHostsByApp(db: UserDb, appIds: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const appId of new Set(appIds)) {
    const hosts = new Set<string>();
    for (const row of db.listConnections(appId)) {
      if (row.status !== CONNECTION_STATUS.approved) continue;
      for (const host of row.allowedHosts) hosts.add(host);
    }
    out[appId] = [...hosts].sort();
  }
  return out;
}

/**
 * The most AI calls one day of the next seven can spend: the busiest day's occurrences in the
 * zone × the *ask the AI* steps, never above the global ceiling the engine enforces (E7).
 */
export function dailyAiBound(spec: ScheduleSpec, steps: readonly ScheduleStep[], now: Date): number {
  const ai = steps.filter((step) => step.kind === 'app-think').length;
  if (ai === 0) return 0;
  const zone = resolveZone(spec.tz);
  const perDay = new Map<string, number>();
  for (const at of occurrencesBetween(spec, now, new Date(now.getTime() + WEEK_MS), { limit: WEEK_OCCURRENCE_LIMIT, anchor: now })) {
    const w = wallClockIn(zone, at);
    const key = `${w.year}-${w.month}-${w.day}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  let busiest = 0;
  for (const count of perDay.values()) busiest = Math.max(busiest, count);
  return Math.min(SCHEDULE_DAILY_CEILINGS.ai, busiest * ai);
}

/** The IANA zones this runtime can name, for the pin select; empty where `Intl` cannot list them. */
export function knownZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

/** The `/schedule/:id` draft: the persisted schedule as the form shows it; nothing defaults over a saved choice. */
export function draftFromTask(task: { title: string; spec: ScheduleSpec; steps: readonly ScheduleStep[]; missedPolicy: MissedPolicy; alert: AlertKind }, now: Date): EditorDraft {
  return {
    text: '',
    title: task.title,
    titleTouched: true,
    spec: task.spec,
    mode: task.spec.kind,
    cron: cronTextFor(task.spec, now),
    steps: draftsFromSteps(task.steps),
    missedPolicy: task.missedPolicy,
    missedTouched: true,
    alert: task.alert,
  };
}
