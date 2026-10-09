// schedule/cron.ts — the hand-rolled 5-field cron and the occurrence engine (ADR-0074 §5, §7;
// TASK-20261009 C5). Pure: no dependencies, no React, no I/O. Every boundary is total — a
// parser answers `undefined`, the occurrence functions answer `[]`, nothing throws.
//
// WHO IS THE TRUTH. The engine computes from the `ScheduleSpec`, not from the cron string:
// `nextOccurrence`/`occurrencesBetween` take the spec and fall back to its cron only for
// `custom` (and for `every N minutes|hours`, whose meaning IS the aligned cron). `compileSpec`
// exists for display, for the advanced cron field and for the persisted `cron` column; where
// 5-field cron cannot say what the spec says it emits the nearest SUPERSET and the spec
// narrows it:
//   once               → `once:<ISO>` (a cron cannot fire exactly once; `specFromCron` reads it back)
//   every N days       → the daily cron at the spec's `time`, or at the anchor's wall time when
//                        it names none; the N-day stride from the anchor lives here
//                        (`opts.anchor`, the task's createdAt/startsAt)
//   monthly nth weekday → `M H * * wd` (every such weekday); the nth filter lives here
//   monthly last       → `M H 28,29,30,31 * *`; the last-day filter lives here
//
// HOW TIME IS COMPUTED (feasibility F9). Occurrences are found by stepping calendar DAYS in the
// task's IANA zone: month / day-of-month / weekday (and nth, last, the N-day stride) are tested
// on the zone-independent proleptic Gregorian date first, and only on a matching day are the
// hour/minute candidates converted to instants. A wall-clock time becomes an instant by the
// usual method: read it as UTC (the guess), measure the zone's offset a day before and a day
// after the guess with one cached `Intl.DateTimeFormat` per zone (`formatToParts`,
// `hourCycle:'h23'`), correct the guess by each offset, and keep the earliest candidate whose
// wall clock reads back as requested. A DST gap (02:30 on 2026-03-08 in Los Angeles) has no
// such candidate → skipped; a DST overlap (01:30 on 2026-11-01) has two → the FIRST (summer
// time) one. Feb 29 exists only in leap years and the 31st only in long months because the
// calendar, not a modulo, decides which days exist.
//
// BOUNDS. A search runs at most 400 days from `after`/`from` (`SEARCH_BOUND_DAYS`): a window
// longer than that is truncated, a spec that never matches answers `undefined`. `until.date`
// means occurrences on or before the END of that day in the zone; `until.count` means the
// N-th occurrence counted from `opts.anchor` is the last — the caller passes the task's
// createdAt; without an anchor the window's own first N are the N. With `opts.spent` the
// caller's own record of how many have fired replaces that calendar count (Gate-5 M9: the
// planner counts RECORDED runs, so a schedule paused through its occurrences still gets its
// remaining fires).
//
// THE FLOOR'S QUESTION (Gate-5 S6). `minCronGapMs` answers the smallest gap a cron can fire at
// from its FIELDS — adjacent minutes within an hour, the wrap to the next listed hour, the wrap
// to the next matching calendar day — rather than from a handful of sampled occurrences, which a
// minute list dense only at the hour's end could slip past.
//
// SHARED WITH THE EDITOR (Gate-5 M14): `WEEKDAY_KEYS`, `WEEKEND_KEYS`, `sortDays`, `pad2` and
// `listWords` are exported from here so `editorModel.ts` and `describeSpec` spell them once.

import { WEEKDAYS, type ScheduleSpec, type Weekday } from './types.js';

/** A parsed 5-field cron, as sets. `any*` is true only for a literal `*` (Vixie's day OR rule). */
export type CronFields = {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday; a 7 in the expression is folded to 0. */
  readonly daysOfWeek: ReadonlySet<number>;
  readonly anyDayOfMonth: boolean;
  readonly anyDayOfWeek: boolean;
};

