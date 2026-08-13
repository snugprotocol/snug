/**
 * Header-template LINT — the static half of the Dynamic Auth v2 template contract
 * (TASK-20260810-p0-contracts, AC6/AC7/AC8; parent plan fold S-M2).
 *
 * WHY THIS EXISTS. `connectionRequestSchema` (packages/protocol) bounds the header
 * template's ENVELOPE — entry count, header-name charset, value length — but it cannot
 * bound the template's CONTENT: whether `{{hmac_sha256(api_secret, request.body)}}`
 * names a real declared field is a question about the sibling `fields` list, which Zod
 * has no view of from inside a record value. That check is this module.
 *
 * THE HOLE IT CLOSES, precisely. `template-engine.ts`'s `resolveArgToken` returns the
 * TOKEN ITSELF when it matches neither `request.*` nor a declared field — the literal
 * fallback that exists so `{{base64('foo')}}` and numeric args work. In ARGUMENT
 * position that fallback is silent and wrong: `{{hmac_sha256(api_secrt, request.body)}}`
 * (one transposed character) signs the eight-byte string "api_secrt" instead of the
 * credential and produces a plausible-looking 64-hex signature that the provider
 * rejects. The engine throws loudly for BARE placeholders (`resolveExpression`) but
 * never for arguments, so "the engine already catches typos" is false. The lint makes
 * that fallback UNREACHABLE from an accepted template — a strictly stronger claim than
 * "the engine throws", because it is checked before a credential is ever read.
 *
 * IT IS ALSO THE ENUM'S ONLY ENFORCER. `AUTH_TEMPLATE_HELPERS` below is the single
 * source of truth the engine's HELPERS map is asserted against (AC7), so the pinned
 * enum is a checked invariant rather than a comment. The lint rejects out-of-enum names
 * INDEPENDENTLY of the map: defense in depth, so a helper re-added to the engine in a
 * later change does not silently become reachable from templates linted under the old
 * enum.
 *
 * PURE AND SYNCHRONOUS by design. It reads no credential values — only field KEYS — so
 * it can run at review time, at approval time and at render time with identical results
 * and no C1 exposure. Nothing here touches `ctx.fields`' values.
 */

/**
 * The pinned helper enum — FIVE names (four per parent plan §Pinned decisions, fold
 * F-m3; `cdp_jwt` added by TASK-20260812-desktop-auth-awareness P3, ADR-0022 §2).
 *
 * `hmac_sha256_b64` is the added encoding-capable variant. It exists because
 * Coinbase-Exchange's `base64(HMAC-SHA256(base64decode(secret), prehash))` was
 * inexpressible in three independent ways at once: `hmacHex` returns hex
 * unconditionally, `base64Utf8` is utf8-in so it cannot re-encode raw digest bytes, and
 * the grammar has no nesting (`parseHelperArgs` splits flat tokens — there is no
 * recursive descent), so `{{base64(hmac_sha256(...))}}` cannot parse. The three
 * transforms are FUSED into one fixed-arity helper rather than exposed as a general
 * `base64decode()` primitive a template could aim at arbitrary text.
 *
 * `cdp_jwt` is the second signing-capable family: a host-side, provider-scheme-named
 * signing function minting a per-request ES256 CDP JWT (Coinbase CDP keys). Like
 * `hmac_sha256_b64` it is a FUSED fixed shape, not a general JWT primitive — the claim
 * set, algorithm, and expiry are pinned in the engine, so a template can aim it only at
 * "sign this request as CDP", never at arbitrary token minting. Its arguments carry a
 * STRICTER form rule than the generic one: see `lintExpression`.
 *
 * `unix_ms`, `hmac_sha512` and `sha256` are deliberately ABSENT: they shipped in the
 * engine's map with no requirement behind them, and every unused helper is signing
 * surface a hostile template can reach.
 */
export const AUTH_TEMPLATE_HELPERS = ['timestamp', 'hmac_sha256', 'hmac_sha256_b64', 'base64', 'cdp_jwt'] as const;

export type AuthTemplateHelper = (typeof AUTH_TEMPLATE_HELPERS)[number];

/**
 * The pinned request tokens. This set IS `readRequestField`'s switch, not an inference
 * from it — the engine throws on anything else, and the lint's job is to agree with that
 * switch STATICALLY so the failure lands at review time instead of at signing time.
 *
 * Note `request.pathAndQuery` can legitimately render EMPTY (`deriveDefaultPath` returns
 * '' for an unparseable URL). That is a render-time value question, not a lint question:
 * an empty render is a valid outcome for an accepted token.
 *
 * `request.timestamp` is the odd one and is here on purpose. It is a RENDER fact — minted
 * by the render pass from the memoized `RenderState`, not read off the request — and it
 * exists because the Coinbase-Exchange prehash needs the timestamp in ARGUMENT position:
 * `{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery,
 * request.body)}}`. A helper CALL is not an accepted argument form in this grammar, so
 * `timestamp()` could not go there and the Exchange template ADR-0017 §Consequences calls
 * buildable was in fact INEXPRESSIBLE (verified by execution: both the four-part and the
 * two-part shapes linted `ok: false`).
 *
 * A pinned token was chosen over allowing nested zero-arg helper calls because it keeps
 * the grammar FLAT. Nesting would make argument resolution recursive and asynchronous, and
 * every bound on it ("zero-arg only", "one level") would be a rule enforced by code rather
 * than by the shape of the language. A token is enforced by the token list itself.
 */
