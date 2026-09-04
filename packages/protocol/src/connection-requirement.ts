/**
 * Dynamic Auth v2 — `connectionRequirementSchema`, the RICHER, BOUNDED authoring
 * channel (TASK-20260810-p0-contracts, parent plan §4). INTERNAL protocol surface.
 *
 * WHY THIS EXISTS. `llmProposalSchema` (render-directive.ts:63–69) is
 * `authSpecHintsSchema.omit({registrationConsoleUrl, registrationInstructions,
 * headerTemplate, fields, userLayerFields})`. Those five omissions were the AL-04
 * answer to credential misdirection — an LLM that authors field LABELS dictates which
 * secret the user pastes — but they are also exactly the seats a Coinbase-shaped
 * requirement needs. So every static-kind proposal collapsed to the transformer's one
 * generic field: the owner's "Coinbase needs key + secret + passphrase" defect. This
 * schema re-admits those seats and pays for them a different way: BOUNDS at parse
 * (every string charset-guarded, every list capped, `strictObject` throughout), a
 * TEMPLATE LINT and a REGISTRY-BORROW BAN in packages/auth, and a strong
 * field-by-field review that renders every byte of this shape verbatim before any
 * credential is collected. The defense moved from "the channel cannot express it" to
 * "the user sees exactly what it expresses" — a deliberate trade recorded in ADR-0017.
 *
 * REQUIREMENT ≠ GRANT (parent plan §1). Everything here is credential-FREE: it says
 * what an app NEEDS, never what the user ALLOWED. `declaredApiHosts` is a REQUEST for
 * a host ceiling; the FROZEN ceiling is `snug_connections.allowed_hosts`, computed by
 * `deriveConnectionAllowedHosts` at approval and enforced at the db write boundary and
 * the outbound executor. Two named host objects, never conflated — the same split
 * `auth-schema.ts` documents for v3.
 *
 * FLAT, NOT DISCRIMINATED (deliberate). v3's `authSpecSchema` is a discriminated union
 * whose per-kind shapes gate which seats exist. A requirement is an AUTHORING artifact
 * that must survive re-inference and hand-editing, so kind-conditional seat presence
 * would make every edit a potential structural rejection. The one conditional rule kept
 * is the `none` coherence check (see below), because a keyless kind carrying credential
 * seats is not a loose shape — it is an incoherent one.
 *
 * PUBLICATION LINE: like `auth-schema.ts` and `render-directive.ts`, deliberately NOT
 * in `json-schemas.ts` SOURCES — auth stays out of the publishes-to-spec set until the
 * Beta exit gate. The shape is locked by the in-package tests instead, and the staged
 * v0.3 draft carries the prose.
 *
 * P0 IS ADDITIVE (fold B1): this schema lands ALONGSIDE `llmProposalSchema` and the v3
 * `snug_auth_specs` surface, which keep shipping until their last consumers are rewired
 * in P3/P4.
 */

import { z } from 'zod';
import {
  AUTH_HINT_HOSTS_MAX_ITEMS,
  AUTH_HINT_HOST_MAX_CHARS,
  AUTH_HINT_SCOPES_MAX_ITEMS,
  AUTH_HINT_SCOPE_MAX_CHARS,
  AUTH_KINDS,
  AUTH_PROVIDER_NAME_MAX_CHARS,
  normalizeAuthHost,
  oauth2AuthCodeSchema,
} from './auth-schema.js';

// ------------------------------------------------------------------ constants

/**
 * The six kind discriminators: v3's five (`AUTH_KINDS`, derived — never retyped, they
 * are PERSISTED literals shared with AL-03/AL-04) plus `'none'` (Q6).
 *
 * `'none'` is the keyless provider: a public API that needs no credential but still
 * needs a host ceiling. Q6 took the cheap schema window now rather than re-opening a
 * persisted discriminator set later; the alternative was modelling keyless apps as
 * "no connection row", which loses the host gate entirely.
 */
export const CONNECTION_KINDS = [...AUTH_KINDS, 'none'] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/**
 * `snug_connections.provenance` — which channel authored the requirement. Drives the
 * review posture (`registry` may keep the light prefilled path; everything else forces
 * the strong field-by-field review) and the `user_confirmed`-wins rule (R3: a `user`
 * requirement is never overwritten by inference). Persisted column values — never
 * prose-only literals.
 *
 * `shared` (TASK-20260904, ADR-0063 §3) is the untrusted declaration channel ADR-0016
 * clause 6 anticipated: a requirement that arrived inside an app bundle from someone
 * the user may not know. It is its own literal — never `starter` reused — so the review
 * copy can say honestly who wrote it. Widening this set is a WRITE-TIME enum change on
 * a TEXT column, not a storage-schema change: no `USERDB_SCHEMA_VERSION` bump (the
 * `linked_device` precedent; a bump would make every older hub refuse the whole file).
 */
