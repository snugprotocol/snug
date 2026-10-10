/**
 * TASK-20261010-cross-app-access — access between apps (ADR-0075; spec 1.1 Part VI). The
 * constants (Appendix B), the error codes (Appendix A), the field-level pieces of the two
 * frames, and the two records a hub implementing Part VI persists.
 *
 * WHAT THIS IS. One app (the READER) reads another app's tables (the SOURCE) only under an
 * ACCESS GRANT the user gave on a host surface the app cannot forge: read-only, per table
 * with the columns disclosed and FROZEN, for a duration, revocable, and logged on the
 * source's own row. (The spec always says *access grant* — Part III's *connection grant* is
 * a different record.)
 *
 * THE FRAMES. `snug:access-request` is STRICT (it carries app-authored SQL and a release act
 * — R2's strict exception, the net pair's posture); `snug:access-response` is TOLERANT (the
 * db-response shape: nothing in it becomes a real-world effect, and a strict host→app frame
 * would make every reserved growth seat — a future `access: 'write'` — a MAJOR bump, because
 * the SDK drops what `parseFrame` rejects; D2/D16). The frame SCHEMAS live in `frames.ts`
 * beside the net pair (they need the envelope helpers and the `Frame` union); their
 * field-level pieces live here, and this module never imports `frames.ts` (no cycle).
 *
 * THE RECORDS. `accessGrant:<id>` and the entries of `accessLog:<sourceAppId>` are
 * namespaced `snug_settings` rows (ADR-0075 §2, §7) — normative PROSE in spec §22 for a hub
 * implementing Part VI, no JSON Schema (the Part III–V rule). A grant reaches a hub from an
 * imported `.snug`, a sync pull or a hand-edited row as readily as from the consent sheet,
 * so each record is `strictObject` at every level, byte-capped, and a credential anywhere in
 * it is a parse REFUSAL through the ONE walk (`record-guards.ts`).
 *
 * Browser-safe; zod only. Imports: constants, userdb-schema, record-guards, security (never frames).
 */

import { z } from 'zod';
import { LIMITS } from './constants.js';
import {
  canonicalJson,
  findRecordCredential,
  fnv1a64Hex,
  utf8ByteLength,
} from './record-guards.js';
import { isCredentialKeyName } from './security.js';
import { APP_KV_TABLE, APP_OBJECT_NAME_RULE, isValidAppObjectName } from './userdb-schema.js';

// ------------------------------------------------------------------ constants (Appendix B)

/** The four ops of `snug:access-request`. */
export const ACCESS_OPS = ['request', 'query', 'list', 'release'] as const;
export type AccessOp = (typeof ACCESS_OPS)[number];

/** The reader's stated purpose: one line, shown quoted (bidi-isolated) under "Budget says:". */
export const ACCESS_PURPOSE_MAX_CHARS = 200;
export const ACCESS_HINT_WORDS_MAX = 16;
export const ACCESS_HINT_WORD_MAX_CHARS = 32;
export const ACCESS_HINT_TABLES_MAX = 16;
/** Tables per grant. */
export const ACCESS_MAX_TABLES = 32;
/** Columns per granted table. */
export const ACCESS_MAX_COLUMNS = 64;
/** One column name in a grant's frozen column list. */
export const ACCESS_COLUMN_NAME_MAX_CHARS = 64;
export const ACCESS_SQL_MAX_CHARS = 4096;
export const ACCESS_MAX_PARAMS = 64;
/** A string bound parameter. */
export const ACCESS_PARAM_STRING_MAX_CHARS = 4096;
/** Rows per query answer (the engine truncates in band, `truncated`/`totalRows`). */
export const ACCESS_MAX_ROWS = 500;
/** A query answer's rows in UTF-8 BYTES (192 KiB) — under `LIMITS.MAX_FRAME_BYTES`, so a capped answer always crosses. */
export const ACCESS_MAX_RESULT_BYTES = 192 * 1024;
/** The scoped-read Worker's wall clock. */
export const ACCESS_QUERY_TIMEOUT_MS = 2000;
/** The largest source runtime a read may copy. */
export const ACCESS_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
/** How long a grant's scoped bytes are cached. */
export const ACCESS_SCOPED_CACHE_MS = 10_000;
/** Whole-grant cap in UTF-8 BYTES of the serialised (parsed) `accessGrant:<id>` row. */
export const ACCESS_GRANT_MAX_BYTES = 16 * 1024;
/** Live grants per file. */
export const ACCESS_MAX_GRANTS = 100;
/** Ended (revoked/expired) grants older than this are pruned on write. */
export const ACCESS_ENDED_RETENTION_MS = 30 * 86_400_000;
/** One bounded `accessLog:<sourceAppId>` row per source. */
export const ACCESS_LOG_MAX_ENTRIES = 200;
export const ACCESS_LOG_MAX_BYTES = 64 * 1024;
/** Every source's history together. */
export const ACCESS_LOG_TOTAL_MAX_BYTES = 1024 * 1024;
/**
 * A `read` entry keeps the statement's first 200 characters — unless the credential walk
 * refuses it. The writer's order is the contract: walk the FULL statement first and omit the
 * `sql` seat on a hit, THEN cut. A key straddling the cut leaves a prefix too short for the
 * walk to recognise, so walking only the cut text could persist a partial key.
 */
