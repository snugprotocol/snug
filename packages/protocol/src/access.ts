/**
 * TASK-20261010-cross-app-access — access between apps (ADR-0075; spec 1.1 Part VI), widened
 * by TASK-20261010-host-broker PR-3 (ADR-0076 §4–§8; spec 1.2). The constants (Appendix B),
 * the error codes (Appendix A), the field-level pieces of the two frames, and the records a
 * hub implementing Part VI persists.
 *
 * WHAT THIS IS. One app (the READER) reads — and, when the user ticked it per table, changes
 * — another app's tables (the SOURCE) only under an ACCESS GRANT the user gave on a host
 * surface the app cannot forge: per table with the GRANTED columns disclosed and FROZEN (the
 * rest WITHHELD), for a duration, revocable, and logged on the source's own row. A write is
 * one plain statement, bounded at `ACCESS_WRITE_MAX_ROWS`, journaled as ROWS so the user can
 * undo it from the source's history (D-PR3-7). (The spec always says *access grant* —
 * Part III's *connection grant* is a different record.)
 *
 * THE FRAMES. `snug:access-request` is STRICT (it carries app-authored SQL and a release act
 * — R2's strict exception, the net pair's posture); `snug:access-response` is TOLERANT (the
 * db-response shape: nothing in it becomes a real-world effect, and a strict host→app frame
 * would make every additive seat a MAJOR bump, because the SDK drops what `parseFrame`
 * rejects; D2/D16). 1.1 reserved `access: 'write'` on the view as exactly such a seat; 1.2
 * fills it — a 1.1 app still parses a `list` answer that carries it. The frame SCHEMAS live in
 * `frames.ts` beside the net pair (they need the envelope helpers and the `Frame` union);
 * their field-level pieces live here, and this module never imports `frames.ts` (no cycle).
 *
 * THE RECORDS. `accessGrant:<id>`, the entries of `accessLog:<sourceAppId>`, the undo journal
 * `accessUndo:<targetAppId>` and the builder-time declaration `accessWants:<appId>` are
 * namespaced `snug_settings` rows (ADR-0075 §2, §7; ADR-0076 §5, §11) — normative PROSE in
 * spec §22 for a hub implementing Part VI, no JSON Schema (the Part III–V rule). A record
 * reaches a hub from an imported `.snug`, a sync pull or a hand-edited row as readily as from
 * the consent sheet, so each is `strictObject` at every level, byte-capped, and a credential
 * anywhere in it is a parse REFUSAL through the ONE walk (`record-guards.ts`). Every seat 1.2
 * adds to the grant is OPTIONAL with the 1.1 meaning when absent, and the writer OMITS every
 * default, so a defaults-off 1.2 record is byte- and intent-identical to a 1.1 record
 * (D-PR3-2; the ADR-0075 §9 import guard keeps a pre-upgrade backup unsuspended).
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

/**
 * The seven ops of `snug:access-request`, in the order the frame's variants are declared:
 * the 1.1 four (`request`, `query`, `list`, `release`) and 1.2's `write`, `refresh` and
 * `discover` (ADR-0076 §4, §6, §7). A 1.1 host answers an op it does not serve `MALFORMED`
 * with the `requestId` recovered — how a 1.2 app learns it is on a 1.1 host (D-PR3-5).
 */
export const ACCESS_OPS = ['request', 'query', 'write', 'refresh', 'list', 'release', 'discover'] as const;
export type AccessOp = (typeof ACCESS_OPS)[number];

/**
 * What an ask asks for and what a grant holds: `read` (the 1.1 meaning, the default when the
 * seat is absent) or `write` (some table of the scope may be changed). The record ties the two
 * — `access: 'write'` exactly when a table carries `write: true` (D-PR3-2).
 */
