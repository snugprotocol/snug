# 0017 — The requirement/grant split (amends ADR-0016)

- **Status:** accepted (owner decisions Q1–Q9, 2026-08-10; recorded 2026-08-10; amended by 0022 — fifth helper cdp_jwt + queryTemplate, so the four-helper prose below is historical)
- **Date:** 2026-08-10
- **Task:** TASK-20260810-p0-contracts (child P0 of TASK-20260810-dynamic-auth-rewrite)

## Context

ADR-0016 settled **who may ask for a connection**. It named three proposers, fixed the
review each receives, and closed with clause 6: a list of prerequisites any *untrusted*
declaration channel must clear first. This ADR is what happens when that channel turns
out to be needed — and what it costs.

The trigger was not a security finding. It was the owner running the shipped product:
a Coinbase app built in the Playground asks for **one API key**, when Coinbase needs
**key + secret + passphrase**. The comparison to OProject was blunt — "even my grandma
could walk through the dynamic auth flow" there, while Snug ships a connection that
cannot work.

**Root cause, verified at source rather than assumed.** The schema and the runtime can
already express Coinbase: `authFieldSchema` is open, `template-engine.ts` ships
`hmac_sha256` and `{{timestamp()}}`, and the wizard renders `spec.fields` generically.
What cannot express it is every **authoring** path, because all three flow through
`llmProposalSchema` — which is literally
`authSpecHintsSchema.omit({registrationConsoleUrl, registrationInstructions, headerTemplate, fields, userLayerFields})`
(`render-directive.ts:63–69`). Those five omissions were AL-04's answer to credential
misdirection, and they were a good answer: an LLM that authors field LABELS dictates
which secret the user pastes. They are also exactly the five seats a Coinbase-shaped
requirement needs. So every static-kind proposal collapsed to the transformer's single
generic field. The defect is structural, not a missing form control.

The second thing the product exposed is a **conflation**. `snug_auth_specs` stores two
things that have different writers, different lifetimes, and different trust:

- **what the app NEEDS** — provider, kind, field list, registration walkthrough,
  endpoints, header template, declared hosts. Credential-free. Knowable at build time.
- **what the user ALLOWED** — approved status, the frozen host ceiling, the approval
  timestamp, the revocation tombstone. Only ever knowable from an explicit human act.

Conflating them is why ADR-0016 clause 2 had to say "the declaration is never
persisted": with one row for both concepts, persisting *what the app needs* would have
meant persisting an ungranted thing shaped exactly like a grant. That constraint then
propagated outward as UX damage the owner hit directly — a declaring app that the user
edits loses its guided setup entirely (ADR-0016 §Consequences), because nothing durable
was ever written down.

## Decision

**Split the concept in two.** A **connection requirement** is credential-free and
persists as a `declared` row, written at authoring moments (build, auth-touching edit,
starter install). A **connection grant** — `status='approved'`, the frozen
`allowed_hosts`, `approved_at` — is written **only** by the wizard on explicit user
approval. Credentials remain in `snug_secrets` under ADR-0014 custody, byte-for-byte
unchanged.

An app can hold requirements and no grants. That is the normal pre-connect state: the
executor fails closed with `NET_NOT_APPROVED` and the user gets a connect CTA, exactly
as today.

### Re-affirmed, not repealed

**An app may never propose a connection at runtime.** There is no frame, no SDK call,
and no announce field through which running app code can ask for a credential grant.
ADR-0016's central holding is untouched by this ADR. What changes is what the three
*already-named* proposers may carry, and whether it is written down.

### Clause-by-clause amendment

| ADR-0016 clause | v2 status |
|---|---|
| Proposers: user / builder directive / install act | **Kept**, but the builder and install channels now carry the full `connectionRequirement` (bounded), and both **persist** it as a `declared` row at build/install time |
| "The declaration is never persisted" (clause 2) | **Amended**: requirements persist as credential-free `declared` rows. What must never persist without approval is a *grant*. Rationale: R1/R2 — the requirement must outlive the chat/session so the run surface never needs to re-derive it |
| "Approval remains the only writer" (clause 5) | **Refined**: approval remains the only writer **of grants** (status `approved`, frozen hosts, credentials). Builder/install writers may create/replace **`declared` rows only** and may NEVER touch an `approved` or `revoked` row (closes the recorded `putAuthSpec` fail-open-on-unapproved finding by construction) |
| Two-fact install vouch (clause 3) | **Kept at install time** (install_source + byte-match), but its *consequence* changes: once installed, the requirement is a persisted row in the user's DB, so **editing the app no longer withdraws the guided setup** — the owner-hit UX pain disappears. Edits instead flow through R3's re-infer rules |
| Strong review for inferred/declared content (clause 4) | **Kept and extended**: everything the richer channel carries (fields, registration steps, templates) renders **verbatim in the strong field-by-field review** before approval |
| Clause 6 prerequisites for untrusted channels | **Promoted into this task**: the provider-name charset/confusable guard and registry-borrow ban ship in Phase 0 (they were AL-10-queued; a rewrite of this surface must not rebuild on top of known holes) |

