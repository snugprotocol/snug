// TASK-20261010-cross-app-access — AC1 (protocol frames) and AC2 (protocol records), ADR-0075
// §Decision 1–2. One `it` per clause of the task file's AC1/AC2; every bound at cap and cap+1;
// every refusal with its passing twin.
//
//  - The REQUEST (`snug:access-request`) is STRICT: it carries app-authored SQL and a release
//    act, so an unknown key is MALFORMED (R2's strict exception, the net pair's posture).
//  - The RESPONSE (`snug:access-response`) is TOLERANT (the db-response shape, D2/D16): nothing
//    in it becomes a real-world effect, and a strict host→app frame would make every reserved
//    growth seat (a future `access: 'write'`) a MAJOR bump because the SDK drops what
//    `parseFrame` rejects.
//  - The access-grant RECORD is strict at every level and byte-capped; a credential-shaped
//    purpose (or log `sql` seat) is a parse refusal through the ONE credential walk, now in
//    `record-guards.ts` (D8) and re-exported by `schedule.ts` unchanged.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_COLUMN_NAME_MAX_CHARS,
  ACCESS_DURATIONS,
  ACCESS_ENDED_RETENTION_MS,
  ACCESS_ERROR_CODES,
  ACCESS_GRANT_MAX_BYTES,
  ACCESS_GRANT_STATUSES,
  ACCESS_HINT_TABLES_MAX,
  ACCESS_HINT_WORDS_MAX,
  ACCESS_HINT_WORD_MAX_CHARS,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_LOG_KINDS,
  ACCESS_LOG_MAX_BYTES,
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_REASON_MAX_CHARS,
  ACCESS_LOG_SQL_MAX_CHARS,
  ACCESS_LOG_TOTAL_MAX_BYTES,
  ACCESS_MAX_COLUMNS,
  ACCESS_MAX_GRANTS,
  ACCESS_MAX_PARAMS,
  ACCESS_MAX_RESULT_BYTES,
  ACCESS_MAX_ROWS,
  ACCESS_MAX_TABLES,
  ACCESS_OPS,
  ACCESS_PARAM_STRING_MAX_CHARS,
  ACCESS_PROVENANCES,
  ACCESS_PURPOSE_MAX_CHARS,
  ACCESS_QUERY_RATE_PER_MINUTE,
  ACCESS_QUERY_TIMEOUT_MS,
  ACCESS_REQUEST_MIN_GAP_MS,
  ACCESS_SCOPED_CACHE_MS,
  ACCESS_SOURCE_MAX_BYTES,
  ACCESS_SQL_MAX_CHARS,
  ACCESS_SUSPEND_REASONS,
  ACCESS_TIMEOUT_STRIKES,
  FORBIDDEN_TOKEN_RULE,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  SINGLE_STATEMENT_RULE,
  accessGrantSchema,
  accessGrantViewSchema,
  accessLogEntrySchema,
  accessRequestHash,
  accessRequestSchema,
  accessResponseSchema,
  buildJsonSchemas,
  canonicalAccessGrantIntent,
  durationFromExpiry,
  durationToExpiry,
  findRecordCredential,
  findScheduleCredential,
  frameWithinLimits,
  isCredentialKeyName,
  isAccessErrorCode,
  isReadOnlySelect,
  parseAccessGrant,
  parseAccessLogEntry,
  parseFrame,
  type AccessGrant,
  type AccessRequestFrame,
  type Frame,
} from '../index.js';
import * as recordGuards from '../record-guards.js';
import * as schedule from '../schedule.js';

// ------------------------------------------------------------------ fixtures

const OPENAI_SHAPED_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const GRANT_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

const reqBase = { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: 'acc-1', instanceId: 'ins-1' } as const;
const respBase = { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: 'acc-1' } as const;

const askFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...reqBase,
  op: 'request',
  purpose: 'to show spending by category',
  ...over,
});
const queryFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...reqBase,
  op: 'query',
  grantId: GRANT_ID,
  sql: 'SELECT amount, category FROM transactions WHERE date > ?',
  ...over,
});
const listFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...reqBase, op: 'list', ...over });
const releaseFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...reqBase, op: 'release', grantId: GRANT_ID, ...over });

const view = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GRANT_ID,
  access: 'read',
  source: { displayName: 'Ledger', iconEmoji: '📒', iconColor: '#9891CE' },
  tables: [{ name: 'transactions', columns: ['amount', 'category', 'date', 'note'] }],
  duration: 'session',
  unattended: false,
  ...over,
});

const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GRANT_ID,
  readerAppId: 'budget',
  sourceAppId: 'ledger',
  scope: { tables: [{ name: 'transactions', columns: ['amount', 'category', 'date', 'note'] }] },
  access: 'read',
  purpose: 'to show spending by category',
  duration: { kind: 'until', at: '2026-10-17T09:00:00.000Z' },
  unattended: false,
  status: 'active',
  provenance: 'app',
  readerVersion: 12,
  grantedAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
  reads: 0,
  timeouts: 0,
  ...over,
});

const logEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: '2026-10-10T09:05:00.000Z',
  kind: 'read',
  grantId: GRANT_ID,
  readerAppId: 'budget',
  readerName: 'Budget',
  tables: ['transactions'],
  sql: 'SELECT amount, category FROM transactions',
  rows: 412,
  attended: true,
  ...over,
});

const parses = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const frameOk = (value: unknown): boolean => parseFrame(value).ok;
const isMalformed = (value: unknown): boolean => {
  const result = parseFrame(value);
  return !result.ok && result.ignored !== true && result.code === 'MALFORMED';
};
const utf8 = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const tablesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, columns: ['a'] }));
const columnsOf = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

/** Every code point the shared display-safety refinement refuses (task file + ADR-0075 §4). */
const REFUSED_CODE_POINTS: number[] = [
  ...Array.from({ length: 0x20 }, (_, i) => i), // C0 (incl. \t \n \r — single line)
  ...Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => 0x7f + i), // DEL + C1
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings/overrides
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, // zero-width
  // W1 fix lane (review findings 3, 7): the other invisible formats a purpose could hide text in
  0x00ad, 0x034f, 0x180e, // soft hyphen, combining grapheme joiner, Mongolian vowel separator
  0x2061, 0x2062, 0x2063, 0x2064, // invisible operators
  0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, // deprecated bidi-shaping controls
  0xfff9, 0xfffa, 0xfffb, // interlinear annotation
  0xe0001, 0xe0041, 0xe007f, // the tag block (invisible tag letters)
  0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, // blank-rendering fillers
];

/** Every Unicode format (Cf) code point the runtime knows — the rule must refuse each one (total, not enumerated). */
const FORMAT_CODE_POINTS: number[] = (() => {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (/\p{Cf}/u.test(String.fromCodePoint(cp))) out.push(cp);
  }
  return out;
})();

// ======================================================================== AC1

