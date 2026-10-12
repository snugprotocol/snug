/**
 * TASK-20261009-scheduling-framework, C1 — the scheduler's shapes (ADR-0074 §2, §5, §6).
 *
 * A task is EXECUTABLE INTENT that lives in the user's file and roams with it: an
 * imported `.snug`, a sync pull or a hand-edited settings row can all put bytes in front
 * of these schemas, and what parses here later spends the user's brain, their network
 * budget and their attention. So every bound lives at the parse, every object is strict
 * at every level, and a credential-shaped string anywhere in a task is a REFUSAL rather
 * than a warning — a task is the one place a secret must never be able to ride.
 *
 * Internal draft — OUT of `json-schemas.ts` SOURCES (publication line guarded below).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildJsonSchemas } from '../json-schemas.js';
import { ACCESS_WRITE_MAX_ROWS } from '../access.js';
import * as protocolIndex from '../index.js';
import {
  ALERT_KINDS,
  APP_AGENT_DEADLINE_MARGIN_MS,
  APP_AGENT_MAX_ROUND_TRIPS,
  APP_AGENT_MAX_TOOL_CALLS,
  FETCH_CONNECTION_MAX_CHARS,
  SCHEDULE_HELD_REASONS,
  MISSED_POLICIES,
  PAUSED_REASONS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SCHEDULED_TASK_MAX_BYTES,
  SCHEDULE_APP_INPUT_MAX_BYTES,
  SCHEDULE_CONTEXT_DEFAULT_ROWS,
  SCHEDULE_CONTEXT_MAX_ROWS,
  SCHEDULE_CONTEXT_SQL_MAX_CHARS,
  SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS,
  SCHEDULE_CRON_MAX_CHARS,
  SCHEDULE_DAILY_CEILINGS,
  SCHEDULE_EVERY_MAX_N,
  SCHEDULE_GRACE_MS,
  SCHEDULE_HOST_KINDS,
  SCHEDULE_ID_MAX_CHARS,
  SCHEDULE_MAX_APP_VERSIONS,
  SCHEDULE_MAX_STEPS,
  SCHEDULE_MAX_TASKS,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_PROMPT_MAX_CHARS,
  SCHEDULE_PROPOSALS_PER_RUN,
  SCHEDULE_PROPOSAL_SQL_MAX_CHARS,
  SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS,
  SCHEDULE_PROPOSAL_TTL_MS,
  SCHEDULE_RUNS_MAX_BYTES,
  SCHEDULE_RUNS_MAX_ENTRIES,
  SCHEDULE_RUNS_TOTAL_MAX_BYTES,
  SCHEDULE_RUN_MAX_BYTES,
  SCHEDULE_RUN_REASON_MAX_CHARS,
  SCHEDULE_STALE_AFTER_MS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
  SCHEDULE_UNITS,
  SCHEDULE_UNTIL_MAX_COUNT,
  STEP_RESULT_STATUSES,
  TASK_PROVENANCES,
  WEEKDAYS,
  canonicalScheduleIntent,
  canonicalScheduledTask,
  findScheduleCredential,
  isIanaTimeZone,
  isReadOnlySelect,
  isSingleDmlStatement,
  parseScheduleProposal,
  parseScheduleRun,
  parseScheduledTask,
  parseSchedulerState,
  proposalHash,
  scheduleProposalItemSchema,
  scheduleProposalSchema,
  scheduleRunSchema,
  scheduleSpecSchema,
  scheduleStepSchema,
  scheduledTaskSchema,
  schedulerStateSchema,
  stepResultSchema,
} from '../schedule.js';

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
const parses = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const AT = '2026-10-09T08:00:00.000Z';

/** The OpenAI-shaped key the security suite already uses — one fixture, not a second spelling. */
const OPENAI_SHAPED_KEY = 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD';

const daily = { kind: 'daily', time: '08:00', tz: 'device' };

const notify = { kind: 'notify', title: 'Water the plants', body: 'The ferns are thirsty.' };
const appRun = { kind: 'app-run', appId: 'weather', input: { city: 'Oslo' } };
const appThink = {
  kind: 'app-think',
  appId: 'ledger',
  prompt: 'Summarise what I spent this week.',
  context: { sql: ['SELECT * FROM expenses ORDER BY at DESC'], maxRows: 20 },
};

const minimalTask = {
  id: 'task-1',
  title: 'Morning reminder',
  enabled: true,
  provenance: 'user',
  steps: [notify],
  spec: daily,
  cron: '0 8 * * *',
  missedPolicy: 'run-once',
  staleAfterMs: 86_400_000,
  alert: 'inbox',
  appVersions: {},
  createdAt: AT,
  updatedAt: AT,
};

const minimalRun = {
  id: 'run-1',
  taskId: 'task-1',
  dueAt: AT,
  trigger: 'due',
  status: 'ok',
  host: { kind: 'web' },
  steps: [],
};

const minimalState = { watermark: AT, daily: { date: '2026-10-09', ai: 0, net: 0 } };

const minimalProposal = { title: 'Morning reminder', steps: [notify], spec: daily };

/**
 * Lands the PARSED object's serialized UTF-8 size exactly on `cap` by sizing an ASCII
 * pad: the schema fills defaults, so the probe is parsed first and the pad is the
 * remainder. Returns the pad whose object sits AT the cap; one more char is over it.
 */
function padToCap(schema: z.ZodType, build: (pad: string) => unknown, cap: number): string {
  const probe = schema.safeParse(build('x'));
  if (!probe.success) throw new Error(`probe must parse: ${probe.error.message}`);
  return 'x'.repeat(cap - utf8Bytes(JSON.stringify(probe.data)) + 1);
}

// ------------------------------------------------------------------ constants

