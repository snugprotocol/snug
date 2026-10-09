// parseScheduleText.test.ts — TASK-20261009 C6 (ADR-0074 §4, design F10): the deterministic
// English grammar behind the plain-language box and the chat offer. One table of phrasings with
// the exact spec each must produce, a table of refusals (no time expression, contradictions,
// out-of-range numbers), the filler-word tolerance, and `scheduleOffer`'s intent gate.
//
// `now` is Friday 2026-10-09 08:00 PDT (15:00Z); every relative instant below is hand-computed
// in America/Los_Angeles (PDT = UTC-7 until 2026-11-01).
import { describe, expect, it } from 'vitest';

import { parseScheduleText, readSchedule, scheduleOffer } from '../schedule/parseScheduleText.js';
import type { ScheduleSpec, Weekday } from '../schedule/types.js';

// The spec carries the zone it was asked to compute in — `'device'` when the editor says so,
// the IANA name when a task is pinned. The table computes in a pinned zone so its instants
// are fixed; every expected spec therefore carries that zone.
const ZONE = 'America/Los_Angeles';
const NOW = new Date('2026-10-09T15:00:00Z');
const WEEKDAYS_MF = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;

const daily = (time: string): ScheduleSpec => ({ kind: 'daily', time, tz: ZONE });
const weekly = (days: Weekday[], time: string): ScheduleSpec => ({ kind: 'weekly', days, time, tz: ZONE });
const every = (n: number, unit: 'minutes' | 'hours' | 'days', time?: string): ScheduleSpec => ({
  kind: 'every',
  n,
  unit,
  ...(time === undefined ? {} : { time }),
  tz: ZONE,
});
const once = (at: string): ScheduleSpec => ({ kind: 'once', at, tz: ZONE });