export const ACCESS_LOG_SQL_MAX_CHARS = 200;
/** A log entry's one-line reason (`took too long`, `reader-updated`, …). */
export const ACCESS_LOG_REASON_MAX_CHARS = 120;
/** Consecutive reads coalesce only on an identical `(grantId, sql)` within this window. */
export const ACCESS_LOG_COALESCE_MS = 60_000;
/** Per reader app (host-assigned id + frame generation): one `request` per 10 s … */
export const ACCESS_REQUEST_MIN_GAP_MS = 10_000;
/** … 60 `query` a minute … */
export const ACCESS_QUERY_RATE_PER_MINUTE = 60;
/** … and three consecutive timeouts suspend the grant `reader-misbehaved`. */
export const ACCESS_TIMEOUT_STRIKES = 3;
/** App ids in an access record — the settings-key bound scheduling records already live under. */
export const ACCESS_APP_ID_MAX_CHARS = 64;

/**
 * The four durations the user chooses from. `session` (*while Budget is open*, the DEFAULT)
 * is a MEMORY grant bound to the reader's frame generation and NEVER persists; `day`,
 * `week` and `always` (*until I stop it*) persist.
 */
export const ACCESS_DURATIONS = ['session', 'day', 'week', 'always'] as const;
export type AccessDuration = (typeof ACCESS_DURATIONS)[number];

/** Stored statuses. `expired` is DERIVED from the duration at read — never stored. */
export const ACCESS_GRANT_STATUSES = ['active', 'revoked', 'suspended'] as const;
export type AccessGrantStatus = (typeof ACCESS_GRANT_STATUSES)[number];

/** Why a grant was suspended — every one is undone only by the user's *allow again*. */
export const ACCESS_SUSPEND_REASONS = ['imported', 'reader-updated', 'source-changed', 'source-restricted', 'reader-misbehaved'] as const;
export type AccessSuspendReason = (typeof ACCESS_SUSPEND_REASONS)[number];

/** Who started the grant: the reader app's `request`, or the user from host chrome. Only the user's act WRITES one either way. */
export const ACCESS_PROVENANCES = ['app', 'user'] as const;
export type AccessProvenance = (typeof ACCESS_PROVENANCES)[number];

/** The access log's entry kinds. */
export const ACCESS_LOG_KINDS = ['granted', 'read', 'refused', 'revoked', 'expired', 'released', 'suspended'] as const;
export type AccessLogKind = (typeof ACCESS_LOG_KINDS)[number];

/** The `snug:host-event` rung on the reader's live frame when a grant changes. Data `{ grantId }` — ids only (R7). */
export const ACCESS_CHANGED_EVENT = 'access-changed';

const DAY_MS = 86_400_000;

/** The span each EXPIRING duration grants — the one table both directions below derive from. */
const EXPIRING_SPANS_MS = { day: DAY_MS, week: 7 * DAY_MS } as const;
type ExpiringDuration = keyof typeof EXPIRING_SPANS_MS;

/**
 * The absolute expiry a duration implies, as an ISO instant — `undefined` for the session
 * grant (it ends with the reader's frame generation) and for `always` (it ends when the
 * user stops it). `now` is epoch milliseconds.
 */
