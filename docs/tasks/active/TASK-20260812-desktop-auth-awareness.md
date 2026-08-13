# TASK-20260812-desktop-auth-awareness: Desktop-aware dynamic auth — platform truth in prompts/inference, registry request seats, Coinbase CDP repair, Spotify opener fix, Hue LAN connector

- **Status**: in-progress — P0 (plan approved by owner 2026-08-12)
- **Owner**: jeetu
- **Risk tier**: **high** — `packages/auth` (registry, executor, admission), `packages/protocol` (request-template seats → spec-sync), `packages/knowledge` (LLM-bound prompts), C1-adjacent (new signing paths, LAN TLS trust); auth/protocol auto-escalate
- **Branch**: `fix/TASK-20260812-desktop-auth-awareness` (off `main`)
- **Packages touched**: `protocol` (request template seats: queryTemplate + jwt function grammar), `auth` (registry seats + Coinbase/Hue entries, executor signing + LAN TLS policy, admission substitution), `knowledge` (KB copy + platform layer + inferrer prompt), `playground` (assembly wiring, wizard, net observer, starters glue), `desktop` (opener capability, pinned-TLS LAN fetch), `examples` (weather-planner, crypto-portfolio, hue-lights-party), docs
- **Spec impact**: **yes (internal staged draft only)** — `connectionRequestSchema` gains `queryTemplate`; template grammar gains a JWT signing function; **and (P0 finding lan-schema-2) `connectionRequirementSchema` gains an optional `lanHost` seat with `declaredApiHosts` becoming required-XOR-`lanHost`** (superRefine; emitter/admission/host-trigger updated). Follow SPEC_SYNC into `docs/spec-drafts/` v0.3 staging + spec-changelog entry; **nothing pushed to `snugprotocol/spec`** (AL-12 held).
- **Related**: ADR-0017/0020/0021; TASK-20260812-desktop-hub-scaffold (PR #41); TASK-20260810-dynamic-auth-rewrite; next-steps 2026-08-12 (BYOK CORS advisory; desktop follow-up 7 "Hue/LAN starter"); new ADR-0022 (registry request/testRequest seats + signing functions + auth-shaped failure surfacing) and ADR-0023 (LAN-class providers: user-supplied bridge host, pairing, TLS trust) — drafted in this task

## Spec (what & why)

The desktop shell (ADR-0021) shipped native CORS-free fetch, the RFC-1918 LAN rung, and
loopback OAuth — but the dynamic-auth intelligence layer doesn't know it, one desktop
capability grant is broken, and the registry's Coinbase entry encodes an expired
credential scheme. Owner-reported 2026-08-12, **all repro'd in the desktop shell**:

1. **Authoring brain denies desktop capabilities.** The KB literally teaches "desktop-native
   fetch is a FUTURE rung that does not exist yet" (`90-auth-and-connected-apis.md:60-62`)
   and "blocks private ranges" (`20-html-template.md:288`), and **no platform signal reaches
   any prompt** — so the model told the owner LAN pairing is impossible on a platform where
   it is implemented and tested (`connected-fetch.ts:712-729`).
2. **Spotify starter, desktop: "could not open your browser for the sign-in — try again".**
   Deterministic: `capabilities/main.json:12` grants `opener:allow-open-url` **with an empty
   URL scope** (the scope lives in `opener:allow-default-urls`, absent), so tauri-plugin-opener
   rejects every `openUrl` incl. the Spotify authorize URL; the wizard's bare `catch {}` at
   `connectionWizard.ts:1159` swallows the cause. Tests were green because the desktop test
   mocks `../oauth.js` wholesale and the capability belt test asserts only the http scope.
3. **Authored Coinbase app: portfolio silently offline.** Structural, two co-equal halves:
   (a) a pinned-Coinbase requirement can never carry a signing template — the registry type
   has no `request`/`testRequest` seats, Guard 2b refuses authored ones beside the brand —
   so the executor injects the generic `X-Api-Key` default and **the saved api_secret is
   never used**; (b) the entry's HMAC+passphrase scheme is dead upstream anyway — retail
   HMAC keys **expired 2025-02-05**; current Coinbase = CDP key name + EC private key
   signing a per-request ES256 JWT (`Authorization: Bearer`). The 401 is silent at every
   layer: static-kind 401 returns `ok:true` (no `onNetError`), no testRequest → the done
   screen claims "connected" unverified, and no bridge connection-status frame exists.
4. **Registry specs were prompt-inferred.** In scope (owner decision): only the reported
   defects — Coinbase (CDP repair), Spotify (verified current — loopback-fixed-port posture
   and PKCE rules confirmed against 2025-11-27 enforcement), Hue (no entry exists at all).
5. **Starters + inference lag the platform.** weather-planner and crypto-portfolio are
   functionally broken at credential injection (OpenWeather needs `?appid=` query;
   CoinGecko needs `x-cg-demo-api-key`/query — **no query mechanism exists anywhere**);
   hue-lights-party ships a hard-disabled button even inside the desktop shell; the
   build-time inference channels (KB-taught directive + recovery inferrer) carry zero
   platform facts.

**Owner interview (2026-08-12):** all symptoms on desktop · Coinbase credential is a CDP
key → registry targets ES256 JWT primary · **full Hue connector in scope** (owner verifies
against real bridge) · registry repair scoped to reported defects only.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — platform truth in authoring prompts**: with the desktop platform set, the
   builder/app-chat system assembly contains a desktop-capabilities section (LAN
   RFC-1918-literal reach, native fetch/no CORS wall, loopback OAuth) and the stale
   "blocks private ranges"/"does not exist yet" copy is gone from what the model sees;
   with web (or no) platform, assembly is byte-identical to today except the corrected
   KB copy states the web limits as *web* limits. Golden-render tests both ways; the
   separator-forging guards stay green.
2. **AC2 — platform truth in inference**: the recovery inferrer's **user slot** (system
   slot stays static per D2) carries platform facts on desktop (LAN hosts legal when
   user-named; desktop postures exist) and none on web; a LAN-class provider prompt on
   desktop yields a requirement the executor can serve, and on web yields the honest
   web-limits refusal copy. Admission/persistence stay platform-blind (user files roam
   between web and desktop; platform-conditional behavior lives in prompts, wizard, and
   executor only — negative test: a desktop-minted LAN row admitted on web is not refused,
   it is *disclosed* as desktop-only in the wizard).
