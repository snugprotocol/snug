/**
 * Guards shared by every record a Snug host persists in the user's file from app- or
 * AI-authored input (TASK-20261010-cross-app-access D8). ONE home for:
 *
 *  - the SQL statement rules (`SINGLE_STATEMENT_RULE`, `SELECT_PREFIX_RULE`, `DML_PREFIX_RULE`,
 *    `FORBIDDEN_TOKEN_RULE`, `CTE_WRITE_RULE`) and `isReadOnlySelect` — the scheduler's
 *    `app-think` context query (ADR-0074) and the access read (ADR-0075 §6) refuse with the
 *    SAME rule, so a fix to one is a fix to both;
 *  - the credential walk `findRecordCredential` — a scheduled task, a run, a proposal, an
 *    access grant and an access-log entry all refuse a credential with the SAME walk;
 *  - the canonical-JSON and FNV-1a helpers the records' identities are built from.
 *
 * `schedule.ts` re-exports `findScheduleCredential` (= `findRecordCredential`),
 * `ScheduleCredentialIssue` (= `RecordCredentialIssue`) and `isReadOnlySelect`, so its public
 * surface and every scheduling test row are unchanged by the move.
 *
 * Browser-safe; no node imports (the package rule).
 */

import { STRIP_HEADERS } from './constants.js';
import { scanForCredentialValues, type CredentialFinding } from './security.js';

// ------------------------------------------------------------- SQL statement rules

/** No `;` except an optional trailing one — ONE statement. */
export const SINGLE_STATEMENT_RULE = /^[^;]*;?\s*$/;
/** A read starts with `SELECT` or `WITH`. */
export const SELECT_PREFIX_RULE = /^\s*(?:SELECT|WITH)\b/i;
/** A data change starts with `INSERT`, `UPDATE` or `DELETE`. */
export const DML_PREFIX_RULE = /^\s*(?:INSERT|UPDATE|DELETE)\b/i;
/** Never in a guarded statement, read or write: these reach outside the app's own data. */
export const FORBIDDEN_TOKEN_RULE = /\b(?:ATTACH|DETACH|PRAGMA)\b/i;
/** A `WITH … INSERT|UPDATE|DELETE|REPLACE` is the one write a SELECT-prefix rule would let through. */
export const CTE_WRITE_RULE = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * ONE statement that starts with `SELECT` or `WITH`, no `;` before an optional trailing one,
 * no ATTACH/DETACH/PRAGMA anywhere, and no DML keyword after a `WITH` prefix (the CTE-prefixed
 * write forms). A regex cannot parse SQL, so this is deliberately narrow; the receiving side
 * is read-only by construction (`scratchRun`, ADR-0019; the scoped scratch read, ADR-0075 §6)
 * — this is the boundary's half, not the only half.
 */
export function isReadOnlySelect(sql: string): boolean {
  if (!SELECT_PREFIX_RULE.test(sql)) return false;
  if (!SINGLE_STATEMENT_RULE.test(sql)) return false;
  if (FORBIDDEN_TOKEN_RULE.test(sql)) return false;
  if (/^\s*WITH\b/i.test(sql) && CTE_WRITE_RULE.test(sql)) return false;
  return true;
}

// ------------------------------------------------------------- credential refusal

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

/**
 * Opening punctuation a token can lead with — a quoted SQL literal (`'sk-…'`), a parenthesis
 * (`IN ("eyJ…")`), a bracket. Stripped before the token is scanned (TASK-20261010-cross-app-access:
 * the access log's `sql` seat is SQL, where a value sits inside quotes, not between spaces).
 */
