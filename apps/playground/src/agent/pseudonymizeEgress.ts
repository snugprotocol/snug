/**
 * pseudonymizeEgress — the HOST-ENFORCED half of third-party pseudonymisation
 * (TASK-20260820-host-pseudonymisation, threat-model R-9).
 *
 * Before an app-message wire from a sidecar-connected app reaches ANY provider — BYOK,
 * local, or the subscription hub's /invoke — every harvested identity and the jid/phone
 * primitives are redacted from it. The guard lives in BOTH leaf transport producers
 * (`createDirectAppTransport`, `createServerAppTransport`), not only the RunView wrapper,
 * so a future call site reaching a lower export is bound by construction (Gate-5 review,
 * altitude finding 5). The shipped WhatsApp app still runs its own P-label scrub (stable
 * per-thread labels are a UX property only the app can own); THIS module is the boundary
 * that binds every app, including one whose own scrub was rewritten away.
 *
 * THE SCRUB POPULATION is the sidecar connection FACT in any status
 * (`appHasSidecarFact`), not approval: a `declared` row — the state every IMPORTED
 * connection lands in — cannot serve traffic, but the app's imported SQLite still holds
 * replayable thread content (Gate-5 review, cross-file finding 1).
 *
 * THE HONEST FRAME: anti-default and anti-naive, not anti-adversarial. Substring
 * redaction stops raw identities flowing by default and by sloppiness; a deliberately
 * obfuscating app (homoglyphs, base64, numbers-as-JSON-numbers, identities glued to word
 * characters) still defeats it, and the threat model discloses exactly that.
 *
 * WHAT IS WALKED, AND WHAT DELIBERATELY IS NOT:
 *  - `action`, `payload`, `state`: every string value AND every object key (plan-review
 *    blocker 1 — a well-formed envelope must not smuggle in-band; and a name containing
 *    a JSON metacharacter is `\"`-escaped on the wire, where raw substring replacement
 *    would miss it).
 *  - `responseSchema`: string VALUES only, with the directory matched CASE-SENSITIVELY.
 *    Keys and `required` entries define the reply shape the app parses; a chat saved as
 *    "Home" must not case-fold onto a `home` property and silently break every
 *    structured reply (Gate-5 review, cross-file finding 2). Case-variant smuggling via
 *    schema tokens joins the disclosed obfuscation residual.
 *  - `appId`, `instanceId`, `requestId`: passed through VERBATIM. They are host/runner-
 *    minted ids the model may echo for correlation; `PHONE_PATTERN` rewrites ~35% of
 *    real `crypto.randomUUID()` values (Gate-5 review, line-scan finding 2), and a
 *    mangled id is a silently broken reply. The ≤128-char id fields remain a disclosed
 *    residual channel.
 *
 * A wire that fails `parseAppRequest` is redacted as a RAW string, with an
 * unescape-normalised shadow pass: if unescaping reveals nothing new to redact, the
 * byte-preserving raw redaction is kept (legitimate `\\uXXXX` data must not be
 * corrupted); if escapes were hiding identities, the unescaped redaction wins — the
 * malformed path must never be the weaker path.
 */

import {
  ERROR_CODES,
  buildAppRequest,
  parseAppRequest,
  type EnvelopeInput,
} from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { readIdentityDirectory } from '../state/sidecarIdentity.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { getUserDb } from '../state/userdb.js';

export const CONTACT_TOKEN = '[contact]';
export const NUMBER_TOKEN = '[number]';

/**
 * The primitives, carried from the reference scrub (examples/whatsapp/app.html AC12
 * lineage — the jid pattern is pinned byte-equal to the app's by test): a jid in any of
 * WhatsApp's address spaces, and a digit run long enough to be dialable however it is
 * spaced, dotted, dashed or bracketed. The attacker is not adversarial, it is
 * FORMATTING. One deliberate widening over the reference: a leading '(' is consumed too,
 * so '(555) 123-4567' redacts whole instead of leaving a stray parenthesis. Stated cost,
 * pinned by test: separated numeric SEQUENCES ('1 2 3 4 5 6 7') collapse to one token —
 * over-redaction is the safe direction.
 */
