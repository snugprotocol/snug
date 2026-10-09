/**
 * TASK-20261009-scheduling-framework — the scheduler's shapes: a task, its steps, a run,
 * the scheduler's state and a proposal (ADR-0074 §2, §5, §6). INTERNAL protocol surface.
 *
 * WHY THIS EXISTS. A Snug app lives in the user's file and thinks through the user's own
 * brain, but nothing happens unless the user is looking. ADR-0074 puts ONE scheduler in
 * every runner and keeps its record in the user's file through namespaced settings rows
 * (`schedule:<taskId>`, `scheduleRuns:<taskId>`, `schedulerState`). These are the shapes
 * those rows must parse to; the engine (`apps/playground/src/schedule/`) and the typed
 * accessors (`packages/db/src/userdb/schedules.ts`) read nothing that did not pass here.
 *
 * A TASK IS EXECUTABLE INTENT. What parses as a task later spends the user's brain, their
 * network budget and their attention — and a task reaches a hub from an imported `.snug`,
 * a sync pull or a hand-edited row as readily as from the editor. So every bound lives at
 * the parse (per seat, per list, and a whole-object UTF-8 byte cap), every object is
 * `strictObject` at every level, and a credential-shaped string, a URL carrying userinfo
 * or an `authorization`-like key ANYWHERE in a task, a run or a proposal is a REFUSAL
 * (C1, ADR-0074 §6): the file is the one place a secret must never be able to ride.
 *
 * SPEC AND CRON, BOTH PERSISTED. `spec` is the intuitive form the editor shows and never
 * reverse-parses; `cron` is the engine's form. `compileSpec` (the playground) writes both
 * together; this module only shapes them.
 *
 * NO `leaderHost`. Leadership is runtime — per origin, per file uuid, a `navigator.locks`
 * request — never a persisted claim another host would have to trust (feasibility F4/F10).
 *
 * Internal draft — OUT of `json-schemas.ts` SOURCES (ADR-0074 §1: scheduling is a host
 * feature, not protocol; a host that never schedules is still conforming).
 */

import { z } from 'zod';
import { STRIP_HEADERS } from './constants.js';
import { scanForCredentialValues, type CredentialFinding } from './security.js';

// ------------------------------------------------------------------ constants

/** The `every` units. PERSISTED literals. */
export const SCHEDULE_UNITS = ['minutes', 'hours', 'days'] as const;
export type ScheduleUnit = (typeof SCHEDULE_UNITS)[number];

/** Weekdays in cron order from Monday — the editor's presets (weekdays, weekends) are day SETS. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Per-step outcomes inside one run. */
export const STEP_RESULT_STATUSES = ['ok', 'failed', 'blocked', 'refused', 'no-handler', 'skipped'] as const;
export type StepResultStatus = (typeof STEP_RESULT_STATUSES)[number];

/** Who created the task — the frequency floor and the consent copy both key off it. */
export const TASK_PROVENANCES = ['user', 'builder', 'chat', 'app', 'imported'] as const;
export type TaskProvenance = (typeof TASK_PROVENANCES)[number];

/** What a missed occurrence does on the next open (ADR-0074 §5). */
export const MISSED_POLICIES = ['ask', 'run-once', 'skip'] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];