export const ACCESS_LEVELS = ['read', 'write'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

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

// --- spec 1.2 (ADR-0076 §4–§8, §11; D-PR3-6/7/17/20/21/26)

/** Rows one brokered write may change (the dry run refuses past it; the apply re-counts). */
export const ACCESS_WRITE_MAX_ROWS = 200;
/** One undo journal entry's serialised UTF-8 BYTES (64 KiB) — the captured rows of one write. */
export const ACCESS_UNDO_MAX_BYTES = 64 * 1024;
/** The whole `accessUndo:<targetAppId>` row (256 KiB) — enforced by the accessor, not the entry schema (W-Q4). */
export const ACCESS_UNDO_MAX_ROW_BYTES = 256 * 1024;
/** LIVE entries per (target, reader) — a 21st write is refused rather than evicting one (S9). */
export const ACCESS_UNDO_MAX_ENTRIES = 20;
/** How long an entry stays undoable. */
export const ACCESS_UNDO_TTL_MS = 7 * 86_400_000;
/** A source runs for a reader's `refresh` at most once per cooldown; inside it the answer is `fresh: false, reason: 'recent'`. */
export const ACCESS_REFRESH_COOLDOWN_MS = 5 * 60_000;
/** A reader's `discover` class is answered from a per-reader cache for this long — one library gather a minute. */
export const ACCESS_DISCOVER_CACHE_MS = 60_000;
/** A source's row-modifying statements ring `access-source-changed` coalesced per source: at once, then once more at the window's end. */
export const ACCESS_DOORBELL_COALESCE_MS = 2_000;
/** A materialised read (the chat and scheduler doors): rows kept per table before the dump is `truncated`. */
export const ACCESS_MATERIALISE_MAX_ROWS = 5_000;
/** … UTF-8 JSON bytes kept per table before the dump is `truncated` … */
export const ACCESS_MATERIALISE_MAX_BYTES = 2 * 1024 * 1024;
/** … ONE byte budget across a whole set in grant order … */
export const ACCESS_MATERIALISE_MAX_SET_BYTES = 8 * 1024 * 1024;
/** … and the Worker's wall clock for one dump (the SQL is the host's, so a timeout counts no strike). */
export const ACCESS_MATERIALISE_TIMEOUT_MS = 5_000;
/** The builder-time declaration `accessWants:<appId>` (ADR-0076 §11): serialised UTF-8 BYTES … */
export const ACCESS_WANTS_MAX_BYTES = 2 * 1024;
/** … and entries. */
export const ACCESS_WANTS_MAX_ENTRIES = 4;

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

/**
 * Who started the grant: the reader app's `request`, the user from host chrome, or the
 * chat's card beside the reader (1.2; R-86). Only the user's act WRITES one either way.
 */
export const ACCESS_PROVENANCES = ['app', 'user', 'chat'] as const;
export type AccessProvenance = (typeof ACCESS_PROVENANCES)[number];

/**
 * The access log's entry kinds: the 1.1 seven, and 1.2's `wrote` (a brokered write landed),
 * `undone` (the user put its rows back) and `refreshed` (a reader asked the source to fetch).
 */
export const ACCESS_LOG_KINDS = ['granted', 'read', 'refused', 'revoked', 'expired', 'released', 'suspended', 'wrote', 'undone', 'refreshed'] as const;
export type AccessLogKind = (typeof ACCESS_LOG_KINDS)[number];

/** Which door asked — on any log kind; `user` is an act from host chrome (an undo). */
export const ACCESS_LOG_VIAS = ['app', 'chat', 'schedule', 'user'] as const;
export type AccessLogVia = (typeof ACCESS_LOG_VIAS)[number];

/**
 * By whose authority a `wrote` line landed: the standing per-table tick (`permission`), a
 * card or result-page approve (`approval`), or a task's arming (`task`, ADR-0076 §9).
 */
export const ACCESS_WRITE_AUTHORITIES = ['permission', 'approval', 'task'] as const;
export type AccessWriteAuthority = (typeof ACCESS_WRITE_AUTHORITIES)[number];

/**
 * Why a `refreshed` line's run did not end in a result — machine tokens the host words for
 * the person; a handler's own summary never reaches a line (D-PR3-6). The cooldown's
 * `recent` is an ANSWER, never a line, so it is not here.
 */
export const ACCESS_REFRESH_REASONS = ['no-handler', 'timeout', 'capped', 'refused', 'failed'] as const;
export type AccessRefreshReason = (typeof ACCESS_REFRESH_REASONS)[number];

/** What a `discover` answers: a CLASS over the user's matching apps — never a count, never a name (D-PR3-21). */
export const ACCESS_CANDIDATE_CLASSES = ['none', 'one', 'several'] as const;
export type AccessCandidateClass = (typeof ACCESS_CANDIDATE_CLASSES)[number];

/** The `snug:host-event` rung on the reader's live frame when a grant changes. Data `{ grantId }` — ids only (R7). */
export const ACCESS_CHANGED_EVENT = 'access-changed';
/** Rung on a READER's live frame after its source changed (a source's own write, a brokered write, an undo). Data `{ grantId }`. */
export const ACCESS_SOURCE_CHANGED_EVENT = 'access-source-changed';
/** Rung on a SOURCE's live frame after a reader read it. Data `{ grantId }`. */
export const ACCESS_READ_EVENT = 'access-read';
/** Rung on an app's OWN live frame after the host changed its data on its behalf (a brokered write, an undo, the chat's approved write). Data `{ table }` — the table alone, omitted when unknown. */
export const DATA_CHANGED_EVENT = 'data-changed';

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
 * Error codes for `snug:access-response` — the 1.1 twelve and 1.2's three. Same open-string
 * wire rule as `ERROR_CODES` (R5): receivers handle an unknown code via `retryable`.
 * Retryability by code: `ACCESS_DECLINED` is retryable only for *not now* (`false` after
 * *don't allow* or a mute); `ACCESS_PENDING`, `ACCESS_UNATTENDED`, `ACCESS_RATE_LIMITED` and
 * `ACCESS_BUSY` (the target holds an open transaction, or changed between the dry run and
 * the apply) are retryable; `ACCESS_WRITE_REFUSED` (a statement, table, column or value rule
 * — worded without the source fact that decided it) and `ACCESS_REFRESH_FAILED` (no handler,
 * a timeout, the day's ceiling, a refused send, a failed fetch, schedules off) are not.
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
  ACCESS_WRITE_REFUSED: 'ACCESS_WRITE_REFUSED',
  ACCESS_BUSY: 'ACCESS_BUSY',
  ACCESS_REFRESH_FAILED: 'ACCESS_REFRESH_FAILED',
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
 * tables with their columns (and, at 1.2, which may be changed), the duration and expiry,
 * and whether the source's settings & notes (`kv`) or a fetch on request (`refresh`) were
 * allowed; never the inventory, never a library id, never the WITHHELD columns (ADR-0075
 * §5; D-PR3-3). TOLERANT at every level (`z.object`, D2/D16): an unknown key still parses —
 * tolerant of KEYS, not of SHAPES: a known seat with the wrong shape is MALFORMED (W-Q3).
 * `access` stays an open string: 1.1 reserved `'write'` there and 1.2 sends it, so a 1.1 app
 * parses a `list` answer that carries a write grant. The additive seats appear ONLY when
 * set (`z.literal(true)`, absent ≡ default), so a read-only grant's view is byte-identical
 * to its 1.1 view. The seats it does know are still bounded: 1..32 tables, 1..64 columns each.
 */
export const accessGrantViewSchema = z.object({
  id: frameId,
  /** `'read'` or `'write'` at 1.2 (`ACCESS_LEVELS`); open so a later value still parses. */
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
        /** The reader may change this table's granted columns (one plain statement at a time). */
        write: z.literal(true).optional(),
      }),
    )
    .min(1)
    .max(ACCESS_MAX_TABLES),
  duration: z.enum(ACCESS_DURATIONS),
  /** Absent for `session` and `always`. */
  expiresAt: isoInstant.optional(),
  unattended: z.boolean(),
  /** The source's settings & notes (`snug_kv`, credential-free) are readable too. */
  kv: z.literal(true).optional(),
  /** The reader may ask the source to fetch new data before a read (`op: 'refresh'`). */
  refresh: z.literal(true).optional(),
});
export type AccessGrantView = z.infer<typeof accessGrantViewSchema>;