describe('parseScheduleText — the grammar', () => {
  const ROWS: ReadonlyArray<readonly [string, ScheduleSpec]> = [
    // weekdays / every day / day parts
    ['every weekday at 8', weekly([...WEEKDAYS_MF], '08:00')],
    ['every weekday at 8am', weekly([...WEEKDAYS_MF], '08:00')],
    ['weekdays at 8:30', weekly([...WEEKDAYS_MF], '08:30')],
    ['on weekdays at 6:45 pm', weekly([...WEEKDAYS_MF], '18:45')],
    ['every weekday morning', weekly([...WEEKDAYS_MF], '08:00')],
    ['daily 7am', daily('07:00')],
    ['every day at 7', daily('07:00')],
    ['every day', daily('09:00')],
    ['everyday at 6:15', daily('06:15')],
    ['each day at 7pm', daily('19:00')],
    ['every morning at 7', daily('07:00')],
    ['every morning', daily('08:00')],
    ['every afternoon', daily('15:00')],
    ['every evening at 6', daily('18:00')],
    ['every night at 10', daily('22:00')],
    ['nightly at 11', daily('23:00')],
    ['every day at noon', daily('12:00')],
    ['every day at midnight', daily('00:00')],
    // named days
    ['mondays and thursdays 5:30 pm', weekly(['mon', 'thu'], '17:30')],
    ['every monday at 9', weekly(['mon'], '09:00')],
    ['mon, wed, fri at noon', weekly(['mon', 'wed', 'fri'], '12:00')],
    ['tuesdays & thursdays at 7:15am', weekly(['tue', 'thu'], '07:15')],
    ['weekends at 10', weekly(['sat', 'sun'], '10:00')],
    ['every weekend morning', weekly(['sat', 'sun'], '08:00')],
    ['every friday at 5', weekly(['fri'], '05:00')],
    ['every friday at 5pm', weekly(['fri'], '17:00')],
    ['friday evenings at 6', weekly(['fri'], '18:00')],
    ['monday to friday at 9', weekly([...WEEKDAYS_MF], '09:00')],
    ['mon-fri at 9', weekly([...WEEKDAYS_MF], '09:00')],
    ['every sunday', weekly(['sun'], '09:00')],
    ['weekly on wednesdays at 3pm', weekly(['wed'], '15:00')],
    ['every week on thursday at 4pm', weekly(['thu'], '16:00')],
    // intervals
    ['every 2 hours', every(2, 'hours')],
    ['every two hours', every(2, 'hours')],
    ['every 15 minutes', every(15, 'minutes')],
    ['every 15 mins', every(15, 'minutes')],
    ['every 3 days', every(3, 'days')],
    ['every other day', every(2, 'days')],
    ['every 2 weeks', every(14, 'days')],
    ['hourly', every(1, 'hours')],
    ['every hour', every(1, 'hours')],
    ['every 60 minutes', every(1, 'hours')],
    ['every 48 hours', every(2, 'days')],
    // an N-day stride may name its time; minutes and hours may not (see REFUSED)
    ['every 3 days at 9', every(3, 'days', '09:00')],
    ['every 2 days at 7:30 pm', every(2, 'days', '19:30')],
    ['every other day at 8', every(2, 'days', '08:00')],
    ['every 2 weeks at 9', every(14, 'days', '09:00')],
    ['every 48 hours at 9', every(2, 'days', '09:00')], // 48 hours IS 2 days, so the time rides
    ['every 3 days in the evening', every(3, 'days', '18:00')],
    // monthly
    ['first of the month', { kind: 'monthly', on: { kind: 'day', day: 1 }, time: '09:00', tz: ZONE }],
    ['on the 1st of every month at 9', { kind: 'monthly', on: { kind: 'day', day: 1 }, time: '09:00', tz: ZONE }],
    ['last day of the month at 6pm', { kind: 'monthly', on: { kind: 'last' }, time: '18:00', tz: ZONE }],
    ['first monday of every month', { kind: 'monthly', on: { kind: 'nth', nth: 1, weekday: 'mon' }, time: '09:00', tz: ZONE }],
    ['third friday of the month at 4pm', { kind: 'monthly', on: { kind: 'nth', nth: 3, weekday: 'fri' }, time: '16:00', tz: ZONE }],
    ['every month on the 15th', { kind: 'monthly', on: { kind: 'day', day: 15 }, time: '09:00', tz: ZONE }],
    ['monthly on the 28th at 8am', { kind: 'monthly', on: { kind: 'day', day: 28 }, time: '08:00', tz: ZONE }],
    ['end of the month at 5pm', { kind: 'monthly', on: { kind: 'last' }, time: '17:00', tz: ZONE }],
    // one-offs, relative to now (Fri 2026-10-09 08:00 PDT)
    ['in 20 minutes', once('2026-10-09T15:20:00.000Z')],
    ['in 2 hours', once('2026-10-09T17:00:00.000Z')],
    ['in an hour', once('2026-10-09T16:00:00.000Z')],
    ['in 3 days', once('2026-10-12T15:00:00.000Z')],
    ['in a week', once('2026-10-16T15:00:00.000Z')],
    ['tomorrow at 9', once('2026-10-10T16:00:00.000Z')],
    ['tomorrow', once('2026-10-10T16:00:00.000Z')],
    ['tomorrow morning', once('2026-10-10T15:00:00.000Z')],
    ['today at 5pm', once('2026-10-10T00:00:00.000Z')],
    ['tonight', once('2026-10-10T04:00:00.000Z')],
    ['tonight at 8', once('2026-10-10T03:00:00.000Z')],
    ['once on oct 20 at noon', once('2026-10-20T19:00:00.000Z')],
    ['on october 20 at 12', once('2026-10-20T19:00:00.000Z')],
    ['on october 20th', once('2026-10-20T16:00:00.000Z')],
    ['20 october at 6pm', once('2026-10-21T01:00:00.000Z')],
    ['on jan 5 at 9am', once('2027-01-05T17:00:00.000Z')], // next January; PST
    ['on march 1, 2027 at 9', once('2027-03-01T17:00:00.000Z')],
    ['at 5pm', once('2026-10-10T00:00:00.000Z')], // today, still ahead
    ['at 7am', once('2026-10-10T14:00:00.000Z')], // already past today → tomorrow
    ['at 8', once('2026-10-10T15:00:00.000Z')], // 08:00 is now → tomorrow
    ['midnight', once('2026-10-10T07:00:00.000Z')],
    ['noon', once('2026-10-09T19:00:00.000Z')],
    // until / count
    ['every weekday at 8 until dec 31', { kind: 'weekly', days: [...WEEKDAYS_MF], time: '08:00', tz: ZONE, until: { kind: 'date', date: '2026-12-31' } }],
    ['every day at 7 for 10 times', { kind: 'daily', time: '07:00', tz: ZONE, until: { kind: 'count', count: 10 } }],
    ['every monday at 9, 4 times', { kind: 'weekly', days: ['mon'], time: '09:00', tz: ZONE, until: { kind: 'count', count: 4 } }],
    // case, punctuation, filler
    ['EVERY WEEKDAY AT 8AM', weekly([...WEEKDAYS_MF], '08:00')],
    ['remind me every weekday at 8 to stretch, please', weekly([...WEEKDAYS_MF], '08:00')],
    ['summarise my ledger every monday at 9', weekly(['mon'], '09:00')],
    ['please run the weather app tomorrow at 9.', once('2026-10-10T16:00:00.000Z')],
    ['Remind me in 20 minutes to call Sam', once('2026-10-09T15:20:00.000Z')],
    ['check the inbox at 5 p.m. today', once('2026-10-10T00:00:00.000Z')],
    ['ping me daily at 7:00 AM', daily('07:00')],
  ];

  it.each(ROWS)('%j', (text, expected) => {
    expect(parseScheduleText(text, NOW, ZONE)).toEqual(expected);
  });

  it('returns the spec with the zone it was asked to compute in', () => {
    expect(parseScheduleText('every day at 7', NOW, 'UTC')).toEqual({ kind: 'daily', time: '07:00', tz: 'UTC' });
    expect(parseScheduleText('tomorrow at 9', NOW, 'UTC')).toEqual({ kind: 'once', at: '2026-10-10T09:00:00.000Z', tz: 'UTC' });
    expect(parseScheduleText('every day at 7', NOW, 'device')).toEqual({ kind: 'daily', time: '07:00', tz: 'device' });
  });

  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ['summarise my ledger', 'no time expression'],
    ['', 'empty'],
    ['hello there', 'no time expression'],
    ['every day on mondays', 'daily contradicts a day list'],
    ['every 2 hours on mondays', 'an interval contradicts a day list'],
    ['in 20 minutes every day', 'one-off contradicts recurring'],
    ['tomorrow every monday', 'one-off contradicts recurring'],
    ['tomorrow on oct 20', 'two dates'],
    ['at 8 and at 5', 'two times'],
    ['every 0 minutes', 'zero interval'],
    ['every 90 minutes', 'not a whole number of hours'],
    ['every 2 months', 'no months unit in the spec'],
    ['last friday of the month', 'last weekday-of-month is not in the spec'],
    ['at 25', 'hour out of range'],
    ['at 13pm', 'meridiem hour out of range'],
    ['at 5:70 pm', 'minute out of range'],
    ['on the 32nd of every month', 'day out of range'],
    ['on feb 30', 'no such date'],
    ['every 2 hours at 9', 'a clock-aligned interval carries no time'],
    ['every 15 minutes at 9am', 'a clock-aligned interval carries no time'],
    ['every 30 seconds', 'no seconds unit'],
    ['yesterday at 5', 'the past'],
    ['every weekday at 8 until yesterday', 'until needs a date'],
  ];

  it.each(REFUSED)('refuses %j (%s)', (text) => {
    expect(parseScheduleText(text, NOW, ZONE)).toBeUndefined();
  });

  it('does not read an English verb as a day abbreviation', () => {
    expect(parseScheduleText('I sat down at 5pm', NOW, ZONE)).toEqual(once('2026-10-10T00:00:00.000Z'));
    expect(parseScheduleText('out in the sun at 5pm', NOW, ZONE)).toEqual(once('2026-10-10T00:00:00.000Z'));
    expect(parseScheduleText('every sat at 5pm', NOW, ZONE)).toEqual(weekly(['sat'], '17:00'));
    expect(parseScheduleText('sat and sun at 10', NOW, ZONE)).toEqual(weekly(['sat', 'sun'], '10:00'));
  });

  it('a one-off whose explicit "today" time has passed is refused rather than moved', () => {
    expect(parseScheduleText('today at 7am', NOW, ZONE)).toBeUndefined();
  });
});

