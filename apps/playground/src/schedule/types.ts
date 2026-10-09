// schedule/types.ts — the ScheduleSpec shape the engine, the compiler and the text grammar share.
//
// LOCAL STRUCTURAL COPY. `packages/protocol/src/schedule.ts` (ADR-0074 §1, TASK-20261009 C1) is
// the zod-first source of truth and is being written in parallel; this file mirrors its inferred
// shape field for field so `cron.ts` and `parseScheduleText.ts` compile on their own. A later
// commit aliases `ScheduleSpec` here to the protocol export — nothing else in this folder changes.

/** Day keys in the order a sentence lists them (Monday first; `sun` is cron's 0). */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Units an `every` spec may count in. Weeks are N×7 days; months are a `monthly` spec. */
export const SCHEDULE_UNITS = ['minutes', 'hours', 'days'] as const;
export type ScheduleUnit = (typeof SCHEDULE_UNITS)[number];

/** When a recurring schedule stops: on a calendar date (end of that day in the zone) or after N runs. */
export type ScheduleUntil = { kind: 'date'; date: string } | { kind: 'count'; count: number };

/** Which day of the month a `monthly` spec fires on. */
export type MonthlyOn =
  | { kind: 'day'; day: number }
  | { kind: 'nth'; nth: 1 | 2 | 3 | 4; weekday: Weekday }
  | { kind: 'last' };

type SpecBase = {
  /** `'device'` resolves to the device zone at compute time; anything else is an IANA zone name. */
  tz: 'device' | string;
  until?: ScheduleUntil;
};

export type ScheduleSpec =
  | (SpecBase & { kind: 'once'; at: string })
  | (SpecBase & { kind: 'every'; n: number; unit: ScheduleUnit })
  | (SpecBase & { kind: 'daily'; time: string })
  | (SpecBase & { kind: 'weekly'; days: Weekday[]; time: string })
  | (SpecBase & { kind: 'monthly'; on: MonthlyOn; time: string })
  | (SpecBase & { kind: 'custom'; cron: string });
