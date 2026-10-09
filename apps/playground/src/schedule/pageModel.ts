// schedule/pageModel.ts — the pure derivations the schedule page, the hub section and the
// missed card share (TASK-20261009-scheduling-framework U1, U2, U4). No sentence lives here
// (`copy.ts`, `copy.page.ts`) and no act (`scheduler.ts`): this module turns the store's view
// — tasks, runs, a clock — into the rows a component renders, so three surfaces group, sort
// and date things one way, and a test can pin each rule without a DOM.
//
// THE CLOCK. Relative words ("next tomorrow", "3 minutes ago") and the *today* group depend on
// "now"; components read it through `pageClock` so a test can hold it still, and `useNow()`
// re-reads it once a minute so a row that said "in 1 minute" does not say so all afternoon.

import { useEffect, useState } from 'react';

import type { RunStatus, ScheduleRun, ScheduleStep, ScheduledTask } from '@snugprotocol/protocol';

import { useLibraryRevision } from '../platform/signals.js';
import { refreshAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { userLibrary } from '../state/library.js';
import { nextOccurrence } from './cron.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------------- the clock

export const pageClock = { now: (): Date => new Date() };

/** Test seam: hold the page's clock still (or let it go again with no argument). */
export function __setPageClockForTests(now?: () => Date): void {
  pageClock.now = now ?? ((): Date => new Date());
}

/** "Now", re-read once a minute so relative words stay honest while the page sits open. */
export function useNow(intervalMs = MINUTE_MS): Date {
  const [now, setNow] = useState(() => pageClock.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(pageClock.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------- relative words

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole local calendar days from `now` to `target` (DST-safe: rounded). */
export function localDayDiff(target: Date, now: Date): number {
  return Math.round((startOfLocalDay(target) - startOfLocalDay(now)) / DAY_MS);
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return localDayDiff(a, b) === 0;
}

/**
 * "now" · "in 5 minutes" · "2 hours ago" · "tomorrow" · "in 3 days" · "last week". Calendar
 * days win once the target is on another local day — "tomorrow" is what a person says about
 * 8 AM when it is 10 PM, not "in 10 hours". `Intl` supplies the words for the locale.
 */
export function relativeTime(target: Date, now: Date, locale = 'en-US'): string {
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const days = localDayDiff(target, now);
  if (days === 0) {
    if (abs < 45_000) return 'now';
    if (abs < HOUR_MS) return rtf.format(Math.round(diff / MINUTE_MS), 'minute');
    return rtf.format(Math.round(diff / HOUR_MS), 'hour');
  }
  if (Math.abs(days) < 7) return rtf.format(days, 'day');
  if (Math.abs(days) < 30) return rtf.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month');
  return rtf.format(Math.round(days / 365), 'year');
}

/**
 * The absolute form beside `relativeTime` — one `Intl` rendering for every surface that names an
 * instant in full ("Oct 9, 2026, 7:00 AM"); the result detail pairs it with the relative one.
 */
export function absoluteTime(target: Date, locale = 'en-US', zone?: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(zone !== undefined ? { timeZone: zone } : {}),
  }).formatToParts(target);
  return parts.map((part) => part.value).join('').replace(/\u202f/g, ' ');
}

// ------------------------------------------------------------------------ the steps

export const appIdsOf = (steps: readonly ScheduleStep[]): string[] => [...new Set(steps.flatMap((step) => (step.kind === 'notify' ? [] : [step.appId])))];

/** How many *ask the AI* steps a schedule has — one brain call each per occurrence. */
export const aiStepsOf = (steps: readonly ScheduleStep[]): number => steps.filter((step) => step.kind === 'app-think').length;

// ---------------------------------------------------------------------- the results

/** The statuses that are a RESULT a person may open (mirrors the engine's set). */
export const RESULT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['ok', 'failed', 'needs-you', 'interrupted', 'capped', 'no-handler']);

export interface ResultRow {
  run: ScheduleRun;
  item: ScheduledTask;
  /** `finishedAt ?? dueAt` — what the feed sorts by and dates with. */
  at: string;
}

const atOf = (run: ScheduleRun): string => run.finishedAt ?? run.dueAt;

/** Every result across every schedule, newest first. A run whose schedule is gone is not listed. */
export function resultRows(tasks: readonly ScheduledTask[], runsByTask: Record<string, ScheduleRun[]>): ResultRow[] {
  const byId = new Map(tasks.map((item) => [item.id, item] as const));
  const rows: ResultRow[] = [];
  for (const [taskId, runs] of Object.entries(runsByTask)) {
    const item = byId.get(taskId);
    if (item === undefined) continue;
    for (const run of runs) {
      if (!RESULT_STATUSES.has(run.status)) continue;
      rows.push({ run, item, at: atOf(run) });
    }
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A schedule's runs, newest first by due instant (the accessor already answers so; this pins it). */
export function runsNewestFirst(runs: readonly ScheduleRun[] | undefined): ScheduleRun[] {
  return [...(runs ?? [])].sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt));
}

/** The most recent RESULT of a schedule (never a candidate, a claim or a skip). */
export function latestResult(runs: readonly ScheduleRun[] | undefined): ScheduleRun | undefined {
  return runsNewestFirst(runs).find((run) => RESULT_STATUSES.has(run.status));
}

// ---------------------------------------------------------------------- the pending

export interface PendingRow {
  run: ScheduleRun;
  item: ScheduledTask;
}

/**
 * The persisted catch-up candidates (`pending` rows) of ENABLED schedules, oldest due first —
 * what the missed card lists. A schedule that is off (the user's switch, an engine pause, an
 * untrusted import) is never offered to run from here (Gate-5 S1).
 */
export function pendingRows(tasks: readonly ScheduledTask[], runsByTask: Record<string, ScheduleRun[]>): PendingRow[] {
  const byId = new Map(tasks.map((item) => [item.id, item] as const));
  const rows: PendingRow[] = [];
  for (const [taskId, runs] of Object.entries(runsByTask)) {
    const item = byId.get(taskId);
    if (item === undefined || !item.enabled) continue;
    for (const run of runs) if (run.status === 'pending') rows.push({ run, item });
  }
  return rows.sort((a, b) => Date.parse(a.run.dueAt) - Date.parse(b.run.dueAt));
}

/** The AI calls accepting every candidate would spend: one per *ask the AI* step, per candidate (collapsed = runs once). */
export function pendingAiCalls(rows: readonly PendingRow[]): number {
  return rows.reduce((sum, row) => sum + aiStepsOf(row.item.steps), 0);
}

// ---------------------------------------------------------------------- the groups

export type Attention = { kind: 'needs-you'; run: ScheduleRun } | { kind: 'paused'; reason: NonNullable<ScheduledTask['pausedReason']> } | { kind: 'imported' };

/**
 * Why a schedule sits under *needs your attention*, or `undefined`: its latest result needs
 * the user, the engine paused it (with its reason — *resume* is the act), or it arrived
 * disabled with an imported file (*review* is the act).
 */
export function attentionOf(item: ScheduledTask, runs: readonly ScheduleRun[] | undefined): Attention | undefined {
  if (item.pausedReason !== undefined) return { kind: 'paused', reason: item.pausedReason };
  if (item.provenance === 'imported' && !item.enabled) return { kind: 'imported' };
  const latest = latestResult(runs);
  if (latest?.status === 'needs-you') return { kind: 'needs-you', run: latest };
  return undefined;
}

/** The next time an ENABLED schedule fires after `now`, or `undefined` (disabled, finished, out of range). */
export function nextFor(item: ScheduledTask, now: Date): Date | undefined {
  if (!item.enabled) return undefined;
  const next = nextOccurrence(item.spec, now, { anchor: new Date(item.startsAt ?? item.createdAt) });
  if (next === undefined) return undefined;
  if (item.endsAt !== undefined && next.getTime() > Date.parse(item.endsAt)) return undefined;
  return next;
}

export interface Grouped {
  attention: ScheduledTask[];
  today: ScheduledTask[];
  upcoming: ScheduledTask[];
  paused: ScheduledTask[];
}

const byNext = (now: Date) => (a: ScheduledTask, b: ScheduledTask): number => {
  const an = nextFor(a, now)?.getTime() ?? Number.POSITIVE_INFINITY;
  const bn = nextFor(b, now)?.getTime() ?? Number.POSITIVE_INFINITY;
  return an === bn ? a.title.localeCompare(b.title) : an - bn;
};

/**
 * needs your attention (any `attentionOf`) · today (enabled, next on this local day) · upcoming
 * (enabled, later) · paused (off by the user's own hand). Each group soonest first.
 */
export function groupTasks(tasks: readonly ScheduledTask[], runsByTask: Record<string, ScheduleRun[]>, now: Date): Grouped {
  const grouped: Grouped = { attention: [], today: [], upcoming: [], paused: [] };
  for (const item of tasks) {
    if (attentionOf(item, runsByTask[item.id]) !== undefined) grouped.attention.push(item);
    else if (!item.enabled) grouped.paused.push(item);
    else {
      const next = nextFor(item, now);
      if (next !== undefined && isSameLocalDay(next, now)) grouped.today.push(item);
      else grouped.upcoming.push(item);
    }
  }
  const sort = byNext(now);
  grouped.attention.sort((a, b) => a.title.localeCompare(b.title));
  grouped.today.sort(sort);
  grouped.upcoming.sort(sort);
  grouped.paused.sort((a, b) => a.title.localeCompare(b.title));
  return grouped;
}

/** The first `limit` enabled schedules by next occurrence — the hub section's rows. */
export function upcomingTasks(tasks: readonly ScheduledTask[], now: Date, limit = 3): ScheduledTask[] {
  return tasks
    .filter((item) => item.enabled && nextFor(item, now) !== undefined)
    .sort(byNext(now))
    .slice(0, limit);
}

// ----------------------------------------------------------------------- the apps

export interface AppIndex {
  /** `installSource` → appId (the hub's dedup map), for the templates' "add X" decision. */
  bySource: ReadonlyMap<string, string>;
  /** Every installed app's id. */
  ids: ReadonlySet<string>;
  name: (appId: string) => string;
  emoji: (appId: string) => string | undefined;
}

/**
 * What the page knows about installed apps: the library list (re-read on the library
 * revision, like the hub) for identities, the app-meta store for names and emoji. A read
 * that fails leaves the index it had — the page is about schedules, not the shelf.
 */
export function useAppIndex(enabled = true): AppIndex {
  const metaMap = useAppMetaMap();
  const revision = useLibraryRevision();
  const [bySource, setBySource] = useState<ReadonlyMap<string, string>>(new Map());
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void refreshAppMeta().catch(() => undefined);
    void userLibrary()
      .list()
      .then((entries) => {
        if (cancelled) return;
        const sources = new Map<string, string>();
        for (const entry of entries) if (entry.installSource !== undefined) sources.set(entry.installSource, entry.id);
        setBySource(sources);
        setIds(new Set(entries.map((entry) => entry.id)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, revision]);
  return {
    bySource,
    ids,
    name: (appId) => metaMap[appId]?.displayName ?? appId,
    emoji: (appId) => metaMap[appId]?.iconEmoji,
  };
}
