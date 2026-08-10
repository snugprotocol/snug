/**
 * Header-template engine for `request.headerTemplate` strings — ported from OProject
 * (AL-02 plan D7) and rewritten ASYNC-FIRST on WebCrypto (plan D6): every helper and
 * both render functions return Promises, and the PUBLIC signature is async from day
 * one so AL-03 consumes it async with no sync→async break later. No node crypto or
 * byte-buffer APIs (AC5 lint test).
 *
 * Supports two forms:
 *   1. Plain field substitution: `{{api_key}}` → `ctx.fields.api_key`
 *   2. Helper invocations:       `{{timestamp()}}`, `{{base64('foo')}}`,
 *                                `{{hmac_sha256(api_secret, request.body)}}`
 *
 * Intentionally tiny — Mustache without partials/sections, no arbitrary code paths,
 * no eval. Unknown placeholders throw `AuthTemplateError`: better to fail loudly
 * during signing than to send malformed auth headers.
 */

import { base64ToBytes, bytesToBase64, bytesToHex, utf8ToBase64 } from './base64url.js';
import { assertLintedTemplate } from './template-lint.js';

export class AuthTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthTemplateError';
  }
}

/** Subset of the request that helper functions may inspect. */
export interface AuthTemplateRequest {
  method: string;
  url: string;
  /** Path + query portion ("/v2/orders?limit=10") — what most exchange APIs sign. */
  pathAndQuery?: string;
  body?: string;
}

export interface AuthTemplateContext {
  /** Credential field values, keyed by AuthField.key — read from the CredentialStore per use. */
  fields: Record<string, string>;
  /** Optional request shape for helpers like hmac_sha256(secret, body). */
  request?: AuthTemplateRequest;
}

const encoder = new TextEncoder();