// ------------------------------------------------------------------ the RECORDS (persisted, strict)

/**
 * `crypto.randomUUID()`'s shape: a lowercase RFC 4122 version-4 uuid — a grant's id, an undo entry's
 * id. Memory (session) grants mint theirs the same way. Exported for the module's internal siblings
 * (the own journal, a run's `applied` seat — TASK-20261010-host-broker PR-4), never from the index:
 * one rule for every undo id the file holds.
 */
const UUID_V4_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const uuidV4Schema = z.string().regex(UUID_V4_RULE, 'a lowercase uuid v4');
const appIdSchema = z.string().min(1).max(ACCESS_APP_ID_MAX_CHARS);
const columnNameSchema = z.string().min(1).max(ACCESS_COLUMN_NAME_MAX_CHARS);

const hasNoDuplicates = (values: readonly string[]): boolean => new Set(values).size === values.length;

/**
 * One granted table with its columns as disclosed at consent — FROZEN: a later difference
 * suspends the grant (`source-changed`). `columns` are the GRANTED columns (the ones the user
 * ticked); `withheld` (1.2, D-PR3-2) the non-credential columns the user left UNTICKED — it
 * exists for the drift check (`columns ∪ withheld` against the live set) and the sheet, and
 * is OMITTED when empty (absent ≡ `[]`, the 1.1 meaning: nothing withheld). What may be read
 * is `columns` — one rule. A credential-named column (`isCredentialKeyName`: `api_key`,
 * `password`, `token`, …) is NEVER in either list (D14/Q2): the consent sheet shows it as
 * *never shared* and leaves it out, the drift check ignores such live columns, and the scoped
 * read masks any cell under one — so a planted or hand-edited grant naming it is a parse
 * refusal, not a mask's last line of defence. `write: true` (1.2) says the reader may change
 * this table's granted columns; it is OMITTED when false.
 */