describe('AC1 — the frame-type literals and the constants table (Appendix B)', () => {
  it('FRAME_TYPES gains exactly the access pair', () => {
    expect(FRAME_TYPES.accessRequest).toBe('snug:access-request');
    expect(FRAME_TYPES.accessResponse).toBe('snug:access-response');
  });

  it('every ACCESS_* constant carries the value the task file pins', () => {
    expect(ACCESS_OPS).toEqual(['request', 'query', 'list', 'release']);
    expect(ACCESS_PURPOSE_MAX_CHARS).toBe(200);
    expect([ACCESS_HINT_WORDS_MAX, ACCESS_HINT_WORD_MAX_CHARS, ACCESS_HINT_TABLES_MAX]).toEqual([16, 32, 16]);
    expect([ACCESS_MAX_TABLES, ACCESS_MAX_COLUMNS, ACCESS_COLUMN_NAME_MAX_CHARS]).toEqual([32, 64, 64]);
    expect([ACCESS_SQL_MAX_CHARS, ACCESS_MAX_PARAMS, ACCESS_PARAM_STRING_MAX_CHARS]).toEqual([4096, 64, 4096]);
    expect([ACCESS_MAX_ROWS, ACCESS_MAX_RESULT_BYTES]).toEqual([500, 196_608]);
    expect(ACCESS_MAX_RESULT_BYTES).toBeLessThan(LIMITS.MAX_FRAME_BYTES);
    expect(ACCESS_QUERY_TIMEOUT_MS).toBe(2000);
    expect(ACCESS_SOURCE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(ACCESS_SCOPED_CACHE_MS).toBe(10_000);
    expect([ACCESS_GRANT_MAX_BYTES, ACCESS_MAX_GRANTS, ACCESS_ENDED_RETENTION_MS]).toEqual([16 * 1024, 100, 30 * 86_400_000]);
    expect([ACCESS_LOG_MAX_ENTRIES, ACCESS_LOG_MAX_BYTES, ACCESS_LOG_TOTAL_MAX_BYTES, ACCESS_LOG_SQL_MAX_CHARS, ACCESS_LOG_COALESCE_MS]).toEqual([
      200,
      64 * 1024,
      1024 * 1024,
      200,
      60_000,
    ]);
    expect(ACCESS_LOG_REASON_MAX_CHARS).toBe(120);
    expect([ACCESS_REQUEST_MIN_GAP_MS, ACCESS_QUERY_RATE_PER_MINUTE, ACCESS_TIMEOUT_STRIKES]).toEqual([10_000, 60, 3]);
    expect(ACCESS_DURATIONS).toEqual(['session', 'day', 'week', 'always']);
    expect(ACCESS_GRANT_STATUSES).toEqual(['active', 'revoked', 'suspended']);
    expect(ACCESS_SUSPEND_REASONS).toEqual(['imported', 'reader-updated', 'source-changed', 'source-restricted', 'reader-misbehaved']);
    expect(ACCESS_PROVENANCES).toEqual(['app', 'user']);
    expect(ACCESS_LOG_KINDS).toEqual(['granted', 'read', 'refused', 'revoked', 'expired', 'released', 'suspended']);
    expect(ACCESS_CHANGED_EVENT).toBe('access-changed');
  });

  it('ACCESS_ERROR_CODES is exactly the twelve Appendix A codes (open-string wire rule, R5)', () => {
    expect(Object.keys(ACCESS_ERROR_CODES).sort()).toEqual(
      [
        'ACCESS_INVALID_REQUEST',
        'ACCESS_NOT_GRANTED',
        'ACCESS_DECLINED',
        'ACCESS_PENDING',
        'ACCESS_UNATTENDED',
        'ACCESS_NO_SOURCES',
        'ACCESS_REVOKED',
        'ACCESS_EXPIRED',
        'ACCESS_QUERY_REFUSED',
        'ACCESS_QUERY_FAILED',
        'ACCESS_RATE_LIMITED',
        'ACCESS_SIZE_EXCEEDED',
      ].sort(),
    );
    for (const [key, value] of Object.entries(ACCESS_ERROR_CODES)) expect(value).toBe(key);
    expect(isAccessErrorCode('ACCESS_REVOKED')).toBe(true);
    expect(isAccessErrorCode('NET_NOT_APPROVED')).toBe(false);
    expect(isAccessErrorCode('')).toBe(false);
  });

  it('durationToExpiry: a day and a week are absolute instants; the session grant and "until I stop it" have none', () => {
    const now = Date.parse('2026-10-10T09:00:00.000Z');
    expect(durationToExpiry('day', now)).toBe('2026-10-11T09:00:00.000Z');
    expect(durationToExpiry('week', now)).toBe('2026-10-17T09:00:00.000Z');
    expect(durationToExpiry('session', now)).toBeUndefined();
    expect(durationToExpiry('always', now)).toBeUndefined();
  });

  // W6 finding 18 — the inverse lives beside the forward map, derived from the same spans, so an
  // engine never re-derives "which duration was this" with a threshold of its own.
  it('durationFromExpiry inverts durationToExpiry for every expiring duration, and reads a hand-written span as the NEAREST one', () => {
    const now = Date.parse('2026-10-10T09:00:00.000Z');
    const granted = new Date(now).toISOString();
    for (const kind of ['day', 'week'] as const) expect(durationFromExpiry(granted, durationToExpiry(kind, now)!)).toBe(kind);
    const at = (days: number): string => new Date(now + days * 86_400_000).toISOString();
    expect(durationFromExpiry(granted, at(2))).toBe('day');
    expect(durationFromExpiry(granted, at(5))).toBe('week');
    expect(durationFromExpiry(granted, at(30))).toBe('week');
  });
});

describe('AC1 — parseFrame admits every access-request op and every access-response variant', () => {
  it('admits op "request" — bare, and with hints and renew', () => {
    expect(frameOk(askFrame())).toBe(true);
    expect(frameOk(askFrame({ hints: { words: ['spending', 'category'], tables: ['transactions'] }, renew: GRANT_ID }))).toBe(true);
    expect(frameOk(askFrame({ hints: {} }))).toBe(true);
    const parsed = parseFrame(askFrame());
    expect(parsed.ok && parsed.frame.type).toBe(FRAME_TYPES.accessRequest);
  });

  it('admits op "query" (with and without params), "list" and "release"', () => {
    expect(frameOk(queryFrame())).toBe(true);
    expect(frameOk(queryFrame({ params: ['2026-01-01', 3, 2.5, true, false, null] }))).toBe(true);
    expect(frameOk(listFrame())).toBe(true);
    expect(frameOk(releaseFrame())).toBe(true);
    expect(accessRequestSchema.options.map((option) => option.shape.op.value)).toEqual([...ACCESS_OPS]);
  });

  it('refuses an unknown op and a missing per-op seat (parse, don\'t check)', () => {
    expect(isMalformed(askFrame({ op: 'discover' }))).toBe(true);
    expect(isMalformed(queryFrame({ sql: undefined }))).toBe(true);
    expect(isMalformed(queryFrame({ grantId: undefined }))).toBe(true);
    expect(isMalformed(releaseFrame({ grantId: undefined }))).toBe(true);
    expect(isMalformed(askFrame({ purpose: undefined }))).toBe(true);
    expect(isMalformed(askFrame({ instanceId: undefined }))).toBe(true);
  });

  it('admits every access-response variant: request, query, list, release, error', () => {
    expect(frameOk({ ...respBase, ok: true, op: 'request', grant: view() })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'request', grant: view({ duration: 'week', expiresAt: '2026-10-17T09:00:00.000Z', unattended: true }) })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'query', columns: ['amount'], rows: [[12.5], [null]] })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'query', columns: ['amount'], rows: [], truncated: true, totalRows: 900 })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'list', grants: [] })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'list', grants: [view(), view({ id: 'other' })] })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'release' })).toBe(true);
    expect(
      frameOk({ ...respBase, ok: false, error: { code: ACCESS_ERROR_CODES.ACCESS_REVOKED, message: 'access was stopped', retryable: false } }),
    ).toBe(true);
    // An unknown future code still parses (R5 open string).
    expect(frameOk({ ...respBase, ok: false, error: { code: 'ACCESS_SOMETHING_NEW', message: 'x', retryable: true } })).toBe(true);
  });
});

