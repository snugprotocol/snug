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
  CONNECTION_STATUS,
  LIMITS,
  NET_ERROR_CODES,
  NET_METHODS,
  STRIP_HEADERS,
  isWhitelistedNetResponseHeader,
  type AuthSpec,
  type AuthSpecStatus,
  type ConnectionRequirement,
  type ConnectionStatus,
  type NetMethod,
} from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey, authCredentialSecretKey } from '@snugprotocol/db';
import { isHostAllowed } from './app-host-freeze.js';
import { utf8ToBase64 } from './base64url.js';
import type { AuthConnectionState, CredentialStore } from './credential-store.js';
import { isForbiddenNetHost } from './net-guards.js';
import { OAuthService, SnugAuthError, type FetchLike } from './oauth-service.js';
import { scrubAuthValues } from './scrub.js';
import { AuthTemplateError, renderAuthHeaderTemplate } from './template-engine.js';
import { AuthTemplateLintError, assertLintedTemplate } from './template-lint.js';
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

/**
 * The v4 (Dynamic Auth v2) projection of a `snug_connections` row — a NARROWED view of
 * packages/db's `ConnectionRow`, carrying only what the executor is entitled to read.
 *
 * `pendingRequirement` is present in the TYPE and read by NOTHING in this module, and that
 * is deliberate rather than an oversight (folds B2/S-m2). Naming the seat documents that
 * the executor SAW the staged edit and refused it: binding to a pending requirement would
 * let an edit alone widen the host ceiling or re-aim a live secret into a new header with
 * no user approval — precisely the silent widening the pending column exists to prevent.
 * A reader that omitted the field would make that refusal invisible instead of explicit.
 */
export interface NetConnectionRow {
  appId: string;
  slot: string;
  /** The APPROVED requirement — the grant the executor binds to. */
  requirement: ConnectionRequirement;
  status: ConnectionStatus;
  /** The FROZEN ceiling (`allowed_hosts`), computed at approval. Routing matches against THIS. */
  allowedHosts: readonly string[];
  /** Staged, UNapproved edit. Never read at request time (folds B2/S-m2). */
  pendingRequirement?: ConnectionRequirement;
  /** Arrived via import/sync — barred with the distinct NET_IMPORTED_UNAPPROVED. */
  imported?: boolean;
}

/**
 * The v4 reader. It returns EVERY row for the app rather than pre-selecting one, because
 * selection IS the routing decision and the executor is the seat accountable for it: a
 * reader that picked a row would hide the two-match ambiguity (NET_AMBIGUOUS_CONNECTION)
 * inside an untested accessor, where no executor-altitude test could observe it.
 */