export const CONNECTION_PROVENANCES = ['registry', 'inference', 'user_docs', 'starter', 'user', 'shared'] as const;

export type ConnectionProvenance = (typeof CONNECTION_PROVENANCES)[number];

/**
 * `snug_connections.status` — the THREE persisted values. "needs re-approval" is
 * DERIVED (`status='approved' AND pending_requirement_json IS NOT NULL`, fold B2) and
 * is never a fourth status: a fourth value would let a stage-time write move a row out
 * of `approved`, which is precisely the silent widening the pending column prevents.
 */
export const CONNECTION_STATUS = {
  declared: 'declared',
  approved: 'approved',
  revoked: 'revoked',
} as const;

export const CONNECTION_STATUSES = Object.values(CONNECTION_STATUS);

export type ConnectionStatus = (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

/**
 * Slot charset — the second half of the `(app_id, slot)` primary key, so it is a
 * PERSISTED identifier. Lowercase-only and dash-only by construction: SQLite compares
 * these bytes exactly, so `Coinbase` and `coinbase` would fork into two rows for one
 * provider, and a dotted form (`api.coinbase.com`) would invite confusing a slot with
 * a host. 40 chars matches `APP_OBJECT_NAME_RULE`'s ceiling.
 */
export const CONNECTION_SLOT_RULE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Per-app declared-slot cap (fold S-M1, mutation-evidenced). v4 lifts v3's structural
 * one-row-per-app limit (`snug_auth_specs.app_id` was the whole PK), and `guardAddedBytes`
 * caps BYTES per write, not ROW COUNT — so without a named bound a hostile or broken
 * build emits unbounded `declared` rows: storage spam, review fatigue, a flooded
 * Settings screen.
 *
 * 8 is chosen to clear the legitimate ceiling with headroom and still sit far below the
 * human-attention threshold the cap exists to protect. The plan's own worked example
 * (R6: "Dropbox + OneDrive + Google Drive in one app") is 3; a generous aggregator —
 * three clouds plus calendar, mail, notes — reaches 6. Review fatigue and Settings
 * flooding begin in the low tens, so 8 rows is a survivable screen and 100 is not.
 *
 * NOT AN ENDORSEMENT OF 8-CONNECTION APPS: doctrine still teaches ONE connection per
 * app (Q4). This is a structural backstop, not a feature budget. Enforced in
 * `putDeclaredConnection` (packages/db), which is where row COUNT is knowable.
 */
export const AUTH_MAX_SLOTS_PER_APP = 8;

/** Max credential field definitions per requirement — the wizard renders one input each. */
export const CONNECTION_REQUIREMENT_MAX_FIELDS = 8;

/** Max registration walkthrough steps; the wizard renders these as a plain `<ol>`. */
export const CONNECTION_REQUIREMENT_MAX_INSTRUCTIONS = 10;

/** Max chars per registration step — a step, not an essay. */
export const CONNECTION_REQUIREMENT_INSTRUCTION_MAX_CHARS = 300;

/**
 * Max header-template entries. The template is rendered HOST-side into real outbound
 * requests with real credentials, and every entry is shown verbatim in the strong
 * review — so the bound is as much about a reviewable code box as about bytes.
 */
export const CONNECTION_REQUIREMENT_MAX_HEADER_ENTRIES = 8;

/** Max chars per header-template value. */
export const CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS = 300;

/**
 * Max query-template entries — the queryTemplate mirror of
 * `CONNECTION_REQUIREMENT_MAX_HEADER_ENTRIES`, same number for the same reason: the
 * template is rendered host-side into a real outbound URL with real credentials, and
 * every entry is shown verbatim in the strong review, so the bound is as much about a
 * reviewable code box as about bytes. A separate constant (not a reuse) because the two
 * seats can legitimately diverge and a shared name would hide which one a change moved.
 */
export const CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES = 8;

/** Max chars for a URL seat (console/docs/homepage) — rendered as a link in the review. */
export const CONNECTION_REQUIREMENT_URL_MAX_CHARS = 300;

/** Field-label ceiling: labels are rendered verbatim above each credential input. */
export const CONNECTION_FIELD_LABEL_MAX_CHARS = 80;

/** Field-description ceiling: the helper line under each credential input. */
export const CONNECTION_FIELD_DESCRIPTION_MAX_CHARS = 200;

/** Field-placeholder ceiling: greyed sample text inside each credential input. */
export const CONNECTION_FIELD_PLACEHOLDER_MAX_CHARS = 60;

/** `testRequest.pathAndQuery` ceiling — the optional "test this connection" probe (Q7). */
export const CONNECTION_TEST_REQUEST_PATH_MAX_CHARS = 200;

/**
 * Field-key charset. Keys are the join between three surfaces: `{{key}}` in the header
 * template, the `auth:<appId>:<slot>:<fieldKey>` secret key, and the wizard's input
 * identity. Keeping them `[a-z0-9_]` means a key can never smuggle a template
 * metacharacter or a secret-key path separator.
 */
export const CONNECTION_FIELD_KEY_RULE = /^[a-z0-9_]{1,40}$/;

/**
 * Header-name charset (RFC 7230 token, narrowed). Narrowed deliberately: the full token
 * grammar admits characters that would let a declared header name collide confusingly
 * with a control seat in a code box. Real provider headers are alnum + dash.
 */
export const CONNECTION_HEADER_NAME_RULE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Query-parameter-name charset (TASK-20260812-desktop-auth-awareness P3, ADR-0022 §3;
 * P0 amendment 11). Query names get their OWN rule rather than reusing the header one
 * because the two vocabularies genuinely differ: real query parameters carry
 * underscores (CoinGecko's `x_cg_demo_api_key` — the motivating case the header rule's
 * alnum+dash would reject), dots, and PHP/Rails-style brackets (`filter[key]`), while
 * header names must stay proxy-safe alnum+dash. What both rules still exclude is every
 * character that could smuggle URL structure past the review code box: `=`, `&`, `%`,
 * `?`, `#`, space, and the template metacharacters. "Same lint family as
 * headerTemplate" (AC6) refers to the VALUE rules — the shared value bounds here and
 * the declared-field-keys lint in packages/auth — never to this key charset.
 */
export const CONNECTION_QUERY_NAME_RULE = /^[A-Za-z0-9_.\[\]-]{1,64}$/;

/**
 * Hostname charset — LDH labels, dot-separated, no scheme/port/path/credentials. The
 * length ceiling (`AUTH_HINT_HOST_MAX_CHARS`, RFC 1035's 253) is applied separately so
 * an over-long-but-well-formed host fails on LENGTH, which is the honest diagnostic.
 *
 * NOTE (ADR-0023, TASK-20260812-desktop-auth-awareness P5): digit-only labels pass this
 * rule, so a dotted-decimal IPv4 LITERAL like `192.168.1.50` is — and always was — a
 * legal `declaredApiHosts` entry. That is deliberate and predates the `lanHost` seat
 * (ADR-0021 Decision 4's private-literal transport rung), which is why the LAN fork adds
 * an EXTRA rule for lanHost requirements rather than loosening this one: see the
 * `lanHost` superRefine below for what a LAN declaration may and may not freeze into its
 * ceiling.
 */
export const CONNECTION_HOST_RULE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The LAN host CLASSES a `lanHost` seat may declare (ADR-0023 Decision 1).
 *
 * A single-member union today, and additive by construction: a future device class (a
 * hostname-on-the-local-network class, an IPv6 ULA class) is a NEW literal here plus its
 * own validator and its own admission rule — never a widening of this one. Pinned as an
 * exported tuple so the registry, the wizard and the admission fork all name the same
 * class rather than each spelling the string.
 */
export const CONNECTION_LAN_HOST_CLASSES = ['rfc1918-ipv4-literal'] as const;

export type ConnectionLanHostClass = (typeof CONNECTION_LAN_HOST_CLASSES)[number];

/** Dotted-decimal shape gate for `isRfc1918Ipv4Literal` — four 1–3 digit octets, nothing else. */
const IPV4_LITERAL_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * True when `host` is an RFC-1918 private-range IPv4 LITERAL — 10.0.0.0/8,
 * 172.16.0.0/12, or 192.168.0.0/16 — the `rfc1918-ipv4-literal` class, decided
 * arithmetically rather than by prefix string.
 *
 * WHY THIS LIVES IN PROTOCOL AND NOT IN packages/auth. `packages/auth` already carries
 * `isPrivateRfc1918Ipv4Literal` (net-guards.ts) and the two are semantically identical —
 * but `packages/auth` DEPENDS ON this package, so importing it here would be a
 * dependency cycle. The class is a dozen lines of arithmetic over no shared state; a
 * cycle to save them is the worse trade. The two are pinned EQUIVALENT by a
 * cross-package test in packages/auth, so a drift fails loudly instead of becoming two
 * guards quietly disagreeing about what "private" means (lesson 2026-08-10: two lints
 * disagreeing about the same word is the founding-defect shape).
 *
 * Deliberately NARROWER than "not publicly routable": loopback (127/8), link-local
 * (169.254/16), CGN (100.64/10), every DNS name, and IPv6 in every form (bare,
 * bracketed, ULA, IPv4-mapped) are NOT in this class. Anything not well-formed
 * dotted-decimal returns false — fails closed toward refusal.
 */
export function isRfc1918Ipv4Literal(host: string): boolean {
  let candidate = host.trim().toLowerCase();
  if (candidate.endsWith('.')) candidate = candidate.slice(0, -1); // trailing-dot hygiene
  if (!IPV4_LITERAL_SHAPE.test(candidate)) return false;
  const octets = candidate.split('.').map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/**
 * Printable ASCII, space through tilde (U+0020–U+007E). The confusable guard's alphabet
 * — see `providerNameSchema` for what it does and does NOT claim.
 */
const PRINTABLE_ASCII_RULE = /^[\x20-\x7e]+$/;

// ------------------------------------------------------------ building blocks

/**
 * CONFUSABLE GUARD (parent §4, promoted from AL-10; ADR-0016 clause 6 prerequisite).
 *
 * WHAT IT STOPS — two distinct harms, both real:
 *  1. VISUAL: `ѕpotify` (Cyrillic ѕ, U+0455) renders as "spotify" in the review UI, so
 *     a user reading carefully still reads a trusted brand. Fullwidth Latin, zero-width
 *     characters, and bidi overrides (U+202E) are the same attack with different bytes.
 *  2. REGISTRY-KEY EVASION: `normalizeProviderKey` (well-known-providers.ts:134) is
 *     `toLowerCase().replace(/[^a-z0-9]/g,'')`, so a homoglyph name normalizes to a
 *     DIFFERENT key — it misses the registry, misses the registry-borrow ban, and
 *     therefore keeps its attacker-authored endpoints/template while LOOKING pinned.
 *     This second half is why the guard sits at the schema and not only in the UI.
 *
 * WHAT IT DOES NOT STOP — stated honestly, and stated in ADR-0017: pure-ASCII
 * lookalikes (`5potify`, `Spotlfy`, `C0inbase`) are ACCEPTED here. No charset or
 * normalization rule can reject them without also rejecting legitimate names, and a
 * lookalike denylist is unbounded. Those are carried by two other defenses: the strong
 * review's provenance copy ("proposed by a model — a guess, not an authority"), and the
 * registry-borrow ban firing on `declaredApiHosts ∩ registry apiHosts` (fold S-M3), which
 * catches borrowing a trusted HOST under a lookalike NAME. This guard is not a lookalike
 * defense and must never be described as one.
 *
 * NFC normalization is asserted rather than applied: a name whose canonical form differs
 * from its stored form would compare unequal to itself across surfaces that normalize
 * differently. Since the printable-ASCII rule already excludes every character NFC can
 * change, this check can only fire on input that also fails the charset rule — it is a
 * belt-and-braces statement of intent for the day the charset is widened.
 */
const providerNameSchema = z
  .string()
  .min(1)
  .max(AUTH_PROVIDER_NAME_MAX_CHARS)
  .regex(PRINTABLE_ASCII_RULE, 'provider.name must be printable ASCII (confusable guard)')
  .refine((name) => name.normalize('NFC') === name, 'provider.name must be NFC-normalized');

const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(CONNECTION_REQUIREMENT_URL_MAX_CHARS);

/**
 * A credential field DEFINITION — never a credential value. `type` drives masking and
 * paste behavior in the wizard; the shipped `authFieldTypeSchema` literals are reused
 * verbatim because they are already persisted in v3 rows.
 */
export const connectionFieldSchema = z.strictObject({
  key: z.string().regex(CONNECTION_FIELD_KEY_RULE),
  label: z.string().min(1).max(CONNECTION_FIELD_LABEL_MAX_CHARS),
  type: z.enum(['text', 'secret', 'password', 'url']),
  description: z.string().max(CONNECTION_FIELD_DESCRIPTION_MAX_CHARS).optional(),
  placeholder: z.string().max(CONNECTION_FIELD_PLACEHOLDER_MAX_CHARS).optional(),
  /** True by default; false only for genuinely optional fields. */
  required: z.boolean().optional(),
});
export type ConnectionField = z.infer<typeof connectionFieldSchema>;

export const connectionProviderSchema = z.strictObject({
  name: providerNameSchema,
  homepageUrl: httpsUrlSchema.optional(),
  docsUrl: httpsUrlSchema.optional(),
});
export type ConnectionProvider = z.infer<typeof connectionProviderSchema>;

/**
 * The registration walkthrough. `instructions` are PLAIN TEXT rendered as an `<ol>` —
 * never as HTML, never as links. That is a rendering contract the wizard owes this
 * schema: the steps come from an untrusted channel and are shown with wizard-grade
 * legitimacy, so markup here would be phishing with the host's own chrome.
 */
export const connectionRegistrationSchema = z.strictObject({
  consoleUrl: httpsUrlSchema.optional(),
  instructions: z
    .array(z.string().min(1).max(CONNECTION_REQUIREMENT_INSTRUCTION_MAX_CHARS))
    .max(CONNECTION_REQUIREMENT_MAX_INSTRUCTIONS)
    .optional(),
});
export type ConnectionRegistration = z.infer<typeof connectionRegistrationSchema>;

/**
 * Credential placement for static kinds — header entries and, since ADR-0022 §3, query
 * parameters (OpenWeather's `?appid=` and CoinGecko's demo query form were structurally
 * unservable without a query seat). Values in BOTH templates may reference declared
 * field keys, the pinned helper enum, and the pinned request tokens — but THAT rule is
 * not expressible in Zod (it needs the sibling `fields` list), so it is the TEMPLATE
 * LINT's job (packages/auth, AC6), and the two templates' value lints are derived from
 * ONE resolution (lesson 2026-08-10: two lints disagreeing about "declared" is the
 * founding-defect shape). What the schema pins here is the envelope: entry counts, the
 * per-seat name charsets, and value lengths. Fold S-M2: the lint and the engine's
 * HELPERS map are reconciled so the enum is enforced rather than aspirational.
 *
 * Rendered query VALUES are credentials in a URL — ADR-0022 §3 binds the executor to
 * inject them only AFTER ceiling checks and to scrub them from every host-visible echo
 * (an enumerated site list, packages/auth). The schema's job is only the bounded shape.
 */
export const connectionRequestSchema = z.strictObject({
  headerTemplate: z
    .record(
      z.string().regex(CONNECTION_HEADER_NAME_RULE),
      z.string().min(1).max(CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS),
    )
    .refine(
      (template) => Object.keys(template).length <= CONNECTION_REQUIREMENT_MAX_HEADER_ENTRIES,
      `headerTemplate accepts at most ${CONNECTION_REQUIREMENT_MAX_HEADER_ENTRIES} entries`,
    )
    .optional(),
  queryTemplate: z
    .record(
      z.string().regex(CONNECTION_QUERY_NAME_RULE),
      // The headerTemplate VALUE bounds, verbatim — same family by construction.
      z.string().min(1).max(CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS),
    )
    .refine(
      (template) => Object.keys(template).length <= CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES,
      `queryTemplate accepts at most ${CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES} entries`,
    )
    .optional(),
});
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>;

const connectionEndpointsSchema = z.strictObject({
  authorizeUrl: httpsUrlSchema.optional(),
  tokenUrl: httpsUrlSchema.optional(),
  refreshUrl: httpsUrlSchema.optional(),
  revokeUrl: httpsUrlSchema.optional(),
});

/**
 * Declared hosts — a REQUEST for a ceiling, not the ceiling. Normalized on the way
 * through (`normalizeAuthHost`: lowercase + IDNA toASCII via the URL trick) so a
 * unicode declared host can match a real punycoded request host, per the AL-03
 * amendment B3 asymmetry. The charset rule runs AFTER normalization for the same
 * reason: `MÜNCHEN.example` is a legitimate declaration whose canonical form is LDH.
 */
const declaredApiHostsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(AUTH_HINT_HOST_MAX_CHARS)
      .transform(normalizeAuthHost)
      .refine((host) => CONNECTION_HOST_RULE.test(host), 'declaredApiHosts entries must be bare hostnames'),
  )
  .min(1)
  .max(AUTH_HINT_HOSTS_MAX_ITEMS);

/**
 * The LAN-CLASS HOST SEAT (ADR-0023 Decision 1; P0 amendment 2 "lan-schema-2").
 *
 * A provider whose API lives on a device on the USER'S OWN NETWORK — a Philips Hue
 * bridge is the first — cannot have its host pinned by anyone but the user: the address
 * is theirs, assigned by their own router. Before this seat such a requirement was
 * literally unrepresentable, because `declaredApiHosts` is required AND `.min(1)`
 * (probe-confirmed 2026-08-13: safeParse fails with "expected array, received
 * undefined"), so the registry had nowhere to say "this provider's host is collected,
 * not pinned".
 *
 * `label` is the copy the wizard renders above the address input ("Bridge IP address").
 * It reuses the field-label ceiling because it IS a field label in every way that
 * matters to the review screen, and a seat that renders like a label with a different
 * bound would drift from the thing it looks like.
 *
 * NOTE WHAT THIS SEAT IS NOT: it is a DECLARATION that a host will be collected, never a
 * host. The collected address lands in `declaredApiHosts` (see the XOR rule below),
 * because that is the seat `deriveConnectionAllowedHosts` unions into the frozen
 * ceiling — one host object, not two (the REQUIREMENT ≠ GRANT split at the top of this
 * file stays exactly as it was).
 */
export const connectionLanHostSchema = z.strictObject({
  class: z.enum(CONNECTION_LAN_HOST_CLASSES),
  label: z.string().min(1).max(CONNECTION_FIELD_LABEL_MAX_CHARS),
});
export type ConnectionLanHost = z.infer<typeof connectionLanHostSchema>;

/**
 * The optional "test this connection" probe (Q7), run through the REAL connected-fetch
 * executor at the wizard's `done` step. GET-only and path-only by construction: a probe
 * that could choose its method or its host would be a write primitive and a second host
 * channel, both of which the frozen ceiling exists to deny.
 */
export const connectionTestRequestSchema = z.strictObject({
  method: z.literal('GET'),
  pathAndQuery: z.string().min(1).max(CONNECTION_TEST_REQUEST_PATH_MAX_CHARS).startsWith('/'),
});
export type ConnectionTestRequest = z.infer<typeof connectionTestRequestSchema>;

// -------------------------------------------------------------- the requirement

const connectionRequirementShape = {
  /** Stable connection id within the app — the second half of the (app_id, slot) PK. */
  slot: z.string().regex(CONNECTION_SLOT_RULE),
  provider: connectionProviderSchema,
  kind: z.enum(CONNECTION_KINDS),
  fields: z.array(connectionFieldSchema).min(1).max(CONNECTION_REQUIREMENT_MAX_FIELDS).optional(),
  registration: connectionRegistrationSchema.optional(),
  endpoints: connectionEndpointsSchema.optional(),
  scopes: z
    .array(z.string().max(AUTH_HINT_SCOPE_MAX_CHARS))
    .max(AUTH_HINT_SCOPES_MAX_ITEMS)
    .optional(),
  /** Defaults to true (public-client posture; ADR-0014 consequence). */
  pkce: z.boolean().optional(),
  /** Per-provider authorize-URL query params (Google's `access_type=offline`, etc.). */
  authorizeParams: z.record(z.string().min(1).max(64), z.string().max(200)).optional(),
  request: connectionRequestSchema.optional(),
  /**
   * The embedded org→user second layer (fold T-M7), reusing the shipped
   * `oauth2AuthCodeSchema` verbatim so R5's two-layer case stays expressible and
   * umbrella AC5(a) stays checkable post-rewrite.
   *
   * REGISTRY-SYNTHESIZED ONLY at 1.0. The schema cannot enforce that — it has no idea
   * which channel it is parsing — so admission is the lint's job (AC5, packages/auth),
   * which REJECTS this seat on the LLM, manifest, user-docs and user channels. Naming
   * it here rather than omitting it is the point: v3's hole was that
   * `llmProposalSchema` omitted `userLayerFields` but NOT `userLayerEndpoints`, so an
   * LLM could aim the three-legged flow at attacker endpoints. One named seat with one
   * named gate beats four partially-omitted ones.
   */
  userLayer: oauth2AuthCodeSchema.optional(),
  /**
   * REQUIRED-XOR-`lanHost` (ADR-0023 Decision 1). Optional at the FIELD level and made
   * conditionally-required by the superRefine below, because Zod cannot express "required
   * unless a sibling is present" any other way. Every non-LAN requirement is byte-identical
   * to its pre-P5 self: absent or empty is still a rejection, with the same path.
   */
  declaredApiHosts: declaredApiHostsSchema.optional(),
  lanHost: connectionLanHostSchema.optional(),
  testRequest: connectionTestRequestSchema.optional(),
} as const;

/**
 * The single requirement schema — one schema, three call sites (build directive,
 * starter manifest, wizard/user entry). Strict at every level: an unknown key anywhere
 * is a rejection, never a passthrough, so a future seat cannot ride in unreviewed on a
 * channel that predates it.
 */
export const connectionRequirementSchema = z
  .strictObject(connectionRequirementShape)
  .superRefine((requirement, ctx) => {
    // ---------------------------------------------------------------- THE HOST XOR
    //
    // EXACTLY ONE host source, and the rule is decided by what CONSUMES this seat.
    // `deriveConnectionAllowedHosts` (below) unions `declaredApiHosts` into
    // `snug_connections.allowed_hosts` at approval, and that frozen ceiling is the
    // runtime injection wall. So a LAN row must be ABLE to carry the collected bridge
    // address in `declaredApiHosts` — there is no second path by which a ceiling could
    // freeze around the user's device, and inventing one would mean two host objects
    // where this file has always insisted on one.
    //
    //   (a) NO `lanHost`  ⇒ `declaredApiHosts` REQUIRED, non-empty. Today's rule,
    //       unchanged for every shipped requirement, same issue path as before.
    //   (b) `lanHost` present ⇒ `declaredApiHosts` is EITHER ABSENT (pre-collection —
    //       what a LAN registry entry emits) OR EXACTLY ONE entry, and that entry must
    //       be a literal of the DECLARED CLASS (today: RFC-1918 IPv4).
    //
    // WHY "exactly one, of the class" rather than "contains one". A public host beside a
    // `lanHost` would freeze a public host into a ceiling the review screen presents as
    // "a device on your own network" — a credential aimed anywhere, wearing LAN clothes.
    // A SECOND private literal is a second device the user never paired. The schema is
    // the first of two seats that refuse this; admission re-validates the class on the
    // borrow path (packages/auth, amendment 10c) because a requirement can reach
    // admission without passing through here (C5: admission reads defensively at the
    // envelope boundary).
    const declaredHosts = requirement.declaredApiHosts;
    if (requirement.lanHost === undefined) {
      if (declaredHosts === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['declaredApiHosts'],
          message: 'declaredApiHosts is required unless the requirement declares a lanHost seat',
        });
      }
    } else if (declaredHosts !== undefined) {
      const classOf: Record<ConnectionLanHostClass, (host: string) => boolean> = {
        'rfc1918-ipv4-literal': isRfc1918Ipv4Literal,
      };
      const inClass = classOf[requirement.lanHost.class];
      if (declaredHosts.length !== 1 || !inClass(declaredHosts[0]!)) {
        ctx.addIssue({
          code: 'custom',
          path: ['declaredApiHosts'],
          message: `a lanHost requirement declares EXACTLY ONE host and it must be of class '${requirement.lanHost.class}' — the address the user collected, and nothing else`,
        });
      }
    }

    // `linked_device` COHERENCE (ADR-0032, TASK-20260816). Stated BEFORE the `none` arm
    // below because that arm ends in an early return.
    //
    // The kind's credential is a sidecar access token MINTED at pairing — like Hue's
    // application key, the user never types it, but it must still have a named slot for
    // `snug_secrets` to hold and for the header template to reference. A row with no field
    // has nothing for pairing to fill and nothing for the executor to inject; it would
    // parse cleanly and then fail mid-send, after the user armed auto-reply. That is the
    // worst possible moment to discover an incoherent row, so it fails closed here.
    //
    // Endpoints are refused because a device link is not an authorization-code flow: it
    // never redirects, and `refreshUrl` unions into the DERIVED CEILING
    // (`deriveConnectionAllowedHosts` below), so tolerating them would let a kind that
    // cannot use them widen the wall that contains it.
    //
    // A `lanHost` seat is refused for the reason ADR-0032 §4 records: `isLanRequirement`
    // keys on the seat's mere presence, so carrying one would route this row into the LAN
    // pairing path and its mandatory TLS certificate pin — which a sidecar on a unix socket
    // can never produce. The sidecar is reached as a capability, not as a host.
    if (requirement.kind === 'linked_device') {
      if (requirement.fields === undefined || requirement.fields.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message:
            "kind 'linked_device' stores a minted session token, so it must declare exactly the field that token fills",
        });
      }
      if (requirement.endpoints !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoints'],
          message: "kind 'linked_device' never redirects, so it must carry no OAuth endpoints",
        });
      }
      if (requirement.lanHost !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['lanHost'],
          message:
            "kind 'linked_device' is reached as a capability, not as a network host — it must carry no lanHost seat (ADR-0032)",
        });
      }
    }

    // `none` COHERENCE (Q6). A keyless kind that declares credential seats is not a
    // loose shape, it is an incoherent one: there is nothing for the wizard to collect
    // and nothing for the executor to inject, so a half-formed row would reach the
    // grant path and fail at the worst moment. Fail closed at the schema instead.
    //
    // `declaredApiHosts` stays REQUIRED for `none` (it is required for every kind):
    // keyless means "no credentials", never "no host gate".
    if (requirement.kind !== 'none') return;
    if (requirement.fields !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: "kind 'none' declares no credentials, so it must carry no fields",
      });
    }
    if (requirement.request !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['request'],
        message: "kind 'none' has no credential to inject, so it must carry no request template",
      });
    }
  });