describe('constants — every bound is an exported literal, never prose-only', () => {
  it('pins the enum sets exactly (persisted literals — never retyped downstream)', () => {
    expect([...SCHEDULE_UNITS]).toEqual(['minutes', 'hours', 'days']);
    expect([...WEEKDAYS]).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect([...STEP_RESULT_STATUSES]).toEqual(['ok', 'failed', 'blocked', 'refused', 'no-handler', 'skipped']);
    expect([...TASK_PROVENANCES]).toEqual(['user', 'builder', 'chat', 'app', 'imported']);
    expect([...MISSED_POLICIES]).toEqual(['ask', 'run-once', 'skip']);
    expect([...ALERT_KINDS]).toEqual(['inbox', 'notification']);
    expect([...PAUSED_REASONS]).toEqual(['failures', 'ignored', 'app-updated']);
    expect([...RUN_TRIGGERS]).toEqual(['due', 'late', 'catch-up', 'manual']);
    expect([...RUN_STATUSES]).toEqual([
      'pending',
      'running',
      'ok',
      'failed',
      'skipped',
      'needs-you',
      'interrupted',
      'capped',
      'no-handler',
    ]);
    expect([...SCHEDULE_HOST_KINDS]).toEqual(['web', 'desktop', 'host']);
  });

  it('pins the caps, floors and ceilings (ADR-0074 §2, §6)', () => {
    expect(SCHEDULED_TASK_MAX_BYTES).toBe(16 * 1024);
    expect(SCHEDULE_RUN_MAX_BYTES).toBe(8 * 1024);
    expect(SCHEDULE_MAX_TASKS).toBe(200);
    expect(SCHEDULE_RUNS_MAX_ENTRIES).toBe(50);
    expect(SCHEDULE_RUNS_MAX_BYTES).toBe(64 * 1024);
    expect(SCHEDULE_RUNS_TOTAL_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(SCHEDULE_MIN_INTERVAL_MS).toEqual({ user: 5 * 60_000, other: 15 * 60_000 });
    expect(SCHEDULE_GRACE_MS).toBe(15 * 60_000);
    expect(SCHEDULE_PROPOSAL_TTL_MS).toBe(7 * 86_400_000);
    expect(SCHEDULE_DAILY_CEILINGS).toEqual({ ai: 100, net: 500 });
    expect(SCHEDULE_APP_INPUT_MAX_BYTES).toBe(1024);
    expect(SCHEDULE_STEP_SUMMARY_MAX_CHARS).toBe(4096);
    expect(SCHEDULE_PROPOSALS_PER_RUN).toBe(3);
    expect(SCHEDULE_MAX_STEPS).toBe(5);
    expect(SCHEDULE_TITLE_MAX_CHARS).toBe(80);
    expect(SCHEDULE_NOTIFY_BODY_MAX_CHARS).toBe(120);
    expect(SCHEDULE_PROMPT_MAX_CHARS).toBe(2048);
    expect(SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS).toBe(4);
    expect(SCHEDULE_CONTEXT_SQL_MAX_CHARS).toBe(1024);
    expect(SCHEDULE_CONTEXT_MAX_ROWS).toBe(200);
    expect(SCHEDULE_CONTEXT_DEFAULT_ROWS).toBe(50);
    expect(SCHEDULE_CRON_MAX_CHARS).toBe(120);
    expect(SCHEDULE_EVERY_MAX_N).toBe(999);
    expect(SCHEDULE_UNTIL_MAX_COUNT).toBe(1000);
    expect(SCHEDULE_MAX_APP_VERSIONS).toBe(5);
    expect(SCHEDULE_STALE_AFTER_MS).toEqual({ min: 60_000, max: 604_800_000 });
    expect(SCHEDULE_PROPOSAL_SQL_MAX_CHARS).toBe(2048);
    expect(SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS).toBe(300);
    expect(SCHEDULE_RUN_REASON_MAX_CHARS).toBe(200);
  });
});

// --------------------------------------------------------------- scheduleSpec

describe('scheduleSpecSchema — every variant parses', () => {
  it('accepts once / every / daily / weekly / monthly(day|nth|last) / custom', () => {
    const variants = [
      { kind: 'once', at: AT, tz: 'device' },
      { kind: 'every', n: 30, unit: 'minutes', tz: 'device' },
      { kind: 'every', n: 3, unit: 'days', time: '09:00', tz: 'device' },
      daily,
      { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device' },
      { kind: 'weekly', days: ['sat', 'sun'], time: '09:30', tz: 'Europe/Oslo' },
      { kind: 'monthly', on: { kind: 'day', day: 1 }, time: '08:00', tz: 'device' },
      { kind: 'monthly', on: { kind: 'nth', nth: 2, weekday: 'tue' }, time: '08:00', tz: 'device' },
      { kind: 'monthly', on: { kind: 'last' }, time: '23:59', tz: 'UTC' },
      { kind: 'custom', cron: '*/15 9-17 * * 1-5', tz: 'America/Los_Angeles' },
    ];
    for (const variant of variants) {
      expect(parses(scheduleSpecSchema, variant), JSON.stringify(variant)).toBe(true);
    }
  });

  it('accepts an optional until (date | count) on every variant', () => {
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'date', date: '2026-12-31' } })).toBe(true);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'count', count: 1 } })).toBe(true);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'count', count: SCHEDULE_UNTIL_MAX_COUNT } })).toBe(true);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'count', count: SCHEDULE_UNTIL_MAX_COUNT + 1 } })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'count', count: 0 } })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'date', date: '2026-12-31T00:00:00Z' } })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'date', date: '2026-12-31', count: 3 } })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'never' } })).toBe(false);
  });

  it('tz is "device" or an IANA zone the runtime knows — validated by Intl, not by a list', () => {
    expect(isIanaTimeZone('Europe/Oslo')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Mars/Olympus')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone('device')).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, tz: 'Mars/Olympus' })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, tz: '' })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, tz: 'Europe/Oslo' })).toBe(true);
    const { tz: _dropped, ...noTz } = daily;
    expect(parses(scheduleSpecSchema, noTz)).toBe(false);
  });

  it('bounds every.n at the cap, not before it', () => {
    const every = (n: unknown) => ({ kind: 'every', n, unit: 'hours', tz: 'device' });
    expect(parses(scheduleSpecSchema, every(SCHEDULE_EVERY_MAX_N))).toBe(true);
    expect(parses(scheduleSpecSchema, every(SCHEDULE_EVERY_MAX_N + 1))).toBe(false);
    expect(parses(scheduleSpecSchema, every(0))).toBe(false);
    expect(parses(scheduleSpecSchema, every(1.5))).toBe(false);
    expect(parses(scheduleSpecSchema, { ...every(1), unit: 'weeks' })).toBe(false);
  });

  it('every.time is optional HH:MM, honoured only when unit is "days" — minutes and hours refuse it', () => {
    const every = (unit: string, time?: string) => ({ kind: 'every', n: 3, unit, ...(time === undefined ? {} : { time }), tz: 'device' });
    expect(parses(scheduleSpecSchema, every('days', '09:00'))).toBe(true);
    expect(parses(scheduleSpecSchema, every('days'))).toBe(true); // optional — without it the stride fires at its creation wall time
    expect(parses(scheduleSpecSchema, every('hours', '09:00'))).toBe(false);
    expect(parses(scheduleSpecSchema, every('minutes', '09:00'))).toBe(false);
    for (const time of ['9:00', '24:00', '09:60', '9am', '']) {
      expect(parses(scheduleSpecSchema, every('days', time)), time).toBe(false);
    }
    // The refusal names the seat, so an editor can point at it rather than at the whole spec.
    const refused = scheduleSpecSchema.safeParse(every('hours', '09:00'));
    expect(refused.success).toBe(false);
    expect(refused.success ? [] : refused.error.issues.map((issue) => issue.path.join('.'))).toContain('time');
  });

  it('weekly.days is a non-empty, unique set of weekdays', () => {
    const weekly = (days: unknown) => ({ kind: 'weekly', days, time: '08:00', tz: 'device' });
    expect(parses(scheduleSpecSchema, weekly([]))).toBe(false);
    expect(parses(scheduleSpecSchema, weekly(['mon', 'mon']))).toBe(false);
    expect(parses(scheduleSpecSchema, weekly(['monday']))).toBe(false);
    expect(parses(scheduleSpecSchema, weekly([...WEEKDAYS]))).toBe(true);
  });

  it('monthly.on bounds day 1..31 and nth 1..4', () => {
    const monthly = (on: unknown) => ({ kind: 'monthly', on, time: '08:00', tz: 'device' });
    expect(parses(scheduleSpecSchema, monthly({ kind: 'day', day: 31 }))).toBe(true);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'day', day: 32 }))).toBe(false);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'day', day: 0 }))).toBe(false);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'nth', nth: 4, weekday: 'fri' }))).toBe(true);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'nth', nth: 5, weekday: 'fri' }))).toBe(false);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'nth', nth: 0, weekday: 'fri' }))).toBe(false);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'last', day: 1 }))).toBe(false);
    expect(parses(scheduleSpecSchema, monthly({ kind: 'first' }))).toBe(false);
  });

  it('time is HH:MM, 24-hour, zero-padded', () => {
    for (const time of ['00:00', '08:00', '23:59']) {
      expect(parses(scheduleSpecSchema, { ...daily, time }), time).toBe(true);
    }
    for (const time of ['24:00', '8:00', '08:60', '08:00:00', '8 am', '']) {
      expect(parses(scheduleSpecSchema, { ...daily, time }), time).toBe(false);
    }
  });

  it('once.at is an ISO instant', () => {
    expect(parses(scheduleSpecSchema, { kind: 'once', at: '2026-10-09', tz: 'device' })).toBe(false);
    expect(parses(scheduleSpecSchema, { kind: 'once', at: 'tomorrow', tz: 'device' })).toBe(false);
  });

  it('custom.cron is capped at the cap, not before it', () => {
    const custom = (cron: string) => ({ kind: 'custom', cron, tz: 'device' });
    expect(parses(scheduleSpecSchema, custom('*'.repeat(SCHEDULE_CRON_MAX_CHARS)))).toBe(true);
    expect(parses(scheduleSpecSchema, custom('*'.repeat(SCHEDULE_CRON_MAX_CHARS + 1)))).toBe(false);
    expect(parses(scheduleSpecSchema, custom(''))).toBe(false);
  });

  it('is STRICT at every level — an unknown key or kind is a rejection', () => {
    expect(parses(scheduleSpecSchema, { ...daily, jitter: 5 })).toBe(false);
    expect(parses(scheduleSpecSchema, { kind: 'hourly', tz: 'device' })).toBe(false);
    expect(parses(scheduleSpecSchema, { ...daily, until: { kind: 'count', count: 1, extra: true } })).toBe(false);
    expect(parses(scheduleSpecSchema, { kind: 'monthly', on: { kind: 'last', extra: 1 }, time: '08:00', tz: 'device' })).toBe(false);
    // A daily spec cannot smuggle another variant's seat.
    expect(parses(scheduleSpecSchema, { ...daily, cron: '* * * * *' })).toBe(false);
  });
});

// --------------------------------------------------------------- scheduleStep