export const JID_PATTERN_SOURCE = String.raw`\b[\w.-]+@(?:s\.whatsapp\.net|g\.us|c\.us|lid|broadcast)\b`;
const JID_PATTERN = new RegExp(JID_PATTERN_SOURCE, 'gi');
const PHONE_PATTERN = /(?:\+|\()?\d[\d\s(). -]{6,}\d/g;

/** The pseudonym vocabulary the shipped app emits — never rewritten (AC6). */
const LABEL_SHAPE = /^(?:P\d+|YOU)$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One compiled longest-first alternation over the directory — one pass over the text
 * instead of one pass per identity. Word boundaries wrap each alternative whose edges
 * are word characters, so "News" in the directory cannot gut "Newsworthy".
 */
export function compileDirectoryMatcher(
  identities: readonly string[],
  caseSensitive = false,
): RegExp | undefined {
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
  return new RegExp(alternatives.join('|'), caseSensitive ? 'g' : 'gi');
}

/**
 * Matcher memo, keyed on the directory ARRAY IDENTITY — `readIdentityDirectory` returns
 * a stable reference while nothing changed, so the hot path (every send, every sidecar
 * tool result) compiles once per directory revision instead of once per call (Gate-5
 * review, efficiency finding 2). `null` stands for "compiled to no matcher".
 */
const matcherMemo = new WeakMap<readonly string[], RegExp | null>();
const matcherMemoCS = new WeakMap<readonly string[], RegExp | null>();

function directoryMatcher(identities: readonly string[], caseSensitive: boolean): RegExp | undefined {
  const memo = caseSensitive ? matcherMemoCS : matcherMemo;
  const hit = memo.get(identities);
  if (hit !== undefined) return hit ?? undefined;
  const compiled = compileDirectoryMatcher(identities, caseSensitive);
  memo.set(identities, compiled ?? null);
  return compiled;
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
  return redactWithMatcher(text, directoryMatcher(identities, false));
}

/**
 * Every string VALUE — and, when `redactKeys`, every object KEY — recursively. Numbers
 * pass (disclosed residual). Unchanged subtrees are returned by REFERENCE, so the common
 * no-hit wire costs no allocation beyond the walk itself.
 */
function deepRedact(value: unknown, redact: (text: string) => string, redactKeys: boolean): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const next = deepRedact(entry, redact, redactKeys);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const nextKey = redactKeys ? redact(key) : key;
      const next = deepRedact(entry, redact, redactKeys);
      if (nextKey !== key || next !== entry) changed = true;
      out[nextKey] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/** `\uXXXX` → the character it spells, so the raw fallback cannot be dodged by escaping. */
function unescapeUnicode(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Scrub one LLM-bound wire. Parsed path for a valid envelope; raw-string path with the
 * unescape shadow pass for anything else. A cooperating app's canonical `JSON.stringify`
 * wire with no raw identities round-trips byte-identical, ids always do.
 */
export function scrubAppWire(wire: string, identities: readonly string[]): string {
  const matcher = directoryMatcher(identities, false);
  const redact = (text: string): string => redactWithMatcher(text, matcher);
  const parsed = parseAppRequest(wire);
  if (parsed.ok) {
    const { snug: _snug, appId, instanceId, requestId, action, responseSchema, ...rest } = parsed.envelope;
    const scrubbedRest = deepRedact(rest, redact, true) as Omit<
      EnvelopeInput,
      'appId' | 'instanceId' | 'requestId' | 'action' | 'responseSchema'
    >;
    // The schema subtree plays by its own rules — see the module doc.
    const schema =
      responseSchema === undefined
        ? undefined
        : deepRedact(
            responseSchema,
            (text) => redactWithMatcher(text, directoryMatcher(identities, true)),
            false,
          );
    return buildAppRequest({
      appId,
      instanceId,
      requestId,
      action: redact(action),
      ...scrubbedRest,
      ...(schema !== undefined ? { responseSchema: schema } : {}),
    });
  }
  // RAW FALLBACK. Commutation test: if redacting and unescaping commute, the escapes hid
  // nothing redactable — keep the byte-preserving raw redaction (an app's legitimate
  // `"\\u0022"` data must not come back corrupted). Only when unescaping reveals hidden
  // identities does the unescaped redaction win.
  const rawRedacted = redactWithMatcher(wire, matcher);
  const unescaped = unescapeUnicode(wire);
  if (unescaped === wire) return rawRedacted;
  const unescapedRedacted = redactWithMatcher(unescaped, matcher);
  return unescapedRedacted === unescapeUnicode(rawRedacted) ? rawRedacted : unescapedRedacted;
}

export type WireGuardResult =
  | { ok: true; wire: string }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * The per-send guard both leaf transports call (AC8b: predicate and directory are read
 * HERE, at send time — a connection approved while RunView is mounted must bind the very
 * next send; the stale-capture defect class transport.ts documents twice).
 *
 * The app's identity comes from the transport when it has one, else from the envelope
 * the runner host stamped (the uninstalled-starter mode constructs transports without an
 * appId — Gate-5 review, line-scan finding 6). A wire with NO resolvable identity is
 * scrubbed unconditionally: over-redaction is the safe direction on bytes nothing can
 * vouch for.
 *
 * FAIL CLOSED (AC8c): if the user DB cannot be read, the send is refused by name — a
 * backstop that silently degrades to raw-to-provider on a read hiccup is not a boundary.
 * Apps without a sidecar connection fact pass through byte-identical.
 */
export async function guardWireForApp(
  appId: string | undefined,
  wire: string,
  getDb: () => Promise<UserDb> = getUserDb,
): Promise<WireGuardResult> {
  try {
    const db = await getDb();
    let effective = appId;
    if (effective === undefined) {
      const parsed = parseAppRequest(wire);
      if (parsed.ok) effective = parsed.envelope.appId;
    }
    if (effective !== undefined && !appHasSidecarFact(db, effective)) return { ok: true, wire };
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
