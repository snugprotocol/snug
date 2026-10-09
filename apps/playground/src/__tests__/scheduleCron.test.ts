// scheduleCron.test.ts — TASK-20261009 C5 (ADR-0074 §5, §7): the hand-rolled cron and the
// occurrence engine. `parseCron` acceptance/refusal, `compileSpec`/`specFromCron` round trips
// for every preset, exact `describeSpec` strings, and occurrences computed by stepping DAYS in
// the task's zone — the DST gap skipped, the overlap once, Feb 29 only in leap years, the 31st
// skipped in short months, `monthly{last}`, the 400-day bound, `until`, the N-day stride, and a
// cost bound. Every expected instant below was computed BY HAND: America/Los_Angeles springs
// forward 2026-03-08 02:00 PST → 03:00 PDT (10:00Z) and falls back 2026-11-01 02:00 PDT →
// 01:00 PST (09:00Z); PDT is UTC-7, PST is UTC-8.
import { describe, expect, it } from 'vitest';

import {
  compileSpec,
  describeSpec,
  isValidZone,
  listWords,
  minCronGapMs,
  nextOccurrence,
  occurrencesBetween,
  pad2,
  parseCron,
  resolveZone,
  sortDays,
  specFromCron,
  type CronFields,
  WEEKDAY_KEYS,
  WEEKEND_KEYS,
} from '../schedule/cron.js';
import type { ScheduleSpec } from '../schedule/types.js';

const LA = 'America/Los_Angeles';
const range = (lo: number, hi: number): Set<number> => {
  const out = new Set<number>();
  for (let v = lo; v <= hi; v += 1) out.add(v);
  return out;
};
const iso = (dates: readonly Date[]): string[] => dates.map((d) => d.toISOString());
const at = (s: string): Date => new Date(s);

describe('parseCron', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, CronFields]> = [
    [
      '* * * * *',
      {
        minutes: range(0, 59),
        hours: range(0, 23),
        daysOfMonth: range(1, 31),
        months: range(1, 12),
        daysOfWeek: range(0, 6),
        anyDayOfMonth: true,
        anyDayOfWeek: true,
      },
    ],
    [
      '0 8 * * 1-5',
      {
        minutes: new Set([0]),
        hours: new Set([8]),
        daysOfMonth: range(1, 31),
        months: range(1, 12),
        daysOfWeek: new Set([1, 2, 3, 4, 5]),
        anyDayOfMonth: true,
        anyDayOfWeek: false,
      },
    ],
    [
      '*/15 * * * *',
      {
        minutes: new Set([0, 15, 30, 45]),
        hours: range(0, 23),
        daysOfMonth: range(1, 31),
        months: range(1, 12),
        daysOfWeek: range(0, 6),
        anyDayOfMonth: true,
        anyDayOfWeek: true,
      },
    ],
    [
      '30 17 * * mon,thu',
      {
        minutes: new Set([30]),
        hours: new Set([17]),
        daysOfMonth: range(1, 31),
        months: range(1, 12),
        daysOfWeek: new Set([1, 4]),
        anyDayOfMonth: true,
        anyDayOfWeek: false,
      },
    ],
    [
      '0 9 1 JAN,jul *',
      {
        minutes: new Set([0]),
        hours: new Set([9]),
        daysOfMonth: new Set([1]),
        months: new Set([1, 7]),
        daysOfWeek: range(0, 6),
        anyDayOfMonth: false,
        anyDayOfWeek: true,
      },
    ],
    [
      '  0 0 * * 7  ',
      {
        minutes: new Set([0]),
        hours: new Set([0]),
        daysOfMonth: range(1, 31),
        months: range(1, 12),
        daysOfWeek: new Set([0]),
        anyDayOfMonth: true,
        anyDayOfWeek: false,
      },
    ],
    [
      '1-10/2 */6 */10 * sun-tue',
      {
        minutes: new Set([1, 3, 5, 7, 9]),
        hours: new Set([0, 6, 12, 18]),
        daysOfMonth: new Set([1, 11, 21, 31]),
        months: range(1, 12),
        daysOfWeek: new Set([0, 1, 2]),
        anyDayOfMonth: false,
        anyDayOfWeek: false,
      },
    ],
    [
      '5/20 * * * *',
      {
        minutes: new Set([5, 25, 45]),
        hours: range(0, 23),
        daysOfMonth: range(1, 31),
        months: range(1, 12),
        daysOfWeek: range(0, 6),
        anyDayOfMonth: true,
        anyDayOfWeek: true,
      },
    ],
  ];

  it.each(ACCEPTED)('accepts %j as a normalised set structure', (expr, expected) => {
    expect(parseCron(expr)).toEqual(expected);
  });

  const REFUSED = [
    ['', 'empty'],
    ['* * * *', 'four fields'],
    ['* * * * * *', 'six fields (seconds)'],
    ['0 0 * * * * 2026', 'seven fields (year)'],
    ['60 * * * *', 'minute 60'],
    ['* 24 * * *', 'hour 24'],
    ['* * 0 * *', 'day-of-month 0'],
    ['* * 32 * *', 'day-of-month 32'],
    ['* * * 0 *', 'month 0'],
    ['* * * 13 *', 'month 13'],
    ['* * * * 8', 'day-of-week 8'],
    ['0 0 L * *', 'L'],
    ['0 0 15W * *', 'W'],
    ['0 0 * * 1#2', '#'],
    ['0 0 ? * *', '?'],
    ['*/0 * * * *', 'step 0'],
    ['10-5 * * * *', 'reversed range'],
    ['0 8 * * monday', 'full day name'],
    ['0 8 * * mo', 'two-letter day'],
    ['0,, * * * *', 'empty list item'],
    ['a b c d e', 'letters'],
    ['-5 * * * *', 'negative'],
    ['1.5 * * * *', 'fraction'],
  ] as const;

  it.each(REFUSED)('refuses %j (%s)', (expr) => {
    expect(parseCron(expr)).toBeUndefined();
  });
});