/** Where a result announces itself. */
export const ALERT_KINDS = ['inbox', 'notification'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Why the engine paused a task on its own (ADR-0074 §6 self-protection). */
export const PAUSED_REASONS = ['failures', 'ignored', 'app-updated'] as const;
export type PausedReason = (typeof PAUSED_REASONS)[number];

/** What started a run. */
export const RUN_TRIGGERS = ['due', 'late', 'catch-up', 'manual'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** A run's lifecycle. `pending` is a persisted catch-up candidate the missed card reads. */
export const RUN_STATUSES = [
  'pending',
  'running',
  'ok',
  'failed',
  'skipped',
  'needs-you',
  'interrupted',
  'capped',
  'no-handler',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Which shell ran it — every run records this so the UI can say in words what ran where. */
export const SCHEDULE_HOST_KINDS = ['web', 'desktop', 'host'] as const;
export type ScheduleHostKind = (typeof SCHEDULE_HOST_KINDS)[number];

/** Whole-task cap in UTF-8 BYTES of the serialized (parsed) task — the `schedule:<id>` row's size. */
export const SCHEDULED_TASK_MAX_BYTES = 16 * 1024;
/** Whole-run cap in UTF-8 BYTES of one serialized run row. */
export const SCHEDULE_RUN_MAX_BYTES = 8 * 1024;

/** ≤ 200 tasks per file (ADR-0074 §2). */
export const SCHEDULE_MAX_TASKS = 200;
/** One bounded `scheduleRuns:<taskId>` row per task — newest first. */
export const SCHEDULE_RUNS_MAX_ENTRIES = 50;
export const SCHEDULE_RUNS_MAX_BYTES = 64 * 1024;
/** Every task's run history together. */
export const SCHEDULE_RUNS_TOTAL_MAX_BYTES = 2 * 1024 * 1024;

/** Frequency floors: the user's own schedules may run every 5 min; app-, builder- and chat-proposed ones every 15. */
export const SCHEDULE_MIN_INTERVAL_MS = { user: 5 * 60_000, other: 15 * 60_000 } as const;
/** Within the grace a run is merely `late`; older occurrences are MISSED (ADR-0074 §5). */
export const SCHEDULE_GRACE_MS = 15 * 60_000;
/** Pending data-change proposals expire after seven days. */
export const SCHEDULE_PROPOSAL_TTL_MS = 7 * 86_400_000;
/** Global daily ceilings on brain and network calls, with an 80 % warning (ADR-0074 §6). */
export const SCHEDULE_DAILY_CEILINGS = { ai: 100, net: 500 } as const;

export const SCHEDULE_MAX_STEPS = 5;
export const SCHEDULE_TITLE_MAX_CHARS = 80;
export const SCHEDULE_NOTIFY_BODY_MAX_CHARS = 120;
/** An `app-run` input: serialized JSON, UTF-8 BYTES — it rides the kv handshake under the same cap. */
export const SCHEDULE_APP_INPUT_MAX_BYTES = 1024;
export const SCHEDULE_PROMPT_MAX_CHARS = 2048;
export const SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS = 4;
export const SCHEDULE_CONTEXT_SQL_MAX_CHARS = 1024;
export const SCHEDULE_CONTEXT_MAX_ROWS = 200;
export const SCHEDULE_CONTEXT_DEFAULT_ROWS = 50;
export const SCHEDULE_STEP_SUMMARY_MAX_CHARS = 4096;
export const SCHEDULE_PROPOSALS_PER_RUN = 3;
export const SCHEDULE_PROPOSAL_SQL_MAX_CHARS = 2048;
export const SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS = 300;
export const SCHEDULE_RUN_REASON_MAX_CHARS = 200;
export const SCHEDULE_CRON_MAX_CHARS = 120;
export const SCHEDULE_EVERY_MAX_N = 999;
export const SCHEDULE_UNTIL_MAX_COUNT = 1000;
/** Ids and app ids — the same charset-free bound the kv namespace and settings keys already live under. */
export const SCHEDULE_ID_MAX_CHARS = 64;
export const SCHEDULE_TZ_MAX_CHARS = 64;
/** A task names at most this many apps; `appVersions` records each one's version at enable. */
export const SCHEDULE_MAX_APP_VERSIONS = 5;
/** A missed occurrence's freshness window: one minute to seven days. */
export const SCHEDULE_STALE_AFTER_MS = { min: 60_000, max: 604_800_000 } as const;

// ------------------------------------------------------------- building blocks

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** `HH:MM`, 24-hour, zero-padded — what the editor writes and the cron compiler reads. */
const TIME_RULE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** `new Date().toISOString()` shape — `z.iso.datetime()` refuses offsets, so a stored instant is always UTC. */
const isoInstant = z.iso.datetime();
const isoDate = z.iso.date();
const id = z.string().min(1).max(SCHEDULE_ID_MAX_CHARS);
const appId = z.string().min(1).max(SCHEDULE_ID_MAX_CHARS);
const title = z.string().min(1).max(SCHEDULE_TITLE_MAX_CHARS);

/**
 * An IANA zone name is whatever THIS runtime's `Intl` resolves — the same resolver the
 * cron compiler fires occurrences through, so a zone that parses here is a zone that runs.
 * A list would drift from the ICU data the host actually ships.
 */
export function isIanaTimeZone(tz: string): boolean {
  if (tz === '' || tz === 'device') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `'device'` = resolved at fire time on whichever host runs it; a named zone pins it (Q13). */
const tzSchema = z.union([
  z.literal('device'),
  z.string().min(1).max(SCHEDULE_TZ_MAX_CHARS).refine(isIanaTimeZone, 'tz must be "device" or an IANA zone this runtime knows'),
]);

const SINGLE_STATEMENT_RULE = /^[^;]*;?\s*$/;
const SELECT_PREFIX_RULE = /^\s*(?:SELECT|WITH)\b/i;
const DML_PREFIX_RULE = /^\s*(?:INSERT|UPDATE|DELETE)\b/i;
/** Never in a scheduled statement, read or write: these reach outside the app's own data. */
const FORBIDDEN_TOKEN_RULE = /\b(?:ATTACH|DETACH|PRAGMA)\b/i;
/** A `WITH … INSERT|UPDATE|DELETE|REPLACE` is the one write a SELECT-prefix rule would let through. */
const CTE_WRITE_RULE = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * An `app-think` context query: ONE statement that starts with `SELECT` or `WITH`, no
 * `;` before an optional trailing one, no ATTACH/DETACH/PRAGMA anywhere, and no DML
 * keyword after a `WITH` prefix (the CTE-prefixed write forms). A regex cannot parse
 * SQL, so this is deliberately narrow; `db.scratchRun` on the receiving side is
 * read-only by construction (ADR-0019) — this is the boundary's half, not the only half.
 */
export function isReadOnlySelect(sql: string): boolean {
  if (!SELECT_PREFIX_RULE.test(sql)) return false;
  if (!SINGLE_STATEMENT_RULE.test(sql)) return false;
  if (FORBIDDEN_TOKEN_RULE.test(sql)) return false;
  if (/^\s*WITH\b/i.test(sql) && CTE_WRITE_RULE.test(sql)) return false;
  return true;
}

/** String literals and quoted identifiers, so a keyword INSIDE one (`'select from the menu'`, a column named `"from"`) is data, not a read. */
const QUOTED_RULE = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g;
const DELETE_FROM_HEAD_RULE = /^\s*DELETE\s+FROM\b/i;
const NESTED_READ_RULE = /\b(?:SELECT|FROM)\b/i;

/**
 * A nested read anywhere in a DML statement — `INSERT … SELECT`, a `(SELECT …)` subquery,
 * `UPDATE … FROM`, `WHERE id IN (SELECT …)` — reaches every table the app holds, so a
 * scheduled proposal may carry only LITERAL values (S8). Quoted text is blanked first; the
 * `DELETE FROM` head is the statement's own and not a read.
 */
function hasNestedRead(sql: string): boolean {
  const bare = sql.replace(QUOTED_RULE, "''");
  const body = DELETE_FROM_HEAD_RULE.test(bare) ? bare.replace(DELETE_FROM_HEAD_RULE, '') : bare;
  return NESTED_READ_RULE.test(body);
}

/**
 * A pending data change the AI proposed: ONE `INSERT`/`UPDATE`/`DELETE` statement over
 * literal values — no second statement, no ATTACH/DETACH/PRAGMA, and no nested `SELECT`
 * or `FROM` (`hasNestedRead`). DDL never rides a proposal — the engine dry-runs these on
 * the scratch copy and the user approves them one card at a time.
 */
export function isSingleDmlStatement(sql: string): boolean {
  return DML_PREFIX_RULE.test(sql) && SINGLE_STATEMENT_RULE.test(sql) && !FORBIDDEN_TOKEN_RULE.test(sql) && !hasNestedRead(sql);
}

// ------------------------------------------------------- credential refusal

/** `authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization` — the C1 strip set, as key names. */
const AUTH_LIKE_KEYS = new Set<string>(STRIP_HEADERS);

/**
 * `scheme://` followed by an authority that carries `@` before its first `/`, `?` or `#`
 * — RFC 3986 userinfo, wherever the URL sits in a string. The same refusal the open-url
 * frame makes on a URL seat, extended to prose because a prompt or a body is free text.
 */
const URL_USERINFO_RULE = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s"'<>`]*@/i;

/** Punctuation a prose token drags along (`sk-….` at a sentence's end) — stripped before the token is scanned. */
const TRAILING_PUNCTUATION_RULE = /[.,;:!?)\]}'"`]+$/;

export interface ScheduleCredentialIssue {
  path: string;
  reason: 'auth-like-key' | 'url-userinfo' | CredentialFinding['reason'];
}

/**
 * One string through the security module's VALUE scan — under its key, so the scanner's
 * key-context rule (high entropy under a credential-ish key rejects; under a neutral key
 * it only warns) holds exactly as it does on an envelope. The scanner's shapes are
 * anchored to the start of a value, and a prompt or a reply summary is PROSE, so each
 * whitespace-separated token is scanned as well: `Use sk-… to fetch.` carries a key.
 */
function credentialValueReason(text: string, keyName: string | undefined): CredentialFinding['reason'] | undefined {
  const whole = scanForCredentialValues(keyName === undefined ? text : { [keyName]: text }).rejects[0];
  if (whole) return whole.reason;
  if (!/\s/.test(text)) return undefined;
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(TRAILING_PUNCTUATION_RULE, '');
    if (token === '') continue;
    const hit = scanForCredentialValues(token).rejects[0];
    if (hit) return hit.reason;
  }
  return undefined;
}

/**
 * The ONE credential walk for everything the scheduler persists. Three refusals:
 * an authorization-like KEY at any depth (case-insensitive — `app-run.input` is free
 * JSON, and a header map is exactly what an app would try to smuggle), a URL with
 * userinfo in any string, and the security module's high-confidence VALUE shapes
 * (Bearer, JWT, known provider prefixes, high entropy under a credential-ish key),
 * whole or embedded in prose. The scanner's warnings (`token: 'rook'`) never refuse —
 * a task is strict, not paranoid.
 */
export function findScheduleCredential(value: unknown): ScheduleCredentialIssue | undefined {
  const seen = new Set<object>();
  const walk = (node: unknown, path: string, keyName: string | undefined): ScheduleCredentialIssue | undefined => {
    if (typeof node === 'string') {
      if (URL_USERINFO_RULE.test(node)) return { path, reason: 'url-userinfo' };
      const reason = credentialValueReason(node, keyName);
      return reason ? { path, reason } : undefined;
    }
    if (typeof node !== 'object' || node === null || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const hit = walk(node[index], `${path}[${index}]`, undefined);
        if (hit) return hit;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (AUTH_LIKE_KEYS.has(key.toLowerCase())) return { path: childPath, reason: 'auth-like-key' };
      const hit = walk(child, childPath, key);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(value, '', undefined);
}

/** Shared tail refinement: the whole-object byte cap, then the credential walk over the PARSED value. */
function refuseOversizeOrCredential(what: string, maxBytes: number) {
  return (value: unknown, ctx: z.RefinementCtx): void => {
    if (utf8Bytes(JSON.stringify(value)) > maxBytes) {
      ctx.addIssue({ code: 'custom', message: `the serialized ${what} must be at most ${maxBytes} bytes` });
    }
    const credential = findScheduleCredential(value);
    if (credential) {
      ctx.addIssue({
        code: 'custom',
        message: `a ${what} may not carry a credential (${credential.reason} at ${credential.path || '<root>'})`,
      });
    }
  };
}

// ---------------------------------------------------------------- the spec

const untilSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('date'), date: isoDate }),
  z.strictObject({ kind: z.literal('count'), count: z.int().min(1).max(SCHEDULE_UNTIL_MAX_COUNT) }),
]);
export type ScheduleUntil = z.infer<typeof untilSchema>;