describe('scheduleStepSchema — notify | app-run | app-think', () => {
  it('accepts every step kind', () => {
    expect(parses(scheduleStepSchema, notify)).toBe(true);
    expect(parses(scheduleStepSchema, appRun)).toBe(true);
    expect(parses(scheduleStepSchema, { kind: 'app-run', appId: 'weather' })).toBe(true);
    expect(parses(scheduleStepSchema, appThink)).toBe(true);
  });

  it('notify bounds title and body at their caps', () => {
    expect(parses(scheduleStepSchema, { ...notify, title: 'x'.repeat(SCHEDULE_TITLE_MAX_CHARS) })).toBe(true);
    expect(parses(scheduleStepSchema, { ...notify, title: 'x'.repeat(SCHEDULE_TITLE_MAX_CHARS + 1) })).toBe(false);
    expect(parses(scheduleStepSchema, { ...notify, title: '' })).toBe(false);
    expect(parses(scheduleStepSchema, { ...notify, body: 'x'.repeat(SCHEDULE_NOTIFY_BODY_MAX_CHARS) })).toBe(true);
    expect(parses(scheduleStepSchema, { ...notify, body: 'x'.repeat(SCHEDULE_NOTIFY_BODY_MAX_CHARS + 1) })).toBe(false);
  });

  it('app-run.input is any JSON value whose serialized size is at most 1 KiB — bytes, not chars', () => {
    const run = (input: unknown) => ({ kind: 'app-run', appId: 'weather', input });
    // '"' + 1022 + '"' = 1024 bytes.
    expect(parses(scheduleStepSchema, run('x'.repeat(SCHEDULE_APP_INPUT_MAX_BYTES - 2)))).toBe(true);
    expect(parses(scheduleStepSchema, run('x'.repeat(SCHEDULE_APP_INPUT_MAX_BYTES - 1)))).toBe(false);
    // 341 three-byte chars = 1023 bytes + two quotes = 1025: over by BYTES while 343 chars under by length.
    expect(parses(scheduleStepSchema, run('€'.repeat(341)))).toBe(false);
    expect(parses(scheduleStepSchema, run({ nested: [1, 'two', null, { three: true }] }))).toBe(true);
    expect(parses(scheduleStepSchema, run(null))).toBe(true);
    expect(parses(scheduleStepSchema, run(() => 1))).toBe(false);
  });

  it('app-think bounds prompt, sql count, sql length and maxRows at their caps; maxRows defaults', () => {
    const think = (patch: Record<string, unknown>) => ({ ...appThink, ...patch });
    expect(parses(scheduleStepSchema, think({ prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX_CHARS) }))).toBe(true);
    expect(parses(scheduleStepSchema, think({ prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX_CHARS + 1) }))).toBe(false);
    expect(parses(scheduleStepSchema, think({ prompt: '' }))).toBe(false);

    const sqlOf = (count: number) => Array.from({ length: count }, (_, i) => `SELECT ${i}`);
    expect(parses(scheduleStepSchema, think({ context: { sql: sqlOf(SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS) } }))).toBe(true);
    expect(parses(scheduleStepSchema, think({ context: { sql: sqlOf(SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS + 1) } }))).toBe(false);

    const longSelect = (chars: number) => `SELECT '${'x'.repeat(chars - "SELECT ''".length)}'`;
    expect(parses(scheduleStepSchema, think({ context: { sql: [longSelect(SCHEDULE_CONTEXT_SQL_MAX_CHARS)] } }))).toBe(true);
    expect(parses(scheduleStepSchema, think({ context: { sql: [longSelect(SCHEDULE_CONTEXT_SQL_MAX_CHARS + 1)] } }))).toBe(false);

    expect(parses(scheduleStepSchema, think({ context: { maxRows: SCHEDULE_CONTEXT_MAX_ROWS } }))).toBe(true);
    expect(parses(scheduleStepSchema, think({ context: { maxRows: SCHEDULE_CONTEXT_MAX_ROWS + 1 } }))).toBe(false);
    expect(parses(scheduleStepSchema, think({ context: { maxRows: 0 } }))).toBe(false);

    const parsed = scheduleStepSchema.parse(think({ context: {} }));
    expect(parsed.kind === 'app-think' && parsed.context.maxRows).toBe(SCHEDULE_CONTEXT_DEFAULT_ROWS);
  });

  it('app-think.context.sql entries are each one read-only SELECT', () => {
    expect(isReadOnlySelect('SELECT * FROM expenses')).toBe(true);
    expect(isReadOnlySelect('  select count(*) from expenses;')).toBe(true);
    expect(isReadOnlySelect('WITH recent AS (SELECT * FROM expenses) SELECT * FROM recent')).toBe(true);
    expect(isReadOnlySelect('DELETE FROM expenses')).toBe(false);
    expect(isReadOnlySelect('SELECT 1; DELETE FROM expenses')).toBe(false);
    expect(isReadOnlySelect('SELECT 1; SELECT 2')).toBe(false);
    expect(isReadOnlySelect("ATTACH DATABASE 'x' AS y")).toBe(false);
    expect(isReadOnlySelect("SELECT * FROM t WHERE 1 UNION SELECT 1 FROM (ATTACH 'x' AS y)")).toBe(false);
    expect(isReadOnlySelect('PRAGMA writable_schema = 1')).toBe(false);
    expect(isReadOnlySelect("SELECT 1 FROM t WHERE 1; PRAGMA writable_schema = 1")).toBe(false);
    // The rule is on the PRAGMA token: `pragma_table_info()` is a read-only table-valued
    // function (a schema READ), and a word boundary keeps it out of the refusal on purpose.
    expect(isReadOnlySelect("SELECT * FROM pragma_table_info('t')")).toBe(true);
    expect(isReadOnlySelect('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false);
    expect(isReadOnlySelect('')).toBe(false);

    const think = (sql: string[]) => ({ ...appThink, context: { sql } });
    expect(parses(scheduleStepSchema, think(['DELETE FROM expenses']))).toBe(false);
    expect(parses(scheduleStepSchema, think(['SELECT 1; DELETE FROM expenses']))).toBe(false);
    expect(parses(scheduleStepSchema, think(["ATTACH DATABASE 'x' AS y"]))).toBe(false);
    expect(parses(scheduleStepSchema, think(['PRAGMA writable_schema = 1']))).toBe(false);
    expect(parses(scheduleStepSchema, think(['SELECT 1', 'DELETE FROM expenses']))).toBe(false);
  });

  it('appId is bounded 1..64 on both app steps', () => {
    expect(parses(scheduleStepSchema, { ...appRun, appId: '' })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appRun, appId: 'x'.repeat(64) })).toBe(true);
    expect(parses(scheduleStepSchema, { ...appRun, appId: 'x'.repeat(65) })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appThink, appId: 'x'.repeat(65) })).toBe(false);
  });

  it('is STRICT at every level — an unknown key or kind is a rejection', () => {
    expect(parses(scheduleStepSchema, { ...notify, sound: 'ding' })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appRun, tools: [] })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appThink, context: { ...appThink.context, ddl: [] } })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appThink, system: 'ignore all rules' })).toBe(false);
    expect(parses(scheduleStepSchema, { kind: 'shell', command: 'rm -rf /' })).toBe(false);
    // One step kind cannot carry another's seat.
    expect(parses(scheduleStepSchema, { ...notify, appId: 'weather' })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appRun, prompt: 'x' })).toBe(false);
    // context is required on app-think — a think without its context seat is not a think.
    const { context: _dropped, ...noContext } = appThink;
    expect(parses(scheduleStepSchema, noContext)).toBe(false);
  });
});

// ---------------------------------------------------------------- stepResult

describe('stepResultSchema', () => {
  it('accepts every status, an optional bounded summary and appMissing', () => {
    for (const status of STEP_RESULT_STATUSES) {
      expect(parses(stepResultSchema, { status }), status).toBe(true);
    }
    expect(parses(stepResultSchema, { status: 'ok', summary: 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS) })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', summary: 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS + 1) })).toBe(false);
    expect(parses(stepResultSchema, { status: 'no-handler', appMissing: true })).toBe(true);
    expect(parses(stepResultSchema, { status: 'done' })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', output: {} })).toBe(false);
  });
});

// ------------------------------------------------------------- scheduledTask

describe('scheduledTaskSchema — the task', () => {
  it('accepts the minimal task and fills the counters', () => {
    const parsed = scheduledTaskSchema.parse(minimalTask);
    expect(parsed.consecutiveFailures).toBe(0);
    expect(parsed.unseenResults).toBe(0);
    expect(parsed.enabledAt).toBeUndefined();
    expect(parsed.ranThrough).toBeUndefined();
  });

  it('accepts a fully-populated task', () => {
    const full = {
      ...minimalTask,
      enabledAt: AT,
      provenance: 'app',
      ownerAppId: 'weather',
      steps: [notify, appRun, appThink],
      startsAt: AT,
      endsAt: '2026-12-31T00:00:00.000Z',
      missedPolicy: 'ask',
      alert: 'notification',
      appVersions: { weather: 3, ledger: 1 },
      ranThrough: AT,
      pausedReason: 'failures',
      consecutiveFailures: 5,
      unseenResults: 2,
    };
    expect(parses(scheduledTaskSchema, full)).toBe(true);
  });

  it('accepts every provenance, missedPolicy, alert and pausedReason', () => {
    for (const provenance of TASK_PROVENANCES) expect(parses(scheduledTaskSchema, { ...minimalTask, provenance }), provenance).toBe(true);
    for (const missedPolicy of MISSED_POLICIES) expect(parses(scheduledTaskSchema, { ...minimalTask, missedPolicy }), missedPolicy).toBe(true);
    for (const alert of ALERT_KINDS) expect(parses(scheduledTaskSchema, { ...minimalTask, alert }), alert).toBe(true);
    for (const pausedReason of PAUSED_REASONS) expect(parses(scheduledTaskSchema, { ...minimalTask, pausedReason }), pausedReason).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, provenance: 'system' })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, missedPolicy: 'always' })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, alert: 'email' })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, pausedReason: 'user' })).toBe(false);
  });

  it('bounds id, title, cron, steps, staleAfterMs, appVersions and the counters at their caps', () => {
    expect(parses(scheduledTaskSchema, { ...minimalTask, id: 'x'.repeat(64) })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, id: 'x'.repeat(65) })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, id: '' })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, title: 'x'.repeat(SCHEDULE_TITLE_MAX_CHARS) })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, title: 'x'.repeat(SCHEDULE_TITLE_MAX_CHARS + 1) })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, title: '' })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, cron: '*'.repeat(SCHEDULE_CRON_MAX_CHARS) })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, cron: '*'.repeat(SCHEDULE_CRON_MAX_CHARS + 1) })).toBe(false);

    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: Array.from({ length: SCHEDULE_MAX_STEPS }, () => notify) })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: Array.from({ length: SCHEDULE_MAX_STEPS + 1 }, () => notify) })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [] })).toBe(false);

    expect(parses(scheduledTaskSchema, { ...minimalTask, staleAfterMs: SCHEDULE_STALE_AFTER_MS.min })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, staleAfterMs: SCHEDULE_STALE_AFTER_MS.min - 1 })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, staleAfterMs: SCHEDULE_STALE_AFTER_MS.max })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, staleAfterMs: SCHEDULE_STALE_AFTER_MS.max + 1 })).toBe(false);

    const versions = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`app${i}`, 1]));
    expect(parses(scheduledTaskSchema, { ...minimalTask, appVersions: versions(SCHEDULE_MAX_APP_VERSIONS) })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, appVersions: versions(SCHEDULE_MAX_APP_VERSIONS + 1) })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, appVersions: { weather: 0 } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, appVersions: { weather: 1.5 } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, appVersions: { '': 1 } })).toBe(false);

    expect(parses(scheduledTaskSchema, { ...minimalTask, consecutiveFailures: -1 })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, unseenResults: -1 })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, ownerAppId: 'x'.repeat(65) })).toBe(false);
  });

  it('requires ISO instants on every timestamp seat', () => {
    for (const seat of ['enabledAt', 'startsAt', 'endsAt', 'ranThrough', 'createdAt', 'updatedAt']) {
      expect(parses(scheduledTaskSchema, { ...minimalTask, [seat]: '2026-10-09' }), seat).toBe(false);
      expect(parses(scheduledTaskSchema, { ...minimalTask, [seat]: 1760000000000 }), seat).toBe(false);
    }
  });

  it('rejects a task that parses seat-by-seat but exceeds the whole-object byte cap — at cap+1, not at the cap', () => {
    const longSelect = `SELECT '${'s'.repeat(SCHEDULE_CONTEXT_SQL_MAX_CHARS - "SELECT ''".length)}'`;
    const fatThink = (prompt: string) => ({
      ...appThink,
      prompt,
      context: { sql: Array.from({ length: SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS }, () => longSelect), maxRows: 200 },
    });
    const build = (pad: string) => ({
      ...minimalTask,
      steps: [fatThink('p'.repeat(1000)), fatThink('p'.repeat(1000)), fatThink(pad)],
    });
    const pad = padToCap(scheduledTaskSchema, build, SCHEDULED_TASK_MAX_BYTES);
    expect(pad.length).toBeLessThanOrEqual(SCHEDULE_PROMPT_MAX_CHARS);

    const atCap = scheduledTaskSchema.safeParse(build(pad));
    expect(atCap.success).toBe(true);
    if (atCap.success) expect(utf8Bytes(JSON.stringify(atCap.data))).toBe(SCHEDULED_TASK_MAX_BYTES);
    expect(parses(scheduledTaskSchema, build(`${pad}x`))).toBe(false);
  });

  it('is STRICT at every level — an unknown key is a rejection, never a passthrough', () => {
    expect(parses(scheduledTaskSchema, { ...minimalTask, leaderHost: 'web' })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, approved: true })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, spec: { ...daily, extra: 1 } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...notify, extra: 1 }] })).toBe(false);
  });
});