async function hmacBytes(secret: Uint8Array, message: string): Promise<Uint8Array> {
  // `secret as BufferSource` — WebCrypto's importKey takes a BufferSource; the cast is
  // only needed because TS models Uint8Array's generic ArrayBufferLike backing store.
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/**
 * Per-render state. Currently one entry, and it is a correctness fix rather than a cache:
 *
 * TIMESTAMP MEMOIZATION. Every signing scheme that sends a timestamp header ALSO signs
 * that timestamp, so a template reads the timestamp twice — once for
 * `CB-ACCESS-TIMESTAMP`, once inside `{{hmac_sha256_b64(api_secret, request.timestamp, ...)}}`.
 * Evaluating `Date.now()` independently at each site straddles a second boundary
 * whenever the two calls land either side of one, so the header and the signed prehash
 * disagree and the provider rejects the request. That presents as an INTERMITTENT ~1-in-N
 * auth failure — the worst possible shape to debug — so the timestamp is evaluated once
 * per render pass and reused across every placeholder in the whole header object.
 *
 * Until B2 this memoization protected NOTHING REACHABLE. The only way to read a timestamp
 * was `{{timestamp()}}`, which is a helper CALL — and a helper call was never an accepted
 * ARGUMENT form in either the lint or the engine, so the signed-and-sent pair the
 * memoization exists for could not be written down. `request.timestamp` (a pinned token,
 * legal in argument position by the grammar that already existed) is what makes it
 * reachable. Both forms read this one slot, so they cannot disagree.
 */
interface RenderState {
  timestamp?: string;
}

/**
 * The one seat that mints the render pass's timestamp. Both `{{timestamp()}}` and
 * `{{request.timestamp}}` route through it, which is what makes "the signed timestamp
 * byte-equals the sent timestamp" true by CONSTRUCTION rather than by two call sites
 * agreeing to read the same field.
 */
const renderTimestamp = (state: RenderState): string =>
  (state.timestamp ??= Math.floor(Date.now() / 1000).toString());

type HelperFn = (args: string[], ctx: AuthTemplateContext, state: RenderState) => Promise<string> | string;

/**
 * The pinned helper enum, FOUR entries — asserted key-for-key against
 * `AUTH_TEMPLATE_HELPERS` (template-lint.ts) by AC7, so the enum is an enforced
 * invariant and not a comment. `unix_ms`, `hmac_sha512` and `sha256` were trimmed here:
 * they shipped with no requirement behind them, and an unused helper is reachable
 * signing surface.
 */
const HELPERS: Record<string, HelperFn> = {
  timestamp: (_args, _ctx, state) => renderTimestamp(state),
  base64: (args) => utf8ToBase64(args[0] ?? ''),
  hmac_sha256: async (args) => {
    const [secret, message] = args;
    if (secret === undefined || message === undefined) {
      throw new AuthTemplateError('hmac_sha256 requires (secret, message)');
    }
    return bytesToHex(await hmacBytes(encoder.encode(secret), message));
  },
  /**
   * `hmac_sha256_b64(secret, ...messageParts)` — base64(HMAC-SHA256(base64decode(secret),
   * concat(messageParts))). All three transforms FUSED into one fixed-shape helper.
   *
   * This is the Coinbase-Exchange signature, which was inexpressible before: `hmac_sha256`
   * returns hex unconditionally, `base64` is utf8-in so it cannot re-encode raw digest
   * bytes, and the grammar has no nesting, so `{{base64(hmac_sha256(...))}}` cannot even
   * parse. Fusing is the security choice: a general `base64decode()` primitive could be
   * aimed at arbitrary text, whereas this one only ever decodes the key argument and only
   * ever feeds the result straight into HMAC.
   *
   * The VARIADIC tail is what makes the real prehash expressible — Exchange signs
   * `timestamp + method + path + body`, and `parseHelperArgs` splits on commas, so a
   * four-part prehash cannot arrive as a single argument. Concatenation adds no new
   * primitive: every part is a token the lint already approved individually.
   */
  hmac_sha256_b64: async (args) => {
    const [secret, ...messageParts] = args;
    if (secret === undefined || messageParts.length === 0) {
      throw new AuthTemplateError('hmac_sha256_b64 requires (secret, message)');
    }
    let key: Uint8Array;
    try {
      key = base64ToBytes(secret);
    } catch {
      // Never fall back to signing with the raw string. A silent fallback would make the
      // helper's behavior depend on user-pasted credential content and would emit a
      // valid-looking-but-wrong signature instead of a diagnosable failure. The message
      // deliberately names no value (C5).
      throw new AuthTemplateError('hmac_sha256_b64 secret must be standard base64');
    }
    return bytesToBase64(await hmacBytes(key, messageParts.join('')));
  },
};

/**
 * The engine's ACTUAL helper names, exported so AC7 can assert the real map against the
 * lint's `AUTH_TEMPLATE_HELPERS` enum.
 *
 * Before this export AC7 was a TAUTOLOGY: the test compared a locally-declared
 * `PINNED_HELPERS` array to `AUTH_TEMPLATE_HELPERS`, and both are lint/test-side constants
 * — the engine's `HELPERS` map was never read, so a helper added to the engine without an
 * enum amendment passed. The enum could only ever equal itself. `HELPERS` stays private
 * (the functions are not public surface); only the NAME SET is exposed, which is exactly
 * what the invariant is about.
 */
export const AUTH_ENGINE_HELPER_NAMES: readonly string[] = Object.freeze(Object.keys(HELPERS));

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const HELPER_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/;

/**
 * Render a single template string. Unknown placeholders reject.
 *
 * NOT the lint seat. This function is the primitive `renderAuthHeaderTemplate` is built
 * from, and it is also what the lint's own tests call to prove the engine's literal
 * fallback is live. The gate therefore sits on the header-object seat — the one every
 * production caller actually uses (`connected-fetch.ts`) — where the declared field keys
 * are knowable from the context.
 */
export async function renderAuthTemplateString(
  template: string,
  ctx: AuthTemplateContext,
  state: RenderState = {},
): Promise<string> {
  let result = '';
  let lastIndex = 0;
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    result += template.slice(lastIndex, match.index);
    result += await resolveExpression(String(match[1]).trim(), ctx, state);
    lastIndex = match.index + match[0].length;
  }
  return result + template.slice(lastIndex);
}

/**
 * Render every value in a header template object. Header keys are kept verbatim
 * (no templating) — only values support `{{...}}`.
 *
 * THE LINT GATE (AC8). Every template is linted here, immediately before any credential
 * is touched, against the field keys present in `ctx.fields`. The render seat ENFORCES
 * rather than trusts: a caller that forgets to lint at authoring time still cannot emit
 * a signature computed over a typo'd literal, and no future call site can be added that
 * bypasses the check. `ctx.fields` is the right key source precisely because it is what
 * the engine would substitute FROM — linting against anything else would leave a gap
 * between what was checked and what gets resolved.
 *
 * One `RenderState` is shared across every header value so `{{timestamp()}}` in the
 * timestamp header and `{{timestamp()}}` inside the signature agree — see `RenderState`.
 */
