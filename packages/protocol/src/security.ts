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
  reason: 'bearer-prefix' | 'jwt-shape' | 'high-entropy' | 'credential-key-name';
}

export interface CredentialScan {
  /** High-confidence credential VALUES — callers reject the payload. */
  rejects: CredentialFinding[];
  /** Key-name-only hits (e.g. a chess app's `token: 'rook'`) — log/telemetry, never reject. */
  warnings: CredentialFinding[];
}

const JWT_SHAPE = /^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/;
const BEARER_PREFIX = /^bearer\s+\S+/i;
const KEY_NAME = /(authorization|passw(or)?d|secret|api[_-]?key|(access|refresh|id|session)[_-]?token|client[_-]?secret|private[_-]?key|credential)/i;
const BARE_TOKEN_KEY = /^tokens?$/i;

/**
 * C1 value-shape scan for app payload/state bound for an LLM or external party.
 * Value shapes (Bearer/JWT/high-entropy) are rejects; key names alone are warnings
 * (review finding 4: `{token: 'rook'}` must not break a chess app).
 */
export function scanForCredentialValues(input: unknown): CredentialScan {
  const rejects: CredentialFinding[] = [];
  const warnings: CredentialFinding[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, path: string, keyName?: string): void => {
    if (typeof value === 'string') {
      if (BEARER_PREFIX.test(value)) rejects.push({ path, reason: 'bearer-prefix' });
      else if (JWT_SHAPE.test(value)) rejects.push({ path, reason: 'jwt-shape' });
      else if (isHighEntropySecret(value)) rejects.push({ path, reason: 'high-entropy' });
      else if (keyName && (KEY_NAME.test(keyName) || BARE_TOKEN_KEY.test(keyName))) {
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