export interface NetConnectionReader {
  listConnections(appId: string): readonly NetConnectionRow[] | Promise<readonly NetConnectionRow[]>;
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

/**
 * Deps common to both eras. The READER is the only thing that differs, so it is factored
 * out into the discriminated pair below rather than being a pair of optional fields —
 * `specReader?` + `connectionReader?` would type-check a deps object carrying NEITHER,
 * and the failure would surface as a runtime `undefined.getAuthSpec` at the first request
 * instead of at the wiring site.
 */
interface ConnectedFetchBaseDeps {
  credentialStore: CredentialStore;
  fetchImpl: FetchLike;
  confirmGate: NetConfirmGate;
  /** Injectable time source (grant bookkeeping/telemetry); defaults to Date.now. */
  clock?: () => number;
}

/**
 * v3 (`snug_auth_specs`) or v4 (`snug_connections`) — exactly one, never both.
 *
 * THE CUTOVER RULE (fold B1) IS WHY BOTH EXIST. v4 is ADDITIVE: `snug_auth_specs` and its
 * shipped consumers keep working until P3 rewires the last one, so deleting the v3 reader
 * here would break a surface whose removal is a named exit item of a LATER phase. The
 * union lets one executor serve both without either path branching on the other's absence.
 */
export type ConnectedFetchDeps = ConnectedFetchBaseDeps &
  ({ specReader: NetSpecReader; connectionReader?: never } | { connectionReader: NetConnectionReader; specReader?: never });

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

// ------------------------------------------------------------- v4 slot plumbing

/**
 * A CredentialStore view scoped to ONE slot: every read/write is re-keyed from
 * `auth:<appId>:<fieldKey>` (v3) to `auth:<appId>:<slot>:<fieldKey>` (v4, P0's builders).
 *
 * WHY A WRAPPER RATHER THAN A SECOND STORE INTERFACE. The OAuth service reads its own
 * credentials (`client_id`, `client_secret`, `access_token`, `refresh_token`) directly
 * through a `CredentialStore`, so a v4 OAuth grant would silently read and WRITE v3
 * non-slot keys unless the slot is applied beneath it. Wrapping the store means the
 * service needs no v4 awareness at all and cannot be forgotten at one of its four call
 * sites — the alternative was threading a slot through every OAuth method, where the one
 * site that missed it would cross-contaminate two slots' tokens.
 *
 * THE RE-KEY IS A LIE TOLD TO THE INNER STORE, told deliberately: the composite field
 * `<slot>:<fieldKey>` is passed to a v3 store whose own builder then produces exactly the
 * v4 four-segment key. `authConnectionCredentialSecretKey` is asserted against that below
 * so the two derivations can never drift — if P0's builder shape ever changes, this
 * throws at wiring time rather than reading the wrong key forever.
 *
 * NO FALLBACK TO v3 KEYS, and this is the load-bearing security property (AC7). A miss
 * fails closed. Falling back would mean a slot RENAME keeps serving the OLD provider's
 * credential under the NEW provider's requirement — the executor would hand Dropbox's
 * token to whatever host the renamed slot now declares.
 */
class SlotScopedCredentialStore implements CredentialStore {
  constructor(
    private readonly inner: CredentialStore,
    private readonly slot: string,
  ) {}

  /** `<slot>:<field>` — the composite the inner v3 builder turns into the v4 key. */
  private scoped(field: string): string {
    return `${this.slot}:${field}`;
  }

  getCredential(appId: string, field: string): Promise<string | undefined> {
    return this.inner.getCredential(appId, this.scoped(field));
  }

  setCredential(appId: string, field: string, value: string): Promise<void> {
    return this.inner.setCredential(appId, this.scoped(field), value);
  }

  deleteCredential(appId: string, field: string): Promise<void> {
    return this.inner.deleteCredential(appId, this.scoped(field));
  }

  async listCredentialFields(appId: string): Promise<string[]> {
    const prefix = `${this.slot}:`;
    const fields = await this.inner.listCredentialFields(appId);
    return fields.filter((field) => field.startsWith(prefix)).map((field) => field.slice(prefix.length));
  }

  // Connection STATE is slot-scoped through the same composite trick, so slot A's token
  // bookkeeping (obtainedAt/expiresIn/status) can never be read as slot B's — a shared
  // state row would make one slot's expiry silently invalidate the other's live token.
  getConnectionState(appId: string): Promise<AuthConnectionState | undefined> {
    return this.inner.getConnectionState(appId, this.slot);
  }

  setConnectionState(appId: string, state: AuthConnectionState): Promise<void> {
    return this.inner.setConnectionState(appId, state, this.slot);
  }

  clearConnectionState(appId: string): Promise<void> {
    return this.inner.clearConnectionState(appId, this.slot);
  }

  /**
   * Deliberately NOT narrowed to the slot. `clearApp` is disconnect's final act and its
   * contract is "wipe the whole `auth:<appId>:*` slice"; narrowing it here would leave
   * every OTHER slot's credentials on disk after a disconnect the user believes was total.
   * The v4 per-slot wipe is `revokeConnection`'s job in packages/db (P0), which owns the
   * tombstone alongside it.
   */
  clearApp(appId: string): Promise<void> {
    return this.inner.clearApp(appId);
  }

