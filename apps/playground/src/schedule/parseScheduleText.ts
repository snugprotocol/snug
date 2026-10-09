// schedule/parseScheduleText.ts — the deterministic English grammar behind the plain-language
// box and the chat offer (ADR-0074 §4; TASK-20261009 C6; design F10). Regexes and small
// tables, no brain call, no dependency. Total: an unreadable, contradictory or out-of-range
// phrase answers `undefined`, never a guess and never a throw.
//
// HOW IT READS. The text is lowercased and normalised (punctuation out, "a.m." → "am", "each"
// → "every" …), then a fixed sequence of matchers each CONSUME their fragment — the match is
// blanked in place so a later matcher cannot read the same words twice, and the fragment's
// position is kept so `scheduleOffer` can quote the schedule it saw ("every weekday at 8").
// Words that match nothing are the task, not the schedule ("remind me … to stretch").
//
// READINGS WORTH KNOWING. A bare hour is the 24-hour clock ("at 5" is 05:00; say "5pm") unless
// a day-part word moves it ("every evening at 6" → 18:00). A recurring schedule without a time
// fires at 09:00, or at the day part's hour (morning 08:00, afternoon 15:00, evening 18:00,
// night 21:00). A bare time is a one-off: today if still ahead, else tomorrow. Relative phrases
// ("in 20 minutes", "tomorrow at 9", "on oct 20") become `once` at the absolute instant
// computed in `zone` from `now`. The spec carries `tz: zone` exactly as given, so the editor
// passes `'device'` for a device-following task and an IANA name for a pinned one.
//
// NOT IN THE GRAMMAR (answered `undefined`, by design): "every N days at <time>" (an N-day
// stride has no time field), "every 2 months", "last friday of the month", seconds, numeric
// dates ("10/20"), "half past", "quarter to", and anything in the past ("yesterday").

import { instantInZone, resolveZone, wallClockIn } from './cron.js';
import { WEEKDAYS, type MonthlyOn, type ScheduleSpec, type ScheduleUntil, type Weekday } from './types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const DEFAULT_TIME = { hour: 9, minute: 0 } as const;
const TONIGHT_TIME = { hour: 21, minute: 0 } as const;

type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';
const PART_TIMES: Record<DayPart, { hour: number; minute: number }> = {
  morning: { hour: 8, minute: 0 },
  afternoon: { hour: 15, minute: 0 },
  evening: { hour: 18, minute: 0 },
  night: { hour: 21, minute: 0 },
};

