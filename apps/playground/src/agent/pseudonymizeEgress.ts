/**
 * pseudonymizeEgress — the HOST-ENFORCED half of third-party pseudonymisation
 * (TASK-20260820-host-pseudonymisation, threat-model R-9).
 *
 * Before an app-message wire from a sidecar-connected app reaches ANY provider — BYOK,
 * local, or the subscription hub's /invoke, all behind the one transport seam — every
 * harvested identity and the jid/phone primitives are redacted from it. The shipped
 * WhatsApp app still runs its own P-label scrub (stable per-thread labels are a UX
 * property only the app can own); THIS module is the boundary that binds every app,
 * including one whose own scrub was rewritten away by the feature lane.
 *
 * THE HONEST FRAME: anti-default and anti-naive, not anti-adversarial. Substring
 * redaction stops raw identities flowing by default and by sloppiness; a deliberately
 * obfuscating app (homoglyphs, base64, numbers-as-JSON-numbers) still defeats it, and
 * the threat model discloses exactly that.
 *
 * Redaction operates on the PARSED envelope — every string value AND every object key,
 * across `state`, `payload`, `action`, `responseSchema` and the ids alike (fresh-context
 * plan review 2026-08-20, blocker 1: a well-formed `responseSchema` must not be an
 * in-band smuggling channel; and a name containing a JSON metacharacter is `\"`-escaped
 * on the wire, where substring replacement would miss it). A wire that fails
 * `parseAppRequest` is unescape-normalised and redacted as a raw string — the malformed
 * path must never be the weaker path.
 */

import {
  ERROR_CODES,
  buildAppRequest,
  parseAppRequest,
  type EnvelopeInput,
} from '@snugprotocol/protocol';

import { readIdentityDirectory } from '../state/sidecarIdentity.js';
import { resolveSidecarSlot } from '../state/sidecarLive.js';
import { getUserDb } from '../state/userdb.js';

export const CONTACT_TOKEN = '[contact]';
export const NUMBER_TOKEN = '[number]';

/**
 * The primitives, carried verbatim from the reference scrub (examples/whatsapp/app.html
 * AC12 lineage): a jid in any of WhatsApp's address spaces, and a digit run long enough
 * to be dialable however it is spaced, dotted, dashed or bracketed. The attacker is not
 * adversarial, it is FORMATTING.
 */
const JID_PATTERN = /\b[\w.-]+@(?:s\.whatsapp\.net|g\.us|c\.us|lid|broadcast)\b/gi;
// One deliberate widening over the reference: a leading '(' is consumed too, so
// '(555) 123-4567' redacts whole instead of leaving a stray parenthesis behind.
const PHONE_PATTERN = /(?:\+|\()?\d[\d\s(). -]{6,}\d/g;

/** The pseudonym vocabulary the shipped app emits — never rewritten (AC6). */
const LABEL_SHAPE = /^(?:P\d+|YOU)$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One compiled longest-first case-insensitive alternation over the directory — one pass
 * over the text instead of one pass per identity (plan review F12: per-identity
 * split/join over a 150 KB wire and a few-thousand-entry directory scans hundreds of
 * megabytes per turn). Word boundaries wrap each alternative whose edges are word
 * characters, so "News" in the directory cannot gut "Newsworthy" (F10).
 */
export function compileDirectoryMatcher(identities: readonly string[]): RegExp | undefined {
  const usable = [
    ...new Set(
      identities.filter(
        (id) => typeof id === 'string' && id.trim().length >= 3 && !LABEL_SHAPE.test(id),
      ),
    ),
  ].sort((a, b) => b.length - a.length);
  if (usable.length === 0) return undefined;
  const alternatives = usable.map((id) => {
    const escaped = escapeRegExp(id);
    const pre = /^\w/.test(id) ? '\\b' : '';
    const post = /\w$/.test(id) ? '\\b' : '';
    return `${pre}${escaped}${post}`;
  });
  return new RegExp(alternatives.join('|'), 'gi');
}

function redactWithMatcher(text: string, matcher: RegExp | undefined): string {
  let out = matcher === undefined ? text : text.replace(matcher, CONTACT_TOKEN);
  out = out.replace(JID_PATTERN, CONTACT_TOKEN);
  out = out.replace(PHONE_PATTERN, (hit) => {
    // Short digit runs are quantities, prices and times — redacting them would gut the
    // text. Seven digits is the shortest dialable number. Dash-separated dates fall on
    // the redacted side (8 digits): over-redaction is the safe direction, and the test
    // suite pins it as documented behavior.
    return hit.replace(/\D/g, '').length >= 7 ? NUMBER_TOKEN : hit;
  });
  return out;
}

/** Redact one free-text string: directory identities, then the primitives. */
export function scrubText(text: string, identities: readonly string[]): string {
  return redactWithMatcher(text, compileDirectoryMatcher(identities));
}

/** Every string VALUE and every object KEY, recursively. Numbers pass (disclosed residual). */
function deepRedact(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((entry) => deepRedact(entry, redact));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[redact(key)] = deepRedact(entry, redact);
    return out;
  }
  return value;
}

/** `\uXXXX` → the character it spells, so the raw fallback cannot be dodged by escaping. */
function unescapeUnicode(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Scrub one LLM-bound wire. Parsed path for a valid envelope (walks the WHOLE envelope);
 * unescape-normalised raw-string path for anything else. A cooperating app's canonical
 * `JSON.stringify` wire with no raw identities round-trips byte-identical.
 */
export function scrubAppWire(wire: string, identities: readonly string[]): string {
  const matcher = compileDirectoryMatcher(identities);
  const redact = (text: string): string => redactWithMatcher(text, matcher);
  const parsed = parseAppRequest(wire);
  if (parsed.ok) {
    const { snug: _snug, ...rest } = parsed.envelope;
    return buildAppRequest(deepRedact(rest, redact) as EnvelopeInput);
  }
  return redact(unescapeUnicode(wire));
}

export type WireGuardResult =
  | { ok: true; wire: string }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * The per-send guard the app transport calls (AC8b: predicate and directory are read
 * HERE, at send time — a connection approved while RunView is mounted must bind the very
 * next send; the stale-capture defect class transport.ts documents twice).
 *
 * FAIL CLOSED (AC8c): if the user DB cannot be read, the send is refused by name — a
 * backstop that silently degrades to raw-to-provider on a read hiccup is not a boundary.
 * Apps without a sidecar-ceiling connection pass through byte-identical: the scrub's
 * population is exactly R-9's (owner decision 2026-08-20).
 */
export async function guardWireForApp(
  appId: string,
  wire: string,
  getDb: () => Promise<Parameters<typeof resolveSidecarSlot>[0]> = getUserDb,
): Promise<WireGuardResult> {
  try {
    const db = await getDb();
    if (resolveSidecarSlot(db, appId) === undefined) return { ok: true, wire };
    return { ok: true, wire: scrubAppWire(wire, readIdentityDirectory(db)) };
  } catch {
    return {
      ok: false,
      code: ERROR_CODES.HOST_ERROR,
      message:
        'the privacy scrub could not run (the pseudonymisation directory was unreadable), so the request was not sent — try again',
      retryable: true,
    };
  }
}
