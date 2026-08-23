// Credential-SHAPE redaction, single-homed (TASK-20260822-feedback-loop Gate-5
// review). Two surfaces need "mask anything key-shaped in prose" — the LLM
// round-trip inspector (run/llmInspector.ts, display) and the feedback deep links
// (feedback/githubReport.ts, egress to a GitHub URL) — and they had begun to grow
// divergent lists (the review measured real drift: ASIA AWS keys passed one list,
// github_pat_ passed the other). This module is the ONE list; a third consumer
// (agent/connectionInferrerAdapter.ts keeps its own tripwire list today) is queued
// to migrate in next-steps.
//
// Shapes, not knowledge: nothing here reads the credential store — that would be
// a new reader of `snug_secrets` for a non-custody purpose. A secret matching no
// shape below survives, which is why every consumer keeps its own honest second
// wall (the inspector renders to the OWNER's own screen; the feedback path shows
// a preview-confirm before anything leaves).
//
// Deliberately broad on real key shapes — matching too much costs a few masked
// characters, matching too little leaks a key — but scheme words are digit-guarded:
// "Basic authentication failed" is ERROR PROSE, and redacting it to "Basic
// «redacted» failed" destroys the diagnostic the text exists to carry (Gate-5
// finding, executed against the previous regex). Real scheme-carried tokens
// virtually always contain a digit.

interface CredentialShape {
  pattern: RegExp;
  /**
   * PROSE MODE ONLY: the redaction target (the match minus a leading capture
   * group, if any) must contain a digit — otherwise the match is left untouched.
   * Guards word-shaped false positives ("authentication", "mismatch") on patterns
   * whose alphabet overlaps ordinary prose. Display mode ignores the guard —
   * over-masking costs a few characters on the owner's own screen.
   */
  digitGuardInProse?: boolean;
  /**
   * Run only in prose mode. The long-run shape is here for two reasons: display
   * consumers feed multi-megabyte payloads where a bounded-repetition match over
   * an unbroken run can overflow the regex engine's stack (measured — the
   * inspector's 8 MiB fixtures), and prose inputs are short error strings.
   */
  proseOnly?: boolean;
}

const CREDENTIAL_SHAPES: CredentialShape[] = [
  // Anthropic / OpenAI style keys, including the sk-ant-/sk-proj- prefixed variants.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g },
  // Scheme-carried credentials ("Authorization: Bearer <tok>", bare "Basic <tok>").
  // The scheme word is kept (leading group), the value is redacted, and the
  // digit-guard keeps prose like "Basic authentication failed" intact.
  { pattern: /(\b(?:Bearer|Basic|Token|Digest|Negotiate)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, digitGuardInProse: true },
  // Google/GCP.
  { pattern: /\bAIza[A-Za-z0-9_-]{10,}/g },
  // GitHub PATs — classic and fine-grained.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/g },
  // AWS access key ids, permanent AND temporary-session.
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g },
  // Slack.
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // `api-key: <value>` / `x-api-key=<value>` / `"apiKey": "<value>"` style pairs — mask
  // the VALUE, keep the key name so the shape of the request stays readable.
  {
    pattern:
      /((?:api[_-]?key|apikey|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{8,}=*)/gi,
  },
  // Credential-shaped query params — the value only; the rest of the URL survives.
  {
    pattern:
      /([?&](?:key|apikey|api_key|appid|token|access_token|refresh_token|client_secret|secret|sig|signature|x-amz-signature)=)[^&\s"']+/gi,
  },
  // Long unbroken token-like runs (raw echoed secrets): 40+ base64-ish chars with a
  // digit. Plain words never reach this shape; redacting the occasional long hash is
  // an accepted false positive. The digit check rides the guard flag (not a regex
  // lookahead) so pathological inputs stay linear-time.
  { pattern: /[A-Za-z0-9+/=_-]{40,}/g, digitGuardInProse: true, proseOnly: true },
];

export const REDACTED = '«redacted»';

type RedactMode = 'display' | 'prose';

function redact(value: string, mode: RedactMode): string {
  if (!value) return value;
  let out = value;
  for (const { pattern, digitGuardInProse, proseOnly } of CREDENTIAL_SHAPES) {
    if (proseOnly === true && mode !== 'prose') continue;
    // Keep a leading capture group when the pattern has one (the `key:` half of a
    // name/value pair) so the shape stays readable with only the VALUE masked.
    //
    // The group must be detected by TYPE, not by `=== undefined`: String.replace
    // calls a group-less pattern's callback as (match, offset, string), so a naive
    // `prefix` parameter binds to the offset NUMBER (Gate-5 review, 2026-08-05 —
    // 'key sk-ant-…' rendered as 'key 4«redacted»').
    out = out.replace(pattern, (match, ...args: unknown[]) => {
      const first = args[0];
      const prefix = typeof first === 'string' ? first : '';
      const target = match.slice(prefix.length);
      if (mode === 'prose' && digitGuardInProse === true && !/\d/.test(target)) return match;
      return `${prefix}${REDACTED}`;
    });
  }
  return out;
}

/**
 * DISPLAY masking (the LLM inspector's semantics): deliberately broad — a
 * digit-less "Bearer wordlikevalue" is still masked, because over-masking on the
 * owner's own screen costs a few characters while under-masking renders a key.
 */
export function redactCredentialShapes(value: string): string {
  return redact(value, 'display');
}

/**
 * PROSE scrubbing (the feedback deep links): error text must stay diagnostic —
 * "Basic authentication failed" is information, not a credential — so word-shaped
 * matches are digit-guarded, and the long-run shape (unsafe on multi-megabyte
 * display payloads) is enabled.
 */
export function scrubCredentialProse(value: string): string {
  return redact(value, 'prose');
}
