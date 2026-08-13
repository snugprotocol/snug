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

### P3 orchestrator verification (2026-08-13)

All four lanes reported green; the orchestrator's own forced root run
(`turbo run test --force`) found **playground RED** — `registryDriftMigration.test.tsx`'s
two Coinbase probe waits fail ~1 run in 3 at suite scale (95 files sharing the box)
while passing every time in isolation, because a REAL SEC1→PKCS#8 import + ES256 sign
occasionally exceeds `vi.waitFor`'s 1000 ms default. The host lane had seen this once
("a single run exited 1 with no failing test captured") and honestly journaled it as an
unreproduced flake — it was real. Fixed by raising that wait to 10 s/25 ms with the
reason written at the seam; the CONDITION is untouched. **Mutation-verified**: hanging
`cdp_jwt` in the engine still reds both probe tests through the rebuilt dist, so the
raise bought patience, not blindness. Root now **21/21 tasks, 0 cached**.
Lesson shape for Gate 6: *a lane's own green is a sample, not a proof — the
integrating run at full parallelism is a different test than any lane can run.*

### P4 orchestrator verification (2026-08-13) — and a correction to my own P3 fix

P4's root run caught the probe test STILL flaking (measured 3/12 = 25%) and root-caused
what my P3 "fix" got wrong, in two layers:

1. **The P3 fix was structurally unreachable.** I raised `vi.waitFor`'s budget to 10 s
   inside a test whose vitest timeout is the **5000 ms default** — the test dies at
   5004 ms with an anonymous "Test timed out in 5000ms" while `waitFor` is still
   patiently waiting. The raise could never take effect.
2. **The real mechanism was a deadlock, not slowness.** `vi.waitFor` was called INSIDE
   `act()`; React's `act` owns the scheduler while pending, so the component could never
   re-render with the resolved outcome. Measured: 200 consecutive ES256 imports+signs
   take 83 ms total — the mint was never slow, and failures were bimodal (~158 ms or a
   full hang), which is a deadlock signature, not a latency one. Fixed by moving
   `waitFor` outside `act` with `settle()` in each poll, inner budget (8 s) strictly
   below an explicit outer timeout (15 s) so a real hang reports with a MESSAGE.
   Orchestrator-verified: **0 failures in 10 consecutive full-suite runs** against a 25 %
   baseline, and mutation-verified (hanging `cdp_jwt` still reds both probe tests).

**Two lessons for Gate 6, both about my own reasoning:** (a) *a timing fix is not
verified by "it passed a few times" — it needs the failure RATE measured before and
after, because P3's fix passed 6 consecutive runs while being structurally inert*;
(b) *when a symptom is intermittent and every added `console.log` makes it pass, that is
a scheduler/ordering bug (a Heisenbug), not a slow operation — and "raise the timeout"
is the fix you reach for when you have not found the mechanism yet.* Also worth keeping:
**"budget" fixes must check the enclosing budget** — an inner timeout above an outer one
is dead code that looks like diligence.

P4's other refutations (both probe-backed, brief claims corrected): CoinGecko DOES
reflect `x-cg-demo-api-key` in its CORS allow-headers, so the query form was chosen for
preflight-independence, not necessity; and CoinGecko gets NO `testRequest` because
`api.coingecko.com` answers every endpoint keylessly — a probe would report CONNECTED
for a typo'd key. No button beats a meaningless one.

### P5 orchestrator verification (2026-08-13)

Independently re-derived rather than accepted: tree clean; 10 P5 commits present; root
`turbo run test --force` **21/21 tasks, 0 cached**; **cargo 48 passed** (my first check
printed "0 tests" — the trailing doc-test section, not a missing suite: the empty-result
lesson working as intended, one tool-call later); the pinned-TLS guards are real
(`a_single_flipped_byte_in_the_pin_refuses`,
`pinned_mode_REFUSES_a_different_certificate_on_the_same_address`,
`refuses_loopback_link_local_public_names_and_ipv6`,
`refuses_plain_http_even_to_a_private_literal`, size cap enforced in Rust before IPC);
and the cross-package seam identities are asserted (`platform.lanFetch toBe lanFetch`,
`platform.lanPair toBe lanPair`). The corrected `secretPath: [0, 'success', 'username']`
is on disk.

**The three findings worth carrying to Gate 6 (all are the same shape — a green suite
that proves less than it appears to):**
1. **A data defect that would have failed forever against a working bridge.** The pinned
   literal `success[0].username` is ambiguous prose; P5-shape encoded it as
   `['success', 0, 'username']`, but a CLIP v1 pairing response is an ARRAY of result
   objects OUTERMOST. The shipped path resolved to `undefined` on every real answer —
   and the fence pinning it compared the registry array to a retyped copy of ITSELF, so
   it was green against the broken value. Only driving a real-shaped body through the
   walk found it. *Rule: a fence that restates the data cannot test the data; it must
   exercise it.*
2. **The cross-package seam is what neither package's suite watches.** Deleting
   `lanFetch` (and later `lanPair`) from the desktop platform object left ALL desktop
   tests green — desktop tests drive the module function directly, and the playground's
   suite supplies its own fake platform. Each side complete, jointly blind. It recurred
   one lane after being journaled, which makes it a pattern, not an incident.
3. **Co-located guards mask each other.** Deleting `runLanPairing`'s approved-status
   check killed nothing because the host guard beside it refuses the same inputs first —
   the same shape as P5-shape's guard-beside-null-safe-accessor mutant. *Rule: each
   refusal needs an input that satisfies every OTHER refusal.*

**Scope decisions recorded (not silent):** hue carries no `testRequest` (pairing IS the
verification) and no `desktopRedirectPosture` (a LAN device runs no OAuth); the Hue
starter's apply control stays honestly greyed because **no protocol frame tells an app
which hosts it may reach** — the executor takes a literal URL, so a LAN app cannot know
its own bridge address without a new approved-host disclosure frame (queued for its own
task, its own protocol decision); the web Hue tile remains fully locked (over-strict, an
owner UX call); an env-gated e2e pin (`starters-connect.spec.ts`) had silently rotted
behind `SNUG_E2E_HAS_APP` since P3 and was re-pinned at the tile — worth a Gate 6 sweep
for other rotted env-gated specs. Windows remains unverified for `lan_fetch` (amendment 9).

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
KB layer id:              95-platform-desktop (desktop-only append; web = byte-identical assembly, no variant needed — pin superseded at P2, confirmed by orchestrator)
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

### 2026-08-13 — claude (P2 worktree agent) — P2 complete (platform truth, prompts + inference)
- Tests first, red proven both ways: knowledge `platform-truth.test.ts` 12/19 red at
  assertions + tsc-gate red on the missing `platform` seat; playground
  `platformPromptWiring.test.ts` 7/9 red. Mutation check: a web-assembly-gains-layer
  mutant killed by the negative guard (exactly 1 test bit).
- KB corrections: 90-auth's "FUTURE rung that does not exist yet" → the shipped ADR-0021
  truth (native fetch, RFC-1918 LAN from the desktop app only, browser hub keeps
  refusing private ranges) + the amendment-15 user-typed-LAN sentence; 20-html-template's
  copy-exactly comment "blocks private ranges" → approved-hosts-only framing, moved in
  LOCKSTEP with sdk/embedded/snug-hooks.js and all 14 example app.html copies (the
  three-way byte-compare demanded one commit) + sdk types.ts doc comment;
  70-defensive-coding verified clean (never repeated the claim — no edit).
