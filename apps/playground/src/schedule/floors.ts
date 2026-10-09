// schedule/floors.ts — the pure cost rules of a schedule (TASK-20261009-scheduling-framework;
// ADR-0074 §5, §6; Q12; security F6). No React, no store, no I/O: every function is a value
// over a `ScheduleSpec`, its steps and an anchor instant, and the editor, the consent surface
// and the engine all read the same answers.
//
// THE PERIOD. `minIntervalMs` is the smallest gap between two consecutive occurrences. For
// `every N <unit>` it is the NOMINAL N×unit — the user's stated cadence — even though the
// compiled cron aligns to the hour or day (`every 7 minutes` fires at :00, :07 … :56 and then
// :00 again, a 4-minute gap once an hour): the floor measures intent and spend RATE, and the
// nominal interval is the honest rate. Every other recurring form is SAMPLED: the next nine
// occurrences from the anchor (`until` stripped — a schedule limited to one run still has a
// period), the minimum of the eight gaps. A one-off has no period; a spec that cannot fire
// twice inside the engine's 400-day bound answers `undefined`, which every reader treats as
// "slower than anything a floor or a window cares about".
//
// THE FLOOR (security F6). The user's own schedule may run every 5 minutes; anything proposed
// by the builder, the chat or an app — and anything imported — every 15. `imported` counts as
// "other" on purpose: an imported task is executable intent that arrived without this user's
// act (ADR-0074 §2), so it gets the stricter floor.
//
// THE FRESHNESS WINDOW (Q12, design F5). A missed occurrence older than one period is stale —
// the next one is about to replace it — clamped to the protocol's [1 minute, 7 days]; a one-off
// has no period and keeps one day. THE CATCH-UP DEFAULT derives from cost: a reminder-only
// schedule catches up silently (`run-once`), anything that spends the brain or the network
// asks. THE WEEKLY ESTIMATE is occurrences in the next seven days × the steps that spend —
// `app-think` one brain call, `app-run` ONE network call as an estimate (an app's own code may
// make none or several; the counting transport records the truth at run time), `notify` none.

import {
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_STALE_AFTER_MS,
  type MissedPolicy,
  type ScheduleSpec,
  type ScheduleStep,
  type ScheduleUnit,
  type TaskProvenance,
} from '@snugprotocol/protocol';

import { SEARCH_BOUND_DAYS, occurrencesBetween } from './cron.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const UNIT_MS: Record<ScheduleUnit, number> = { minutes: MINUTE_MS, hours: 3_600_000, days: DAY_MS };

/** Nine occurrences give eight gaps — enough to see a weekday/weekend or a short-month gap. */
const SAMPLE_OCCURRENCES = 9;
/** A one-off has no period; a missed one is fresh for a day. */
const ONCE_FRESHNESS_MS = DAY_MS;
/** The most minute-aligned instants in seven days, plus one so a truncation would be visible. */
const WEEK_OCCURRENCE_LIMIT = 7 * 24 * 60 + 1;

/** What one step spends per occurrence. */
export type StepCost = { readonly ai: number; readonly net: number };

const STEP_COST: Record<ScheduleStep['kind'], StepCost> = {
  notify: { ai: 0, net: 0 },
  'app-think': { ai: 1, net: 0 },
  'app-run': { ai: 0, net: 1 },
};

/** The same spec with no `until` — the period of a schedule does not depend on when it stops. */
const withoutUntil = (spec: ScheduleSpec): ScheduleSpec => (spec.until === undefined ? spec : { ...spec, until: undefined });

/**
 * The smallest gap in ms between two consecutive occurrences; `undefined` for a one-off or a
 * spec that cannot fire twice within the engine's search bound (see the header).
 */
export function minIntervalMs(spec: ScheduleSpec, anchor: Date): number | undefined {
  switch (spec.kind) {
    case 'once':
      return undefined;
    case 'every':
      return spec.n * UNIT_MS[spec.unit];
    default: {
      const to = new Date(anchor.getTime() + SEARCH_BOUND_DAYS * DAY_MS);
      const sampled = occurrencesBetween(withoutUntil(spec), anchor, to, { limit: SAMPLE_OCCURRENCES, anchor });
      let min: number | undefined;
      for (let i = 1; i < sampled.length; i += 1) {
        const gap = (sampled[i] as Date).getTime() - (sampled[i - 1] as Date).getTime();
        if (min === undefined || gap < min) min = gap;
      }
      return min;
    }
  }
}

/** The floor for who created the schedule: the user's own every 5 minutes, everything else every 15. */
export function frequencyFloorMs(provenance: TaskProvenance): number {
  return provenance === 'user' ? SCHEDULE_MIN_INTERVAL_MS.user : SCHEDULE_MIN_INTERVAL_MS.other;
}

const minutesWord = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
};

/**
 * One sentence when the schedule would run more often than its floor allows — naming how often
 * it would run and the floor in minutes — or `undefined` when the cadence is fine. A one-off and
 * a spec with no measurable period are never refused.
 */
export function frequencyFloorRefusal(spec: ScheduleSpec, provenance: TaskProvenance, anchor: Date): string | undefined {
  const interval = minIntervalMs(spec, anchor);
  if (interval === undefined) return undefined;
  const floor = frequencyFloorMs(provenance);
  if (interval >= floor) return undefined;
  const who = provenance === 'user' ? 'your own schedule' : 'a schedule that was suggested or imported';
  return `too often: this would run every ${minutesWord(interval)}, and ${who} may run at most every ${minutesWord(floor)}`;
}

/**
 * How long a missed occurrence stays worth asking about: one period, clamped to the protocol's
 * [1 minute, 7 days]; a one-off keeps a day. A spec with no measurable period gets the maximum.
 */
export function freshnessWindowMs(spec: ScheduleSpec, anchor: Date): number {
  if (spec.kind === 'once') return ONCE_FRESHNESS_MS;
  const period = minIntervalMs(spec, anchor) ?? SCHEDULE_STALE_AFTER_MS.max;
  return Math.min(SCHEDULE_STALE_AFTER_MS.max, Math.max(SCHEDULE_STALE_AFTER_MS.min, period));
}

/** Cost-derived (Q12): reminders only → catch up silently; anything that spends → ask. */
export function defaultMissedPolicy(steps: readonly ScheduleStep[]): MissedPolicy {
  return steps.every((step) => step.kind === 'notify') ? 'run-once' : 'ask';
}

/**
 * Occurrences in `(anchor, anchor + 7 days]` × what the steps spend per occurrence (see the
 * header for the `app-run` estimate). A step list that spends nothing answers zeros without
 * touching the engine.
 */
export function estimatedCallsPerWeek(spec: ScheduleSpec, steps: readonly ScheduleStep[], anchor: Date): { ai: number; net: number } {
  let ai = 0;
  let net = 0;
  for (const step of steps) {
    ai += STEP_COST[step.kind].ai;
    net += STEP_COST[step.kind].net;
  }
  if (ai === 0 && net === 0) return { ai: 0, net: 0 };
  const to = new Date(anchor.getTime() + WEEK_MS);
  const occurrences = occurrencesBetween(spec, anchor, to, { limit: WEEK_OCCURRENCE_LIMIT, anchor }).length;
  return { ai: occurrences * ai, net: occurrences * net };
}