describe('scheduleOffer — the chat gate', () => {
  it('offers only when a schedule parses AND an intent word is present, with the phrase it read', () => {
    expect(scheduleOffer('remind me every weekday at 8 to stretch', NOW, ZONE)).toEqual({
      spec: weekly([...WEEKDAYS_MF], '08:00'),
      phrase: 'every weekday at 8',
    });
    expect(scheduleOffer('summarise my ledger every monday at 9', NOW, ZONE)).toEqual({
      spec: weekly(['mon'], '09:00'),
      phrase: 'every monday at 9',
    });
    expect(scheduleOffer('can you do this tomorrow at 9?', NOW, ZONE)).toEqual({
      spec: once('2026-10-10T16:00:00.000Z'),
      phrase: 'tomorrow at 9',
    });
    expect(scheduleOffer('ping me in 20 minutes', NOW, ZONE)).toEqual({
      spec: once('2026-10-09T15:20:00.000Z'),
      phrase: 'in 20 minutes',
    });
    expect(scheduleOffer('water the ferns every 3 days at 9', NOW, ZONE)).toEqual({
      spec: every(3, 'days', '09:00'),
      phrase: 'every 3 days at 9',
    });
    expect(scheduleOffer('schedule the weather report for mondays and thursdays at 5:30 pm', NOW, ZONE)?.phrase).toBe(
      'mondays and thursdays at 5:30 pm',
    );
  });

  it('stays quiet without an intent word even when the text parses', () => {
    expect(parseScheduleText('mondays and thursdays 5:30 pm', NOW, ZONE)).toBeDefined();
    expect(scheduleOffer('mondays and thursdays 5:30 pm', NOW, ZONE)).toBeUndefined();
    expect(parseScheduleText('noon', NOW, ZONE)).toBeDefined();
    expect(scheduleOffer('noon', NOW, ZONE)).toBeUndefined();
    expect(scheduleOffer('first of the month', NOW, ZONE)).toBeUndefined();
  });

  it('stays quiet when nothing parses, intent word or not', () => {
    expect(scheduleOffer('remind me about the ledger', NOW, ZONE)).toBeUndefined();
    expect(scheduleOffer('schedule something', NOW, ZONE)).toBeUndefined();
    expect(scheduleOffer('build me a todo app', NOW, ZONE)).toBeUndefined();
    expect(scheduleOffer('', NOW, ZONE)).toBeUndefined();
  });
});