describe('AC1 — the REQUEST is strict; the RESPONSE is tolerant', () => {
  it('an unknown key on every request op is MALFORMED (strictObject), including inside hints', () => {
    expect(isMalformed(askFrame({ appId: 'evil' }))).toBe(true);
    expect(isMalformed(queryFrame({ access: 'write' }))).toBe(true);
    expect(isMalformed(listFrame({ sourceAppId: 'ledger' }))).toBe(true);
    expect(isMalformed(releaseFrame({ extra: 1 }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: ['a'], apps: ['ledger'] } }))).toBe(true);
    // The passing twins.
    expect(frameOk(askFrame())).toBe(true);
    expect(frameOk(listFrame())).toBe(true);
  });

  it('an unknown key on the response still parses (the db-response shape), at the top and inside a grant view', () => {
    expect(frameOk({ ...respBase, ok: true, op: 'release', futureSeat: { a: 1 } })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'query', columns: [], rows: [], cursor: 'next' })).toBe(true);
    expect(frameOk({ ...respBase, ok: true, op: 'request', grant: view({ futureField: 1, source: { displayName: 'Ledger', badge: 'x' } }) })).toBe(true);
  });

  it('a list answer carrying a future access: "write" grant still parses (the reserved seat is not a MAJOR bump)', () => {
    expect(frameOk({ ...respBase, ok: true, op: 'list', grants: [view(), view({ access: 'write', writeScope: ['transactions'] })] })).toBe(true);
  });

  it('the response still refuses what it knows is wrong (tolerant of keys, not of shapes)', () => {
    expect(isMalformed({ ...respBase, ok: true, op: 'query', columns: ['a'], rows: 'not rows' })).toBe(true);
    expect(isMalformed({ ...respBase, ok: true, op: 'list' })).toBe(true);
    expect(isMalformed({ ...respBase, ok: true, op: 'request' })).toBe(true);
    expect(isMalformed({ ...respBase, ok: false })).toBe(true);
    expect(isMalformed({ ...respBase, ok: true, op: 'request', grant: view({ duration: 'forever' }) })).toBe(true);
    expect(isMalformed({ ...respBase, ok: true, op: 'request', grant: view({ unattended: undefined }) })).toBe(true);
  });
});

describe('AC1 — bounds hold at cap and refuse at cap+1', () => {
  it('purpose: 1..200 characters', () => {
    expect(frameOk(askFrame({ purpose: 'p'.repeat(ACCESS_PURPOSE_MAX_CHARS) }))).toBe(true);
    expect(isMalformed(askFrame({ purpose: 'p'.repeat(ACCESS_PURPOSE_MAX_CHARS + 1) }))).toBe(true);
    expect(isMalformed(askFrame({ purpose: '' }))).toBe(true);
    expect(isMalformed(askFrame({ purpose: '   ' }))).toBe(true);
  });

  it('hint words: at most 16, each 1..32 characters', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
    expect(frameOk(askFrame({ hints: { words: words(ACCESS_HINT_WORDS_MAX) } }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: words(ACCESS_HINT_WORDS_MAX + 1) } }))).toBe(true);
    expect(frameOk(askFrame({ hints: { words: ['w'.repeat(ACCESS_HINT_WORD_MAX_CHARS)] } }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: ['w'.repeat(ACCESS_HINT_WORD_MAX_CHARS + 1)] } }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: [''] } }))).toBe(true);
  });

  it('hint tables: at most 16, each an app object name (APP_OBJECT_NAME_RULE; never snug_kv or a reserved prefix)', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(frameOk(askFrame({ hints: { tables: names(ACCESS_HINT_TABLES_MAX) } }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { tables: names(ACCESS_HINT_TABLES_MAX + 1) } }))).toBe(true);
    expect(frameOk(askFrame({ hints: { tables: ['transactions', 'T_2'] } }))).toBe(true);
    for (const bad of ['1abc', 'has space', 'semi;colon', 'x'.repeat(42), 'snug_kv', 'snug_apps', 'sqlite_master', 'app_abc__t', '']) {
      expect(isMalformed(askFrame({ hints: { tables: [bad] } })), bad).toBe(true);
    }
  });

  it('the query sql refuses bidi controls and stray C0/C1 controls; tabs and newlines pass (review finding 9)', () => {
    for (const sql of ['SELECT 1 \u202E', 'SELECT 1 \u2067x\u2069', 'SELECT 1 \u200E', 'SELECT 1 \u0007', 'SELECT 1 \u001b[0m', 'SELECT 1 \u0090']) {
      expect(isMalformed(queryFrame({ sql })), JSON.stringify(sql)).toBe(true);
    }
    expect(frameOk(queryFrame({ sql: 'SELECT amount,\n\tcategory\r\nFROM transactions' }))).toBe(true);
    expect(frameOk(queryFrame({ sql: "SELECT * FROM t WHERE note = ?", params: ['\u202E is fine in a bound value'] }))).toBe(true);
  });

  it('sql: 1..4096 characters', () => {
    const select = (chars: number) => `SELECT '${'x'.repeat(chars - "SELECT ''".length)}'`;
    expect(select(ACCESS_SQL_MAX_CHARS)).toHaveLength(ACCESS_SQL_MAX_CHARS);
    expect(frameOk(queryFrame({ sql: select(ACCESS_SQL_MAX_CHARS) }))).toBe(true);
    expect(isMalformed(queryFrame({ sql: select(ACCESS_SQL_MAX_CHARS + 1) }))).toBe(true);
    expect(isMalformed(queryFrame({ sql: '' }))).toBe(true);
  });

  it('params: at most 64 scalars — string (≤ 4096) · number · boolean · null', () => {
    expect(frameOk(queryFrame({ params: Array.from({ length: ACCESS_MAX_PARAMS }, (_, i) => i) }))).toBe(true);
    expect(isMalformed(queryFrame({ params: Array.from({ length: ACCESS_MAX_PARAMS + 1 }, (_, i) => i) }))).toBe(true);
    expect(frameOk(queryFrame({ params: ['s'.repeat(ACCESS_PARAM_STRING_MAX_CHARS)] }))).toBe(true);
    expect(isMalformed(queryFrame({ params: ['s'.repeat(ACCESS_PARAM_STRING_MAX_CHARS + 1)] }))).toBe(true);
    for (const bad of [{ a: 1 }, [1], undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isMalformed(queryFrame({ params: [bad] })), String(bad)).toBe(true);
    }
    expect(frameOk(queryFrame({ params: [] }))).toBe(true);
  });

  it('a grant view carries 1..32 tables, each with 1..64 columns', () => {
    const ask = (tables: unknown) => ({ ...respBase, ok: true, op: 'request', grant: view({ tables }) });
    expect(frameOk(ask(tablesOf(ACCESS_MAX_TABLES)))).toBe(true);
    expect(isMalformed(ask(tablesOf(ACCESS_MAX_TABLES + 1)))).toBe(true);
    expect(isMalformed(ask([]))).toBe(true);
    expect(frameOk(ask([{ name: 'transactions', columns: columnsOf(ACCESS_MAX_COLUMNS) }]))).toBe(true);
    expect(isMalformed(ask([{ name: 'transactions', columns: columnsOf(ACCESS_MAX_COLUMNS + 1) }]))).toBe(true);
  });
});

