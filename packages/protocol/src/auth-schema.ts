/**
 * Dynamic Auth spec schema — INTERNAL protocol surface (AL-02, plan D1).
 *
 * Ported from the two source systems (codenames OProject/IProject — C4):
 * OProject's five-kind discriminated union + `userLayer` embedding, IProject's
 * `.strict()` ingest posture. Persisted in the `snug_auth_specs` table
 * (userdb-schema.ts, schema v3) with credential VALUES under `snug_secrets`
 * `auth:` keys per ADR-0014 (local-first custody).
 *
 * PUBLICATION LINE (plan D1 / finding 9): these schemas are deliberately NOT in
 * `json-schemas.ts` SOURCES — that export set is the publishes-to-spec line and
 * auth stays out of it until the Beta exit gate. The shape is locked by the
 * in-package snapshot test instead.
 *
 * STRICTNESS SPLIT (finding 12): `.strict()` here applies at the RUNTIME
 * validation boundary — ingest fails closed (the db accessor and importUserDb
 * both parse with this schema). Any future PUBLISHED schema artifact follows
 * rule R2 forward-compat (`io: 'input'`, no `additionalProperties: false`) —
 * two artifacts, never conflated.
 *
 * @draft userLayer — two-layer runtime resolution deferred
 * (TWO_LAYER_RESOLUTION_DEFERRED); publication gated at Beta exit. The shape
 * ships so the OAuth loop can complete for two-layer specs (audit bug 1), but
 * runtime resolution beyond that loop stays deferred.
 */

import { z } from 'zod';

// ------------------------------------------------------------------ constants

/**
 * The five kind literals, pinned verbatim (plan D2). These are PERSISTED
 * discriminators shared with AL-03/AL-04 — never retype them.
 */
export const AUTH_KINDS = [
  'api_key',
  'bearer_token',
  'basic_auth',
  'oauth2_client_creds',
  'oauth2_auth_code',
] as const;

export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * `snug_auth_specs.status` values (plan N5) — exported constants, never
 * prose-only literals. AL-03 bars credential injection unless the row is
 * `approved`; imported/synced rows land as `imported_unapproved` until the user
 * re-approves them with the full frozen host list displayed.
 */
export const AUTH_SPEC_STATUS = {
  unapproved: 'unapproved',
  approved: 'approved',
  importedUnapproved: 'imported_unapproved',
} as const;

export const AUTH_SPEC_STATUSES = Object.values(AUTH_SPEC_STATUS);

export type AuthSpecStatus = (typeof AUTH_SPEC_STATUS)[keyof typeof AUTH_SPEC_STATUS];

/**
 * `snug_secrets` key namespace for every Dynamic Auth value (ADR-0014 clause 6):
 * `auth:<appId>:<field>` credential values, `auth:<appId>:_connection` dynamic
 * connection state, `auth:_flow:<flowId>` spilled pending-flow state, and
 * `auth:_state_hmac` (the per-user state-signing key, reused for nothing else).
 * Key BUILDERS live in @snugprotocol/db next to the secrets quartet.
 */
export const AUTH_SECRET_PREFIX = 'auth:';

// ------------------------------------------------------------ building blocks

const authFieldTypeSchema = z.enum(['text', 'secret', 'password', 'url']);
export type AuthFieldType = z.infer<typeof authFieldTypeSchema>;

export const authFieldSchema = z
  .strictObject({
    /** Stable key — matches headerTemplate placeholders and the `auth:<appId>:<key>` secret key. */
    key: z.string().min(1),
    /** Human-readable label shown by the wizard (AL-04). */
    label: z.string().min(1),
    /** Input type — drives masking + paste behavior. */
    type: authFieldTypeSchema,
    description: z.string().optional(),
    placeholder: z.string().optional(),
    /** True by default; false for genuinely optional fields. */
    required: z.boolean().optional(),
  });
export type AuthField = z.infer<typeof authFieldSchema>;

export const authProviderInfoSchema = z.strictObject({
  /** Display name of the third-party service ("Spotify", "Coinbase", …). */
  name: z.string().min(1),
  iconUrl: z.url().optional(),
  homepageUrl: z.url().optional(),
  docsUrl: z.url().optional(),
});
export type AuthProviderInfo = z.infer<typeof authProviderInfoSchema>;

export const authRegistrationSchema = z.strictObject({
  /** Where the user goes to register/find their credentials. */
  consoleUrl: z.url().optional(),
  /** Hand-authored numbered steps surfaced verbatim by the wizard. */
  instructions: z.array(z.string().min(1)).optional(),
});
export type AuthRegistration = z.infer<typeof authRegistrationSchema>;