- Platform seat: `HostSystemPromptOptions.platform?: 'web'|'desktop'` (PINNED); layer id
  `95-platform-desktop` (PINNED by the P2 brief — NOTE: supersedes this file's earlier
  pinned literal `95-platform-capabilities (web/desktop variants)`; web needs no variant
  because absent/'web' is byte-identical by construction). Desktop appends the layer LAST
  on both branches through the shared separator. Inferrer user slot gains the pinned
  `Platform facts (desktop):` block on desktop only; system slot static (D2).
- Call sites: builder.ts (both branches, ADR-0012 cache note), transport.ts (appRuntime),
  connectionInferrerAdapter.ts pass `getPlatform().kind`; invoke.ts UNCHANGED with
  web-only comments (desktop never calls the hub path).
- Green, tsc-gated: knowledge 164→183, playground 876→885, server 126, sdk 41,
  examples 185; root `turbo run test --force` 21/21, 0 cached. Commit 0ae904c on the
  worktree branch; orchestrator merges.
- Next step: P3 (registry request seats + Coinbase CDP + silent-401, ADR-0022).

### 2026-08-13 — claude (P3 protocol lane) — queryTemplate seat + CONNECTION_QUERY_NAME_RULE (ADR-0022 §3)
- Tests first, red proven both ways: tsc gate red on the two missing exports
  (`CONNECTION_QUERY_NAME_RULE`, `CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES`); vitest 7/10
  new tests red at assertions (the 3 green ones are pure negatives — bad-charset,
  strict-unknown-seat, `none` coherence — that must also SURVIVE the change; their
  positive siblings prove the mechanism bites).
- `connectionRequestSchema` gains optional `queryTemplate`: keys by the PINNED
  `CONNECTION_QUERY_NAME_RULE = /^[A-Za-z0-9_.\[\]-]{1,64}$/` (exported; header rule
  byte-untouched, pinned by test in rule AND behavior — underscore header key still
  rejects); values reuse `CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS` verbatim.
  NEW ADDITIVE constant `CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES = 8` (mirror of the
  header entry bound; deliberately its own name so the two seats can diverge visibly —
  additive beside the pinned literals, no supersession). `none` coherence closes over
  the new seat via the existing `request !== undefined` check (query-only request on a
  keyless kind rejected at parse, tested); canonical-hash identity sees the seat
  (requirement_version bumps, tested). strictObject discipline held (`bodyTemplate`
  sibling refused, tested).
- Schema-artifact sweep (the 2026-07-31 exported-JSON-Schema lesson): NOTHING to move —
  `connection-requirement.ts` sits behind the json-schemas publication line (NOT in
  SOURCES; `schemas/*.json` byte-unchanged, schemas-stable green), and no snapshot pins
  the request seat's inner keys (render-directive snap pins v3 hints + directive
  top-level keys only).
- SPEC_SYNC: staged in `docs/spec-drafts/spec-v0.3-auth.md` (shape block + new §4.4.2:
  own key charset, one-resolution value lint, placement-after-ceiling + enumerated-scrub
  host obligations) + spec-changelog entry marked internal-staged/not-pushed. AL-12 held;
  nothing pushed to `snugprotocol/spec`. `cdp_jwt` deliberately ABSENT from protocol and
  from this staging — helper grammar is the auth lane's.
- Executor-lane handoff notes: (a) NO protocol-level template-token validation exists
  that would reject an unknown helper name — the schema pins envelope only; the
  rejection lives in packages/auth's template lint (`AUTH_TEMPLATE_HELPERS`), which will
  refuse `{{cdp_jwt(...)}}` until amendment 7 moves the helper pins — expected, not
  pre-fixed here. (b) With the seat now parseable, amendment 1(a) (occupiedPromptSeats
  counts a queryTemplate-carrying request) is LIVE-urgent: a queryTemplate-only request
  still sails past Guard 2b until the auth lane lands it.
- Green, tsc-gated: protocol 254→264; dependents all green via
  `turbo run test --filter=...@snugprotocol/protocol` — 21/21 tasks (auth 555, db 306,
  knowledge 183, playground 885, server 126, sdk 41, adapters 120, runner 110,
  desktop 55; 2 cached = the protocol tasks run fresh moments earlier in the same tree).
- Next step: P3 auth lane (registry seats + Coinbase CDP + executor JWT/query injection
  + silent-401 observer).

### 2026-08-13 — claude (P3 executor lane) — cdp_jwt helper + queryTemplate injection + onAuthShapedFailure (ADR-0022 §2/§3/§4)
- Tests first, red proven both times: cdp-jwt/template-lint 17 red at "unknown template
  helper 'cdp_jwt'" before the grammar change; connected-fetch-query-observer 11/18 red
  (the 7 green are pure negatives that must also survive — no-fire on 200/none-kind/
  cured-retry, off-ceiling refusal — their positive siblings prove the mechanism bites).
- `cdp_jwt(api_key, private_key)` (commit 1): helper enum 4→5, HELPER_ARITY {2,2},
  per-argument lint rule STRICTER than generic (both args declared field keys — quoted
  literals and request tokens refused; the engine receives resolved values and cannot
  re-check, so the render gate's lint is the enforcement seat). PINNED_HELPERS +
  engine↔lint both-direction parity moved in the SAME commit (amendment 7; MIGRATED).
  Claims pinned by test: header {alg ES256, kid, typ JWT, nonce 16-byte hex}; payload
  {iss cdp, sub, uri '<METHOD> <host><path>' no scheme/no query, nbf now (shared
  renderTimestamp slot), exp nbf+120}. es256-key.ts DER-wraps SEC1→PKCS#8 (both PEM
  headers, pasted-\n normalization); honest typed errors: Ed25519 names the CDP-portal
  fix, undecodable PEM never echoes content, missing WebCrypto ECDSA loud (amdts 4/9).
  AC4 independent verify: openssl P-256 fixture keys checked in (test keys, not
  secrets); minted JWT decoded + crypto.subtle.verify against the fixture PUBLIC key,
  plus a tampered-payload negative so the verify is not vacuous.
- queryTemplate injection (commit 2): rendered AFTER every gate into the OUTBOUND URL
  only; confirm gate captures the PRE-injection URL (pinned); a request seat carrying
  EITHER template suppresses the kind default (query credential never also sent as
  X-Api-Key); header+query render through ONE RenderState (timestamp agreement pinned)
  and ONE declared-keys lint resolution. Scrub set widened per amendment 14: rendered
  query VALUES join the candidates at body/header scrub AND the NET_FETCH_FAILED
  message (previously unscrubbed) is scrubbed with the FULL set — C1 negatives: thrown
  credentialed URL redacted, thrown header value redacted, echoed body/etag redacted.
- onAuthShapedFailure (commit 2): optional ConnectedFetchDeps seat; fires only at the
  ONE delivery point of execute() when the delivered result is 401/403 AND credentials
  (header or query) were injected; refresh-cured 401 fires nothing; probe path strips
  the seat (`executeConnectionTestRequest` → probeDeps). test-request-single-path
  source-proof pin MIGRATED in the same commit: now pins the probeDeps derivation AND
  `createConnectedFetch(probeDeps).execute(` — strictly stronger, negative half intact.
- **Pin adaptation (journaled per the pinned-literals rule):** the pinned literal
  `onAuthShapedFailure(appId, slot, status)` is the PLAYGROUND-layer shape. At the
  ConnectedFetchDeps seam the signature is `(slot, status)` — `appId` is execute()'s
  own argument, already in the caller's hand, so threading it through deps would let a
  wiring bug report a foreign app's identity. The playground lane adds appId when it
  forwards to the RunView banner. No other pinned literal touched.