describe('AC1 — purpose and hint words: a single line, no controls, no bidi overrides, no zero-width characters', () => {
  it('refuses every C0/C1 control, bidi override/isolate and zero-width character — in the purpose and in a hint word', () => {
    for (const cp of REFUSED_CODE_POINTS) {
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      expect(isMalformed(askFrame({ purpose: `to show${ch}spending` })), `purpose ${label}`).toBe(true);
      expect(isMalformed(askFrame({ hints: { words: [`spend${ch}ing`] } })), `word ${label}`).toBe(true);
    }
  });

  it('refuses the line and paragraph separators and the invisible bidi marks too (single line; stricter reading)', () => {
    for (const cp of [0x2028, 0x2029, 0x200e, 0x200f, 0x061c]) {
      expect(isMalformed(askFrame({ purpose: `a${String.fromCodePoint(cp)}b` })), cp.toString(16)).toBe(true);
    }
  });

  it('refuses EVERY Unicode format (Cf) code point — the rule is total, not an enumerated list (review finding 7)', () => {
    expect(FORMAT_CODE_POINTS.length).toBeGreaterThanOrEqual(150);
    for (const cp of FORMAT_CODE_POINTS) {
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      expect(isMalformed(askFrame({ purpose: `to show${ch}spending` })), `purpose ${label}`).toBe(true);
      expect(isMalformed(askFrame({ hints: { words: [`spend${ch}ing`] } })), `word ${label}`).toBe(true);
    }
  });

  it('a purpose made only of a blank-rendering filler is refused like a blank one (review finding 7)', () => {
    for (const blank of ['\u2800', '\u3164', '\uffa0', '\u115f\u1160']) {
      expect(isMalformed(askFrame({ purpose: blank })), blank.codePointAt(0)?.toString(16)).toBe(true);
    }
    expect(isMalformed(askFrame({ purpose: '   ' }))).toBe(true);
  });

  it('refuses leading or trailing whitespace — the shown quote is exactly the stored bytes (review finding 10)', () => {
    expect(isMalformed(askFrame({ purpose: '  to show spending  ' }))).toBe(true);
    expect(isMalformed(askFrame({ purpose: 'to show spending ' }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: ['spending '] } }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: [' spending'] } }))).toBe(true);
    expect(parses(accessGrantSchema, grant({ purpose: ' to show spending' }))).toBe(false);
    expect(frameOk(askFrame({ purpose: 'to show  spending', hints: { words: ['spending'] } }))).toBe(true);
  });

  it('the passing twins: ordinary text in any script, emoji and punctuation', () => {
    for (const purpose of [
      'to show spending by category',
      'pour afficher les dépenses — par catégorie',
      '按类别显示支出',
      'لعرض الإنفاق حسب الفئة',
      'budget 💸 (monthly) "totals", 50% off?',
      // W1 fix lane: the total Cc/Cf rule must not catch ordinary scripts or emoji modifiers
      'खर्च श्रेणी के अनुसार दिखाने के लिए',
      '카테고리별 지출 보기',
      'להציג הוצאות לפי קטגוריה',
      'love it ❤️ 👍🏽 🇬🇧 🇯🇵',
    ]) {
      expect(frameOk(askFrame({ purpose })), purpose).toBe(true);
    }
    expect(frameOk(askFrame({ hints: { words: ['dépenses', '支出', '💸'] } }))).toBe(true);
  });

  it('a credential-shaped purpose or hint word is refused at the frame too (it would be shown, then persisted)', () => {
    expect(isMalformed(askFrame({ purpose: `use ${OPENAI_SHAPED_KEY} to read` }))).toBe(true);
    expect(isMalformed(askFrame({ purpose: 'see https://alice:hunter2@example.com/x' }))).toBe(true);
    expect(isMalformed(askFrame({ hints: { words: [OPENAI_SHAPED_KEY.slice(0, 32)] } }))).toBe(true);
  });
});

describe('AC1 — host-ready advertises access optionally', () => {
  const ready = (capabilities: Record<string, unknown>) => ({
    v: PROTOCOL_VERSION,
    type: FRAME_TYPES.hostReady,
    instanceId: 'ins-1',
    protocolVersions: [1],
    capabilities,
    theme: 'light',
  });

  it('a 1.0 ready frame (no access key) still parses; access true/false parses; a non-boolean is MALFORMED', () => {
    expect(frameOk(ready({ streaming: true, db: true, auth: false, net: true, openUrl: true }))).toBe(true);
    expect(frameOk(ready({ streaming: true, db: true, auth: false, access: true }))).toBe(true);
    expect(frameOk(ready({ streaming: true, db: true, auth: false, access: false }))).toBe(true);
    expect(isMalformed(ready({ streaming: true, db: true, auth: false, access: 'yes' }))).toBe(true);
  });
});

describe('AC1 — frameWithinLimits keeps both access frames in the 256 KiB class', () => {
  it('a query response of exactly MAX_FRAME_BYTES passes; one byte more is refused (not the db or net class)', () => {
    const frameOf = (cell: string): Frame => {
      const parsed = parseFrame({ ...respBase, ok: true, op: 'query', columns: ['note'], rows: [[cell]] });
      if (!parsed.ok) throw new Error('fixture must parse');
      return parsed.frame;
    };
    const base = utf8(frameOf(''));
    const atCap = frameOf('x'.repeat(LIMITS.MAX_FRAME_BYTES - base));
    expect(utf8(atCap)).toBe(LIMITS.MAX_FRAME_BYTES);
    expect(frameWithinLimits(atCap)).toBe(true);
    const over = frameOf('x'.repeat(LIMITS.MAX_FRAME_BYTES - base + 1));
    expect(frameWithinLimits(over)).toBe(false);
    // Well inside the db/net classes — proving the access pair is NOT routed to either.
    expect(utf8(over)).toBeLessThan(LIMITS.MAX_NET_FRAME_BYTES);
  });

  it('a query request of exactly MAX_FRAME_BYTES passes; one byte more is refused', () => {
    const frameOf = (last: string): Frame => {
      const params = [...Array.from({ length: ACCESS_MAX_PARAMS - 1 }, () => 'p'.repeat(ACCESS_PARAM_STRING_MAX_CHARS)), last];
      const parsed = parseFrame(queryFrame({ params }));
      if (!parsed.ok) throw new Error('fixture must parse');
      return parsed.frame;
    };
    const room = LIMITS.MAX_FRAME_BYTES - utf8(frameOf(''));
    expect(room).toBeGreaterThan(0);
    expect(room + 1).toBeLessThanOrEqual(ACCESS_PARAM_STRING_MAX_CHARS);
    expect(frameWithinLimits(frameOf('x'.repeat(room)))).toBe(true);
    expect(frameWithinLimits(frameOf('x'.repeat(room + 1)))).toBe(false);
  });
});