export function durationToExpiry(kind: AccessDuration, now: number): string | undefined {
  switch (kind) {
    case 'day':
    case 'week':
      return new Date(now + EXPIRING_SPANS_MS[kind]).toISOString();
    case 'session':
    case 'always':
      return undefined;
  }
}

/**
 * The inverse of `durationToExpiry` for a grant that expires: the duration whose span is NEAREST
 * the span from `grantedAt` to `expiresAt` (exact for every instant `durationToExpiry` wrote; a
 * hand-written or foreign span reads as the closest choice the user could have made).
 */
export function durationFromExpiry(grantedAt: string, expiresAt: string): ExpiringDuration {
  const span = Date.parse(expiresAt) - Date.parse(grantedAt);
  let nearest: ExpiringDuration = 'day';
  for (const kind of Object.keys(EXPIRING_SPANS_MS) as ExpiringDuration[]) {
    if (Math.abs(EXPIRING_SPANS_MS[kind] - span) < Math.abs(EXPIRING_SPANS_MS[nearest] - span)) nearest = kind;
  }
  return nearest;
}

// ------------------------------------------------------------------ error codes (Appendix A)

/**
 * Error codes for `snug:access-response`. Same open-string wire rule as `ERROR_CODES` (R5):
 * receivers handle an unknown code via `retryable`. Retryability by code:
 * `ACCESS_DECLINED` is retryable only for *not now* (`false` after *don't allow* or a mute);
 * `ACCESS_PENDING`, `ACCESS_UNATTENDED` and `ACCESS_RATE_LIMITED` are retryable.
 * `ACCESS_SIZE_EXCEEDED` is the runner's belt only (the engine truncates in band).
 */
export const ACCESS_ERROR_CODES = {
  ACCESS_INVALID_REQUEST: 'ACCESS_INVALID_REQUEST',
  ACCESS_NOT_GRANTED: 'ACCESS_NOT_GRANTED',
  ACCESS_DECLINED: 'ACCESS_DECLINED',
  ACCESS_PENDING: 'ACCESS_PENDING',
  ACCESS_UNATTENDED: 'ACCESS_UNATTENDED',
  ACCESS_NO_SOURCES: 'ACCESS_NO_SOURCES',
  ACCESS_REVOKED: 'ACCESS_REVOKED',
  ACCESS_EXPIRED: 'ACCESS_EXPIRED',
  ACCESS_QUERY_REFUSED: 'ACCESS_QUERY_REFUSED',
  ACCESS_QUERY_FAILED: 'ACCESS_QUERY_FAILED',
  ACCESS_RATE_LIMITED: 'ACCESS_RATE_LIMITED',
  ACCESS_SIZE_EXCEEDED: 'ACCESS_SIZE_EXCEEDED',
} as const;

export type AccessErrorCode = (typeof ACCESS_ERROR_CODES)[keyof typeof ACCESS_ERROR_CODES];

const ACCESS_ERROR_CODE_SET = new Set<string>(Object.values(ACCESS_ERROR_CODES));

export function isAccessErrorCode(code: string): code is AccessErrorCode {
  return ACCESS_ERROR_CODE_SET.has(code);
}

// ------------------------------------------------------------------ shared text rules

/**
 * What a line of app-chosen text the host SHOWS may not contain (ADR-0075 §4–5). The rule is
 * TOTAL over Unicode's general categories, not an enumerated list:
 *  - every control character, `\p{Cc}` (C0 U+0000–U+001F — so no tab or newline: one line —
 *    DEL and C1 U+007F–U+009F);
 *  - every format character, `\p{Cf}` — the bidi embeddings/overrides (U+202A–U+202E) and
 *    isolates (U+2066–U+2069), the invisible bidi marks (U+200E, U+200F, U+061C), the
 *    zero-width characters (U+200B–U+200D, U+2060, U+FEFF), the invisible operators
 *    (U+2061–U+2064), the soft hyphen, U+180E, the interlinear annotations, the whole tag
 *    block U+E0000–U+E007F (a subdivision-flag emoji is refused with it — the narrow cost of
 *    refusing invisible tag text), and every other Cf code point;
 *  - the line and paragraph separators (U+2028, U+2029), the combining grapheme joiner
 *    (U+034F), and the blank-rendering fillers (U+2800, U+3164, U+115F, U+1160, U+FFA0).
 * Any of these lets an app make the consent sheet say something other than what its bytes
 * say. Spec prose states it as: no control (Cc) or format (Cf) character, no line or
 * paragraph separator, no U+034F, no blank filler; no leading or trailing whitespace; not blank.
 */
