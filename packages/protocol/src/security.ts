import { STRIP_HEADERS } from './constants.js';

const STRIP_SET = new Set<string>(STRIP_HEADERS);

/**
 * C1 deterministic MUST: remove credential-bearing headers from any app-originated
 * request before it reaches an adapter, publisher, or LLM payload. Pure — returns a copy.
 */
export function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIP_SET.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export interface CredentialFinding {
  path: string;
  reason: 'bearer-prefix' | 'jwt-shape' | 'known-key-prefix' | 'high-entropy' | 'credential-key-name';
}

export interface CredentialScan {
  /** High-confidence credential VALUES — callers reject the payload. */
  rejects: CredentialFinding[];
  /** Key-name-only hits (e.g. a chess app's `token: 'rook'`) — log/telemetry, never reject. */
  warnings: CredentialFinding[];
}

/**
 * The JWT shape, ONE home (TASK-20261023-siwc-chatgpt-plan AC10, lesson L191): three base64url
 * segments of at least 8 characters each, the first a JSON header (`eyJ`). `jwtShapeInText`
 * finds it inside prose for the redaction seats (the Responses adapter's error-body backstop,
 * the inspector's display mode) — a ChatGPT-plan access token is a JWT, and a provider 401
 * echoes the bearer it was sent. The scanner below judges a WHOLE value by the same shape
 * through `isWholeJwtValue`, without the bound (see there).
 */
export const JWT_SHAPE_SOURCE = String.raw`eyJ[\w-]{8,4093}\.[\w-]{8,4096}\.[\w-]{8,4096}`;
// Each segment of the IN-TEXT matcher is BOUNDED (4 096 characters, the `eyJ` prefix counted): the
// unbounded form made the prose matcher overflow V8's regex stack on an 8 MiB unbroken `eyJ…` run
// (measured 2026-10-24, TASK-20261023-siwc-chatgpt-plan §12 L5-7). A real JWT segment is a few
// kilobytes; a megabyte run is not a token, and every consumer — the Responses adapter's backstop,
// the inspector's display redaction — must stay linear on multi-megabyte payloads.
/** A FRESH global, word-bounded matcher per call — a shared `g` regex would carry `lastIndex` between callers. */
export function jwtShapeInText(): RegExp {
  return new RegExp(String.raw`\b${JWT_SHAPE_SOURCE}`, 'g');
}

const JWT_SEGMENT_MIN = 8;

/** `[\w-]` as a character walk — linear, no regex engine, no length limit. */
function isBase64UrlRun(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
    if (!ok) return false;
  }
  return true;
}

/**
 * The ANCHORED whole-value rule the scanner rejects on, kept UNBOUNDED on purpose (Gate 5 S7):
 * built from the bounded source above, a JWT whose payload ran past 4 096 characters sailed
 * through the C1 scanner — measured. A whole value is a token when it splits on `.` into
 * exactly three `[\w-]` segments of at least 8 characters, the first starting `eyJ`. A split
 * and a charset walk per segment: linear in the value's length, so the 8 MiB payload that
 * motivated the bound still completes here.
 */
function isWholeJwtValue(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [head, payload, signature] = parts as [string, string, string];
  if (!head.startsWith('eyJ')) return false;
  for (const segment of [head, payload, signature]) {
    if (segment.length < JWT_SEGMENT_MIN || !isBase64UrlRun(segment)) return false;
  }
  return true;
}
const BEARER_PREFIX = /^bearer\s+\S+/i;
/** Well-known provider secret prefixes (OpenAI/Anthropic sk-, GitHub ghp_/gho_, Slack xox, AWS AKIA, Stripe rk_/sk_live). */
const KNOWN_KEY_PREFIX = /^(sk-[\w-]{16,}|sk_(live|test)_[\w]{16,}|rk_(live|test)_[\w]{16,}|ghp_[\w]{20,}|gho_[\w]{20,}|xox[abps]-[\w-]{10,}|AKIA[A-Z0-9]{16})/;
const KEY_NAME = /(authorization|passw(or)?d|secret|api[_-]?key|(access|refresh|id|session)[_-]?token|client[_-]?secret|private[_-]?key|credential)/i;
const BARE_TOKEN_KEY = /^tokens?$/i;

/**
 * Whether a KEY NAME (a JSON key, a column name) is credential-ish — the ONE definition the
 * value scan below uses for its key-context rule, exported so other surfaces judge a name
 * the same way (TASK-20261010-cross-app-access AC7/AC12/D14: `describeAppData` flags such a
 * column `sensitive`, a grant's scope never names one, and the scoped read masks every cell
 * under one). Unanchored on purpose, like the scan: `secretary` reads as sensitive — the
 * cost of a false positive is one column withheld from sharing, the cost of a miss is a key.
 */
export function isCredentialKeyName(name: string): boolean {
  return KEY_NAME.test(name) || BARE_TOKEN_KEY.test(name);
}

/**
 * C1 value-shape scan for app payload/state bound for an LLM or external party.
 * Defense-in-depth only — C1 load-bearing enforcement is stripCredentialHeaders at the
 * envelope boundary plus the token-boundary design (credentials never enter the iframe).
 * Rejects: unambiguous credential shapes (Bearer/JWT/known provider prefixes), and
 * high-entropy strings sitting under a credential-ish key name. Warnings: key-name-only
 * hits (`{token: 'rook'}`) and entropy-only hits under neutral keys (compressed app state
 * is legitimately high-entropy). Callers should not scan db `bytesBase64` traffic.
 */
export function scanForCredentialValues(input: unknown): CredentialScan {
  const rejects: CredentialFinding[] = [];
  const warnings: CredentialFinding[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, path: string, keyName?: string): void => {
    if (typeof value === 'string') {
      const credentialishKey = keyName !== undefined && isCredentialKeyName(keyName);
      if (BEARER_PREFIX.test(value)) rejects.push({ path, reason: 'bearer-prefix' });
      else if (isWholeJwtValue(value)) rejects.push({ path, reason: 'jwt-shape' });
      else if (KNOWN_KEY_PREFIX.test(value)) rejects.push({ path, reason: 'known-key-prefix' });
      else if (isHighEntropySecret(value)) {
        (credentialishKey ? rejects : warnings).push({ path, reason: 'high-entropy' });
      } else if (credentialishKey) {
        warnings.push({ path, reason: 'credential-key-name' });
      }
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key, key);
    }
  };

  visit(input, '');
  return { rejects, warnings };
}

/**
 * Secret heuristic: long, spaceless, mixed-class strings with high Shannon entropy.
 * Tuned to catch API-key/secret shapes while passing prose, FEN strings, and UUIDs-in-sentences.
 */
function isHighEntropySecret(value: string): boolean {
  if (value.length < 32 || value.length > 512 || /\s/.test(value)) return false;
  const classes =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/\d/.test(value)) + Number(/[^a-zA-Z0-9]/.test(value));
  if (classes < 3) return false;
  return shannonEntropy(value) > 4.2;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
