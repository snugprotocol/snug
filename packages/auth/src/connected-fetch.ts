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
 *   4. https-only scheme (A1 — no localhost exception; the desktop transport policy's
 *      one admission is http to an RFC-1918 IPv4 LITERAL, Decision 6 below) +
 *      punycode-normalized host ∈ frozenAllowedHosts (B3, both sides normalized at
 *      check time)
 *   5. SSRF literal guard (net-guards.ts — honest browser edition; stood down ONLY for
 *      the same policy-admitted RFC-1918 class, which this gate forbids for no other
 *      reason)
 *   6. mutating methods pass the confirm gate BEFORE any credential is read
 *   7. app-supplied credential-shaped headers stripped (C1, belt to the schema's braces)
 *   8. injection per kind (template engine / OAuth service, ceiling-checked internally)
 *   9. fetch with redirect:'manual' — a 30x is NET_REDIRECT_BLOCKED, never followed
 *  10. response read under the 1 MiB cap (overflow → small terminal NET_SIZE_EXCEEDED,
 *      B1), scrubbed (body + whitelisted header values, R1), whitelist-filtered (A2)
 *
 * There is no strictness knob anywhere in this module (C1 / audit bug 3 dies by
 * construction — the AC lint walks this file like every other). The one deliberate
 * transport-profile seat is `transportPolicy` (Decision 6, TASK-20260812): it widens
 * ONLY which scheme gates 4+5 accept for RFC-1918 IPv4 literals already inside the
 * frozen approved ceiling — no credential, confirm, injection, scrub, redirect, or
 * size gate reads it, and absent/false is byte-identical to the browser profile.
 */

import {
  AUTH_SPEC_STATUS,
  CONNECTION_STATUS,
  LIMITS,
  NET_ERROR_CODES,
  NET_METHODS,
  STRIP_HEADERS,
  isWhitelistedNetResponseHeader,
  parseConnectionUrl,
  type AuthSpec,
  type AuthSpecStatus,
  type ConnectionRequest,
  type ConnectionRequirement,
  type ConnectionStatus,
  type NetMethod,
  SIDECAR_SYMBOLIC_HOST,} from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey, authCredentialSecretKey } from '@snugprotocol/db';
import { isHostAllowed } from './app-host-freeze.js';
import { utf8ToBase64 } from './base64url.js';
import type { AuthConnectionState, CredentialStore } from './credential-store.js';
import { isForbiddenNetHost, isPrivateRfc1918Ipv4Literal } from './net-guards.js';
import { OAuthService, SnugAuthError, type FetchLike } from './oauth-service.js';
import { scrubAuthValues } from './scrub.js';
import { AuthTemplateError, renderAuthRequestTemplates } from './template-engine.js';
import { AuthTemplateLintError, assertLintedTemplate } from './template-lint.js';
import type { NetConfirmRequest } from './session-confirm.js';

// ------------------------------------------------------------------------ types


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
/**
 * The LAN pinned-TLS transport (ADR-0023 Decision 3; P0 amendment 6) — the
 * desktop shell's `lan_fetch` command, seen from this side of the IPC boundary.
 *
 * A SEPARATE TYPE FROM `FetchLike`, deliberately. `FetchLike` is the web
 * contract and stays byte-untouched: widening it with an optional third
 * parameter would put "pin" in the vocabulary of every fetch seat in this
 * package, including the ones a browser wires, and a browser has no business
 * knowing what a certificate pin is. The pin is a REQUIRED parameter here
 * because a pinless call to this transport is not a weaker request — it is a
 * different (pair-mode) trust decision that only the wizard may make.
 */
export type LanFetchLike = (url: string, init: RequestInit, pin: string) => Promise<Response>;

