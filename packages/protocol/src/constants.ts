/** Wire protocol version carried in every postMessage frame (`v`) and chat envelope (`snug`). */
export const PROTOCOL_VERSION = 1 as const;

/**
 * The chat-envelope tag prefixed to app requests sent through the host's agent endpoint.
 * This is the ONLY definition — prompt templates receive it via injection ({{envelopeTag}}),
 * never as a retyped literal (ancestors duplicated it in four places).
 */
export const SNUG_APP_REQUEST_TAG = '[SNUG_APP_REQUEST]';

/** postMessage frame `type` literals. The `snug:` prefix namespace is reserved (rule R2). */
export const FRAME_TYPES = {
  announce: 'snug:app-announce',
  hostReady: 'snug:host-ready',
  appMessage: 'snug:app-message',
  appCancel: 'snug:app-cancel',
  appResponse: 'snug:app-response',
  dbRequest: 'snug:db-request',
  dbResponse: 'snug:db-response',
  hostEvent: 'snug:host-event',
  appEvent: 'snug:app-event',
  /** The envelope net capability (AL-03; PUBLISHED at spec v0.3 — in json-schemas SOURCES since TASK-20260820-spec-v03-whitepaper). */
  netRequest: 'snug:net-request',
  netResponse: 'snug:net-response',
  /**
   * The open-url capability (ADR-0038 D5, TASK-20260818; PUBLISHED at spec v0.3 in
   * json-schemas SOURCES alongside the net pair) — an app may REQUEST the host open an
   * https URL; a host confirm dialog and a user gesture sit between the request and any
   * window. Host-ready's `openUrl` capability flag advertises it.
   */
  openUrlRequest: 'snug:open-url-request',
  openUrlResult: 'snug:open-url-result',
} as const;

export type FrameType = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];

/**
 * Known error codes (rule R5). The wire accepts any string so v1.x can add codes without
 * breaking v1.0 parsers; receivers handle unknown codes via `retryable` and render them
 * as HOST_ERROR. CONSENT_REQUIRED and AUTH_REQUIRED are reserved (auth broker is v1.1).
 */
export const ERROR_CODES = {
  PARSE_FAILED: 'PARSE_FAILED',
  THREAD_CONFLICT: 'THREAD_CONFLICT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  RESET_FAILED: 'RESET_FAILED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  HOST_ERROR: 'HOST_ERROR',
} as const;

export type KnownErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const KNOWN_ERROR_CODES = new Set<string>(Object.values(ERROR_CODES));

export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN_ERROR_CODES.has(code);
}

/** R5: receivers render unknown codes as HOST_ERROR and honor the frame's `retryable` flag. */
export function classifyErrorCode(code: string): KnownErrorCode {
  return isKnownErrorCode(code) ? code : ERROR_CODES.HOST_ERROR;
}

/**
 * Size and retry limits (rule R6). Backoff values inherited from the hardened ancestor.
 * db-request/db-response frames get their own size class (MAX_DB_FRAME_BYTES) so a
 * base64-encoded MAX_ARTIFACT_BYTES `.sqlite` file can round-trip through the db bridge
 * (v0.1-draft amendment, TASK-20260731-runner-sandbox).
 */
export const LIMITS = {
  MAX_FRAME_BYTES: 256 * 1024,
  MAX_DB_FRAME_BYTES: 8 * 1024 * 1024,
  /**
   * net-request/net-response size class (AL-03 amendment B1): the 1 MiB response body
   * cap plus a 64 KiB envelope margin (status/headers/ids/JSON quoting). Mirrors the db
   * class so a cap-sized scrubbed body crosses the bridge and an oversized one becomes a
   * SMALL terminal NET_SIZE_EXCEEDED error — never a silent drop.
   */
  MAX_NET_FRAME_BYTES: 1024 * 1024 + 64 * 1024,
  /** Request body ceiling for `snug:net-request` (bytes, executor-enforced). */
  MAX_NET_REQUEST_BODY_BYTES: 256 * 1024,
  /** Response body ceiling the connected-fetch executor enforces WHILE reading (inherited from an ancestor system). */
  MAX_NET_RESPONSE_BODY_BYTES: 1024 * 1024,
  MAX_ARTIFACT_BYTES: 5 * 1024 * 1024,
  RAW_EXCERPT_CHARS: 200,
  MAX_PARSE_FAILURES: 3,
  THREAD_CONFLICT_BACKOFF_MS: [100, 250, 500],
  DISPLAY_NAME_CHARS: 80,
  DESCRIPTION_CHARS: 400,
  ICON_EMOJI_CHARS: 8,
  ICON_COLOR_CHARS: 32,
  ACTION_CHARS: 128,
  ID_CHARS: 128,
} as const;