export type ConnectionRequirement = z.infer<typeof connectionRequirementSchema>;

// ------------------------------------------------------------- host derivation

const hostOfUrl = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return normalizeAuthHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
};

/**
 * The DERIVED HOST UNION for a requirement: `declaredApiHosts` ∪ every OAuth endpoint
 * host (authorize, token, **refresh** — it receives long-lived credentials, revoke) ∪
 * the embedded `userLayer`'s endpoints and declared hosts. This is v3's
 * `deriveAuthAllowedHosts` semantics, re-homed on the flat requirement shape.
 *
 * Frozen at approval into `snug_connections.allowed_hosts`, displayed in full to the
 * user first, and thereafter the runtime injection ceiling.
 *
 * LAN ROWS (ADR-0023): a `lanHost` requirement that has not yet collected its address
 * has NO `declaredApiHosts`, so this returns `[]` — an EMPTY ceiling, which refuses
 * every host. That is the correct pre-collection answer and it is why the wizard's
 * binding order is collect the address → approve the row → freeze the ceiling → pair
 * (P0 amendment 5): pairing always runs against a ceiling that already contains the
 * bridge. `lanHost` itself contributes NO host — it is a declaration that one will be
 * collected, never an address — so there is exactly one seat feeding the ceiling, as
 * there has always been.
 *
 * OUTPUT STABILITY IS LOAD-BEARING, not cosmetic (P0 cutover trap 1). `importUserDb`'s
 * reconciliation branch 1 keeps an approval only when the STORED `allowed_hosts` JSON
 * is byte-identical to the local approved row's; branch 2 recomputes from the
 * requirement. So sorted + unique + normalized output is what stops an otherwise-
 * unchanged connection from missing branch 1 and mass-demoting every approval on the
 * first sync pull after cutover — which reads to the user as "the update logged me out
 * of everything".
 */