interface ConnectedFetchBaseDeps {
  credentialStore: CredentialStore;
  fetchImpl: FetchLike;
  /**
   * HOST-POLICY override of the per-request wall clock (default
   * REQUEST_TIMEOUT_MS). Deps-level on purpose: a timeout an app or a
   * requirement could set is a timeout an app can effectively disable. Tests
   * inject a small value to drive the armed-signal path without waiting.
   */
  requestTimeoutMs?: number;
  /**
   * DESKTOP-ONLY, and absent on web (AC10: absence is byte-identical to today).
   * Supplied by the shell's platform seam; routed to by the executor — and ONLY
   * by the executor — for an RFC-1918 IPv4 literal that is already inside the
   * frozen ceiling, carrying that connection's recorded TOFU pin.
   *
   * IT IS NEVER A FALLBACK FOR `fetchImpl`, IN EITHER DIRECTION. A LAN host with
   * no `lanFetch` fails honestly rather than silently riding the public-root
   * transport (which would fail with an opaque TLS error at best, and at worst
   * succeed against something that is not the user's bridge); and a public host
   * never reaches `lanFetch`, because pinned trust is a property of the HOST
   * CLASS, not of a pin happening to exist.
   */
  lanFetch?: LanFetchLike;
  /**
   * THE SIDECAR TRANSPORT (ADR-0032) — a locally-spawned helper on a unix socket.
   *
   * Desktop-only, and its ABSENCE is a refusal rather than a fallback to `fetchImpl`, for the
   * same reason `lanFetch` states above: the symbolic host is an IDENTITY the frozen ceiling
   * can hold, not an address. `.localhost` is RFC 6761 reserved and the helper has no TCP
   * endpoint at all, so a request that reached the network could only fail — and on a browser
   * it would leak the attempt to a DNS resolver.
   */
  sidecarFetch?: (
    method: string,
    pathAndQuery: string,
    body?: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: string }>;
  confirmGate: NetConfirmGate;
  /** Injectable time source (grant bookkeeping/telemetry); defaults to Date.now. */
  clock?: () => number;
  /**
   * Desktop transport profile (Decision 6, TASK-20260812 / ADR-0021 draft). When
   * `allowHttpForPrivateHosts` is true, an RFC-1918 private-range IPv4 LITERAL host
   * (10/8, 172.16/12, 192.168/16 — octet-parsed in net-guards.ts) that the user
   * approved into the frozen host ceiling becomes reachable: gate 4 additionally
   * admits `http:` for that class and gate 5's private-range refusal stands down for
   * it. NEVER exempted, regardless of policy: loopback, link-local, `localhost`,
   * `.local`/`.internal` names, DNS names of any kind, and IPv6 in every form (the
   * policy covers IPv4 literals only — Hue-class devices are IPv4; IPv6 ULA stays
   * refused for now). Absent or false = today's browser profile, byte-identical.
   * This is a TRANSPORT-scheme choice over a reviewed host class, not a strictness
   * flag: gates 1–3 and 6–10 never read it.
   */
  transportPolicy?: { allowHttpForPrivateHosts: boolean };
  /**
   * AUTH-SHAPED FAILURE OBSERVER (ADR-0022 §4, P0 amendment 8) — host-only. Fires when
   * the FINAL delivered result of `execute()` is a 401/403 AND this executor injected
   * credentials into that request (header or query). The app-visible result is
   * untouched — `ok:true`, status as-is; apps legitimately read 401 bodies — so this
   * seat is how the host learns "the provider rejected the stored credential" without
   * breaking the app contract.
   *
   * Carries `(slot, status, detail?)` and NOTHING else: no credentials, no URL, and no
   * raw response bytes. `detail` (TASK-20260815 AC4, ADR-0028 era) is a SHORT extract of
   * the provider's own error reason — read from the DELIVERED body only (already
   * scrubbed with the full candidate set and 1 MiB-capped at gate 10, never the raw
   * `Response`), recognized JSON error shapes or a plain-text head, hard-capped at 160
   * chars, absent for HTML/unrecognized bodies. It exists because the banner's guess
   * copy ("the key may be wrong, expired, or revoked") misdiagnosed the Spotify
   * scope-less 403; the provider names the actual reason ("Insufficient client scope" /
   * "User not registered in the Developer Dashboard"). The `appId` is the caller's own
   * execute() argument, so the playground layer adds it when it forwards to the RunView
   * banner (the deps-level adaptation is journaled).
   *
   * NOT a retry hook: a 401 cured by the transparent OAuth refresh retry fires nothing
   * (only the delivered result counts), and `executeConnectionTestRequest` suppresses
   * the seat entirely — probe outcomes render in the wizard, not as a banner.
   */
  onAuthShapedFailure?: (slot: string, status: number, detail?: string) => void;
}

/**
 * P3 (fold B1's named exit): the v3 `snug_auth_specs` reader is GONE and the deps are a
 * plain object again. The discriminated union that used to live here existed only to let
 * one executor serve both eras during the cutover; with the last v3 consumer rewired,
 * keeping it would preserve a second grant path that nothing can reach but that every
 * future reader of this file would have to reason about.
 */
export type ConnectedFetchDeps = ConnectedFetchBaseDeps & { connectionReader: NetConnectionReader };

export interface ConnectedFetch {
  /** `appId` is the HOST-assigned binding (R5) — never anything the app claimed. */
  execute(appId: string, input: NetRequestInput): Promise<ConnectedFetchResult>;
}

// -------------------------------------------------------------------- internals

/**
 * Per-request wall clock. 60 s, raised from 15 s on the owner's first real SimpleFIN
 * walk (TASK-20260818): an aggregate provider's first wide-range read (13 months of
 * transactions, the bridge gathering from institutions) legitimately outlives 15 s,
 * and the abort surfaced as the transport's own noise ("Request canceled"). Still a
 * BOUND, deliberately — a hung provider must never hold the executor open forever —
 * and overridable per DEPS (host policy), never per request or per requirement:
 * a timeout an app could set is a timeout an app can effectively disable.
 */
const REQUEST_TIMEOUT_MS = 60_000;
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
 * The ONE spelling of each approval-state refusal (Gate-5 reuse finding): the literal
 * path's zero-match arm and ADR-0026's symbolic pre-check refuse the SAME conditions,
 * and two hand-rolled copies of the sentence (or a dropped IMPORTED arm — the live
 * divergence the review caught) would show the same app two different remedies for one
 * state depending on how it spelled the URL.
 */
const notApprovedFailure = (providerName?: string): ConnectedFetchResult =>
  failure(
    NET_ERROR_CODES.NET_NOT_APPROVED,
    providerName === undefined
      ? 'no approved connection covers this request'
      : `no approved connection covers this request — connect ${providerName} to continue`,
  );

const importedUnapprovedFailure = (): ConnectedFetchResult =>
  failure(
    NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
    'this connection arrived via import/sync — re-approve it in settings before the app can use it',
  );

/**
 * The TOFU pin's shape: 64 lowercase hex characters — a SHA-256 over the leaf
 * certificate's DER, as `lan_fetch`'s `fingerprint_der` produces it.
 *
 * A DELIBERATE RESTATEMENT of the Rust `valid_fingerprint`, for the same reason
 * `isPrivateRfc1918Ipv4Literal` restates protocol's rule: this is the other side
 * of an IPC boundary and the two cannot share code. Checking it HERE as well as
 * there is not redundancy — it is the difference between a named refusal at the
 * seam that knows what the value is for, and an unexplained handshake failure
 * two layers down that reads like a broken device.
 */