/**
 * Headers that MUST be stripped from any app-originated request before it reaches an
 * adapter, a publisher, or an LLM payload (hard constraint C1). Lower-case canonical.
 */
export const STRIP_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
] as const;

/** The pinned HTTP method set for `snug:net-request` (AL-03 plan D1). */
export const NET_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type NetMethod = (typeof NET_METHODS)[number];

/** Methods that require user confirmation through the host's confirm gate (AL-03 plan D3.6). */
export const NET_MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Error codes for `snug:net-response` (AL-03 plan D1). Same open-string wire rule as
 * ERROR_CODES (R5): receivers handle unknown codes via `retryable`.
 * NET_SCRUBBED_HEADER_STRIPPED is RESERVED (like CONSENT_REQUIRED above): a future rev
 * may use it to report that app-supplied credential-shaped headers were stripped —
 * today the schema rejects them at the bridge and the executor silently strips (C1).
 */
export const NET_ERROR_CODES = {
  NET_INVALID_REQUEST: 'NET_INVALID_REQUEST',
  NET_NOT_APPROVED: 'NET_NOT_APPROVED',
  NET_IMPORTED_UNAPPROVED: 'NET_IMPORTED_UNAPPROVED',
  /**
   * Dynamic Auth v2 (P1): TWO approved grants in one app claim the SAME target host, so
   * host-based slot routing has no unique answer. v3 could not produce this code —
   * `snug_auth_specs.app_id` was the whole primary key, so "which connection?" had exactly
   * one answer — and v4's `(app_id, slot)` key makes the question genuinely ambiguous.
   *
   * A REFUSAL, never a tiebreak. Picking "the first row" would send provider A's secret to
   * a host provider B also claims, which is credential theft performed by the host itself.
   * Doctrine caps apps at one connection (Q4), so this state is a bug or an attack rather
   * than a routine case, and it is decided BEFORE any credential is read.
   */
  NET_AMBIGUOUS_CONNECTION: 'NET_AMBIGUOUS_CONNECTION',
  NET_SCHEME_BLOCKED: 'NET_SCHEME_BLOCKED',
  NET_HOST_BLOCKED: 'NET_HOST_BLOCKED',
  NET_SSRF_BLOCKED: 'NET_SSRF_BLOCKED',
  NET_CONFIRM_DENIED: 'NET_CONFIRM_DENIED',
  NET_REDIRECT_BLOCKED: 'NET_REDIRECT_BLOCKED',
  NET_SIZE_EXCEEDED: 'NET_SIZE_EXCEEDED',
  NET_FETCH_FAILED: 'NET_FETCH_FAILED',
  NET_AUTH_FAILED: 'NET_AUTH_FAILED',
  NET_SCRUBBED_HEADER_STRIPPED: 'NET_SCRUBBED_HEADER_STRIPPED',
} as const;

export type NetErrorCode = (typeof NET_ERROR_CODES)[keyof typeof NET_ERROR_CODES];

/**
 * Response headers allowed to cross the bridge on a net-response (AL-03 plan D1 +
 * open Q2: `link` for pagination). WHITELIST-only: `set-cookie` and everything else is
 * dropped before the frame is built (amendment A2), and whitelisted VALUES are still
 * scrubbed for injected credential values (amendment R1). Lower-case canonical.
 */
export const NET_RESPONSE_HEADER_WHITELIST = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'retry-after',
  'link',
] as const;

const NET_RESPONSE_HEADER_SET = new Set<string>(NET_RESPONSE_HEADER_WHITELIST);

/** Whitelist membership, case-insensitive, plus the `x-ratelimit-*` glob (open Q2). */
export function isWhitelistedNetResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return NET_RESPONSE_HEADER_SET.has(lower) || lower.startsWith('x-ratelimit-');
}

/** Fixed CDN allowlist seed for the runner CSP (hard constraint C2 — never widened at runtime). */
export const CDN_ALLOWLIST = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
] as const;