const scopeTableSchema = z
  .strictObject({
    name: accessTableNameSchema,
    columns: z
      .array(columnNameSchema)
      .min(1)
      .max(ACCESS_MAX_COLUMNS)
      .refine(hasNoDuplicates, 'a column appears once')
      .refine((columns) => !columns.some(isCredentialKeyName), 'a credential-named column is never shared'),
    withheld: z
      .array(columnNameSchema)
      .max(ACCESS_MAX_COLUMNS)
      .refine(hasNoDuplicates, 'a withheld column appears once')
      .refine((columns) => !columns.some(isCredentialKeyName), 'a credential-named column is never in a scope')
      .optional(),
    write: z.literal(true).optional(),
  })
  .refine((table) => !(table.withheld ?? []).some((column) => table.columns.includes(column)), {
    path: ['withheld'],
    message: 'a column is granted or withheld, never both',
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
 * An access grant — the `accessGrant:<id>` settings row (ADR-0075 §2; ADR-0076 §4). Written
 * ONLY by the user's act on a host surface. Strict at every level; the serialised grant is
 * capped at 16 KiB; a credential anywhere (a credential-shaped purpose, above all) is a
 * REFUSAL. `status` and its reasons agree: `suspended` ⇔ `suspendedReason`, `revoked` ⇔
 * `revokedAt`; `access` and the scope agree: `'write'` ⇔ some table carries `write: true`.
 * Every 1.2 seat (`withheld`, `write`, `kv`, `refresh`) is optional with the 1.1 meaning when
 * absent and is OMITTED by the writer at its default (D-PR3-2) — a strict 1.1 parser refuses
 * a record that carries any of them, so a widened grant on a 1.1 hub is NO access (fail
 * closed, Q19).
 */
export const accessGrantSchema = z
  .strictObject({
    id: uuidV4Schema,
    readerAppId: appIdSchema,
    sourceAppId: appIdSchema,
    scope: accessScopeSchema,
    /** `'write'` exactly when some table carries `write: true` (the superRefine below); the record is strict where the view is not. */
    access: z.enum(ACCESS_LEVELS),
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
    /** The source's settings & notes (`snug_kv`) are in the scope too — through the ONE credential walk at the copy (D-PR3-22). */
    kv: z.literal(true).optional(),
    /** The reader may ask the source to fetch new data before a read (D-PR3-17). */
    refresh: z.literal(true).optional(),
  })
  .superRefine((grant, ctx) => {
    if (grant.readerAppId === grant.sourceAppId) {
      ctx.addIssue({ code: 'custom', path: ['sourceAppId'], message: 'an app never holds access to itself' });
    }
    if ((grant.access === 'write') !== grant.scope.tables.some((table) => table.write === true)) {
      ctx.addIssue({ code: 'custom', path: ['access'], message: 'access is "write" exactly when some table carries write: true' });
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

const REFRESH_REASON_SET = new Set<string>(ACCESS_REFRESH_REASONS);

/**
 * One entry of the `accessLog:<sourceAppId>` row — the source keeps the history (ADR-0075 §7;
 * ADR-0076 §5, D-PR3-6). Strict and capped per seat; a credential in an app-authored seat
 * (above all the logged statement) is a REFUSAL, so the host omits the `sql` seat when the
 * walk hits rather than persist it. The reader's NAME is host-written and is not walked.
 * The 1.2 seats ride particular kinds (the superRefine): `via` any kind; `authority` and
 * `undoId` a `wrote` line only; `changes` a `wrote` or `undone` line; a `refreshed` line's
 * `reason` is ONE of `ACCESS_REFRESH_REASONS` (a handler's words never reach a line), while
 * every other kind keeps the display-line rule for its reason.
 */
export const accessLogEntrySchema = z
  .strictObject({
    at: isoInstant,
    kind: z.enum(ACCESS_LOG_KINDS),
    grantId: uuidV4Schema,
    readerAppId: appIdSchema,
    /**
     * The reader's library name at the time — the source's history reads in words. HOST-written
     * from the library row and outside the credential walk: an app honestly named "Bearer Bonds"
     * must never be unloggable (the history may never lie about by whose act access began).
     */
    readerName: z.string().min(1).max(LIMITS.DISPLAY_NAME_CHARS),
    tables: z.array(accessTableNameSchema).max(ACCESS_MAX_TABLES).optional(),
    /** The statement's first 200 characters (a `read`, or a `wrote`'s forward statement) — walked on the FULL statement before the cut (`ACCESS_LOG_SQL_MAX_CHARS`). */
    sql: z.string().min(1).max(ACCESS_LOG_SQL_MAX_CHARS).refine(isSqlTextSafe, UNSAFE_SQL_TEXT_MESSAGE).optional(),
    rows: z.int().min(0).optional(),
    /** Coalesced identical `(grantId, sql)` reads within `ACCESS_LOG_COALESCE_MS`. */
    count: z.int().min(1).optional(),
    /** Whether the user was looking (`false` — *while you were away*). */
    attended: z.boolean().optional(),
    reason: z.string().min(1).max(ACCESS_LOG_REASON_MAX_CHARS).refine(isDisplaySafeLine, UNSAFE_DISPLAY_TEXT_MESSAGE).optional(),
    /** Arrived with an imported file — shown under its own heading. */
    imported: z.boolean().optional(),
    /** Which door asked (1.2) — `user` for an act from host chrome, such as an undo. */
    via: z.enum(ACCESS_LOG_VIAS).optional(),
    /** By whose authority a `wrote` line landed (1.2). */
    authority: z.enum(ACCESS_WRITE_AUTHORITIES).optional(),
    /** Rows a `wrote` line changed, or an `undone` line put back (1.2). */
    changes: z.int().min(0).optional(),
    /** The undo journal entry a `wrote` line can be reversed from (1.2) — live while the entry is. */
    undoId: uuidV4Schema.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind !== 'wrote') {
      if (entry.authority !== undefined) ctx.addIssue({ code: 'custom', path: ['authority'], message: 'authority rides only a "wrote" line' });
      if (entry.undoId !== undefined) ctx.addIssue({ code: 'custom', path: ['undoId'], message: 'undoId rides only a "wrote" line' });
    }
    if (entry.kind !== 'wrote' && entry.kind !== 'undone' && entry.changes !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['changes'], message: 'changes rides only a "wrote" or an "undone" line' });
    }
    if (entry.kind === 'refreshed' && entry.reason !== undefined && !REFRESH_REASON_SET.has(entry.reason)) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: `a "refreshed" line's reason is one of ${ACCESS_REFRESH_REASONS.join(', ')}` });
    }
    // Only the seats an app can AUTHOR are walked: the statement, the reason and the table
    // names. Host-written seats (readerName from the library row, ids, timestamps, the 1.2
    // enums and counts) are not — exactly as a grant's column names are identifiers, not values.
    const credential = findRecordCredential({ sql: entry.sql, reason: entry.reason, tables: entry.tables });
    if (credential) {
      ctx.addIssue({
        code: 'custom',
        message: `an access-log entry may not carry a credential (${credential.reason} at ${credential.path || '<root>'})`,
      });
    }
  });