describe('readSchedule — the spec WITH the words it was read from (the editor’s prefill)', () => {
  it('reads a schedule and names its words, intent word or not — the gate is the chat offer’s alone', () => {
    expect(readSchedule('mondays and thursdays 5:30 pm, water the ferns', NOW, ZONE)).toEqual({
      spec: weekly(['mon', 'thu'], '17:30'),
      phrase: 'mondays and thursdays 5:30 pm',
    });
    expect(scheduleOffer('mondays and thursdays 5:30 pm, water the ferns', NOW, ZONE)).toBeUndefined();
    expect(readSchedule('remind me to call mom at 5', NOW, ZONE)).toEqual({
      spec: once('2026-10-10T12:00:00.000Z'), // 05:00 PDT has passed → tomorrow
      phrase: 'at 5',
    });
    expect(readSchedule('every weekday at 8, summarise my ledger', NOW, ZONE)).toEqual({
      spec: weekly([...WEEKDAYS_MF], '08:00'),
      phrase: 'every weekday at 8',
    });
  });

  it('answers undefined exactly where parseScheduleText does, and the same spec elsewhere', () => {
    expect(readSchedule('water the ferns', NOW, ZONE)).toBeUndefined();
    expect(readSchedule('', NOW, ZONE)).toBeUndefined();
    expect(readSchedule('every day on mondays', NOW, ZONE)).toBeUndefined();
    for (const text of ['every weekday at 8', 'in 20 minutes', 'first monday of every month', 'ping me daily at 7:00 AM']) {
      expect(readSchedule(text, NOW, ZONE)?.spec, text).toEqual(parseScheduleText(text, NOW, ZONE));
    }
  });
});
