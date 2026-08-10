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
 * The pinned helper enum — FOUR names (parent plan §Pinned decisions, fold F-m3).
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
 * `unix_ms`, `hmac_sha512` and `sha256` are deliberately ABSENT: they shipped in the
 * engine's map with no requirement behind them, and every unused helper is signing
 * surface a hostile template can reach. Net helper count drops six -> four.
 */
export const AUTH_TEMPLATE_HELPERS = ['timestamp', 'hmac_sha256', 'hmac_sha256_b64', 'base64'] as const;

export type AuthTemplateHelper = (typeof AUTH_TEMPLATE_HELPERS)[number];

/**
 * The pinned request tokens. This set IS `readRequestField`'s switch, not an inference
 * from it — the engine throws on anything else, and the lint's job is to agree with that
 * switch STATICALLY so the failure lands at review time instead of at signing time.
 *
 * Note `request.pathAndQuery` can legitimately render EMPTY (`deriveDefaultPath` returns
 * '' for an unparseable URL). That is a render-time value question, not a lint question:
 * an empty render is a valid outcome for an accepted token.
 */
export const AUTH_TEMPLATE_REQUEST_TOKENS = [
  'request.method',
  'request.url',
  'request.pathAndQuery',
  'request.body',
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
    for (const arg of args) {
      // A QUOTED argument is a literal by authorial intent — that is the one place the
      // engine's fallback is correct, so the lint permits it. An UNQUOTED argument must
      // name something real; otherwise it lands on the silent fallback.
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