Clauses 1, 3, 4 and 6 are kept. Only clause 3's *consequence* moves, and only clause 6's
*schedule* moves — the prerequisites themselves became blocking work in this phase
rather than a note about a future one.

The write rules are enforced in `packages/db` accessors with named errors, not in review
prose: `ConnectionWriteRuleViolation` (wrong accessor for this status),
`ConnectionRevokedError` (tombstone), `ConnectionSlotCapExceeded` (§Slot cap). Clause 5's
refinement is therefore a type-and-throw property, not a convention — `putDeclaredConnection`
throws on `approved` and on `revoked`, so "the builder cannot touch a grant" is checked by
the same seam that would otherwise have to be re-audited on every future call site.

### The pending-requirement seat

An edit that changes the requirement of an **approved** row does not write it. It stages
into `pending_requirement_json` via `stagePendingRequirement`, and the grant keeps
serving `requirement_json` with its old frozen hosts until `reapproveConnection`
promotes it. "Needs re-approval" is **derived** (`status='approved' AND
pending_requirement_json IS NOT NULL`), never a fourth status value — a fourth value
would let a stage-time write move a row out of `approved`, which is precisely the silent
widening this seat prevents.

### Slot cap: `AUTH_MAX_SLOTS_PER_APP = 8`

v4 keys on `(app_id, slot)`, which lifts v3's structural one-row-per-app limit
(`snug_auth_specs.app_id` was the whole primary key). `guardAddedBytes` bounds bytes per
write, not row count, so without a named bound a hostile or broken build emits unbounded
`declared` rows: storage spam, review fatigue, a flooded Settings screen.

8 clears the legitimate ceiling with headroom and still sits far below the human-attention
threshold the cap exists to protect. The plan's own worked example (R6: Dropbox +
OneDrive + Google Drive) is 3; a generous aggregator — three clouds plus calendar, mail,
notes — reaches 6. Review fatigue begins in the low tens, so 8 rows is a survivable
screen and 100 is not. Two boundary rules are pinned by tests rather than left to
reading: **replacing** an existing slot never counts (otherwise the legitimate re-inference
path breaks exactly at the cap), and **revoked tombstones DO count** (they are what a
flooding attacker leaves behind, and the revoke path keeps the row by design).

**This is not an endorsement of 8-connection apps.** Doctrine still teaches ONE connection
per app (Q4). The cap is a structural backstop against a hostile or broken build, and a
future reader must not mistake it for a feature budget.

### The confusable guard, scoped honestly

`provider.name` is constrained to printable ASCII (U+0020–U+007E) with an NFC assertion.

**What it stops**, two distinct harms:

1. **Visual.** `ѕpotify` (Cyrillic ѕ, U+0455) renders as "spotify" in the review UI, so a
   user reading carefully still reads a trusted brand. Fullwidth Latin, zero-width
   characters and bidi overrides are the same attack with different bytes.
2. **Registry-key evasion.** `normalizeProviderKey` is
   `toLowerCase().replace(/[^a-z0-9]/g,'')`, so a homoglyph name normalizes to a
   *different* key — it misses the registry, therefore misses the registry-borrow ban,
   and keeps its attacker-authored endpoints and template while *looking* pinned. This
   second half is why the guard sits at the schema and not only in the UI.

**What it does NOT stop:** pure-ASCII lookalikes. `5potify`, `Spotlfy` and `C0inbase` are
**accepted** by this guard. No charset or normalization rule can reject them without also
rejecting legitimate names, and a lookalike denylist is unbounded.

The division of labor is therefore explicit, and is stated here so the guard is never
mistaken for a lookalike defense:

| Attack | Carried by |
|---|---|
| non-ASCII homoglyph (`ѕpotify`) | the charset guard, at the schema |
| registry-key evasion via homoglyph | the charset guard, at the schema |
| **brand-adjacent name (`Spotify Inc`, `Coinbase Pro`, `CoinbaseInc`)** | **the registry-borrow ban's name trigger** — see the P5 amendment below |
| ASCII lookalike (`5potify`) that names a real host | the **registry-borrow ban's host trigger** — declaring `api.spotify.com` hits the ban regardless of the name |
| ASCII lookalike that names no trusted host | the **strong review's provenance copy** — "proposed by a model — a guess, not an authority" |

The host trigger is the load-bearing one for the LOOKALIKE row. A lookalike name is only
*useful* to an attacker if it also reaches a real provider's host, and that is exactly what
the intersection check catches. A lookalike that borrows nothing is a human-judgment
problem, and we say so rather than implying a technical control we do not have.

#### P5 amendment — the name trigger also fires on BRAND-ADJACENT names

**Recorded 2026-08-10 (TASK-20260810-p5-security-close), reproduced by execution before it
was fixed.**

As originally shipped the name trigger used `lookupWellKnownProvider`, i.e. exact-key
lookup after `toLowerCase().replace(/[^a-z0-9]/g,'')`. That collapses case and punctuation
but **not added words**, so:

- `Spotify`, `SPOTIFY!`, `S-p-o-t-i-f-y` → **hit** the registry (ban fires);
- `Spotify Inc`, `Spotify Connect`, `Spotify-Premium`, `Coinbase Pro`, `CoinbaseInc`,
  `GitHub Enterprise` → **missed** it entirely, and were admitted with attacker-authored
  `fields`, an attacker-authored `headerTemplate` and attacker-chosen hosts, while the
  review screen rendered the trusted brand.

The host trigger caught this only when the attacker *also* declared a registry host — which
an attacker aiming a credential at their own server never does.

The name trigger now falls through to a **boundary-aware segment-run match**
(`findBrandAdjacentRegistryKeys`, packages/auth): the name is split on non-alphanumerics
*and* camelCase/digit humps, and any contiguous run of segments that joins to a registry
key is a borrow. `CoinbaseInc` is reachable because of the hump split; `GITHUB ENTERPRISE`
because a run of capitals is not itself a hump.

**The false-positive side was weighed and is pinned by test.** A plain substring test would
have fired on `Slackline Weather`, `Slacker Radio`, `Googol Analytics` and `Gmailer Tools`
— genuinely different providers whose names merely contain a registry name's letters.
Boundary-aware matching misses all of them, and a negative test holds that line.

**A brand-adjacent name is treated as borrowing even when the product is genuinely
different.** `Coinbase Exchange` is a real, distinct product on a distinct host and it
still fires the ban. This is deliberate: admission cannot verify that a brand-adjacent name
belongs to a real neighbouring product, an attacker's `Coinbase Pro` makes exactly the same
claim, and a user reading either one beside an authored credential prompt cannot tell them
apart. A genuinely different provider earns a registry entry of its own through a reviewed
PR — the one channel the ban exempts. The in-repo fixtures that named `Coinbase Exchange`
moved to unpinned providers rather than the guard being softened for them.

**Still out of scope, unchanged:** pure-ASCII lookalikes (`5potify`, `Spotlfy`). They share
no segment with a registry key, so this amendment does not reach them and must not be
described as doing so.

### The registry-borrow ban fires on name OR host, for all kinds

The ban triggers on provider-name match **or** on `declaredApiHosts ∩` any registry
entry's `apiHosts`. On either hit the registry's pinned values **replace** the declared
ones for those seats — hosts, endpoints, registration block, and `provider.name` itself —
and the declared values are discarded, not merged.

Name-match alone is evaded by renaming. Host-match alone is evaded by trading on the
brand in the review screen while declaring no overlapping host. Both triggers are needed,
and the ban is **kind-agnostic**: today the registry is consulted for `oauth2_auth_code`
only, so `kind:'api_key'` + `providerName:'Spotify'` currently borrows Spotify's
legitimacy while pointing the credential at an attacker-chosen host. That is fixed here.