3. **AC3 — Spotify desktop sign-in works**: the opener capability carries an explicit
   https-only URL scope; a capability belt test asserts it (beside the http one); the
   wizard catch binds the error and renders **differentiated** copy (opener denial vs
   port-41420 collision vs genuine browser failure — the transport's collision message
   surfaces verbatim); in-shell gate step opens the system browser for a real authorize
   URL (or asserts at the pre-open seam). Mock-boundary rule: at least one test exercises
   the REAL `../oauth.js` module surface (lesson 2026-08-08: seams that short-circuit).
4. **AC4 — Coinbase CDP end-to-end**: registry Coinbase default becomes CDP (fields
   `api_key` = key name + `private_key` = EC PEM secret; passphrase and api_secret seats
   gone), carries a pinned `request` signing template using the new host-side JWT
   function and a pinned `testRequest`; the executor mints a fresh ES256 JWT per request
   (iss `cdp`, sub = key name, `uri` claim = `METHOD host path`, exp = now+120 s, kid,
   nonce) verified against an independent JWT decode+ES256 verify in tests; the wizard's
   "test this connection" renders for Coinbase and a 401 translates to "the provider
   rejected these credentials". C1 negatives: the private key never appears in iframe
   payloads, logs, exports of app-visible state, or error strings.
5. **AC5 — silent auth failures surface**: a 401/403 on a request where the executor
   injected credentials still returns the response to the app unchanged (`ok:true`,
   status as-is — app contract unbroken) **and** fires a new host-side observer that
   renders the RunView banner with a "check this connection" CTA opening the wizard on
   the failing (appId, slot); wizard probe failures render their translation. Negative:
   a 401 on a request with NO injected credentials fires nothing.
6. **AC6 — query-param credential placement exists and the two broken starters work**:
   `connectionRequestSchema` gains `queryTemplate` (same lint family as headerTemplate;
   admitted/substituted/refused by exactly the same Guard 2b + matched-option resolution
   — ONE resolution drives refusal and substitution, lesson 2026-08-12); registry
   openweather carries `{ appid: '{{api_key}}' }`, coingecko its documented query form;
   executor renders query credentials into the URL **after** ceiling checks, and scrubs
   them from every error string, log, inspector payload, and net-result echo (C1
   negatives). weather-planner and crypto-portfolio pass a wizard test-probe against
   stub servers asserting the credential arrived in the query, not as `X-Api-Key`.
7. **AC7 — Hue LAN connector on desktop (full)**: a `hue` registry entry exists under a
   new LAN-class shape (no pinnable apiHosts; wizard collects the bridge IP, validated
   RFC-1918 IPv4 literal, which lands in `declaredApiHosts` and freezes into the
   ceiling); the wizard runs the pairing flow (press link button → `POST https://<ip>/api`
   with `devicetype` + `generateclientkey` → application key lands **directly in
   snug_secrets**, never in app/LLM-visible state — C1 negative); requests carry
   `hue-application-key` header via the pinned template; desktop TLS trust for the bridge
   per ADR-0023 (TOFU pin recorded at pairing; scoped to RFC-1918-literal ceiling hosts
   ONLY — negative test: a public host can never use the pinned-trust path, and the pin
   is per-connection). Discovery button (desktop-only) queries `discovery.meethue.com`
   via native fetch with manual-IP fallback. Simulated-bridge integration test in CI;
   **owner manual verification against the real bridge journaled as the closing AC**.
8. **AC8 — Hue starter lights up on desktop**: hue-lights-party is rewritten — platform
   check enables the apply path inside the shell, ships a connection manifest in the new
   LAN shape, keeps the honest greyed state on web; e2e pins updated in the same change
   (web 'honestly greyed' pins stay; desktop journey added); manifest-list mirrors
   (connection-manifests.test.mjs, DEMO_STARTER_REQUIREMENTS) updated together.
9. **AC9 — registry/structural fences move together**: every pinned table that constrains
   this change (KIND_TABLE 10→11, exact field-key lists, posture/browserCallable tables,
   template parity, Guard 2b seat list, matched-option handle) is updated in the same
   commit as the data it pins, and the loopback⇒PKCE and borrow-ban guards stay green;
   deleted/changed test cases classified MIGRATED/OBSOLETE/LOST (lesson 2026-08-10).
10. **AC10 — no-regression**: root `turbo run test --force` green (0 cached), all
    platform seams default to today's behavior when no platform is set; web playground
    behavior unchanged except enumerated deltas (corrected KB copy, the new 401 banner,
    wizard test-probe on Coinbase, LAN disclosure states), each with its own test.

**Out of scope** (recorded, not silent): Apple Music's invented endpoints (real ceiling
hazard flagged by recon — queued to next-steps, needs its own registry decision);
google/gmail/googledrive/slack wizard-incompleteness (no fields/registration);
re-verification of unreported registry entries; Hue Remote API (cloud OAuth) authOption;
device-flow/https-bridge transports (posture refusals stand); subscription-mode server
twins; DNS pin-resolution (stays queued); mDNS discovery (cloud broker + manual entry
only this task); OpenWeather/CoinGecko dead-citation refresh beyond the entries we touch.

