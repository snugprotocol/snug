# TASK-20260805-auth-core: Dynamic Auth port part 1 — the pure core (umbrella child AL-02)

- **Status**: in-progress (plan APPROVED via fresh-context review: v1 REJECT → v2 APPROVE-WITH-CHANGES → v3 all mandatory amendments folded; owner's umbrella approval pre-approves)
- **Owner**: Jeetu (autonomous run; Claude implements)
- **Risk tier**: **high** (packages/protocol + packages/auth + credential custody — auto-escalated; plan review completed pre-implementation per PROCESS)
- **Branch**: `feat/TASK-20260805-auth-core`
- **Packages touched**: `protocol` (High), `db` (Med), `auth` (new), docs
- **Spec impact**: internal draft — snug_auth_specs DDL + auth schema in protocol, OUT of json-schemas SOURCES; spec-changelog entry marked internal-draft; staged v0.3 prose is AL-12
- **Related**: TASK-20260805-alpha-umbrella (AL-02) · ADR-0013/0014 (AL-01, merged) · internal/03-audit-auth.md · roadmap A2


> v3 (2026-08-05): v2 re-review verdict **APPROVE-WITH-CHANGES**; all four mandatory amendments (N1, N2, N3, finding-5 residual) + all advisory items folded inline below. This version is implementation-ready once AL-01 (ADR-0014) merges. v1 REJECT + v2 re-review preserved in reviewer transcript.
> **Escalation clause (finding 1 residual):** if the merged ADR-0014's custody wording is WEAKER than D3, implementation HALTS and escalates to the owner — D3 never silently adapts to a weaker ADR. The authority arrow points from this reviewed plan to the ADR check, not the reverse.

## Spec (what & why)

Port the Dynamic Auth **pure core** from the two source systems into Snug, local-first: the auth spec schema, the pinned well-known-provider registry, the header template engine, the deterministic params→spec transformer, and the DI-pure OAuth service (PKCE default, refresh/rotation/revoke) — re-seated on Snug's `snug_secrets`-backed local credential store. No server vault, no inference, no UI (AL-03/04), no connected-fetch runtime (AL-03). Audit bugs 1+2 are fixed HERE with named ACs; **bug 3 (strict host injection) is explicitly AL-03's AC** — this child's contribution is that `packages/auth` exposes no strictness knob anywhere (finding 4). Skill identity is an opaque `appId`; branded tenant/user types dropped.

**Hard dependency:** AL-01's ADR-0014 (local-first credentials doctrine) must be MERGED first and must state the precise custody line (see D3); every security-relevant header in this child references that real ADR number (finding 1). If AL-01 lands it as a different number, update references before implementation.

## Design decisions (pinned; reviewer-verified v2)

**D1 — Schema placement: `packages/protocol`, INTERNAL surface (finding 9).** Zod auth-spec schema + `snug_auth_specs` DDL constants live in `packages/protocol/src/auth-schema.ts` (types) + `userdb-schema.ts` (DDL), following the userdb precedent EXACTLY: **NOT added to `json-schemas.ts` `SOURCES`** (that export set is the publishes-to-spec line; auth stays out until the Beta gate), locked instead by an in-package snapshot/stability test. The two-layer `userLayer` shape ships marked `@draft — runtime deferred (TWO_LAYER_RESOLUTION_DEFERRED); publication gated at Beta exit` in code comments. `USERDB_SCHEMA_VERSION` bumps (v3) in THIS child — the table + migration are one coherent storage change and the migration machinery requires it — with the spec-changelog entry explicitly marked **internal draft, excluded from the A12/AL-13 push**. Strictness split (finding 12): `.strict()` applies at the RUNTIME validation boundary (ingest fail-closed); any future PUBLISHED schema artifact follows R2 forward-compat (`io:'input'`, no `additionalProperties:false`) — two artifacts, never conflated; a code comment at the schema site records this.

**D2 — Kind-set + host semantics, fully specified (finding 5 + N4 + finding-5 residual).** OProject's 5-kind enum + `userLayer` embedding; IProject's `.strict()` ingest posture. **The five kind literals, pinned verbatim (persisted discriminators — shared with AL-03/04, never retyped):** `api_key` · `bearer_token` · `basic_auth` · `oauth2_client_creds` · `oauth2_auth_code`. Host model — two named objects, never conflated:
- `declaredApiHosts: string[]` — the API hosts the spec asks to call. REQUIRED non-empty for `api_key`/`bearer_token`/`basic_auth`/`oauth2_client_creds`. For `oauth2_auth_code`: the well-known registry entries are EXTENDED in this child with a human-reviewed `apiHosts` list per provider (the ported registry carries only OAuth endpoints — verified; the Spotify entry gains `api.spotify.com`, etc.); `declaredApiHosts` may be empty ONLY when the registry supplies `apiHosts`, otherwise required — the branch now points at data that exists.
- `frozenAllowedHosts` (the `snug_auth_specs.allowed_hosts` column) — computed AT APPROVAL as `declaredApiHosts ∪ registryApiHosts ∪ derivedOAuthEndpointHosts(authorizeUrl, tokenUrl, refreshUrl, revokeUrl)` (**`refreshUrl` included — N2**; it is the endpoint that receives long-lived credentials), **displayed in full to the user at approval**, then frozen. The injection/refresh host set at runtime IS `frozenAllowedHosts`. Tests cover: derived-host merge incl. refreshUrl, display completeness, refresh-host-in-ceiling.

**D3 — Custody line, stated honestly (finding 2 — was BLOCKER).** Values under `snug_secrets` keys `auth:<appId>:<field>`; spec metadata in new `snug_auth_specs`. The custody rule (must match ADR-0014's corrected wording): **hub origins NEVER receive secrets** (existing strip + VACUUM path); **personal sync origins the user explicitly connects (Dropbox) carry the full file INCLUDING `auth:` values** — deliberate, opt-in, the cross-device story, consistent with BYOK keys which already behave this way; default exports strip, full export is an explicit opt-in. The launch claim is the hub-custody claim ("your keys never reach our servers; your file goes only to storage you choose"), never the absolute "never leave your file". NO new stripping code path — but the TESTS now cover all four paths (finding 2): (i) hub push carries no `auth:` bytes; (ii) default export carries no `auth:` bytes; (iii) Dropbox push DOES carry them **only** under `secretsAllowed` gating — asserted as deliberate with a test named `custody-line.dropbox-carries-secrets-by-design`; (iv) full export opt-in carries them. Byte-probes, not API asserts.

**D4 — CredentialStore seam.** `packages/auth/src/credential-store.ts`: interface + `UserDbCredentialStore` impl over the secrets quartet + new spec-table accessors in `packages/db`. Auth runtime depends only on the interface. **No long-lived plaintext token cache** (finding 10): tokens are read from the store per use; `disconnect()` deletes them; a lifecycle test drives connect→use→disconnect and asserts no retained copy serves a post-disconnect call.

**D5 — Host-freeze at the DB write boundary + import reconciliation (finding 3 — was BLOCKER; amended per N1/N2).**
- The freeze invariant is enforced IN `packages/db`'s `snug_auth_specs` accessor — the only writer of that table. Ordinary update rejects **any change to the DERIVED HOST UNION, not just the `allowed_hosts` column (N2)**: the accessor recomputes the union over the incoming spec's endpoints (authorize/token/refresh/revoke) + declared/registry API hosts; if it differs from the frozen set → `HostFreezeViolation`. Widening happens only via `reapproveAuthSpec()` (new `approved_at`, full host list re-displayed). Defense in depth (N2b): the OAuth service ALSO validates the target host ∈ `frozenAllowedHosts` before EVERY outbound token/refresh/revoke POST — a spec whose refresh host escaped the ceiling cannot refresh. Tests: approve → ordinary-update edit of `tokenUrl` host → rejected; service-level refresh-outside-ceiling → rejected.
- **Import-time reconciliation — DELTA-AWARE (N1):** the pass lives INSIDE `importUserDb` (covering pull-merge, applyRemote, recovery restore, and UI import for free). Before swapping DBs, snapshot local `snug_auth_specs`; after import, RESTORE local `status`/`approved_at` for rows whose `(app_id, spec, allowed_hosts)` are byte-identical to a locally-approved pre-import row; demote to `imported_unapproved` only NEW or CHANGED rows. (Identical rows carry zero attack surface; blanket demotion would nuke approvals on every routine two-device pull and train approval fatigue.) Validation failures: unknown-keys-only failures **demote-and-preserve** (R2 at the import boundary — an older hub must not destroy a newer hub's additive data); structurally unusable rows are dropped + surfaced. Credential injection is barred while `imported_unapproved` (AL-03 reads `status`). Tests: doctored widened-hosts import → never honored; **byte-identical re-import → approval SURVIVES**; unknown-key row → preserved + demoted.
- Honest future note (finding 13): single-actor today; a publisher model (2.0 broker) needs a real migration — the "slots in without schema change" claim is DROPPED.
- **State placement (N3):** `snug_auth_specs` holds ONLY approval-stable spec metadata. Two other persisted shapes get explicit homes: **connection dynamic state** (`obtained_at`/`expires_in`/`status`/`lastError`/`scopesGranted`) → secret key `auth:<appId>:_connection` (export-stripped, Dropbox-carried per D3); **pending flow state** (state token, flowId, pkceVerifier, expiry) → in-memory in the initiating context, spilling only to `auth:_flow:<flowId>` secret keys with TTL cleanup. NEITHER ever touches `snug_auth_specs` — a token refresh must not dirty the synced table (content-hash gate) nor change default-export bytes. Test: refresh → `snug_auth_specs` content unchanged in default-export bytes.

**D6 — OAuth service port, async-first, seamed (findings 6, 7, 8).**
- **Async-first crypto core:** `signState`/`verifyState`/`pkceChallenge` and all template-engine helpers (`base64`/`sha256`/`hmac_*`) return Promises, built on WebCrypto (`crypto.subtle`, `getRandomValues`) with a shared browser-safe `base64url` helper (no `Buffer` anywhere; test: encode/decode round-trip + RFC 4648 vectors). `renderAuthHeaderTemplate` is async in its PUBLIC signature from day one (AL-03 consumes it async — no sync→async break later). Constant-time compare preserved across the rewrite with a dedicated test. `AbortSignal.timeout` usage pinned as browser-OK.
- **Flow binding (bug 2, reshaped per finding 7):** no fake "session". `generateAuthUrl` mints a per-flow random `flowId`, stored in the state row and returned to the caller (it becomes the BroadcastChannel/popup channel identity in AL-04). `handleCallback` REQUIRES `expectedFlowId`; mismatch → typed error. The bug-2 test drives TWO concurrent flows and proves flow A's callback cannot complete against flow B's expectation — a value the system owns and can genuinely mismatch, not caller-invented theater. State nonce stays single-use + TTL'd; PKCE binds start↔exchange.
- **Bug 1:** callback path unwraps `userLayer` for two-layer specs; test drives a two-layer spec through start→callback to completion. (Runtime two-layer resolution beyond the OAuth loop stays deferred per `TWO_LAYER_RESOLUTION_DEFERRED`.)
- **CallbackTransport seam NOW (finding 8):** AL-02 defines `RedirectUriProvider` (produces the `redirect_uri` used in BOTH `generateAuthUrl` and the token exchange — must be identical) + `CallbackSink` (delivery of the returned `code`/`state` back into `handleCallback`). Implementations: test-fake here; hosted-origin route + popup/BroadcastChannel in AL-04; localhost loopback when desktop returns. The redirect URI is a launch-visible contract (Spotify BYO registration) — its shape is decided by the provider seam, not hardcoded. `access_type=offline&prompt=consent` become per-provider registry options (Google-isms, applied only where the registry says so), not hardcoded.
- Branded types dropped; `SkillType` → opaque `appId`; state HMAC key generated per-user, stored at `auth:_state_hmac`, reused for NOTHING else. PKCE S256 default; refresh 60s skew + rotation tolerance; best-effort revoke.

**D7 — Ported near-verbatim (with source tests adapted):** `well-known-providers.ts` (+ per-provider consent-param options per D6), `template-engine.ts` (async per D6), IProject's `resolveAuthMode` as `auth-mode.ts`, `params-to-auth-spec.ts` rewritten per D2, IProject's freeze predicate as `app-host-freeze.ts`.

**NOT ported:** OProject `skill-auth-service.ts`, `token-vault.ts`, Postgres repos, inferrer/wizard/routes.

**Forward constraint registered for AL-04 (finding 14 + finding-7 residual):** credential values never enter `snug_chat_messages` (any field incl. `meta`), app-attached chat context assembly, or inspector state. AL-02 provides the choke-point: the CredentialStore is the only reader of `auth:` values, and a **canary** test (named as such) byte-probes a simulated post-wizard chat export for a known secret value — mutation-checked by deliberately writing a secret into chat `meta` in test setup to prove the probe CAN go red. Also: **AL-04's caller must supply `expectedFlowId` from its own held copy, never parsed out of the callback payload/state** — parsing it from the callback makes the binding tautological. Both constraints copied into AL-04's task file at creation.
**Status enum as protocol constants (N5):** `imported_unapproved` and the full `snug_auth_specs.status` enum are exported constants in `packages/protocol/src/auth-schema.ts` — AL-03 imports them; never prose-only literals.
**Spec-draft annotation (finding-9 nit):** the docs step annotates `docs/spec-drafts/spec-v0.2-userdb.md` ("reference implementation carries an internal v3 draft table; v0.2 describes v2") so AL-13's push isn't self-contradicting.

**Forward constraint registered for AL-03 (finding 4):** host injection is always-strict BY CONSTRUCTION — no env var, no flag, no config surface (C1). Named AC in AL-03; copied into its task file at creation.

## Files to touch (order)

1. `packages/protocol`: `auth-schema.ts` (new, internal surface per D1) + `userdb-schema.ts` (table DDL, v3 bump, migration) + in-package snapshot tests. NOT in `json-schemas.ts` SOURCES. → spec-changelog entry (marked internal draft).
2. `packages/db`: spec-table accessors with freeze enforcement (D5) + import/sync-restore reconciliation pass + custody-line byte-probe tests (all four paths, D3) + secrets-namespace helpers.
3. `packages/auth`: base64url helper → credential-store → auth-mode → well-known-providers → template-engine (async) → params-to-auth-spec → app-host-freeze → oauth-service (D6). Tests FIRST per file.
4. `docs/`: code-map rows, architecture graph, spec-changelog, task file journal; ADR-0014 reference check.

## Test plan (tests first; AC → test)

- AC1 schema: 5-kind validation incl. `.strict()` ingest rejection; `declaredApiHosts` required rules per kind (D2); `userLayer` draft shape; snapshot stability; NOT exported to `schemas/` (a test asserts the export set is unchanged).
- AC2 custody: the four byte-probe paths of D3 (hub push / default export / dropbox push / full export).
- AC3 freeze + import: `HostFreezeViolation` on ordinary widen; `reapproveAuthSpec` path; **import of doctored DB → `imported_unapproved`, widened hosts never honored** ; invalid rows dropped+surfaced; sync-restore runs the same pass; approval displays the complete frozen host list (D2).
- AC4 oauth: PKCE start→callback with fake provider through the CallbackTransport seam; **bug-1** two-layer completion; **bug-2** two-concurrent-flows mismatch rejection; state single-use + TTL; refresh skew/rotation; revoke best-effort; forged state (any other key) fails `verifyState` (finding 11); `auth:_state_hmac` absent from default-export bytes (finding 11); token-cache lifecycle (D4/finding 10); redirect_uri identical in authorize URL and token exchange.
- AC5 C1 surface: no strictness/skip-validation parameter anywhere in exported API (signature walk); no `process.env` in `packages/auth`; no `Buffer`/`node:crypto` imports (browser-safety lint test).
- Mutation-check every guard test (revert → red → restore), recorded in journal.

## Cross-package impact
protocol (High → full graph), db (Med), auth (new, High). No runner/server/playground code changes. Root + Playwright stay green.

## Spec-sync impact
Protocol touched → spec-changelog entry (internal draft, v3 storage schema + auth shapes; excluded from AL-13's v0.1+v0.2 push). Staged v0.3 prose is AL-12.

## Reviewer re-check requests (v1 → v2 delta)
1. Finding 1 → hard dependency on merged ADR-0014 + reference check step.
2. Finding 2 → D3 rewritten: honest custody line, four-path byte-probe tests, no false "stripping is free" claim.
3. Finding 3 → D5: freeze at db write boundary; import/sync-restore reconciliation with `imported_unapproved` status contract for AL-03.
4. Finding 5 → D2: two named host objects, per-kind rules, approval-display completeness, refresh-in-ceiling.
5. Finding 6 → D6 async-first, base64url helper, async template signature now, constant-time test.
6. Finding 7 → `expectedFlowId` per-flow nonce with two-concurrent-flows test.
7. Finding 8 → RedirectUriProvider + CallbackSink seams in AL-02; consent params per-provider.
8. Finding 9 → schemas out of `SOURCES` export; in-package snapshots; draft markers; bump justified + marked internal.
9. Findings 4/10/11/12/13/14 → folded as written above.

## Decisions & surprises

(running)

## Session journal (append-only, newest last)

### 2026-08-06 — Claude (Fable 5, orchestrator) — task instantiated
- Plan v3 (above) instantiated post-review; AL-01 merged (PR #5) so ADR-0014 exists on main — implementer must run the D3-vs-ADR-0014 check FIRST (escalation clause).
- Next step: implementation, tests first.
