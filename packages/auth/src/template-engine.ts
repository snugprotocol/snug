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

import { bytesToHex, utf8ToBase64Url } from './base64url.js';

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

async function digestHex(algorithm: 'SHA-256' | 'SHA-512', value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(algorithm, encoder.encode(value))));
}

async function hmacHex(algorithm: 'SHA-256' | 'SHA-512', secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: algorithm }, false, [
    'sign',
  ]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

/** Standard (non-url) base64 of a utf8 string — what signing schemes expect. */
function base64Utf8(value: string): string {
  const url = utf8ToBase64Url(value);
  const base64 = url.replace(/-/g, '+').replace(/_/g, '/');
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4);
}

type HelperFn = (args: string[], ctx: AuthTemplateContext) => Promise<string> | string;

const HELPERS: Record<string, HelperFn> = {
  timestamp: () => Math.floor(Date.now() / 1000).toString(),
  unix_ms: () => Date.now().toString(),
  base64: (args) => base64Utf8(args[0] ?? ''),
  hmac_sha256: (args) => {
    const [secret, message] = args;
    if (secret === undefined || message === undefined) {
      throw new AuthTemplateError('hmac_sha256 requires (secret, message)');
    }
    return hmacHex('SHA-256', secret, message);
  },
  hmac_sha512: (args) => {
    const [secret, message] = args;
    if (secret === undefined || message === undefined) {
      throw new AuthTemplateError('hmac_sha512 requires (secret, message)');
    }
    return hmacHex('SHA-512', secret, message);
  },
  sha256: (args) => digestHex('SHA-256', args[0] ?? ''),
};

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const HELPER_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/;

/** Render a single template string. Unknown placeholders reject. */
export async function renderAuthTemplateString(template: string, ctx: AuthTemplateContext): Promise<string> {
  let result = '';
  let lastIndex = 0;
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    result += template.slice(lastIndex, match.index);
    result += await resolveExpression(String(match[1]).trim(), ctx);
    lastIndex = match.index + match[0].length;
  }
  return result + template.slice(lastIndex);
}

/**
 * Render every value in a header template object. Header keys are kept verbatim
 * (no templating) — only values support `{{...}}`.
 */
export async function renderAuthHeaderTemplate(
  headerTemplate: Record<string, string>,
  ctx: AuthTemplateContext,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerTemplate)) {
    out[key] = await renderAuthTemplateString(value, ctx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function resolveExpression(expr: string, ctx: AuthTemplateContext): Promise<string> {
  const helperMatch = HELPER_RE.exec(expr);
  if (helperMatch) {
    const name = helperMatch[1]!;
    const helper = HELPERS[name];
    if (helper === undefined) {
      throw new AuthTemplateError(`Unknown template helper: ${name}`);
    }
    const args = parseHelperArgs(helperMatch[2]!, ctx);
    return helper(args, ctx);
  }

  if (expr.startsWith('request.')) {
    return readRequestField(expr.slice('request.'.length), ctx);
  }
  if (Object.prototype.hasOwnProperty.call(ctx.fields, expr)) {
    return ctx.fields[expr]!;
  }
  throw new AuthTemplateError(`Unknown template field: ${expr}`);
}

function parseHelperArgs(argList: string, ctx: AuthTemplateContext): string[] {
  const trimmed = argList.trim();
  if (trimmed.length === 0) return [];

  const args: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

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
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (ch === ',' && !inSingleQuote && !inDoubleQuote) {
      args.push(resolveArgToken(current.trim(), ctx));
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(resolveArgToken(current.trim(), ctx));
  return args;
}

function resolveArgToken(token: string, ctx: AuthTemplateContext): string {
  if (token.length === 0) return '';
  if (token.startsWith('request.')) {
    return readRequestField(token.slice('request.'.length), ctx);
  }
  if (Object.prototype.hasOwnProperty.call(ctx.fields, token)) {
    return ctx.fields[token]!;
  }
  // Anything else is a literal — covers numeric or quote-stripped values.
  return token;
}

function readRequestField(path: string, ctx: AuthTemplateContext): string {
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