describe('compileSpec ↔ specFromCron', () => {
  const ROUND_TRIPS: ReadonlyArray<readonly [string, ScheduleSpec, string]> = [
    ['daily', { kind: 'daily', time: '07:00', tz: 'device' }, '0 7 * * *'],
    ['daily at midnight', { kind: 'daily', time: '00:00', tz: 'device' }, '0 0 * * *'],
    ['weekdays', { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device' }, '0 8 * * 1,2,3,4,5'],
    ['weekends', { kind: 'weekly', days: ['sat', 'sun'], time: '10:00', tz: 'device' }, '0 10 * * 0,6'],
    ['two days', { kind: 'weekly', days: ['mon', 'thu'], time: '17:30', tz: 'device' }, '30 17 * * 1,4'],
    [
      'all seven days',
      { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '09:00', tz: 'device' },
      '0 9 * * 0,1,2,3,4,5,6',
    ],
    ['monthly day', { kind: 'monthly', on: { kind: 'day', day: 1 }, time: '09:00', tz: 'device' }, '0 9 1 * *'],
    ['monthly 31st', { kind: 'monthly', on: { kind: 'day', day: 31 }, time: '23:59', tz: 'device' }, '59 23 31 * *'],
    ['every 15 minutes', { kind: 'every', n: 15, unit: 'minutes', tz: 'device' }, '*/15 * * * *'],
    ['every minute', { kind: 'every', n: 1, unit: 'minutes', tz: 'device' }, '* * * * *'],
    ['every 7 minutes (a list, 60 is not divisible)', { kind: 'every', n: 7, unit: 'minutes', tz: 'device' }, '0,7,14,21,28,35,42,49,56 * * * *'],
    ['every 2 hours', { kind: 'every', n: 2, unit: 'hours', tz: 'device' }, '0 */2 * * *'],
    ['every hour', { kind: 'every', n: 1, unit: 'hours', tz: 'device' }, '0 * * * *'],
    ['every 5 hours (a list, 24 is not divisible)', { kind: 'every', n: 5, unit: 'hours', tz: 'device' }, '0 0,5,10,15,20 * * *'],
    ['once (the special form)', { kind: 'once', at: '2026-10-20T19:00:00.000Z', tz: 'device' }, 'once:2026-10-20T19:00:00.000Z'],
  ];

  it.each(ROUND_TRIPS)('%s compiles and reads back as the same preset', (_name, spec, cron) => {
    expect(compileSpec(spec)).toBe(cron);
    expect(specFromCron(cron)).toEqual(spec);
  });

  it('keeps a pinned zone out of the cron and answers "device" when reading back', () => {
    expect(compileSpec({ kind: 'daily', time: '07:00', tz: LA })).toBe('0 7 * * *');
    expect(specFromCron('0 7 * * *')).toEqual({ kind: 'daily', time: '07:00', tz: 'device' });
  });

  it('every N days compiles to a daily cron at the anchor wall time (the stride lives in the engine)', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 3, unit: 'days', tz: 'UTC' };
    expect(compileSpec(spec, at('2026-10-01T15:00:00Z'))).toBe('0 15 * * *');
    const inLA: ScheduleSpec = { kind: 'every', n: 3, unit: 'days', tz: LA };
    expect(compileSpec(inLA, at('2026-10-01T15:00:00Z'))).toBe('0 8 * * *');
  });

  it('every N days with a time compiles to the daily cron at THAT time — the anchor no longer matters', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 3, unit: 'days', time: '09:00', tz: LA };
    expect(compileSpec(spec, at('2026-10-01T15:00:00Z'))).toBe('0 9 * * *');
    expect(compileSpec(spec, at('2026-10-01T23:45:00Z'))).toBe('0 9 * * *');
    expect(compileSpec({ ...spec, time: '19:30' })).toBe('30 19 * * *');
    expect(compileSpec({ ...spec, time: '9:00' })).toBeUndefined();
    expect(compileSpec({ ...spec, time: '24:00' })).toBeUndefined();
    // The cron is the daily SUPERSET: it reads back as `daily`, never as the stride — specFromCron is unchanged.
    expect(specFromCron('0 9 * * *')).toEqual({ kind: 'daily', time: '09:00', tz: 'device' });
  });

  it('monthly nth weekday compiles to the weekday superset — documented, not a round trip', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'nth', nth: 1, weekday: 'mon' }, time: '09:00', tz: 'device' };
    expect(compileSpec(spec)).toBe('0 9 * * 1');
    expect(specFromCron('0 9 * * 1')).toEqual({ kind: 'weekly', days: ['mon'], time: '09:00', tz: 'device' });
  });

  it('monthly last compiles to the 28–31 superset, which reads back as custom', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'last' }, time: '18:00', tz: 'device' };
    expect(compileSpec(spec)).toBe('0 18 28,29,30,31 * *');
    expect(specFromCron('0 18 28,29,30,31 * *')).toEqual({ kind: 'custom', cron: '0 18 28,29,30,31 * *', tz: 'device' });
  });

  it('custom passes a valid cron through (trimmed) and refuses an invalid one', () => {
    expect(compileSpec({ kind: 'custom', cron: '  0 8 * * 1-5 ', tz: 'device' })).toBe('0 8 * * 1-5');
    expect(compileSpec({ kind: 'custom', cron: '0 8 * * L', tz: 'device' })).toBeUndefined();
  });

  it('refuses what 5-field cron cannot say', () => {
    expect(compileSpec({ kind: 'every', n: 60, unit: 'minutes', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'every', n: 90, unit: 'minutes', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'every', n: 24, unit: 'hours', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'every', n: 0, unit: 'hours', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'every', n: 2.5, unit: 'hours', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'weekly', days: [], time: '08:00', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'daily', time: '25:00', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'daily', time: '8am', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'monthly', on: { kind: 'day', day: 32 }, time: '09:00', tz: 'device' })).toBeUndefined();
    expect(compileSpec({ kind: 'once', at: 'not a date', tz: 'device' })).toBeUndefined();
  });

  it('specFromCron answers custom for a valid cron that is not a preset, undefined for garbage', () => {
    expect(specFromCron('0 8 * * 1-5')).toEqual({ kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device' });
    expect(specFromCron('0 8,12 * * *')).toEqual({ kind: 'custom', cron: '0 8,12 * * *', tz: 'device' });
    expect(specFromCron('0 9 1 jan *')).toEqual({ kind: 'custom', cron: '0 9 1 jan *', tz: 'device' });
    expect(specFromCron('5 */2 * * *')).toEqual({ kind: 'custom', cron: '5 */2 * * *', tz: 'device' });
    expect(specFromCron('0 0 L * *')).toBeUndefined();
    expect(specFromCron('once:nope')).toBeUndefined();
  });
});

