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

import { base64ToBytes, bytesToBase64, bytesToBase64Url, bytesToHex, utf8ToBase64, utf8ToBase64Url } from './base64url.js';
import { CdpKeyImportError, ED25519_RUNTIME_ERROR, importEd25519PrivateKey } from './ed25519-key.js';
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
  /**
   * Every field key the requirement DECLARES, including declared-but-optional fields the
   * user left blank (which are therefore absent from `fields`).
   *
   * The two lists are not the same, and conflating them was a shipped defect: a template
   * naming a `required: false` field passed the executor's lint (which checks the
   * declaration) and was then rejected by the render seat's lint (which checked only what
   * was loaded), so the connection reported CONNECTED and every request failed closed.
   *
   * Omit it and the declaration is taken to be exactly the loaded keys — correct for
   * callers with no optional fields, and it keeps the engine standalone-safe (AC8).
   */
  declaredFieldKeys?: readonly string[];
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
 * The pinned helper enum, FIVE entries — asserted key-for-key against
 * `AUTH_TEMPLATE_HELPERS` (template-lint.ts) by AC7, so the enum is an enforced
 * invariant and not a comment. `unix_ms`, `hmac_sha512` and `sha256` were trimmed here:
 * they shipped with no requirement behind them, and an unused helper is reachable
 * signing surface. `cdp_jwt` is the fifth name and the second signing-capable family
 * (TASK-20260812-desktop-auth-awareness P3, ADR-0022 §2).
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
  /**
   * `cdp_jwt(api_key_field, private_key_field)` — mint a fresh Coinbase-CDP EdDSA JWT per render
   * (ADR-0030, superseding ADR-0022 §2's ES256-only clause). Both arguments are
   * DECLARED FIELD KEYS by the lint's per-argument rule for this helper (never
   * literals, never request tokens): the first resolves to the CDP key NAME
   * (`organizations/…/apiKeys/…`, non-secret, rides kid/sub) and the second to the
   * Ed25519 secret (any portal shape — secret, never leaves this function).
   *
   * CLAIM SHAPE, pinned by cdp-jwt.test.ts and byte-identical to the ES256 era
   * (verified against Coinbase's own jwt_generator): header { alg:'EdDSA', kid,
   * typ:'JWT', nonce:<16 random bytes hex> }; payload { iss:'cdp', sub:<key name>,
   * uri:'<METHOD> <host><path>' — NO scheme, NO query — nbf:now, exp:now+120 }.
   * The nbf second is read through `renderTimestamp`, so a template that also sends a
   * timestamp header cannot disagree with the JWT about when "now" was (the same
   * memoization the HMAC family relies on).
   *
   * Ed25519 ONLY (owner decision 2026-08-15 — one signing path, no algorithm
   * negotiation): WebCrypto's raw 64-byte Ed25519 output is exactly the JWS EdDSA
   * signature format (RFC 8037 §3.2 — no conversion). Key import lives in
   * ed25519-key.ts (armor-first detection, every shape canonicalized to the seed,
   * honest typed errors, total runtime rule); its CdpKeyImportError is re-thrown as
   * AuthTemplateError so callers see ONE error type from the template surface.
   */
  cdp_jwt: async (args, ctx, state) => {
    const [apiKeyName, privateKeyPem] = args;
    if (args.length !== 2 || apiKeyName === undefined || privateKeyPem === undefined || apiKeyName === '' || privateKeyPem === '') {
      // Covers the blank declared-optional case too: an empty key name or PEM must fail
      // loudly here, never mint a JWT "signed" with nothing. Names no values (C5).
      // ROLE-suffixed argument names (the lint's own wording at template-lint.ts) —
      // never bare field keys, which read as registry field names and steer the user
      // toward authoring a field the lint would then refuse (review finding).
      throw new AuthTemplateError(
        'cdp_jwt requires (api_key_field, private_key_field) — both declared fields must have values',
      );
    }
    const req = ctx.request;
    if (req === undefined) {
      throw new AuthTemplateError('cdp_jwt requires request context (method and url) to mint the uri claim');
    }
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      throw new AuthTemplateError('cdp_jwt could not parse the request url for the uri claim');
    }

    let signingKey: CryptoKey;
    try {
      signingKey = await importEd25519PrivateKey(privateKeyPem);
    } catch (err) {
      if (err instanceof CdpKeyImportError) throw new AuthTemplateError(err.message);
      throw err;
    }

    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nowSec = Number(renderTimestamp(state));

    // `parsed.host` (not hostname) keeps a non-default port in the claim — the uri must
    // describe the request actually sent. Scheme and query are dropped by construction.
    const header = { alg: 'EdDSA', kid: apiKeyName, typ: 'JWT', nonce: bytesToHex(nonceBytes) };
    const payload = {
      iss: 'cdp',
      sub: apiKeyName,
      uri: `${req.method} ${parsed.host}${parsed.pathname}`,
      nbf: nowSec,
      exp: nowSec + 120,
    };
    const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(JSON.stringify(payload))}`;

    let signature: Uint8Array;
    try {
      signature = new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, encoder.encode(signingInput)),
      );
    } catch {
      // The ONE runtime-absence sentence, owned by ed25519-key.ts (review: two typed
      // copies of a user-facing diagnosis drift).
      throw new AuthTemplateError(ED25519_RUNTIME_ERROR);
    }
    return `${signingInput}.${bytesToBase64Url(signature)}`;
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
 * is touched. The render seat ENFORCES rather than trusts: a caller that forgets to lint
 * at authoring time still cannot emit a signature computed over a typo'd literal, and no
 * future call site can be added that bypasses the check.
 *
 * The key source is the requirement's DECLARED fields (`ctx.declaredFieldKeys`), falling
 * back to the loaded keys when a caller declares nothing. It used to be `ctx.fields`
 * unconditionally, on the reasoning that the engine should lint what it would substitute
 * FROM. That reasoning was wrong for one case and it shipped: a `required: false` field
 * the user left blank is declared but never loaded, so a legitimate template naming it
 * passed the executor's declaration-based lint and was rejected HERE. The gap this lint
 * exists to close — a token naming nothing in the declaration — is still closed, because
 * the declaration is a superset of what may legally be referenced; what is no longer
 * rejected is a token naming a real field that simply has no value today, which
 * `resolveExpression` now renders as empty.
 *
 * One `RenderState` is shared across every header value so `{{timestamp()}}` in the
 * timestamp header and `{{timestamp()}}` inside the signature agree — see `RenderState`.
 */
export async function renderAuthHeaderTemplate(
  headerTemplate: Record<string, string>,
  ctx: AuthTemplateContext,
): Promise<Record<string, string>> {
  return (await renderAuthRequestTemplates({ headerTemplate }, ctx)).headers;
}

/** The two template seats of a `request` block (ADR-0022 §3). Keys are kept verbatim. */
export interface AuthRequestTemplates {
  headerTemplate?: Record<string, string>;
  queryTemplate?: Record<string, string>;
}

/**
 * Render BOTH request templates in ONE pass (TASK-20260812-desktop-auth-awareness P3,
 * ADR-0022 §3). This is the same gate as `renderAuthHeaderTemplate` — that function is
 * now a thin wrapper over this one — extended to the query seat with two properties
 * that are the whole point:
 *
 * ONE LINT RESOLUTION. The declared-field-keys list is computed ONCE and drives the
 * lint of both templates (lesson 2026-08-10: two lints disagreeing about "declared" is
 * the founding-defect shape). A query template naming an undeclared field fails here
 * exactly like a header template would, before any credential is read.
 *
 * ONE RENDER STATE. Header and query values share a single `RenderState`, so a
 * timestamp read in a header and a timestamp read in a query parameter are ONE value by
 * construction — the same second-boundary hazard `RenderState` documents for the
 * signed-and-sent header pair applies unchanged when one of the pair moves into the URL.
 *
 * Rendered QUERY values are credentials destined for a URL: the caller (the executor —
 * the only production caller) owes them the enumerated scrub obligations of ADR-0022 §3.
 */
export async function renderAuthRequestTemplates(
  templates: AuthRequestTemplates,
  ctx: AuthTemplateContext,
): Promise<{ headers: Record<string, string>; query: Record<string, string> }> {
  const fieldKeys = [...(ctx.declaredFieldKeys ?? Object.keys(ctx.fields))];
  const headerTemplate = templates.headerTemplate ?? {};
  const queryTemplate = templates.queryTemplate ?? {};
  assertLintedTemplate(headerTemplate, { fieldKeys });
  assertLintedTemplate(queryTemplate, { fieldKeys });
  const state: RenderState = {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerTemplate)) {
    headers[key] = await renderAuthTemplateString(value, ctx, state);
  }
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(queryTemplate)) {
    query[key] = await renderAuthTemplateString(value, ctx, state);
  }
  return { headers, query };
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
  // A DECLARED field with no stored value renders empty rather than throwing. This is the
  // `required: false` case: the user was invited to leave the box blank, so the header is
  // sent present-but-empty, which is what these APIs expect. A token naming nothing in the
  // declaration still throws — that is the typo guard, and it is the only reason this
  // branch cannot simply return '' for everything.
  if (ctx.declaredFieldKeys?.includes(expr) === true) {
    return '';
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
  // A DECLARED field with no stored value resolves to empty, matching `resolveExpression`.
  // This branch must come BEFORE the literal fallback below: without it a blank optional
  // field used as a helper argument would sign over the literal string "passphrase"
  // instead of the empty value — a silently wrong signature rather than a loud failure.
  if (ctx.declaredFieldKeys?.includes(token) === true) {
    return '';
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