describe('AC1 — buildJsonSchemas() publishes the access pair: request strict, response tolerant — sixteen files', () => {
  const objectNodes = (node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
    if (Array.isArray(node)) node.forEach((child) => objectNodes(child, out));
    else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (record.type === 'object') out.push(record);
      Object.values(record).forEach((child) => objectNodes(child, out));
    }
    return out;
  };

  it('sixteen files, the access pair among them', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names).toHaveLength(16);
    expect(names).toContain('access-request.json');
    expect(names).toContain('access-response.json');
  });

  it('access-request.json: every object (each op variant and hints) carries additionalProperties: false', () => {
    const exported = JSON.parse(buildJsonSchemas()['access-request.json'] ?? 'null') as unknown;
    const objects = objectNodes(exported);
    expect(objects.length).toBeGreaterThanOrEqual(5); // four op variants + hints
    for (const object of objects) expect(object.additionalProperties).toBe(false);
  });

  it('access-response.json: no object closes additionalProperties (tolerant, the db-response shape)', () => {
    const exported = JSON.parse(buildJsonSchemas()['access-response.json'] ?? 'null') as unknown;
    const objects = objectNodes(exported);
    expect(objects.length).toBeGreaterThanOrEqual(5);
    for (const object of objects) expect(object.additionalProperties).not.toBe(false);
  });
});

// ======================================================================== AC2

describe('AC2 — accessGrantSchema: strict at every level', () => {
  it('parses a well-formed grant and carries scope.tables[].columns, unattended, status and suspendedReason', () => {
    const parsed = accessGrantSchema.parse(grant({ unattended: true, status: 'suspended', suspendedReason: 'reader-updated' }));
    expect(parsed.scope.tables[0]?.columns).toEqual(['amount', 'category', 'date', 'note']);
    expect(parsed.unattended).toBe(true);
    expect(parsed.status).toBe('suspended');
    expect(parsed.suspendedReason).toBe('reader-updated');
    expect(parses(accessGrantSchema, grant({ duration: { kind: 'always' } }))).toBe(true);
    expect(parses(accessGrantSchema, grant({ provenance: 'user' }))).toBe(true);
  });

  it('an unknown key at the root, in scope, in a scope table, or in the duration is refused', () => {
    expect(parses(accessGrantSchema, grant({ extra: 1 }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ scope: { tables: [{ name: 't', columns: ['a'] }], rowFilter: 'x' } }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ scope: { tables: [{ name: 't', columns: ['a'], where: '1' }] } }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ duration: { kind: 'always', at: '2026-10-17T09:00:00.000Z' } }))).toBe(false);
    expect(parses(accessGrantSchema, grant())).toBe(true);
  });

  it('access is a one-member enum: "write" is refused in the RECORD (the view is tolerant; the record is not)', () => {
    expect(parses(accessGrantSchema, grant({ access: 'write' }))).toBe(false);
  });

  it('a session grant never persists, and "expired" is derived, never a stored status', () => {
    expect(parses(accessGrantSchema, grant({ duration: { kind: 'session' } }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ status: 'expired' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ duration: { kind: 'until', at: 'next tuesday' } }))).toBe(false);
  });

  it('status and its reasons agree: suspended ⇔ suspendedReason; revoked ⇔ revokedAt (stricter reading)', () => {
    expect(parses(accessGrantSchema, grant({ status: 'suspended' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ status: 'active', suspendedReason: 'imported' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ status: 'suspended', suspendedReason: 'not-a-reason' }))).toBe(false);
    for (const reason of ACCESS_SUSPEND_REASONS) {
      expect(parses(accessGrantSchema, grant({ status: 'suspended', suspendedReason: reason })), reason).toBe(true);
    }
    expect(parses(accessGrantSchema, grant({ status: 'revoked' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ status: 'active', revokedAt: '2026-10-12T09:00:00.000Z' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ status: 'revoked', revokedAt: '2026-10-12T09:00:00.000Z' }))).toBe(true);
  });

  it('id is a uuid v4 (the crypto.randomUUID() shape, lowercase); anything else is refused', () => {
    expect(parses(accessGrantSchema, grant({ id: crypto.randomUUID() }))).toBe(true);
    expect(parses(accessGrantSchema, grant({ id: GRANT_ID.toUpperCase() }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ id: '3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b' }))).toBe(false); // v1
    expect(parses(accessGrantSchema, grant({ id: '3f2b8c1e-9a4d-4e6f-7b2a-1c3d5e7f9a0b' }))).toBe(false); // bad variant
    expect(parses(accessGrantSchema, grant({ id: 'grant-1' }))).toBe(false);
  });

  it('a reader never holds a grant on itself; app ids are bounded 1..64', () => {
    expect(parses(accessGrantSchema, grant({ sourceAppId: 'budget' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ readerAppId: 'r'.repeat(64) }))).toBe(true);
    expect(parses(accessGrantSchema, grant({ readerAppId: 'r'.repeat(65) }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ sourceAppId: '' }))).toBe(false);
  });

  it('readerVersion ≥ 1; reads and timeouts default to 0 and are never negative', () => {
    expect(parses(accessGrantSchema, grant({ readerVersion: 0 }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ readerVersion: 1.5 }))).toBe(false);
    const { reads: _reads, timeouts: _timeouts, ...bare } = grant();
    const parsed = accessGrantSchema.parse(bare);
    expect([parsed.reads, parsed.timeouts]).toEqual([0, 0]);
    expect(parses(accessGrantSchema, grant({ reads: -1 }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ timeouts: -1 }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ reads: 14, lastReadAt: '2026-10-10T09:05:00.000Z' }))).toBe(true);
  });
});

describe('AC2 — the scope: tables with their frozen columns', () => {
  const scoped = (tables: unknown) => grant({ scope: { tables } });

  it('1..32 tables per grant, 1..64 columns per table, each column 1..64 characters', () => {
    expect(parses(accessGrantSchema, scoped(tablesOf(ACCESS_MAX_TABLES)))).toBe(true);
    expect(parses(accessGrantSchema, scoped(tablesOf(ACCESS_MAX_TABLES + 1)))).toBe(false);
    expect(parses(accessGrantSchema, scoped([]))).toBe(false);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: columnsOf(ACCESS_MAX_COLUMNS) }]))).toBe(true);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: columnsOf(ACCESS_MAX_COLUMNS + 1) }]))).toBe(false);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: [] }]))).toBe(false);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: ['c'.repeat(ACCESS_COLUMN_NAME_MAX_CHARS)] }]))).toBe(true);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: ['c'.repeat(ACCESS_COLUMN_NAME_MAX_CHARS + 1)] }]))).toBe(false);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: [''] }]))).toBe(false);
  });

  it('table names follow APP_OBJECT_NAME_RULE; snug_kv is NEVER shareable, nor any reserved prefix', () => {
    expect(parses(accessGrantSchema, scoped([{ name: 'transactions', columns: ['a'] }]))).toBe(true);
    for (const bad of ['snug_kv', 'SNUG_KV', 'snug_settings', 'sqlite_master', 'app_x__t', '1t', 'a b', 'x'.repeat(42)]) {
      expect(parses(accessGrantSchema, scoped([{ name: bad, columns: ['a'] }])), bad).toBe(false);
    }
  });

  it('a table appears once and a column once per table (stricter reading — a duplicate is a malformed scope)', () => {
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: ['a'] }, { name: 't', columns: ['b'] }]))).toBe(false);
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: ['a', 'a'] }]))).toBe(false);
  });

  it('a credential-named column is NEVER in a scope (D14/Q2; review findings 4 and 11) — the ONE rule is security.isCredentialKeyName', () => {
    for (const bad of ['api_key', 'password', 'token', 'secret', 'access_token', 'Authorization']) {
      expect(parses(accessGrantSchema, scoped([{ name: 't', columns: ['amount', bad] }])), bad).toBe(false);
      expect(isCredentialKeyName(bad), bad).toBe(true);
    }
    // The passing twins: ordinary columns, and names that merely CONTAIN "token" or "id" in a non-credential shape.
    expect(parses(accessGrantSchema, scoped([{ name: 't', columns: ['amount', 'note', 'token_count', 'tokenizer', 'id', 'user_id'] }]))).toBe(true);
    // The tolerant VIEW does not refuse (a host never sends one — the record stops it at the write boundary).
    expect(accessGrantViewSchema.safeParse(view({ tables: [{ name: 't', columns: ['api_key'] }] })).success).toBe(true);
  });
});