describe('scheduledTaskSchema — a credential anywhere in a task is a parse REFUSAL (ADR-0074 §6)', () => {
  it('refuses an OpenAI-shaped key in a prompt', () => {
    const task = { ...minimalTask, steps: [{ ...appThink, prompt: `Use ${OPENAI_SHAPED_KEY} to fetch.` }] };
    expect(parses(scheduledTaskSchema, task)).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...appThink, prompt: OPENAI_SHAPED_KEY }] })).toBe(false);
    expect(findScheduleCredential(task)?.reason).toBe('known-key-prefix');
  });

  it('refuses a URL carrying userinfo, whole or embedded in prose', () => {
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...notify, body: 'https://user:pass@example.com/' }] })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...notify, body: 'Open https://user:pass@example.com/x today' }] })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...notify, body: 'https://user@example.com/' }] })).toBe(false);
    expect(findScheduleCredential({ a: 'see https://u:p@h/x' })?.reason).toBe('url-userinfo');
    // An ordinary URL, and an @ past the authority, are fine.
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...notify, body: 'Open https://example.com/x?y=1 today' }] })).toBe(true);
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...notify, body: 'https://example.com/@handle' }] })).toBe(true);
  });

  it('refuses an authorization-like key inside app-run.input, case-insensitively', () => {
    const run = (input: unknown) => ({ ...minimalTask, steps: [{ kind: 'app-run', appId: 'weather', input }] });
    expect(parses(scheduledTaskSchema, run({ authorization: 'rook' }))).toBe(false);
    expect(parses(scheduledTaskSchema, run({ headers: { Authorization: 'x' } }))).toBe(false);
    expect(parses(scheduledTaskSchema, run({ 'X-Api-Key': 'x' }))).toBe(false);
    expect(parses(scheduledTaskSchema, run({ cookie: 'a=b' }))).toBe(false);
    expect(parses(scheduledTaskSchema, run([{ COOKIE: 'a=b' }]))).toBe(false);
    expect(findScheduleCredential({ input: { Authorization: 'x' } })).toEqual({ path: 'input.Authorization', reason: 'auth-like-key' });
    // The existing scanner's WARNINGS never refuse: a chess app's `token: 'rook'` still rides.
    expect(parses(scheduledTaskSchema, run({ token: 'rook', square: 'e4' }))).toBe(true);
    expect(findScheduleCredential(run({ token: 'rook' }))).toBeUndefined();
  });

  it('refuses a Bearer value and a JWT shape, wherever they sit', () => {
    expect(parses(scheduledTaskSchema, { ...minimalTask, title: 'Bearer abcdef123456' })).toBe(false);
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ kind: 'app-run', appId: 'w', input: { blob: jwt } }] })).toBe(false);
  });
});

// --------------------------------------------------------------- scheduleRun

describe('scheduleRunSchema — one execution', () => {
  it('accepts the minimal run and fills collapsedCount and calls', () => {
    const parsed = scheduleRunSchema.parse(minimalRun);
    expect(parsed.collapsedCount).toBe(1);
    expect(parsed.calls).toEqual({ ai: 0, net: 0 });
    expect(parsed.proposals).toBeUndefined();
  });

  it('accepts a fully-populated run', () => {
    const full = {
      ...minimalRun,
      trigger: 'catch-up',
      collapsedCount: 48,
      status: 'needs-you',
      startedAt: AT,
      finishedAt: AT,
      host: { kind: 'host', binding: 'claude-code' },
      steps: [{ status: 'ok', summary: 'Spent 120 on food.' }, { status: 'no-handler', appMissing: true }],
      proposals: {
        items: [{ appId: 'notes', sql: "INSERT INTO notes (body) VALUES ('hi')", summary: 'Adds a note', counts: { changes: 1 } }],
        expiresAt: '2026-10-16T08:00:00.000Z',
      },
      calls: { ai: 1, net: 0 },
      seenAt: AT,
      reason: 'stale',
    };
    expect(parses(scheduleRunSchema, full)).toBe(true);
  });

  it('accepts every trigger, status and host kind', () => {
    for (const trigger of RUN_TRIGGERS) expect(parses(scheduleRunSchema, { ...minimalRun, trigger }), trigger).toBe(true);
    for (const status of RUN_STATUSES) expect(parses(scheduleRunSchema, { ...minimalRun, status }), status).toBe(true);
    for (const kind of SCHEDULE_HOST_KINDS) expect(parses(scheduleRunSchema, { ...minimalRun, host: { kind } }), kind).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, trigger: 'cron' })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, status: 'done' })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, host: { kind: 'cloud' } })).toBe(false);
  });

  it('bounds steps, proposals, collapsedCount, calls and reason at their caps', () => {
    const results = (count: number) => Array.from({ length: count }, () => ({ status: 'ok' }));
    expect(parses(scheduleRunSchema, { ...minimalRun, steps: results(SCHEDULE_MAX_STEPS) })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, steps: results(SCHEDULE_MAX_STEPS + 1) })).toBe(false);

    const item = { appId: 'notes', sql: 'DELETE FROM notes WHERE id = 1' };
    const proposals = (count: number) => ({ items: Array.from({ length: count }, () => item), expiresAt: AT });
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: proposals(SCHEDULE_PROPOSALS_PER_RUN) })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: proposals(SCHEDULE_PROPOSALS_PER_RUN + 1) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: { items: [item] } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: { items: [item], expiresAt: 'next week' } })).toBe(false);

    expect(parses(scheduleRunSchema, { ...minimalRun, collapsedCount: 0 })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, calls: { ai: -1, net: 0 } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, calls: { ai: 0 } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, reason: 'x'.repeat(SCHEDULE_RUN_REASON_MAX_CHARS) })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, reason: 'x'.repeat(SCHEDULE_RUN_REASON_MAX_CHARS + 1) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, id: 'x'.repeat(65) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, taskId: '' })).toBe(false);
  });

  it('rejects a run that parses seat-by-seat but exceeds the whole-object byte cap — at cap+1, not at the cap', () => {
    const build = (pad: string) => ({
      ...minimalRun,
      steps: [{ status: 'ok', summary: 's'.repeat(3000) }, { status: 'ok', summary: 's'.repeat(3000) }, { status: 'ok', summary: pad }],
    });
    const pad = padToCap(scheduleRunSchema, build, SCHEDULE_RUN_MAX_BYTES);
    expect(pad.length).toBeLessThanOrEqual(SCHEDULE_STEP_SUMMARY_MAX_CHARS);

    const atCap = scheduleRunSchema.safeParse(build(pad));
    expect(atCap.success).toBe(true);
    if (atCap.success) expect(utf8Bytes(JSON.stringify(atCap.data))).toBe(SCHEDULE_RUN_MAX_BYTES);
    expect(parses(scheduleRunSchema, build(`${pad}x`))).toBe(false);
  });

  it('is STRICT at every level — an unknown key is a rejection', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, approved: true })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, host: { kind: 'web', origin: 'x' } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, calls: { ai: 0, net: 0, disk: 0 } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, steps: [{ status: 'ok', extra: 1 }] })).toBe(false);
    const item = { appId: 'notes', sql: 'DELETE FROM notes WHERE id = 1' };
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: { items: [item], expiresAt: AT, approved: true } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: { items: [{ ...item, approved: true }], expiresAt: AT } })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, proposals: { items: [{ ...item, counts: { changes: 1, rows: [] } }], expiresAt: AT } })).toBe(false);
  });

  it('refuses a credential in a result — a reply never carries one into the file', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, steps: [{ status: 'ok', summary: `Key: ${OPENAI_SHAPED_KEY}` }] })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, reason: 'https://u:p@h/x' })).toBe(false);
  });
});