- Green, tsc-gated: auth 555→595 (31 files). Fences moved with data, same commits:
  PINNED_HELPERS (MIGRATED), single-path source proof (MIGRATED); nothing OBSOLETE,
  nothing LOST. Registry seats/Coinbase entry/wizard probe are the REGISTRY lane's.
- Next step: P3 registry lane (registry request/testRequest seats + Guard 2b
  one-resolution change + Coinbase CDP entry rewrite + seat-drift migration).

### 2026-08-13 — claude (P3 registry lane) — registry request/testRequest seats + admission amendment 1 (all three parts) + Coinbase CDP rewrite (ADR-0022 §1/§5)
- Tests first, red proven both times. Commit 1: tsc gate 6 errors (missing type seats)
  + vitest 5/9 red (queryTemplate-hole + emitter; the 4 greens are negatives that must
  also survive). Commit 2: auth 21 red pre-implementation (fences + new tests),
  playground 5 red at persisted altitude. Post-green mutation check on the committed
  tree: disabling the request byte-match exemption bit 3 tests (double-admission,
  emitter-shape admission, channel-admission whole-registry idempotence); restored via
  `git checkout` over the committed file.
- Registry seats (b28b919): `WellKnownOauthProvider` + `WellKnownAuthOption` gain
  optional `request`/`testRequest` typed AS the protocol's `ConnectionRequest`/
  `ConnectionTestRequest` (shape-compat by construction); `requirementFromRegistryEntry`
  emits them deep-copied under the existing `option ?? entry` flow rule — an option
  WITHOUT the seats removes them (a sign-in flow never inherits a signing template).
  Amendment 1(a): `occupiedPromptSeats` counts a request carrying headerTemplate OR
  queryTemplate; authored queryTemplate-only request on every borrow channel now
  REFUSED (was: sailed past Guard 2b); empty request still exempt.
- Coinbase CDP + amendments 1(b)/1(c) (8cd4ecf): fields → `['api_key','private_key']`
  (pinned labels), pinned `request.headerTemplate` `Bearer {{cdp_jwt(api_key,
  private_key)}}`, pinned `testRequest` GET /api/v3/brokerage/accounts, CDP-portal
  registration (consoleUrl `https://portal.cdp.coinbase.com/` — portal ROOT, matching
  the sibling OAuth option's existing verified citation rather than guessing a deep
  path); api_secret/passphrase GONE; OAuth option byte-untouched. ONE hoisted
  `matchAuthOption` handle now drives all three seat exemptions AND substitution;
  request/testRequest structurally identical to the MATCHED flow's pinned values are
  exempt (admission runs twice); no matched fields ⇒ no exemption (fail closed,
  negative-tested incl. cross-option composites). `applyRegistryValues` substitutes
  both seats channel-agnostically, deep-copied.