describe('AC2 — the serialised grant is capped at 16 KiB', () => {
  /** A valid grant whose serialised UTF-8 form is exactly `target` bytes (columns to fill, the purpose to fine-tune). */
  const grantOfBytes = (target: number): Record<string, unknown> => {
    const tables: { name: string; columns: string[] }[] = [];
    const make = (purpose: string) => grant({ purpose, scope: { tables } });
    for (let i = 0; ; i += 1) {
      const last = tables[tables.length - 1];
      const table = last && last.columns.length < ACCESS_MAX_COLUMNS ? last : { name: `t${tables.length}`, columns: [] as string[] };
      if (table !== last) tables.push(table);
      table.columns.push(`c${String(i).padStart(4, '0')}`.padEnd(ACCESS_COLUMN_NAME_MAX_CHARS, 'x'));
      if (utf8(make('p')) > target) {
        table.columns.pop();
        if (table.columns.length === 0) tables.pop();
        break;
      }
    }
    const room = target - utf8(make('p'));
    return make('p'.repeat(1 + room));
  };

  it('exactly ACCESS_GRANT_MAX_BYTES passes; one byte more refuses', () => {
    const atCap = grantOfBytes(ACCESS_GRANT_MAX_BYTES);
    expect(utf8(atCap)).toBe(ACCESS_GRANT_MAX_BYTES);
    expect(parses(accessGrantSchema, atCap)).toBe(true);
    const over = grantOfBytes(ACCESS_GRANT_MAX_BYTES + 1);
    expect(utf8(over)).toBe(ACCESS_GRANT_MAX_BYTES + 1);
    expect(parses(accessGrantSchema, over)).toBe(false);
  });
});

describe('AC2 — a credential-shaped purpose is a parse refusal (the ONE walk, record-guards.findRecordCredential)', () => {
  it('refuses a provider key, a Bearer value, a JWT and a userinfo URL in the purpose', () => {
    expect(parses(accessGrantSchema, grant({ purpose: `use ${OPENAI_SHAPED_KEY} to read` }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ purpose: 'Bearer abcdef123456' }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ purpose: `token ${JWT.slice(0, 120)}` }))).toBe(false);
    expect(parses(accessGrantSchema, grant({ purpose: 'see https://alice:hunter2@example.com/x' }))).toBe(false);
    expect(findRecordCredential(grant({ purpose: `use ${OPENAI_SHAPED_KEY} now` }))).toEqual({ path: 'purpose', reason: 'known-key-prefix' });
  });

  it('the passing twin: an ordinary purpose (even one naming tokens and keys in words) parses', () => {
    expect(parses(accessGrantSchema, grant({ purpose: 'to count game tokens by key colour' }))).toBe(true);
    expect(findRecordCredential(grant())).toBeUndefined();
  });

  it('schedule.ts re-exports the walk and the read-only guard unchanged — the SAME functions', () => {
    expect(findScheduleCredential).toBe(findRecordCredential);
    expect(schedule.findScheduleCredential).toBe(recordGuards.findRecordCredential);
    expect(isReadOnlySelect).toBe(recordGuards.isReadOnlySelect);
    expect(schedule.isReadOnlySelect).toBe(recordGuards.isReadOnlySelect);
    expect(SINGLE_STATEMENT_RULE).toBe(recordGuards.SINGLE_STATEMENT_RULE);
    expect(FORBIDDEN_TOKEN_RULE).toBe(recordGuards.FORBIDDEN_TOKEN_RULE);
    expect(SINGLE_STATEMENT_RULE.test('SELECT 1;')).toBe(true);
    expect(SINGLE_STATEMENT_RULE.test('SELECT 1; SELECT 2')).toBe(false);
    expect(FORBIDDEN_TOKEN_RULE.test("ATTACH 'x' AS y")).toBe(true);
    expect(FORBIDDEN_TOKEN_RULE.test("SELECT * FROM pragma_table_info('t')")).toBe(false);
  });

  it('the walk sees a credential inside a quoted SQL literal or after "=" (the log\'s sql seat is SQL, not prose)', () => {
    expect(findRecordCredential({ sql: `SELECT * FROM t WHERE k = '${OPENAI_SHAPED_KEY}'` })?.reason).toBe('known-key-prefix');
    expect(findRecordCredential({ sql: `SELECT * FROM t WHERE k='${OPENAI_SHAPED_KEY}'` })?.reason).toBe('known-key-prefix');
    expect(findRecordCredential({ sql: `SELECT * FROM t WHERE k IN ("${JWT}")` })?.reason).toBe('jwt-shape');
    expect(findRecordCredential({ sql: "SELECT note FROM t WHERE note = 'pay the bearer'" })).toBeUndefined();
  });

  it('the walk sees a credential glued by an operator or separator (review finding 8)', () => {
    const KEY = OPENAI_SHAPED_KEY;
    for (const text of [
      `key:${KEY}`,
      `SELECT * FROM t WHERE k>'${KEY}'`,
      `SELECT * FROM t WHERE k<'${KEY}'`,
      `SELECT * FROM t WHERE k<>'${KEY}'`,
      `SELECT * FROM t WHERE k||'${KEY}'`,
      `SELECT 1;${KEY}`,
      `SELECT * FROM t WHERE k LIKE '%${KEY}%'`,
      `a|${KEY}`,
    ]) {
      expect(findRecordCredential({ sql: text })?.reason, text).toBe('known-key-prefix');
    }
    expect(findRecordCredential({ sql: `token:${JWT}` })?.reason).toBe('jwt-shape');
  });

  it('the walk sees a Bearer value mid-text and inside a quoted literal; prose about a bearer stays clean (review findings 2, 8)', () => {
    for (const text of [
      'use Bearer abcdefghijklmnop0123456789 to read',
      "SELECT * FROM t WHERE h = 'Bearer abcdef1234567890'",
      "SELECT * FROM t WHERE h = 'Bearer abcdef1234567890xyz'",
      'SELECT * FROM t WHERE h="bearer eyJhbGciOiJIUzI1NiJ9abc"',
    ]) {
      expect(findRecordCredential({ sql: text })?.reason, text).toBe('bearer-prefix');
    }
    expect(parses(accessLogEntrySchema, logEntry({ sql: "SELECT * FROM t WHERE h = 'Bearer abcdef1234567890'" }))).toBe(false);
    for (const text of [
      "SELECT note FROM t WHERE note = 'pay the bearer'",
      "SELECT * FROM bonds WHERE name = 'Bearer Bonds'",
      'the bearer of news reads the ledger',
      'a bearer responsibilities overview',
      'to show what the bearer instrument holds',
    ]) {
      expect(findRecordCredential({ sql: text }), text).toBeUndefined();
    }
  });

  it('the walk runs on the FULL statement: a key straddling the 200-character log cut is caught before the cut (review finding 9)', () => {
    const lead = "SELECT amount FROM transactions WHERE note = '";
    const tail = "' OR k = '";
    const partial = OPENAI_SHAPED_KEY.slice(0, 18); // 'sk-proj-abcdefghij' — under the 16-after-prefix shape
    const head = `${lead}${'n'.repeat(ACCESS_LOG_SQL_MAX_CHARS - lead.length - tail.length - partial.length)}${tail}`;
    const full = `${head}${OPENAI_SHAPED_KEY}'`;
    const cut = full.slice(0, ACCESS_LOG_SQL_MAX_CHARS);
    expect(cut).toBe(`${head}${partial}`);
    expect(findRecordCredential({ sql: full })?.reason).toBe('known-key-prefix');
    // The cut alone no longer looks like a key — so W3 walks the full statement, then omits the seat on a hit.
    expect(parses(accessLogEntrySchema, logEntry({ sql: cut }))).toBe(true);
    expect(findRecordCredential({ sql: cut })).toBeUndefined();
  });
});