describe('describeSpec', () => {
  const STRINGS: ReadonlyArray<readonly [ScheduleSpec, string]> = [
    [{ kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device' }, 'Weekdays at 8:00 AM'],
    [{ kind: 'weekly', days: ['sat', 'sun'], time: '10:00', tz: 'device' }, 'Weekends at 10:00 AM'],
    [{ kind: 'weekly', days: ['thu', 'mon'], time: '17:30', tz: 'device' }, 'Mondays and Thursdays at 5:30 PM'],
    [{ kind: 'weekly', days: ['mon', 'wed', 'fri'], time: '12:00', tz: 'device' }, 'Mondays, Wednesdays and Fridays at 12:00 PM'],
    [{ kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '09:00', tz: 'device' }, 'Every day at 9:00 AM'],
    [{ kind: 'daily', time: '07:00', tz: 'device' }, 'Every day at 7:00 AM'],
    [{ kind: 'daily', time: '00:00', tz: 'device' }, 'Every day at 12:00 AM'],
    [{ kind: 'every', n: 2, unit: 'hours', tz: 'device' }, 'Every 2 hours'],
    [{ kind: 'every', n: 1, unit: 'hours', tz: 'device' }, 'Every hour'],
    [{ kind: 'every', n: 15, unit: 'minutes', tz: 'device' }, 'Every 15 minutes'],
    [{ kind: 'every', n: 1, unit: 'minutes', tz: 'device' }, 'Every minute'],
    [{ kind: 'every', n: 3, unit: 'days', tz: 'device' }, 'Every 3 days'],
    [{ kind: 'every', n: 3, unit: 'days', time: '09:00', tz: 'device' }, 'Every 3 days at 9:00 AM'],
    [{ kind: 'every', n: 2, unit: 'days', time: '19:30', tz: 'device' }, 'Every 2 days at 7:30 PM'],
    [{ kind: 'every', n: 1, unit: 'days', time: '09:00', tz: 'device' }, 'Every day at 9:00 AM'],
    [{ kind: 'every', n: 3, unit: 'days', time: '09:00', tz: 'device', until: { kind: 'count', count: 5 } }, 'Every 3 days at 9:00 AM, 5 times'],
    [{ kind: 'monthly', on: { kind: 'day', day: 1 }, time: '09:00', tz: 'device' }, 'On the 1st of every month at 9:00 AM'],
    [{ kind: 'monthly', on: { kind: 'day', day: 2 }, time: '09:00', tz: 'device' }, 'On the 2nd of every month at 9:00 AM'],
    [{ kind: 'monthly', on: { kind: 'day', day: 3 }, time: '09:00', tz: 'device' }, 'On the 3rd of every month at 9:00 AM'],
    [{ kind: 'monthly', on: { kind: 'day', day: 11 }, time: '09:00', tz: 'device' }, 'On the 11th of every month at 9:00 AM'],
    [{ kind: 'monthly', on: { kind: 'day', day: 22 }, time: '09:00', tz: 'device' }, 'On the 22nd of every month at 9:00 AM'],
    [{ kind: 'monthly', on: { kind: 'last' }, time: '18:00', tz: 'device' }, 'On the last day of every month at 6:00 PM'],
    [{ kind: 'monthly', on: { kind: 'nth', nth: 1, weekday: 'mon' }, time: '09:00', tz: 'device' }, 'On the first Monday of every month at 9:00 AM'],
    [{ kind: 'monthly', on: { kind: 'nth', nth: 3, weekday: 'fri' }, time: '16:00', tz: 'device' }, 'On the third Friday of every month at 4:00 PM'],
    [{ kind: 'once', at: '2026-10-20T19:00:00.000Z', tz: LA }, 'Once on Oct 20, 2026 at 12:00 PM'],
    [{ kind: 'once', at: '2026-10-20T19:00:00.000Z', tz: 'UTC' }, 'Once on Oct 20, 2026 at 7:00 PM'],
    [{ kind: 'custom', cron: '0 8 * * 1-5', tz: 'device' }, 'Custom (0 8 * * 1-5)'],
    [
      { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device', until: { kind: 'date', date: '2026-12-31' } },
      'Weekdays at 8:00 AM until Dec 31, 2026',
    ],
    [{ kind: 'daily', time: '07:00', tz: 'device', until: { kind: 'count', count: 10 } }, 'Every day at 7:00 AM, 10 times'],
  ];

  it.each(STRINGS)('%j → %s', (spec, expected) => {
    expect(describeSpec(spec)).toBe(expected);
  });

  it('takes the hour cycle from the locale — a 24-hour locale never says AM', () => {
    const text = describeSpec({ kind: 'daily', time: '07:00', tz: 'device' }, 'en-GB');
    expect(text).toMatch(/^Every day at 0?7:00$/);
    expect(text).not.toMatch(/AM|PM/);
  });

  it('once with an unparseable instant says so instead of throwing', () => {
    expect(describeSpec({ kind: 'once', at: 'nope', tz: 'device' })).toBe('Once (invalid date)');
  });
});

describe('resolveZone', () => {
  it('resolves "device" to the Intl device zone and passes a known zone through', () => {
    expect(resolveZone('device')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(resolveZone(LA)).toBe(LA);
    expect(isValidZone(LA)).toBe(true);
    expect(isValidZone('Europe/Lodnon')).toBe(false);
  });

  it('falls back to the device zone for an unknown zone rather than throwing', () => {
    expect(resolveZone('Europe/Lodnon')).toBe(resolveZone('device'));
  });
});

describe('occurrencesBetween — zone-aware day stepping', () => {
  it('skips the DST gap: 02:30 does not exist on 2026-03-08 in Los Angeles', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '02:30', tz: LA };
    const got = occurrencesBetween(spec, at('2026-03-07T00:00:00Z'), at('2026-03-10T00:00:00Z'));
    expect(iso(got)).toEqual([
      '2026-03-07T10:30:00.000Z', // 02:30 PST
      // 2026-03-08: skipped — the clock jumps 02:00 → 03:00
      '2026-03-09T09:30:00.000Z', // 02:30 PDT
    ]);
  });

  it('fires the DST overlap ONCE, the first time: 01:30 PDT on 2026-11-01, not 01:30 PST', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '01:30', tz: LA };
    const got = occurrencesBetween(spec, at('2026-10-31T12:00:00Z'), at('2026-11-02T12:00:00Z'));
    expect(iso(got)).toEqual([
      '2026-11-01T08:30:00.000Z', // 01:30 PDT (the 09:30Z repeat is not listed)
      '2026-11-02T09:30:00.000Z', // 01:30 PST
    ]);
  });

  it('fires the overlap once in a zone east of UTC too (Europe/Berlin, 2026-10-25 02:30)', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '02:30', tz: 'Europe/Berlin' };
    const got = occurrencesBetween(spec, at('2026-10-24T12:00:00Z'), at('2026-10-25T12:00:00Z'));
    expect(iso(got)).toEqual(['2026-10-25T00:30:00.000Z']); // 02:30 CEST (UTC+2), not 01:30Z CET
  });

  it('skips the gap east of UTC (Europe/Berlin, 2026-03-29 02:30)', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '02:30', tz: 'Europe/Berlin' };
    const got = occurrencesBetween(spec, at('2026-03-28T12:00:00Z'), at('2026-03-30T12:00:00Z'));
    expect(iso(got)).toEqual(['2026-03-30T00:30:00.000Z']); // the 29th has no 02:30
  });

  it('Feb 29 fires only in a leap year: after 2027-03-01 the next is 2028-02-29', () => {
    const spec: ScheduleSpec = { kind: 'custom', cron: '0 9 29 2 *', tz: 'UTC' };
    expect(nextOccurrence(spec, at('2027-03-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T09:00:00.000Z');
  });

  it('monthly on the 31st skips 30-day months (April 31 does not exist)', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'day', day: 31 }, time: '09:00', tz: 'UTC' };
    const got = occurrencesBetween(spec, at('2026-03-30T00:00:00Z'), at('2026-06-01T00:00:00Z'));
    expect(iso(got)).toEqual(['2026-03-31T09:00:00.000Z', '2026-05-31T09:00:00.000Z']);
  });

  it('monthly last lands on 31, 28 and 31 across Jan–Mar 2026', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'last' }, time: '18:00', tz: 'UTC' };
    const got = occurrencesBetween(spec, at('2026-01-01T00:00:00Z'), at('2026-04-01T00:00:00Z'));
    expect(iso(got)).toEqual(['2026-01-31T18:00:00.000Z', '2026-02-28T18:00:00.000Z', '2026-03-31T18:00:00.000Z']);
  });

  it('monthly last in a leap February', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'last' }, time: '18:00', tz: 'UTC' };
    expect(nextOccurrence(spec, at('2028-02-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T18:00:00.000Z');
  });

  it('monthly first Monday over Oct–Dec 2026', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'nth', nth: 1, weekday: 'mon' }, time: '09:00', tz: 'UTC' };
    const got = occurrencesBetween(spec, at('2026-10-01T00:00:00Z'), at('2026-12-31T23:59:00Z'));
    expect(iso(got)).toEqual(['2026-10-05T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-12-07T09:00:00.000Z']);
  });

  it('monthly fourth Friday over Oct–Dec 2026 (never a fifth)', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'nth', nth: 4, weekday: 'fri' }, time: '16:00', tz: 'UTC' };
    const got = occurrencesBetween(spec, at('2026-10-01T00:00:00Z'), at('2026-12-31T23:59:00Z'));
    expect(iso(got)).toEqual(['2026-10-23T16:00:00.000Z', '2026-11-27T16:00:00.000Z', '2026-12-25T16:00:00.000Z']);
  });

  it('weekly Mondays and Thursdays at 17:30 in Los Angeles over one week', () => {
    const spec: ScheduleSpec = { kind: 'weekly', days: ['mon', 'thu'], time: '17:30', tz: LA };
    const got = occurrencesBetween(spec, at('2026-10-12T00:00:00Z'), at('2026-10-19T00:00:00Z'));
    expect(iso(got)).toEqual(['2026-10-13T00:30:00.000Z', '2026-10-16T00:30:00.000Z']);
  });

  it('weekly keeps the wall-clock time across the fall-back transition', () => {
    const spec: ScheduleSpec = { kind: 'weekly', days: ['sat', 'sun'], time: '08:00', tz: LA };
    const got = occurrencesBetween(spec, at('2026-10-30T00:00:00Z'), at('2026-11-03T00:00:00Z'));
    expect(iso(got)).toEqual(['2026-10-31T15:00:00.000Z', '2026-11-01T16:00:00.000Z']);
  });

  it('every 15 minutes aligns to the hour; from is exclusive and to inclusive', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 15, unit: 'minutes', tz: 'UTC' };
    const got = occurrencesBetween(spec, at('2026-10-09T15:00:00Z'), at('2026-10-09T16:00:00Z'));
    expect(iso(got)).toEqual([
      '2026-10-09T15:15:00.000Z',
      '2026-10-09T15:30:00.000Z',
      '2026-10-09T15:45:00.000Z',
      '2026-10-09T16:00:00.000Z',
    ]);
  });

  it('every 2 hours aligns to the zone midnight', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 2, unit: 'hours', tz: LA };
    expect(nextOccurrence(spec, at('2026-10-09T15:07:00Z'))?.toISOString()).toBe('2026-10-09T17:00:00.000Z'); // 10:00 PDT
  });

  it('every 3 days strides from the anchor at the anchor wall time, across DST', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 3, unit: 'days', tz: LA };
    const anchor = at('2026-10-01T15:00:00Z'); // 08:00 PDT
    const got = occurrencesBetween(spec, anchor, at('2026-11-10T00:00:00Z'), { anchor });
    expect(iso(got)).toEqual([
      '2026-10-04T15:00:00.000Z',
      '2026-10-07T15:00:00.000Z',
      '2026-10-10T15:00:00.000Z',
      '2026-10-13T15:00:00.000Z',
      '2026-10-16T15:00:00.000Z',
      '2026-10-19T15:00:00.000Z',
      '2026-10-22T15:00:00.000Z',
      '2026-10-25T15:00:00.000Z',
      '2026-10-28T15:00:00.000Z',
      '2026-10-31T15:00:00.000Z',
      '2026-11-03T16:00:00.000Z', // 08:00 PST
      '2026-11-06T16:00:00.000Z',
      '2026-11-09T16:00:00.000Z',
    ]);
  });

  it('every 3 days with a time strides from the anchor DAY and fires at that wall time, across DST', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 3, unit: 'days', time: '09:00', tz: LA };
    const anchor = at('2026-10-01T15:00:00Z'); // 08:00 PDT — the anchor's own 09:00 is still ahead
    const got = occurrencesBetween(spec, anchor, at('2026-11-10T00:00:00Z'), { anchor });
    expect(iso(got)).toEqual([
      '2026-10-01T16:00:00.000Z', // 09:00 PDT, day 0
      '2026-10-04T16:00:00.000Z',
      '2026-10-07T16:00:00.000Z',
      '2026-10-10T16:00:00.000Z',
      '2026-10-13T16:00:00.000Z',
      '2026-10-16T16:00:00.000Z',
      '2026-10-19T16:00:00.000Z',
      '2026-10-22T16:00:00.000Z',
      '2026-10-25T16:00:00.000Z',
      '2026-10-28T16:00:00.000Z',
      '2026-10-31T16:00:00.000Z',
      '2026-11-03T17:00:00.000Z', // 09:00 PST — the wall clock holds, the instant moves
      '2026-11-06T17:00:00.000Z',
      '2026-11-09T17:00:00.000Z',
    ]);
    // An anchor past 09:00 on its day: day 0 has nothing left, so the first fire is day 3 — and the
    // anchor's own wall time (13:00) is never the fire time.
    const late = at('2026-10-01T20:00:00Z'); // 13:00 PDT
    expect(nextOccurrence(spec, late, { anchor: late })?.toISOString()).toBe('2026-10-04T16:00:00.000Z');
    // A malformed time answers nothing, never throws.
    expect(nextOccurrence({ ...spec, time: '9:00' }, anchor, { anchor })).toBeUndefined();
  });

  it('every N days without an anchor strides from `from`; days before the anchor never match', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 3, unit: 'days', tz: 'UTC' };
    expect(nextOccurrence(spec, at('2026-10-01T15:00:00Z'))?.toISOString()).toBe('2026-10-04T15:00:00.000Z');
    const before = occurrencesBetween(spec, at('2026-09-01T00:00:00Z'), at('2026-09-30T00:00:00Z'), { anchor: at('2026-10-01T15:00:00Z') });
    expect(before).toEqual([]);
  });

  it('once answers exactly its instant when inside the window and nothing otherwise', () => {
    const spec: ScheduleSpec = { kind: 'once', at: '2026-10-20T19:00:00.000Z', tz: 'device' };
    expect(iso(occurrencesBetween(spec, at('2026-10-20T00:00:00Z'), at('2026-10-21T00:00:00Z')))).toEqual(['2026-10-20T19:00:00.000Z']);
    expect(occurrencesBetween(spec, at('2026-10-20T19:00:00Z'), at('2026-10-21T00:00:00Z'))).toEqual([]); // from is exclusive
    expect(iso(occurrencesBetween(spec, at('2026-10-20T00:00:00Z'), at('2026-10-20T19:00:00Z')))).toEqual(['2026-10-20T19:00:00.000Z']); // to is inclusive
    expect(nextOccurrence(spec, at('2026-10-21T00:00:00Z'))).toBeUndefined();
    expect(nextOccurrence({ kind: 'once', at: 'nope', tz: 'device' }, at('2026-10-01T00:00:00Z'))).toBeUndefined();
  });

  it('until a date: occurrences on or before the end of that day in the zone', () => {
    const spec: ScheduleSpec = { kind: 'weekly', days: ['fri'], time: '09:00', tz: 'UTC', until: { kind: 'date', date: '2026-10-23' } };
    const got = occurrencesBetween(spec, at('2026-10-09T00:00:00Z'), at('2026-12-31T00:00:00Z'));
    expect(iso(got)).toEqual(['2026-10-09T09:00:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-23T09:00:00.000Z']);
    const late: ScheduleSpec = { kind: 'daily', time: '23:30', tz: LA, until: { kind: 'date', date: '2026-10-10' } };
    // 23:30 PDT on Oct 10 is 06:30Z on Oct 11 — still "on" Oct 10 in the zone. (The window opens at
    // 01:00 PDT on the 10th so the 9th's 23:30 stays out.)
    expect(iso(occurrencesBetween(late, at('2026-10-10T08:00:00Z'), at('2026-10-20T00:00:00Z')))).toEqual(['2026-10-11T06:30:00.000Z']);
  });

  it('until a count: the N-th occurrence from the anchor is the last', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '09:00', tz: 'UTC', until: { kind: 'count', count: 3 } };
    const anchor = at('2026-10-01T00:00:00Z');
    // Oct 1, 2, 3 are the three runs; the window opens after Oct 2 09:00.
    expect(iso(occurrencesBetween(spec, at('2026-10-02T12:00:00Z'), at('2026-10-31T00:00:00Z'), { anchor }))).toEqual(['2026-10-03T09:00:00.000Z']);
    expect(nextOccurrence(spec, at('2026-10-03T12:00:00Z'), { anchor })).toBeUndefined();
    // Without an anchor the window's own first three are the three.
    expect(iso(occurrencesBetween(spec, at('2026-10-02T12:00:00Z'), at('2026-10-31T00:00:00Z')))).toEqual([
      '2026-10-03T09:00:00.000Z',
      '2026-10-04T09:00:00.000Z',
      '2026-10-05T09:00:00.000Z',
    ]);
  });

  it('until a count with `spent` given: the caller’s record replaces the calendar count from the anchor (M9)', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '09:00', tz: 'UTC', until: { kind: 'count', count: 3 } };
    const anchor = at('2026-10-01T00:00:00Z'); // the calendar would say Oct 1 and 2 are spent
    const from = at('2026-10-02T12:00:00Z');
    const to = at('2026-10-31T00:00:00Z');
    expect(iso(occurrencesBetween(spec, from, to, { anchor, spent: 0 }))).toEqual(['2026-10-03T09:00:00.000Z', '2026-10-04T09:00:00.000Z', '2026-10-05T09:00:00.000Z']);
    expect(iso(occurrencesBetween(spec, from, to, { anchor, spent: 1 }))).toEqual(['2026-10-03T09:00:00.000Z', '2026-10-04T09:00:00.000Z']);
    expect(occurrencesBetween(spec, from, to, { anchor, spent: 3 })).toEqual([]);
    expect(occurrencesBetween(spec, from, to, { anchor, spent: 7 })).toEqual([]);
    expect(nextOccurrence(spec, from, { anchor, spent: 2 })?.toISOString()).toBe('2026-10-03T09:00:00.000Z');
    expect(nextOccurrence(spec, from, { anchor, spent: 3 })).toBeUndefined();
  });

  it('until a count survives an anchor older than the 400-day bound', () => {
    const spec: ScheduleSpec = { kind: 'monthly', on: { kind: 'day', day: 15 }, time: '09:00', tz: 'UTC', until: { kind: 'count', count: 24 } };
    const anchor = at('2025-01-01T00:00:00Z'); // runs: 2025-01-15 … 2026-12-15
    const got = occurrencesBetween(spec, at('2026-11-01T00:00:00Z'), at('2027-06-01T00:00:00Z'), { anchor });
    expect(iso(got)).toEqual(['2026-11-15T09:00:00.000Z', '2026-12-15T09:00:00.000Z']);
  });

  it('bounds the search at 400 days: a never-matching cron answers undefined, a long window is truncated', () => {
    expect(nextOccurrence({ kind: 'custom', cron: '0 0 30 2 *', tz: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBeUndefined();
    const daily: ScheduleSpec = { kind: 'daily', time: '09:00', tz: 'UTC' };
    const got = occurrencesBetween(daily, at('2026-01-01T00:00:00Z'), at('2028-01-01T00:00:00Z'));
    expect(got).toHaveLength(400);
    expect(got[0]?.toISOString()).toBe('2026-01-01T09:00:00.000Z');
    expect(got[399]?.toISOString()).toBe('2027-02-04T09:00:00.000Z');
  });

  it('honours the limit and answers nothing for an empty or inverted window', () => {
    const spec: ScheduleSpec = { kind: 'every', n: 1, unit: 'minutes', tz: 'UTC' };
    expect(occurrencesBetween(spec, at('2026-01-01T00:00:00Z'), at('2026-01-02T00:00:00Z'), { limit: 5 })).toHaveLength(5);
    expect(occurrencesBetween(spec, at('2026-01-01T00:00:00Z'), at('2026-01-02T00:00:00Z'))).toHaveLength(1000);
    expect(occurrencesBetween(spec, at('2026-01-02T00:00:00Z'), at('2026-01-01T00:00:00Z'))).toEqual([]);
    expect(occurrencesBetween(spec, at('2026-01-01T00:00:00Z'), at('2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('custom cron with both day fields restricted matches either (Vixie)', () => {
    // 1st of the month OR Monday, at 09:00 — Oct 2026: 1st (Thu), 5th, 12th, 19th, 26th (Mondays)
    const spec: ScheduleSpec = { kind: 'custom', cron: '0 9 1 * 1', tz: 'UTC' };
    const got = occurrencesBetween(spec, at('2026-10-01T00:00:00Z'), at('2026-10-31T23:59:00Z'));
    expect(iso(got)).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-05T09:00:00.000Z',
      '2026-10-12T09:00:00.000Z',
      '2026-10-19T09:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ]);
  });

  it('answers nothing for an invalid custom cron or an invalid time, never throws', () => {
    expect(occurrencesBetween({ kind: 'custom', cron: '0 0 L * *', tz: 'UTC' }, at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'))).toEqual([]);
    expect(nextOccurrence({ kind: 'daily', time: '99:00', tz: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBeUndefined();
    expect(nextOccurrence({ kind: 'daily', time: '09:00', tz: 'Europe/Lodnon' }, at('2026-01-01T00:00:00Z'))).toBeDefined();
  });

  it('a weekday-8am spec over 366 days computes in under 50 ms', () => {
    const spec: ScheduleSpec = { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: LA };
    const from = at('2026-01-01T00:00:00Z');
    const to = at('2027-01-02T00:00:00Z');
    occurrencesBetween(spec, from, at('2026-01-03T00:00:00Z')); // warm the per-zone formatter cache
    const started = performance.now();
    const got = occurrencesBetween(spec, from, to);
    const elapsed = performance.now() - started;
    // 2026 starts and ends on a Thursday: 52 weeks + 1 weekday = 261; Fri 2027-01-01 08:00 PST (16:00Z) is inside too.
    expect(got).toHaveLength(262);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('the editor’s shared helpers are exported from here (M14): WEEKDAY_KEYS, WEEKEND_KEYS, sortDays, pad2, listWords', () => {
  it('spell the day sets in cron order from Monday, pad to two digits and list words with an "and"', () => {
    expect(WEEKDAY_KEYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    expect(WEEKEND_KEYS).toEqual(['sat', 'sun']);
    expect(sortDays(['fri', 'mon', 'mon', 'wed'])).toEqual(['mon', 'wed', 'fri']);
    expect(pad2(7)).toBe('07');
    expect(pad2(12)).toBe('12');
    expect(listWords([])).toBe('');
    expect(listWords(['Mondays'])).toBe('Mondays');
    expect(listWords(['Mondays', 'Fridays'])).toBe('Mondays and Fridays');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('minCronGapMs — the smallest gap a cron can fire at, from its fields (S6)', () => {
  const gap = (cron: string): number | undefined => {
    const fields = parseCron(cron);
    if (fields === undefined) throw new Error(`bad cron ${cron}`);
    return minCronGapMs(fields, at('2026-10-09T12:20:00Z'));
  };
  it('adjacent minutes within an hour, the wrap to the next listed hour, the wrap to the next matching day', () => {
    expect(gap('*/10 * * * *')).toBe(10 * 60_000);
    expect(gap('0,45,46 * * * *')).toBe(60_000); // 45 → 46
    expect(gap('0,59 0,23 * * *')).toBe(60_000); // 23:59 → 00:00
    expect(gap('30 8,9 * * *')).toBe(3_600_000); // 08:30 → 09:30
    expect(gap('0 8 * * 1-5')).toBe(86_400_000); // Mon → Tue
    expect(gap('0 8 * * 5')).toBe(7 * 86_400_000); // Fri → Fri
    expect(gap('0 8 1 * *')).toBe(28 * 86_400_000); // Feb 1 → Mar 1 is the shortest month seen
  });
  it('a cron that fires fewer than twice in 400 days has no gap', () => {
    expect(gap('0 0 31 2 *')).toBeUndefined();
    expect(gap('0 8 29 2 *')).toBeUndefined(); // a leap day: at most once inside the bound
  });
});