describe('scheduleProposalItemSchema — a pending data change is DML, one statement, for ONE named app', () => {
  it('accepts INSERT / UPDATE / DELETE with an optional summary and dry-run counts', () => {
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: "INSERT INTO notes (body) VALUES ('hi')" })).toBe(true);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'UPDATE notes SET body = 1 WHERE id = 2;' })).toBe(true);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DELETE FROM notes WHERE id = 1', summary: 'Removes one', counts: { changes: 1 } })).toBe(true);
  });

  it('carries the app it was proposed FOR (S4): a run pools items from several steps, so each names its own app; absent or oversize is a refusal', () => {
    expect(parses(scheduleProposalItemSchema, { sql: 'DELETE FROM notes WHERE id = 1' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: '', sql: 'DELETE FROM notes WHERE id = 1' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'x'.repeat(SCHEDULE_ID_MAX_CHARS), sql: 'DELETE FROM notes WHERE id = 1' })).toBe(true);
    expect(parses(scheduleProposalItemSchema, { appId: 'x'.repeat(SCHEDULE_ID_MAX_CHARS + 1), sql: 'DELETE FROM notes WHERE id = 1' })).toBe(false);
    expect(scheduleProposalItemSchema.parse({ appId: 'ledger', sql: 'DELETE FROM notes WHERE id = 1' }).appId).toBe('ledger');
  });

  it('refuses a SELECT, DDL, two statements, ATTACH/PRAGMA and a nested SELECT/FROM — a scheduled proposal is literal-valued DML (S8)', () => {
    expect(isSingleDmlStatement('SELECT * FROM notes')).toBe(false);
    expect(isSingleDmlStatement('DROP TABLE notes')).toBe(false);
    expect(isSingleDmlStatement('CREATE TABLE x (id)')).toBe(false);
    expect(isSingleDmlStatement('DELETE FROM notes; DROP TABLE notes')).toBe(false);
    expect(isSingleDmlStatement("ATTACH DATABASE 'x' AS y")).toBe(false);
    expect(isSingleDmlStatement("INSERT INTO t VALUES (1); ATTACH 'x' AS y")).toBe(false);
    expect(isSingleDmlStatement('PRAGMA writable_schema = 1')).toBe(false);
    expect(isSingleDmlStatement('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false);
    // A nested read reaches every table the app holds — a proposal may only carry literal values.
    expect(isSingleDmlStatement('INSERT INTO t SELECT * FROM u')).toBe(false);
    expect(isSingleDmlStatement('UPDATE t SET note = (SELECT secret FROM private_notes LIMIT 1) WHERE id = 1')).toBe(false);
    expect(isSingleDmlStatement('DELETE FROM t WHERE id IN (SELECT id FROM u)')).toBe(false);
    expect(isSingleDmlStatement("INSERT INTO t (body) VALUES ('select from the menu')")).toBe(true); // inside a string literal: data, not a read
    expect(isSingleDmlStatement('DELETE FROM notes WHERE id = 1')).toBe(true); // the DML's own FROM is not a nested read
    expect(isSingleDmlStatement("UPDATE t SET fromage = 'brie' WHERE selected = 1")).toBe(true); // whole words only
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'SELECT * FROM notes' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DROP TABLE notes' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'ALTER TABLE notes ADD COLUMN x' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DELETE FROM notes; DROP TABLE notes' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'INSERT INTO t SELECT * FROM u' })).toBe(false);
  });

  it('bounds sql, summary and counts at their caps', () => {
    const dml = (chars: number) => `DELETE FROM notes WHERE body = '${'x'.repeat(chars - "DELETE FROM notes WHERE body = ''".length)}'`;
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: dml(SCHEDULE_PROPOSAL_SQL_MAX_CHARS) })).toBe(true);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: dml(SCHEDULE_PROPOSAL_SQL_MAX_CHARS + 1) })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: '' })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DELETE FROM t', summary: 'x'.repeat(SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS) })).toBe(true);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DELETE FROM t', summary: 'x'.repeat(SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS + 1) })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DELETE FROM t', counts: { changes: -1 } })).toBe(false);
    expect(parses(scheduleProposalItemSchema, { appId: 'notes', sql: 'DELETE FROM t', counts: {} })).toBe(false);
  });
});

// ------------------------------------------------------------ schedulerState

describe('schedulerStateSchema — watermark, global pause, daily counters', () => {
  it('accepts the state and defaults globalPause to false', () => {
    const parsed = schedulerStateSchema.parse(minimalState);
    expect(parsed.globalPause).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, globalPause: true })).toBe(true);
  });

  it('has NO leaderHost seat — leadership is runtime, per origin (feasibility F4/F10)', () => {
    expect(parses(schedulerStateSchema, { ...minimalState, leaderHost: 'web' })).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, leader: 'web' })).toBe(false);
  });

  it('requires an ISO instant watermark and a YYYY-MM-DD daily date with non-negative counters', () => {
    expect(parses(schedulerStateSchema, { ...minimalState, watermark: '2026-10-09' })).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, daily: { date: '2026-10-9', ai: 0, net: 0 } })).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, daily: { date: AT, ai: 0, net: 0 } })).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, daily: { date: '2026-10-09', ai: -1, net: 0 } })).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, daily: { date: '2026-10-09', ai: 0 } })).toBe(false);
    expect(parses(schedulerStateSchema, { ...minimalState, daily: { date: '2026-10-09', ai: 0, net: 0, disk: 0 } })).toBe(false);
    expect(parses(schedulerStateSchema, { watermark: AT })).toBe(false);
  });
});

// --------------------------------------------------- scheduleProposal + hash

describe('scheduleProposalSchema + proposalHash — the semantic fields only', () => {
  it('accepts a proposal and bounds title and steps', () => {
    expect(parses(scheduleProposalSchema, minimalProposal)).toBe(true);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, title: 'x'.repeat(SCHEDULE_TITLE_MAX_CHARS + 1) })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, steps: [] })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, steps: Array.from({ length: SCHEDULE_MAX_STEPS + 1 }, () => notify) })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, enabled: true })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, provenance: 'user' })).toBe(false);
  });

  it('refuses a credential in a proposal — it becomes a task', () => {
    expect(parses(scheduleProposalSchema, { ...minimalProposal, steps: [{ ...appThink, prompt: OPENAI_SHAPED_KEY }] })).toBe(false);
  });

  it('is a stable hex digest that ignores the title and key order', () => {
    const a = proposalHash(scheduleProposalSchema.parse(minimalProposal));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // Pinned: the hash is a persisted dedupe key (declines mute by it), so a drift in the
    // canonical bytes or the digest would silently un-mute every muted suggestion.
    expect(a).toBe('a5f2f9edb259b586');
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, title: 'A different name' }))).toBe(a);
    const shuffled = {
      spec: { tz: 'device', time: '08:00', kind: 'daily' },
      steps: [{ body: notify.body, title: notify.title, kind: 'notify' }],
      title: minimalProposal.title,
    };
    expect(proposalHash(scheduleProposalSchema.parse(shuffled))).toBe(a);
  });

  it('differs on a step change and on a spec change', () => {
    const a = proposalHash(scheduleProposalSchema.parse(minimalProposal));
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, steps: [{ ...notify, body: 'Different.' }] }))).not.toBe(a);
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, steps: [notify, notify] }))).not.toBe(a);
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, spec: { ...daily, time: '09:00' } }))).not.toBe(a);
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, spec: { ...daily, tz: 'Europe/Oslo' } }))).not.toBe(a);
    // An N-day stride's `time` is semantic too: "every 3 days" and "every 3 days at 9" are different suggestions.
    const stride = { kind: 'every', n: 3, unit: 'days', tz: 'device' };
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, spec: { ...stride, time: '09:00' } }))).not.toBe(
      proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, spec: stride })),
    );
  });
});

// ---------------------------------------------------------- tolerant readers