export function deriveConnectionAllowedHosts(requirement: ConnectionRequirement): string[] {
  const hosts = new Set<string>();
  const addDeclared = (declared: readonly string[] | undefined): void => {
    for (const host of declared ?? []) hosts.add(normalizeAuthHost(host));
  };
  const addEndpoints = (urls: ReadonlyArray<string | undefined>): void => {
    for (const url of urls) {
      const host = hostOfUrl(url);
      if (host !== undefined) hosts.add(host);
    }
  };

  addDeclared(requirement.declaredApiHosts);
  const endpoints = requirement.endpoints;
  if (endpoints !== undefined) {
    addEndpoints([endpoints.authorizeUrl, endpoints.tokenUrl, endpoints.refreshUrl, endpoints.revokeUrl]);
  }
  const layer = requirement.userLayer;
  if (layer !== undefined) {
    addDeclared(layer.declaredApiHosts);
    addEndpoints([
      layer.endpoints.authorizeUrl,
      layer.endpoints.tokenUrl,
      layer.endpoints.refreshUrl,
      layer.endpoints.revokeUrl,
    ]);
  }
  return [...hosts].sort();
}

// ------------------------------------------------------- canonical identity

/**
 * Recursive KEY sort — the only structural rewrite canonicalization performs.
 *
 * ARRAY ORDER IS PRESERVED, deliberately, and this is the one place the parent plan's
 * shorthand ("stable key order, stable ARRAY order, whitespace-free JSON", §5 P2) must
 * be read as intent rather than literally. Every array in a requirement is SEMANTICALLY
 * ORDERED and user-visible: `registration.instructions` is a numbered walkthrough
 * (step 3 before step 1 is a different walkthrough), `fields` is the wizard's input
 * order, and `scopes` renders in declaration order on the wizard's review screen and
 * scope-diff box (built by TASK-20260815 — until then this sentence described a
 * renderer that did not exist) as well as the provider's consent page. Sorting them would make two
 * requirements that a user would read as different collapse to one hash — so a
 * reordered walkthrough would silently keep its `requirement_version` and, worse, ride
 * through the edit pipeline as a no-op with nothing re-reviewed. "Stable" is satisfied
 * by the arrays already being stable: they arrive in the order the author wrote them
 * and are stored verbatim.
 *
 * KEY order, by contrast, carries no meaning and is NOT stable across the channels that
 * produce requirements — an LLM re-emits the same requirement with keys in a different
 * order every turn. That is the churn this exists to absorb.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}

/**
 * The CANONICAL IDENTITY of a requirement (fold T-mn3): key-sorted, whitespace-free
 * JSON. `requirement_version` bumps exactly when this string differs across a persisted
 * replacement, and P2's edit pipeline uses the same function for its deterministic
 * "the builder re-emitted an identical requirement" no-op — one definition, so the two
 * can never disagree about what "changed" means.
 *
 * A canonical STRING rather than a digest, on purpose. The digest a synchronous accessor
 * could compute in a browser without WebCrypto (which is async) would be a short
 * non-cryptographic hash, and a collision there is not a cosmetic bug: two different
 * requirements sharing a version would let a changed requirement ride an approved grant's
 * version through the skew window. Comparing the canonical bytes is EXACT, needs no
 * crypto, and stays synchronous. The name says `hash` because that is the plan's word
 * for the role; the value is the pre-image, which is strictly stronger.
 *
 * Input is a PARSED requirement, so the value is JSON-safe by construction — no
 * undefined-dropping surprises, because `strictObject` has already removed everything
 * that is not a declared seat.
 */
export function canonicalRequirementHash(requirement: ConnectionRequirement): string {
  return JSON.stringify(sortKeysDeep(requirement));
}