- Fences, classified in the commit: MIGRATED static-kind-registry (exact ordered CDP
  pair) · registry-template-parity (Coinbase parity re-pointed at the registry's OWN
  template: tokens↔keys both directions, lint-clean, end-to-end render to a verified
  3-segment Bearer JWT with the SEC1 fixture key; whole-registry own-keys lint now
  covers options too) · registry-self-containment AC3 (+request/testRequest
  present-iff-present + copies; D6 list) · matched-option default list ·
  inferrer registry-rung lists (x2) · connected-fetch optional-fields suite (the
  shipped entry lost its only `required:false` seat, so the founding shape moved to a
  local fixture — every assertion verbatim; mechanism is executor-altitude) ·
  playground coinbaseJourney (CDP pair + row must persist the pinned seats).
  OBSOLETE-and-enforced: the passphrase-key parity pins — replaced by a negative that
  pins the passphrase seat OUT of every entry. UNCHANGED (verified green, no edits):
  desktop-posture posture/browserCallable tables, channel-admission evasion lists.
  NEW playground `registrySeatPersistence.test.ts` (amendment 1c persisted shape):
  pipeline+db double-admission persists the seats; `stagePendingRequirement` of the
  registry shape ADMITTED on 'starter'- and 'inference'-provenance rows (the
  seat-drift migration's admission precondition, now open); near-miss staged template
  still refused.
- KB truth-up (c49acd1): pinned-provider section now states the registry pins where
  credentials are sent + how connections are tested (the previously-false promise is
  true); omit-list names the whole `request` seat; "four helpers" → five with a
  cdp_jwt use-only-for-that-scheme caveat (the executor lane's helper made the
  "anything else is rejected" copy false for authored providers too). Generated
  content regenerated; P2's platform paragraph + headings untouched.
- DELIBERATELY NOT MOVED, against the executor-lane handoff note: the protocol
  `connection-requirement.test.ts` Coinbase-Exchange fixture. It imports nothing from
  the registry, pins the SCHEMA's expressiveness for a signed three-value provider on
  `api.exchange.coinbase.com`, and its own comment already distinguishes the Exchange
  surface from retail/CDP. Protocol suite verified green (264) with zero edits — the
  fixture is not a fence on registry data.
- Green, tsc-gated: auth 595→620, knowledge 183, playground 885→889, protocol 264
  (untouched). Left for the playground lane: wizard probe render for Coinbase +
  done-screen truth, RunView banner, seat-drift wizard-open migration wiring,
  registry seat data for openweather/coingecko (P4 starters realignment).

### 2026-08-13 — claude (P3 host lane) — AC5 banner + wizard-open drift migration + coinbase probe pin (ADR-0022 §4, amendment 3)
- Tests first, red proven both times: authShapedFailureSurface 13 red (suite unloadable
  on the missing store/component, then 12/13 at assertions); registryDriftMigration
  10 red (9 at the missing `migrateConnectionRegistryDrift` / un-migrated persisted
  shapes; the item-2 probe test's BUTTON already rendered — the probeable gate lit the
  moment the registry lane pinned testRequest, so that test is a component-surface
  FENCE on predecessor work, red only at its outcome wait).
- AC5 banner (d801c64): `connectedFetchDepsFor` gains an optional observer param
  threaded ONLY by `createNetHandlerFor`, which adds the appId it already holds — the
  pinned literal `onAuthShapedFailure(appId, slot, status)` is this playground
  altitude, completing the executor lane's journaled (slot, status) adaptation. New
  `authShapedFailureStore` (one failure at a time, appId/slot/status and nothing else);
  `AuthRepairBanner` in RunView renders provider-named copy ("<provider> rejected this
  app's credentials (401)…") with a "check this connection" CTA. **Journaled seam
  choice:** the CTA calls `openConnectionWizard({appId, slot, source:'error_cta'})` on
  the EXACT failing slot — the brief's `openConnectionWizardForApp` takes (appId,
  source) and re-picks a slot; the observer knows the slot, and AC5's own text says
  "opening the wizard on the failing (appId, slot)". Dismisses only on a real boolean
  open (Promise-truthiness lesson re-pinned). Negatives at the shipped seam: 200,
  kind-none 401, refresh-cured OAuth 401 (full production fixture), wizard probe
  (deps never thread the seat AND executor strips it — both halves driven),
  foreign-app banner, refused-open keeps the banner; ok:true + status passthrough
  pinned unchanged.
- Drift migration (48664cc): `migrateConnectionRegistryDrift(appId, slot)`, run by the
  SHEET before first render — every open route (Settings, chat card, net-error CTA,
  AC5 banner CTA) lands there, so amendment 3's "wizard open AND banner CTA route" is
  one seam. SEAT drift (fields unchanged, pinned request/testRequest absent): the
  row's own requirement re-runs registry substitution through `stagePendingRequirement`
  (the ONE admission resolution — amendment 1's byte-match exemption is what opens the
  path) and a HOST-IDENTICAL result is promoted via `reapproveConnection`: **approval
  status survives** (never leaves `approved`), secrets untouched, version bumps, net
  grants invalidated (R3). **Journaled honest behavior:** `approved_at` is refreshed by
  the promotion accessor — the amendment binds the STATUS, and no user re-approval is
  forced; a ceiling that would move at all is left STAGED for the ordinary diff
  instead. FIELD-SET drift (owner's old coinbase triple — Guard 2b refuses the row's
  own persisted shape, which IS the detection): the registry's current kind-matched
  shape is staged, the diff disclosed, and `reapproveFromDiff` now walks the
  credential half on a field-set change too (same rule as the kind rebind — "existing
  secrets still valid" is false when the boxes changed). **Journaled:** the route is
  register → credentials (the machine's derived path; the registry pins a CDP-portal
  walkthrough the user needs to mint the new key, one screen before the brief's
  "credentials step"), and old secrets for dropped fields (api_secret, passphrase)
  stay in storage untouched but unused — wiped only by revoke/delete as ever. Never
  touched: unapproved rows, app-staged pending edits (never clobbered), non-registry
  providers, revoked tombstones, secrets. Migration failure → sheet renders the row as
  stored (pre-migration behavior, never a blocked wizard).
- AC6 sub-test fixture honesty: pre-existing approved old-shape rows are minted
  through a db opened with the PERMISSIVE default admission gate ("an older hub
  admitted this under the old registry"), then reopened under the production gate —
  current admission refuses the old shapes, which is the drift itself; the persisted
  shape is what is asserted, and the probe is proven to aim the pinned
  `/api/v3/brokerage/accounts` with a real 3-segment `cdp_jwt` Bearer minted from the
  stored EC test key (generated per-run, never checked in).
- No Guard 2b provenance collision surfaced: the stage path admits on the row's stored
  channel exactly as amendment 1(c) proved open; registry-provenance rows ride the
  same branch (Guard 2b exempt, substitution identical). Nothing improvised.
- Green, tsc-gated: playground 889→912 (95 files; wizard/settings/desktop/coinbase
  suites green with zero edits to existing tests — the reapproveFromDiff routing
  change broke none, since every existing reapprove fixture stages same-field shapes);
  auth 620 (dist consumer, untouched). Left for P4: openweather/coingecko registry
  queryTemplate data + starters; the migration seam is live for them the moment their
  registry entries gain seats.

### 2026-08-13 — claude (P4 starters lane) — openweather/coingecko query data + starter journey + dead code (AC6, P4 items 1–4)

- Producer verification first: all P3 lane commits present (a53b788 · 2c13ee0/49ddf82 ·
  b28b919/8cd4ecf/e6480ce · d801c64/48664cc · 024dded); `packages/auth` green at 620
  before any P4 work. No orchestration defect.
- **Registry data (8b386fd)**, red-first (new `registry-query-credentials.test.ts` 14 red /
  10 green — the greens are pure negatives that must ALSO survive: Guard 2b still refusing
  authored query templates on every borrow channel, ceiling checks, and the
  coingecko-has-no-testRequest pin). openweather gains
  `request.queryTemplate = { appid: '{{api_key}}' }` (PINNED literal) and its comment now
  NAMES where the placement is pinned instead of promising it; coingecko gains
  `{ x_cg_demo_api_key: '{{api_key}}' }` (PINNED literal).
- **Two brief claims REFUTED by live probes + primary docs (2026-08-13), recorded in the
  entry comments so neither is re-litigated:**
  1. *"CoinGecko's custom header is not in its CORS preflight allow-list."* FALSE — a live
     OPTIONS probe shows CoinGecko REFLECTS `x-cg-demo-api-key` back in
     `access-control-allow-headers`; both forms work from a browser today. The query form
     is still the right pin, but for preflight-INDEPENDENCE (a query param is a simple
     request and never asks for a preflight), not for a CORS wall that does not exist.
  2. *The suggested coingecko testRequest.* `api.coingecko.com` is a documented "Keyless
     Public API" — every endpoint answers 200 with NO key, so any probe would report
     CONNECTED for a typo'd key; `/api/v3/key` is Pro-plan-only on `pro-api.coingecko.com`
     (live probe on the demo host: 401 error_code 10005) and would fail for every CORRECT
     demo key, off-ceiling besides. **Deliberate omission journaled: coingecko carries NO
     testRequest.** No button beats a meaningless one. openweather DOES get one —
     `GET /data/2.5/weather?q=London`, verified live to 401 without a valid appid, so it
     exercises the credential rather than merely reaching the host.
- **Starter journey (83cee14)**: new `starterQueryCredentialJourney.test.ts` (11 tests) at
  playground altitude, because the seam spans packages and no per-package test can reach
  it. Requirement read from the SHIPPED MANIFEST ON DISK; persisted through the real
  pipeline + production db gate (both admission passes); deps from the exported production
  `connectedFetchDepsFor` — never a hand-rolled deps object. Asserts the PERSISTED row's
  queryTemplate, the credential on the wire as a query param with `X-Api-Key` absent and
  the app's own params intact, C1 over the WHOLE serialized result (driven with a response
  echoing the credentialed URL in body AND etag), the thrown-URL redaction
  (amendment 14's NET_FETCH_FAILED site), off-ceiling refusal, and a cross-contamination
  negative (both starters share the `api_key` kind AND field key — a slot-routing defect
  would be invisible in any single-app test). Red-first in two layers: 5 red / 6 green on
  the shipped tree, then mutation-verified on green — swapping openweather's queryTemplate
  for a headerTemplate reds exactly its 3 assertions.
- **Starter apps: VERIFIED, NO CHANGE NEEDED.** weather-planner's `FORECAST_URL` and
  crypto-portfolio's `PRICES_URL` already call bare endpoints with only the app's own
  parameters — a fresh scan of both files for key/token/authorization strings returns only
  `appId` (host-assigned identity). Both already say "C1 by construction". The test's app
  URLs are taken from the shipped app source rather than invented.
- **Mirrors: VERIFIED UNCHANGED, no edit.** `DEMO_STARTER_REQUIREMENTS` still mirrors the
  four bare manifests byte-for-byte and `connection-manifests.test.mjs`'s lists are
  correct — bare manifests stay bare, so the P0 refutation holds after the data landed.
- **Dead code + comment truth (8a802fc).** `HubView.installStarter` DELETED — zero callers
  (grepped apps/packages/examples/docs; only its own definition and three done/ task files
  calling it dead), tiles route through `openStarter`. It was a loaded gun: it saved HTML
  and navigated, FULL STOP — no `installStarterConnections`, no
  `installStarterRuntimeContract` — so rewiring a tile to it would ship a connected starter
  with no connection row and no runtime contract. Orphaned `installing`/`installError`
  state, the banner and the `loadStarterHtml` import went with it; a comment at
  `openStarter` records why the hub has no install path. `starterDeclaration.ts`'s claim
  that "the Settings surface renders this" is FALSE (no renderer of `mismatch` exists
  anywhere in the UI; a `console.warn` is the only signal) — comment corrected, real
  surface queued in next-steps, NOT built. Two test names/comments repeating the claim
  trued up with ASSERTIONS UNTOUCHED.
- **The root run earned its keep again (f0c74ad).** Runs 1–3 green, run 4 RED: P3's
  `registryDriftMigration` coinbase probe was still flaking (measured 3/12 = 25% on the
  committed tree). **P3's diagnosis was wrong and its fix could never have worked**: it
  raised `vi.waitFor` to 10s inside a test whose OWN vitest timeout is the 5000ms default,
  so the raise was unreachable and every failure was an anonymous "Test timed out in
  5000ms" at 5004ms. The mint was never slow — 200 consecutive SEC1→PKCS#8 imports + ES256
  signs take 83ms, and the failures are BIMODAL (with a 30s budget: ~158ms or a full hang).
  **ROOT CAUSE: `vi.waitFor` was called INSIDE `act()`** — React's `act` owns the scheduler
  while its callback is pending, so the component could never re-render with the resolved
  outcome; the condition was structurally unable to become true from inside the call
  waiting for it. (Every diagnostic `console.log` I added made it pass, by shifting the
  render ahead of the wait — a Heisenbug in both directions.) Fixed by moving `waitFor`
  outside `act` with `settle()` awaited inside each poll; CONDITION untouched. Also made
  the inner budget strictly smaller than an explicit outer one (8s wait, 15s testTimeout)
  so a real hang is named by the assertion rather than by an anonymous timeout.
  Mutation-verified: hanging `cdp_jwt` still reds both probe tests through the rebuilt
  dist. 0 failures in 20 file runs and 8 full-suite runs.
- **Fences (AC9), classified:** MIGRATED registry-self-containment "the emitter hands out
  COPIES" — the whole-registry copy fence only unwrapped `headerTemplate` and silently
  stopped covering the whole registry the moment queryTemplate-only entries arrived; now
  checks BOTH seats, mutation-verified. UNCHANGED and verified green with zero edits:
  static-kind-registry exact field lists (fields untouched), registry-template-parity
  (already iterates both seats and auto-lints the new templates), desktop-posture
  posture/browserCallable tables, well-known-providers structural rules,
  test-request-single-path, registry-substitution, matched-option, demoRequirementStarters,
  connection-manifests. **Nothing OBSOLETE, nothing LOST, no test weakened or deleted.**
- Green, tsc-gated: auth 620→646 (33 files), playground 912→923 (96 files), examples 185,
  protocol/knowledge/db/server/sdk/adapters/runner/desktop untouched. Root
  `turbo run test --force` run FOUR times consecutively: `Tasks: 21 successful, 21 total` ·
  `Cached: 0 cached, 21 total` every time.
- Next step: P5 (Hue LAN connector, ADR-0023).

### 2026-08-13 — claude (P5 shape lane) — lanHost protocol seat + hue entry + the three-part admission fork (ADR-0023 D1/D2, amendments 2 and 10)

- Producer verification first: all P4 commits present (8b386fd · 83cee14 · 8a802fc ·
  f0c74ad · 27ffb92 · 28a509b); `packages/auth` green at 646 and `packages/protocol` at
  264 BEFORE any P5 work. No orchestration defect.
- **Every claim in the brief re-executed as a probe before code moved**, against the built
  dist with a hue-shaped entry injected at runtime. All confirmed:
  1. **amendment 2 (lan-schema-2) CONFIRMED** — the pre-collection LAN row is
     unrepresentable: `safeParse` fails "declaredApiHosts: Invalid input: expected array,
     received undefined". Also confirmed and worth recording: a private IP literal
     ALREADY parses as a `declaredApiHosts` entry today (`CONNECTION_HOST_RULE` accepts
     digit labels), so the fork adds an EXTRA rule for LAN rows rather than loosening the
     host charset.
  2. **amendment 10(a) CONFIRMED** — `PROBE-A: THREW -> TypeError: entry.apiHosts is not
     iterable` for a requirement naming "Some Obscure SaaS". One apiHosts-less entry
     makes EVERY admission of EVERY requirement throw, from inside the guard whose whole
     job is to fail closed.
  3. **amendment 10(b) CONFIRMED** — with (a) patched in the probe: `PROBE-B: ok= true
     hosts= []`. The user's declared `192.168.1.50` REPLACED by the entry's absent hosts,
     silently, ok:true.
- **THE XOR RULE, decided and journaled** (the brief asked me to decide by reading how
  `deriveConnectionAllowedHosts` and the ceiling freeze consume `declaredApiHosts`):
  the derivation unions `declaredApiHosts` into `snug_connections.allowed_hosts` at
  approval and that frozen ceiling IS the runtime wall, so the collected bridge address
  must be able to live in `declaredApiHosts` — there is no second path by which a ceiling
  could freeze around the user's device, and inventing one would mean two host objects
  where the schema has always insisted on one. Hence: **no lanHost ⇒ declaredApiHosts
  required non-empty (byte-identical to today, pinned by test); lanHost present ⇒
  declaredApiHosts either ABSENT (pre-collection) or EXACTLY ONE host of the declared
  class (post-collection)**. A public host beside a lanHost would freeze a public host
  into a ceiling the review screen presents as "a device on your own network"; a second
  private literal is a second device the user never paired. Both refused, both ways
  pinned. `deriveConnectionAllowedHosts` returns `[]` for a pre-collection row — an empty
  ceiling that refuses everything, which is why the wizard order is binding: collect →
  approve → freeze → pair.
- **`isRfc1918Ipv4Literal` is a deliberate RESTATEMENT, not a reuse**: `packages/auth`
  depends on protocol, so importing `isPrivateRfc1918Ipv4Literal` would be a dependency
  CYCLE. The two are pinned equivalent by a 28-case cross-package test in packages/auth,
  so a drift fails loudly instead of becoming two guards disagreeing about "private"
  (lesson 2026-08-10). Journaled because the brief asked which way this went.
- **Admission fork (all three parts)**, each mutation-verified with a killing test:
  restoring the original crash → 22 red; reverting 10(b)'s host preservation → 6 red;
  disabling 10(c)'s class check → 7 red. Guard 2c runs BEFORE Guard 2b and on EVERY
  channel **including `registry`** — a host rule, not prompt copy, and registry is exactly
  where the P3 seat-drift re-substitution lands. ADR-0020's "hosts are ALWAYS the entry's"
  carve-out is scoped to lanHost entries ONLY, pinned by a test that a normal entry still
  substitutes.
- **One mutation initially SURVIVED and was fixed rather than shipped** (worth keeping for
  Gate 6): deleting the `registryHostIndex` lanHost skip killed nothing, because the
  null-safe `?? []` beside it already covers today's hostless entry. *A guard that
  survives its own deletion is decoration* — added a test that drives the skip directly
  (a LAN entry mutated to ALSO carry apiHosts must still contribute no host trigger), and
  the skip now kills its mutant.
- **Registry lookup behavior, journaled because a test of mine asserted it wrongly first:**
  `lookupWellKnownProvider('Philips Hue')` correctly returns UNDEFINED — resolution is
  exact-key by contract (the key is the pinned literal `hue`), and resolving a
  brand-adjacent spelling there would hand it the entry's pinned values as if it had asked
  for them. The human spellings reach the entry by the two paths that should: the BAN via
  `findBrandAdjacentRegistryKeys` (segments `philips`+`hue` → run `hue`) and the INFERRER
  via the new aliases. All three paths now pinned.
- **Deliberate omissions, both journaled rather than silent:** hue carries NO
  `testRequest` (every CLIP v2 read needs the key pairing mints — a probe before pairing
  can only fail, one after merely repeats what pairing proved; pairing IS the
  verification, same discipline as coingecko's P4 omission) and NO
  `desktopRedirectPosture` (a LAN device runs no OAuth redirect; the posture-completeness
  suite treats it as the static kind it is, +1 row, no new posture literal needed).
- **Pinned literals: every one honored EXACTLY, no supersessions.** Registry key `hue`,
  kind `api_key`, fields `['application_key']` (secret), header
  `{'hue-application-key':'{{application_key}}'}`, lanHost
  `{class:'rfc1918-ipv4-literal', label:'Bridge IP address'}`, pairing `POST /api` with
  `{"devicetype":"snug#hub","generateclientkey":true}` → `success[0].username`.
- **Fences (AC9), classified, moved in the same commits as the data:** MIGRATED KIND_TABLE
  10→11 · well-known-providers "non-empty apiHosts" → "pinned apiHosts XOR lanHost" (the
  old rule's content survives verbatim inside branch (a) — nothing LOST) · registry-self-
  containment AC3 emitter + the whole-registry COPY fence (forked so it does not go
  vacuous on LAN entries the way the queryTemplate copy fence silently did at P4) ·
  desktop-posture browserCallable table + static-kind no-posture list · channel-admission
  whole-registry idempotence + host-trigger loop. UNCHANGED and verified green with zero
  edits: static-kind-registry exact field lists, registry-template-parity, matched-option,
  test-request-single-path, registry-substitution, registry-request-seats. **Nothing
  OBSOLETE, nothing LOST, no test weakened or deleted.**
- **Eleven consumer sites the now-nullable `declaredApiHosts` surfaced were each fixed
  honestly, never cast away**: `requirementToSpec`, `deriveRowHosts` and the probe
  base-host in connected-fetch (a pre-collection LAN row genuinely has no host — the probe
  refuses with NET_NOT_APPROVED, which is the truth); the wizard host diff, the RunView
  starter teaser and the revoked-before check in playground; and the test-side fixtures,
  whose pinned-host premise is now STATED rather than optional-chained past (lesson
  2026-08-06).
- SPEC_SYNC: `docs/spec-drafts/spec-v0.3-auth.md` gains the shape block + new §4.8 (the
  seat, the XOR verdict table, three host obligations) and `docs/spec-changelog.md` an
  entry marked INTERNAL DRAFT / not pushed. AL-12 held; nothing pushed to
  `snugprotocol/spec`.
- Green, tsc-gated: protocol 264→280, auth 646→693; db 306, knowledge 183, playground 923,
  server 126, sdk 41, adapters 120, runner 110, desktop 55 — all untouched and green. Root
  `turbo run test --force` run THREE times consecutively: `Tasks: 21 successful, 21 total`
  · `Cached: 0 cached, 21 total` every time; auth suite alone 8 consecutive runs, failure
  rate **0/8**.
- Left for P5's sibling lanes: the wizard bridge-IP step + pairing flow + discovery button
  (the `pairing` seat is data-complete and waiting), the desktop Rust `lan_fetch`
  pinned-TLS command + `lanFetch?` executor dep, the starter rewrite + e2e, the Rust-
  boundary simulated-bridge test (amendment 13), and the amendment-15 private-IP consent
  copy on the review screen.

### 2026-08-13 — claude (P5 transport lane) — Rust `lan_fetch` pinned-TLS command + the `lanFetch` executor seam (ADR-0023 D3, amendments 5/6/13/16)

- Producer verification first: P5-shape's commits present (a5029e9 · 77747fe + journal
  bd07e10); `packages/auth` green at 693, desktop at 55, playground at 923, cargo at 26
  BEFORE any P5-transport work. No orchestration defect.
- **The brief contradicted the code once, and the code was right** — the single finding
  worth carrying to Gate 6. Routing EVERY `lanPrivateHost` request to `lanFetch` (the
  literal reading of amendment 6) reddened four pre-existing Decision-6 tests. They were
  correct: ADR-0021's http-to-private-literal rung is a DIFFERENT transport, for LAN
  devices that serve no TLS at all, and ADR-0023's own alternatives section keeps it
  explicitly — *"ADR-0021's http-for-private-literals rung remains for other LAN device
  classes."* A plain-http device can never have a certificate, hence never a pin, so
  routing it to the pinned path would have refused it **forever**, silently retiring a
  shipped rung with a green suite. Condition is `lanPrivateHost && url.protocol ===
  'https:'`, reasoned from the ADR rather than from the four red tests. *Lesson shape: a
  guard that is "the same class" in one dimension can be two classes in another — the
  host class was right and the SCHEME was the axis the amendment did not name.*
- **Rust (`src-tauri/src/lanfetch.rs`, 22 tests, cargo 26→48).** Two explicit modes on a
  `rustls::ServerCertVerifier` this crate owns: `pair` accepts-and-CAPTURES the leaf's
  SHA-256 fingerprint + CN (reqwest never exposes the peer cert to callers, so the capture
  lives INSIDE the verifier and rides back beside the response — amendment 5), `pinned`
  requires a 64-hex pin and refuses any other leaf. An unknown mode is an ERROR, never
  defaulted to the "safer" one: defaulting either grants pair-mode trust to a typo or
  produces a pinned refusal the caller cannot explain. Host class (RFC-1918 IPv4 literals
  only — loopback, link-local, CGNAT, public literals, DNS names, IPv6 both spellings, and
  leading-zero octal forms all refused), `Policy::none()` unconditionally, the 1 MiB cap on
  the STREAM before bytes cross IPC, and a FRESH client per call are all enforced in Rust
  before a socket opens. The fresh-client rule is not hygiene: the verifier only runs at
  handshake, so a pooled connection established under one pin would serve a later call
  carrying another with no check at all.
- **AC7's CI fixture is the Rust-boundary test (amendment 13), and the reason is
  structural**: the host-class check refuses loopback, so no 127.0.0.1 stub can reach this
  path. The verifier is fed real `rcgen` DER certificates directly. Deps named rather than
  borrowed transitively (reqwest/rustls/sha2 all already ride in via tauri-plugin-http's
  default `rustls-tls`) — a transitive dependency is not an API contract. `cargo check
  --release` run explicitly: the `#[cfg(not(debug_assertions))]` handler list carrying
  `lan_fetch` is compiled, not just source-scanned.
- **Amendment 16, per-command not command-family**: `ipc-lan-fetch-refused` joins
  `IPC_CHECK_IDS` with its OWN callback slot in the sandboxed probe, so a refusal proven
  for `write_user_file` can never be credited to `lan_fetch` (pinned by a test that drives
  exactly that borrowed-evidence case). Its sensor is honestly weaker than the sentinel and
  says so in its own detail string — `lan_fetch`'s effect is a request to a private IP, and
  the Rust host-class check refuses every address a CI runner can bind, so there is nowhere
  for a "did it fire?" listener to sit. It vouches only alongside the three key-absence
  checks, and every "cannot tell" input FAILS (the 2026-07-31 unanswerable-sensor rule).
- **Executor seam (`connected-fetch.ts` gate 9a).** Routing decided where `lanPrivateHost`
  is already computed and the ceiling is already known — a platform-level router would have
  to re-derive both. **Neither absence is a fallback, and both refusals are the design**:
  no `lanFetch` dep → named refusal (`deps.lanFetch ?? deps.fetchImpl` would send a bridge
  request through the public-root transport: opaque TLS failure at best, success against
  the wrong device at worst); no recorded pin → named refusal (pair mode is a wizard step
  the user consents to by pressing a physical button; a request-time fallback would be the
  accept-invalid-certs call this whole design exists to avoid). The pin's SHAPE is
  re-validated at this seam rather than trusted from storage, so a corrupted KV fails
  loudly here instead of as a mystifying handshake error two layers down.
- **Pin custody**: `AuthConnectionState.lanPin` in `auth:<appId>:<slot>:_connection`
  (ADR-0014) — NOT a db column, exactly as the P0 refutation predicted. Per-connection by
  construction, since the grant's store is already slot-scoped (pinned by a test that
  writes a second slot's pin and proves it is invisible).
- **GUARD RE-PROOF, driven THROUGH the LAN path** (the 2026-08-12 lesson, whose founding
  precedent is this very transport family): redirecting simulated bridge →
  NET_REDIRECT_BLOCKED; oversized body → NET_SIZE_EXCEEDED; denied confirm → nothing sent
  on either transport; credentialed 401 → the auth-shaped observer still fires. None of
  these were assumed from the shared `init` object.
- **A MUTANT SURVIVED and was fixed rather than shipped** (the P5-shape lane's lesson, one
  lane later): deleting `lanFetch,` from the desktop platform object left all 80 desktop
  tests green — every test drove the module function directly, and the playground wiring
  suite stubs the platform rather than building the real one. *The one fact that makes this
  entire lane reachable in production was unasserted.* Three wiring tests added; the mutant
  now dies, as does aliasing `lanFetch` to `fetchImpl`. Lesson shape: **when a lane spans
  two packages, the seam BETWEEN them is the thing neither package's suite is watching.**
- **A FIXTURE FIXED, NOT A GUARD** (lesson 2026-08-06): the playground fixture authored
  `fields` + `request.headerTemplate` while borrowing the hue brand, and Guard 2b refused
  it. Making the fixture BARE was the fix — and it upgraded the test, which now exercises
  registry substitution + admission + executor routing end to end instead of a hand-built
  row.
- **Fences (AC9), classified, moved in the same commits as the data:** MIGRATED ×2 in
  `connected-fetch.test.ts` (two Decision-6 tests written when `fetchImpl` was the only
  transport, so "the gates admitted it" and "it went out through fetchImpl" were one
  observation; both CLAIMS survive verbatim and the assertions now follow the request to
  where it actually goes — the harness gained a separate `lanCalls` so a transport switch
  can never hide as an empty `calls`) · MIGRATED `test-request-single-path` (its "exactly
  two network seats" allowlist matches on `fetchImpl(` and is structurally blind to a LAN
  seat — now also pins exactly ONE module holding `lanFetch(`, no `deps.lanFetch(` in the
  probe body, and neither `??` fallback direction in source). **Nothing OBSOLETE, nothing
  LOST, no test weakened or deleted.**
- **Pinned literals: every one honored exactly.** `lanFetch?(url, init, pin)` beside
  `fetchImpl` with `FetchLike` byte-untouched; `lan_fetch { mode: 'pair' | 'pinned' }`;
  TOFU pin at `snug_secrets` KV `auth:<appId>:<slot>:_connection`. No supersessions.
- Green, tsc-gated: auth 693→712, desktop 55→83, playground 923→929, cargo 26→48;
  protocol 280, db 306, knowledge 183, server 126, sdk 41, adapters 120, runner 110,
  examples 185 all untouched and green. Root `turbo run test --force` run THREE times
  consecutively: `Tasks: 21 successful, 21 total` · `Cached: 0 cached, 21 total` every
  time. Failure rates measured, not assumed: desktop **0/6**, auth **0/5**, cargo **0/5**.
- Left for P5's sibling lanes: the wizard bridge-IP step + pairing flow (`lanPair` is
  exported from `apps/desktop/src/lan-fetch.ts` and returns the captured pin beside the
  response, so pin + minted key are written in one step) + discovery button; the starter
  rewrite + e2e; amendment 15's private-IP consent copy on the review screen.

### 2026-08-13 — claude (P5 flow lane) — the LAN wizard + consent copy + the hue starter's LAN declaration (ADR-0023 D1/D2/D4, amendments 5/15; AC8)

- Producer verification first: P5-shape's commits (a5029e9 · 77747fe + journal bd07e10)
  and P5-transport's (e5950b7 · 1ab60d1 + journal e620c8e) all present; desktop green at
  83 and auth at 712→714 BEFORE any P5-flow work. No orchestration defect.
- **The binding order is now enforced on the surface the user touches**: a pre-collection
  LAN row renders an ADDRESS STEP instead of the review, because approving one would
  freeze an empty ceiling that refuses everything with nothing on any screen to explain
  it. Collect → approve → pair, with the pairing step gated on `approved` and on a
  single RFC-1918 ceiling host, and the exchange URL built from the FROZEN ceiling plus
  the registry's pinned path (the pairing seat deliberately cannot express a host).
- **A NEW PLATFORM SEAT, `lanPair?(url, init)`, deliberately NOT beside the executor's
  deps.** P5-transport exported `lanPair` for the wizard but left it unreachable from the
  playground; a seat on `SnugPlatform` is the honest channel, and its asymmetry with
  `lanFetch` is the guard: `connectedFetchDepsFor` threads `lanFetch` alone, so a
  request-time path to accept-and-capture does not exist. Pinned by test on both sides.
- **TWO DATA DEFECTS FOUND BY DRIVING THE FLOW END TO END**, both journaled rather than
  quietly fixed:
  1. **`hue.pairing.secretPath` was inverted** — `['success', 0, 'username']`, a literal
     reading of the pinned literal's ambiguous prose `success[0].username`. A CLIP v1
     pairing answer is an ARRAY of result objects, OUTERMOST, so the index comes first.
     Probed both encodings against a real-shaped body before touching anything: the
     shipped path resolves to `undefined` on EVERY real bridge response, so pairing would
     have failed forever ("the device did not hand back a key") while the bridge answered
     perfectly. Corrected to `[0, 'success', 'username']`. **This SUPERSEDES the pinned
     literal's spelling** — recorded here under the adapt-and-journal rule, and reported
     in openItems. The registry's own prose comment already described the array-outermost
     shape and the desktop lane's fixtures already used it; only the path disagreed.
  2. **The fence that pinned it could not have caught it.** It compared the registry's
     array to a retyped copy of itself and was green against a path that finds nothing.
     MIGRATED to a test that WALKS the path through a real response body (lesson
     2026-08-04), plus a negative that the walk cannot land on the Entertainment
     clientkey. The old test's CLAIM survives verbatim; only its altitude moved.
- **ONE RESOLUTION, EXTRACTED RATHER THAN COPIED.** `lookupWellKnownProvider('Philips
  Hue')` correctly returns UNDEFINED (exact-key by contract — P5-shape's design note),
  so the wizard needed the brand-adjacent rung admission uses to reach `hue`. Rather than
  re-derive it, `resolveRegistryEntryByName` moved OUT of `requirement-admission.ts` into
  the registry module and both call it. Two copies would eventually pair using an
  exchange from an entry the row never borrowed from (lesson 2026-08-12).
- **MUTATION-TESTED ALL SEVEN NEW GUARDS at rule AND call site. TWO SURVIVED and were
  fixed rather than shipped** — the third and fourth instances of this task's recurring
  shape:
  - **The pairing STATUS guard survived its own deletion.** The "unreachable before
    approval" test could not kill it: a pre-collection row has no HOST either, so the
    host guard beside it refuses first and masks the deletion. The discriminating input
    is a row with a COLLECTED address that is not yet approved — the exact state a user
    occupies between typing and approving. *Lesson shape: two guards in one function mask
    each other exactly the way a guard and a null-safe accessor did at P5-shape; whichever
    runs first makes the other look load-bearing.*
  - **`lanPair,` deleted from the desktop platform object left all 83 desktop tests
    green** — P5-transport's `lanFetch` seam mutant, one seat and one lane later, in a
    codebase that had already learned this lesson twice. The desktop tests drive the
    module function directly; the playground's wizard suite supplies its own fake
    platform. **The seam between two packages is what neither package's suite watches.**
- **A guard proven UNREACHABLE and recorded as such rather than given a test that cannot
  fail.** The pairing seat's host check: a probe over every channel × three off-class
  ceilings (public, two-private, private+public) showed admission refuses them all, so no
  production state reaches it. It stays as belt to admission's braces, and the test now
  pins the braces at the altitude where the decision is made (lesson 2026-08-05).
- **A FIXTURE FIXED, NOT A GUARD, twice** (lesson 2026-08-06): the consent-band fixture
  first borrowed `api.github.com` and Guard 2b refused it for authoring `fields` under
  GitHub's brand; and a slot named after a dotted address was refused by the slot charset.
  Both were the fixture being wrong, and both refusals were the rules working.
- **Amendment 15's consent band keys on the HOST, never on `lanHost`** — the load-bearing
  choice, since the threat is a prompt-injected `api_key` row aimed at a router, which
  carries no LAN seat and borrows no brand. Tested with a non-hue, non-lanHost
  requirement across /8, /12, /16, loopback and link-local, and negatively against a
  public host that merely LOOKS private (`192-168-1-1.attacker.example`). It WARNS and
  names the address; it never refuses, because self-hosted services are legitimate.
- **AC8 — A BRIEF-vs-CODE CONTRADICTION, stopped and reported rather than improvised.**
  The brief asks the starter to call the bridge through `useConnectedFetch` against CLIP
  v2 endpoints. **It cannot, and the limit is the runtime's rather than the app's.** The
  executor takes a LITERAL url (`new URL(input.url)`) and checks its host against the
  frozen ceiling; there is **no frame through which the host tells an app which hosts it
  may reach** (grepped `packages/protocol/src/frames.ts`, `runtime-contract.ts` and the
  SDK hooks — nothing). A placeholder host does not parse; a hardcoded one is right for
  exactly one user. Handing sandboxed app code the user's home-network address would be a
  NEW disclosure needing its own protocol decision, not something a starter may take. So
  the app **declares** the connection, **holds** the governed seam, and keeps its apply
  control greyed with copy naming the REAL reason — replacing the old reason ("the
  desktop app does not exist"), which stopped being true this task. **Queued, not
  silent:** an approved-host disclosure frame is the missing piece, and it is a protocol
  decision for its own task.
- **The manifest is BARE and that is load-bearing.** A starter manifest borrows the `hue`
  brand, and Guard 2b refuses a borrowing channel that authors `fields`/`request` — a
  "helpful" fields array would make it UNADMITTABLE and install an app whose connection
  could never be created. Pinned by a suite that drives the **real shipped bytes** through
  schema → admission → substitution (every other suite either injects a fixture or stops
  at the schema, so none could see it) and asserts the refusal for exactly that edit.
- **Fences (AC9), classified, moved in the same commits as the data:** MIGRATED
  `connection-manifests` five declarers → six + the "hue ships NO manifest" negative → two
  positives (LAN shape, bare manifest) · MIGRATED `validate.test.mjs` `readDeclaredHosts`
  forked with required-XOR-lanHost (old rule verbatim in branch (a); the LAN branch is
  STRICTER and returns `[]` so no URL literal is allowlisted by it) · MIGRATED
  `lan-class-registry` secretPath value-pin → walk-pin · MIGRATED both e2e hue pins.
  **OBSOLETE:** "hue declares nothing" and the demoRequirement comment resting on it (the
  hue demo variant stays absent for a NEW stated reason: those variants drive a 127.0.0.1
  stub, and both the address step and the Rust host-class check refuse loopback by
  design). **Nothing LOST, no test weakened or deleted.**
- **An e2e pin that could never have passed, found by re-deriving rather than trusting.**
  `starters-connect.spec.ts` opened hue by clicking `open hue lights party` — a button P3
  made `disabled` when it marked the tile `desktopOnly`. Both hue specs sit behind
  `SNUG_E2E_HAS_APP`, so the suite could not tell. Re-pinned at the TILE, where the
  honesty actually renders; the install spec's OUTCOME (no row from browsing the web hub)
  is preserved with its reason now asserted rather than assumed — `starter-install` lives
  in the run view, unreachable behind a locked tile, so the old assertion measured a proxy.
- **REAL HARDWARE IS NOT REQUIRED BY ANY TEST THIS LANE WROTE, and CI does not depend on
  one.** Every wizard test drives a faked `lanPair` platform seat; the transport itself is
  proven at the Rust boundary (P5-transport, amendment 13). The owner's manual
  verification is AC7's closing step and is spelled out in the handoff below.
- Green, tsc-gated: auth 693→714, desktop 83→85, playground 929→971, examples 185→189;
  protocol 280, db 306, knowledge 183, server 126, sdk 41, adapters 120, runner 110 all
  untouched and green. Root `turbo run test --force` run THREE times consecutively:
  `Tasks: 21 successful, 21 total` · `Cached: 0 cached, 21 total` every time. Failure
  rates measured, not assumed: playground **0/5**, desktop **0/5**, auth **0/3**, and the
  three new suites alone **0/6**.
- Left for P6: the owner's real-bridge verification (steps below), the Windows leg
  (amendment 9, still unverified), and the approved-host disclosure frame the starter's
  apply path is waiting on.

**OWNER MANUAL VERIFICATION (AC7's closing step) — no test depends on this.**
1. Build and run the desktop app on macOS, on the same network as the Hue bridge.
2. Install *hue lights party* from the shelf, open Settings → Connections → `hue`.
3. **Address step.** Expect a box labelled *Bridge IP address*, the registration
   walkthrough, and a *find my bridge* button. Press it: good = one or more addresses
   offered as buttons; honest failure = "we didn't find a bridge from here" with manual
   entry still working (common — the broker only knows bridges that phoned home).
4. Type the bridge address (e.g. `192.168.1.50`) and press *use this address*. Good = the
   review screen appears listing that address, **with the private-network warning band
   naming it**. Bad = an error under the box (check the address shape: `192.168.x.x`,
   `10.x.x.x` or `172.16–31.x.x`, no port, no `https://`).
5. Press *approve this connection*. Good = the pairing screen, showing the link-button
   instruction. **Nothing has been sent to the bridge yet** — verify by not pressing the
   button and confirming no key exists.
6. **Press the round button on top of the bridge**, then within 30 seconds press
   *I pressed the button — connect*. Good = the done screen. Bad, and each is DISTINCT:
   *"press the round button on your bridge, then try again"* = the window closed (repeat
   this step); *"we couldn't reach the device at …"* = wrong address or a different
   network; *"we couldn't record this device's security certificate"* = pairing worked but
   the pin was not captured — **nothing was saved**, retry, and report if it repeats.
7. **The C1 check, worth doing once by hand:** the minted key must appear NOWHERE on
   screen at any point. It is not in the done screen, not in any error, and not in the
   app. If you ever see a long random-looking string in this flow, that is a defect —
   capture it and report it.
8. Open the app. The apply control stays greyed with copy about the address never
   reaching the app — **that is expected at this stage**, not a pairing failure (see the
   contradiction recorded above). The connection is real regardless: Settings shows it
   approved, and re-opening the wizard shows the done screen rather than the address step.