describe('tolerant readers — undefined for anything unusable, never a throw', () => {
  const readers: ReadonlyArray<[string, (raw: string | null | undefined) => unknown, unknown]> = [
    ['parseScheduledTask', parseScheduledTask, minimalTask],
    ['parseScheduleRun', parseScheduleRun, minimalRun],
    ['parseSchedulerState', parseSchedulerState, minimalState],
    ['parseScheduleProposal', parseScheduleProposal, minimalProposal],
  ];

  it('reads a valid row back, defaults filled', () => {
    for (const [name, read, fixture] of readers) {
      const value = read(JSON.stringify(fixture));
      expect(value, name).toBeDefined();
      expect(value, name).toMatchObject(fixture as Record<string, unknown>);
    }
    expect(parseScheduledTask(JSON.stringify(minimalTask))?.unseenResults).toBe(0);
    expect(parseScheduleRun(JSON.stringify(minimalRun))?.calls).toEqual({ ai: 0, net: 0 });
    expect(parseSchedulerState(JSON.stringify(minimalState))?.globalPause).toBe(false);
  });

  it('returns undefined for absent, malformed, non-object or non-conforming text', () => {
    for (const [name, read, fixture] of readers) {
      for (const bad of [undefined, null, '', '{{', '[]', '"text"', '42', 'null', '{}', JSON.stringify({ ...(fixture as object), unknown: 1 })]) {
        expect(() => read(bad), `${name}(${String(bad)})`).not.toThrow();
        expect(read(bad), `${name}(${String(bad)})`).toBeUndefined();
      }
    }
  });

  it('refuses a credential-bearing task through the tolerant path too', () => {
    const task = { ...minimalTask, steps: [{ ...appThink, prompt: OPENAI_SHAPED_KEY }] };
    expect(parseScheduledTask(JSON.stringify(task))).toBeUndefined();
  });
});

// ------------------------------------------------------------- canonical

describe('canonicalScheduledTask — byte identity for the import guard (ADR-0074 §2)', () => {
  it('is key-order independent so a re-serialized row still compares equal', () => {
    const a = canonicalScheduledTask(scheduledTaskSchema.parse(minimalTask));
    const reordered = Object.fromEntries(Object.entries(minimalTask).reverse());
    const b = canonicalScheduledTask(scheduledTaskSchema.parse({ ...reordered, spec: { tz: 'device', time: '08:00', kind: 'daily' } }));
    expect(a).toBe(b);
    expect(a).toBe(JSON.stringify(JSON.parse(a)));
  });

  it('differs whenever any seat differs — the import comparison must not collapse tasks', () => {
    const base = canonicalScheduledTask(scheduledTaskSchema.parse(minimalTask));
    expect(canonicalScheduledTask(scheduledTaskSchema.parse({ ...minimalTask, enabled: false }))).not.toBe(base);
    expect(canonicalScheduledTask(scheduledTaskSchema.parse({ ...minimalTask, cron: '0 9 * * *' }))).not.toBe(base);
  });
});

describe('canonicalScheduleIntent — what a run or a counter must NOT change (M4)', () => {
  const parsed = (over: Record<string, unknown> = {}) => scheduledTaskSchema.parse({ ...minimalTask, ...over });

  it('is key-order independent and stable across the engine’s own bookkeeping — a backup round trip after one run still matches', () => {
    const base = canonicalScheduleIntent(parsed());
    const reordered = Object.fromEntries(Object.entries(minimalTask).reverse());
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse({ ...reordered, spec: { tz: 'device', time: '08:00', kind: 'daily' } }))).toBe(base);
    expect(canonicalScheduleIntent(parsed({ ranThrough: AT }))).toBe(base);
    expect(canonicalScheduleIntent(parsed({ updatedAt: '2026-10-10T08:00:00.000Z' }))).toBe(base);
    expect(canonicalScheduleIntent(parsed({ consecutiveFailures: 3, unseenResults: 12 }))).toBe(base);
    expect(canonicalScheduleIntent(parsed({ enabled: false, pausedReason: 'failures' }))).toBe(base);
    expect(canonicalScheduleIntent(parsed({ enabledAt: AT, appVersions: { w: 2 }, staleAfterMs: 120_000 }))).toBe(base);
    expect(base).toBe(JSON.stringify(JSON.parse(base)));
  });

  it('differs on every field that IS the intent: steps, spec, cron, startsAt, endsAt, missedPolicy, alert, ownerAppId, provenance, title', () => {
    const base = canonicalScheduleIntent(parsed());
    expect(canonicalScheduleIntent(parsed({ title: 'Other' }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ steps: [{ ...notify, body: 'Different.' }] }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ spec: { ...daily, time: '09:00' } }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ cron: '0 9 * * *' }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ startsAt: AT }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ endsAt: AT }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ missedPolicy: 'skip' }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ alert: 'notification' }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ ownerAppId: 'w' }))).not.toBe(base);
    expect(canonicalScheduleIntent(parsed({ provenance: 'chat' }))).not.toBe(base);
  });
});

// ------------------------------------------------------------ publication

describe('publication line — the schedule shapes stay OUT of json-schemas SOURCES (ADR-0074 §1)', () => {
  it('buildJsonSchemas() exports no schedule entry', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names).not.toContain('schedule.json');
    expect(names.some((name) => /schedul/i.test(name))).toBe(false);
  });
});

// ======================================================================
// TASK-20261010-host-broker PR-4 — the task write authority, the run's new seats and the
// host-native job constants (contract v2: D-PR4-7, D-PR4-11, D-PR4-15, D-PR4-17; AC31).
// Every new seat is INTERNAL, strict, and OMITTED when absent (D-PR3-2's omit-defaults rule),
// so a task or a run that never used one stays byte-identical to its pre-PR-4 form.
// ======================================================================

const ARMED_AT = '2026-10-11T09:00:00.000Z';
const UNDO_UUID = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b';
const writeAuthority = (over: Record<string, unknown> = {}) => ({ rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 3, ...over });
const armedTask = (over: Record<string, unknown> = {}) => ({ ...minimalTask, steps: [appThink], writeAuthority: writeAuthority(), ...over });

describe('PR-4 — the new constants (contract v2 module contracts)', () => {
  it('pins SCHEDULE_HELD_REASONS exactly — ONE table of why an armed item was not made (D-PR4-11)', () => {
    expect([...SCHEDULE_HELD_REASONS]).toEqual(['busy', 'changed', 'cannot-undo', 'full', 'failed', 'over-limit', 'stopped']);
  });

  it('pins the host-native job bounds (D-PR4-13, D-PR4-15)', () => {
    expect(APP_AGENT_MAX_TOOL_CALLS).toBe(8);
    expect(APP_AGENT_MAX_ROUND_TRIPS).toBe(10);
    expect(FETCH_CONNECTION_MAX_CHARS).toBe(16_000);
    expect(APP_AGENT_DEADLINE_MARGIN_MS).toBe(30_000);
  });

  it('index.ts exports every new name (the module contract: "index.ts exports")', () => {
    const exported = protocolIndex as Record<string, unknown>;
    for (const name of ['SCHEDULE_HELD_REASONS', 'APP_AGENT_MAX_TOOL_CALLS', 'APP_AGENT_MAX_ROUND_TRIPS', 'FETCH_CONNECTION_MAX_CHARS', 'APP_AGENT_DEADLINE_MARGIN_MS']) {
      expect(exported[name], name).toBeDefined();
    }
    expect(exported.SCHEDULE_HELD_REASONS).toBe(SCHEDULE_HELD_REASONS);
  });
});

describe('PR-4 — app-think + tools?: true (D-PR4-15; absent ≡ tool-free)', () => {
  it('an app-think step accepts tools: true, and absent stays the tool-free step', () => {
    expect(parses(scheduleStepSchema, { ...appThink, tools: true })).toBe(true);
    const parsed = scheduleStepSchema.parse(appThink);
    expect('tools' in parsed).toBe(false);
    const withTools = scheduleStepSchema.parse({ ...appThink, tools: true });
    expect(withTools.kind === 'app-think' && withTools.tools).toBe(true);
  });

  it('tools is the literal true only (omit-defaults: false is never written, so it never parses)', () => {
    expect(parses(scheduleStepSchema, { ...appThink, tools: true }), 'the passing twin').toBe(true);
    expect(parses(scheduleStepSchema, { ...appThink, tools: false })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appThink, tools: 'yes' })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appThink, tools: 1 })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appThink, tools: ['data_query'] })).toBe(false);
  });

  it('the seat is app-think\'s alone — notify and app-run refuse it', () => {
    expect(parses(scheduleStepSchema, { ...appThink, tools: true }), 'the passing twin').toBe(true);
    expect(parses(scheduleStepSchema, { ...notify, tools: true })).toBe(false);
    expect(parses(scheduleStepSchema, { ...appRun, tools: true })).toBe(false);
  });

  it('a tools step rides a task and a proposal (every proposal channel may carry tools: true — D-PR4-20)', () => {
    expect(parses(scheduledTaskSchema, { ...minimalTask, steps: [{ ...appThink, tools: true }] })).toBe(true);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, steps: [{ ...appThink, tools: true }] })).toBe(true);
  });

  it('tools is part of the intent: a tool-free and a tools step are different schedules', () => {
    const base = canonicalScheduleIntent(scheduledTaskSchema.parse({ ...minimalTask, steps: [appThink] }));
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse({ ...minimalTask, steps: [{ ...appThink, tools: true }] }))).not.toBe(base);
    const proposal = proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, steps: [appThink] }));
    expect(proposalHash(scheduleProposalSchema.parse({ ...minimalProposal, steps: [{ ...appThink, tools: true }] }))).not.toBe(proposal);
  });
});