export type AccessLogEntry = z.infer<typeof accessLogEntrySchema>;

// ------------------------------------------------------------------ the undo journal and the wants (persisted, strict)

/** Steps per undo entry — a frame's `write` is exactly one; the room is for PR-4's multi-statement approvals (the own journal reuses it). */
export const ACCESS_UNDO_MAX_STEPS = 64;

/**
 * One row a brokered write touched, as the journal keeps it: the rowid and the cells of the
 * step's `columns` in column order — `after` for an INSERT, `before` AND `after` for an
 * UPDATE, `before` for a DELETE (the step's `op` decides; the arity is the step's). Cells are
 * the bound-parameter scalars (`accessParamSchema`): a BLOB or an over-long text never enters
 * the journal — the apply refuses the write instead (D-Q15).
 */
export const accessUndoRowSchema = z.strictObject({
  rowid: z.int(),
  before: z.array(accessParamSchema).optional(),
  after: z.array(accessParamSchema).optional(),
});
export type AccessUndoRow = z.infer<typeof accessUndoRowSchema>;

/** The three statement shapes a brokered write may have (D-PR3-9) — the step's `op`. */
const ACCESS_UNDO_OPS = ['insert', 'update', 'delete'] as const;
type AccessUndoOp = (typeof ACCESS_UNDO_OPS)[number];