const specBase = {
  tz: tzSchema,
  until: untilSchema.optional(),
} as const;

const timeOfDay = z.string().regex(TIME_RULE, 'time must be HH:MM (24-hour)');

const weekdaysSchema = z
  .array(z.enum(WEEKDAYS))
  .min(1)
  .max(WEEKDAYS.length)
  .refine((days) => new Set(days).size === days.length, 'days must be unique');

const monthlyOnSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('day'), day: z.int().min(1).max(31) }),
  z.strictObject({ kind: z.literal('nth'), nth: z.int().min(1).max(4), weekday: z.enum(WEEKDAYS) }),
  z.strictObject({ kind: z.literal('last') }),
]);

/**
 * `every N minutes|hours` aligns to the clock (minutes 0, 15, 30, 45; hours 0, 2, 4, …) and
 * has no time of day to name; `every N days` strides from its anchor and fires at the
 * anchor's wall time UNLESS `time` names one ("every 3 days at 9"). So `time` is optional,
 * and a `time` on a minutes or hours stride is a refusal rather than a silently ignored seat.
 */
const everySchema = z
  .strictObject({
    kind: z.literal('every'),
    n: z.int().min(1).max(SCHEDULE_EVERY_MAX_N),
    unit: z.enum(SCHEDULE_UNITS),
    /** Honoured only when `unit` is `days`; absent, the stride keeps its creation wall time. */
    time: timeOfDay.optional(),
    ...specBase,
  })
  .superRefine((spec, ctx) => {
    if (spec.time !== undefined && spec.unit !== 'days') {
      ctx.addIssue({ code: 'custom', path: ['time'], message: 'time is honoured only when unit is "days"' });
    }
  });