const UNSAFE_DISPLAY_CHAR_RULE = /[\p{Cc}\p{Cf}\u034F\u2028\u2029\u2800\u3164\u115F\u1160\uFFA0]/u;
const UNSAFE_DISPLAY_TEXT_MESSAGE =
  'must be one line of visible text — no control, format (bidi, zero-width, tag), line-separator or blank-filler characters, and no leading or trailing whitespace';

/** One line of visible text: no unsafe character, not blank, and no leading/trailing whitespace (the shown quote is the stored bytes). */
function isDisplaySafeLine(text: string): boolean {
  return !UNSAFE_DISPLAY_CHAR_RULE.test(text) && text.trim() !== '' && text.trim() === text;
}

/**
 * What app-authored SQL — the query frame's statement and the history's logged copy — may
 * not contain: the bidi controls (embeddings/overrides, isolates and the invisible marks
 * U+200E, U+200F, U+061C), which would let the history row render a statement other than
 * the one that ran, and the C0/C1 controls OTHER than tab, newline and carriage return (a
 * multi-line SELECT legitimately carries those). A bound parameter is a value, never shown
 * as the statement, and is not refined.
 */
const UNSAFE_SQL_CHAR_RULE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const isSqlTextSafe = (text: string): boolean => !UNSAFE_SQL_CHAR_RULE.test(text);
const UNSAFE_SQL_TEXT_MESSAGE = 'sql may not carry bidi controls or control characters other than tab, newline and carriage return';

const credentialFree = (seat: string) => (text: string): boolean => findRecordCredential({ [seat]: text }) === undefined;

/** A bounded line of app-chosen display text that is also never credential-shaped. */
function displayLine(seat: string, max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine(isDisplaySafeLine, UNSAFE_DISPLAY_TEXT_MESSAGE)
    .refine(credentialFree(seat), `${seat} may not carry a credential`);
}

/** The reader's stated purpose (1..200, one line). Shown quoted, never trusted; excluded from the request hash. */
export const accessPurposeSchema = displayLine('purpose', ACCESS_PURPOSE_MAX_CHARS);

/** One relevance hint word (1..32, one line). */
export const accessHintWordSchema = displayLine('word', ACCESS_HINT_WORD_MAX_CHARS);

/**
 * A table an access grant (or a hint) may name: an app object name (`APP_OBJECT_NAME_RULE`)
 * outside every reserved prefix — and NEVER `snug_kv`: the driver-internal kv table is not
 * shareable (ADR-0075 §2), even though it is the one reserved name an app's own SQL may use.
 */
export const accessTableNameSchema = z
  .string()
  .regex(APP_OBJECT_NAME_RULE)
  .refine((name) => name.toLowerCase() !== APP_KV_TABLE && isValidAppObjectName(name), 'not a shareable app table name');

/** Relevance hints: words and table names the host ranks the user's apps by. Never shown to another app. */
export const accessHintsSchema = z.strictObject({
  words: z.array(accessHintWordSchema).max(ACCESS_HINT_WORDS_MAX).optional(),
  tables: z.array(accessTableNameSchema).max(ACCESS_HINT_TABLES_MAX).optional(),
});
export type AccessHints = z.infer<typeof accessHintsSchema>;

/** A bound parameter: a scalar. (`z.number()` refuses NaN and ±Infinity.) */
export const accessParamSchema = z.union([z.string().max(ACCESS_PARAM_STRING_MAX_CHARS), z.number(), z.boolean(), z.null()]);
export type AccessParam = z.infer<typeof accessParamSchema>;

/**
 * A query's statement: ONE read-only SELECT — enforced by the host (`ACCESS_QUERY_REFUSED`),
 * not the parser. The parser bounds its size and refuses bidi and stray control characters
 * (it is shown, as the history's *what it asked*).
 */
