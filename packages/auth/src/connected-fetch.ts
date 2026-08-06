/**
 * The connected-fetch executor (AL-03 plan D2) — the ONLY seat that both reads
 * credential values and calls fetch. Ported from OProject's auth-fetch resolver seam +
 * response scrubber, re-seated DI-pure on Snug's local-first custody: credentials come
 * from the CredentialStore per use (no cache — AL-02 D4), the approval/ceiling row from
 * the NetSpecReader (the `snug_auth_specs` accessor), and the network from an injected
 * `fetchImpl`. The runner NEVER imports this module (value-blind bridge, amendment R4);
 * the embedder wires it in.
 *
 * Enforcement order is pinned by plan D3 and each gate is tested at this altitude:
 *   1. shape (hand-written, fail closed; GET/HEAD body rejected per R2; byte cap on the body)
 *   2. binding — `appId` is HOST-assigned (R5); the input carries no identity field
 *   3. spec exists AND status === approved (AL-02 status contract; imported rows
 *      barred with the distinct NET_IMPORTED_UNAPPROVED)
 *   4. https-only scheme (A1 — no localhost exception) + punycode-normalized host ∈
 *      frozenAllowedHosts (B3, both sides normalized at check time)
 *   5. SSRF literal guard (net-guards.ts — honest browser edition)
 *   6. mutating methods pass the confirm gate BEFORE any credential is read
 *   7. app-supplied credential-shaped headers stripped (C1, belt to the schema's braces)
 *   8. injection per kind (template engine / OAuth service, ceiling-checked internally)
 *   9. fetch with redirect:'manual' — a 30x is NET_REDIRECT_BLOCKED, never followed
 *  10. response read under the 1 MiB cap (overflow → small terminal NET_SIZE_EXCEEDED,
 *      B1), scrubbed (body + whitelisted header values, R1), whitelist-filtered (A2)
 *
 * There is no relaxation parameter of any kind anywhere in this module (C1 / audit
 * bug 3 dies by construction — the AC lint walks this file like every other).
 */

import {
  AUTH_SPEC_STATUS,
  LIMITS,
  NET_ERROR_CODES,
  NET_METHODS,
  STRIP_HEADERS,
  isWhitelistedNetResponseHeader,
  type AuthSpec,
  type AuthSpecStatus,
  type NetMethod,
} from '@snugprotocol/protocol';
import { isHostAllowed } from './app-host-freeze.js';
import { utf8ToBase64 } from './base64url.js';
import type { CredentialStore } from './credential-store.js';
import { isForbiddenNetHost } from './net-guards.js';
import { OAuthService, SnugAuthError, type FetchLike } from './oauth-service.js';
import { scrubAuthValues } from './scrub.js';
import { AuthTemplateError, renderAuthHeaderTemplate } from './template-engine.js';
import type { NetConfirmRequest } from './session-confirm.js';

// ------------------------------------------------------------------------ types

/** The slice of a `snug_auth_specs` row the executor consumes (AL-02's AuthSpecRow shape). */
export interface NetSpecRow {
  spec: AuthSpec;
  status: AuthSpecStatus;
  /** The FROZEN ceiling (`allowed_hosts` column). The runtime injection ceiling IS this set. */
  allowedHosts: readonly string[];
}

export interface NetSpecReader {
  getAuthSpec(appId: string): NetSpecRow | undefined | Promise<NetSpecRow | undefined>;
}

/** Decision seat for mutating calls (D3.6). The playground wires the session-remember gate. */
export interface NetConfirmGate {
  confirm(request: NetConfirmRequest): boolean | Promise<boolean>;
}

export interface NetRequestInput {
  url: string;
  method?: NetMethod;
  headers?: Record<string, string>;
  body?: string;
}

export type ConnectedFetchResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated?: boolean }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface ConnectedFetchDeps {
  credentialStore: CredentialStore;
  specReader: NetSpecReader;
  fetchImpl: FetchLike;
  confirmGate: NetConfirmGate;
  /** Injectable time source (grant bookkeeping/telemetry); defaults to Date.now. */
  clock?: () => number;
}