## Plan

Recon: 6 read-only code agents + 1 web-research agent (workflow `wf_d3f51505-863`,
2026-08-12); full structured reports in the workflow journal. Load-bearing facts inlined
below with citations. Provider facts verified against official docs + live curl CORS
probes the same day.

### Ground truth the plan builds on (verified by recon)

- **Prompt stack is platform-blind end to end**: `buildHostSystemPrompt` options are only
  `{appBuilder, artifacts, appRuntime}` (`knowledge/src/assemble.ts:25-43`); substitutions
  are static protocol constants (`render.ts:42+`); `getPlatform()` is consumed only by
  `agent/adapter.ts:88` (fetchImpl) and `state/net.ts:115` (transportPolicy). Desktop is
  direct-mode only (`platform-desktop.ts:252` `subscriptionMode:false`), so the injection
  point is the playground assembly at `builder.ts:205-207` (the `WEBLLM_BUILD_SUFFIX`
  pattern is the precedent). All four app-chat lanes ride the same static system.
- **Stale copy locations**: `90-auth-and-connected-apis.md:12-14,60-62` ("FUTURE rung that
  does not exist yet"), `20-html-template.md:286-289` (copy-exactly comment "blocks private
  ranges" — ships verbatim inside every generated app), `70-defensive-coding.md:18-20`.
  Headings are retrieval-load-bearing; reword bodies, keep heading structure.
- **Inference seams**: channel A = KB-taught reply-closing directive persisted by
  `connectionPipeline.ts:408-469`; channel B = `createConnectionRequirementInferrer`
  (`connection-requirement-inferrer.ts:194-216`) called from the post-turn seam, prompt
  assembled by `buildConnectionRequirementInferrerPrompt` (`assemble.ts:280-306`) — system
  slot static by design (D2), platform facts belong in the **user slot**, injected by the
  playground adapter (`connectionInferrerAdapter.ts:96-117` — the only caller that can
  read `getPlatform()`; `packages/auth` cannot import the platform seam). No runtime
  (post-build) inference exists (Q5 removed it); the wizard's unknown-provider desktop
  default is posture `loopback` with the loopback⇒PKCE refusal backstop.
- **LAN legality today**: nothing refuses a private-IP-literal `declaredApiHosts` at
  schema/admission (`CONNECTION_HOST_RULE` accepts digit labels; no host-class lint);
  refusal is executor-only — gate 4/5 vs the Decision-6 stand-down
  (`connected-fetch.ts:711-730`), keyed on `transportPolicy.allowHttpForPrivateHosts`
  from `getPlatform().capabilities.lanHttpPrivate` (`net.ts:112-115`). 19 tests pin the
  executor policy (12 in connected-fetch Decision-6 describe + 7 net-guards; the desktop
  task file's "17" is a stale snapshot — corrected here).
- **Spotify failure chain**: `main.json:12` bare `opener:allow-open-url` → plugin
  `scope.is_url_allowed` over an empty allow vec → `Error::ForbiddenUrl` on every open →
  rejection lands in `connectionWizard.ts:1158-1168`'s bare catch → generic copy. Failure
  mode 2 (same message): port-41420 bind collision text from `desktop-transport.ts:117-121`
  swallowed by the same catch. Fix shape: scoped
  `{"identifier":"opener:allow-open-url","allow":[{"url":"https://*"}]}` (tighter than
  `allow-default-urls`; matches `oauth.ts:52`'s https-only guard).
- **Coinbase chain**: template source is only `spec.request?.headerTemplate`
  (`connected-fetch.ts:548`); kind-default `X-Api-Key` at `:569-579`; registry type has no
  request/testRequest seats (`well-known-providers.ts:93-216`); Guard 2b
  `CREDENTIAL_PROMPT_SEATS = ['fields','request','testRequest']`
  (`requirement-admission.ts:217`) refuses authored ones; 401 delivered `ok:true`
  (`connected-fetch.ts:804-816`); probe gated on `requirement.testRequest !== undefined`
  (`ConnectionWizardSheet.tsx:708`); done screen claims connected regardless (`:720`).
  The KB-taught CB-ACCESS template exists only as the unpinned "Meridian Exchange"
  example + parity transcription — no production channel attaches it to Coinbase.
- **Coinbase provider truth** (official docs + live probes 2026-08-12): retail/Advanced
  Trade = CDP key (`organizations/{org}/apiKeys/{key}`) + private key → per-request JWT,
  `Authorization: Bearer`, claims iss=`cdp`/sub=keyName/uri=`METHOD host path`/exp=+120 s,
  header kid+nonce; **no passphrase on this path**; legacy retail HMAC expired 2025-02-05;
  HMAC+passphrase survives only on institutional `api.exchange.coinbase.com`. ES256 (EC)
  is the universally safe algorithm (Coinbase App docs: Ed25519 NOT supported there;
  Advanced Trade accepts both). Balances: `GET /api/v3/brokerage/accounts`, portfolios at
  `/api/v3/brokerage/portfolios`. CORS: no ACAO on v3 → desktop/server only (confirms
  `browserCallable:false`).
- **Hue provider truth**: CLIP v2 is https-only on the bridge; pairing = link button +
  `POST /api {"devicetype":…,"generateclientkey":true}` → `username` (the
  `hue-application-key` header value) + `clientkey`; bridge cert CN = bridgeId, Signify
  private CA on current firmware, self-signed on old ones → pin/TOFU, never plain http;
  discovery = mDNS `_hue._tcp` or `discovery.meethue.com` (CORS-locked, desktop-only;
  verified live). Registry structural rule "every entry has non-empty apiHosts"
  (well-known-providers.test.ts) **collides** with a user-specific bridge IP → LAN-class
  entries need a type change (ADR-0023), not a data row.
- **Starters**: manifests are PR-reviewed `connection.json` under the v4 schema (userdb is
  **v6**, not v5); four bare manifests borrow from the registry; weather-planner/crypto-
  portfolio break at injection (no query mechanism; registry's own `:542-544` comment
  promises a template engine placement that doesn't exist); hue-lights-party hard-disables
  its apply button with no platform check (`app.html:475-485`). Also: `HubView.installStarter`
  is dead code that would bypass manifest/contract copy if rewired (delete it);
  `starterDeclaration.ts:62-64` promises a Settings html_mismatch surface that doesn't
  exist (fix the comment; real surface queued).
- **Structural fences that must move with the change** (AC9): KIND_TABLE set-equality
  (registry-self-containment.test.ts:43-61), exact ordered field keys incl. Coinbase
  `['api_key','api_secret','passphrase']` (static-kind-registry.test.ts:50-72), posture +
  browserCallable exact tables (desktop-posture.test.ts:157-233), loopback⇒PKCE (:85-102),
  template parity incl. the pinned `passphrase` key (registry-template-parity.test.ts),
  matched-option handle (matched-option-admission.test.ts), borrow-ban evasion lists.

### Decisions being made now (→ two ADR drafts in this task)

**ADR-0022 — Registry request seats, host-side signing functions, auth-shaped failure
surfacing** (drafted at P0, finalized P3):
1. `WellKnownOauthProvider` (and options, matched-option rules per ADR-0020) gain optional
   `request` (headerTemplate + NEW queryTemplate) and `testRequest` seats — pinned,
   human-reviewed, substituted on the registry channel by the SAME matched-option
   resolution that drives refusal (Guard 2b's "nothing to substitute WITH" comment becomes
   false and its behavior becomes: borrowers still refused, registry now substitutes).
2. Template grammar gains `{{cdp_jwt(api_key, private_key)}}` — a host-side,
   provider-scheme-named signing function (like `hmac_sha256_b64`) minting the CDP JWT
   per request from the live request context (method/host/path). ES256 only at v1;
   an Ed25519 PEM yields an honest wizard/probe error naming the fix ("generate an EC
   key"). Grammar lives beside the existing function tokens → protocol lint + SPEC_SYNC
   staged draft.
3. `queryTemplate` injection happens after ceiling checks; rendered values are scrubbed
   from every error/log/inspector surface (C1). Lint: same declared-field-keys rule as
   headerTemplate, both lints derived from ONE resolution (lesson 2026-08-10: two lints
   disagreeing about "declared" is the founding-defect shape).
4. Auth-shaped failure observer: executor reports "credentialed request got 401/403" to a
   host-only callback; app-visible result unchanged. RunView renders the repair banner.
5. Coinbase entry: CDP fields (`api_key` key-name text + `private_key` EC-PEM secret),
   pinned request template + testRequest (`GET /api/v3/brokerage/accounts`), OAuth option
   untouched, `api.exchange.coinbase.com`/passphrase world **dropped** (institutional,
   out of product scope — recorded here, not an authOption).

**ADR-0023 — LAN-class providers: user-supplied bridge host, pairing exchange, scoped TLS
trust** (drafted at P0, finalized P5):
1. A LAN-class registry entry declares `lanHost` (class `rfc1918-ipv4-literal`, label,
   wizard copy) INSTEAD of pinned `apiHosts`; the structural "non-empty apiHosts" rule
   becomes "pinned apiHosts XOR lanHost". The user-typed bridge IP is validated
   (RFC-1918 IPv4 literal only) and lands in `declaredApiHosts` → frozen ceiling. Rows
   stay platform-portable; on web the wizard discloses "needs the desktop app" (the
   `disclosedBrowserWall` pattern) and the executor keeps refusing (existing gates).
2. Pairing is a wizard-run, host-side credential exchange described by a registry
   `pairing` seat (Hue: link-button POST, response field → secret). The minted key writes
   straight to `snug_secrets`; the exchange response is never surfaced to app/LLM state.
3. Desktop TLS for RFC-1918-literal ceiling hosts: TOFU — the bridge cert (fingerprint +
   CN) is pinned at pairing time onto the connection row; subsequent requests go through
   a dedicated Rust `lan_fetch` command that verifies the pin (reqwest custom verifier)
   and is reachable ONLY for RFC-1918-literal hosts inside the frozen ceiling. Never a
   global accept-invalid-certs flag (lesson 2026-08-12: a guard expressed as a transport
   flag must be re-proven — the pin check is code we execute, asserted by tests at the
   Rust boundary). Public hosts: byte-identical behavior to today.
4. Discovery: wizard "find my bridge" button, desktop-only, native fetch to
   `discovery.meethue.com`, manual IP entry as the primary path.

**Platform-truth design (AC1/AC2, no new ADR — extends ADR-0018/0021 doctrine):**
- New KB layer `95-platform-capabilities` variants + a `platform` seat on
  `HostSystemPromptOptions` (`'web' | 'desktop'`, default web = today's copy corrected to
  claim only web limits). Assembly stays cache-stable per install (a client's platform
  never changes mid-session; ADR-0012 prefix implications journaled).
- Inferrer: platform facts ride the **user slot** via the playground adapter; prompt rule
  "extract, never invent" stays — a bridge IP is never model-proposed, the wizard collects
  it (recon's user-entry conclusion).

### Phases (each = failing tests first; orchestrated via dynamic workflows, worktree isolation for any writing agent — lessons 2026-08-04/2026-08-12)

- **P0 — plan review (before any implementation code, High tier)**: fresh-context
  adversarial review of THIS plan, 3 lenses (security/C1-C2 — JWT minting, query secrets,
  TLS pinning, pairing custody; wiring-claims-vs-code — every citation above re-executed;
  scope/feasibility — WebCrypto ES256 in WKWebView, reqwest custom verifier viability).
  Both ADR drafts written. Findings folded back here before P1.
- **P1 — Spotify opener fix** (small, independent; ships first so the owner can re-test):
  scoped opener capability + belt test + wizard catch binds `err` with differentiated
  copy + real-module test + in-shell gate step. Owner manual check: Spotify sign-in
  round-trip on desktop.
- **P2 — platform truth (prompts + inference)**: KB copy corrections (90-auth,
  20-html-template, 70-defensive-coding), platform layer + assembly seat + builder/app-chat
  wiring, inferrer adapter user-slot facts, golden renders web/desktop, separator guards.
- **P3 — registry request seats + Coinbase CDP + silent-401** (ADR-0022): protocol schema
  (queryTemplate, jwt function token) + staged spec draft + spec-changelog; executor JWT
  mint (WebCrypto ES256; independent verify in tests) + query injection + scrubbing +
  auth-shaped observer; registry seats + substitution through `requirementFromRegistryEntry`
  + Guard 2b/matched-option one-resolution change; Coinbase entry rewrite + testRequest;
  wizard probe + done-screen truth; RunView banner; all pinned tables moved (AC9).
  Existing-row migration: wizard detects field-set drift on open and routes to
  re-credential (owner re-enters the CDP key once).
- **P4 — starters realignment**: openweather/coingecko request seats + starter probes
  against stubs; demoreq mirrors + manifest lists; HubView dead code removed;
  starterDeclaration comment truth; e2e updates.
- **P5 — Hue connector (ADR-0023)**: registry lanHost/pairing type change + `hue` entry +
  structural-rule fork; wizard bridge-IP step + pairing flow + discovery button; desktop
  Rust `lan_fetch` pinned-TLS command + TS seam + negative tests both ways; starter
  rewrite + e2e; simulated-bridge integration test; **owner real-bridge verification
  journaled**.
- **P6 — whole-surface review + close-out** (lesson 2026-08-10, mandatory): trace one CDP
  private key wizard→JWT→wire and one Hue application key pairing→row→header→bridge, at
  every handoff asking what the receiver trusts that the sender never guaranteed; refuter
  stage; threat-model delta (`docs/security/threat-model-delta-desktop-auth.md`: JWT
  surface, query-string credentials, TOFU pin, pairing listener window, LAN disclosure);
  ADRs finalized; docs (architecture, code-map counts, next-steps incl. out-of-scope flags
  — Apple Music endpoints hazard, google-family wizard gaps); spec-changelog; journal; PR.

### P0 plan-review amendments (2026-08-12 — wiring + feasibility lenses: 9 CONFIRMED after adversarial refutation, 3 BLOCKERs; all binding on P1–P6. Security lens re-run appended below when it lands.)

1. **[BLOCKER admission-idempotence-1] Substituted request/testRequest must survive the
   SECOND admission pass.** `occupiedPromptSeats` exempts only `fields` via
   `matchAuthOption` (`requirement-admission.ts:292-313`); admission runs TWICE on the
   production path (pipeline + db admissionGate), so pinned request/testRequest written
   on pass 1 would be refused on pass 2 — the exact P5-blocker shape, probe-reproduced
   against built dist. **Also: a request carrying ONLY `queryTemplate` sails past Guard
   2b today** (occupiedPromptSeats never counts it) — a real hole the new seat would
   widen. Binding: (a) `request` counts as occupied when it carries headerTemplate OR
   queryTemplate; (b) request/testRequest values byte-matching the MATCHED option's
   pinned values are exempt, derived from the SAME `matchAuthOption` handle as fields —
   one resolution, all three seats; (c) idempotence tests per seat: bare starter manifest
   survives double admission; `stagePendingRequirement` of the registry-shaped CDP
   requirement on a `'starter'`/`'inference'`-provenance row is admitted — asserted on
   the PERSISTED shape.
2. **[BLOCKER lan-schema-2] The LAN shape is a protocol schema change, now named.**
   `declaredApiHostsSchema.min(1)` + required seat make a pre-collection LAN row
   unrepresentable (probe: hue-like entry fails safeParse). `connectionRequirementSchema`
   gains optional `lanHost {class, label}` with declaredApiHosts required-XOR-lanHost;
   emitter, admission, borrow-ban host trigger, and CONNECTION_HOST_RULE notes updated;
   SPEC_SYNC staged-draft + AC9 fence list gain the fork. Spec-impact header updated.
3. **[BLOCKER seat-migration-gap] Existing approved rows never see new registry seats.**
   Rows are admitted once; the executor reads only the persisted spec — so P4 alone
   cannot fix the owner's existing weather-planner/crypto-portfolio installs, and
   field-set-drift migration can't fire when the field set is unchanged. Binding: wizard
   open (incl. the AC5 banner CTA route) detects **registry-SEAT drift** — when
   `lookupWellKnownProvider` pins request/testRequest absent from the row's spec, re-run
   registry substitution and re-persist WITHOUT re-crediting (stored secrets stay valid);
   route to re-credential only when the field set also drifted. AC6 gains a sub-test
   starting from a pre-existing approved row minted with the old registry.
4. **[MAJOR cdp-key-import] SEC1→PKCS#8 wrapping is required.** CDP EC keys download as
   SEC1 `BEGIN EC PRIVATE KEY`; WebCrypto importKey takes pkcs8 only (probe: DataError on
   SEC1, 64-byte raw r||s sign output confirmed JWS-ready). Binding: DER-wrap SEC1 →
   PKCS#8 (id-ecPublicKey + prime256v1) accepting both PEM headers, fixture test with a
   real-format key; honest wizard/probe errors for Ed25519 PEM and undecodable PEM;
   `cdp_jwt` requires NATIVE WebCrypto ECDSA — the desktop subtle-fallback does not
   implement it, so absence surfaces an honest error, never a silent failure.
5. **[MAJOR pairing-transport-unspecified] The pairing POST gets a named transport.**
   Binding wizard ordering: bridge IP collected → row approved → ceiling frozen → THEN
   pairing. Pairing rides the SAME Rust command in an explicit `mode:'pair'` whose rustls
   verifier accepts-and-CAPTURES the cert (fingerprint+CN) — reqwest never exposes the
   peer cert to callers, so capture must live INSIDE the verifier — for RFC-1918-IPv4-
   literal hosts only (validated in Rust), returning the pin alongside the response so
   the wizard writes pin+key in one step. Normal mode requires a pin and refuses without
   one. Pair mode carries its own enumerated guards (Rust host-class check, response size
   cap, no redirects) and negative tests: unreachable for public hosts and from iframes
   (C2 IPC scope).
6. **[MAJOR lan-pin-plumbing] The pin's channel to the transport is pinned.** The
   executor resolves the pin from the grant's row and routes via a NEW optional
   desktop-only dep `lanFetch?(url, init, pin)` beside `fetchImpl` in ConnectedFetchDeps
   (`FetchLike` untouched for web); routing decided IN THE EXECUTOR at gate 4/5 where
   `lanPrivateHost` is already computed. Pin storage: the connection's dynamic-state KV
   in `snug_secrets` (`auth:<appId>:<slot>:_connection`, ADR-0014 custody — NOT a new db
   column). Rust: fresh reqwest client per call (pin baked into the verifier, no client
   cache), `Policy::none()` unconditionally, 1 MiB cap enforced in Rust before bytes
   cross IPC. Semantics re-proven per the flag lesson: redirecting simulated bridge →
   NET_REDIRECT_BLOCKED; oversized body → NET_SIZE_EXCEEDED.
7. **[MAJOR ac9-helper-enum-7] AC9's fence list gains the template-helper pins**:
   `AUTH_TEMPLATE_HELPERS`/`HELPER_ARITY` (typed Record — a 5th helper cannot compile
   without moving it), test-side `PINNED_HELPERS`, and the both-directions engine↔lint
   set-equality assertions — moved in the same commit as the `cdp_jwt` grammar change.
8. **[MINOR observer-retry-8] Observer semantics pinned**: fires only on the FINAL
   delivered result of `execute()` (post-OAuth-refresh-retry; negative test: 401 cured by
   refresh fires nothing); `executeConnectionTestRequest` SUPPRESSES the observer (probe
   outcomes render in the wizard only), tested.
9. **[MINOR windows-leg-unverified] Desktop claims scoped to macOS**: AC3/AC7 in-shell
   steps run on the macOS gate leg; Windows stays pending per the desktop scaffold task;
   P6 journals that `cdp_jwt` (native ECDSA) and `lan_fetch` are Windows-unverified with
   honest-error paths if the APIs are absent.

**Round 2 (lenses re-ran against the amended plan; 4 more CONFIRMED, 1 BLOCKER):**

10. **[BLOCKER lan-admission-clobber] The borrow ban must fork for lanHost entries with
    NAMED semantics** (probe: one apiHosts-less entry makes EVERY admission of ANY
    requirement throw TypeError from `registryHostIndex`; and a borrow hit on an existing
    entry silently replaces a declared `192.168.1.50` with the pinned hosts — the exact
    AC7 chain). Binding: (a) `registryHostIndex` skips lanHost entries; (b)
    `applyRegistryValues` PRESERVES the declaration's declaredApiHosts for lanHost
    entries and admission re-validates the RFC-1918-IPv4-literal class — a borrower
    cannot smuggle a public host under the hue brand; (c) ADR-0020's "hosts are ALWAYS
    the entry's" invariant gains the lanHost carve-out, recorded in ADR-0023. Negative
    tests: hue borrow keeps the IP; hue + public declared host refused; non-hue
    admission unaffected by the hue entry's presence.
11. **[MAJOR querytemplate-key-charset] queryTemplate gets its OWN key charset.**
    `CONNECTION_HEADER_NAME_RULE` is alnum+dash (no underscore) and would reject the
    plan's own `x_cg_demo_api_key`. Binding: new
    `CONNECTION_QUERY_NAME_RULE = /^[A-Za-z0-9_.\[\]-]{1,64}$/`; "same lint family"
    means the VALUE lint (declared-field-keys, one resolution with headerTemplate), not
    the key charset.
12. **[MINOR adr22-wording] ADR-0022 wording corrected**: the template grammar has FOUR
    helpers today (timestamp, hmac_sha256, hmac_sha256_b64, base64) — `cdp_jwt` is the
    FIFTH and second signing-capable one; and substitution runs on EVERY channel's
    borrow hit via `applyRegistryValues` (the registry channel is merely exempt from
    Guard 2b's refusal) — implementers target `applyRegistryValues`, not a
    registry-channel-only branch.
13. **[MINOR ci-simulated-bridge] AC7's CI fixture named**: lan_fetch's host-class check
    refuses loopback, so the standard 127.0.0.1 stub cannot exercise it. The pin
    verifier is tested at the Rust unit boundary (rustls verifier fed the bridge cert
    directly), plus one macOS gate journey step against a private-IP stub bound to the
    runner's real RFC-1918 interface when one exists (honest skip otherwise) — AC7's
    "simulated-bridge integration test in CI" means the Rust-boundary test; the gate
    step is best-effort.

**Security lens (ran third, prose-mode after two mechanical failures; verdict: "safe to
implement as amended, conditional on folding Findings 1–2." Clean bills issued on:
cdp_jwt custody, observer-as-oracle, TOFU pin vs import/sync — a pulled image cannot
overwrite the pin because local secrets win in the merge, and an imported row demotes to
`declared`+`imported=1` so a re-pointed pin cannot serve traffic without re-approval —
pairing custody, opener https reach. Both findings' citations re-derived by the
orchestrator before folding.):**

14. **[MAJOR querytemplate-scrub-enumeration] The scrub promise becomes an ENUMERATED
    site list + a widened candidate set.** `scrubAuthValues(text, authHeaders)` iterates
    header VALUES only, and `NET_FETCH_FAILED` returns `request failed: ${err.message}`
    completely unscrubbed (`connected-fetch.ts:781` — verified) while fetch errors
    routinely embed the full URL, query string included; that message reaches the app
    (`net.ts:163`). Binding: rendered query values join the scrubber's candidate set;
    the `NET_FETCH_FAILED` message is scrubbed (or the URL's query stripped) before it
    can appear anywhere; enumerated sites = fetch-error message · response body/header
    scrub · LLM inspector · RunView surfaces. C1 negative test: a query-credential
    request whose fetch throws with the URL in `err.message` → credential redacted.
    (Verified clean already: NetConfirm shows host+method only; the confirm store
    captures the URL BEFORE query injection; frame inspector is structural.)
15. **[MINOR lan-apikey-review-copy] Private-IP consent copy for the NON-Hue case.** A
    prompt-injected authored `api_key` row can target a victim LAN IP and ride the
    ADR-0021 rung with no pairing gate; the only barrier is the review screen's bare
    host list. Binding: the review screen detects a private-range/IP-literal declared
    host and renders a distinct warning ("this is a device on your own network — make
    sure you recognize this address before pasting a credential"); the AC2 platform
    copy states LAN hosts in authored requirements are USER-entered, never
    model-proposed (the extract-never-invent rule, restated for static kinds).
16. **[Recommendation, adopted] AC7 gains a per-command IPC sub-test**: the gate (or a
    Rust-boundary test) proves `lan_fetch` SPECIFICALLY is unreachable from a sandboxed
    subframe and refuses public hosts in Rust — per-command, not just command-family
    (the "mutate the call site" discipline).

Refuted findings (5 in round 1 + 11 in round 2) recorded in the workflow journal
(`wf_d15a9134-75c`) — round 2's refutations were mostly duplicates of already-folded
round-1 amendments, confirming the folds hold. Notable
refutations worth keeping: the pairing-order concern died because approval precedes
pairing by design (now explicit in amendment 5); the TOFU pin needs NO db schema change
(the `_connection` KV already exists for exactly this class of state); `https://*` in a
tauri glob scope DOES cross path separators (single-star match verified against
glob::Pattern defaults); the template engine is **async-first end-to-end**
(`renderAuthHeaderTemplate` returns a Promise, awaited at `connected-fetch.ts:563`), so
an awaiting WebCrypto helper forces no seam change; and the demoreq/manifest mirrors do
not leak registry seats (bare manifests stay bare — substitution happens at admission).

### Pinned shared literals (lesson 2026-08-03 — before any fan-out)

```
Registry seat names:      request.headerTemplate · request.queryTemplate · testRequest   (exact requirement-schema names)
JWT function token:       {{cdp_jwt(api_key, private_key)}}                              (ES256; claims iss='cdp', sub=<api_key>, uri='<METHOD> <host><path>', nbf, exp=+120s; header kid=<api_key>, nonce)
Coinbase fields (ordered): ['api_key', 'private_key']                                    (labels: 'API key name (organizations/…/apiKeys/…)' · 'EC private key (PEM)')
Coinbase testRequest:     GET https://api.coinbase.com/api/v3/brokerage/accounts
OpenWeather queryTemplate: { appid: '{{api_key}}' }
CoinGecko queryTemplate:  { x_cg_demo_api_key: '{{api_key}}' }
Hue registry key:         'hue' · kind 'api_key' · fields ['application_key'] (secret) · header { 'hue-application-key': '{{application_key}}' }
Hue lanHost seat:         { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' }   (protocol: connectionRequirementSchema.lanHost, declaredApiHosts required-XOR-lanHost)
Hue pairing:              POST https://{lanHost}/api  body {"devicetype":"snug#hub","generateclientkey":true} → success[0].username → application_key; clientkey stored, unused v1
LAN transport dep:        lanFetch?(url, init, pin)   (optional ConnectedFetchDeps seat beside fetchImpl; executor routes at gate 4/5; FetchLike untouched)
Query key charset:        CONNECTION_QUERY_NAME_RULE = /^[A-Za-z0-9_.\[\]-]{1,64}$/       (queryTemplate keys; header rule stays alnum+dash)
Rust command modes:       lan_fetch { mode: 'pair' | 'pinned', ... }                      (pair: capture cert fingerprint+CN, RFC-1918 literals only; pinned: refuse without pin match)
TOFU pin storage:         snug_secrets KV `auth:<appId>:<slot>:_connection`               (ADR-0014 custody; NOT a db column)
Auth-shaped observer:     onAuthShapedFailure(appId, slot, status)                        (host-only; app result untouched; fires on FINAL post-retry result; suppressed for wizard probes)
Opener capability:        { "identifier": "opener:allow-open-url", "allow": [{ "url": "https://*" }] }
KB layer id:              95-platform-capabilities (web/desktop variants)
```

### Test plan (tests FIRST, per TDD.md)

AC→tests: AC1/AC2 golden renders + separator guards + adapter user-slot unit ·
AC3 belt test + catch-differentiation unit + real-module test + in-shell step ·
AC4 JWT independent-verify + registry structural + probe render + C1 negatives (iframe
payload scan, log scan, error-string scan) · AC5 observer fires/doesn't (credentialed vs
not) + banner render + app-result-unchanged pin · AC6 schema lint one-resolution test +
scrub negatives + two starter stub probes · AC7 pairing custody negative + pin-scope
negatives both ways (public host never pinned-path; wrong-fingerprint refused) +
simulated-bridge round trip · AC8 e2e web-greyed pins kept + desktop journey · AC9
fence-motion enumerated in the diff · AC10 root `turbo run test --force`, 0 cached.
Negative tests mandatory for every C1/C2-adjacent seam (Gate 3); every guard mutated at
rule AND call site (lesson 2026-08-08).

### Cross-package impact

`protocol` (schema + grammar) → auth, db, sdk, playground, examples, server ·
`auth` → playground, desktop · `knowledge` → playground, server · `desktop` Rust+TS ·
`examples` validate suite. In doubt → root `pnpm test` (turbo, forced).

### Spec-sync impact

`connectionRequestSchema.queryTemplate` + template function grammar → SPEC_SYNC staged
v0.3 draft in `docs/spec-drafts/` + spec-changelog entry. **No push** (AL-12 held).

## Decisions & surprises

- 2026-08-12 — Owner interview: all-desktop repro; CDP key; full Hue connector in scope
  (real-bridge verification by owner); registry repair limited to reported defects.
- 2026-08-12 — Recon surprises worth recording: (1) the Spotify failure is a one-line
  capability scope omission, invisible because the only test mocks the whole module;
  (2) Coinbase's saved `api_secret` is never read by ANY code path — the entry was
  never connectable; (3) retail HMAC keys expired provider-side in Feb 2025, so even the
  intended template was dead; (4) `discovery.meethue.com` CORS-locks to its own origin —
  another desktop-only rung; (5) Apple Music's registry endpoints are invented URLs that
  silently widen the ceiling (flagged out of scope → next-steps).

## Session journal (append-only, newest last)

### 2026-08-12 — claude — session start (Gates 1–2)
- Done: task file created; 7-agent recon workflow (wf_d3f51505-863) completed — all five
  symptoms root-caused with citations; owner interviewed (4 answers folded into spec);
  plan + two ADR outlines written; branch `fix/TASK-20260812-desktop-auth-awareness` cut.
- State: **planned — STOPPED at Gate 2 for owner plan approval.** No implementation code.
- Next step: on approval → P0 fresh-context plan review (High tier), then P1.
- Open questions for the owner at approval: (a) AC5 keeps the app-visible 401 contract
  and adds a host banner — confirm over the alternative (remap 401→ok:false, breaking);
  (b) CoinGecko placement pinned to the query form on both platforms (works everywhere)
  — confirm; (c) ES256-only for CDP v1 (Ed25519 keys get an honest error) — confirm;
  (d) dropping the institutional Exchange (passphrase) surface entirely — confirm.

### 2026-08-12 — claude — plan approved; P0 started
- Done: owner approved the plan as written ("yes approved go ahead" — recommendations
  (a)–(d) stand as the plan's defaults, none overridden). ADR-0022 and ADR-0023 drafted
  (`docs/decisions/`, status proposed). P0 fresh-context adversarial plan review
  dispatched as a workflow: 3 lenses (security/C1-C2 · wiring-claims-vs-code ·
  scope/feasibility) each paired with default-to-refuted refuters over the task file +
  both ADR drafts.
- State: P0 running; no implementation code yet (High-tier gate holds).
- Next step: fold CONFIRMED findings into plan + ADRs, then P1 (Spotify opener fix).

### 2026-08-12 — claude — P0 complete (3 rounds), P1 complete
- P0: wiring lens round 1 (4 confirmed incl. 2 BLOCKERs, probe-executed) + feasibility
  (5 confirmed incl. 1 BLOCKER) folded; lenses re-ran against the AMENDED plan (resume
  cache invalidation re-ran everything after the edited security prompt — accidental but
  valuable: round 2 found the lan-admission-clobber BLOCKER *in my round-1 fold*);
  security lens succeeded on attempt 3 as a prose agent after two mechanical
  structured-output failures (placeholder, then retry-cap) — 2 findings (scrub
  enumeration MAJOR, LAN consent copy MINOR) + 5 clean bills; its citations re-derived
  by hand before folding. 15 confirmed findings total, all folded into plan + ADRs.
- P1 (tests first, red proven): `capabilities/main.json` opener grant was a BARE string
  = empty URL scope = every `openUrl` refused (`ForbiddenUrl`) — now a scoped object
  `allow: [{url: "https://*"}]`; wizard catch at `connectionWizard.ts` binds the error
  and renders three differentiated messages (port-41420 collision verbatim / opener
  denial names Snug / genuine failure appends the cause; flow teardown asserted); belt
  tests pin the opener scope beside the http one; `openerRealModule.test.ts` closes the
  wholesale-mock gap (real `oauth.ts` https guard exercised). Desktop 55 (was 50),
  playground 876 (was 873), both tsc-gated green.
- Gate note (AC3, deliberate): no in-shell open_url check added — a positive control
  necessarily opens a real browser on CI, and a refuses-http-only check cannot fail for
  the regression it would claim to guard (bare grant refuses http too). The build
  itself schema-validates the capability file, the belt pins its content, the wizard
  tests hold the pre-open seam. **The live positive proof is the owner's manual Spotify
  sign-in — owner: please re-test Spotify connect in the desktop app after the next
  build.**
- Next step: P2 (platform truth in prompts + inference).