const LEADING_PUNCTUATION_RULE = /^[(['"`{<]+/;

/**
 * Where a free-text string is cut into tokens: whitespace, and the separators and SQL
 * operators a value sits between or is glued to (`k='sk-…'`, `IN (a,b)`, `k<>'sk-…'`,
 * `k||'sk-…'`, `LIKE '%sk-…'`, `key:sk-…`, `a;sk-…`). None of these characters occurs inside
 * a Bearer token, a JWT or a known provider key, so cutting on them can only reveal a shape,
 * never split one. (`:` is safe to cut on: `URL_USERINFO_RULE` runs on the WHOLE string first.)
 */
const TOKEN_SPLIT_RULE = /[\s=,()<>|;:%]+/;

/**
 * The opaque half of a `Bearer <token>` pair met MID-TEXT (the scanner's Bearer shape is
 * anchored at a value's start, and a token never contains the space the pair needs): at
 * least 16 token characters with a digit, token punctuation or an inner case change — so a
 * random credential matches and prose (`the bearer of news`, `Bearer Bonds`, `bearer
 * responsibilities`) does not.
 */
const BEARER_WORD_RULE = /^bearer$/i;
const BEARER_TOKEN_CHARS_RULE = /^[A-Za-z0-9._~+/=-]{16,}$/;
const BEARER_TOKEN_SIGNAL_RULE = /[0-9._~+/=]|[a-z][A-Z]/;

export interface RecordCredentialIssue {
  path: string;
  reason: 'auth-like-key' | 'url-userinfo' | CredentialFinding['reason'];
}

/**
 * One string through the security module's VALUE scan — under its key, so the scanner's
 * key-context rule (high entropy under a credential-ish key rejects; under a neutral key
 * it only warns) holds exactly as it does on an envelope. The scanner's shapes are
 * anchored to the start of a value, and a prompt, a reply summary, a purpose or a logged
 * statement is free text, so the text is also scanned with its leading punctuation
 * stripped (`"Bearer …"`), token by token (`Use sk-… to fetch.`, `WHERE k = 'sk-…'`,
 * `k<>'sk-…'`), and pair by pair for a mid-text or quoted `Bearer <token>`
 * (`WHERE h = 'Bearer …'`).
 */
function credentialValueReason(text: string, keyName: string | undefined): CredentialFinding['reason'] | undefined {
  const whole = scanForCredentialValues(keyName === undefined ? text : { [keyName]: text }).rejects[0];
  if (whole) return whole.reason;
  const unquoted = text.replace(LEADING_PUNCTUATION_RULE, '');
  if (unquoted !== text && unquoted !== '') {
    const hit = scanForCredentialValues(unquoted).rejects[0];
    if (hit) return hit.reason;
  }
  const tokens = text
    .split(TOKEN_SPLIT_RULE)
    .map((raw) => raw.replace(LEADING_PUNCTUATION_RULE, '').replace(TRAILING_PUNCTUATION_RULE, ''))
    .filter((token) => token !== '');
  for (const [index, token] of tokens.entries()) {
    if (token !== text) {
      const hit = scanForCredentialValues(token).rejects[0];
      if (hit) return hit.reason;
    }
    const next = tokens[index + 1];
    if (BEARER_WORD_RULE.test(token) && next !== undefined && BEARER_TOKEN_CHARS_RULE.test(next) && BEARER_TOKEN_SIGNAL_RULE.test(next)) {
      const hit = scanForCredentialValues(`Bearer ${next}`).rejects[0];
      if (hit) return hit.reason;
    }
  }
  return undefined;
}

/**
 * The ONE credential walk for everything a host persists from app- or AI-authored input
 * (scheduled tasks, runs, proposals — ADR-0074 §6; access grants and access-log entries —
 * ADR-0075 §2, §7). Three refusals: an authorization-like KEY at any depth
 * (case-insensitive — free JSON is exactly where an app would try to smuggle a header map),
 * a URL with userinfo in any string, and the security module's high-confidence VALUE shapes
 * (Bearer, JWT, known provider prefixes, high entropy under a credential-ish key), whole or
 * embedded in free text. The scanner's warnings (`token: 'rook'`) never refuse — a record
 * is strict, not paranoid.
 */
export function findRecordCredential(value: unknown): RecordCredentialIssue | undefined {
  const seen = new Set<object>();
  const walk = (node: unknown, path: string, keyName: string | undefined): RecordCredentialIssue | undefined => {
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

// ------------------------------------------------------------- record identity helpers

/** UTF-8 byte length — every record's whole-object cap is measured in BYTES, never characters. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}

/** Key-sorted (recursively), whitespace-free JSON. Array order is meaningful and kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64 over the text's UTF-8, as 16 lowercase hex digits. SYNCHRONOUS on purpose: a
 * dedupe key decided in a render path ("already pending / already declined"), never a
 * security boundary — the user's consent surface is the boundary, and it shows the fields
 * themselves, not the hash.
 */
export function fnv1a64Hex(text: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}