/** The seats a row holds under each op — the rule `accessUndoStepSchema` enforces per row. */
const UNDO_ROW_SEATS: Record<AccessUndoOp, { readonly before: boolean; readonly after: boolean }> = {
  insert: { before: false, after: true },
  update: { before: true, after: true },
  delete: { before: true, after: false },
};

/**
 * One statement's captured rows (D-PR3-7): the table, the op, the columns the values are
 * listed under (UPDATE: the SET columns in order; DELETE: every non-generated column; INSERT:
 * the INSERT list) and the rows. STRUCTURE, never statement text — the undo BUILDS its
 * statements at undo time from this, every identifier quoted and validated against the live
 * `table_xinfo`, every value a bound parameter (S3). The row cap is the write's own.
 */
export const accessUndoStepSchema = z
  .strictObject({
    table: accessTableNameSchema,
    op: z.enum(ACCESS_UNDO_OPS),
    columns: z.array(columnNameSchema).min(1).max(ACCESS_MAX_COLUMNS),
    /** At least one row: a step that captured none has nothing to put back and is never journaled (Gate-5 W-1 — the apply drops it; this is the belt). */
    rows: z.array(accessUndoRowSchema).min(1).max(ACCESS_WRITE_MAX_ROWS),
  })
  .superRefine((step, ctx) => {
    const seats = UNDO_ROW_SEATS[step.op];
    for (const [index, row] of step.rows.entries()) {
      for (const seat of ['before', 'after'] as const) {
        const cells = row[seat];
        if ((cells !== undefined) !== seats[seat]) {
          ctx.addIssue({ code: 'custom', path: ['rows', index, seat], message: `a row of an "${step.op}" step ${seats[seat] ? 'holds' : 'has no'} "${seat}" values` });
        } else if (cells !== undefined && cells.length !== step.columns.length) {
          ctx.addIssue({ code: 'custom', path: ['rows', index, seat], message: 'one value per column, in column order' });
        }
      }
    }
  });
export type AccessUndoStep = z.infer<typeof accessUndoStepSchema>;