export const accessSqlSchema = z.string().min(1).max(ACCESS_SQL_MAX_CHARS).refine(isSqlTextSafe, UNSAFE_SQL_TEXT_MESSAGE);
export const accessParamsSchema = z.array(accessParamSchema).max(ACCESS_MAX_PARAMS);

// ------------------------------------------------------------------ the grant VIEW (wire, tolerant)

const frameId = z.string().min(1).max(LIMITS.ID_CHARS);
const isoInstant = z.iso.datetime();

/**
 * What the reader LEARNS about a grant — the source's display name and icon, the granted
 * tables with their columns, the duration and expiry; never the inventory, never a library
 * id (ADR-0075 §5). TOLERANT at every level (`z.object`, D2/D16): an unknown key still
 * parses, and `access` is an open string so a future `'write'` grant in a `list` answer is
 * not a MAJOR bump — at 1.1 a host only ever sends `'read'`. The seats it does know are
 * still bounded: 1..32 tables, 1..64 columns each.
 */
export const accessGrantViewSchema = z.object({
  id: frameId,
  /** `'read'` at 1.1; open so a reserved growth value (`'write'`) still parses. */
  access: z.string().min(1).max(32),
  source: z.object({
    displayName: z.string().min(1).max(LIMITS.DISPLAY_NAME_CHARS),
    iconEmoji: z.string().max(LIMITS.ICON_EMOJI_CHARS).optional(),
    iconColor: z.string().max(LIMITS.ICON_COLOR_CHARS).optional(),
  }),
  tables: z
    .array(
      z.object({
        name: z.string().regex(APP_OBJECT_NAME_RULE),
        columns: z.array(z.string().min(1).max(ACCESS_COLUMN_NAME_MAX_CHARS)).min(1).max(ACCESS_MAX_COLUMNS),
      }),
    )
    .min(1)
    .max(ACCESS_MAX_TABLES),
  duration: z.enum(ACCESS_DURATIONS),
  /** Absent for `session` and `always`. */
  expiresAt: isoInstant.optional(),
  unattended: z.boolean(),
});
export type AccessGrantView = z.infer<typeof accessGrantViewSchema>;

// ------------------------------------------------------------------ the RECORDS (persisted, strict)

/** `crypto.randomUUID()`'s shape: a lowercase RFC 4122 version-4 uuid. Memory (session) grants mint theirs the same way. */
const UUID_V4_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const grantIdSchema = z.string().regex(UUID_V4_RULE, 'a grant id is a lowercase uuid v4');
const appIdSchema = z.string().min(1).max(ACCESS_APP_ID_MAX_CHARS);

const hasNoDuplicates = (values: readonly string[]): boolean => new Set(values).size === values.length;

/**
 * One granted table with its columns as disclosed at consent — FROZEN: a later difference
 * suspends the grant (`source-changed`). A credential-named column (`isCredentialKeyName`:
 * `api_key`, `password`, `token`, …) is NEVER in a scope (D14/Q2): the consent sheet shows it
 * as *never shared* and leaves it out, the drift check ignores such live columns, and the
 * scoped read masks any cell under one — so a planted or hand-edited grant naming it is a
 * parse refusal, not a mask's last line of defence.
 */
const scopeTableSchema = z.strictObject({
  name: accessTableNameSchema,
  columns: z
    .array(z.string().min(1).max(ACCESS_COLUMN_NAME_MAX_CHARS))
    .min(1)
    .max(ACCESS_MAX_COLUMNS)
    .refine(hasNoDuplicates, 'a column appears once')
    .refine((columns) => !columns.some(isCredentialKeyName), 'a credential-named column is never shared'),
});

export const accessScopeSchema = z.strictObject({
  tables: z
    .array(scopeTableSchema)
    .min(1)
    .max(ACCESS_MAX_TABLES)
    .refine((tables) => hasNoDuplicates(tables.map((table) => table.name)), 'a table appears once'),
});
export type AccessScope = z.infer<typeof accessScopeSchema>;

/** A persisted duration. `session` NEVER persists (it is a memory grant), so it has no form here. */
export const accessGrantDurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('until'), at: isoInstant }),
  z.strictObject({ kind: z.literal('always') }),
]);
export type AccessGrantDuration = z.infer<typeof accessGrantDurationSchema>;