/**
 * The intuitive form — what the editor shows and persists so it never reverse-parses
 * cron. Every variant carries `tz` and an optional `until`; `custom` is the escape hatch
 * for the five-field grammar the hand-rolled compiler accepts (ADR-0074 §7).
 */
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: isoInstant, ...specBase }),
  everySchema,
  z.strictObject({ kind: z.literal('daily'), time: timeOfDay, ...specBase }),
  z.strictObject({ kind: z.literal('weekly'), days: weekdaysSchema, time: timeOfDay, ...specBase }),
  z.strictObject({ kind: z.literal('monthly'), on: monthlyOnSchema, time: timeOfDay, ...specBase }),
  z.strictObject({ kind: z.literal('custom'), cron: z.string().min(1).max(SCHEDULE_CRON_MAX_CHARS), ...specBase }),
]);
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

// --------------------------------------------------------------- the steps

/** Any JSON value, bounded by its serialized UTF-8 size — the kv handshake carries these bytes verbatim. */
const appInputSchema = z
  .json()
  .refine((input) => utf8Bytes(JSON.stringify(input)) <= SCHEDULE_APP_INPUT_MAX_BYTES, `input must serialize to at most ${SCHEDULE_APP_INPUT_MAX_BYTES} bytes`);

const thinkContextSchema = z.strictObject({
  /** User-typed read-only queries, run on the scratch copy and delimited as data in the prompt. */
  sql: z
    .array(z.string().min(1).max(SCHEDULE_CONTEXT_SQL_MAX_CHARS).refine(isReadOnlySelect, 'each context query must be one read-only SELECT'))
    .max(SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS)
    .optional(),
  maxRows: z.int().min(1).max(SCHEDULE_CONTEXT_MAX_ROWS).default(SCHEDULE_CONTEXT_DEFAULT_ROWS),
});