Making the ban kind-agnostic required widening the registry type: `WellKnownOauthProvider.endpoints`
becomes **optional**, because a static-kind provider (an exchange with an HMAC-signed API
key and no OAuth flow) must be representable by `apiHosts` and `registration` alone.
Inventing placeholder endpoint URLs would have been worse than absent —
`deriveConnectionAllowedHosts` unions endpoint hosts into the frozen ceiling, so a
placeholder would silently widen it. **P0 widens the type only; the static-kind data
entries are P4.**

#### P5 amendment — admission must be IDEMPOTENT (a shipped defect, now closed)

**Recorded 2026-08-10 (TASK-20260810-p5-security-close), found by driving a starter through
a real browser and confirmed present on the P4 baseline.**

Admission deliberately runs **twice** on the production path: once in
`persistConnectionRequirement` (the pipeline), and again inside the db accessor via the
injected `admissionGate`, so that no write can bypass the guard. That is the right design —
`packages/db` owns the rule "nothing persists unadmitted" and the composition root supplies
the registry-aware gate.

But substitution was not idempotent with respect to Guard 2b. Pass 1 **adds** the registry's
pinned `fields` to a bare requirement; pass 2 then read that seat as *borrower-authored
credential-prompt copy* and refused it. The guard rejected the value it had itself just
produced.

**Blast radius: every registry-backed starter.** All six shipped manifests declare a pinned
provider and (correctly) omit `fields`, so all of them failed to persist with
`write_refused`. The user saw "the agent proposed a connection that failed validation" and
**no connect card at all** — the same user-visible outcome as the P4 dead-field-list defect
it was supposed to have fixed.

**Why nothing caught it.** Two gaps compounded, and both are now closed:

1. no test drove a starter through `putDeclaredConnection` — the starter coverage stopped
   at schema/admission/manifest parity, which passed throughout;
2. the playground's `installTestUserDb` opened the db **without** the production
   `admissionGate`, so the entire suite ran against a database whose write accessors had no
   registry-aware admission. The second pass was structurally unreachable from any test.

**The fix.** A `fields` list that is byte-for-byte the registry's pinned list no longer
counts as an occupied prompt seat (`fieldsMatchRegistry`). Receiving the pinned value is not
an authoring act. Anything that differs in any property — one relabelled input, one added or
dropped key — is still authored and still refused, which a negative test pins alongside the
idempotence test.

The general rule this leaves behind: **a test double for the user DB may differ from
production in its backend and nothing else.** Guards are behavior under test, never
scaffolding to omit.

### `userLayer` is registry-synthesized only

The embedded org→user second layer keeps R5's two-layer case expressible and umbrella
AC5(a) checkable. It is **rejected on the LLM, manifest, user-docs and user channels** —
because of *where it came from*, never because of what it says. A `userLayer` pointing at
genuine Spotify URLs is still an LLM-authored seat, and the next one will not point at
Spotify.

Naming the seat and gating it beats omitting it. v3's actual hole is that
`llmProposalSchema` omits `userLayerFields` but **not** `userLayerEndpoints` /
`userLayerScopes` / `userLayerPkce` — so an LLM proposal can already aim the three-legged
consent flow at endpoints it chose, and the user sees a real-looking consent screen on an
attacker's host. One named seat with one named gate beats four partially-omitted ones.

### The Coinbase-variant encoding decision

**Decision: add ONE encoding-capable helper variant, `hmac_sha256_b64`.** The pinned
helper enum becomes four: `timestamp | hmac_sha256 | hmac_sha256_b64 | base64`.

**Verified at source, not assumed.** Coinbase-Exchange signs
`base64(HMAC-SHA256(base64decode(secret), timestamp+method+path+body))`, and that is
inexpressible today in **three independent ways at once**:

- `hmacHex` (`template-engine.ts:49–54`) is the only HMAC path and returns hex
  unconditionally (`bytesToHex`);
- `base64Utf8` (`:57–61`) is utf8-in/base64-out, so it cannot encode raw digest bytes;
- the grammar has no nesting — `parseHelperArgs` splits flat tokens with no recursive
  descent, so `{{base64(hmac_sha256(...))}}` cannot parse as a nested call;
- and nothing anywhere decodes a secret.

The alternative was pinning the P2 eval to a hex-expressible provider variant. Rejected
for three reasons, in order of weight:

1. **It would silently retire the owner's own motivating example.** The passphrase is the
   diagnostic marker of Coinbase *Exchange*, and Exchange is precisely the base64/decode
   variant. The hex-expressible Advanced Trade variant has no passphrase — it is two
   fields. So "pin a hex variant" satisfies the letter of *expressible* by deleting the
   third field whose absence is the defect that was filed. That is resolving a decision by
   redefining the requirement, against R5.
2. **Confidence, stated plainly.** Provider schemes could not be verified live from the
   implementing environment (no network). HIGH confidence that Coinbase Exchange uses
   `base64(HMAC(base64decode(secret), ts+method+path+body))` with CB-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE.
   MEDIUM confidence that Advanced Trade ever shipped a hex-HMAC CB-ACCESS-* variant, and
   LOW that it is still current — Coinbase has been moving Advanced Trade onto CDP keys
   using ES256/EdDSA JWTs, which is asymmetric and expressible by **neither** option. So
   the rejected option would have pinned the eval to a variant we cannot confirm exists,
   failing in P2 with the contract already frozen. This decision rests only on the
   high-confidence claim.
3. **The security delta is smaller than it looks, and the reason was verified.**
   `scrub.ts:16–19` already documents that any re-encoded value defeats the value-match
   scrubber, and `base64` is already in the enum — so base64 *output* adds zero new
   scrub-evasion reach. The only genuinely new primitive is **decoding the secret**, and
   it is confined INSIDE the helper (fused, fixed arity) rather than exposed as a general
   `base64decode()` a template could aim at arbitrary text. Net new attacker capability: a
   secret can reach an allowed host as raw-decoded-key HMAC output. The frozen host
   ceiling still bounds who receives it.

`hmac_sha256_b64(secret, ...messageParts)` takes a **variadic** message tail concatenated
in order, because Coinbase's real prehash is a four-part concat and `parseHelperArgs`
splits on commas — a multi-part prehash cannot arrive as one argument. This adds no new
primitive; it is concatenation of already-permitted tokens.

**One consequence is a real defect if ignored, so it is pinned here:** the timestamp
signed MUST be the same value sent in `CB-ACCESS-TIMESTAMP`. Two separate timestamp
evaluations can straddle a second boundary and produce an intermittently-invalid
signature — a ~1-in-N auth failure, not a theoretical one. The timestamp is therefore
evaluated **once per render pass** and memoized in the render context.

#### `request.timestamp`: a fifth pinned request token, added so the above is reachable

The four-helper enum above is **necessary but not sufficient** for Exchange, and the
first implementation shipped it insufficient. Verified by execution against the built
package: the pinned template

```
{{hmac_sha256_b64(api_secret, timestamp(), request.method, request.pathAndQuery, request.body)}}
```

**failed the lint** (`ok: false`). A helper CALL is not an accepted ARGUMENT form — the
grammar is flat, `parseHelperArgs` has no recursive descent, and the lint accepts an
argument only if it is a quoted literal, a declared field key, or a pinned request token.
So the timestamp could be *sent* (`{{timestamp()}}` in bare position) but never *signed*,
and the Coinbase-Exchange template this section justifies the fourth helper for was
**inexpressible in the shipped code**. The `timestamp()` memoization was, for the same
reason, protecting nothing reachable: no template could evaluate it twice.

**Decision: add `request.timestamp` to the pinned request-token set** (now five:
`request.method` · `request.url` · `request.pathAndQuery` · `request.body` ·
`request.timestamp`). It is a **render fact**, not a request fact — minted by the render
pass from the memoized state rather than read off the request — so it resolves even when
no request context is supplied, and `{{timestamp()}}` and `{{request.timestamp}}` are
served from the **same memoized slot** and cannot disagree.