/** A wall-clock reading in some zone; `month` is 1–12. */
export type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

/** The longest a search runs, in days from its start. */
export const SEARCH_BOUND_DAYS = 400;
const DEFAULT_LIMIT = 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// parseCron

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

type FieldRule = { readonly min: number; readonly max: number; readonly names?: readonly string[] };
const FIELD_RULES: readonly FieldRule[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DOW_NAMES },
];

const ITEM = /^(?:(\*)|([a-z]{3}|\d+)(?:-([a-z]{3}|\d+))?)(?:\/(\d+))?$/;

const valueOf = (token: string, rule: FieldRule): number | undefined => {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= rule.min && n <= rule.max ? n : undefined;
  }
  const index = rule.names?.indexOf(token) ?? -1;
  return index < 0 ? undefined : index + rule.min;
};

const parseField = (field: string, rule: FieldRule): { set: Set<number>; any: boolean } | undefined => {
  const set = new Set<number>();
  if (field === '*') {
    for (let v = rule.min; v <= rule.max; v += 1) set.add(v);
    return { set, any: true };
  }
  for (const item of field.split(',')) {
    const m = ITEM.exec(item);
    if (!m) return undefined;
    const [, star, lo, hi, stepText] = m;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let from: number | undefined;
    let to: number | undefined;
    if (star !== undefined) {
      from = rule.min;
      to = rule.max;
    } else {
      from = valueOf(lo ?? '', rule);
      // `a-b`, or `a/step` meaning a..max, or a lone `a`.
      to = hi !== undefined ? valueOf(hi, rule) : stepText !== undefined ? rule.max : from;
    }
    if (from === undefined || to === undefined || from > to) return undefined;
    for (let v = from; v <= to; v += step) set.add(v);
  }
  return { set, any: false };
};

/**
 * Parses a 5-field cron (minute hour day-of-month month day-of-week). Accepts `*`, lists,
 * ranges, steps and the 3-letter month/day names; refuses `L`, `W`, `#`, `?`, 6 or 7 fields
 * and out-of-range values. Day-of-week 7 is Sunday (0).
 */
export const parseCron = (expr: string): CronFields | undefined => {
  const fields = expr.trim().toLowerCase().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const parsed = fields.map((field, i) => parseField(field, FIELD_RULES[i] as FieldRule));
  const [minutes, hours, daysOfMonth, months, daysOfWeekRaw] = parsed;
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) return undefined;
  const daysOfWeek = new Set<number>();
  for (const d of daysOfWeekRaw.set) daysOfWeek.add(d % 7);
  return {
    minutes: minutes.set,
    hours: hours.set,
    daysOfMonth: daysOfMonth.set,
    months: months.set,
    daysOfWeek,
    anyDayOfMonth: daysOfMonth.any,
    anyDayOfWeek: daysOfWeekRaw.any,
  };
};

// ---------------------------------------------------------------------------------------------
// Small shared helpers

/** Two digits, zero-padded — `7` → `07`. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');
const sorted = (set: ReadonlySet<number>): number[] => [...set].sort((a, b) => a - b);
const isInt = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;

/** `HH:MM` on the 24-hour clock → `{hour, minute}`, or undefined. */
const parseTime = (time: string): { hour: number; minute: number } | undefined => {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
};

/** Monday-first key → cron number (mon=1 … sat=6, sun=0). */
export const cronDayOf = (day: Weekday): number => (WEEKDAYS.indexOf(day) + 1) % 7;
const weekdayOfCron = (n: number): Weekday => WEEKDAYS[(n + 6) % 7] as Weekday;
/** The distinct days in cron order from Monday. */
export const sortDays = (days: readonly Weekday[]): Weekday[] =>
  [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

// ---------------------------------------------------------------------------------------------
// Zones

const formatters = new Map<string, Intl.DateTimeFormat>();
const zoneVerdicts = new Map<string, boolean>();

const formatterFor = (zone: string): Intl.DateTimeFormat => {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(zone, fmt);
  }
  return fmt;
};