export const AUTH_TEMPLATE_REQUEST_TOKENS = [
  'request.method',
  'request.url',
  'request.pathAndQuery',
  'request.body',
  'request.timestamp',
] as const;

export type AuthTemplateRequestToken = (typeof AUTH_TEMPLATE_REQUEST_TOKENS)[number];

/** Min/max arity per helper. `hmac_sha256_b64` takes a VARIADIC message tail — see below. */
const HELPER_ARITY: Record<AuthTemplateHelper, { min: number; max: number }> = {
  timestamp: { min: 0, max: 0 },
  base64: { min: 1, max: 1 },
  hmac_sha256: { min: 2, max: 2 },
  /**
   * (secret, ...messageParts) — the tail is concatenated in order. Coinbase-Exchange's
   * real prehash is a FOUR-part concat (timestamp + method + path + body) and
   * `parseHelperArgs` splits on commas, so a multi-part prehash cannot arrive as one
   * argument. Accepting the tail is strictly more honest than forcing authors to sign
   * only what fits one token, and it adds no new primitive: it is string concatenation
   * of tokens the lint has already individually approved.
   */
  hmac_sha256_b64: { min: 2, max: 6 },
  /** (api_key_field, private_key_field) — exactly two, both DECLARED field keys (see below). */
  cdp_jwt: { min: 2, max: 2 },
};

/** Mirrors the engine's `PLACEHOLDER_RE`/`HELPER_RE` exactly — divergence here is a hole. */
const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const HELPER_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/;

export interface AuthTemplateLintOptions {
  /** Declared credential field keys — KEYS ONLY; the lint never sees a value. */
  fieldKeys: readonly string[];
}

export interface AuthTemplateLintIssue {
  /** Header name the offending value sits under. */
  header: string;
  /** The raw `{{...}}` inner expression that failed. */
  expression: string;
  /** Human-readable reason, naming the offending token so a review can quote it. */
  message: string;
}

export type AuthTemplateLintResult =
  | { ok: true; issues: readonly [] }
  | { ok: false; issues: readonly AuthTemplateLintIssue[] };

const isPinnedHelper = (name: string): name is AuthTemplateHelper =>
  (AUTH_TEMPLATE_HELPERS as readonly string[]).includes(name);

const isPinnedRequestToken = (token: string): token is AuthTemplateRequestToken =>
  (AUTH_TEMPLATE_REQUEST_TOKENS as readonly string[]).includes(token);

/**
 * Split a helper's argument list the way the ENGINE does, but reporting whether each
 * argument was QUOTED. The engine's `parseHelperArgs` strips quotes and then loses that
 * distinction, which is exactly why it cannot tell a literal from a typo'd field key —
 * the lint has to keep the fact that the author wrote quotes.
 *
 * Kept byte-for-byte parallel to the engine's scanner (same escape handling, same
 * quote-toggle rules, same comma-splitting) so a template cannot lint one way and render
 * another. Any change to one MUST be mirrored in the other.
 */
interface ParsedArg {
  text: string;
  quoted: boolean;
}

function splitHelperArgs(argList: string): ParsedArg[] {
  const trimmed = argList.trim();
  if (trimmed.length === 0) return [];

  const args: ParsedArg[] = [];
  let current = '';
  let quoted = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  const push = (): void => {
    args.push({ text: current.trim(), quoted });
    current = '';
    quoted = false;
  };

  for (const ch of trimmed) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      quoted = true;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      quoted = true;
      continue;
    }
    if (ch === ',' && !inSingleQuote && !inDoubleQuote) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return args;
}

/**
 * Lint one `{{...}}` expression. Returns a reason string, or `null` when it is accepted.
 *
 * The two accepted shapes mirror `resolveExpression`: a helper call, or a bare token.
 * Everything else — including a bare token that merely LOOKS like a request field
 * (`request.headers`) — is rejected, because the engine would either throw at signing
 * time (bare position) or silently substitute the literal (argument position). Both
 * outcomes are worse than a review-time rejection.
 */