/**
 * Steps are INDEPENDENT: no step's content enters another step's prompt or another
 * app's vendor (security F3). A multi-app task is several steps on one result page.
 *  - `notify` — *Remind me*: an inbox result, and a host-decided notification when the task's `alert` says so.
 *  - `app-run` — *Run [app]*: the app's own code in a hidden frame, fed `input` over the kv handshake (PR-B).
 *  - `app-think` — *Ask [app]'s AI*: the app's OWN transport, no tools, no connected calls; the reply is text.
 */
export const scheduleStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('notify'),
    title,
    body: z.string().min(1).max(SCHEDULE_NOTIFY_BODY_MAX_CHARS),
  }),
  z.strictObject({
    kind: z.literal('app-run'),
    appId,
    input: appInputSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('app-think'),
    appId,
    prompt: z.string().min(1).max(SCHEDULE_PROMPT_MAX_CHARS),
    context: thinkContextSchema,
  }),
]);
export type ScheduleStep = z.infer<typeof scheduleStepSchema>;

const stepsSchema = z.array(scheduleStepSchema).min(1).max(SCHEDULE_MAX_STEPS);

export const stepResultSchema = z.strictObject({
  status: z.enum(STEP_RESULT_STATUSES),
  summary: z.string().max(SCHEDULE_STEP_SUMMARY_MAX_CHARS).optional(),
  /** The named app is gone from this file — the step cannot run here. */
  appMissing: z.boolean().optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

// ---------------------------------------------------------------- the task

const appVersionsSchema = z
  .record(appId, z.int().min(1))
  .refine((versions) => Object.keys(versions).length <= SCHEDULE_MAX_APP_VERSIONS, `appVersions accepts at most ${SCHEDULE_MAX_APP_VERSIONS} entries`);

/**
 * A task — the `schedule:<taskId>` settings row. `enabled` is set by nothing but the
 * user's act (ADR-0074 §4); `ranThrough` is the latest due instant ever recorded and is
 * never pruned — the dedupe record that survives run-history pruning (E5).
 */
export const scheduledTaskSchema = z
  .strictObject({
    id,
    title,
    enabled: z.boolean(),
    enabledAt: isoInstant.optional(),
    provenance: z.enum(TASK_PROVENANCES),
    /** The app that proposed it (provenance `app`) — its steps may name only this app. */
    ownerAppId: appId.optional(),
    steps: stepsSchema,
    spec: scheduleSpecSchema,
    /** The engine's form, compiled from `spec` by the same write. Empty for a one-off. */
    cron: z.string().max(SCHEDULE_CRON_MAX_CHARS),
    startsAt: isoInstant.optional(),
    endsAt: isoInstant.optional(),
    missedPolicy: z.enum(MISSED_POLICIES),
    /** A missed occurrence older than this is auto-skipped with a history line, never asked. */
    staleAfterMs: z.int().min(SCHEDULE_STALE_AFTER_MS.min).max(SCHEDULE_STALE_AFTER_MS.max),
    alert: z.enum(ALERT_KINDS),
    /** Each named app's version at enable — a SHARED or AGENT update of one pauses the task (E8). */
    appVersions: appVersionsSchema,
    ranThrough: isoInstant.optional(),
    createdAt: isoInstant,
    updatedAt: isoInstant,
    pausedReason: z.enum(PAUSED_REASONS).optional(),
    consecutiveFailures: z.int().min(0).default(0),
    /** Results nobody opened — `seenAt` is set only by a user gesture (E7). */
    unseenResults: z.int().min(0).default(0),
  })
  .superRefine(refuseOversizeOrCredential('task', SCHEDULED_TASK_MAX_BYTES));
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

// ----------------------------------------------------------------- the run

/**
 * One pending data change: the app it is FOR, the statement, the AI's one-line reason, the
 * dry-run count. A run pools the items of every *Ask the AI* step it ran, and a task may ask
 * several apps, so each item names its own app (S4) — the approval card dry-runs and applies
 * it against THAT app's data, never the first step's.
 */
export const scheduleProposalItemSchema = z.strictObject({
  appId,
  sql: z.string().min(1).max(SCHEDULE_PROPOSAL_SQL_MAX_CHARS).refine(isSingleDmlStatement, 'a proposal is one INSERT, UPDATE or DELETE statement over literal values'),
  summary: z.string().max(SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS).optional(),
  counts: z.strictObject({ changes: z.int().min(0) }).optional(),
});
export type ScheduleProposalItem = z.infer<typeof scheduleProposalItemSchema>;

/**
 * The run's pending *changes waiting for your OK* — one expiry for the batch (one reply
 * produced them). NEVER executed by the engine; stripped on every import, pull and export
 * so a foreign file can never plant an approval card (ADR-0074 §6).
 */
const runProposalsSchema = z.strictObject({
  items: z.array(scheduleProposalItemSchema).max(SCHEDULE_PROPOSALS_PER_RUN),
  expiresAt: isoInstant,
});

const callsSchema = z.strictObject({ ai: z.int().min(0), net: z.int().min(0) });

/**
 * A run — one entry in the `scheduleRuns:<taskId>` row, keyed `(taskId, dueAt)`. It is
 * CLAIMED (`running`) before anything executes and finalised after; a `pending` row is a
 * persisted catch-up candidate; `collapsedCount` is how many missed occurrences it stands
 * for (ADR-0074 §5). `host` is which shell ran it — the honesty the UI reads back.
 */
export const scheduleRunSchema = z
  .strictObject({
    id,
    taskId: id,
    dueAt: isoInstant,
    trigger: z.enum(RUN_TRIGGERS),
    collapsedCount: z.int().min(1).default(1),
    status: z.enum(RUN_STATUSES),
    startedAt: isoInstant.optional(),
    finishedAt: isoInstant.optional(),
    host: z.strictObject({
      kind: z.enum(SCHEDULE_HOST_KINDS),
      binding: z.string().min(1).max(SCHEDULE_ID_MAX_CHARS).optional(),
    }),
    steps: z.array(stepResultSchema).max(SCHEDULE_MAX_STEPS),
    proposals: runProposalsSchema.optional(),
    calls: callsSchema.default({ ai: 0, net: 0 }),
    /** Set only by a user gesture — never by an app-derived signal (E7). */
    seenAt: isoInstant.optional(),
    /** Why a run ended short of `ok` in one line (`stale`, `paused`, `capped`, …). */
    reason: z.string().max(SCHEDULE_RUN_REASON_MAX_CHARS).optional(),
  })
  .superRefine(refuseOversizeOrCredential('run', SCHEDULE_RUN_MAX_BYTES));
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

// ------------------------------------------------------------ scheduler state

/**
 * The `schedulerState` row: the reconcile watermark (advanced only after every candidate
 * row is written), the global pause, and the daily counters the ceilings read. There is
 * deliberately NO leader seat — leadership is a runtime lock, not a persisted claim.
 */
export const schedulerStateSchema = z.strictObject({
  watermark: isoInstant,
  globalPause: z.boolean().default(false),
  daily: z.strictObject({
    date: isoDate,
    ai: z.int().min(0),
    net: z.int().min(0),
  }),
});
export type SchedulerState = z.infer<typeof schedulerStateSchema>;

// ----------------------------------------------------------------- proposal

/**
 * What the builder, the chat or an app may PROPOSE (ADR-0074 §4) — a title and the two
 * semantic fields. Nothing here sets `enabled`; every channel lands on the one consent
 * surface, and the user's act writes the task. An app's steps may name only the
 * proposer — that rule needs the sender's identity, so it lives at the strip, not here.
 */
export const scheduleProposalSchema = z
  .strictObject({
    title,
    steps: stepsSchema,
    spec: scheduleSpecSchema,
  })
  .superRefine(refuseOversizeOrCredential('proposal', SCHEDULED_TASK_MAX_BYTES));
export type ScheduleProposal = z.infer<typeof scheduleProposalSchema>;

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * The proposal's identity over its SEMANTIC fields only — `steps` and `spec`, key-sorted;
 * the title never enters the bytes, so a reworded suggestion for the same schedule is the
 * same suggestion (the per-app "already pending / already declined" dedupe, ADR-0074 §4).
 *
 * FNV-1a 64 over the canonical UTF-8, hex. SYNCHRONOUS on purpose, like
 * `canonicalRuntimeContract`: the strip decides "is this suggestion already pending?" in
 * a render path and a decline mutes by this key — an async digest would drag state
 * machinery into both. It is a dedupe key among at most a handful of proposals per app,
 * never a security boundary: the user's consent surface is the boundary, and it shows
 * the fields themselves, not the hash. Hash the PARSED proposal so defaults are in the bytes.
 */
export function proposalHash(proposal: ScheduleProposal): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sortKeysDeep({ steps: proposal.steps, spec: proposal.spec })));
  let hash = FNV64_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Canonical bytes for a task — key-sorted, whitespace-free JSON. Load-bearing for the
 * IMPORT GUARD (ADR-0074 §2): an imported task stays enabled only when these bytes match
 * a local task's. A canonical STRING, not a digest — the comparison is exact, needs no
 * async crypto, and has no collision surface (the `canonicalRuntimeContract` reasoning).
 */