/**
 * An access grant — the `accessGrant:<id>` settings row (ADR-0075 §2). Written ONLY by the
 * user's act on a host surface. Strict at every level; the serialised grant is capped at
 * 16 KiB; a credential anywhere (a credential-shaped purpose, above all) is a REFUSAL.
 * `status` and its reasons agree: `suspended` ⇔ `suspendedReason`, `revoked` ⇔ `revokedAt`.
 */
export const accessGrantSchema = z
  .strictObject({
    id: grantIdSchema,
    readerAppId: appIdSchema,
    sourceAppId: appIdSchema,
    scope: accessScopeSchema,
    /** A one-member enum: writes are deferred (ADR-0075 §10); the record is strict where the view is not. */
    access: z.literal('read'),
    purpose: accessPurposeSchema,
    duration: accessGrantDurationSchema,
    /** *Also while I'm away* — a hidden scheduled frame may `query` only under it. Default off at consent. */
    unattended: z.boolean(),
    status: z.enum(ACCESS_GRANT_STATUSES),
    suspendedReason: z.enum(ACCESS_SUSPEND_REASONS).optional(),
    provenance: z.enum(ACCESS_PROVENANCES),
    /** The reader's app version at consent. */
    readerVersion: z.int().min(1),
    grantedAt: isoInstant,
    updatedAt: isoInstant,
    revokedAt: isoInstant.optional(),
    reads: z.int().min(0).default(0),
    lastReadAt: isoInstant.optional(),
    /** Consecutive query timeouts; `ACCESS_TIMEOUT_STRIKES` suspends `reader-misbehaved`. */
    timeouts: z.int().min(0).default(0),
  })
  .superRefine((grant, ctx) => {
    if (grant.readerAppId === grant.sourceAppId) {
      ctx.addIssue({ code: 'custom', path: ['sourceAppId'], message: 'an app never holds access to itself' });
    }
    if ((grant.status === 'suspended') !== (grant.suspendedReason !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['suspendedReason'], message: 'suspendedReason is present exactly when status is "suspended"' });
    }
    if ((grant.status === 'revoked') !== (grant.revokedAt !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['revokedAt'], message: 'revokedAt is present exactly when status is "revoked"' });
    }
    if (utf8ByteLength(JSON.stringify(grant)) > ACCESS_GRANT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the serialized access grant must be at most ${ACCESS_GRANT_MAX_BYTES} bytes` });
    }
    const credential = findRecordCredential(grant);
    if (credential) {
      ctx.addIssue({
        code: 'custom',
        message: `an access grant may not carry a credential (${credential.reason} at ${credential.path || '<root>'})`,
      });
    }
  });
export type AccessGrant = z.infer<typeof accessGrantSchema>;

/**
 * One entry of the `accessLog:<sourceAppId>` row — the source keeps the history (ADR-0075 §7).
 * Strict and capped per seat; a credential in an app-authored seat (above all the logged
 * statement) is a REFUSAL, so the host omits the `sql` seat when the walk hits rather than
 * persist it. The reader's NAME is host-written and is not walked.
 */
export const accessLogEntrySchema = z
  .strictObject({
    at: isoInstant,
    kind: z.enum(ACCESS_LOG_KINDS),
    grantId: grantIdSchema,
    readerAppId: appIdSchema,
    /**
     * The reader's library name at the time — the source's history reads in words. HOST-written
     * from the library row and outside the credential walk: an app honestly named "Bearer Bonds"
     * must never be unloggable (the history may never lie about by whose act access began).
     */
    readerName: z.string().min(1).max(LIMITS.DISPLAY_NAME_CHARS),
    tables: z.array(accessTableNameSchema).max(ACCESS_MAX_TABLES).optional(),
    /** The statement's first 200 characters (a `read`) — walked on the FULL statement before the cut (`ACCESS_LOG_SQL_MAX_CHARS`). */
    sql: z.string().min(1).max(ACCESS_LOG_SQL_MAX_CHARS).refine(isSqlTextSafe, UNSAFE_SQL_TEXT_MESSAGE).optional(),
    rows: z.int().min(0).optional(),
    /** Coalesced identical `(grantId, sql)` reads within `ACCESS_LOG_COALESCE_MS`. */
    count: z.int().min(1).optional(),
    /** Whether the user was looking (`false` — *while you were away*). */
    attended: z.boolean().optional(),
    reason: z.string().min(1).max(ACCESS_LOG_REASON_MAX_CHARS).refine(isDisplaySafeLine, UNSAFE_DISPLAY_TEXT_MESSAGE).optional(),
    /** Arrived with an imported file — shown under its own heading. */
    imported: z.boolean().optional(),
  })
  .superRefine((entry, ctx) => {
    // Only the seats an app can AUTHOR are walked: the statement, the reason and the table
    // names. Host-written seats (readerName from the library row, ids, timestamps) are not —
    // exactly as a grant's column names are identifiers, not values.
    const credential = findRecordCredential({ sql: entry.sql, reason: entry.reason, tables: entry.tables });
    if (credential) {
      ctx.addIssue({
        code: 'custom',
        message: `an access-log entry may not carry a credential (${credential.reason} at ${credential.path || '<root>'})`,
      });
    }
  });
export type AccessLogEntry = z.infer<typeof accessLogEntrySchema>;

// ------------------------------------------------------------------ identities

/**
 * Canonical bytes of a grant's INTENT — who reads whom, what, why, for how long, unattended
 * or not, and who asked — key-sorted, whitespace-free JSON. Load-bearing for the IMPORT
 * GUARD (ADR-0075 §9): an imported grant stays active only when these bytes equal a local
 * grant's. Deliberately NOT covered: `status`, `suspendedReason`, `revokedAt`, the counters
 * (`reads`, `lastReadAt`, `timeouts`), the timestamps and `readerVersion` — they move with
 * ordinary use, and comparing them would demote every grant of a backup taken before its
 * next read (the `canonicalScheduleIntent` reasoning). A canonical STRING, not a digest:
 * the comparison is exact and has no collision surface.
 */
export function canonicalAccessGrantIntent(grant: AccessGrant): string {
  const { id, readerAppId, sourceAppId, scope, access, purpose, duration, unattended, provenance } = grant;
  return canonicalJson({ id, readerAppId, sourceAppId, scope, access, purpose, duration, unattended, provenance });
}

/** The semantic fields of an `op: 'request'` frame (the frame itself satisfies this). */
export interface AccessRequestSemantics {
  readonly hints?: { readonly words?: readonly string[]; readonly tables?: readonly string[] } | undefined;
  readonly renew?: string | undefined;
}

/** Trimmed, lower-cased, de-duplicated and sorted — the one normal form of a hint list. */
function normalisedHints(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()))].sort();
}

/**
 * An ask's identity over its SEMANTIC fields only — the hint tables, the hint words and
 * `renew` — so a reworded purpose with the same hints is the SAME ask (*don't allow* records
 * this; ADR-0075 §4). The purpose is free text and is EXCLUDED. Each hint list is NORMALISED
 * first — trimmed, lower-cased (SQLite identifiers are case-insensitive, so `T1` and `t1` are
 * one table), de-duplicated and sorted — so a trivially different spelling cannot mint a
 * fresh decline slot. FNV-1a 64 over the canonical UTF-8, hex — the `proposalHash` code
 * (`fnv1a64Hex`): a dedupe key, never a security boundary. Absent hints, empty hints and
 * empty lists are the same ask. (`renew` is hashed as given; the host treats it as part of
 * the ask only when it names one of THIS reader's grants, else hashes it as absent.)
 */
export function accessRequestHash(request: AccessRequestSemantics): string {
  const tables = normalisedHints(request.hints?.tables);
  const words = normalisedHints(request.hints?.words);
  return fnv1a64Hex(canonicalJson({ tables, words, renew: request.renew }));
}

// ------------------------------------------------------------------ read path

/**
 * The TOLERANT read path for a persisted row: `undefined` rather than a throw on anything
 * unusable — a malformed `accessGrant:<id>` row reads as "no such grant" (the
 * `parseScheduledTask` posture). The strict schema still decides what "usable" means.
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

export function parseAccessGrant(raw: string | null | undefined): AccessGrant | undefined {
  return tolerantRead(accessGrantSchema, raw);
}

export function parseAccessLogEntry(raw: string | null | undefined): AccessLogEntry | undefined {
  return tolerantRead(accessLogEntrySchema, raw);
}