/**
 * The two bounds every undo journal entry is held to, over the PARSED entry — the access journal's
 * and the own journal's alike (TASK-20261010-host-broker PR-4 D-PR4-3: extracted, not copied, so a
 * hand-edited row one schema refuses the other refuses too). The serialised entry is capped at
 * `ACCESS_UNDO_MAX_BYTES`; then EVERY captured cell is walked UNDER ITS COLUMN
 * (`findRecordCredential({ [column]: value })`, so the walk's key-context rule judges a
 * high-entropy value by the column it sits in) and a hit is a REFUSAL — a journal never holds a
 * credential, and the apply refuses a write whose captured values would (S12).
 */
export function refuseUndoOversizeOrCredential(entry: { readonly steps: readonly AccessUndoStep[] }, ctx: z.RefinementCtx): void {
  if (utf8ByteLength(JSON.stringify(entry)) > ACCESS_UNDO_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', message: `the serialized undo entry must be at most ${ACCESS_UNDO_MAX_BYTES} bytes` });
    return; // the walk below is bounded by the cap, not by the schema's row and step caps alone
  }
  for (const [stepIndex, step] of entry.steps.entries()) {
    for (const [rowIndex, row] of step.rows.entries()) {
      for (const seat of ['before', 'after'] as const) {
        for (const [cellIndex, value] of (row[seat] ?? []).entries()) {
          const column = step.columns[cellIndex];
          if (column === undefined) continue; // the arity issue is the step's
          const credential = findRecordCredential({ [column]: value });
          if (credential) {
            ctx.addIssue({
              code: 'custom',
              path: ['steps', stepIndex, 'rows', rowIndex, seat, cellIndex],
              message: `an undo entry may not carry a credential (${credential.reason} under ${column})`,
            });
            return;
          }
        }
      }
    }
  }
}

/**
 * One entry of the `accessUndo:<targetAppId>` row — the TARGET keeps the journal (ADR-0076 §5;
 * spec §22.4; D-PR3-7). Host-written after a brokered write committed; `readerName` is the
 * library name (host-written, not walked — the log entry's precedent, W-Q6). Held to
 * `refuseUndoOversizeOrCredential` above. An undone entry is kept, marked `undoneAt`, until it
 * expires; it is never offered again.
 */
export const accessUndoEntrySchema = z
  .strictObject({
    id: uuidV4Schema,
    at: isoInstant,
    expiresAt: isoInstant,
    authority: z.enum(ACCESS_WRITE_AUTHORITIES),
    via: z.enum(ACCESS_LOG_VIAS),
    grantId: uuidV4Schema,
    readerAppId: appIdSchema,
    readerName: z.string().min(1).max(LIMITS.DISPLAY_NAME_CHARS),
    steps: z.array(accessUndoStepSchema).min(1).max(ACCESS_UNDO_MAX_STEPS),
    undoneAt: isoInstant.optional(),
  })
  .superRefine(refuseUndoOversizeOrCredential);
export type AccessUndoEntry = z.infer<typeof accessUndoEntrySchema>;

/**
 * The builder-time declaration `accessWants:<appId>` (ADR-0076 §11, verbatim; D-PR3-7): what
 * an app WILL ask for, so the host can show it before the first ask — 1..4 asks of a purpose
 * and optional hints, each under the ask's own rules (one display-safe line, shareable table
 * names, never a credential), the whole capped at `ACCESS_WANTS_MAX_BYTES`. No other seat: an
 * access level, an app, a source or a table list has no place in a declaration — the user's
 * act decides those. Since PR-5 (D-PR5-2) the host DERIVES the row from the app's own html head
 * (`<meta name="snug:access-wants" content='…'>`, read by `@snugprotocol/db`'s
 * `extractAccessWants`) at every admission, and every import re-derives it — never a bundle
 * field, never trusted from a file.
 */