The rejected alternative was allowing a **nested zero-arg helper call in argument
position**, bounded to one level. It keeps `timestamp()` as the only spelling, but it
makes argument resolution recursive and asynchronous, and every bound on it ("zero-arg
only", "one level, no recursion") becomes a rule enforced by code that a later edit can
relax. A pinned token is enforced by the token list itself, and the grammar stays flat.
Nesting remains **rejected by both the lint and the engine**, and that rejection is tested
rather than assumed.

The acceptance property is not "the two timestamp headers match" — two frozen clocks
satisfy that. It is that the HMAC **independently recomputed from the value sent in
`CB-ACCESS-TIMESTAMP`** equals the value sent in `CB-ACCESS-SIGN`. That is what
`template-parity.test.ts` asserts, and defeating the memoization turns it red.

#### Quoted helper arguments are literals in the ENGINE, not only in the lint

The lint skips a quoted argument unexamined, on the reading that quotes mark a literal by
authorial intent. The engine did not honor that reading: `parseHelperArgs` stripped the
quotes and **discarded the fact they were there**, so `resolveArgToken` looked the bare
text up in `ctx.fields` and resolved it as a credential. Verified by execution:
`{{base64('api_key')}}` **linted `ok: true`** and **rendered `base64('SUPERSECRET')`** —
the live credential, from a template that passes a human review precisely *because* the
quotes make it look inert.

This was a **C1 breach reachable from an approved template**, and it is fixed in the
**engine**: quoted arguments are returned verbatim without consulting `ctx.fields` or the
request tokens. The fix belongs there rather than in a widened lint because widening the
lint would only narrow *which* templates reach the capability, leaving the engine still
able to resolve a quoted token to a secret. With the engine honoring quoting, the lint's
own parity claim — "a template cannot lint one way and render another" — is true of the
shipped code.

**Cost accounted honestly:** the enum is FOUR, not the three the plan pinned. The trim is
unaffected — `unix_ms`, `hmac_sha512` and `sha256` are deleted from the engine's HELPERS
map, so the net count drops six → four. Every unused helper is signing surface a hostile
template can reach, and those three shipped with no requirement behind them.

The variant is not privileged: it is linted like every other helper (name in enum; every
UNQUOTED argument a declared field key or a pinned request token; quoted arguments are
literals and render as their own text) and rendered verbatim in the strong review code box
like every other template.

## Alternatives considered

- **Keep `llmProposalSchema`'s omissions and add a manual add-a-field UI.** The narrowest
  security posture: no LLM-authored field labels, ever. Rejected because it fails the
  grandma bar the rewrite exists to meet — it moves the entire burden of knowing that
  Coinbase needs a passphrase, and what to call it, onto a non-technical user, which is
  the exact work OProject does for them. It also does not fix the header template, so a
  signed scheme stays unbuildable at any level of user effort.
- **A connector catalog: ship pinned specs for the top N providers and support nothing
  else.** Rejected: it makes Snug's app surface a function of our integration backlog,
  which is the SaaS-integration model the positioning decision (2026-08-04) rejects
  outright. The registry stays as a *trusted rung* that wins on conflict, not as the only
  way to connect.
- **Admit the rich channel with no persistence** (keep clause 2 intact; resolve
  requirements on demand every time). Rejected: it re-creates the failure that motivated
  this ADR — the requirement dies with the session, so the run surface must re-derive it,
  which is inference at run time and directly against R2. It is also what makes an edit
  silently lose the guided setup.
- **A fourth status value for "needs re-approval"** instead of the derived-pill +
  `pending_requirement_json` seat. Rejected: any write that moves a row out of `approved`
  to signal a *pending* change is exactly the silent-widening shape the staging seat
  exists to prevent, and it would put the transition on the edit pipeline's write path.
- **Migrate v3 `snug_auth_specs` rows into v4 `snug_connections`.** Rejected (Q9, owner):
  the surface is pre-launch, so a fresh start costs nothing real, while a translation
  would give one connection two live writers during the additive cutover window. v4 lands
  **alongside** v3; the v3 table's deletion is a named exit item of P3.

## Consequences

- **A Coinbase-shaped app becomes buildable**: three fields, a signed CB-ACCESS-* header
  template, a developer-console walkthrough, and a host ceiling — persisted as a
  `declared` row before the app is ever run. That is the defect this rewrite was filed
  for, and it is the acceptance bar for P2. The exact four-header template is now
  **executed** in `template-parity.test.ts`, not asserted in prose — the first
  implementation of this ADR claimed buildability while the template failed the lint.
- **The v4 four-helper lint also applies to the still-shipping v3 `authSpec` render
  path.** `connected-fetch.ts`'s static-kind branch lints every `headerTemplate` before
  rendering, and it does not branch on schema version, so a v3 spec whose template uses
  `unix_ms`, `hmac_sha512` or `sha256` now fails closed with `NET_AUTH_FAILED` rather
  than rendering. This is disclosed rather than scoped away for two reasons: the engine's
  HELPERS map no longer contains those three at all, so a v3 template using them would
  fail at render regardless — scoping the lint to v4 rows would change only *which*
  error is raised, trading a review-time rejection for a signing-time throw — and the
  surface is pre-launch, so no such row exists in a user's database. A repo-wide search
  finds the three names only in the trim's own comments and tests.
- **Editing a declaring app no longer withdraws its guided setup.** ADR-0016's recorded
  UX cost is repaid: the requirement is the user's own persisted row, so an edit flows
  through the re-infer rules instead of vanishing. ADR-0016 §Consequences' warning against
  quietly reverting clause 3 still stands for the *install-time* vouch, which is unchanged.
- **The defense moved from "the channel cannot express it" to "the user sees exactly what
  it expresses."** That is a deliberate trade, and it puts more weight on the strong
  review screen than v3 did. If the review screen ever degrades — truncating a template,
  collapsing a host list, summarizing instructions — the trade stops paying. P3 owes the
  verbatim rendering that this ADR assumes.
- **`packages/protocol` changes**, so C3/SPEC_SYNC applies: `connectionRequirementSchema`,
  the `connection_requirement` directive, and userdb schema **v4**. Steps 1–3 + 6 were
  taken; **steps 4–5 (push to `snugprotocol/spec`) were NOT** — publication of the auth
  surface stays gated at Beta exit and AL-12 stays HELD. The staged prose is
  `docs/spec-drafts/spec-v0.3-auth.md`, created under the owner's 2026-08-10 carve-out.
- **P0 is additive.** `llmProposalSchema` and `snug_auth_specs` keep shipping;
  `starterDeclaration.ts:31` imports the former at runtime and 33 files touch the latter.
  Their deletions are named exit items of P4 and P3. `authRequiredPayloadSchema` **is**
  deleted here — it had zero non-test consumers.
- **`AUTH_MAX_SLOTS_PER_APP` is a backstop, not a doctrine change.** The KB still teaches
  one connection per app; lifting that later is a doctrine + review change, not a schema
  change.

### Residual risk, stated plainly

Three risks are **accepted, not mitigated**, and P5's threat-model delta must carry all
three:

1. **An approved-but-hostile header template can route a secret into an odd header of an
   already-allowed host.** The lint bounds *what* a template may reference; it cannot know
   that `X-Debug: {{api_secret}}` is wrong. The only bounds are the frozen host ceiling
   (which decides *who* receives it) and the human who read the template verbatim in the
   review. This is the direct cost of admitting LLM-authored templates, and it is why the
   review renders them uncollapsed.
2. **Helper encoding defeats the value-match scrubber by design.** The boundary is
   narrower than "base64 output is not caught", and stating it loosely understates one
   case while overstating another. The scrubber matches the values it actually INJECTED,
   and the executor feeds it the RENDERED headers — so with `{{base64(api_secret)}}`
   injected, a response echoing that same base64 string IS redacted. Executed:

   ```
   scrub('x=U1VQRVJTRUNSRVRLRVk=', {'X-Debug':'U1VQRVJTRUNSRVRLRVk='}) -> "x=***"     (redacted)
   scrub('raw: SUPERSECRETKEY',    {'X-Debug':'U1VQRVJTRUNSRVRLRVk='}) -> unchanged   (NOT redacted)
   scrub('raw: SUPERSECRETKEY',    {'X-Debug':'SUPERSECRETKEY'})       -> "raw: ***"  (redacted)
   ```

   The genuinely uncaught case is sharper: the UNDERLYING raw secret is never in the
   candidate set, because the base64 form is what was injected — so a response echoing the
   raw value passes through untouched. URL-escaped, hex, double-base64 and
   split-across-JSON echoes are uncaught for the same reason (`scrub.ts:16–19` documents
   re-encoded values as out of scope). `hmac_sha256_b64` adds one row: the decoded key
   never leaves the render, but the digest output is outside the scrubber's reach by the
   same boundary. The host ceiling remains the wall — the scrubber was never the primary
   one. Note the *quoted* form
   `{{base64('api_secret')}}` is no longer an instance of this risk at all — it renders
   the literal string, per §Quoted helper arguments above — and a reviewer may now rely on
   quotes meaning what they appear to mean.
3. **ASCII lookalike provider names are accepted.** Per §Confusable guard above — carried
   by the host-intersection ban and the review's provenance copy, not by the charset rule.

None of these are new *classes* — v3 already admitted (1) for registry-pinned templates
and (2) via `base64`. What the rewrite changes is who may author the template, which
raises the frequency, not the ceiling.