  getOrCreateStateHmacKey(): Promise<string> {
    return this.inner.getOrCreateStateHmacKey();
  }
}

/**
 * DRIFT GUARD for the re-key above: the composite path this module builds must be byte-
 * identical to P0's canonical v4 builder. Cheap, runs once per module load, and turns a
 * future divergence between the two derivations into an immediate loud failure rather
 * than a silent read of a key that will never exist.
 */
{
  const viaComposite = authCredentialSecretKey('a', 'slot:field');
  const viaBuilder = authConnectionCredentialSecretKey('a', 'slot', 'field');
  if (viaComposite !== viaBuilder) {
    throw new Error(`v4 slot key derivation drifted: '${viaComposite}' !== '${viaBuilder}'`);
  }
}

/**
 * Adapt an approved v4 requirement to the v3 `AuthSpec` shape the injection path already
 * speaks. Requirement and spec are the same information in two dialects — the requirement
 * is FLAT (it must survive re-inference and hand-editing) while the spec is a discriminated
 * union — so this is a dialect translation, not a trust decision. Nothing is widened here:
 * hosts come from the row's FROZEN `allowedHosts`, never from anything this function reads.
 *
 * `none` returns null: a keyless kind has no spec because there is nothing to inject.
 */
function requirementToSpec(requirement: ConnectionRequirement): AuthSpec | null {
  if (requirement.kind === 'none') return null;
  const provider = { name: requirement.provider.name };
  const fields = requirement.fields ?? [];
  // The frozen ceiling is enforced from `row.allowedHosts`; the spec copy exists only
  // because the shipped schemas require the seat.
  const declaredApiHosts = [...requirement.declaredApiHosts];
  switch (requirement.kind) {
    case 'oauth2_auth_code':
      return {
        kind: 'oauth2_auth_code',
        provider,
        endpoints: {
          authorizeUrl: requirement.endpoints?.authorizeUrl ?? '',
          tokenUrl: requirement.endpoints?.tokenUrl ?? '',
          ...(requirement.endpoints?.refreshUrl !== undefined ? { refreshUrl: requirement.endpoints.refreshUrl } : {}),
          ...(requirement.endpoints?.revokeUrl !== undefined ? { revokeUrl: requirement.endpoints.revokeUrl } : {}),
        },
        ...(requirement.scopes !== undefined ? { scopes: [...requirement.scopes] } : {}),
        ...(requirement.pkce !== undefined ? { pkce: requirement.pkce } : {}),
        ...(requirement.authorizeParams !== undefined ? { authorizeParams: { ...requirement.authorizeParams } } : {}),
        clientCreds: fields.length > 0 ? fields : [{ key: 'client_id', label: 'Client ID', type: 'text' as const }],
        declaredApiHosts,
      } as AuthSpec;
    case 'oauth2_client_creds':
      return {
        kind: 'oauth2_client_creds',
        provider,
        endpoints: { tokenUrl: requirement.endpoints?.tokenUrl ?? '' },
        ...(requirement.scopes !== undefined ? { scopes: [...requirement.scopes] } : {}),
        clientCreds: fields.length > 0 ? fields : [{ key: 'client_id', label: 'Client ID', type: 'text' as const }],
        declaredApiHosts,
      } as AuthSpec;
    default:
      return {
        kind: requirement.kind,
        provider,
        fields,
        ...(requirement.request !== undefined ? { request: { ...requirement.request } } : {}),
        declaredApiHosts,
      } as AuthSpec;
  }
}

/**
 * The routing outcome. Modelled as a THREE-way result rather than `NetConnectionRow |
 * undefined` because zero-match and two-match are different refusals with different codes,
 * and collapsing them would force the caller to re-derive which one happened.
 */
type SlotResolution =
  | { kind: 'matched'; row: NetConnectionRow }
  | { kind: 'none'; declaredProvider?: string }
  | { kind: 'ambiguous'; slots: string[] };

/**
 * SLOT ROUTING (parent §5 Multi-connection, R6): pick the grant by TARGET HOST against
 * each row's FROZEN `allowed_hosts`. Never by position, never "the first row", never a
 * guess — those would all resolve to "send some credential and hope".
 *
 * Only APPROVED rows participate. `declared` rows are requirements the user never granted
 * and `revoked` rows are tombstones; either serving a request would make approval
 * decorative.
 */
function resolveSlot(rows: readonly NetConnectionRow[], host: string): SlotResolution {
  const approved = rows.filter((row) => row.status === CONNECTION_STATUS.approved);
  const matches = approved.filter((row) => isHostAllowed(host, row.allowedHosts));
  if (matches.length === 1) return { kind: 'matched', row: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', slots: matches.map((row) => row.slot).sort() };

  // ZERO MATCHES — name the provider the user would have to connect, but ONLY when a
  // DECLARED (or revoked) row for this host backs the claim. Deriving the name from the
  // REQUEST instead would let the app choose the host's own CTA copy, turning an error
  // banner into an app-authored phishing surface.
  const candidate = rows.find(
    (row) => row.status !== CONNECTION_STATUS.approved && isHostAllowed(host, deriveRowHosts(row)),
  );
  return candidate === undefined ? { kind: 'none' } : { kind: 'none', declaredProvider: candidate.requirement.provider.name };
}

/**
 * The hosts an UNAPPROVED row would serve. `allowed_hosts` is only frozen at approval, so
 * a `declared` row may carry an empty ceiling — falling back to the requirement's declared
 * hosts is what lets the zero-match CTA name the right provider. This value NEVER gates a
 * request: it is used solely to choose CTA copy, on a path that has already refused.
 */
function deriveRowHosts(row: NetConnectionRow): readonly string[] {
  return row.allowedHosts.length > 0 ? row.allowedHosts : row.requirement.declaredApiHosts;
}

// --------------------------------------------------------------------- factory

export function createConnectedFetch(deps: ConnectedFetchDeps): ConnectedFetch {
  void (deps.clock ?? Date.now); // reserved seat — grant bookkeeping moved to AL-10 (AL-04 N6: nothing in the wizard reads time)

  /**
   * Internal OAuth service seat: token get/refresh only. Flow starts belong to the
   * approval surface (AL-04); this provider throwing keeps that boundary typed.
   *
   * Built PER STORE rather than once, because a v4 grant's service must sit on the
   * SLOT-SCOPED store (its `access_token`/`refresh_token` live under the slot). The v3
   * path passes the bare store and gets exactly today's object.
   */
  const oauthFor = (store: CredentialStore): OAuthService =>
    new OAuthService({
      store,
      redirectUriProvider: {
        redirectUri: () => {
          throw new Error('connected-fetch never starts OAuth flows — connect via the approval surface');
        },
      },
      fetch: deps.fetchImpl,
    });

  const v3Oauth = deps.specReader !== undefined ? oauthFor(deps.credentialStore) : null;

  /**
   * The era-neutral view the injection path consumes. Both readers collapse to this, so
   * gates 5–10 are ONE code path rather than two — a v4-only duplicate of the scrub, the
   * redirect block or the size cap is exactly how a guarantee silently stops applying to
   * half the traffic.
   */
  interface ResolvedGrant {
    /** null for kind 'none' — nothing to inject (Q6). */
    spec: AuthSpec | null;
    allowedHosts: readonly string[];
    store: CredentialStore;
    oauth: OAuthService;
  }

  async function resolveInjectedHeaders(
    appId: string,
    grant: ResolvedGrant,
    request: { method: string; url: string; body?: string },
    forceRefresh: boolean,
  ): Promise<Record<string, string>> {
    const spec = grant.spec;
    // Q6 — kind 'none': the keyless provider. Injects NOTHING. Approval and the frozen
    // host ceiling still gated this request upstream; "no credential" never means "no
    // gate", which is why `none` is a connection row at all rather than the absence of one.
    if (spec === null) return {};
    if (spec.kind === 'oauth2_auth_code') {
      const scope = { appId, spec, allowedHosts: grant.allowedHosts };
      const token = forceRefresh ? await grant.oauth.refresh(scope) : await grant.oauth.getAccessToken(scope);
      return { Authorization: `Bearer ${token}` };
    }
    if (spec.kind === 'oauth2_client_creds') {
      const scope = { appId, spec, allowedHosts: grant.allowedHosts };
      const token = forceRefresh
        ? await grant.oauth.refreshClientCreds(scope)
        : await grant.oauth.getClientCredsAccessToken(scope);
      return { Authorization: `Bearer ${token}` };
    }
    // Static kinds — values read from the store PER USE (AL-02 D4, no cache anywhere).
    const fields: Record<string, string> = {};
    for (const field of spec.fields) {
      const value = await grant.store.getCredential(appId, field.key);
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
      // Lint against the spec's DECLARED field keys, not the keys actually loaded above.
      // The two differ whenever an optional field has no stored value: `fields` would be
      // missing that key, so the engine's own gate (which lints `Object.keys(ctx.fields)`)
      // would reject a template that is legitimately correct for this spec. Linting the
      // declaration here is both stricter in the case that matters — a key naming nothing
      // in the spec is rejected even if a same-named value happened to be loaded — and
      // kinder in the case that does not.
      assertLintedTemplate(template, { fieldKeys: spec.fields.map((field) => field.key) });
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

  /**
   * Gates 2+3 for BOTH eras, returning the era-neutral grant or the refusal.
   *
   * v3 keeps its exact semantics: one row by `app_id`, then status, then the ceiling check
   * (NET_HOST_BLOCKED for an off-ceiling host — the row was FOUND, it simply does not cover
   * this host).
   *
   * v4 routes by host, so an off-ceiling host matches NO ROW and the honest code is
   * NET_NOT_APPROVED rather than NET_HOST_BLOCKED: there is no row whose ceiling was
   * violated, only a host nothing was ever approved for. Same refusal, more accurate name.
   */
  async function resolveGrant(
    appId: string,
    host: string,
  ): Promise<{ ok: true; grant: ResolvedGrant } | { ok: false; failure: ConnectedFetchResult }> {
    if (deps.specReader !== undefined) {
      const row = await deps.specReader.getAuthSpec(appId);
      if (row === undefined) {
        return { ok: false, failure: failure(NET_ERROR_CODES.NET_NOT_APPROVED, 'no approved connection exists for this app') };
      }
      if (row.status === AUTH_SPEC_STATUS.importedUnapproved) {
        return {
          ok: false,
          failure: failure(
            NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
            'this connection arrived via import/sync — re-approve it in settings before the app can use it',
          ),
        };
      }
      if (row.status !== AUTH_SPEC_STATUS.approved) {
        return { ok: false, failure: failure(NET_ERROR_CODES.NET_NOT_APPROVED, 'this connection has not been approved yet') };
      }
      if (!isHostAllowed(host, row.allowedHosts)) {
        return {
          ok: false,
          failure: failure(NET_ERROR_CODES.NET_HOST_BLOCKED, `host '${host}' is outside this app's approved host set`),
        };
      }
      return {
        ok: true,
        grant: { spec: row.spec, allowedHosts: row.allowedHosts, store: deps.credentialStore, oauth: v3Oauth! },
      };
    }

    const rows = await deps.connectionReader.listConnections(appId);
    const resolution = resolveSlot(rows, host);

    if (resolution.kind === 'ambiguous') {
      // Refused BEFORE any credential read — the whole point. The message names the
      // CONFLICTING SLOTS (build-time identifiers the user already sees in Settings) and
      // never a field key, a provider secret or a stored value (C5).
      return {
        ok: false,
        failure: failure(
          NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION,
          `two approved connections (${resolution.slots.join(', ')}) both claim '${host}' — refusing to guess which credential to send`,
        ),
      };
    }

    if (resolution.kind === 'none') {
      // An IMPORTED row for this host earns the DISTINCT code so Settings can name the
      // remedy ("re-approve") instead of the generic "connect".
      const importedCandidate = rows.find(
        (row) => row.imported === true && row.status !== CONNECTION_STATUS.approved && isHostAllowed(host, deriveRowHosts(row)),
      );
      if (importedCandidate !== undefined) {
        return {
          ok: false,
          failure: failure(
            NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
            'this connection arrived via import/sync — re-approve it in settings before the app can use it',
          ),
        };
      }
      const named = resolution.declaredProvider;
      return {
        ok: false,
        failure: failure(
          NET_ERROR_CODES.NET_NOT_APPROVED,
          named === undefined
            ? 'no approved connection covers this request'
            : `no approved connection covers this request — connect ${named} to continue`,
        ),
      };
    }

    const row = resolution.row;
    // THE GRANT IS THE APPROVED REQUIREMENT (folds B2/S-m2). `row.pendingRequirement` is
    // never consulted: hosts come from the FROZEN `allowedHosts` and the template/fields
    // from `row.requirement`, so a staged edit can neither widen the ceiling nor re-aim a
    // live secret into a new header before the user approves it.
    const store = new SlotScopedCredentialStore(deps.credentialStore, row.slot);
    return {
      ok: true,
      grant: {
        spec: requirementToSpec(row.requirement),
        allowedHosts: row.allowedHosts,
        store,
        oauth: oauthFor(store),
      },
    };
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

      // ---------------------------------------------------------------- AMENDED ORDER
      // GATE 3↔4 SWAP — PARSE-THEN-RESOLVE (fold F-m2, amended in the open).
      //
      // The shipped v3 order resolved the row FIRST (a primary-key lookup on `app_id`) and
      // parsed the URL second, which was coherent while "which connection?" had exactly one
      // possible answer. Under v4's `(app_id, slot)` key the answer is chosen BY TARGET
      // HOST, and the host is only knowable from a PARSED url — so resolution structurally
      // cannot precede the parse any more.
      //
      // WHAT THE SWAP COSTS AND WHY IT IS SAFE. Every gate keeps its relative order and its
      // semantics; only these two exchange places. The observable difference is which code
      // an app sees when BOTH would fire: a malformed or non-https URL on an app with no
      // approved connection now reports the URL fault (NET_INVALID_REQUEST /
      // NET_SCHEME_BLOCKED) instead of NET_NOT_APPROVED. That is strictly MORE honest — the
      // request was malformed regardless of approval state — and it leaks nothing new,
      // because URL validity is a property of the app's OWN input, which the app already
      // knows. Nothing that was refused before is admitted now: the parse gates only ever
      // ADD refusals ahead of the approval check, never remove one behind it.
      //
      // Gate 1 (shape) still precedes both, so an unknown top-level field still loses to
      // shape validation rather than to the URL.
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

      // Gates 2+3 — host-assigned binding (R5); the grant must exist, be approved, and
      // (v4) be the UNIQUE approved grant claiming this host.
      const resolved = await resolveGrant(appId, host);
      if (!resolved.ok) return resolved.failure;
      const grant = resolved.grant;

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
          injected = await resolveInjectedHeaders(appId, grant, { method, url: url.href, ...(body !== undefined ? { body } : {}) }, forceRefresh);
        } catch (err) {
          if (err instanceof SnugAuthError) {
            // The typed CAUSE rides along with the prose. All of these collapse to one wire
            // code (NET_AUTH_FAILED) by design — the app must learn nothing beyond "auth
            // failed" — but the HOST's own surfaces (Settings, the wizard's error banner)
            // need to tell "you never pasted this credential" apart from "the mint was
            // rejected", and re-deriving that from a message substring is exactly the
            // fragile matching N1 outlawed for the CTA map. Codes are enumerated in
            // oauth-service.ts and are never values (C5): `missing_credential` names the
            // FIELD that is absent, never what would have been stored in it.
            return failure(NET_ERROR_CODES.NET_AUTH_FAILED, `${err.message} (${err.code})`);
          }
          if (err instanceof AuthTemplateError || err instanceof AuthTemplateLintError) {
            // A lint failure joins the same bucket: it is an auth-configuration fault, not
            // an executor crash. The message names only template structure — never a value.
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
      const isOauthKind = grant.spec?.kind === 'oauth2_auth_code' || grant.spec?.kind === 'oauth2_client_creds';
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

// ------------------------------------------------------- the testRequest probe (Q7)

/**
 * "Test this connection" (Q7), for the wizard's `done` step.
 *
 * IT IS A THIN WRAPPER OVER `execute`, AND THAT IS THE ENTIRE POINT. The natural
 * implementation of a test button is a small dedicated fetch, which would be a SECOND
 * NETWORK PATH: a second host channel with no frozen-ceiling check, a second injection
 * seat with no scrub on the way back, and a second confirm bypass — reachable from the one
 * surface whose whole purpose is to be clicked while credentials are fresh. So this
 * function does exactly two things the executor cannot do for itself (find the slot's
 * stored probe, and turn `pathAndQuery` into an absolute URL) and then hands the request to
 * the SAME ten gates. `test-request-single-path.test.ts` walks the package's sources to
 * prove no third `fetchImpl(` seat ever appears.
 *
 * URL CONSTRUCTION IS `new URL(path, base)`, never string concatenation. Concatenation
 * would let a stored `//evil.example/x` resolve to a NEW HOST; resolving against a base and
 * re-checking through the executor's own routing means an escaped host simply matches no
 * grant and is refused. The probe therefore cannot leave the frozen ceiling even if the
 * stored path tries to — it does not get a private host channel to escape through.
 *
 * GET-only by schema (`connectionTestRequestSchema`), so a probe can never be a write
 * primitive; the executor's confirm gate would catch a mutating method regardless.
 */
export async function executeConnectionTestRequest(
  deps: ConnectedFetchDeps,
  appId: string,
  slot: string,
): Promise<ConnectedFetchResult> {
  const reader = deps.connectionReader;
  if (reader === undefined) {
    return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'the connection probe requires the v4 connection reader');
  }
  const rows = await reader.listConnections(appId);
  const row = rows.find((candidate) => candidate.slot === slot);
  if (row === undefined) {
    return failure(NET_ERROR_CODES.NET_NOT_APPROVED, `no connection exists at slot '${slot}'`);
  }

  // NOTHING IS INVENTED. A connection with no declared probe is not probeable — synthesizing
  // a plausible path ('/', '/me', …) would be the host guessing at a provider's API surface
  // and sending live credentials at the guess.
  const testRequest = row.requirement.testRequest;
  if (testRequest === undefined) {
    return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, `connection '${slot}' declares no test request`);
  }

  // The base host is the FIRST frozen host — the probe's origin is drawn from the approved
  // ceiling, never from the requirement's (re-editable) declared list.
  const baseHost = row.allowedHosts[0] ?? row.requirement.declaredApiHosts[0];
  if (baseHost === undefined) {
    return failure(NET_ERROR_CODES.NET_NOT_APPROVED, `connection '${slot}' has no approved host to probe`);
  }
  let probeUrl: string;
  try {
    probeUrl = new URL(testRequest.pathAndQuery, `https://${baseHost}`).href;
  } catch {
    return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'the stored test request does not form a valid url');
  }

  return createConnectedFetch(deps).execute(appId, { url: probeUrl, method: testRequest.method });
}