/** True when the runtime's Intl knows the zone. */
export const isValidZone = (zone: string): boolean => {
  const known = zoneVerdicts.get(zone);
  if (known !== undefined) return known;
  let ok = false;
  try {
    formatterFor(zone);
    ok = true;
  } catch {
    ok = false;
  }
  zoneVerdicts.set(zone, ok);
  return ok;
};

/**
 * `'device'` → the device zone, read at call time (never cached, so a travelling user's
 * schedule follows the device). An unknown zone also answers the device zone — the editor
 * refuses one through `isValidZone` before it is ever stored.
 */
export const resolveZone = (tz: 'device' | string): string => {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz === 'device') return device;
  return isValidZone(tz) ? tz : device;
};

/** The wall clock an instant reads in a zone (minute precision). */
export const wallClockIn = (zone: string, instant: Date | number): WallClock => {
  const wall: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of formatterFor(zone).formatToParts(typeof instant === 'number' ? new Date(instant) : instant)) {
    switch (part.type) {
      case 'year':
        wall.year = Number(part.value);
        break;
      case 'month':
        wall.month = Number(part.value);
        break;
      case 'day':
        wall.day = Number(part.value);
        break;
      case 'hour':
        wall.hour = Number(part.value) % 24;
        break;
      case 'minute':
        wall.minute = Number(part.value);
        break;
      default:
        break;
    }
  }
  return wall;
};

const wallUtc = (w: WallClock): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);

/** The zone's UTC offset (ms, east positive) in force at a minute-aligned instant. */
const offsetAt = (zone: string, ms: number): number => wallUtc(wallClockIn(zone, ms)) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;

const isCalendarDate = (year: number, month: number, day: number): boolean => {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
};

/**
 * The instant at which a zone's clock reads the given wall time — the earliest one when the
 * clock reads it twice (a DST overlap), undefined when it never does (a DST gap, or no such
 * calendar date).
 */