export interface ConnectedFetch {
  /** `appId` is the HOST-assigned binding (R5) — never anything the app claimed. */
  execute(appId: string, input: NetRequestInput): Promise<ConnectedFetchResult>;
}

// -------------------------------------------------------------------- internals

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_URL_CHARS = 4096;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 4096;
const NET_METHOD_SET = new Set<string>(NET_METHODS);

/**
 * Hand-written input validation — DELIBERATELY not zod (this package declares only
 * @snugprotocol/{db,protocol} as runtime deps; the AC5 lint pins that set, and a phantom
 * zod import made the executor unloadable from a clean checkout). These checks are
 * DEFENSE IN DEPTH: the strict `netRequestSchema` at the protocol bridge already parsed
 * and rejected malformed frames BEFORE the runner routed to this executor. Returns a
 * human-readable reason on failure, `null` when the shape is acceptable.
 */
function validateInputShape(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '(root): expected an object';
  const { url, method, headers, body } = input as Record<string, unknown>;
  // Reject unknown top-level fields (strict — matches the netRequestSchema posture).
  for (const key of Object.keys(input as object)) {
    if (key !== 'url' && key !== 'method' && key !== 'headers' && key !== 'body') {
      return `${key}: unexpected field`;
    }
  }
  if (typeof url !== 'string' || url.length < 1 || url.length > MAX_URL_CHARS) {
    return 'url: must be a non-empty string within the length cap';
  }
  const resolvedMethod = method === undefined ? 'GET' : method;
  if (typeof resolvedMethod !== 'string' || !NET_METHOD_SET.has(resolvedMethod)) {
    return `method: must be one of ${NET_METHODS.join(', ')}`;
  }
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      return 'headers: must be an object';
    }
    for (const [name, value] of Object.entries(headers)) {
      if (name.length < 1 || name.length > MAX_HEADER_NAME_CHARS) return `headers.${name}: name length out of range`;
      if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_CHARS) {
        return `headers.${name}: value must be a string within the length cap`;
      }
    }
  }
  if (body !== undefined && typeof body !== 'string') return 'body: must be a string';
  if ((resolvedMethod === 'GET' || resolvedMethod === 'HEAD') && body !== undefined) {
    return `body: not allowed on ${resolvedMethod}`;
  }
  return null;
}

const STRIP_SET = new Set<string>(STRIP_HEADERS);
const API_KEY_PATTERN = /api[-_]?key/i;
const TOKEN_HEADER_PATTERN = /^x-.*(auth|token)/i;

/** C1 gate 7: the envelope strip list plus the api-key/token header name patterns. */
function isCredentialShapedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return STRIP_SET.has(lower) || API_KEY_PATTERN.test(lower) || TOKEN_HEADER_PATTERN.test(lower);
}

function stripCredentialShapedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialShapedHeaderName(name)) out[name] = value;
  }
  return out;
}

const encoder = new TextEncoder();

const failure = (code: string, message: string, retryable = false): ConnectedFetchResult => ({
  ok: false,
  code,
  message,
  retryable,
});

/**
 * Read the body while enforcing the byte cap (B1): overflow discards every byte read so
 * far and reports overflow — a partial body (which could hold a partially-scrubbed
 * credential reflection) never leaves this function.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<{ body: string; overflow: boolean }> {
  const stream = response.body;
  if (stream === null || stream === undefined || typeof stream.getReader !== 'function') {
    const text = await response.text().catch(() => '');
    if (encoder.encode(text).byteLength > maxBytes) return { body: '', overflow: true };
    return { body: text, overflow: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* the connection is being dropped either way */
        }
        return { body: '', overflow: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder('utf-8', { fatal: false }).decode(combined), overflow: false };
}

// --------------------------------------------------------------------- factory