function lintExpression(expression: string, fieldKeys: ReadonlySet<string>): string | null {
  const helperMatch = HELPER_RE.exec(expression);

  if (helperMatch !== null) {
    const name = helperMatch[1]!;
    if (!isPinnedHelper(name)) {
      return `unknown template helper '${name}' — allowed helpers are ${AUTH_TEMPLATE_HELPERS.join(', ')}`;
    }
    const args = splitHelperArgs(helperMatch[2]!);
    const arity = HELPER_ARITY[name];
    if (args.length < arity.min || args.length > arity.max) {
      const expected = arity.min === arity.max ? `${arity.min}` : `${arity.min}-${arity.max}`;
      return `helper '${name}' takes ${expected} argument(s) but got ${args.length}`;
    }
    if (name === 'cdp_jwt') {
      // PER-ARGUMENT-FORM RULE, stricter than the generic loop below (P0 amendment 7 /
      // ADR-0022 §2): both arguments are CREDENTIAL IDENTITIES — the key name that rides
      // kid/sub and the signing PEM — so the literal and request-token forms the other
      // helpers accept are never right here. A quoted key name would mint a structurally
      // valid JWT for a key the user never declared; a request token in the PEM seat
      // would "sign" with request text. Both are valid-looking-but-wrong outcomes, and
      // the engine cannot re-check this (it receives resolved VALUES), so the render
      // gate's lint is the enforcement seat.
      for (const arg of args) {
        if (arg.quoted || !fieldKeys.has(arg.text)) {
          return `helper 'cdp_jwt' argument '${arg.text}' must be a declared field key — cdp_jwt takes (api_key_field, private_key_field), never quoted literals or request tokens`;
        }
      }
      return null;
    }
    for (const arg of args) {
      // A QUOTED argument is a literal by authorial intent, so the lint permits it
      // unexamined — and the ENGINE now honors that same reading, returning quoted
      // arguments verbatim without consulting `ctx.fields`.
      //
      // That second half used to be false and it was a live credential leak (review
      // blocker B1): the engine stripped the quotes, lost the quoted-ness, and resolved
      // `{{base64('api_key')}}` to the CREDENTIAL — a template this lint had accepted
      // precisely BECAUSE it looked like an inert literal. Skipping a quoted argument is
      // only sound while the engine agrees it is inert; `template-parity.test.ts` is what
      // keeps that agreement from silently rotting.
      if (arg.quoted) continue;
      if (fieldKeys.has(arg.text)) continue;
      if (isPinnedRequestToken(arg.text)) continue;
      if (arg.text.startsWith('request.')) {
        return `helper '${name}' argument '${arg.text}' is not a pinned request token — allowed: ${AUTH_TEMPLATE_REQUEST_TOKENS.join(', ')}`;
      }
      return `helper '${name}' argument '${arg.text}' is not a declared field key, a pinned request token, or a quoted literal`;
    }
    return null;
  }

  if (fieldKeys.has(expression)) return null;
  if (isPinnedRequestToken(expression)) return null;
  if (expression.startsWith('request.')) {
    return `'${expression}' is not a pinned request token — allowed: ${AUTH_TEMPLATE_REQUEST_TOKENS.join(', ')}`;
  }
  return `'${expression}' is not a declared field key or a pinned request token`;
}

/**
 * Lint a whole header template against the requirement's declared field keys.
 *
 * Collects EVERY issue rather than short-circuiting: the strong review renders the
 * template verbatim, and an author fixing one rejection at a time through a
 * re-inference loop is a worse experience than seeing all of them at once.
 */
export function lintAuthHeaderTemplate(
  headerTemplate: Record<string, string>,
  options: AuthTemplateLintOptions,
): AuthTemplateLintResult {
  const fieldKeys = new Set(options.fieldKeys);
  const issues: AuthTemplateLintIssue[] = [];

  for (const [header, value] of Object.entries(headerTemplate)) {
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      const expression = String(match[1]).trim();
      const message = lintExpression(expression, fieldKeys);
      if (message !== null) issues.push({ header, expression, message });
    }
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

/** Thrown by the render seat when a template reaches it unlinted (AC8). */
export class AuthTemplateLintError extends Error {
  readonly issues: readonly AuthTemplateLintIssue[];

  constructor(issues: readonly AuthTemplateLintIssue[]) {
    super(`header template failed the auth template lint: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'AuthTemplateLintError';
    this.issues = issues;
  }
}

/**
 * Enforce the lint or throw. This is the seat `renderAuthHeaderTemplate` calls, so the
 * render path ENFORCES rather than TRUSTS: a caller that forgets to lint gets a
 * rejection, not a silently-wrong signature. The cost is one pure re-parse per render,
 * which is trivial next to the WebCrypto work that follows it.
 */
export function assertLintedTemplate(headerTemplate: Record<string, string>, options: AuthTemplateLintOptions): void {
  const result = lintAuthHeaderTemplate(headerTemplate, options);
  if (!result.ok) throw new AuthTemplateLintError(result.issues);
}