/**
 * Optional request-shaping block for static kinds. Values may reference field
 * keys via `{{field_key}}` and the async template helpers (packages/auth).
 */
export const authRequestSchema = z.strictObject({
  headerTemplate: z.record(z.string(), z.string()).optional(),
});
export type AuthRequest = z.infer<typeof authRequestSchema>;

/**
 * `declaredApiHosts` (plan D2) — the API hosts the spec asks to call. One of
 * TWO named host objects that are never conflated: the OTHER is
 * `frozenAllowedHosts` (the `snug_auth_specs.allowed_hosts` column), computed
 * at approval as declared ∪ registry ∪ derived-OAuth-endpoint hosts (incl.
 * refreshUrl) and enforced at the db write boundary + the service outbound
 * ceiling.
 */
const declaredApiHostsRequired = z.array(z.string().min(1)).min(1);
const declaredApiHostsOptional = z.array(z.string().min(1)).optional();

// ------------------------------------------------------------ per-kind shapes

const oauth2AuthCodeShape = {
  kind: z.literal('oauth2_auth_code'),
  provider: authProviderInfoSchema,
  registration: authRegistrationSchema.optional(),
  endpoints: z.strictObject({
    authorizeUrl: z.url(),
    tokenUrl: z.url(),
    refreshUrl: z.url().optional(),
    revokeUrl: z.url().optional(),
  }),
  scopes: z.array(z.string()).optional(),
  /** PKCE defaults to true (public-client posture; ADR-0014 consequence). */
  pkce: z.boolean().optional(),
  /**
   * Extra authorize-URL query params, per-provider (plan D6): Google's
   * `access_type=offline&prompt=consent` lives HERE (copied from the registry
   * entry by the transformer), never hardcoded in the OAuth service.
   */
  authorizeParams: z.record(z.string(), z.string()).optional(),
  /** What the user pastes in (typically client_id + client_secret; BYO registration). */
  clientCreds: z.array(authFieldSchema).min(1),
  /**
   * Optional ONLY for this kind: may be empty/absent when the well-known
   * registry supplies `apiHosts` for the provider (the transformer enforces
   * that branch — plan D2); the derived union then still carries the OAuth
   * endpoint hosts.
   */
  declaredApiHosts: declaredApiHostsOptional,
};

export const oauth2AuthCodeSchema = z.strictObject(oauth2AuthCodeShape);
export type Oauth2AuthCodeSpec = z.infer<typeof oauth2AuthCodeSchema>;

/** @draft — runtime deferred (TWO_LAYER_RESOLUTION_DEFERRED); publication gated at Beta exit. */
const userLayer = oauth2AuthCodeSchema.optional();

export const oauth2ClientCredsSchema = z.strictObject({
  kind: z.literal('oauth2_client_creds'),
  provider: authProviderInfoSchema,
  registration: authRegistrationSchema.optional(),
  endpoints: z.strictObject({ tokenUrl: z.url() }),
  scopes: z.array(z.string()).optional(),
  clientCreds: z.array(authFieldSchema).min(1),
  declaredApiHosts: declaredApiHostsRequired,
  userLayer,
});
export type Oauth2ClientCredsSpec = z.infer<typeof oauth2ClientCredsSchema>;

export const bearerTokenSchema = z.strictObject({
  kind: z.literal('bearer_token'),
  provider: authProviderInfoSchema,
  registration: authRegistrationSchema.optional(),
  /** Single field by default ("token") — field[0].key is the bearer. */
  fields: z.array(authFieldSchema).min(1),
  request: authRequestSchema.optional(),
  declaredApiHosts: declaredApiHostsRequired,
  userLayer,
});
export type BearerTokenSpec = z.infer<typeof bearerTokenSchema>;

export const basicAuthSchema = z.strictObject({
  kind: z.literal('basic_auth'),
  provider: authProviderInfoSchema,
  registration: authRegistrationSchema.optional(),
  /** Two named fields — by convention `username` and `password`. */
  fields: z.array(authFieldSchema).length(2),
  request: authRequestSchema.optional(),
  declaredApiHosts: declaredApiHostsRequired,
  userLayer,
});
export type BasicAuthSpec = z.infer<typeof basicAuthSchema>;