export function createConnectedFetch(deps: ConnectedFetchDeps): ConnectedFetch {
  void (deps.clock ?? Date.now); // reserved seat (plan D2) — grant bookkeeping lands with AL-04
  // Internal OAuth service seat: token get/refresh only. Flow starts belong to the
  // approval surface (AL-04); this provider throwing keeps that boundary typed.
  const oauth = new OAuthService({
    store: deps.credentialStore,
    redirectUriProvider: {
      redirectUri: () => {
        throw new Error('connected-fetch never starts OAuth flows — connect via the approval surface');
      },
    },
    fetch: deps.fetchImpl,
  });

  async function resolveInjectedHeaders(
    appId: string,
    row: NetSpecRow,
    request: { method: string; url: string; body?: string },
    forceRefresh: boolean,
  ): Promise<Record<string, string>> {
    const spec = row.spec;
    if (spec.kind === 'oauth2_auth_code') {
      const scope = { appId, spec, allowedHosts: row.allowedHosts };
      const token = forceRefresh ? await oauth.refresh(scope) : await oauth.getAccessToken(scope);
      return { Authorization: `Bearer ${token}` };
    }
    if (spec.kind === 'oauth2_client_creds') {
      const scope = { appId, spec, allowedHosts: row.allowedHosts };
      const token = forceRefresh ? await oauth.refreshClientCreds(scope) : await oauth.getClientCredsAccessToken(scope);
      return { Authorization: `Bearer ${token}` };
    }
    // Static kinds — values read from the store PER USE (AL-02 D4, no cache anywhere).
    const fields: Record<string, string> = {};
    for (const field of spec.fields) {
      const value = await deps.credentialStore.getCredential(appId, field.key);
      if (value === undefined) {
        if (field.required !== false) {
          throw new SnugAuthError(`missing credential field '${field.key}' — connect this app first`, 'missing_credential');
        }
        continue;
      }
      fields[field.key] = value;
    }
    const template = spec.request?.headerTemplate;
    if (template !== undefined) {
      return renderAuthHeaderTemplate(template, {
        fields,
        request: { method: request.method, url: request.url, ...(request.body !== undefined ? { body: request.body } : {}) },
      });
    }
    // Kind defaults, ported from the source system (browser-safe base64 for Basic).
    switch (spec.kind) {
      case 'bearer_token':
        return { Authorization: `Bearer ${fields[spec.fields[0]!.key] ?? ''}` };
      case 'basic_auth': {
        const user = fields[spec.fields[0]!.key] ?? '';
        const pass = fields[spec.fields[1]!.key] ?? '';
        return { Authorization: `Basic ${utf8ToBase64(`${user}:${pass}`)}` };
      }
      case 'api_key':
        return { 'X-Api-Key': fields[spec.fields[0]!.key] ?? '' };
    }
  }

  return {
    async execute(appId, input): Promise<ConnectedFetchResult> {
      // Gate 1 — shape, fail closed (hand-written; defense in depth over the bridge's
      // strict netRequestSchema).
      const shapeError = validateInputShape(input);
      if (shapeError !== null) {
        return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, `invalid net request: ${shapeError}`);
      }
      const method = input.method ?? 'GET';
      const body = input.body;
      if (body !== undefined && encoder.encode(body).byteLength > LIMITS.MAX_NET_REQUEST_BODY_BYTES) {
        return failure(
          NET_ERROR_CODES.NET_SIZE_EXCEEDED,
          `request body exceeds ${LIMITS.MAX_NET_REQUEST_BODY_BYTES} bytes`,
        );
      }

      // Gates 2+3 — host-assigned binding; spec must exist and be approved.
      const row = await deps.specReader.getAuthSpec(appId);
      if (row === undefined) {
        return failure(NET_ERROR_CODES.NET_NOT_APPROVED, 'no approved connection exists for this app');
      }
      if (row.status === AUTH_SPEC_STATUS.importedUnapproved) {
        return failure(
          NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
          'this connection arrived via import/sync — re-approve it in settings before the app can use it',
        );
      }
      if (row.status !== AUTH_SPEC_STATUS.approved) {
        return failure(NET_ERROR_CODES.NET_NOT_APPROVED, 'this connection has not been approved yet');
      }

      // Gate 4 — URL parse, https-only scheme (A1), frozen-host ceiling (B3 both sides).
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'url does not parse');
      }
      if (url.username !== '' || url.password !== '') {
        return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'urls with embedded credentials are not allowed');
      }
      if (url.protocol !== 'https:') {
        return failure(NET_ERROR_CODES.NET_SCHEME_BLOCKED, 'only https requests are allowed — no exceptions');
      }
      const host = url.hostname;
      if (!isHostAllowed(host, row.allowedHosts)) {
        return failure(NET_ERROR_CODES.NET_HOST_BLOCKED, `host '${host}' is outside this app's approved host set`);
      }

      // Gate 5 — SSRF literal guard (defense in depth: runs even for ceiling members).
      if (isForbiddenNetHost(host)) {
        return failure(NET_ERROR_CODES.NET_SSRF_BLOCKED, `host '${host}' is a private/loopback target`);
      }

      // Gate 6 — mutating methods need the user's confirmation BEFORE credentials move.
      if (method !== 'GET' && method !== 'HEAD') {
        const granted = await deps.confirmGate.confirm({ appId, host, method, url: url.href });
        if (granted !== true) {
          return failure(NET_ERROR_CODES.NET_CONFIRM_DENIED, `the user declined this ${method} request`);
        }
      }

      // Gate 7 — app-supplied credential-shaped headers are ALWAYS stripped (C1).
      const appHeaders = stripCredentialShapedHeaders(input.headers ?? {});

      const performFetch = async (forceRefresh: boolean): Promise<ConnectedFetchResult> => {
        // Gate 8 — injection (per kind; OAuth paths are ceiling-checked internally, N2b).
        let injected: Record<string, string>;
        try {
          injected = await resolveInjectedHeaders(appId, row, { method, url: url.href, ...(body !== undefined ? { body } : {}) }, forceRefresh);
        } catch (err) {
          if (err instanceof SnugAuthError || err instanceof AuthTemplateError) {
            return failure(NET_ERROR_CODES.NET_AUTH_FAILED, err.message);
          }
          throw err;
        }

        // Gate 9 — the fetch itself: injected headers win over app headers; redirects
        // are returned, never followed.
        let response: Response;
        try {
          response = await deps.fetchImpl(url.href, {
            method,
            headers: { ...appHeaders, ...injected },
            ...(body !== undefined ? { body } : {}),
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return failure(NET_ERROR_CODES.NET_FETCH_FAILED, `request failed: ${message}`, true);
        }
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          return failure(NET_ERROR_CODES.NET_REDIRECT_BLOCKED, 'the server answered with a redirect — never followed');
        }

        // Gate 10 — size cap while reading (B1), scrub (D4/R1), whitelist headers (A2).
        const read = await readBodyCapped(response, LIMITS.MAX_NET_RESPONSE_BODY_BYTES);
        if (read.overflow) {
          return failure(
            NET_ERROR_CODES.NET_SIZE_EXCEEDED,
            `response exceeded the ${LIMITS.MAX_NET_RESPONSE_BODY_BYTES}-byte cap and was discarded`,
          );
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          if (isWhitelistedNetResponseHeader(name)) {
            headers[name.toLowerCase()] = scrubAuthValues(value, injected);
          }
        });
        return { ok: true, status: response.status, headers, body: scrubAuthValues(read.body, injected) };
      };

      const first = await performFetch(false);
      // OAuth 401 → one transparent refresh-and-retry (the token may be revoked or
      // stale beyond the skew window); static kinds surface the 401 as-is.
      const isOauthKind = row.spec.kind === 'oauth2_auth_code' || row.spec.kind === 'oauth2_client_creds';
      if (first.ok && first.status === 401 && isOauthKind) {
        try {
          const second = await performFetch(true);
          return second.ok ? second : first;
        } catch {
          return first;
        }
      }
      return first;
    },
  };
}