const WEEKDAY_KEYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND_KEYS: readonly Weekday[] = ['sat', 'sun'];

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
};
const NUM = String.raw`(\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
const toNumber = (word: string): number => (/^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? Number.NaN));

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH = `(${Object.keys(MONTHS).join('|')})`;

/** Day names and abbreviations (plural allowed) → key. */
const DAY_WORDS: Record<string, Weekday> = {
  mon: 'mon', monday: 'mon',
  tue: 'tue', tues: 'tue', tuesday: 'tue',
  wed: 'wed', weds: 'wed', wednesday: 'wed',
  thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu',
  fri: 'fri', friday: 'fri',
  sat: 'sat', saturday: 'sat',
  sun: 'sun', sunday: 'sun',
};
const DAY = String.raw`(?:mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday|s|rs|r)?s?`;
const ORD = String.raw`(?:st|nd|rd|th)?`;
const NTH_WORDS: Record<string, 1 | 2 | 3 | 4> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };

// ---------------------------------------------------------------------------------------------
// The working text: matchers consume fragments in place

type Fragment = { index: number; text: string };

class Reader {
  text: string;
  readonly fragments: Fragment[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** The first match of `re` (sticky/global flags not needed); consumed when found. */
  take(re: RegExp): RegExpExecArray | undefined {
    const m = re.exec(this.text);
    if (!m || m.index === undefined) return undefined;
    this.consume(m.index, m[0]);
    return m;
  }

  /** Every non-overlapping match of a global `re`, each consumed. */
  takeAll(re: RegExp): RegExpExecArray[] {
    const out: RegExpExecArray[] = [];
    for (;;) {
      const m = this.take(re);
      if (!m) break;
      out.push(m);
    }
    return out;
  }

  has(re: RegExp): boolean {
    return re.test(this.text);
  }

  private consume(index: number, matched: string): void {
    const trimmed = matched.trim();
    const lead = matched.length - matched.trimStart().length;
    this.fragments.push({ index: index + lead, text: trimmed });
    this.text = this.text.slice(0, index) + ' '.repeat(matched.length) + this.text.slice(index + matched.length);
  }

  phrase(): string {
    return [...this.fragments]
      .sort((a, b) => a.index - b.index)
      .map((f) => f.text)
      .join(' ');
  }
}

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\b([ap])\.m\.?/g, '$1m')
    .replace(/[.,;:!?()"'[\]{}]+(?=\s|$)/g, ' ')
    .replace(/(?<=\s|^)[.,;!?()"'[\]{}]+/g, ' ')
    .replace(/\beach\b/g, 'every')
    .replace(/\beveryday\b/g, 'every day')
    .replace(/\bweek\s?days\b/g, 'weekdays')
    .replace(/\bweek\s?ends\b/g, 'weekends')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------------------------
// What the matchers collect

type TimeOfDay = { hour: number; minute: number };
type RawTime = { hour: number; minute: number; meridiem?: 'am' | 'pm'; fixed?: boolean };
type DateRef = { month: number; day: number; year?: number };

type Reading = {
  interval?: { n: number; unit: 'minutes' | 'hours' | 'days' };
  daily?: boolean;
  weekly?: boolean;
  monthly?: MonthlyOn;
  days: Weekday[];
  part?: DayPart;
  times: RawTime[];
  relative?: { n: number; unit: 'minutes' | 'hours' | 'days' };
  dayRefs: ('today' | 'tomorrow' | 'tonight')[];
  dates: DateRef[];
  /** `until <date>` as read; resolved against `now` once the zone is known. */
  untilDate?: DateRef;
  untilCount?: number;
  /** "until" appeared with nothing readable after it. */
  untilMissing?: boolean;
};

const dayKey = (word: string): Weekday | undefined => DAY_WORDS[word.replace(/s$/, '')] ?? DAY_WORDS[word];

const dayRangeOf = (from: Weekday, to: Weekday): Weekday[] => {
  const a = WEEKDAYS.indexOf(from);
  const b = WEEKDAYS.indexOf(to);
  const out: Weekday[] = [];
  for (let i = a; ; i = (i + 1) % 7) {
    out.push(WEEKDAYS[i] as Weekday);
    if (i === b) break;
  }
  return out;
};

const readDateFragment = (monthWord: string | undefined, dayText: string | undefined, yearText: string | undefined): DateRef | undefined => {
  const month = monthWord === undefined ? undefined : MONTHS[monthWord];
  const day = dayText === undefined ? Number.NaN : Number(dayText);
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const year = yearText === undefined ? undefined : Number(yearText);
  return year === undefined ? { month, day } : { month, day, year };
};

const read = (r: Reader): Reading | undefined => {
  const reading: Reading = { days: [], times: [], dayRefs: [], dates: [] };

  // The past is not a schedule.
  if (r.has(/\b(yesterday|last (?:night|week|month|year)|\d+ \w+ ago)\b/)) return undefined;

  // until <date> / N times
  const until = r.take(
    new RegExp(String.raw`\buntil (?:the )?(?:${MONTH} (\d{1,2})${ORD}(?: (\d{4}))?|(\d{1,2})${ORD} (?:of )?${MONTH}(?: (\d{4}))?|(\d{4})-(\d{2})-(\d{2}))\b`),
  );
  if (until) {
    const [, m1, d1, y1, d2, m2, y2, yIso, mIso, dIso] = until;
    const ref =
      yIso !== undefined
        ? { year: Number(yIso), month: Number(mIso), day: Number(dIso) }
        : m1 !== undefined
          ? readDateFragment(m1, d1, y1)
          : readDateFragment(m2, d2, y2);
    if (!ref) return undefined;
    reading.untilDate = ref;
  } else if (r.has(/\buntil\b/)) {
    reading.untilMissing = true;
  }
  const times = r.take(new RegExp(String.raw`\b(?:for )?${NUM} times\b`));
  if (times) {
    const n = toNumber(times[1] as string);
    if (!Number.isInteger(n) || n < 1 || reading.untilDate) return undefined; // "until X, 3 times" — two ends
    reading.untilCount = n;
  }

  // Monthly shapes first: they contain weekday names and ordinals the later matchers would eat.
  const nth = r.take(new RegExp(String.raw`\b(?:on )?(?:the )?(first|second|third|fourth|last|1st|2nd|3rd|4th) (${DAY}) (?:of )?(?:the|every) month\b`));
  if (nth) {
    const word = nth[1] as string;
    const weekday = dayKey(nth[2] as string);
    const n = NTH_WORDS[word];
    if (word === 'last' || n === undefined || !weekday) return undefined;
    reading.monthly = { kind: 'nth', nth: n, weekday };
  }
  if (r.take(/\b(?:on )?(?:the )?(?:last|end) (?:day )?of (?:the|every) month\b/)) {
    if (reading.monthly) return undefined;
    reading.monthly = { kind: 'last' };
  }
  const dayOfMonth =
    r.take(new RegExp(String.raw`\b(?:on )?(?:the )?(first|\d{1,2})${ORD} (?:day )?of (?:the|every) month\b`)) ??
    r.take(new RegExp(String.raw`\b(?:every month|monthly) on (?:the )?(first|\d{1,2})${ORD}\b`));
  if (dayOfMonth) {
    if (reading.monthly) return undefined;
    const day = dayOfMonth[1] === 'first' ? 1 : Number(dayOfMonth[1]);
    if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
    reading.monthly = { kind: 'day', day };
  }
  if (r.take(/\b(?:every month|monthly)\b/)) {
    if (reading.monthly) return undefined;
    reading.monthly = { kind: 'day', day: 0 }; // 0 = the day `now` falls on, filled in later
  }

  // Calendar dates ("oct 20", "20 october 2026", "once on march 1 2027").
  for (const m of r.takeAll(new RegExp(String.raw`\b(?:once )?(?:on )?${MONTH} (\d{1,2})${ORD}(?: (\d{4}))?\b`))) {
    const ref = readDateFragment(m[1], m[2], m[3]);
    if (!ref) return undefined;
    reading.dates.push(ref);
  }
  for (const m of r.takeAll(new RegExp(String.raw`\b(?:once )?(?:on )?(\d{1,2})${ORD} (?:of )?${MONTH}(?: (\d{4}))?\b`))) {
    const ref = readDateFragment(m[2], m[1], m[3]);
    if (!ref) return undefined;
    reading.dates.push(ref);
  }

  // Relative one-offs.
  if (r.take(/\bin half an hour\b/)) reading.relative = { n: 30, unit: 'minutes' };
  const rel = r.take(new RegExp(String.raw`\bin ${NUM} (minutes?|mins?|hours?|hrs?|days?|weeks?)\b`));
  if (rel) {
    if (reading.relative) return undefined;
    const n = toNumber(rel[1] as string);
    const unit = rel[2] as string;
    if (!Number.isInteger(n) || n < 1) return undefined;
    reading.relative = unit.startsWith('w')
      ? { n: n * 7, unit: 'days' }
      : { n, unit: unit.startsWith('m') ? 'minutes' : unit.startsWith('h') ? 'hours' : 'days' };
  }
  for (const m of r.takeAll(/\b(today|tomorrow|tonight)\b/)) reading.dayRefs.push(m[1] as 'today' | 'tomorrow' | 'tonight');
  const thisPart = r.take(/\bthis (morning|afternoon|evening|night)\b/);
  if (thisPart) {
    reading.dayRefs.push('today');
    reading.part = thisPart[1] as DayPart;
  }

  // Times: meridiem forms, then "at H[:MM]", then the words.
  for (const m of r.takeAll(/\b(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/)) {
    reading.times.push({ hour: Number(m[1]), minute: m[2] === undefined ? 0 : Number(m[2]), meridiem: m[3] as 'am' | 'pm' });
  }
  for (const m of r.takeAll(/\bat (\d{1,2})(?::(\d{2}))?\b/)) {
    reading.times.push({ hour: Number(m[1]), minute: m[2] === undefined ? 0 : Number(m[2]) });
  }
  for (const m of r.takeAll(/\b(?:at )?(noon|midday|midnight)\b/)) {
    reading.times.push({ hour: m[1] === 'midnight' ? 0 : 12, minute: 0, fixed: true });
  }
  if (reading.times.length > 1) return undefined;

  // Weekdays / weekends, intervals, the adverbs, day parts.
  const block = r.take(/\b(?:every |on )?(weekdays?|weekends?)\b/);
  if (block) reading.days.push(...((block[1] as string).startsWith('weekday') ? WEEKDAY_KEYS : WEEKEND_KEYS));
  const other = r.take(/\bevery other (day|week)\b/);
  if (other) reading.interval = other[1] === 'day' ? { n: 2, unit: 'days' } : { n: 14, unit: 'days' };
  if (r.take(/\bfortnightly\b/)) {
    if (reading.interval) return undefined;
    reading.interval = { n: 14, unit: 'days' };
  }
  const every = r.take(new RegExp(String.raw`\bevery (?:${NUM} )?(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|seconds?|secs?)\b`));
  if (every) {
    const n = every[1] === undefined ? 1 : toNumber(every[1]);
    const unit = every[2] as string;
    if (!Number.isInteger(n) || n < 1) return undefined;
    if (unit.startsWith('s')) return undefined;
    if (unit.startsWith('mo')) {
      if (n !== 1 || reading.monthly) return undefined;
      reading.monthly = { kind: 'day', day: 0 };
    } else if (unit.startsWith('d') && n === 1) reading.daily = true;
    else if (unit.startsWith('w') && n === 1) reading.weekly = true;
    else {
      if (reading.interval) return undefined;
      reading.interval = unit.startsWith('w')
        ? { n: n * 7, unit: 'days' }
        : { n, unit: unit.startsWith('m') ? 'minutes' : unit.startsWith('h') ? 'hours' : 'days' };
    }
  }
  const adverb = r.take(/\b(hourly|daily|weekly|nightly)\b/);
  if (adverb) {
    const word = adverb[1];
    if (word === 'hourly') {
      if (reading.interval) return undefined;
      reading.interval = { n: 1, unit: 'hours' };
    } else if (word === 'daily') reading.daily = true;
    else if (word === 'weekly') reading.weekly = true;
    else {
      reading.daily = true;
      reading.part = 'night';
    }
  }
  const part = r.take(/\b(every )?(mornings?|afternoons?|evenings?|nights?)\b/);
  if (part) {
    reading.part = (part[2] as string).replace(/s$/, '') as DayPart;
    if (part[1] !== undefined) reading.daily = true;
  }

  // Day names: a list ("mondays and thursdays", "mon, wed, fri") or a range ("monday to friday").
  const range = r.take(new RegExp(String.raw`\b(?:every |on )?(${DAY}) ?(?:to|-|through|until) ?(${DAY})\b`));
  if (range) {
    const from = dayKey(range[1] as string);
    const to = dayKey(range[2] as string);
    if (!from || !to) return undefined;
    reading.days.push(...dayRangeOf(from, to));
  }
  // Commas were normalised away, so the separator is optional: "mon wed fri", "sat and sun".
  const list = r.take(new RegExp(String.raw`\b(every |on )?(${DAY})\b(?: ?(?:and|&|\/|or)? ?(?:and )?(${DAY})\b)*`));
  if (list) {
    const words = (list[0] as string).match(new RegExp(String.raw`\b${DAY}\b`, 'g')) ?? [];
    const keys = words.map(dayKey).filter((d): d is Weekday => d !== undefined);
    // A lone 3-letter abbreviation without "every"/"on" is more likely English ("sat", "sun").
    const lone = keys.length === 1 && list[1] === undefined && (words[0] as string).length <= 3;
    if (!lone) reading.days.push(...keys);
  }

  return reading;
};

// ---------------------------------------------------------------------------------------------
// From a reading to a spec

const resolveTime = (raw: RawTime | undefined, part: DayPart | undefined, fallback: TimeOfDay): TimeOfDay | undefined => {
  if (!raw) return part ? PART_TIMES[part] : fallback;
  if (raw.minute > 59) return undefined;
  if (raw.fixed) return { hour: raw.hour, minute: raw.minute };
  let hour = raw.hour;
  if (raw.meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (raw.meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else {
    if (hour > 23) return undefined;
    if (part !== undefined && part !== 'morning' && hour < 12) hour += 12;
  }
  return { hour, minute: raw.minute };
};

const hhmm = (t: TimeOfDay): string => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
const isoDay = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

type CalendarDay = { year: number; month: number; day: number };

/** Calendar arithmetic on a wall date — zone-independent, so DST never shifts the day. */
const addDays = (wall: CalendarDay, days: number): CalendarDay => {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** The Monday-first key of the weekday a wall date falls on. */
const weekdayOf = (wall: CalendarDay): Weekday =>
  WEEKDAYS[(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() + 6) % 7] as Weekday;

/** The first year ≥ this one where the date exists and its instant is after `now`. */
const resolveDate = (zone: string, nowMs: number, ref: DateRef, time: TimeOfDay): Date | undefined => {
  const thisYear = wallClockIn(zone, nowMs).year;
  const years = ref.year !== undefined ? [ref.year] : [thisYear, thisYear + 1, thisYear + 2, thisYear + 3, thisYear + 4];
  for (const year of years) {
    const instant = instantInZone(zone, year, ref.month, ref.day, time.hour, time.minute);
    if (instant && instant.getTime() > nowMs) return instant;
    if (ref.year !== undefined) return undefined;
  }
  return undefined;
};

/** `until <date>` → the ISO day, the year inferred as the next one where the day is still ahead. */
const resolveUntil = (reading: Reading, zone: string, nowMs: number): ScheduleUntil | undefined | null => {
  if (reading.untilCount !== undefined) return { kind: 'count', count: reading.untilCount };
  if (!reading.untilDate) return undefined;
  const endOfDay = resolveDate(zone, nowMs, reading.untilDate, { hour: 23, minute: 59 });
  if (!endOfDay) return null;
  const w = wallClockIn(zone, endOfDay);
  return { kind: 'date', date: isoDay(w.year, w.month, w.day) };
};

const toSpec = (reading: Reading, now: Date, tz: string): ScheduleSpec | undefined => {
  const zone = resolveZone(tz);
  const nowMs = now.getTime();
  if (reading.untilMissing || Number.isNaN(nowMs)) return undefined;
  const until = resolveUntil(reading, zone, nowMs);
  if (until === null) return undefined;

  const recurringKinds = [reading.interval, reading.daily, reading.monthly, reading.weekly || reading.days.length > 0].filter(Boolean).length;
  const onceKinds = [reading.relative, reading.dayRefs.length > 0, reading.dates.length > 0].filter(Boolean).length;
  if (recurringKinds > 1 || onceKinds > 1 || (recurringKinds > 0 && onceKinds > 0)) return undefined;
  if (reading.dayRefs.length > 1 || reading.dates.length > 1) return undefined;
  const rawTime = reading.times[0];
  const withUntil = (spec: ScheduleSpec): ScheduleSpec => (until ? { ...spec, until } : spec);

  if (recurringKinds === 1) {
    if (reading.interval) {
      if (rawTime) return undefined;
      let { n, unit } = reading.interval;
      if (unit === 'minutes' && n >= 60) {
        if (n % 60 !== 0) return undefined;
        n /= 60;
        unit = 'hours';
      }
      if (unit === 'hours' && n >= 24) {
        if (n % 24 !== 0) return undefined;
        n /= 24;
        unit = 'days';
      }
      if (n < 1 || n > 366) return undefined;
      return withUntil({ kind: 'every', n, unit, tz });
    }
    const time = resolveTime(rawTime, reading.part, DEFAULT_TIME);
    if (!time) return undefined;
    if (reading.daily) return withUntil({ kind: 'daily', time: hhmm(time), tz });
    if (reading.monthly) {
      const on: MonthlyOn =
        reading.monthly.kind === 'day' && reading.monthly.day === 0 ? { kind: 'day', day: wallClockIn(zone, nowMs).day } : reading.monthly;
      return withUntil({ kind: 'monthly', on, time: hhmm(time), tz });
    }
    // "every week" / "weekly" with no day named → the weekday `now` falls on.
    const days =
      reading.days.length > 0
        ? [...new Set(reading.days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b))
        : [weekdayOf(wallClockIn(zone, nowMs))];
    return withUntil({ kind: 'weekly', days, time: hhmm(time), tz });
  }

  // One-offs never take an `until`.
  if (until) return undefined;
  const today = wallClockIn(zone, nowMs);

  if (reading.relative) {
    if (rawTime || reading.part) return undefined;
    const { n, unit } = reading.relative;
    if (unit !== 'days') {
      const at = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + n * (unit === 'minutes' ? MINUTE_MS : HOUR_MS);
      return { kind: 'once', at: new Date(at).toISOString(), tz };
    }
    const target = addDays(today, n);
    const at = instantInZone(zone, target.year, target.month, target.day, today.hour, today.minute);
    return at ? { kind: 'once', at: at.toISOString(), tz } : undefined;
  }

  if (reading.dates.length === 1) {
    const time = resolveTime(rawTime, reading.part, DEFAULT_TIME);
    const at = time ? resolveDate(zone, nowMs, reading.dates[0] as DateRef, time) : undefined;
    return at ? { kind: 'once', at: at.toISOString(), tz } : undefined;
  }

  const dayRef = reading.dayRefs[0];
  if (dayRef) {
    const part = dayRef === 'tonight' ? 'night' : reading.part;
    const time = resolveTime(rawTime, part, dayRef === 'tonight' ? TONIGHT_TIME : DEFAULT_TIME);
    if (!time) return undefined;
    const target = dayRef === 'tomorrow' ? addDays(today, 1) : today;
    const at = instantInZone(zone, target.year, target.month, target.day, time.hour, time.minute);
    if (!at || at.getTime() <= nowMs) return undefined;
    return { kind: 'once', at: at.toISOString(), tz };
  }

  if (rawTime) {
    const time = resolveTime(rawTime, reading.part, DEFAULT_TIME);
    if (!time) return undefined;
    const todayAt = instantInZone(zone, today.year, today.month, today.day, time.hour, time.minute);
    if (todayAt && todayAt.getTime() > nowMs) return { kind: 'once', at: todayAt.toISOString(), tz };
    const tomorrow = addDays(today, 1);
    const at = instantInZone(zone, tomorrow.year, tomorrow.month, tomorrow.day, time.hour, time.minute);
    return at ? { kind: 'once', at: at.toISOString(), tz } : undefined;
  }

  return undefined;
};

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Reads a schedule out of English text — the whole box, or a fragment of a longer sentence —
 * as a `ScheduleSpec`, or `undefined` when there is no time expression, when two readings
 * contradict ("every day on mondays"), or when a number is out of range. Relative phrases are
 * resolved in `zone` from `now`; the spec carries `tz: zone` as given (`'device'` included).
 */
export const parseScheduleText = (text: string, now: Date, zone: 'device' | string): ScheduleSpec | undefined => {
  const normalised = normalise(text);
  if (normalised === '') return undefined;
  const reader = new Reader(normalised);
  const reading = read(reader);
  return reading ? toSpec(reading, now, zone) : undefined;
};

const INTENT = new RegExp(
  String.raw`\b(remind|every|daily|weekly|monthly|hourly|nightly|schedule|tomorrow|tonight|at \d{1,2}(?::\d{2})?(?: ?[ap]m)?|in ${NUM} (?:minutes?|mins?|hours?|hrs?|days?|weeks?)|in half an hour)\b`,
);

/**
 * The chat gate (design F10): an offer only when the message BOTH parses as a schedule AND
 * carries a word of intent — remind, every, daily/weekly/monthly/hourly, schedule, tomorrow,
 * tonight, "at <time>", "in <n> <unit>". `phrase` is the schedule as read, in the message's
 * own words, for the offer card ("Looks like a schedule: *every weekday at 8*").
 */
export const scheduleOffer = (text: string, now: Date, zone: 'device' | string): { spec: ScheduleSpec; phrase: string } | undefined => {
  const normalised = normalise(text);
  if (normalised === '' || !INTENT.test(normalised)) return undefined;
  const reader = new Reader(normalised);
  const reading = read(reader);
  const spec = reading ? toSpec(reading, now, zone) : undefined;
  return spec ? { spec, phrase: reader.phrase() } : undefined;
};