export function canonicalScheduledTask(task: ScheduledTask): string {
  return JSON.stringify(sortKeysDeep(task));
}

/**
 * Canonical bytes of a task's INTENT — what will run, when, how it is caught up and
 * announced, and who asked for it — and nothing the engine writes on its own. The import
 * guard compares THESE (M4): `ranThrough`, `updatedAt`, the counters, the pause, `enabledAt`,
 * `appVersions` and `staleAfterMs` all move with ordinary use, so comparing the whole row
 * would demote every task of a backup taken before its next run. `enabled` is deliberately
 * out too: a backup restored over a task the user paused meanwhile restores the backup's
 * state, which is the same intent they consented to.
 */
export function canonicalScheduleIntent(task: ScheduledTask): string {
  const { steps, spec, cron, startsAt, endsAt, missedPolicy, alert, ownerAppId, provenance, title } = task;
  return JSON.stringify(sortKeysDeep({ steps, spec, cron, startsAt, endsAt, missedPolicy, alert, ownerAppId, provenance, title }));
}

// ---------------------------------------------------------------- read path

/**
 * The TOLERANT read path for a persisted row. Returns `undefined` rather than throwing on
 * anything unusable — a malformed `schedule:<id>` row must read as "no such task" so the
 * scheduler keeps ticking for every other task (the `parseRuntimeContract` posture). The
 * strict schema still decides what "usable" means; this only chooses the failure MODE.
 */
function tolerantRead<T>(schema: z.ZodType<T>, raw: string | null | undefined): T | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export function parseScheduledTask(raw: string | null | undefined): ScheduledTask | undefined {
  return tolerantRead(scheduledTaskSchema, raw);
}

export function parseScheduleRun(raw: string | null | undefined): ScheduleRun | undefined {
  return tolerantRead(scheduleRunSchema, raw);
}

export function parseSchedulerState(raw: string | null | undefined): SchedulerState | undefined {
  return tolerantRead(schedulerStateSchema, raw);
}

export function parseScheduleProposal(raw: string | null | undefined): ScheduleProposal | undefined {
  return tolerantRead(scheduleProposalSchema, raw);
}