export const apiKeySchema = z.strictObject({
  kind: z.literal('api_key'),
  provider: authProviderInfoSchema,
  registration: authRegistrationSchema.optional(),
  fields: z.array(authFieldSchema).min(1),
  request: authRequestSchema.optional(),
  declaredApiHosts: declaredApiHostsRequired,
  userLayer,
});
export type ApiKeySpec = z.infer<typeof apiKeySchema>;

// ------------------------------------------------------------------- hints

const hintEndpointsSchema = z
  .strictObject({
    authorizeUrl: z.url().optional(),
    tokenUrl: z.url().optional(),
    refreshUrl: z.url().optional(),
    revokeUrl: z.url().optional(),
  })
  .optional();

/**
 * The transformer-input HINTS shape (AL-04 plan D1/M8) — the single source of truth
 * for what `paramsToAuthSpec` consumes. `packages/auth` re-derives
 * `ParamsToAuthSpecInput` from THIS schema's inferred type (one definition, two
 * packages served; hand-maintained drift is a compile error). It obeys this module's
 * "persisted discriminators — never retype them" doctrine: field meanings match the
 * shipped transformer exactly, resolved toward SHIPPED runtime behavior (risk R7) —
 * e.g. `kindHint` stays an open string because the transformer owns the unknown-kind
 * failure, and URL slots strict-validate because every downstream consumer does.
 *
 * Hints are NOT a spec: the deterministic, fail-closed `paramsToAuthSpec` remains the
 * only spec builder. LLM-authored shapes derive from this via `llmProposalSchema`
 * (render-directive.ts), which OMITS registration copy + headerTemplate (M5).
 */
export const authSpecHintsSchema = z.strictObject({
  /** Auth kind. Open string — the transformer owns the unknown-kind failure. */
  kindHint: z.string().optional(),
  /** Provider display name. Required; also the well-known-registry lookup key. */
  providerName: z.string(),
  docsUrl: z.url().optional(),
  homepageUrl: z.url().optional(),
  /** Where the user goes to mint credentials — `registration.consoleUrl`. */
  registrationConsoleUrl: z.url().optional(),
  /** Plain-English numbered steps surfaced verbatim by the wizard. */
  registrationInstructions: z.array(z.string()).optional(),
  /** Field definitions the user must paste in; per-kind defaults apply when omitted. */
  fields: z.array(authFieldSchema).optional(),
  /** Non-standard header placement for static kinds (values may use `{{field_key}}`). */
  headerTemplate: z.record(z.string(), z.string()).optional(),
  /** The API hosts the spec asks to call. Per-kind rules live in the transformer. */
  declaredApiHosts: z.array(z.string()).optional(),
  /** OAuth endpoints. Registry defaults apply for well-known providers. */
  endpoints: hintEndpointsSchema,
  scopes: z.array(z.string()).optional(),
  pkce: z.boolean().optional(),
  /** @draft two-layer synthesis — runtime resolution deferred (TWO_LAYER_RESOLUTION_DEFERRED). */
  authMode: z.enum(['per_user', 'global', 'two_layer']).optional(),
  userLayerEndpoints: hintEndpointsSchema,
  userLayerScopes: z.array(z.string()).optional(),
  userLayerPkce: z.boolean().optional(),
  userLayerFields: z.array(authFieldSchema).optional(),
});
export type AuthSpecHints = z.infer<typeof authSpecHintsSchema>;

// ------------------------------------------------------------------ the union

export const authSpecSchema = z.discriminatedUnion('kind', [
  apiKeySchema,
  bearerTokenSchema,
  basicAuthSchema,
  oauth2ClientCredsSchema,
  oauth2AuthCodeSchema,
]);
export type AuthSpec = z.infer<typeof authSpecSchema>;

/** Org-eligible kinds — everything except the 3-legged user-redirect flow. */
export type OrgEligibleAuthSpec = ApiKeySpec | BearerTokenSpec | BasicAuthSpec | Oauth2ClientCredsSpec;

export function isOrgEligibleAuthSpec(spec: AuthSpec): spec is OrgEligibleAuthSpec {
  return spec.kind !== 'oauth2_auth_code';
}

/** Extract the embedded user layer (two-layer specs only). @draft — see module doc. */
export function getAuthUserLayer(spec: AuthSpec): Oauth2AuthCodeSpec | undefined {
  return isOrgEligibleAuthSpec(spec) ? spec.userLayer : undefined;
}

