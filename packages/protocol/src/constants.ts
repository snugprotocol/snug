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

/** Size and retry limits (rule R6). Backoff values inherited from the hardened ancestor. */
export const LIMITS = {
  MAX_FRAME_BYTES: 256 * 1024,
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

/** Fixed CDN allowlist seed for the runner CSP (hard constraint C2 — never widened at runtime). */
export const CDN_ALLOWLIST = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
] as const;
