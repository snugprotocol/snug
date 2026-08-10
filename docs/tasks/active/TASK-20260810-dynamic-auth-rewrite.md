# TASK-20260810-dynamic-auth-rewrite: Dynamic Auth v2 — build-time inference, requirement/grant split, the grandma wizard

- **Status**: **PLANNED — Gate 1 spec + Gate 2 plan, owner decisions Q1–Q9 ANSWERED 2026-08-10 (all nine on the tabled recommendation). NOT started.** Awaiting the standing fresh-context plan review before P0. Pick this up with `/pickup` in a fresh session.
- **Owner**: Jeetu (directed 2026-08-10); Claude drafted this plan
- **Risk tier**: **High** — touches `packages/protocol` (auth schema + directive payload + userdb schema), `packages/auth`, `packages/db`, `packages/knowledge` doctrine, the whole playground auth UI, and starter manifests. High children get fresh-context plan review before implementation per house process.
- **Branch (this plan)**: `feat/TASK-20260810-dynamic-auth-rewrite` (docs-only; cut from the AL-09 branch tip so the AL-09/umbrella journals do not fork). Implementation branches per phase off fresh `main`.
- **Packages touched (implementation)**: `packages/protocol`, `packages/auth`, `packages/db`, `packages/knowledge`, `apps/playground`, `examples/*`, docs/ADRs. Spec impact: **yes** — staged v0.3 auth draft updated via SPEC_SYNC (auth is still unpublished, so the redesign is cheap NOW and expensive after Beta exit).
- **Related**: supersedes the shape (not the harvest) of `TASK-20260807-starters-auth-spectrum` (AL-09, handed off unmerged at `86a564c`) · umbrella `TASK-20260805-alpha-umbrella` · ADR-0014 (custody — unchanged) · ADR-0016 (trust ladder — **amended by this task**, see §ADR-0017) · `internal/03-audit-auth.md` (OProject audit) · AL-04 (wizard/inferrer) · AL-05 (KB doctrine)

## Why (the owner redirect, 2026-08-10)

The owner reviewed AL-09 and redirected: the issues are **architectural, not code bugs**. Compared side-by-side with OProject, the current flow fails the end-user bar. OProject hand-holds a non-technical user through ANY provider's auth — "even my grandma could walk through the dynamic auth flow" — while Snug today ships a Coinbase-built app that asks for a single API key when Coinbase needs **key + secret + passphrase**. The owner's rules, restated as requirements (each becomes acceptance criteria in the phases below):

- **R1 — Infer at build, bake before run.** When a user builds an app that needs a 3rd-party service, the builder LLM researches the provider's auth (docs ladder) and the **complete** auth requirement — every field, the flow kind, the registration steps — is **persisted in the DB as part of the build**, before the user ever runs the app.
- **R2 — Never infer at run.** A running app only *uses* the baked requirement: the wizard guides sign-up/registration/copy-paste and collects credentials. No re-inference, no "infer from docs" button in the run surface.
- **R3 — Re-infer only on auth-touching edits.** Editing an app MAY re-infer, but only when the requested change touches the auth surface. A UI-only edit must leave the requirement (and any existing grant) untouched.
- **R4 — Starters are dev-time inferred.** New starter apps get their auth requirement inferred at development time (by Claude Code, same inference path) and baked into the shipped manifest; install **copies** the requirement into the user's DB (never credentials) and locks it until the user edits the app — at which point R3 applies as if user-authored.
- **R5 — Any credential shape.** Multi-field static credentials (Coinbase key/secret/passphrase), signed-header schemes, PATs, basic auth, OAuth2 both flavors, BYO-dev-registration (Spotify), two-layer — the requirement model must express what real providers actually need.
- **R6 — One connection per app today, N tomorrow.** Design storage/runtime/UI keyed for multiple connections per app (Dropbox + OneDrive + Google Drive in one app); ship with the single-connection doctrine.
- **R7 — Grandma UX.** Rebuild the connect UX on OProject's wizard pattern: one decision per screen, verb-named buttons, numbered provider walkthroughs, copy-paste helpers, masked fields, live progress — technical details abstracted.
- **R8 — Security bar unchanged.** C1–C5, ADR-0014 custody, fail-closed runtime, and the OSS-review posture survive the rewrite. Fresh start on schema/data is allowed (no migration burden), but no trust decision gets quietly weakened.

## What OProject does that we lost (the diligent comparison)

Verified at source in both trees (OProject refs use audit-style codename paths; Snug refs are working-tree).