export const instantInZone = (zone: string, year: number, month: number, day: number, hour: number, minute: number): Date | undefined => {
  if (!isCalendarDate(year, month, day) || !isInt(hour, 0, 23) || !isInt(minute, 0, 59)) return undefined;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(zone, guess - DAY_MS);
  const after = offsetAt(zone, guess + DAY_MS);
  const candidates = before === after ? [guess - before] : [guess - before, guess - after].sort((a, b) => a - b);
  for (const ms of candidates) {
    const w = wallClockIn(zone, ms);
    if (w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute) return new Date(ms);
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// compileSpec / specFromCron

const ONCE_PREFIX = 'once:';

const stepField = (n: number, period: number): string => {
  if (n === 1) return '*';
  if (period % n === 0) return `*/${n}`;
  const list: number[] = [];
  for (let v = 0; v < period; v += n) list.push(v);
  return list.join(',');
};

/**
 * The 5-field cron for a spec (see the header for the forms that are supersets). `anchor`
 * matters only for `every N days` without a `time`, whose wall time it then supplies. Undefined
 * when the spec cannot be said at all: `every` beyond 59 minutes / 23 hours, an empty day list,
 * a bad time.
 */
export const compileSpec = (spec: ScheduleSpec, anchor: Date = new Date()): string | undefined => {
  switch (spec.kind) {
    case 'once': {
      const at = new Date(spec.at);
      return Number.isNaN(at.getTime()) ? undefined : `${ONCE_PREFIX}${at.toISOString()}`;
    }
    case 'every': {
      if (!Number.isInteger(spec.n) || spec.n < 1) return undefined;
      // Minutes and hours align to the clock; a `time` is honoured only on a day stride (the schema refuses it elsewhere).
      if (spec.unit === 'minutes') return spec.n <= 59 ? `${stepField(spec.n, 60)} * * * *` : undefined;
      if (spec.unit === 'hours') return spec.n <= 23 ? `0 ${stepField(spec.n, 24)} * * *` : undefined;
      if (spec.time !== undefined) {
        const t = parseTime(spec.time);
        return t ? `${t.minute} ${t.hour} * * *` : undefined;
      }
      if (Number.isNaN(anchor.getTime())) return undefined;
      const wall = wallClockIn(resolveZone(spec.tz), anchor);
      return `${wall.minute} ${wall.hour} * * *`;
    }
    case 'daily': {
      const t = parseTime(spec.time);
      return t ? `${t.minute} ${t.hour} * * *` : undefined;
    }
    case 'weekly': {
      const t = parseTime(spec.time);
      const days = sortDays(spec.days).map(cronDayOf).sort((a, b) => a - b);
      return t && days.length > 0 ? `${t.minute} ${t.hour} * * ${days.join(',')}` : undefined;
    }
    case 'monthly': {
      const t = parseTime(spec.time);
      if (!t) return undefined;
      const on = spec.on;
      if (on.kind === 'day') return isInt(on.day, 1, 31) ? `${t.minute} ${t.hour} ${on.day} * *` : undefined;
      if (on.kind === 'nth') return isInt(on.nth, 1, 4) ? `${t.minute} ${t.hour} * * ${cronDayOf(on.weekday)}` : undefined;
      return `${t.minute} ${t.hour} 28,29,30,31 * *`;
    }
    case 'custom':
      return parseCron(spec.cron) ? spec.cron.trim() : undefined;
    default:
      return undefined;
  }
};

const single = (set: ReadonlySet<number>): number | undefined => (set.size === 1 ? sorted(set)[0] : undefined);

/** `n` when the set is exactly {0, n, 2n, …} below `period` with 1 ≤ n < period. */
const strideOf = (set: ReadonlySet<number>, period: number): number | undefined => {
  const values = sorted(set);
  if (values.length < 2 || values[0] !== 0) return undefined;
  const n = values[1] as number;
  if (n >= period) return undefined;
  let expected = 0;
  for (const v of values) {
    if (v !== expected) return undefined;
    expected += n;
  }
  return expected >= period ? n : undefined;
};

/**
 * Reads a cron back into the preset the compiler would have emitted it from — daily, weekly,
 * monthly-day, every N minutes/hours, the `once:` form — and answers `custom` for any other
 * valid cron. The result's zone is always `'device'`; the cron never carried one.
 */
export const specFromCron = (cron: string): ScheduleSpec | undefined => {
  const text = cron.trim();
  if (text.startsWith(ONCE_PREFIX)) {
    const at = new Date(text.slice(ONCE_PREFIX.length));
    return Number.isNaN(at.getTime()) ? undefined : { kind: 'once', at: at.toISOString(), tz: 'device' };
  }
  const f = parseCron(text);
  if (!f) return undefined;
  const custom: ScheduleSpec = { kind: 'custom', cron: text, tz: 'device' };
  if (f.months.size !== 12) return custom;
  const minute = single(f.minutes);
  const hour = single(f.hours);
  if (minute !== undefined && hour !== undefined) {
    const time = `${pad2(hour)}:${pad2(minute)}`;
    if (f.anyDayOfMonth && f.anyDayOfWeek) return { kind: 'daily', time, tz: 'device' };
    if (f.anyDayOfMonth) return { kind: 'weekly', days: sortDays(sorted(f.daysOfWeek).map(weekdayOfCron)), time, tz: 'device' };
    const day = single(f.daysOfMonth);
    if (f.anyDayOfWeek && day !== undefined) return { kind: 'monthly', on: { kind: 'day', day }, time, tz: 'device' };
    return custom;
  }
  if (f.anyDayOfMonth && f.anyDayOfWeek) {
    if (f.hours.size === 24) {
      const n = strideOf(f.minutes, 60);
      if (n !== undefined) return { kind: 'every', n, unit: 'minutes', tz: 'device' };
    }
    if (minute === 0) {
      const n = strideOf(f.hours, 24);
      if (n !== undefined) return { kind: 'every', n, unit: 'hours', tz: 'device' };
    }
  }
  return custom;
};

// ---------------------------------------------------------------------------------------------
// describeSpec

const DAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
const NTH_WORDS = ['first', 'second', 'third', 'fourth'] as const;
/** The editor's *weekdays* preset — a day SET, in cron order. */
export const WEEKDAY_KEYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
/** The editor's *weekends* preset. */
export const WEEKEND_KEYS: readonly Weekday[] = ['sat', 'sun'];

const partFormatters = new Map<string, Intl.DateTimeFormat>();
const cachedFormatter = (key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat => {
  let fmt = partFormatters.get(key);
  if (!fmt) {
    fmt = make();
    partFormatters.set(key, fmt);
  }
  return fmt;
};

/** Joins `formatToParts` output, normalising ICU's narrow no-break spaces to a plain space. */
const joinParts = (parts: Intl.DateTimeFormatPart[]): string =>
  parts.map((p) => (p.type === 'literal' && /^\s+$/.test(p.value) ? ' ' : p.value)).join('');

const timeFormatter = (locale: string, zone: string): Intl.DateTimeFormat =>
  cachedFormatter(`t|${locale}|${zone}`, () => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: zone }));
const dateFormatter = (locale: string, zone: string): Intl.DateTimeFormat =>
  cachedFormatter(`d|${locale}|${zone}`, () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: zone }));

