// schedule/types.ts — the ScheduleSpec shape the engine, the compiler and the text grammar share.
//
// RE-EXPORT, NOT A COPY. `packages/protocol/src/schedule.ts` (ADR-0074 §1, TASK-20261009 C1)
// is the zod-first source of truth; this file aliases its inferred types and its persisted
// literal lists so the playground's `cron.ts` and `parseScheduleText.ts` keep one import path
// and never drift from what the parser accepts. `MonthlyOn` is derived from the spec union —
// the protocol names no such type of its own.

export type { ScheduleSpec, ScheduleUnit, ScheduleUntil, Weekday } from '@snugprotocol/protocol';
export { SCHEDULE_UNITS, WEEKDAYS } from '@snugprotocol/protocol';

import type { ScheduleSpec } from '@snugprotocol/protocol';

/** Which day of the month a `monthly` spec fires on — the protocol's `on` seat. */
export type MonthlyOn = Extract<ScheduleSpec, { kind: 'monthly' }>['on'];