| Dimension | OProject (shipped) | Snug today | Verdict |
|---|---|---|---|
| **When inference runs** | At **authoring**: the skill-builder LLM calls a structured `skill_auth_infer` tool BEFORE writing the skill; deterministic transformer encodes; spec row persisted at build. Post-install resolver as fallback. Its ADR-255: "the LLM owns the judgment, the platform owns the encoding." | At **run time, inside the wizard**: inference fires only when the user clicks "infer from docs" in an open wizard session (`wizard.ts:660–680`); result lives in session memory; first DB write is user approval. Nothing persisted at build. | **OProject matches R1/R2; Snug inverts them.** |
| **What the LLM may propose** | Full spec: `fields: AuthField[]` (arbitrary set, per-field label/type/description/placeholder), `registration.{consoleUrl,instructions[]}`, `headerTemplate` incl. HMAC-signed headers (`{{timestamp()}}`), endpoints, scopes. | Hints only: `llmProposalSchema` = provider name + kind hint + hosts + OAuth endpoint hints. `fields`, `headerTemplate`, `registration` **structurally excluded** (AL-04 M5). | **The Coinbase defect lives here** — see §Root cause. |
| **Edit behavior** | Explicit skip-rules: re-infer only when auth is missing/invalid or the change touches auth; `user_confirmed` rows are NEVER overwritten by inference. | No edit hook at all: editing an app neither re-infers nor invalidates; only the starter declaration prefill silently withdraws (ADR-0016 clause 3) — the owner-hit UX pain. | OProject matches R3; Snug has nothing. |
| **Install** | Spec row (shape only, never values) copies across the publish boundary; fallback resolver infers if missing. | `connection.json` resolved on demand, **never persisted**, withdrawn on any edit. | R4 wants OProject's copy-the-shape model. |
| **Wizard UX** | Step machine `spec_confirm → register → paste → connect`; one decision per screen; verb buttons ("I've got my Client ID & Secret"); numbered provider walkthrough + dashboard link; generated redirect-URI with Copy button; masked inputs with reveal; popup + BroadcastChannel + poll backstop; live inference progress; confidence <0.7 shows a "lower-confidence guess" band and a "[the assistant] guessed the credentials {provider} needs — take a quick look before you paste any secrets" confirm screen. | One sheet with a strong review + a credentials list; registration prose + redirect URI shipped late in AL-09 (post-review commits); no step model, no per-screen decisions, no live progress. | R7 = rebuild on OProject's step machine with Snug components/copy. |
| **Multi-connection** | One row per `(kind, skill_id, layer)`; `account_label` column reserved for multi-account. | `snug_auth_specs.app_id` is the **PRIMARY KEY** — one connection per app is structural, and the KB doctrine cites the PK as the reason. | R6 needs re-keying. |
| **Registry** | Endpoints + PKCE only; refuses to default scopes; refuses runtime `.well-known`. Registration steps live per-spec (LLM-authored at build). | Same posture (good) + Spotify carries a `registration` walkthrough; registry is OAuth-shaped only — static kinds can't ride it (the v3-review BLOCKER 1/2 pair). | Keep posture; add static-kind registry entries (§Design). |
| **What Snug does BETTER** | — | Local-first custody (no server vault, ADR-0014); always-strict host injection; frozen host ceiling + 10-gate fail-closed executor with scrub/SSRF/redirect/confirm gates; strong field-by-field review with full host disclosure; trust ladder with named proposers (ADR-0016); iproject host-freeze carried. | **Keep all of it.** The rewrite changes who writes WHAT and WHEN — not the custody or the runtime gates. |

## Root cause of the Coinbase defect (verified at source)

The schema and runtime can already express Coinbase: `fields: z.array(authFieldSchema).min(1)` is open (`auth-schema.ts:129–210`), `template-engine.ts` ships an `hmac_sha256` helper + `{{timestamp()}}`, and the wizard's credentials step renders `spec.fields` generically. **But no authoring path can produce such a spec**: the builder directive, the inferrer output, and the install manifest all flow through `llmProposalSchema`, which deliberately omits `fields`/`headerTemplate`/`registration` (AL-04 security bound, `render-directive.ts:63–69`), and the wizard's edit UI has no add-a-field affordance. So every static-kind proposal collapses to the transformer's single generic field. The fix is not "add a field to a form" — it is **re-admitting rich requirements through a bounded, validated, strongly-reviewed channel**, which is exactly what this rewrite designs (§connectionRequirementSchema, and Q2 for the trade-off).

## Design

### 1. The concept split: requirement vs. grant

The one-word summary of the whole rewrite. Today `snug_auth_specs` conflates two things with different writers, lifetimes, and trust:

- **Connection requirement** — *what the app needs*: provider, kind, field list with per-field metadata, registration walkthrough, endpoints/scopes, header/signing template, declared hosts. Credential-free. **Written at authoring moments only** (build, auth-touching edit, starter install; dev-time for starter manifests). This is what R1 bakes into the DB.
- **Connection grant** — *what the user allowed*: approved status, the **frozen** host ceiling, approval timestamp, revocation tombstone. **Written only by the wizard on explicit user approval** — ADR-0016's "approval is the only writer" survives, scoped to grants. Credentials live in `snug_secrets`, written only by the wizard's credential steps, custody per ADR-0014 unchanged.

An app can run with requirements and no grants (degraded pre-connect state, `NET_NOT_APPROVED`, connect CTA) — fail-closed exactly as today.

### 2. Trust ladder v2 → **ADR-0017** (amends ADR-0016, does not repeal it)

Unchanged and re-affirmed: **an app may never propose a connection at runtime** — no frame, no SDK call, no announce field. The runtime executor stays fail-closed. What changes:

| ADR-0016 clause | v2 status |
|---|---|
| Proposers: user / builder directive / install act | **Kept**, but the builder and install channels now carry the full `connectionRequirement` (bounded), and both **persist** it as a `declared` row at build/install time |
| "The declaration is never persisted" (clause 2) | **Amended**: requirements persist as credential-free `declared` rows. What must never persist without approval is a *grant*. Rationale: R1/R2 — the requirement must outlive the chat/session so the run surface never needs to re-derive it |
| "Approval remains the only writer" (clause 5) | **Refined**: approval remains the only writer **of grants** (status `approved`, frozen hosts, credentials). Builder/install writers may create/replace **`declared` rows only** and may NEVER touch an `approved` or `revoked` row (closes the recorded `putAuthSpec` fail-open-on-unapproved finding by construction) |
| Two-fact install vouch (clause 3) | **Kept at install time** (install_source + byte-match), but its *consequence* changes: once installed, the requirement is a persisted row in the user's DB, so **editing the app no longer withdraws the guided setup** — the owner-hit UX pain disappears. Edits instead flow through R3's re-infer rules |
| Strong review for inferred/declared content (clause 4) | **Kept and extended**: everything the richer channel carries (fields, registration steps, templates) renders **verbatim in the strong field-by-field review** before approval |
| Clause 6 prerequisites for untrusted channels | **Promoted into this task**: the provider-name charset/confusable guard and registry-borrow ban ship in Phase 0 (they were AL-10-queued; a rewrite of this surface must not rebuild on top of known holes) |

### 3. Storage — userdb schema **v4** (fresh start authorized; no migration)

Replaces `snug_auth_specs`. One table, slot-keyed for R6:

```sql
CREATE TABLE snug_connections (
  app_id              TEXT NOT NULL,            -- host-assigned, never app-claimed (R4 identity rule kept)
  slot                TEXT NOT NULL,            -- stable connection id within the app: ^[a-z0-9][a-z0-9-]{0,39}$, e.g. 'spotify'
  requirement_json    TEXT NOT NULL,            -- connectionRequirement (credential-free, bounded, validated)
  requirement_version INTEGER NOT NULL,         -- bumped on every accepted re-inference (R3)
  provenance          TEXT NOT NULL,            -- registry | inference | user_docs | starter | user
  confidence          REAL,                     -- inference confidence when provenance is model-derived
  status              TEXT NOT NULL,            -- declared | approved | revoked
  allowed_hosts       TEXT NOT NULL DEFAULT '[]', -- FROZEN union, computed at approval (unchanged semantics)
  approved_at         TEXT,
  revoked_at          TEXT,                     -- TOMBSTONE: survives; closes the revoke-reversal finding
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (app_id, slot)
)
```