export const accessWantsSchema = z
  .array(z.strictObject({ purpose: accessPurposeSchema, hints: accessHintsSchema.optional() }))
  .min(1)
  .max(ACCESS_WANTS_MAX_ENTRIES)
  .superRefine((wants, ctx) => {
    if (utf8ByteLength(JSON.stringify(wants)) > ACCESS_WANTS_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the serialized declaration must be at most ${ACCESS_WANTS_MAX_BYTES} bytes` });
    }
  });
export type AccessWants = z.infer<typeof accessWantsSchema>;

// ------------------------------------------------------------------ identities

/** A scope table's intent seats with every default OMITTED — `withheld: []` and an absent `write` spell the 1.1 table. */
interface AccessTableIntent {
  readonly name: string;
  readonly columns: readonly string[];
  readonly withheld?: readonly string[];
  readonly write?: true;
}

const tableIntent = ({ name, columns, withheld, write }: AccessScope['tables'][number]): AccessTableIntent => ({
  name,
  columns,
  ...(withheld !== undefined && withheld.length > 0 ? { withheld } : {}),
  ...(write === true ? { write } : {}),
});

/**
 * Canonical bytes of a grant's INTENT — who reads (and may change) whom, what (the granted
 * columns, the withheld ones, which tables may be written, the settings & notes, a fetch on
 * request), why, for how long, unattended or not, and who asked — key-sorted, whitespace-free
 * JSON over the thirteen intent fields. Load-bearing for the IMPORT GUARD (ADR-0075 §9): an
 * imported grant stays active only when these bytes equal a local grant's. Every 1.2 seat is
 * normalised ABSENT ≡ DEFAULT (`withheld: []`, `write`/`kv`/`refresh` unset are left out of
 * the object), so a 1.1 record's bytes are EXACTLY today's nine-key string and a defaults-off
 * 1.2 record is intent-identical to it (a backup taken before the upgrade restores
 * unsuspended, F10), while a widened grant — any seat set — never is (W-Q2). Deliberately NOT
 * covered: `status`, `suspendedReason`, `revokedAt`, the counters (`reads`, `lastReadAt`,
 * `timeouts`), the timestamps and `readerVersion` — they move with ordinary use, and comparing
 * them would demote every grant of a backup taken before its next read (the
 * `canonicalScheduleIntent` reasoning). A canonical STRING, not a digest: the comparison is
 * exact and has no collision surface.
 */
export function canonicalAccessGrantIntent(grant: AccessGrant): string {
  const { id, readerAppId, sourceAppId, access, purpose, duration, unattended, provenance, kv, refresh } = grant;
  return canonicalJson({
    id,
    readerAppId,
    sourceAppId,
    scope: { tables: grant.scope.tables.map(tableIntent) },
    access,
    purpose,
    duration,
    unattended,
    provenance,
    ...(kv === true ? { kv } : {}),
    ...(refresh === true ? { refresh } : {}),
  });
}

/** The semantic fields of an `op: 'request'` frame (the frame itself satisfies this). `access` absent ≡ `'read'` (D-PR3-4). */
export interface AccessRequestSemantics {
  readonly hints?: { readonly words?: readonly string[]; readonly tables?: readonly string[] } | undefined;
  readonly renew?: string | undefined;
  readonly access?: AccessLevel | undefined;
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
 * the ask only when it names one of THIS reader's grants, else hashes it as absent.) An ask
 * for `write` is a DIFFERENT ask from the same hints read — a declined read ask does not
 * decline a later write ask, nor the reverse (D-PR3-4) — while absent and `'read'` hash to
 * the 1.1 bytes, so a decline recorded before the upgrade still matches (W-Q1).
 */
export function accessRequestHash(request: AccessRequestSemantics): string {
  const tables = normalisedHints(request.hints?.tables);
  const words = normalisedHints(request.hints?.words);
  return fnv1a64Hex(canonicalJson({ tables, words, renew: request.renew, ...(request.access === 'write' ? { access: 'write' } : {}) }));
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

/** One entry of the `accessUndo:<targetAppId>` row — `undefined` on junk, a strict failure or a credential cell. */
export function parseAccessUndoEntry(raw: string | null | undefined): AccessUndoEntry | undefined {
  return tolerantRead(accessUndoEntrySchema, raw);
}

/** The `accessWants:<appId>` declaration — `undefined` on junk (an app's declaration is never trusted further than this). */
export function parseAccessWants(raw: string | null | undefined): AccessWants | undefined {
  return tolerantRead(accessWantsSchema, raw);
}