describe('PR-4 — the task\'s writeAuthority and disarmed seats (D-PR4-7)', () => {
  it('accepts writeAuthority {rowsPerRun 1..ACCESS_WRITE_MAX_ROWS, armedAt, armedVersion}', () => {
    expect(ACCESS_WRITE_MAX_ROWS).toBe(200);
    expect(parses(scheduledTaskSchema, armedTask())).toBe(true);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ rowsPerRun: 1 }) }))).toBe(true);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ rowsPerRun: ACCESS_WRITE_MAX_ROWS }) }))).toBe(true);
    const parsed = scheduledTaskSchema.parse(armedTask());
    expect(parsed.writeAuthority).toEqual({ rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: 3 });
  });

  it('bounds rowsPerRun at 1..200, an int; armedAt an ISO instant; armedVersion an int — every seat required', () => {
    expect(parses(scheduledTaskSchema, armedTask()), 'the passing twin').toBe(true);
    for (const rowsPerRun of [0, -1, ACCESS_WRITE_MAX_ROWS + 1, 1.5, '200', null]) {
      expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ rowsPerRun }) })), String(rowsPerRun)).toBe(false);
    }
    for (const armedAt of ['2026-10-11', 'now', 1760000000000, '']) {
      expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ armedAt }) })), String(armedAt)).toBe(false);
    }
    for (const armedVersion of [1.5, '3', null]) {
      expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ armedVersion }) })), String(armedVersion)).toBe(false);
    }
    for (const seat of ['rowsPerRun', 'armedAt', 'armedVersion']) {
      expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ [seat]: undefined }) })), `without ${seat}`).toBe(false);
    }
  });

  it('writeAuthority is STRICT — no seat can widen it (another app, a table list, a standing approval)', () => {
    expect(parses(scheduledTaskSchema, armedTask()), 'the passing twin').toBe(true);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ appId: 'budget' }) }))).toBe(false);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ tables: ['transactions'] }) }))).toBe(false);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: writeAuthority({ cross: true }) }))).toBe(false);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: true }))).toBe(false);
    expect(parses(scheduledTaskSchema, armedTask({ writeAuthority: [writeAuthority()] }))).toBe(false);
  });

  it('accepts disarmed {reason: imported | app-updated, at} — a trace of a disarm the user did not perform', () => {
    for (const reason of ['imported', 'app-updated']) {
      expect(parses(scheduledTaskSchema, { ...minimalTask, disarmed: { reason, at: AT } }), reason).toBe(true);
    }
    expect(parses(scheduledTaskSchema, { ...minimalTask, disarmed: { reason: 'user', at: AT } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, disarmed: { reason: 'switched-off', at: AT } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, disarmed: { reason: 'imported' } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, disarmed: { reason: 'imported', at: '2026-10-11' } })).toBe(false);
    expect(parses(scheduledTaskSchema, { ...minimalTask, disarmed: { reason: 'imported', at: AT, by: 'sync' } })).toBe(false);
  });

  it('both seats are OMITTED when absent — a task that never armed parses with neither key (omit-defaults)', () => {
    expect(parses(scheduledTaskSchema, armedTask({ disarmed: { reason: 'app-updated', at: AT } })), 'the seats exist').toBe(true);
    const parsed = scheduledTaskSchema.parse(minimalTask);
    expect('writeAuthority' in parsed).toBe(false);
    expect('disarmed' in parsed).toBe(false);
    expect(Object.keys(JSON.parse(canonicalScheduledTask(parsed)))).not.toContain('writeAuthority');
    expect(Object.keys(JSON.parse(canonicalScheduledTask(parsed)))).not.toContain('disarmed');
  });

  it('canonicalScheduleIntent EXCLUDES both — consent state, like enabled (AC31 "includes" amended)', () => {
    const base = canonicalScheduleIntent(scheduledTaskSchema.parse({ ...minimalTask, steps: [appThink] }));
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse(armedTask()))).toBe(base);
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse(armedTask({ writeAuthority: writeAuthority({ rowsPerRun: 1, armedVersion: 9 }) })))).toBe(base);
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse({ ...minimalTask, steps: [appThink], disarmed: { reason: 'imported', at: AT } }))).toBe(base);
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse(armedTask())).includes('writeAuthority')).toBe(false);
    expect(canonicalScheduleIntent(scheduledTaskSchema.parse(armedTask())).includes('armedAt')).toBe(false);
  });

  it('the whole-row canonical bytes DO see them (the row is the row)', () => {
    const plain = canonicalScheduledTask(scheduledTaskSchema.parse({ ...minimalTask, steps: [appThink] }));
    expect(canonicalScheduledTask(scheduledTaskSchema.parse(armedTask()))).not.toBe(plain);
  });

  it('the tolerant reader keeps an armed task\'s authority and refuses a malformed one as "no such task"', () => {
    expect(parseScheduledTask(JSON.stringify(armedTask()))?.writeAuthority?.rowsPerRun).toBe(200);
    expect(parseScheduledTask(JSON.stringify(armedTask({ writeAuthority: writeAuthority({ rowsPerRun: 201 }) })))).toBeUndefined();
  });
});

describe('PR-4 — NO proposal channel can carry an authority (AC31 negative; D-PR4-20)', () => {
  it('scheduleProposalSchema refuses writeAuthority, disarmed and an enabled flag — strict, whatever the shape', () => {
    // The authority seat exists on the TASK (the user's act writes it) …
    expect(parses(scheduledTaskSchema, armedTask()), 'the task carries it').toBe(true);
    // … and never on what a builder, a chat or an app may propose.
    expect(parses(scheduleProposalSchema, { ...minimalProposal, writeAuthority: writeAuthority() })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, steps: [appThink], writeAuthority: writeAuthority() })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, writeAuthority: { rowsPerRun: 1 } })).toBe(false);
    expect(parses(scheduleProposalSchema, { ...minimalProposal, disarmed: { reason: 'imported', at: AT } })).toBe(false);
    expect(parseScheduleProposal(JSON.stringify({ ...minimalProposal, writeAuthority: writeAuthority() }))).toBeUndefined();
  });

  it('a step cannot smuggle it either — no step kind has an authority seat', () => {
    expect(parses(scheduleStepSchema, { ...appThink, tools: true }), 'the tools step itself parses').toBe(true);
    for (const step of [notify, appRun, appThink, { ...appThink, tools: true }]) {
      expect(parses(scheduleStepSchema, { ...step, writeAuthority: writeAuthority() }), step.kind).toBe(false);
      expect(parses(scheduleStepSchema, { ...step, makeChanges: true }), step.kind).toBe(false);
    }
  });
});

describe('PR-4 — the run\'s applied group: one app, ≤ 3 items, NO SQL (D-PR4-17)', () => {
  const applied = (over: Record<string, unknown> = {}) => ({ appId: 'ledger', undoId: UNDO_UUID, items: [{ summary: 'Tags March rent', changes: 12 }], ...over });

  it('accepts a group with an undo id, and one that cannot be undone (undoable: false, no undoId)', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied() })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: { appId: 'ledger', undoable: false, items: [{ changes: 2 }] } })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ changes: 1 }, { changes: 0 }, { summary: 'x', changes: 3 }] }) })).toBe(true);
  });

  it('is omitted when absent — a run of an unchanged task stays pre-PR-4 bytes', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied() }), 'the seat exists').toBe(true);
    const parsed = scheduleRunSchema.parse(minimalRun);
    expect('applied' in parsed).toBe(false);
  });

  it('items ≤ SCHEDULE_PROPOSALS_PER_RUN; changes a non-negative int; ONE group, never a list of groups', () => {
    const item = { changes: 1 };
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: Array.from({ length: SCHEDULE_PROPOSALS_PER_RUN }, () => item) }) })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: Array.from({ length: SCHEDULE_PROPOSALS_PER_RUN + 1 }, () => item) }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ changes: -1 }] }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ changes: 1.5 }] }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ summary: 'no count' }] }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: [applied()] })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ appId: undefined }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ appId: 'x'.repeat(SCHEDULE_ID_MAX_CHARS + 1) }) })).toBe(false);
  });

  it('carries NO SQL — not on the group, not on an item (the undo is the journal\'s, never statement text)', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied() }), 'the passing twin').toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ sql: 'DELETE FROM t WHERE id = 1' }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ changes: 1, sql: 'DELETE FROM t WHERE id = 1' }] }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ changes: 1, appId: 'budget' }] }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ steps: [] }) })).toBe(false);
  });

  it('undoable is the literal false only (omit-defaults); undoId is a uuid', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ undoId: undefined, undoable: false }) }), 'the passing twin').toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ undoable: true }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ undoId: 'undo-1' }) })).toBe(false);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ undoId: '' }) })).toBe(false);
  });

  it('the item summary is bounded like a proposal item\'s', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ summary: 'x'.repeat(SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS), changes: 1 }] }) })).toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ summary: 'x'.repeat(SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS + 1), changes: 1 }] }) })).toBe(false);
  });

  it('a credential in an applied summary is a refusal like anywhere else in a run', () => {
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied() }), 'the passing twin').toBe(true);
    expect(parses(scheduleRunSchema, { ...minimalRun, applied: applied({ items: [{ summary: `Key ${OPENAI_SHAPED_KEY}`, changes: 1 }] }) })).toBe(false);
  });

  it('a run holding both a pending proposal and an applied group parses (held items stay pending beside what was made)', () => {
    const run = {
      ...minimalRun,
      applied: applied(),
      proposals: { items: [{ appId: 'ledger', sql: 'DELETE FROM notes WHERE id = 1', held: 'over-limit' }], expiresAt: AT },
    };
    expect(parses(scheduleRunSchema, run)).toBe(true);
  });
});