/** "8:00 AM" / "08:00" — the hour cycle is the locale's; the words are never hardcoded. */
const formatTime = (locale: string, time: string): string => {
  const t = parseTime(time);
  if (!t) return time;
  return joinParts(timeFormatter(locale, 'UTC').formatToParts(new Date(Date.UTC(2000, 0, 1, t.hour, t.minute))));
};

const formatIsoDate = (locale: string, date: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return joinParts(dateFormatter(locale, 'UTC').formatToParts(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))));
};

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
};

/** "a", "a and b", "a, b and c" — the English list the descriptions and the editor both use. */
export const listWords = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`;

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]): boolean => a.length === b.length && a.every((d, i) => d === b[i]);

/**
 * The spec in plain words: "Weekdays at 8:00 AM", "Every 2 hours", "Every 3 days at 9:00 AM",
 * "On the 1st of every month at 9:00 AM", "Once on Oct 20, 2026 at 12:00 PM", "Custom (0 8 * * 1-5)".
 * Times and dates come from `Intl.DateTimeFormat` for the locale (hour cycle included); the
 * connecting words are English, like the grammar that produces the specs.
 */
export const describeSpec = (spec: ScheduleSpec, locale = 'en-US'): string => {
  const t = (time: string): string => formatTime(locale, time);
  let text: string;
  switch (spec.kind) {
    case 'once': {
      const at = new Date(spec.at);
      if (Number.isNaN(at.getTime())) {
        text = 'Once (invalid date)';
        break;
      }
      const zone = resolveZone(spec.tz);
      text = `Once on ${joinParts(dateFormatter(locale, zone).formatToParts(at))} at ${joinParts(timeFormatter(locale, zone).formatToParts(at))}`;
      break;
    }
    case 'every': {
      const unit = spec.unit === 'minutes' ? 'minute' : spec.unit === 'hours' ? 'hour' : 'day';
      text = spec.n === 1 ? `Every ${unit}` : `Every ${spec.n} ${unit}s`;
      if (spec.unit === 'days' && spec.time !== undefined) text += ` at ${t(spec.time)}`;
      break;
    }
    case 'daily':
      text = `Every day at ${t(spec.time)}`;
      break;
    case 'weekly': {
      const days = sortDays(spec.days);
      if (days.length === 7) text = `Every day at ${t(spec.time)}`;
      else if (sameDays(days, WEEKDAY_KEYS)) text = `Weekdays at ${t(spec.time)}`;
      else if (sameDays(days, WEEKEND_KEYS)) text = `Weekends at ${t(spec.time)}`;
      else text = `${listWords(days.map((d) => `${DAY_NAMES[d]}s`))} at ${t(spec.time)}`;
      break;
    }
    case 'monthly': {
      const on = spec.on;
      const when =
        on.kind === 'day'
          ? `the ${ordinal(on.day)}`
          : on.kind === 'nth'
            ? `the ${NTH_WORDS[on.nth - 1] ?? ordinal(on.nth)} ${DAY_NAMES[on.weekday]}`
            : 'the last day';
      text = `On ${when} of every month at ${t(spec.time)}`;
      break;
    }
    case 'custom':
      text = `Custom (${spec.cron.trim()})`;
      break;
    default:
      text = 'Custom';
  }
  const until = spec.until;
  if (until?.kind === 'date') text += ` until ${formatIsoDate(locale, until.date)}`;
  else if (until?.kind === 'count') text += until.count === 1 ? ', once' : `, ${until.count} times`;
  return text;
};

// ---------------------------------------------------------------------------------------------
// Occurrences

type DayTest = (year: number, month: number, day: number, dow: number, dayUtc: number) => boolean;
type Plan = { readonly dayOk: DayTest; readonly times: readonly { hour: number; minute: number }[] };

const planFromCron = (f: CronFields): Plan => {
  const hours = sorted(f.hours);
  const minutes = sorted(f.minutes);
  const times = hours.flatMap((hour) => minutes.map((minute) => ({ hour, minute })));
  const dayOk: DayTest = (_y, month, day, dow) => {
    if (!f.months.has(month)) return false;
    if (f.anyDayOfMonth && f.anyDayOfWeek) return true;
    if (f.anyDayOfMonth) return f.daysOfWeek.has(dow);
    if (f.anyDayOfWeek) return f.daysOfMonth.has(day);
    return f.daysOfMonth.has(day) || f.daysOfWeek.has(dow);
  };
  return { dayOk, times };
};

const planFor = (spec: ScheduleSpec, zone: string, anchorMs: number): Plan | undefined => {
  switch (spec.kind) {
    case 'every': {
      if (spec.unit !== 'days') {
        const cron = compileSpec(spec);
        const f = cron === undefined ? undefined : parseCron(cron);
        return f ? planFromCron(f) : undefined;
      }
      if (!Number.isInteger(spec.n) || spec.n < 1) return undefined;
      // The stride counts days from the anchor's day; the fire time is the spec's own when it names one.
      const wall = wallClockIn(zone, anchorMs);
      const time = spec.time === undefined ? { hour: wall.hour, minute: wall.minute } : parseTime(spec.time);
      if (!time) return undefined;
      const anchorDayUtc = Date.UTC(wall.year, wall.month - 1, wall.day);
      const n = spec.n;
      return {
        dayOk: (_y, _m, _d, _dow, dayUtc) => dayUtc >= anchorDayUtc && Math.round((dayUtc - anchorDayUtc) / DAY_MS) % n === 0,
        times: [time],
      };
    }
    case 'daily': {
      const t = parseTime(spec.time);
      return t ? { dayOk: () => true, times: [t] } : undefined;
    }
    case 'weekly': {
      const t = parseTime(spec.time);
      const days = new Set(spec.days.map(cronDayOf));
      return t && days.size > 0 ? { dayOk: (_y, _m, _d, dow) => days.has(dow), times: [t] } : undefined;
    }
    case 'monthly': {
      const t = parseTime(spec.time);
      if (!t) return undefined;
      const on = spec.on;
      if (on.kind === 'day') {
        if (!isInt(on.day, 1, 31)) return undefined;
        return { dayOk: (_y, _m, day) => day === on.day, times: [t] };
      }
      if (on.kind === 'nth') {
        if (!isInt(on.nth, 1, 4)) return undefined;
        const want = cronDayOf(on.weekday);
        return { dayOk: (_y, _m, day, dow) => dow === want && Math.ceil(day / 7) === on.nth, times: [t] };
      }
      return { dayOk: (year, month, day) => day === daysInMonth(year, month), times: [t] };
    }
    case 'custom': {
      const f = parseCron(spec.cron);
      return f ? planFromCron(f) : undefined;
    }
    default:
      return undefined;
  }
};

const dayUtcOf = (zone: string, ms: number): number => {
  const w = wallClockIn(zone, ms);
  return Date.UTC(w.year, w.month - 1, w.day);
};

const parseIsoDay = (date: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return isCalendarDate(year, month, day) ? Date.UTC(year, month - 1, day) : undefined;
};

/**
 * Steps calendar days in the zone from the day `fromMs` falls on through `lastDayUtc`, testing
 * the day first and converting only a matching day's times. Stops at `limit` results, and
 * (for the open-ended counting pass) after `maxEmptyDays` consecutive days without a hit.
 */
const enumerate = (plan: Plan, zone: string, fromMs: number, toMs: number, lastDayUtc: number, limit: number, maxEmptyDays: number): Date[] => {
  const out: Date[] = [];
  if (!(toMs > fromMs) || limit < 1) return out;
  let emptyRun = 0;
  for (let dayUtc = dayUtcOf(zone, fromMs); dayUtc <= lastDayUtc; dayUtc += DAY_MS) {
    const d = new Date(dayUtc);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    let hit = false;
    if (plan.dayOk(year, month, day, d.getUTCDay(), dayUtc)) {
      for (const t of plan.times) {
        const instant = instantInZone(zone, year, month, day, t.hour, t.minute);
        if (!instant) continue;
        const ms = instant.getTime();
        if (ms <= fromMs) continue;
        if (ms > toMs) break;
        out.push(instant);
        hit = true;
        if (out.length >= limit) return out;
      }
    }
    emptyRun = hit ? 0 : emptyRun + 1;
    if (emptyRun >= maxEmptyDays) break;
  }
  return out;
};

export type OccurrenceOptions = {
  /** Most results to answer (default 1000). */
  limit?: number;
  /** The task's createdAt/startsAt: the origin of an `every N days` stride and of `until.count`. */
  anchor?: Date;
  /** How many of `until.count` have already fired, by the caller's own record — replaces the calendar count from the anchor (M9). */
  spent?: number;
};

/**
 * Every instant the spec fires in `(from, to]`, computed in its resolved zone, earliest first;
 * truncated at `limit` and at 400 days from `from`. See the header for DST, `until` and the
 * superset forms.
 */
export const occurrencesBetween = (spec: ScheduleSpec, from: Date, to: Date, opts: OccurrenceOptions = {}): Date[] => {
  const fromMs = from.getTime();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (Number.isNaN(fromMs) || Number.isNaN(to.getTime()) || limit < 1) return [];
  const toMs = Math.min(to.getTime(), fromMs + SEARCH_BOUND_DAYS * DAY_MS);
  if (!(toMs > fromMs)) return [];
  const zone = resolveZone(spec.tz);
  const untilDayUtc = spec.until?.kind === 'date' ? parseIsoDay(spec.until.date) : undefined;
  if (spec.until?.kind === 'date' && untilDayUtc === undefined) return [];

  if (spec.kind === 'once') {
    const at = new Date(spec.at);
    const ms = at.getTime();
    if (Number.isNaN(ms) || ms <= fromMs || ms > toMs) return [];
    if (untilDayUtc !== undefined && dayUtcOf(zone, ms) > untilDayUtc) return [];
    return [at];
  }

  const anchorMs = opts.anchor && !Number.isNaN(opts.anchor.getTime()) ? opts.anchor.getTime() : fromMs;
  const plan = planFor(spec, zone, anchorMs);
  if (!plan) return [];

  let remaining = limit;
  if (spec.until?.kind === 'count') {
    const count = spec.until.count;
    if (!Number.isInteger(count) || count < 1) return [];
    // Occurrences already spent: the caller's record when it has one (M9); else the calendar's
    // occurrences in (anchor, from] — an open-ended pass that stops at `count` hits or after
    // 400 empty days, so an old anchor is not cut off by the window bound.
    const spent =
      opts.spent !== undefined && Number.isFinite(opts.spent)
        ? Math.max(0, Math.floor(opts.spent))
        : anchorMs < fromMs
          ? enumerate(plan, zone, anchorMs, fromMs, dayUtcOf(zone, fromMs), count, SEARCH_BOUND_DAYS).length
          : 0;
    remaining = Math.min(limit, count - spent);
    if (remaining < 1) return [];
  }

  let lastDayUtc = dayUtcOf(zone, toMs);
  if (untilDayUtc !== undefined) lastDayUtc = Math.min(lastDayUtc, untilDayUtc);
  return enumerate(plan, zone, fromMs, toMs, lastDayUtc, remaining, Number.POSITIVE_INFINITY);
};

/** The first instant strictly after `after`, within 400 days; undefined when there is none. */
export const nextOccurrence = (spec: ScheduleSpec, after: Date, opts: { anchor?: Date; spent?: number } = {}): Date | undefined => {
  if (Number.isNaN(after.getTime())) return undefined;
  const to = new Date(after.getTime() + SEARCH_BOUND_DAYS * DAY_MS);
  return occurrencesBetween(spec, after, to, { limit: 1, anchor: opts.anchor, spent: opts.spent })[0];
};

// ---------------------------------------------------------------------------------------------
// minCronGapMs (S6)

/**
 * The smallest gap, in ms, between two firings of a cron, read from its FIELDS: the closest
 * two listed minutes within an hour, the wrap from the last minute of one listed hour to the
 * first of the next, and the wrap from the last time of one matching day to the first time of
 * the next matching day — the day gap found by stepping the calendar 400 days from `from`
 * (cheap: no instant is converted). Measured on the wall clock, so a DST shift is ignored,
 * like the nominal interval of `every N`: the floor measures intent and rate. `undefined` when
 * the cron cannot fire twice (one time a day on a day that never comes within the bound).
 */
export const minCronGapMs = (fields: CronFields, from: Date): number | undefined => {
  const minutes = sorted(fields.minutes);
  const hours = sorted(fields.hours);
  if (minutes.length === 0 || hours.length === 0 || Number.isNaN(from.getTime())) return undefined;
  const first = minutes[0] as number;
  const last = minutes[minutes.length - 1] as number;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < minutes.length; i += 1) min = Math.min(min, (minutes[i] as number) - (minutes[i - 1] as number));
  for (let i = 1; i < hours.length; i += 1) min = Math.min(min, ((hours[i] as number) - (hours[i - 1] as number)) * 60 - last + first);

  // The smallest gap in days between two matching calendar days within the search bound.
  const { dayOk } = planFromCron(fields);
  const startDayUtc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  let previousDayUtc: number | undefined;
  let minDays = Number.POSITIVE_INFINITY;
  for (let dayUtc = startDayUtc, step = 0; step <= SEARCH_BOUND_DAYS; dayUtc += DAY_MS, step += 1) {
    const d = new Date(dayUtc);
    if (!dayOk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay(), dayUtc)) continue;
    if (previousDayUtc !== undefined) minDays = Math.min(minDays, Math.round((dayUtc - previousDayUtc) / DAY_MS));
    previousDayUtc = dayUtc;
    if (minDays === 1) break;
  }
  if (Number.isFinite(minDays)) {
    const firstHour = hours[0] as number;
    const lastHour = hours[hours.length - 1] as number;
    min = Math.min(min, (minDays - 1) * 1440 + (24 - lastHour) * 60 - last + firstHour * 60 + first);
  }
  return Number.isFinite(min) ? min * MINUTE_MS : undefined;
};