function isLanPinShape(fingerprint: string): boolean {
  return /^[0-9a-f]{64}$/.test(fingerprint);
}

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
export class SlotScopedCredentialStore implements CredentialStore {
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
export function requirementToSpec(requirement: ConnectionRequirement): AuthSpec | null {
  if (requirement.kind === 'none') return null;
  const provider = { name: requirement.provider.name };
  const fields = requirement.fields ?? [];
  // The frozen ceiling is enforced from `row.allowedHosts`; the spec copy exists only
  // because the shipped schemas require the seat.
  //
  // `?? []` since ADR-0023: a LAN-class requirement whose bridge address has not been
  // collected yet carries NO `declaredApiHosts` (the required-XOR-`lanHost` rule). An
  // empty list here is honest and inert — the v3 spec dialect's seat is filled with the
  // empty set, and every host decision downstream reads `row.allowedHosts`, which for
  // such a row is also empty and therefore refuses.
  const declaredApiHosts = [...(requirement.declaredApiHosts ?? [])];
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
  // `?? []` since ADR-0023: a pre-collection LAN row has neither a frozen ceiling nor a
  // declared host, so the CTA falls back to naming no host — which is the truth about
  // that row. This value still never gates a request.
  return row.allowedHosts.length > 0 ? row.allowedHosts : (row.requirement.declaredApiHosts ?? []);
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

  /**
   * The era-neutral view the injection path consumes. Both readers collapse to this, so
   * gates 5–10 are ONE code path rather than two — a v4-only duplicate of the scrub, the
   * redirect block or the size cap is exactly how a guarantee silently stops applying to
   * half the traffic.
   */
  interface ResolvedGrant {
    /** null for kind 'none' — nothing to inject (Q6). */
    spec: AuthSpec | null;
    /** The matched row's slot — the observer's identity seat (ADR-0022 §4). */
    slot: string;
    /**
     * The APPROVED requirement's `request` block, read for the template seats
     * (headerTemplate + queryTemplate). Sourced from the requirement rather than the
     * spec projection because the v3 `AuthRequest` dialect predates `queryTemplate` —
     * same bytes, honestly typed. Absent for kind 'none' (schema coherence forbids it).
     */
    requestSeat?: ConnectionRequest;
    allowedHosts: readonly string[];
    store: CredentialStore;
    oauth: OAuthService;
  }

  /**
   * GATE 9a — resolve the LAN pinned transport for a request the earlier gates
   * have already established is bound for an RFC-1918 IPv4 literal inside this
   * connection's frozen ceiling (ADR-0023 D3; P0 amendment 6).
   *
   * BOTH REFUSALS HERE ARE THE POINT, and neither is a fallback:
   *
   *   1. NO `lanFetch` DEP. This is the web profile (or a desktop build that
   *      failed to wire the seam). The tidy-looking `deps.lanFetch ??
   *      deps.fetchImpl` would send the request through a transport that
   *      verifies against the PUBLIC root store — which for a bridge means an
   *      opaque TLS failure the user cannot act on, and for anything else on
   *      that address means succeeding against a device that is not theirs. A
   *      named refusal is the honest answer, and it names the platform so the
   *      wizard's disclosure copy and this message agree.
   *
   *   2. NO RECORDED PIN (or a malformed one). Pair mode — accept-and-capture —
   *      is a WIZARD STEP the user consents to by pressing a physical button on
   *      the device. Falling back to it at request time would turn every
   *      unpaired request into a silent trust-anything call, which is the
   *      accept-invalid-certs flag this whole design exists to avoid. The pin's
   *      SHAPE is re-validated here rather than trusted from storage: a
   *      corrupted KV must fail loudly at this seam, not as a mystifying
   *      handshake error two layers down.
   *
   * The pin comes from the grant's own slot-scoped `_connection` KV (ADR-0014
   * custody), so it is per-connection by construction — there is no path by
   * which one connection's pin could serve another's request.
   */
  async function resolveLanTransport(
    lanFetch: LanFetchLike | undefined,
    grant: ResolvedGrant,
    appId: string,
  ): Promise<
    | { ok: true; send: (url: string, init: RequestInit) => Promise<Response> }
    | { ok: false; failure: ConnectedFetchResult }
  > {
    if (lanFetch === undefined) {
      return {
        ok: false,
        failure: failure(
          NET_ERROR_CODES.NET_AUTH_FAILED,
          'this connection is a device on your local network, which only the desktop app can reach',
        ),
      };
    }
    const state = await grant.store.getConnectionState(appId);
    const fingerprint = state?.lanPin?.fingerprint;
    if (fingerprint === undefined || !isLanPinShape(fingerprint)) {
      return {
        ok: false,
        failure: failure(
          NET_ERROR_CODES.NET_AUTH_FAILED,
          'this device has not been paired yet — open the connection and pair with it before apps can reach it',
        ),
      };
    }
    return { ok: true, send: (url, init) => lanFetch(url, init, fingerprint) };
  }

  /** What gate 8 injects: headers ride the fetch init; query params join the OUTBOUND URL only. */
  interface InjectedCredentials {
    headers: Record<string, string>;
    query: Record<string, string>;
  }

  const NOTHING_INJECTED: InjectedCredentials = { headers: {}, query: {} };

  async function resolveInjectedCredentials(
    appId: string,
    grant: ResolvedGrant,
    request: { method: string; url: string; body?: string },
    forceRefresh: boolean,
  ): Promise<InjectedCredentials> {
    const spec = grant.spec;
    // Q6 — kind 'none': the keyless provider. Injects NOTHING. Approval and the frozen
    // host ceiling still gated this request upstream; "no credential" never means "no
    // gate", which is why `none` is a connection row at all rather than the absence of one.
    if (spec === null) return NOTHING_INJECTED;
    if (spec.kind === 'oauth2_auth_code') {
      const scope = { appId, spec, allowedHosts: grant.allowedHosts };
      const token = forceRefresh ? await grant.oauth.refresh(scope) : await grant.oauth.getAccessToken(scope);
      return { headers: { Authorization: `Bearer ${token}` }, query: {} };
    }
    if (spec.kind === 'oauth2_client_creds') {
      const scope = { appId, spec, allowedHosts: grant.allowedHosts };
      const token = forceRefresh
        ? await grant.oauth.refreshClientCreds(scope)
        : await grant.oauth.getClientCredsAccessToken(scope);
      return { headers: { Authorization: `Bearer ${token}` }, query: {} };
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
    const requestSeat = grant.requestSeat;
    if (requestSeat?.headerTemplate !== undefined || requestSeat?.queryTemplate !== undefined) {
      // Lint against the spec's DECLARED field keys, not the keys actually loaded above.
      // The two differ whenever an optional field has no stored value: `fields` would be
      // missing that key. Linting the declaration here is both stricter in the case that
      // matters — a key naming nothing in the spec is rejected even if a same-named value
      // happened to be loaded — and kinder in the case that does not.
      //
      // The SAME list is handed to the render seat as `declaredFieldKeys`. That is the
      // whole fix for the shipped optional-field defect: this lint and the engine's own
      // lint used to consult different lists, so a template naming a blank `required:
      // false` field passed here and was rejected there, and the connection reported
      // CONNECTED while every request failed closed. One key source, checked twice —
      // and since ADR-0022 §3 the ONE list drives BOTH template seats (header + query),
      // which the render seat re-lints and renders through a single shared RenderState.
      const declaredFieldKeys = spec.fields.map((field) => field.key);
      if (requestSeat.headerTemplate !== undefined) {
        assertLintedTemplate(requestSeat.headerTemplate, { fieldKeys: declaredFieldKeys });
      }
      if (requestSeat.queryTemplate !== undefined) {
        assertLintedTemplate(requestSeat.queryTemplate, { fieldKeys: declaredFieldKeys });
      }
      return renderAuthRequestTemplates(requestSeat, {
        fields,
        declaredFieldKeys,
        request: { method: request.method, url: request.url, ...(request.body !== undefined ? { body: request.body } : {}) },
      });
    }
    // Kind defaults, ported from the source system (browser-safe base64 for Basic).
    // A request seat carrying EITHER template suppresses these entirely: a provider that
    // places its credential in the query must not ALSO receive the generic header
    // (AC6 — "in the query, not as X-Api-Key").
    switch (spec.kind) {
      case 'bearer_token':
        return { headers: { Authorization: `Bearer ${fields[spec.fields[0]!.key] ?? ''}` }, query: {} };
      case 'basic_auth': {
        const user = fields[spec.fields[0]!.key] ?? '';
        const pass = fields[spec.fields[1]!.key] ?? '';
        return { headers: { Authorization: `Basic ${utf8ToBase64(`${user}:${pass}`)}` }, query: {} };
      }
      case 'api_key':
        return { headers: { 'X-Api-Key': fields[spec.fields[0]!.key] ?? '' }, query: {} };
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
    /**
     * ADR-0026 §2 — the symbolic path threads its OWN rows read through here (one read
     * decides both resolution and injection; a second read would be a TOCTOU seam
     * between the row that resolved and the row that injects) and supplies a
     * HOST-CLEAN label for refusal copy (§3: on that path the host is the user's
     * private fact). The literal path passes neither and behaves byte-identically.
     */
    preset?: { rows: readonly NetConnectionRow[]; hostLabel: string },
  ): Promise<{ ok: true; grant: ResolvedGrant } | { ok: false; failure: ConnectedFetchResult }> {
    const rows = preset?.rows ?? (await deps.connectionReader.listConnections(appId));
    const hostLabel = preset?.hostLabel ?? `'${host}'`;
    const resolution = resolveSlot(rows, host);

    if (resolution.kind === 'ambiguous') {
      // Refused BEFORE any credential read — the whole point. The message names the
      // CONFLICTING SLOTS (build-time identifiers the user already sees in Settings) and
      // never a field key, a provider secret or a stored value (C5).
      return {
        ok: false,
        failure: failure(
          NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION,
          `two approved connections (${resolution.slots.join(', ')}) both claim ${hostLabel} — refusing to guess which credential to send`,
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
        return { ok: false, failure: importedUnapprovedFailure() };
      }
      return { ok: false, failure: notApprovedFailure(resolution.declaredProvider) };
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
        slot: row.slot,
        // Kind 'none' cannot carry a request block (schema coherence); reading it off the
        // APPROVED requirement keeps the same no-pending-read discipline as the spec.
        ...(row.requirement.kind !== 'none' && row.requirement.request !== undefined
          ? { requestSeat: row.requirement.request }
          : {}),
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

      // ADR-0026 — CONNECTION-RELATIVE ADDRESSING. Resolution sits AFTER gate 1 (the
      // shape/size bounds must precede any DB read) and BEFORE the URL gates, so every
      // gate below sees the RESOLVED url and resolution GRANTS nothing — it only
      // translates a slot the app already declared into the ceiling host the user
      // already approved. On this path the resolved host is the USER's private fact:
      // refusal copy here is host-clean, gate 5's message branches, and transport
      // errors scrub the resolved forms (§3). The rows read here is threaded into
      // `resolveGrant` below — ONE read decides both resolution and injection, and
      // re-running `resolveGrant` on the resolved host is what keeps same-row
      // injection structural: the resolving slot's approved row must be among the host
      // matches, so a unique match IS that row, and two matches refuse fail-closed
      // (the slot name selects a ceiling to translate through, never a
      // credential-routing tiebreak).
      let requestUrl = input.url;
      let symbolic: { slot: string; rows: readonly NetConnectionRow[]; ceilingHost: string } | undefined;
      // The parser sees the SAME normalization WHATWG `new URL` applies (strip
      // tab/newline anywhere, trim edges) — otherwise ' snug-connection://x/y' is
      // classified not-connection-url here, falls through to the literal path, parses
      // as the snug-connection scheme after URL's own stripping, and dies three gates
      // later as a mystifying scheme-block instead of the malformed refusal the
      // grammar promises (Gate-5 finding). The literal path is untouched: it keeps
      // `input.url`, which `new URL` normalizes identically itself.
      const connectionUrl = parseConnectionUrl(input.url.trim().replace(/[\t\n\r]/g, ''));
      if (!connectionUrl.ok && connectionUrl.reason === 'malformed') {
        return failure(
          NET_ERROR_CODES.NET_INVALID_REQUEST,
          'malformed connection url — the shape is snug-connection://<slot>/<path>',
        );
      }
      if (connectionUrl.ok) {
        const rows = await deps.connectionReader.listConnections(appId);
        const row = rows.find((candidate) => candidate.slot === connectionUrl.slot);
        if (row === undefined) {
          return failure(
            NET_ERROR_CODES.NET_INVALID_REQUEST,
            `this app declares no connection named '${connectionUrl.slot}'`,
          );
        }
        if (row.status !== CONNECTION_STATUS.approved) {
          // The SAME classification the literal path's zero-match arm applies — an
          // imported row keeps its distinct code and its "re-approve" remedy on the
          // symbolic path too (Gate-5 reuse finding: the first draft dropped this arm).
          return row.imported === true ? importedUnapprovedFailure() : notApprovedFailure(row.requirement.provider.name);
        }
        if (row.allowedHosts.length !== 1) {
          return failure(
            NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION,
            `the '${connectionUrl.slot}' connection does not resolve to exactly one host — a symbolic address must have one meaning`,
          );
        }
        const ceilingHost = row.allowedHosts[0]!;
        // `new URL(path, base)`, never concatenation — the same discipline
        // `executeConnectionTestRequest` documents: under concatenation a smuggled
        // `//evil.example/x` resolves to a NEW host, while base-resolution keeps the
        // authority and lets the canonical guard below fail closed for free. The
        // parser's grammar already refuses the known shapes; this makes the unknown
        // ones refuse too.
        try {
          requestUrl = new URL(connectionUrl.pathAndQuery, `https://${ceilingHost}`).href;
        } catch {
          return failure(
            NET_ERROR_CODES.NET_INVALID_REQUEST,
            'the connection url path did not resolve cleanly — check the path',
          );
        }
        symbolic = { slot: connectionUrl.slot, rows, ceilingHost };
      }

      let url: URL;
      try {
        url = new URL(requestUrl);
      } catch {
        return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'url does not parse');
      }
      if (url.username !== '' || url.password !== '') {
        return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'urls with embedded credentials are not allowed');
      }
      const host = url.hostname;
      // ADR-0026 normalization guard (defense in depth under the parser's grammar): the
      // resolved URL's host must still be the ceiling host it was built from, compared
      // CANONICALLY (`new URL` lowercases and punycodes). Host-clean by construction —
      // the message names the PATH as the problem, because it is.
      if (symbolic !== undefined && !isHostAllowed(host, [symbolic.ceilingHost])) {
        return failure(
          NET_ERROR_CODES.NET_INVALID_REQUEST,
          'the connection url path did not resolve cleanly — check the path',
        );
      }
      // Decision 6 — the ONLY reads of the transport policy. `lanPrivateHost` names the
      // one host class the desktop profile treats differently; computing it once keeps
      // gates 4 and 5 exempting EXACTLY the same requests (a drift between the two would
      // either strand the admission at gate 5 or stand the SSRF guard down for a class
      // gate 4 never admitted).
      const lanPrivateHost =
        deps.transportPolicy?.allowHttpForPrivateHosts === true && isPrivateRfc1918Ipv4Literal(host);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && lanPrivateHost)) {
        return failure(NET_ERROR_CODES.NET_SCHEME_BLOCKED, 'only https requests are allowed — no exceptions');
      }

      // Gates 2+3 — host-assigned binding (R5); the grant must exist, be approved, and
      // (v4) be the UNIQUE approved grant claiming this host.
      const resolved = await resolveGrant(
        appId,
        host,
        symbolic !== undefined
          ? { rows: symbolic.rows, hostLabel: `the '${symbolic.slot}' connection's device` }
          : undefined,
      );
      if (!resolved.ok) return resolved.failure;
      const grant = resolved.grant;

      /**
       * The sidecar send. Injection happens HERE because this path skips the network
       * pipeline below — and skipping it must never mean skipping C1: the helper requires
       * the minted token on every route, and the app must never see it.
       */
      async function sendViaSidecar(): Promise<ConnectedFetchResult> {
        if (deps.sidecarFetch === undefined) {
          // A refusal, never `?? deps.fetchImpl`. The fallback would send a credentialed
          // request down a transport nobody approved, and on the web it would hand the
          // attempt to a DNS resolver.
          return failure(
            NET_ERROR_CODES.NET_FETCH_FAILED,
            'the WhatsApp helper is only reachable from the Snug desktop app',
            false,
          );
        }
        let injected: InjectedCredentials;
        try {
          injected = await resolveInjectedCredentials(
            appId,
            grant,
            { method, url: url.href, ...(input.body !== undefined ? { body: input.body } : {}) },
            false,
          );
        } catch (err) {
          if (err instanceof SnugAuthError) {
            return failure(NET_ERROR_CODES.NET_AUTH_FAILED, `${err.message} (${err.code})`);
          }
          if (err instanceof AuthTemplateError || err instanceof AuthTemplateLintError) {
            return failure(NET_ERROR_CODES.NET_AUTH_FAILED, err.message);
          }
          throw err;
        }
        // App-supplied credential-shaped headers are stripped exactly as gate 7 does; the
        // injected ones win, and the app never contributes an authorization header.
        const headers = { ...stripCredentialShapedHeaders(input.headers ?? {}), ...injected.headers };
        try {
          const answered = await deps.sidecarFetch(
            method,
            `${url.pathname}${url.search}`,
            input.body,
            headers,
          );
          const scrubbed = scrubAuthValues(answered.body, {
            ...Object.fromEntries(Object.entries(injected.headers).map(([k, v]) => [`hdr:${k}`, v])),
          });
          return {
            ok: true,
            status: answered.status,
            headers: { 'content-type': 'application/json' },
            body: scrubbed,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return failure(NET_ERROR_CODES.NET_FETCH_FAILED, `the WhatsApp helper did not answer: ${message}`, true);
        }
      }

      // Gate 5a — THE SIDECAR CLASS (ADR-0032), decided BEFORE the SSRF guard.
      //
      // `isForbiddenNetHost` refuses `.localhost` — correctly, and that refusal is left
      // untouched, because it exists to stop a NETWORK request reaching a local service. This
      // host is never dialled at all: the helper listens on a unix socket, and
      // `whatsapp.sidecar.localhost` is an IDENTITY the frozen ceiling can hold (hosts are
      // the ceiling's unit) rather than an address. RFC 6761 reserves `.localhost` precisely
      // so it can never resolve publicly.
      //
      // Everything that protects the USER has already run above: the row is approved, the
      // host is within the frozen ceiling, and the mutating-confirm gate has answered. What
      // is skipped below is only the machinery for choosing and hardening a NETWORK
      // transport, which has nothing to decide when there is no network involved.
      if (host === SIDECAR_SYMBOLIC_HOST) {
        return await sendViaSidecar();
      }

      // Gate 5 — SSRF literal guard (defense in depth: runs even for ceiling members).
      // The desktop policy stands this gate down for exactly the RFC-1918 IPv4-literal
      // class computed above: such a host is forbidden for no reason BEYOND being
      // private, and the frozen ceiling (gates 2+3) has already vouched for it.
      // Loopback/link-local/names are outside that class and still refuse here.
      // ADR-0026 §3: the symbolic branch is HOST-CLEAN — on that path this message
      // reaches an app that must never learn the resolved address, and on web (no
      // transport policy) this is exactly where a resolved LAN host lands.
      if (!lanPrivateHost && isForbiddenNetHost(host)) {
        return failure(
          NET_ERROR_CODES.NET_SSRF_BLOCKED,
          symbolic !== undefined
            ? 'this connection resolves to an address on your local network, which this platform cannot reach'
            : `host '${host}' is a private/loopback target`,
        );
      }

      // Gate 6 — mutating methods need the user's confirmation BEFORE credentials move.
      //
      // `slot` and `body` ride along for gates that must decide on WHAT is being sent, not
      // only where (ADR-0033's standing gate derives a chat thread from them). Both are
      // optional and the session gate ignores them, so this is additive: on the absolute-URL
      // path — which is how the wizard's probe arrives — `slot` is simply absent, and that
      // absence is what keeps a standing grant off the probe.
      if (method !== 'GET' && method !== 'HEAD') {
        const granted = await deps.confirmGate.confirm({
          appId,
          host,
          method,
          url: url.href,
          ...(symbolic !== undefined ? { slot: symbolic.slot } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        if (granted !== true) {
          return failure(NET_ERROR_CODES.NET_CONFIRM_DENIED, `the user declined this ${method} request`);
        }
      }

      // Gate 7 — app-supplied credential-shaped headers are ALWAYS stripped (C1).
      const appHeaders = stripCredentialShapedHeaders(input.headers ?? {});

      // Whether the DELIVERED result rode injected credentials — the observer's gate.
      // Written by every performFetch pass; the retry pass injects the same way, so the
      // last write always describes the delivered result.
      let credentialsInjected = false;

      const performFetch = async (forceRefresh: boolean): Promise<ConnectedFetchResult> => {
        // Gate 8 — injection (per kind; OAuth paths are ceiling-checked internally, N2b).
        let injected: InjectedCredentials;
        try {
          injected = await resolveInjectedCredentials(appId, grant, { method, url: url.href, ...(body !== undefined ? { body } : {}) }, forceRefresh);
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

        credentialsInjected = Object.keys(injected.headers).length > 0 || Object.keys(injected.query).length > 0;

        // THE SCRUB CANDIDATE SET (ADR-0022 §3, P0 amendment 14) — every value this pass
        // injected, header AND query. Rendered query values are credentials in a URL, so
        // every site below that scrubs header values scrubs them too. The `query:` key
        // prefix only prevents a header/query NAME collision from dropping a candidate;
        // the scrubber reads values, never keys.
        const scrubCandidates: Record<string, string> = { ...injected.headers };
        for (const [key, value] of Object.entries(injected.query)) {
          scrubCandidates[`query:${key}`] = value;
          // BOTH FORMS, derived from the serializer that actually writes the URL (P6
          // whole-surface finding F1). `searchParams.set` percent-encodes, and
          // `scrubAuthValues` is exact-substring — so a raw-only candidate misses the
          // encoded spelling that is what an error message or an echoed body actually
          // contains. A credential with `+`, `/`, `=` or a space (i.e. any base64 key)
          // leaked verbatim. The encoded candidate is built with URLSearchParams itself
          // rather than encodeURIComponent because the two disagree on space (`+` vs
          // `%20`), and a hand-rolled encoder is how this drifts back apart.
          const encoded = new URLSearchParams({ [key]: value }).toString().slice(key.length + 1);
          if (encoded !== value) scrubCandidates[`query:${key}:encoded`] = encoded;
        }

        // QUERY INJECTION — into the OUTBOUND URL only, and only HERE, after every gate:
        // the ceiling/host/SSRF gates matched on the app's own URL, the confirm gate
        // captured `url.href` BEFORE this line (the user confirms the request the app
        // asked for, never a URL carrying their credential), and no result field ever
        // echoes `outboundHref`.
        let outboundHref = url.href;
        if (Object.keys(injected.query).length > 0) {
          const outbound = new URL(url.href);
          for (const [key, value] of Object.entries(injected.query)) outbound.searchParams.set(key, value);
          outboundHref = outbound.href;
        }

        // Gate 9 — the fetch itself: injected headers win over app headers; redirects
        // are returned, never followed.
        const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const init: RequestInit = {
          method,
          headers: { ...appHeaders, ...injected.headers },
          ...(body !== undefined ? { body } : {}),
          redirect: 'manual',
          signal: timeoutSignal,
        };

        // GATE 9a — TRANSPORT SELECTION (ADR-0023 D3; P0 amendment 6). The
        // decision is made HERE, not in the platform, because it is a statement
        // about the frozen ceiling and the ceiling is only knowable at this
        // altitude: `lanPrivateHost` above already established that this host is
        // an RFC-1918 IPv4 literal under a desktop policy, and gates 2+3 already
        // established that it is inside the approved ceiling. A platform-level
        // router would have to re-derive both and could drift from them.
        //
        // WHY THE SCHEME IS PART OF THE CONDITION, and not an afterthought.
        // ADR-0021 Decision 4 opened this rung for `http(s)` to private literals,
        // and ADR-0023's alternatives section keeps it: "ADR-0021's
        // http-for-private-literals rung remains for other LAN device classes."
        // A plain-http device has NO certificate, so it can never have a pin —
        // routing it here would refuse it forever, silently retiring a shipped
        // rung. The pinned transport is what an HTTPS LAN host needs and the
        // only thing it can use; `http` keeps today's path byte-identically.
        // (The Rust command refuses non-https independently, so this is the
        // near side of a guard that exists on both.)
        //
        // Note what this DOESN'T do: there is no `deps.lanFetch ?? deps.fetchImpl`
        // and no `pin ?? pair-mode`. Each absence is a refusal (see
        // `resolveLanTransport`), because both fallbacks silently substitute a
        // different trust decision for the one the user consented to.
        let response: Response;
        try {
          if (lanPrivateHost && url.protocol === 'https:') {
            const lan = await resolveLanTransport(deps.lanFetch, grant, appId);
            if (!lan.ok) return lan.failure;
            response = await lan.send(outboundHref, init);
          } else {
            response = await deps.fetchImpl(outboundHref, init);
          }
        } catch (err) {
          // THE TIMEOUT NAMES ITSELF (TASK-20260818, owner report): every transport
          // spells an armed-signal abort differently (DOMException TimeoutError in a
          // browser, "Request canceled" from the tauri plugin's Rust half), and the
          // transport's spelling reaches the user as noise pointing nowhere. The
          // executor ARMED the signal, so the executor owns the sentence.
          if (timeoutSignal.aborted) {
            return failure(
              NET_ERROR_CODES.NET_FETCH_FAILED,
              `the provider did not answer within ${Math.round(timeoutMs / 1000)}s — it may be busy gathering data; try again in a moment`,
              true,
            );
          }
          const message = err instanceof Error ? err.message : String(err);
          // Scrubbed with the FULL candidate set (amendment 14): fetch errors routinely
          // embed the request URL — query string included — and this message reaches
          // the app. On the symbolic path the RESOLVED host and href join the set
          // (ADR-0026 §3) — ERROR-ONLY candidates, deliberately: the response-body
          // scrub below excludes them, because a device echoing its own address in a
          // payload is the provider's data surface, not a host-side disclosure, and
          // redacting private-IP shapes out of JSON would corrupt legitimate payloads.
          const errorScrub =
            symbolic === undefined
              ? scrubCandidates
              : { ...scrubCandidates, 'resolved:host': symbolic.ceilingHost, 'resolved:href': outboundHref };
          return failure(NET_ERROR_CODES.NET_FETCH_FAILED, `request failed: ${scrubAuthValues(message, errorScrub)}`, true);
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
            headers[name.toLowerCase()] = scrubAuthValues(value, scrubCandidates);
          }
        });
        return { ok: true, status: response.status, headers, body: scrubAuthValues(read.body, scrubCandidates) };
      };

      /**
       * THE ONE DELIVERY SEAT (ADR-0022 §4, amendment 8). Every result leaves execute()
       * through here, so "fires only on the FINAL delivered result" is true by
       * construction: a 401 cured by the refresh retry never reaches this function as
       * the delivered value, and an uncured one reaches it exactly once. A SUCCESS is
       * returned untouched — the observer is a side channel, never a remap.
       *
       * ADR-0026 §3, enforced STRUCTURALLY (Gate-5 altitude finding): on the symbolic
       * path, every FAILURE message is scrubbed of the resolved host and href here —
       * one seat, all messages — so a future gate or edited sentence that forgets to
       * branch on `symbolic` still cannot hand the app the user's private address.
       * The branched host-clean copy upstream remains the primary (better sentences);
       * this is the backstop that makes the boundary hold by construction. Response
       * BODIES are untouched (ok results pass through) — the provider's data surface.
       */
      const deliver = (result: ConnectedFetchResult): ConnectedFetchResult => {
        if (
          result.ok &&
          (result.status === 401 || result.status === 403) &&
          credentialsInjected &&
          deps.onAuthShapedFailure !== undefined
        ) {
          // The detail reads the DELIVERED body — scrubbed and capped at gate 10 — never
          // the raw Response (`scrubCandidates` is performFetch-local by design), and
          // only when someone is LISTENING: the wizard probe strips the seat, so its
          // 401/403 outcomes must not pay for an extraction nobody reads. A 2-arg call
          // when no detail exists keeps empty-body behavior byte-identical.
          const detail = extractAuthFailureDetail(result.body);
          if (detail !== undefined) {
            deps.onAuthShapedFailure(grant.slot, result.status, detail);
          } else {
            deps.onAuthShapedFailure(grant.slot, result.status);
          }
        }
        if (!result.ok && symbolic !== undefined) {
          return {
            ...result,
            message: scrubAuthValues(result.message, {
              'resolved:host': symbolic.ceilingHost,
              'resolved:href': url.href,
            }),
          };
        }
        return result;
      };

      const first = await performFetch(false);
      // OAuth 401 → one transparent refresh-and-retry (the token may be revoked or
      // stale beyond the skew window); static kinds surface the 401 as-is.
      const isOauthKind = grant.spec?.kind === 'oauth2_auth_code' || grant.spec?.kind === 'oauth2_client_creds';
      if (first.ok && first.status === 401 && isOauthKind) {
        try {
          const second = await performFetch(true);
          return deliver(second.ok ? second : first);
        } catch {
          return deliver(first);
        }
      }
      return deliver(first);
    },
  };
}

/** TASK-20260815 AC4: max chars of provider error text forwarded to the observer. */
const MAX_AUTH_FAILURE_DETAIL_CHARS = 160;

/**
 * Bodies above this size yield no detail at all. A real provider error envelope is a
 * few hundred bytes; the delivered body can be up to the 1 MiB gate-10 cap, and parsing
 * a megabyte of JSON to pull 160 chars on every credentialed 401/403 is work an
 * adversarial or verbose provider gets to bill us for (Gate-5 review, efficiency).
 */
const MAX_AUTH_FAILURE_BODY_CHARS = 8_192;

/**
 * Extract a short human-readable reason from an auth-shaped failure body.
 *
 * INPUT CONTRACT: the DELIVERED `result.body` — already scrubbed of every injected
 * credential form and 1 MiB-capped at gate 10. This function must never be handed raw
 * transport bytes; it adds bounding and shape-recognition, not scrubbing.
 *
 * Recognized shapes, in order: Spotify's `{"error":{"message":…}}`, RFC 6749
 * `error_description`, a bare `message` string, a bare `error` string. Everything
 * structured-but-unrecognized yields NOTHING — raw JSON in a banner is noise, not
 * diagnosis — and the Gate-5 review found the first cut leaking exactly that: a
 * MALFORMED `{` body (a >1 MiB JSON error truncated mid-token by gate 10 no longer
 * parses) fell through to the text head, and JSON ARRAYS (Hue CLIP v1 errors),
 * JSON strings and `)]}'`-guarded bodies skipped the JSON branch entirely. So: a `{`
 * body parses or yields nothing, and a body opening with `[`, `<`, `"` or `)` is
 * structure/markup, never prose. Plain text becomes the head, hard-capped — a
 * plain-text reason like "quota exceeded" is exactly the honesty the banner wants.
 */
function extractAuthFailureDetail(body: string): string | undefined {
  if (body.length > MAX_AUTH_FAILURE_BODY_CHARS) return undefined;
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  const cap = (text: string): string => text.slice(0, MAX_AUTH_FAILURE_DETAIL_CHARS);
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const error = parsed['error'];
      const candidates: unknown[] = [
        typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['message'] : undefined,
        parsed['error_description'],
        parsed['message'],
        typeof error === 'string' ? error : undefined,
      ];
      const hit = candidates.find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      );
      return hit !== undefined ? cap(hit.trim()) : undefined;
    } catch {
      // Malformed or truncated JSON: brace noise is not a diagnosis.
      return undefined;
    }
  }
  if ('[<")'.includes(trimmed[0]!)) return undefined;
  return cap(trimmed);
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
  // `?.[0]` since ADR-0023: a pre-collection LAN row has no declared host either, so
  // this resolves to undefined and the probe refuses below with NET_NOT_APPROVED —
  // the honest answer for a connection whose device address has not been collected.
  const baseHost = row.allowedHosts[0] ?? row.requirement.declaredApiHosts?.[0];
  if (baseHost === undefined) {
    return failure(NET_ERROR_CODES.NET_NOT_APPROVED, `connection '${slot}' has no approved host to probe`);
  }
  let probeUrl: string;
  try {
    probeUrl = new URL(testRequest.pathAndQuery, `https://${baseHost}`).href;
  } catch {
    return failure(NET_ERROR_CODES.NET_INVALID_REQUEST, 'the stored test request does not form a valid url');
  }

  // OBSERVER SUPPRESSED (ADR-0022 §4, amendment 8): a probe's whole outcome renders in
  // the wizard the user is already looking at — routing it through the banner seat too
  // would double-report every failed probe and let the wizard trigger RunView chrome.
  const { onAuthShapedFailure: _suppressedForProbe, ...probeDeps } = deps;
  return createConnectedFetch(probeDeps).execute(appId, { url: probeUrl, method: testRequest.method });
}