export async function renderAuthHeaderTemplate(
  headerTemplate: Record<string, string>,
  ctx: AuthTemplateContext,
): Promise<Record<string, string>> {
  assertLintedTemplate(headerTemplate, { fieldKeys: Object.keys(ctx.fields) });
  const state: RenderState = {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerTemplate)) {
    out[key] = await renderAuthTemplateString(value, ctx, state);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function resolveExpression(expr: string, ctx: AuthTemplateContext, state: RenderState): Promise<string> {
  const helperMatch = HELPER_RE.exec(expr);
  if (helperMatch) {
    const name = helperMatch[1]!;
    // `hasOwnProperty` rather than a bare index read: `HELPERS` is a plain object literal,
    // so `HELPERS['constructor']` would otherwise resolve to Object.prototype.constructor
    // and be called as a helper. The lint rejects those names too — this is the engine's
    // own half of the same guard, since the engine must stand alone (AC8).
    const helper = Object.prototype.hasOwnProperty.call(HELPERS, name) ? HELPERS[name] : undefined;
    if (helper === undefined) {
      throw new AuthTemplateError(`Unknown template helper: ${name}`);
    }
    const args = parseHelperArgs(helperMatch[2]!, ctx, state);
    return helper(args, ctx, state);
  }

  if (expr.startsWith('request.')) {
    return readRequestField(expr.slice('request.'.length), ctx, state);
  }
  if (Object.prototype.hasOwnProperty.call(ctx.fields, expr)) {
    return ctx.fields[expr]!;
  }
  throw new AuthTemplateError(`Unknown template field: ${expr}`);
}

/**
 * Split a helper's argument list and resolve each argument.
 *
 * QUOTED-NESS IS CARRIED, not discarded (B2 review blocker B1). This scanner used to strip
 * quotes and then hand the bare text to `resolveArgToken`, which looked it up in
 * `ctx.fields` — so `{{base64('api_key')}}` resolved the CREDENTIAL while the lint, which
 * skips quoted arguments as literals-by-authorial-intent, had waved the template through
 * unexamined. Proven by execution: that template linted `ok` and rendered
 * base64('SUPERSECRET'). A reviewer reading quotes concludes no credential is referenced,
 * which made an approved template into a C1 exfiltration path.
 *
 * The fix lands HERE rather than in the lint deliberately. Widening the lint to also
 * type-check quoted arguments would leave the engine still able to resolve a quoted token
 * to a credential — it would only narrow which templates reach that behavior. Making the
 * ENGINE honor quoting removes the capability, so the lint's parity comment
 * (`template-lint.ts` `splitHelperArgs`) is true of the shipped code instead of aspirational.
 *
 * Kept byte-for-byte parallel to the lint's `splitHelperArgs` — same escape handling, same
 * quote toggles, same comma splitting, and now the same notion of quoted-ness. Any change
 * to one MUST be mirrored in the other; `template-parity.test.ts` is what fails if they drift.
 */
function parseHelperArgs(argList: string, ctx: AuthTemplateContext, state: RenderState): string[] {
  const trimmed = argList.trim();
  if (trimmed.length === 0) return [];

  const args: string[] = [];
  let current = '';
  let quoted = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  const push = (): void => {
    args.push(resolveArgToken(current.trim(), quoted, ctx, state));
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

function resolveArgToken(token: string, quoted: boolean, ctx: AuthTemplateContext, state: RenderState): string {
  // A QUOTED argument is a literal by authorial intent, and it is returned VERBATIM without
  // consulting `ctx.fields` or the request tokens. This is the branch that closes B1: it
  // must come before every lookup, because the whole defect was a quoted token reaching one.
  if (quoted) return token;
  if (token.length === 0) return '';
  if (token.startsWith('request.')) {
    return readRequestField(token.slice('request.'.length), ctx, state);
  }
  if (Object.prototype.hasOwnProperty.call(ctx.fields, token)) {
    return ctx.fields[token]!;
  }
  // Anything else is a literal — covers numeric values and unrecognized bare tokens. The
  // lint makes this branch unreachable from an accepted template (see template-lint.ts);
  // it survives so the engine stays total, and NOT as a supported authoring shape.
  return token;
}

function readRequestField(path: string, ctx: AuthTemplateContext, state: RenderState): string {
  // `request.timestamp` is a RENDER fact, not a request fact: it is minted by this pass
  // rather than read off `ctx.request`, so it resolves before the no-request check and is
  // available even when no request context was supplied. It is served from the SAME
  // memoized slot as `{{timestamp()}}`, which is the whole point — the timestamp a
  // signature is computed over and the timestamp sent in the header are one value by
  // construction, not two reads that usually agree. See `RenderState`.
  if (path === 'timestamp') return renderTimestamp(state);

  const req = ctx.request;
  if (req === undefined) {
    throw new AuthTemplateError(`Template referenced request.${path} but no request context was provided`);
  }
  switch (path) {
    case 'method':
      return req.method;
    case 'url':
      return req.url;
    case 'pathAndQuery':
      return req.pathAndQuery ?? deriveDefaultPath(req.url);
    case 'body':
      return req.body ?? '';
    default:
      throw new AuthTemplateError(`Unknown request field: ${path}`);
  }
}

function deriveDefaultPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '';
  }
}