describe('PR-4 — a proposal item\'s held reason (D-PR4-11)', () => {
  const item = { appId: 'ledger', sql: 'DELETE FROM notes WHERE id = 1' };

  it('accepts every SCHEDULE_HELD_REASONS value and nothing else', () => {
    for (const held of SCHEDULE_HELD_REASONS) expect(parses(scheduleProposalItemSchema, { ...item, held }), held).toBe(true);
    for (const held of ['switched-off', 'paused', 'Busy', '', 'too-many']) expect(parses(scheduleProposalItemSchema, { ...item, held }), held).toBe(false);
  });

  it('is omitted when absent — an unarmed run\'s item is pre-PR-4 bytes', () => {
    expect(parses(scheduleProposalItemSchema, { ...item, held: 'busy' }), 'the seat exists').toBe(true);
    expect('held' in scheduleProposalItemSchema.parse(item)).toBe(false);
  });
});

describe('PR-4 — the step result\'s host facts: inOpenApp?, saw?, tools?, blockedBy? (D-PR4-17)', () => {
  it('inOpenApp is the literal true only — absent = out of sight', () => {
    expect(parses(stepResultSchema, { status: 'ok', inOpenApp: true })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', inOpenApp: false })).toBe(false);
    expect('inOpenApp' in stepResultSchema.parse({ status: 'ok' })).toBe(false);
  });

  it('saw is 1..8 {source ≤ 64, table ≤ 64} — written only when non-empty', () => {
    const seen = (n: number) => Array.from({ length: n }, (_, i) => ({ source: `app${i}`, table: `t${i}` }));
    expect(parses(stepResultSchema, { status: 'ok', saw: seen(1) })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', saw: seen(8) })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', saw: seen(9) })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', saw: [] })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', saw: [{ source: 'x'.repeat(64), table: 'y'.repeat(64) }] })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', saw: [{ source: 'x'.repeat(65), table: 't' }] })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', saw: [{ source: 'ledger', table: 'y'.repeat(65) }] })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', saw: [{ source: 'ledger' }] })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', saw: [{ source: 'ledger', table: 't', columns: ['a'] }] })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', saw: [{ source: 'ledger', table: 't', sql: 'SELECT 1' }] })).toBe(false);
  });

  it('tools is {used 0..8, fetched?} or {unavailable: brain | sidecar} — slot names and counts only, never a path', () => {
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 0 } })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: APP_AGENT_MAX_TOOL_CALLS } })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: APP_AGENT_MAX_TOOL_CALLS + 1 } })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: -1 } })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 1.5 } })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 3, fetched: [{ connection: 'spotify', calls: 3 }] } })).toBe(true);
    const fetched = (n: number) => Array.from({ length: n }, (_, i) => ({ connection: `conn-${i}`, calls: 1 }));
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 8, fetched: fetched(8) } })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 8, fetched: fetched(9) } })).toBe(false);
    for (const calls of [0, 9, 1.5]) {
      expect(parses(stepResultSchema, { status: 'ok', tools: { used: 1, fetched: [{ connection: 'spotify', calls }] } }), String(calls)).toBe(false);
    }
    // A slot name (CONNECTION_SLOT_RULE), never a URL, a path or a query.
    for (const connection of ['Spotify', 'https://api.spotify.com', 'spotify/v1/me', '', 'x'.repeat(41)]) {
      expect(parses(stepResultSchema, { status: 'ok', tools: { used: 1, fetched: [{ connection, calls: 1 }] } }), connection).toBe(false);
    }
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 1, fetched: [{ connection: 'spotify', calls: 1, path: '/v1/me' }] } })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: { used: 1, fetched: [{ connection: 'spotify', calls: 1, query: { q: 'x' } }] } })).toBe(false);

    expect(parses(stepResultSchema, { status: 'ok', tools: { unavailable: 'brain' } })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', tools: { unavailable: 'sidecar' } })).toBe(true);
    expect(parses(stepResultSchema, { status: 'ok', tools: { unavailable: 'network' } })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: { unavailable: 'brain', used: 0 } })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: {} })).toBe(false);
    expect(parses(stepResultSchema, { status: 'ok', tools: true })).toBe(false);
  });

  it('blockedBy is the literal brain only', () => {
    expect(parses(stepResultSchema, { status: 'refused', blockedBy: 'brain' })).toBe(true);
    expect(parses(stepResultSchema, { status: 'refused', blockedBy: 'network' })).toBe(false);
    expect(parses(stepResultSchema, { status: 'refused', blockedBy: true })).toBe(false);
  });

  it('every new seat is omitted when absent — a pre-PR-4 step result parses to the same bytes', () => {
    expect(parses(stepResultSchema, { status: 'ok', inOpenApp: true, tools: { used: 0 } }), 'the seats exist').toBe(true);
    const parsed = stepResultSchema.parse({ status: 'ok', summary: 'Spent 120 on food.' });
    expect(Object.keys(parsed).sort()).toEqual(['status', 'summary']);
  });

  it('the seats ride a run inside the whole-run byte cap and the credential walk', () => {
    const run = {
      ...minimalRun,
      steps: [{ status: 'ok', inOpenApp: true }, { status: 'ok', saw: [{ source: 'ledger', table: 'transactions' }], tools: { used: 2, fetched: [{ connection: 'spotify', calls: 1 }] } }, { status: 'refused', blockedBy: 'brain' }],
    };
    expect(parses(scheduleRunSchema, run)).toBe(true);
  });
});

describe('PR-4 — publication line still holds: json-schemas SOURCES unchanged (pinned)', () => {
  it('buildJsonSchemas() exports exactly the sixteen it exported before PR-4 — no own-undo, no schedule entry', () => {
    expect(Object.keys(buildJsonSchemas())).toEqual([
      'app-announce.json',
      'host-ready.json',
      'app-message.json',
      'app-cancel.json',
      'app-response.json',
      'db-request.json',
      'db-response.json',
      'host-event.json',
      'app-event.json',
      'net-request.json',
      'net-response.json',
      'open-url-request.json',
      'open-url-result.json',
      'access-request.json',
      'access-response.json',
      'app-request-envelope.json',
    ]);
  });
});

// =================================================================================================
// PR-4 Gate-5 AUTH-F8 — the forward-compatibility DIRECTION, pinned against a hand-copied pre-PR-4
// reader (main @ 76c9262, packages/protocol/src/schedule.ts). A pre-PR-4 hub parses strictly, so:
//   - a step result carrying `inOpenApp` (a run that ran in the open app — every manual *run now* of an
//     app-run included) or `saw` (it read another app's data) is REFUSED by it — dropped from its
//     history, and from its next export or push;
//   - an *Ask* step carrying `tools` is refused by it — a task holding one (or `writeAuthority`, or
//     `disarmed`) is deleted by its untrusted import.
// The current schema accepts each (the direction is new → old only). This records the residual the
// threat delta names; it never asks the old reader to change.
// =================================================================================================

describe('PR-4 Gate-5 AUTH-F8 — what a pre-PR-4 reader refuses (the direction, hand-copied)', () => {
  /** main's `stepResultSchema`, byte for byte but for the imports. */
  const preStepResultSchema = z.strictObject({
    status: z.enum(['ok', 'failed', 'blocked', 'refused', 'no-handler', 'skipped']),
    summary: z.string().max(4096).optional(),
    appMissing: z.boolean().optional(),
  });
  /** main's `app-think` step member: no `tools` seat. */
  const preAppThinkStepSchema = z.strictObject({
    kind: z.literal('app-think'),
    appId: z.string().min(1),
    prompt: z.string().min(1),
    context: z.strictObject({ sql: z.array(z.string()).optional(), maxRows: z.int().min(1).optional() }),
  });

  it('a step result with inOpenApp: the current schema reads it; a pre-PR-4 reader refuses it', () => {
    const row = { status: 'ok', inOpenApp: true };
    expect(parses(stepResultSchema, row)).toBe(true);
    expect(parses(preStepResultSchema, row)).toBe(false);
  });

  it('a step result with saw: read now, refused before', () => {
    const row = { status: 'ok', saw: [{ source: 'Ledger', table: 'transactions' }] };
    expect(parses(stepResultSchema, row)).toBe(true);
    expect(parses(preStepResultSchema, row)).toBe(false);
  });

  it('the passing twin: a plain step result is read by both', () => {
    expect(parses(stepResultSchema, { status: 'ok', summary: 'done' })).toBe(true);
    expect(parses(preStepResultSchema, { status: 'ok', summary: 'done' })).toBe(true);
  });

  it('an Ask step with tools: read now, refused before', () => {
    const step = { kind: 'app-think', appId: 'ledger', prompt: 'tidy', context: { maxRows: 50 }, tools: true };
    expect(parses(scheduleStepSchema, step)).toBe(true);
    expect(parses(preAppThinkStepSchema, step)).toBe(false);
    const { tools: _t, ...plain } = step;
    expect(parses(preAppThinkStepSchema, plain)).toBe(true);
  });
});