Write rules (enforced in `packages/db` accessors, each a named error like today's `HostFreezeViolation`):

- `putDeclaredConnection(appId, slot, requirement, provenance)` — insert, or replace an existing **`declared`** row (that is the legitimate R3 re-infer path). Throws on `approved` (must go through re-approval) and on `revoked` (must go through the wizard's explicit "you revoked this before — reconnect?" act, which shows the tombstone date).
- `approveConnection(appId, slot)` — wizard-only: freezes `allowed_hosts` from the requirement, stamps `approved_at`, status → `approved`.
- `reapproveConnection(appId, slot, newRequirement?)` — the only widening path, full union diff shown, re-freeze (today's semantics, slot-scoped).
- `revokeConnection(appId, slot)` — status → `revoked`, `revoked_at` stamped, row KEPT, and the credential slice `auth:<appId>:<slot>:*` wiped.
- Credentials key: **`auth:<appId>:<slot>:<fieldKey>`** in `snug_secrets` (slot added); flow/state keys gain the slot likewise. Custody rules ADR-0014 byte-for-byte unchanged.
- `imported_unapproved` maps to: imported rows land `declared` with a `provenance` preserved and an `imported` flag in the requirement envelope, always re-reviewed strong (same posture as today).

### 4. Protocol — `connectionRequirementSchema` (the richer, bounded channel)

New in `packages/protocol` (SPEC_SYNC + staged v0.3 draft update; `llmProposalSchema` and the `auth_wizard` directive payload are superseded; the orphaned unbounded `authRequiredPayloadSchema` is **deleted** — also closes that queued item). Sketch (every bound explicit, every string charset-guarded; constants named like the existing `AUTH_*_MAX_*` family):

```ts
connectionRequirement = strictObject({
  slot,                                             // ^[a-z0-9][a-z0-9-]{0,39}$
  provider: { name (≤120, printable-ASCII guard — confusables rejected at the schema),
              homepageUrl?, docsUrl? (https, ≤300) },
  kind: 'api_key'|'bearer_token'|'basic_auth'|'oauth2_client_creds'|'oauth2_auth_code'|'none',  // 'none' pending Q6
  fields?: AuthField[] (max 8),                      // key ^[a-z0-9_]{1,40}$ · label ≤80 · type text|secret|password|url
                                                     // · description ≤200 · placeholder ≤60 · required
  registration?: { consoleUrl? (https, ≤300),
                   instructions?: string[] (max 10 × ≤300, plain text — rendered as <ol>, never as HTML/links) },
  endpoints? / scopes? / pkce? / authorizeParams?,   // OAuth kinds, current shapes + bounds
  request?: { headerTemplate? (max 8 entries; header name ^[A-Za-z0-9-]{1,64}$; value ≤300;
              value may reference ONLY declared field keys + the pinned helper enum {timestamp, hmac_sha256, base64}) },
  declaredApiHosts (max 32 × ≤253, hostname charset + punycode normalization — current bounds),
  testRequest?: { method:'GET', pathAndQuery ≤200 }  // optional "test this connection" probe — Q7
})
```

Validation is layered: Zod bounds at parse; a **template lint** pass (unknown `{{token}}` → reject; helper args must be field refs or literals); a **registry-borrow ban** (a requirement naming a registry provider gets the registry's endpoints/hosts/registration — declared values for those slots are discarded on registry hit, now for ALL kinds, fixing the v3-review BLOCKER that the discard existed only for OAuth); and the charset/confusable guard on `provider.name`.

### 5. Lifecycle flows

**Build (R1).** The builder LLM, in the build conversation: KB doctrine (rewritten `90-auth-and-connected-apis.md`) teaches it to (a) design against `useConnectedFetch`, (b) research the provider's auth via the docs ladder — pinned registry → model knowledge → user-pasted docs (the shipped rungs; desktop-native fetch stays a documented future rung), and (c) end the build reply with a `connection_requirement` directive carrying the FULL requirement — for Coinbase: three fields (`api_key`, `api_secret`, `passphrase`), the CB-ACCESS-* header template with `hmac_sha256`, the developer-console walkthrough, `api.coinbase.com`. The host validates (schema + lint + ladder) and **persists the `declared` row(s) when the app version is saved** — before first run. A build whose HTML calls `useConnectedFetch` but declares no requirement fails build validation (fail-closed at build, not at run). The chat card renders FROM the persisted row.

**Run (R2).** No inference surface exists at run time: the run-wizard's "infer from docs" affordance is REMOVED (the paste-docs rung lives in build/edit chat). Flow: app's call → `NET_NOT_APPROVED` → connect CTA → wizard reads the `declared` row → step machine (§UX) → approve (grant) → credentials → connected. If no row exists (legacy/misbuilt app), the wizard offers manual setup plus a "fix this in the app's edit chat" CTA — it never guesses.

**Edit (R3).** The edit pipeline: the builder re-emits the requirement set ONLY when its change touches the auth surface (KB skip-rules, ported from OProject's: skip when the edit is UI-only, when a valid requirement exists and no auth change was asked, when the same provider was already inferred this session). Deterministic backstop, not vibes: the host canonically hashes `requirement_json`; if the builder emits an identical requirement → no-op (version unchanged, grants untouched); if it emits a changed one → `putDeclaredConnection` replaces the `declared` row / flags an `approved` row for **re-approval with a field-by-field diff** (old grant keeps serving its OLD frozen hosts until the user re-approves — no silent widening); if it emits none and the HTML's connected-surface is unchanged → nothing happens. A `user`-provenance requirement (hand-confirmed in the wizard) is **never overwritten by inference** — OProject's `user_confirmed`-wins rule, adopted verbatim.

**Starter authoring (R4, dev time).** `connection.json` becomes the full `connectionRequirement` (same schema — one schema, three call sites). A dev-time script (`pnpm --filter examples infer-connection <folder>` or Claude Code running the same inferrer seam) generates it; it is human-reviewed in the PR like any first-party content; the validate suite validates every manifest against the protocol schema (today's pattern, richer shape).

**Starter install (R4, runtime).** The two-fact vouch (unchanged) runs once at install; on success the manifest is **copied into `snug_connections` as `declared` rows, provenance `starter`** — no credentials, ever. From then on the requirement is the user's own row: running works without any LLM configured (the zero-key grandma path), editing follows R3. Reinstall refreshes the requirement only if the row is still `declared` (an approved grant is never silently replaced).

**Revoke.** Tombstone semantics per §Storage; the wizard's reconnect-after-revoke path discloses the prior revocation.

**Multi-connection (R6).** Everything above is slot-scoped. `connected-fetch` gate 3 becomes: find the app's connection whose frozen `allowed_hosts` contains the target host; zero matches → `NET_NOT_APPROVED` (with the slot-aware CTA naming the provider that WOULD match a declared row); two matches → deterministic `NET_AMBIGUOUS_CONNECTION` error (never guess between credentials). Ship with the KB doctrine still teaching one connection per app; lifting it later is a doctrine + review change, not a schema change.

### 6. UX — the grandma wizard (rebuild on Snug components, OProject's step grammar)

State machine per slot (extends the shipped wizard store, replaces the single-sheet layout):

```
review → register → credentials → connect (OAuth only) → done
```

- **review** — the strong field-by-field review, always shown for `inference`/`user_docs`/`starter`/imported provenance (registry rung may keep the light path, per shipped ADR-0016 ladder). Renders EVERYTHING the requirement carries: provider, kind in plain words ("this app signs in with your Spotify account" / "this app uses three secret values from your Coinbase settings"), each field's label+description, the registration steps, the header template verbatim in a code box ("exactly what this app will send"), and the complete host list with the freeze copy (today's). Honest provenance copy stays split (the AL-09 live-sweep fix carries over): model-inferred → "proposed by a model — it is a guess, not an authority"; starter → "ships with this starter — review before you approve". Confidence < 0.7 adds the lower-confidence band (OProject's calibration move).
- **register** — only when `registration` exists or the kind needs a dev app: numbered `<ol>` walkthrough, a "open the {provider} dashboard" affordance (Q3 decides link vs. copy-only), and for OAuth the generated redirect URI in a code box with a copy button + the shipped "register once per provider" explainer. Primary button: **"I've got my credentials"** (verb-named, one decision).
- **credentials** — one masked input per field (reveal toggle, paste-trim), `description` under each, per-field placeholder. Save is write-only into `snug_secrets` (unchanged).
- **connect** (OAuth kinds) — popup + status states lifted from OProject's grammar: "waiting for {provider} sign-in…", closed-without-finishing recovery ("sign-in window closed — if you didn't finish, start again"), success with "connected to {provider}". BroadcastChannel + poll backstop are already shipped in `oauth-service`/wizard — reuse.
- **done** — status card; optional **test call** if the requirement carries `testRequest` (Q7): runs through the REAL connected-fetch executor and shows pass/scrubbed-fail.
- **Settings → Connections** becomes slot-aware: one row per (app, slot) with provider, kind, status pill (`declared — not connected` / `connected` / `revoked` / `needs re-approval`), and per-row connect/re-approve/revoke. The run-header `run-connect` button and chat card open the same wizard.
- Copy register: Snug's lowercase voice; custody line everywhere credentials are collected: **"your keys stay in your file on this device — they never reach our servers"** (exact ADR-0014 claim discipline).

### 7. Security posture — what the richer channel costs and how it's paid

New attack surface admitted by R5 (each mitigation is an AC in the phases):

| Surface | Mitigation |
|---|---|
| LLM-authored `headerTemplate` chooses where secrets are placed | Template lint (declared-field refs + pinned helpers ONLY); rendered host-side at injection only, to frozen-ceiling hosts only; displayed **verbatim** in the strong review; registry-borrow ban means registry providers can't have theirs overridden. Residual risk (a hostile-but-approved template routes a secret into an odd header of an allowed host) is disclosed in the threat-model delta — the host ceiling still bounds WHO receives it |
| LLM-authored `registration.instructions` as a phishing channel ("go to evil.example and enter your bank password") | Plain-text rendering (never links/HTML), length-bounded, shown inside the strong review; `consoleUrl` is https-only, ≤300, rendered with the FULL host visible (Q3 decides click vs copy); registry providers always use pinned registry walkthroughs |
| Provider-name confusables borrowing trusted display names | Charset guard at the schema (printable ASCII) + normalization — promoted from AL-10 to Phase 0 |
| Builder writes rows without user action | Rows land `declared` only — grant nothing, inject nothing, fail-closed executor unchanged; strong review before any grant |
| Re-declaration reversing a revoke | Tombstone row + credential-slice wipe + explicit reconnect disclosure |
| Requirement churn thrash on edits | Canonical-hash no-op rule + `user`-provenance-wins rule + approved rows immutable outside re-approval |

Unchanged and re-asserted as regression ACs: the 10-gate executor order, scrub, SSRF, redirect-block, mutating-confirm, credential-shaped-header strip, https-only, frozen ceiling, `netErrorCta`'s off-ceiling `null` (M12), C1/C2 iframe posture, ADR-0014 custody + export stripping, inference-never-sees-credentials (structural: inference happens before credentials exist; the docs-paste tripwire stays). The AL-10-queued session-binding open question (AC5(b), `expectedFlowId` vs `expectedSessionId`) is **resolved in Phase 1** while the oauth-service is open on the bench.

## What survives, what's rewritten, and AL-09's disposition

**Survives (extend, don't rewrite):** `connected-fetch.ts` (slot routing in gates 3/4; everything else intact), `oauth-service.ts` (+ binding fix), `template-engine.ts` (already has `hmac_sha256`/`timestamp`), `credential-store.ts` (slot in keys), `scrub.ts`, the registry's posture (never default scopes, never runtime discovery) extended with static-kind entries + more providers (coinbase, openweather, coingecko carrying `fields` + `registration` walkthroughs), the wizard store's session machinery, Settings card bones, the OAuth popup/callback plumbing incl. the shared-redirect-URI explainer, the KB's C1 teachings.

**Rewritten:** auth tables (v4), proposal/directive schema (requirement), inferrer prompt + output (full requirement, not hints), `params-to-auth-spec` (registry-first for all kinds, requirement passthrough), wizard UI (step machine), KB `90-auth` doctrine (build-time emission + skip-rules + completeness bar: "declare every field the provider requires — a key without its secret is a defect"), starter manifests, validate suite's manifest checks.

**AL-09 (recommendation, Q8):** harvest, don't merge. The five starter apps' HTML, the shelf looks, the Hue posture, the registry Spotify polish, and the `bearer_token` coverage are all reusable nearly as-is; the manifests and every auth-flow test rebuild on the new schema. The branch stays parked as the harvest source; its unreviewed last-five-commits concern dissolves because that surface is rewritten anyway.

## Implementation phases (each = child task, branch, TDD, fresh-context review per house process)

- **P0 — doctrine + contracts** (High): ADR-0017 text (Q1 amendment table); `connectionRequirementSchema` + bounds + template lint (Q2) + confusable guard + registry-borrow-ban for ALL kinds in `packages/protocol`/`packages/auth`; the `none` kind in the union (Q6); userdb v4 DDL + accessors with the write-rule errors + tombstone; the DDL-replay self-healing guard absorbed from `docs/next-steps.md` (Q9); SPEC_SYNC staged-draft update; delete `authRequiredPayloadSchema`/`llmProposalSchema` (with the validate-suite import moved to the new schema). *Exit: contracts green, mutation-evidenced write rules AND template lint, self-heal proven against a stale-v3 fixture DB, no UI yet.*
- **P1 — runtime** (High): slot routing in connected-fetch (+ `NET_AMBIGUOUS_CONNECTION`); slot-keyed credential store; oauth-service session-binding resolution; property/negative tests incl. cross-slot theft (slot A's credential can never inject into slot B's host). *Exit: executor green against multi-slot fixtures; all current negative tests still pass.*
- **P2 — build/edit pipeline** (High): `connection_requirement` directive emission + host-side validation + persist-on-version-save; build-validation gate (connected HTML ⇒ requirement); edit skip-rules + canonical-hash delta + re-approval flagging; KB doctrine rewrite (prompt-engineering reference first, per standing memory); inferrer re-prompt to full requirements with a Coinbase-shaped eval case. *Exit: chat-building a Coinbase app lands a 3-field declared row with template + walkthrough before first run; UI-only edit provably no-ops (hash test).*
- **P3 — wizard UX** (Med): step machine + screens + copy (§UX); Settings slot rows; run CTA/chat card wiring; remove run-time inference affordance; Playwright journeys for api_key-multi-field, bearer, basic, oauth (stub host pattern unchanged: authored hosts real, e2e injection via the mapped stub project). *Exit: the grandma walkthrough exists end-to-end on stubs; live sweep.*
- **P4 — starters + registry** (Med): registry entries (coinbase/openweather/coingecko + walkthroughs); dev-time inference script; regenerate five manifests; install-act copy-to-rows + provenance `starter`; harvest AL-09 apps/tests. *Exit: install → connect on a zero-LLM profile; validate suite green on rich manifests.*
- **P5 — security close** (High): threat-model delta doc (new surfaces table above, with the residual risks stated); fresh-context adversarial review of the whole surface; live sweep; fold; re-record test counts. *Exit: review verdict folded; umbrella ACs re-checked (the three OProject audit bugs remain named ACs).*

Sequencing is strict P0→P5 for the spine; P4 can interleave after P2. Every phase ends with root suites + Playwright green; shared literals pinned in both task files before any fan-out (house lesson).

## Owner decisions — ANSWERED 2026-08-10 (all nine on the tabled recommendation)

These are now binding constraints on the phases below, not open questions. Each line records the decision and what it obliges.

- **Q1 — ADR-0017 posture. DECIDED: approve the split.** Requirements persist as credential-free `declared` rows; approval remains the only writer of *grants*. ADR-0016 clauses 2 and 5 are amended as tabled in §2. *Obliges: P0 writes ADR-0017 with the amendment table verbatim.*
- **Q2 — LLM-authored header/signing templates. DECIDED: admit, with the full mitigation set.** Bounded at the schema, template-linted (declared field refs + the pinned helper enum `timestamp|hmac_sha256|base64` only), rendered verbatim in the strong review, registry-borrow ban for ALL kinds. This is the decision that makes Coinbase work and that keeps Snug out of the connector-catalog model. *Obliges: P0 ships the lint with mutation evidence; P5's threat-model delta must state the residual risk explicitly — a hostile-but-approved template can route a secret into an odd header of an already-allowed host, bounded only by the frozen host ceiling.*
- **Q3 — inferred `consoleUrl` rendering. DECIDED: split by provenance.** Registry providers render a clickable link (URL pinned by us); `inference`/`user_docs`/`starter` providers render copy-only with the full URL visible. *Obliges: P3's register screen branches on provenance, with a test per branch.*
- **Q4 — multi-connection at 1.0. DECIDED: slot-ready + doctrine cap.** Schema, runtime, and UI are slot-keyed; KB doctrine still teaches one connection per app. *Obliges: P1 ships `NET_AMBIGUOUS_CONNECTION` and the cross-slot theft test even though doctrine caps at one.*
- **Q5 — run-time repair path. DECIDED: strict R2.** No inference surface exists at run time. A missing row yields manual setup plus a "fix this in the app's edit chat" CTA; the wizard never guesses. *Obliges: P3 REMOVES the shipped "infer from docs" affordance (`wizard.ts:660–680`) rather than gating it.*
- **Q6 — `none` kind. DECIDED: include now.** The keyless kind ships in the v4 union; approval still gates network. *Obliges: P0's union includes `none`; P1 proves a `none` connection still fails closed until approved.*
- **Q7 — test-connection probe. DECIDED: static kinds yes, OAuth deferred.** `testRequest` ships for static kinds as one governed GET through the real connected-fetch executor, pass/scrubbed-fail. OAuth defers — the token mint already proves liveness. *Obliges: P3's done screen is conditional on kind; the probe must not become a second network path around the 10 gates.*
- **Q8 — AL-09 branch. DECIDED: harvest, don't merge.** The branch stays parked at `86a564c` as the harvest source; it is never merged to `main`. Reusable nearly as-is: five starter apps' HTML, the shelf looks, the Hue posture, the Spotify registry polish, `bearer_token` coverage. Rebuilding on the new schema: every manifest, every auth-flow test. *Obliges: P4 names each harvested artifact as it lands; the deferred owner review of AL-09's last five commits is moot for merge purposes — that surface is rewritten — but the harvested HTML still gets reviewed as it comes across.*
- **Q9 — schema v4 fresh start. DECIDED: no migration; absorb the self-healing guard into P0.** Existing local DBs self-heal via the queued DDL-replay guard rather than erroring. *Obliges: P0 absorbs the owner-hit guard queued at `23266fc` in `docs/next-steps.md`; it stops being an AL-10 candidate.*

## Out of scope (unchanged by this rewrite)

Broker/subscription custody (1.6→2.0) · desktop runtime + LAN connectors (Hue stays authored + greyed) · publish/marketplace flows · auth spec PUBLICATION (staging only; Beta-exit gate stands) · background/polling connectors · multi-account-per-provider (OProject defers this too; slots are per-provider, not per-account, at 1.0).

## Shared literals pinned (for the implementing sessions)

Table `snug_connections` · statuses `declared|approved|revoked` · provenance `registry|inference|user_docs|starter|user` · secret keys `auth:<appId>:<slot>:<fieldKey>` · slot charset `^[a-z0-9][a-z0-9-]{0,39}$` · directive kind `connection_requirement` · schema export `connectionRequirementSchema` · new net code `NET_AMBIGUOUS_CONNECTION` · helper enum `timestamp|hmac_sha256|base64` · manifest filename stays `examples/<folder>/connection.json` (shape upgraded).

## Session journal (append-only, newest last)

### 2026-08-10 — Claude (orchestrator) — Gate 1+2: owner redirect received; both systems mapped; this plan written

- Owner redirected AL-09 at `/pickup`: rethink the whole dynamic-auth flow (rules R1–R8 above), OProject's UX as the bar, fresh start authorized, comprehensive plan requested for a fresh-session pickup. This entry is the plan's provenance record.
- Evidence gathered this session: full re-read of AL-09's task file + handoff; `internal/03-audit-auth.md`; ADR-0014/0016; roadmap §Dynamic Auth; two deep source maps (OProject wizard/inference/lifecycle with verbatim copy + file:line cites; Snug auth surface across protocol/auth/db/playground/KB). Baseline re-verified: root `pnpm test` 19/19 (turbo cache replay of the handoff-day run), AL-09 branch clean @ `86a564c` = origin, unmerged, no PR.
- Root cause of the owner's Coinbase defect pinned at source (§Root cause): expressible in the spec + runtime, unproducible by any authoring path — the AL-04 `llmProposalSchema` exclusions.
- Owner questions Q1–Q9 tabled with recommendations. NEXT STEP: owner answers → fold → fresh-context plan review (house bar; it has found real blockers on five consecutive children) → P0.

### 2026-08-10 — Claude — `/pickup`: Q1–Q9 answered and folded; plan is decision-complete

- Pickup verification: branch `feat/TASK-20260810-dynamic-auth-rewrite` clean and in sync with origin at `837abeb`. Baseline re-run live (not asserted from the journal): root `pnpm test` **19/19 packages green**, playground 512 tests, FULL TURBO cache replay — matches the recorded handoff-day baseline.
- Diff-vs-journal check: `git diff main...HEAD --stat` shows 32 files / +4,420 lines, which the plan's Branch line explains — this branch was cut from the AL-09 tip `86a564c` so the umbrella journals would not fork, so the bulk is AL-09's unmerged work riding along. This task's own commit `837abeb` is docs-only (4 files). **No lost context; nothing in the diff is unexplained.**
- **Owner answered all nine decisions, each on the tabled recommendation.** Recorded in §Owner decisions with the obligation each one places on a phase. The four load-bearing ones: Q2 admits LLM-authored header/signing templates with the full mitigation set (this is what makes Coinbase work, and what keeps Snug out of the connector-catalog model the roadmap rejects); Q1 approves the requirement/grant split as ADR-0017; Q8 parks AL-09 as a harvest source, never merged; Q4+Q6 take the cheap schema window (slot-ready keying + the `none` kind) while it is still cheap.
- Folded consequences beyond the answer list: P0's exit criteria now name the template-lint mutation evidence (Q2), the `none` kind (Q6), and the DDL-replay self-healing guard absorbed from `docs/next-steps.md` `23266fc` (Q9) — that guard is no longer an AL-10 candidate. Q5 is recorded as a REMOVAL, not a gating, of the shipped run-time "infer from docs" affordance at `wizard.ts:660–680`, so P3 cannot satisfy it by hiding the button.
- Status moved PLANNED-awaiting-answers → PLANNED-decision-complete. **NEXT STEP: the standing fresh-context plan review (High tier), then P0.** No implementation code was written this session — the house bar puts the review before the first phase, and it has found real blockers on five consecutive children.