describe('AC2 — canonicalAccessGrantIntent: the nine intent fields, and nothing the engine writes on its own', () => {
  const intentOf = (over: Record<string, unknown> = {}): string => canonicalAccessGrantIntent(accessGrantSchema.parse(grant(over)));

  it('is key-sorted, whitespace-free JSON over exactly { id, readerAppId, sourceAppId, scope, access, purpose, duration, unattended, provenance }', () => {
    const text = intentOf();
    expect(text).not.toMatch(/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/); // no whitespace outside strings
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(
      ['access', 'duration', 'id', 'provenance', 'purpose', 'readerAppId', 'scope', 'sourceAppId', 'unattended'],
    );
    expect(text).toBe(
      JSON.stringify({
        access: 'read',
        duration: { at: '2026-10-17T09:00:00.000Z', kind: 'until' },
        id: GRANT_ID,
        provenance: 'app',
        purpose: 'to show spending by category',
        readerAppId: 'budget',
        scope: { tables: [{ columns: ['amount', 'category', 'date', 'note'], name: 'transactions' }] },
        sourceAppId: 'ledger',
        unattended: false,
      }),
    );
  });

  it('does NOT cover status, reasons, counters, timestamps or the reader version', () => {
    const base = intentOf();
    expect(intentOf({ status: 'suspended', suspendedReason: 'imported' })).toBe(base);
    expect(intentOf({ status: 'revoked', revokedAt: '2026-10-12T09:00:00.000Z' })).toBe(base);
    expect(intentOf({ reads: 14, lastReadAt: '2026-10-10T09:05:00.000Z', timeouts: 2 })).toBe(base);
    expect(intentOf({ grantedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })).toBe(base);
    expect(intentOf({ readerVersion: 99 })).toBe(base);
  });

  it('DOES move with every one of the nine intent fields', () => {
    const base = intentOf();
    for (const over of [
      { id: crypto.randomUUID() },
      { readerAppId: 'planner' },
      { sourceAppId: 'pantry' },
      { scope: { tables: [{ name: 'transactions', columns: ['amount'] }] } },
      { purpose: 'to show spending by month' },
      { duration: { kind: 'always' } },
      { unattended: true },
      { provenance: 'user' },
    ]) {
      expect(intentOf(over), JSON.stringify(over)).not.toBe(base);
    }
    // `access` is a one-member enum in the record; pin that it is IN the bytes.
    expect(JSON.parse(base)).toHaveProperty('access', 'read');
  });
});

describe('AC2 — accessLogEntrySchema: strict, capped, and the walk refuses a credential-shaped sql seat', () => {
  it('parses an entry of every kind', () => {
    for (const kind of ACCESS_LOG_KINDS) {
      expect(parses(accessLogEntrySchema, { at: '2026-10-10T09:05:00.000Z', kind, grantId: GRANT_ID, readerAppId: 'budget', readerName: 'Budget' }), kind).toBe(true);
    }
    expect(parses(accessLogEntrySchema, logEntry({ count: 3, imported: true, reason: 'took too long' }))).toBe(true);
  });

  it('is strict: an unknown key, an unknown kind or a non-uuid grant id is refused', () => {
    expect(parses(accessLogEntrySchema, logEntry({ extra: 1 }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ kind: 'deleted' }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ grantId: 'g1' }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ at: 'yesterday' }))).toBe(false);
  });

  it('caps every seat at cap and refuses at cap+1', () => {
    expect(parses(accessLogEntrySchema, logEntry({ readerName: 'n'.repeat(LIMITS.DISPLAY_NAME_CHARS) }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ readerName: 'n'.repeat(LIMITS.DISPLAY_NAME_CHARS + 1) }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ readerName: '' }))).toBe(false);
    const select = (chars: number) => `SELECT '${'x'.repeat(chars - "SELECT ''".length)}'`;
    expect(parses(accessLogEntrySchema, logEntry({ sql: select(ACCESS_LOG_SQL_MAX_CHARS) }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ sql: select(ACCESS_LOG_SQL_MAX_CHARS + 1) }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ reason: 'r'.repeat(ACCESS_LOG_REASON_MAX_CHARS) }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ reason: 'r'.repeat(ACCESS_LOG_REASON_MAX_CHARS + 1) }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ tables: Array.from({ length: ACCESS_MAX_TABLES }, (_, i) => `t${i}`) }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ tables: Array.from({ length: ACCESS_MAX_TABLES + 1 }, (_, i) => `t${i}`) }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ tables: ['snug_kv'] }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ count: 1 }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ count: 0 }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ rows: 0 }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ rows: -1 }))).toBe(false);
  });

  it('REFUSES a Bearer-, JWT- or sk-shaped sql seat; the passing twin is an ordinary SELECT', () => {
    expect(parses(accessLogEntrySchema, logEntry({ sql: 'Bearer abcdef1234567890' }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ sql: `SELECT * FROM t WHERE k = '${JWT.slice(0, 150)}'` }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ sql: `SELECT * FROM t WHERE k = '${OPENAI_SHAPED_KEY}'` }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ sql: `SELECT * FROM t WHERE k = ${OPENAI_SHAPED_KEY}` }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ sql: 'SELECT amount, category FROM transactions WHERE date > ? ORDER BY amount DESC' }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ reason: `failed with ${OPENAI_SHAPED_KEY}` }))).toBe(false);
  });

  it('the walk covers only the app-authored seats: a reader NAMED like a credential is still logged (review finding 6)', () => {
    for (const readerName of ['Bearer Bonds', 'Bearer of News', 'Bearer abcdef1234567890', JWT.slice(0, 80)]) {
      for (const kind of ['granted', 'read', 'revoked'] as const) {
        expect(parses(accessLogEntrySchema, logEntry({ kind, readerName })), `${kind} ${readerName}`).toBe(true);
      }
      expect(parseAccessLogEntry(JSON.stringify(logEntry({ readerName })))?.readerName).toBe(readerName);
    }
    // …while the seats an app CAN author still refuse, beside that same name.
    expect(parses(accessLogEntrySchema, logEntry({ readerName: 'Bearer Bonds', sql: `SELECT * FROM t WHERE k = '${OPENAI_SHAPED_KEY}'` }))).toBe(false);
    expect(parses(accessLogEntrySchema, logEntry({ readerName: 'Bearer Bonds', reason: `failed with ${OPENAI_SHAPED_KEY}` }))).toBe(false);
  });

  it('sql and reason refuse bidi controls and stray C0/C1 controls; a multi-line SELECT still parses (review finding 9)', () => {
    for (const sql of [
      'SELECT amount FROM transactions -- \u202Esnoitcasnart',
      'SELECT 1 \u0007\u001b[31m',
      'SELECT 1 \u2066x\u2069',
      'SELECT 1 \u200F',
      'SELECT 1 \u061C',
      'SELECT 1 \u0000',
      'SELECT 1 \u0085',
    ]) {
      expect(parses(accessLogEntrySchema, logEntry({ sql })), JSON.stringify(sql)).toBe(false);
    }
    for (const reason of ['took too long\u202E', 'took\ntoo long', 'took too long\u0007']) {
      expect(parses(accessLogEntrySchema, logEntry({ reason })), JSON.stringify(reason)).toBe(false);
    }
    expect(parses(accessLogEntrySchema, logEntry({ sql: 'SELECT amount,\n\tcategory\r\nFROM transactions' }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ sql: "SELECT * FROM t WHERE note = 'لعرض الإنفاق'" }))).toBe(true);
    expect(parses(accessLogEntrySchema, logEntry({ reason: 'took too long' }))).toBe(true);
  });
});