/**
 * The oauth2_auth_code layer an OAuth flow should run against: the spec itself
 * when it IS that kind, else the embedded `userLayer`. This is the audit bug-1
 * fix seam — the source system's callback never unwrapped the user layer, so
 * two-layer OAuth could start but never complete.
 */
export function resolveAuthCodeLayer(spec: AuthSpec): Oauth2AuthCodeSpec | undefined {
  return spec.kind === 'oauth2_auth_code' ? spec : getAuthUserLayer(spec);
}

/**
 * True when a failed strict parse failed ONLY on unknown keys — the import
 * boundary's R2 seam (plan D5/N1): an older hub must not destroy a newer hub's
 * additive data, so unknown-keys-only rows are demoted-and-preserved while
 * structurally unusable rows are dropped + surfaced.
 */
export function isAuthSpecUnknownKeysOnlyFailure(error: z.ZodError): boolean {
  return error.issues.length > 0 && error.issues.every((issue) => issue.code === 'unrecognized_keys');
}

// ------------------------------------------------------------- host functions

/**
 * Canonical host form: lowercase + IDNA toASCII (punycode) via the URL trick — AL-03
 * amendment B3. URL-derived hosts (`new URL().hostname`) come out punycoded, so
 * declared hosts MUST normalize the same way or a unicode declared host can never
 * match a real request host (the AL-02 merge-review asymmetry). Applied at STORE time
 * (deriveAuthAllowedHosts → new approvals freeze xn-- forms) AND at CHECK time on both
 * sides of every membership comparison, so pre-existing stored unicode entries still
 * match. Inputs smuggling more than a hostname (path/port/credentials/query/fragment)
 * fall back to the trimmed lowercase form, which can never equal a URL-derived
 * hostname — membership fails closed, as before the retrofit.
 */
export function normalizeAuthHost(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.length === 0 || lower.includes('/')) return lower;
  try {
    const url = new URL(`http://${lower}`);
    if (url.pathname === '/' && url.search === '' && url.hash === '' && url.port === '' && url.username === '' && url.password === '' && url.hostname.length > 0) {
      return url.hostname;
    }
  } catch {
    /* not a bare hostname — fall through to the fail-closed form */
  }
  return lower;
}

const hostOfUrl = (url: string): string | undefined => {
  try {
    return normalizeAuthHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
};

/**
 * The DERIVED HOST UNION (plan D2/N2): declaredApiHosts ∪ every OAuth endpoint
 * host — authorizeUrl, tokenUrl, **refreshUrl** (it receives long-lived
 * credentials), revokeUrl — including the embedded userLayer's endpoints and
 * declared hosts. Canonical output: sorted, unique, lowercase — so the frozen
 * `allowed_hosts` column is byte-comparable across devices (import
 * reconciliation identity, plan D5/N1).
 *
 * `frozenAllowedHosts` (the snug_auth_specs.allowed_hosts column) is this
 * union computed AT APPROVAL, displayed in full to the user, then frozen; the
 * runtime injection/refresh ceiling IS that frozen set.
 */
export function deriveAuthAllowedHosts(spec: AuthSpec): string[] {
  const hosts = new Set<string>();
  const addDeclared = (declared: readonly string[] | undefined): void => {
    for (const host of declared ?? []) hosts.add(normalizeAuthHost(host));
  };
  const addEndpoints = (urls: ReadonlyArray<string | undefined>): void => {
    for (const url of urls) {
      if (url === undefined) continue;
      const host = hostOfUrl(url);
      if (host !== undefined) hosts.add(host);
    }
  };

  addDeclared(spec.declaredApiHosts);
  if (spec.kind === 'oauth2_auth_code') {
    const e = spec.endpoints;
    addEndpoints([e.authorizeUrl, e.tokenUrl, e.refreshUrl, e.revokeUrl]);
  }
  if (spec.kind === 'oauth2_client_creds') {
    addEndpoints([spec.endpoints.tokenUrl]);
  }
  const layer = getAuthUserLayer(spec);
  if (layer !== undefined) {
    addDeclared(layer.declaredApiHosts);
    const e = layer.endpoints;
    addEndpoints([e.authorizeUrl, e.tokenUrl, e.refreshUrl, e.revokeUrl]);
  }
  return [...hosts].sort();
}

/** Set equality over host lists, case- and order-insensitive. */
export function hostSetEquals(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a.map(normalizeAuthHost));
  const setB = new Set(b.map(normalizeAuthHost));
  if (setA.size !== setB.size) return false;
  for (const host of setA) if (!setB.has(host)) return false;
  return true;
}