describe('AC2 — tolerant readers answer undefined on junk', () => {
  it('parseAccessGrant reads a good row and answers undefined on junk, empty, null, and a row failing the strict schema', () => {
    const good = JSON.stringify(grant());
    expect(parseAccessGrant(good)?.id).toBe(GRANT_ID);
    for (const raw of ['', null, undefined, '{', 'null', '[]', '42', '"x"', JSON.stringify(grant({ extra: 1 })), JSON.stringify(grant({ purpose: `use ${OPENAI_SHAPED_KEY}` }))]) {
      expect(parseAccessGrant(raw), String(raw)).toBeUndefined();
    }
  });

  it('parseAccessLogEntry likewise', () => {
    expect(parseAccessLogEntry(JSON.stringify(logEntry()))?.kind).toBe('read');
    for (const raw of ['', null, undefined, '{', 'null', '[]', JSON.stringify(logEntry({ kind: 'deleted' })), JSON.stringify(logEntry({ sql: 'Bearer abcdef1234567890' }))]) {
      expect(parseAccessLogEntry(raw), String(raw)).toBeUndefined();
    }
  });
});

describe('AC2 — accessRequestHash: the SEMANTIC fields only (sorted hint tables, sorted hint words, renew)', () => {
  const fnv1a64 = (text: string): string => {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
  };
  const asked = (over: Record<string, unknown> = {}): AccessRequestFrame => {
    const parsed = accessRequestSchema.parse(askFrame(over));
    if (parsed.op !== 'request') throw new Error('fixture must be a request');
    return parsed;
  };
  const hashOf = (over: Record<string, unknown> = {}): string => {
    const frame = asked(over);
    if (frame.op !== 'request') throw new Error('unreachable');
    return accessRequestHash(frame);
  };
  const hints = { words: ['spending', 'category'], tables: ['transactions', 'accounts'] };

  it('is FNV-1a 64 (hex) over key-sorted JSON of { renew, tables: sorted, words: sorted }', () => {
    expect(hashOf({ hints })).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf({ hints })).toBe(fnv1a64('{"tables":["accounts","transactions"],"words":["category","spending"]}'));
    expect(hashOf({ hints, renew: GRANT_ID })).toBe(
      fnv1a64(`{"renew":"${GRANT_ID}","tables":["accounts","transactions"],"words":["category","spending"]}`),
    );
  });

  it('a reworded purpose with the same hints is the SAME ask', () => {
    expect(hashOf({ hints, purpose: 'to show spending by category' })).toBe(hashOf({ hints, purpose: 'so I can chart where the money goes' }));
  });

  it('different hints are a DIFFERENT ask; renew is part of the ask; tables and words are not interchangeable', () => {
    const base = hashOf({ hints });
    expect(hashOf({ hints: { ...hints, tables: ['transactions'] } })).not.toBe(base);
    expect(hashOf({ hints: { ...hints, words: ['spending'] } })).not.toBe(base);
    expect(hashOf({ hints, renew: GRANT_ID })).not.toBe(base);
    expect(hashOf({ hints: { tables: ['ledger'] } })).not.toBe(hashOf({ hints: { words: ['ledger'] } }));
  });

  it('hint order is irrelevant; absent hints, empty hints and empty lists are the same ask', () => {
    expect(hashOf({ hints: { words: ['category', 'spending'], tables: ['accounts', 'transactions'] } })).toBe(hashOf({ hints }));
    const empty = hashOf();
    expect(hashOf({ hints: {} })).toBe(empty);
    expect(hashOf({ hints: { words: [], tables: [] } })).toBe(empty);
    expect(empty).toBe(fnv1a64('{"tables":[],"words":[]}'));
  });

  it('trivially different spellings of the same ask hash equal — trimmed, case-folded, deduplicated (review finding 10)', () => {
    const one = accessRequestHash({ hints: { words: ['spending'] } });
    expect(accessRequestHash({ hints: { words: ['spending '] } })).toBe(one);
    expect(accessRequestHash({ hints: { words: [' Spending'] } })).toBe(one);
    expect(accessRequestHash({ hints: { words: ['Spending'] } })).toBe(one);
    expect(accessRequestHash({ hints: { words: ['spending', 'spending'] } })).toBe(one);
    expect(accessRequestHash({ hints: { words: ['SPENDING', 'spending'] } })).toBe(one);
    // SQLite identifiers are case-insensitive: T1 and t1 are one table.
    expect(accessRequestHash({ hints: { tables: ['T1'] } })).toBe(accessRequestHash({ hints: { tables: ['t1'] } }));
    expect(accessRequestHash({ hints: { tables: ['t1', 'T1'] } })).toBe(accessRequestHash({ hints: { tables: ['t1'] } }));
    // …while a genuinely different word is still a different ask.
    expect(accessRequestHash({ hints: { words: ['spend'] } })).not.toBe(one);
  });

  it('does not mutate the request it hashes', () => {
    const frame = asked({ hints: { words: ['z', 'a'], tables: ['zeta', 'alpha'] } });
    if (frame.op !== 'request') throw new Error('unreachable');
    accessRequestHash(frame);
    expect(frame.hints).toEqual({ words: ['z', 'a'], tables: ['zeta', 'alpha'] });
  });
});

describe('AC2 — the types are inferred from the schemas', () => {
  it('AccessGrant is z.infer of accessGrantSchema (compile-time pin)', () => {
    const parsed: AccessGrant = accessGrantSchema.parse(grant());
    expect(parsed.access).toBe('read');
    expect(parseAccessGrant(JSON.stringify(grant()))).toEqual(parsed);
    expect(parses(accessResponseSchema, { ...respBase, ok: true, op: 'release' })).toBe(true);
  });
});
