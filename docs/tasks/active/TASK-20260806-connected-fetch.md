# TASK-20260806-connected-fetch: Dynamic Auth part 2 — the envelope net capability (umbrella child AL-03)

- **Status**: in-progress (plan APPROVED-WITH-CHANGES via fresh-context review; all amendments folded as binding — see v2 section)
- **Owner**: Jeetu (autonomous run; Claude implements)
- **Risk tier**: **high** (protocol + runner + auth + C1/C2)
- **Branch**: `feat/TASK-20260806-connected-fetch`
- **Packages touched**: `protocol` (High), `runner` (High), `auth` (High), `sdk` (Med), `apps/playground` (Med), docs
- **Spec impact**: internal draft (net frames out of SOURCES; prose staged by AL-12); spec-changelog entry
- **Related**: umbrella AL-03 · TASK-20260805-auth-core (merged PR #6, forward constraints: bug-3 always-strict is THIS child's named AC; punycode ceiling; status gating) · internal/03-audit-auth.md · roadmap A4


> v2: fresh-context plan review verdict **APPROVE-WITH-CHANGES** — all blockers (B1–B3), required changes (R1–R5), and advisories (A1–A3) folded as the BINDING amendments below; open questions closed. Implementation-ready. Where an amendment conflicts with older text above it, the amendment wins.

## v2 BINDING AMENDMENTS (fold-ins from the plan review — the amendment wins over any older text)

- **B1 (silent frame drop):** net frames get their OWN size class: `LIMITS.MAX_NET_FRAME_BYTES` (1 MiB + 64 KiB envelope margin) added to `frameWithinLimits`, mirroring the db-frame class. The executor enforces the 1 MiB response cap while reading and on overflow emits a SMALL terminal `NET_SIZE_EXCEEDED` net-response — an oversized net-response can never be silently dropped at the bridge. Boundary test: response at cap−1/cap/cap+1 → delivered / delivered / terminal error frame (never silence), matching the runner's existing oversized-app-response error contract.
- **B2 (redirect-follow in the sibling credential path):** AL-03 FIXES `oauth-service.postForm` to `redirect: 'manual'` (a 30x from a token/refresh/revoke endpoint returns a typed error, never followed) + regression test. The net path and the credential-POST path ship the same redirect posture in the same child.
- **B3 (punycode, concretely):** hostname normalization to punycode (IDNA toASCII via the `URL` trick) happens at CHECK TIME ON BOTH SIDES — every ceiling entry AND the request host are normalized before membership comparison (so pre-existing stored unicode entries still match), AND `deriveAuthAllowedHosts`/`normalizeAuthHost` are retrofitted to store punycode for all NEW approvals. IDN round-trip test with a real `xn--` host proving ceiling membership; a stored-unicode-entry test proving the check-time normalization closes the AL-02 asymmetry.
- **R1:** scrubber property tests cover injected values planted in WHITELISTED response headers (etag, cache-control, x-ratelimit-*), not just bodies.
- **R2 (closes open Q5):** schema strict-REJECTS `body` on GET/HEAD.
- **R3:** session-remember confirm grants are keyed (app, host, method), in-memory only, and INVALIDATED on any re-approval/host-set change for that app + test.
- **R4:** the runner value-blindness guard is an executable lint test (named file in packages/runner tests): runner source contains no fetch call/import of the executor — mutation-checked, not prose.
- **R5:** net-request frame schema carries NO appId field; the runner's net binding is HOST-ASSIGNED, mirroring the `dbNamespace` model ("never app-claimed"). Test: an extra app-supplied appId-like field is rejected by the strict schema, and the executor uses only the host binding.
- **A1 (closes open Q3):** the `http:` localhost exception is DEAD — scheme gate is https-only; the Playwright stub runs https with a self-signed cert (Playwright `ignoreHTTPSErrors` scoped to the stub fixture only).
- **A2:** explicit test that `set-cookie` on a RESPONSE never crosses the bridge (independent of request-side stripping).
- **A3:** the base64-of-secret scrubber boundary is a NAMED forward-constraint for AL-11's threat model (copied into that task file at creation), not just a code comment.
- **Open Q1 closed:** per-request confirm + session-remember with R3 invalidation.
- **Open Q2 closed:** whitelist adds `link` (pagination); `x-ratelimit-*` glob kept and scrub-covered per R1.
- **Open Q4 closed:** the D5 minimal Connections panel is the permanent settings seat; AL-04's wizard replaces its approval INNARDS, the panel itself survives — not throwaway.

> Original v1 text follows; read through the amendments above.

## Spec (what & why)

Give apps a governed way to reach the network they cannot touch themselves (C2: iframe has zero network): an envelope **net frame**. The app asks `{url, method, headers?, body?}` over the bridge; the HOST — the only fetch caller — validates against the app's approved frozen allowlist, injects credentials from `snug_secrets` via header templates, scrubs responses, blocks private ranges, caps sizes, and gates mutating calls behind user confirmation. OProject audit bug 3 dies by construction: **injection is always strict; no flag, no env var, no bypass parameter exists anywhere** (named AC). C1/C2 are preserved: credentials never enter the iframe or the LLM; the sandbox stays `allow-scripts` + `connect-src` blocked.

## Design decisions (pinned; reviewer: attack)

**D1 — Protocol surface.** New frames in `packages/protocol` (INTERNAL draft, out of `json-schemas.ts` SOURCES, same as AL-02's precedent; in-package snapshots): `net-request` (id, url, method, headers?, body?, appId implicit via bridge binding) and `net-response` (id, ok, status, headers-whitelisted, body, truncated?, error-code). Error codes as exported constants (`NET_NOT_APPROVED`, `NET_HOST_BLOCKED`, `NET_CONFIRM_DENIED`, `NET_SIZE_EXCEEDED`, `NET_SSRF_BLOCKED`, `NET_SCRUBBED_HEADER_STRIPPED`...). LIMITS: request body 256 KiB, response 1 MiB (OProject's cap), both exported constants. **Response headers are whitelist-only** (`content-type`, `content-length`, `cache-control`, `etag`, `last-modified`, `retry-after`, `x-ratelimit-*`); `set-cookie` and everything else never crosses the bridge. By construction the net-response can never echo injected request headers (they are not part of the response object we build).

**D2 — Executor seat: `packages/auth/src/connected-fetch.ts`** — port of OProject's auth-fetch resolver seam + response scrubber, DI-pure: `createConnectedFetch({ credentialStore, specReader, fetchImpl, confirmGate, clock })`. `packages/runner` gains a value-blind `NetHandler` seam on the bridge host (exactly like the transport/db-driver seams — the runner routes frames, never sees credential values; the playground wires the executor in). No strictness parameter exists in any signature (AC-linted like AL-02's AC5).

**D3 — Enforcement order (pinned, each gate tested at the executor altitude with a fake fetch):**
1. Frame shape validation (zod, strict).
2. Cross-app binding: the bridge stamps the appId; the frame carries none (theft guard by construction — an app cannot name another app's spec).
3. Spec lookup: must exist AND `status === 'approved'` — `imported_unapproved`/pending barred with a distinct error (AL-02's status contract, constants imported from protocol).
4. URL parse; scheme must be `https:` (or `http:` ONLY for literal localhost dev-stub hosts that are themselves in the frozen set); hostname **punycode-normalized on BOTH sides** before the ceiling check (AL-02 forward note): host ∈ `frozenAllowedHosts`.
5. SSRF guard, honest browser edition: reject literal private/loopback/link-local IPs (v4+v6), `localhost`, `.local`, `.internal` — documented plainly that a browser cannot pre-resolve DNS, so DNS-rebinding to private IPs is NOT claimed defended here (the frozen allowlist is the primary wall; the threat model doc (AL-11) states this boundary; desktop native fetch revisits it).
6. Method gate: non-GET/HEAD requires user confirmation via the injected `confirmGate` — v1 is per-request confirm with a per-(app, host, method) "remember for this session" checkbox (in-memory only, never persisted).
7. App-supplied credential-shaped headers ALWAYS stripped (Authorization, Cookie, Proxy-Authorization, X-Api-Key patterns — the C1 strip list from the envelope reused) — before injection, regardless of spec kind.
8. Injection: async template engine renders header templates with values read per-use from CredentialStore (no caching — AL-02 D4). For oauth2 kinds: get/refresh token via the AL-02 service (ceiling-checked internally already).
9. `fetchImpl(url, { redirect: 'manual', signal: timeout })`; a redirect response is returned as an error-code response (`NET_REDIRECT_BLOCKED`) — never followed (SSRF/exfil via redirect).
10. Response: size cap enforced while reading; **scrubber** (ported `scrubAuthValues`): every injected header VALUE occurrence redacted from body and from whitelisted response headers before the frame crosses the bridge; then whitelist headers; deliver.

**D4 — Scrubber** ported with OProject's tests + property tests (values embedded in JSON, base64 of exact value NOT claimed caught — documented boundary; multi-occurrence; value-in-header).

**D5 — Minimal approval surface (dev-grade, deliberately small).** AL-04's wizard is the real UX; AL-03 ships a plain "Connections" section in Settings: list per-app specs (kind, provider, FULL frozen host list, status), Approve / Re-approve / Revoke buttons wired to AL-02's accessor APIs, and the mutating-call confirm dialog. Purpose: makes the capability live-sweepable end-to-end and gives AL-04 the wiring points; visual polish explicitly out of scope. (Reviewer: is this the right scope line?)

**D6 — SDK: `useConnectedFetch`** hook (embedded + module forms, KB≡SDK byte-compare rule extended to it) — thin wrapper: returns `{ fetch(url, opts) → Promise<NetResponse> }` over postMessage; no retry logic v1. KB teaching is AL-05 — but the hook ships now so AL-05 documents a real API.

**D7 — Test plan (tests first).**
- Protocol: frame schema validation + strictness; error-code/LIMITS constants exported; snapshots; SOURCES-unchanged test extended.
- Executor unit (fake fetch): one test per gate in D3 order — approved-only, ceiling (incl. punycode + case + port tricks), SSRF literals, confirm gate (deny → no fetch call at all), header strip (app-supplied Authorization never reaches fetchImpl), injection correctness per kind, redirect blocked, size cap (streamed overflow → truncated error, no partial credential leak), scrubber application. Mutation-check each.
- C1 negatives: a net-response containing a planted credential value fails the scrub test; the net-request schema REJECTS a headers object carrying Authorization (belt and braces: stripped at executor even if schema bypassed).
- C2 negatives: existing iframe suite unchanged + a test that the runner's NetHandler seam passes frames only — no fetch occurs inside packages/runner (dependency lint: runner imports no fetch-calling module; the browser CSP suite still proves iframe cannot fetch directly).
- Playwright e2e with a local stub provider (fixture server requiring `X-Api-Key`): approve via the D5 panel → app fetches through the bridge → stub sees the injected key, response renders scrubbed; negatives: unapproved barred, off-ceiling host blocked, imported_unapproved barred after a doctored import, POST prompts confirmation (deny → no request), app-supplied Authorization absent at the stub.
- Live sweep: real byok build of a tiny app using useConnectedFetch against the stub; console/DOM/export secret probes.

## Files to touch (order)
1. `packages/protocol`: net frames + error codes + LIMITS (+ tests, SOURCES guard). Spec-changelog entry (internal draft; prose to AL-12).
2. `packages/auth`: connected-fetch executor + scrubber (+ tests).
3. `packages/runner`: NetHandler seam (+ value-blind tests).
4. `packages/sdk`: useConnectedFetch embedded+module + KB≡SDK sync test extension.
5. `apps/playground`: bridge wiring, Connections panel, confirm dialog (+ vitest, Playwright, stub fixture).
6. Docs: code-map, architecture, next-steps, journal; forward-constraints for AL-04/AL-05 copied into task file.

## Cross-package impact
protocol (High → full graph), runner (High), auth (High), sdk (Med), playground (Med). Root + Playwright green required.

## Out of scope
Inferrer/wizard/render directive (AL-04) · KB teaching (AL-05) · desktop native fetch · polling/background · any spec publication (AL-12 stages prose).

## Open questions for the reviewer
1. Confirm-gate granularity: per-request + session-remember — right v1 line, or should remember be per-app persistent (UX vs safety)?
2. Response-header whitelist: anything missing that real APIs need (pagination Link headers?) — and is `x-ratelimit-*` a safe glob?
3. The http-for-localhost-dev-stub exception in D3.4: right, or should the Playwright stub run https with a self-signed cert instead and the exception die?
4. D5 minimal panel: right scope, or does it create a second approval surface AL-04 then has to kill (throwaway vs seed)?
5. Should `net-request` allow a `body` for GET (some APIs abuse it) — or strict-reject?

## Forward constraints (copy into these children's task files at creation)

- **AL-04 (wizard) — the D5 Connections panel is the PERMANENT settings seat; replace its approval INNARDS, not the panel.** `ConnectionsCard` in `apps/playground/src/views/SettingsView.tsx` renders the per-app list (kind/provider/full frozen host list/status) and the Approve/Re-approve/Revoke actions wired to the AL-02 db accessors. AL-04's wizard becomes the approval flow those buttons open — the panel row + status pills survive. **Every approval transition MUST call `invalidateNetGrants(appId)`** (from `state/net.ts`) or a widened host set rides an old session grant (R3). The mutating-call confirm dialog (`run/NetConfirmDialog.tsx` + `netConfirmStore`) is the confirm surface — AL-04 may restyle it but keeps the per-(app,host,method) session-remember contract.
- **AL-05 (KB teaching) — teach `useConnectedFetch`, which SHIPS NOW as a real API.** Embedded + module forms are byte-locked to `20-html-template.md` section 5 by the KB≡SDK sync test; teaching copy goes in the KB prose layers, never by editing the copy-exactly hook block out of sync. The hook ALWAYS resolves (`{ok:true,status,headers,body}` or `{ok:false,error}`); teach that credentials are injected + scrubbed by the HOST and the app never sees a token; teach that mutating methods prompt the user; teach that only APPROVED hosts are reachable. Read the prompt-engineering reference (standing memory) before authoring.
- **AL-11 (threat model) — the base64-of-secret scrubber boundary is a NAMED constraint for the threat model.** `scrubAuthValues` (`packages/auth/src/scrub.ts`) matches EXACT substrings only; a provider that re-encodes an injected value (base64/hex/URL-escape) defeats it — the frozen host allowlist is the primary wall, the scrubber is defense-in-depth. `scrub.test.ts` pins this honestly (`A3 boundary … NOT caught`). Also for the model: the SSRF guard is the HONEST browser edition — literal private/loopback/link-local IPs + `localhost`/`.local`/`.internal` are rejected, but a browser cannot pre-resolve DNS, so DNS-rebinding to private IPs is NOT claimed defended (the frozen allowlist is the wall; desktop-native fetch revisits it with real DNS). Both are documented at the code sites; AL-11 must state them as explicit boundaries, not implied coverage.

## Decisions & surprises

- **`normalizeAuthHost` punycode retrofit is in `packages/protocol`, not `packages/auth` (B3).** The AL-02 asymmetry lived in the shared normalizer, so the fix belongs there — one function now does IDNA toASCII via the URL trick, and every consumer (deriveAuthAllowedHosts at store time, the auth ceiling predicates + hostSetEquals at check time, the db freeze union check) inherits it. A host string smuggling more than a hostname (path/port/creds/query) falls back to the fail-closed lowercase form. No auth-package change was needed for the check-time half — it already routes through `normalizeAuthHost`.
- **The net-request schema rejecting credential headers makes the C1 e2e a BRIDGE-level proof, not an executor-level one.** A forged `Authorization` on a net-request is answered `MALFORMED` by the runner before the executor ever runs — so the real-stub "Authorization absent" assertion is that the request never leaves the bridge. The executor's belt-and-braces strip (reachable only if the schema were bypassed) is proven at the fake fetch in `connected-fetch.test.ts`. Both layers tested; the e2e exercises the outer one.
- **The SSRF guard blocks the obvious e2e happy path.** A self-signed stub on `127.0.0.1` is a loopback literal the guard correctly refuses — so the net e2e addresses the stub by a public-looking hostname (`stub.snug.test`) that Chromium's `--host-resolver-rules` maps to 127.0.0.1, scoped to a dedicated `net` Playwright project (with `ignoreHTTPSErrors` + `--ignore-certificate-errors` also scoped there, per A1's fixture-only requirement). The stub sends CORS headers because the harness page and the stub are different origins.
- **`@snugprotocol/db` maps to the sql-free `auth-secrets` module in the net e2e import map.** The executor needs only the `auth:` key-shape constants from db, not sql.js — so the fixture serves `/pkg/db/userdb/auth-secrets.js` for the bare `@snugprotocol/db` specifier, keeping the net harness wasm-free.
- **OAuth 401-refresh-retry lives in the executor, not the OAuth service.** The service exposes `refresh`/`refreshClientCreds`; the executor does the one-shot retry (fetch → 401 → forceRefresh injection → refetch) so static kinds surface their 401 untouched and only OAuth kinds retry.
- **A `net` capability boolean was added to `host-ready.capabilities`** (optional, R2-safe) so an app can feature-detect. The runner sets it iff a NetHandler is configured; SnugAppFrame requires BOTH `net` and `netAppId` at the type level (mirrors the db pair).
- **Mutation-checking uncommitted work with `git checkout` wiped host.ts AND the sdk net files TWICE** (the exact M17 lesson from AL-02). Recovered both times by re-applying from context, then re-ran every affected mutation against COMMITTED code. Rule reinforced for the journal: commit the package, THEN mutate.

## Session journal (append-only, newest last)

### 2026-08-06 — Claude (Fable 5, orchestrator) — task instantiated
- Plan v2 instantiated post-review (APPROVE-WITH-CHANGES; B1–B3 + R1–R5 + A1–A3 folded binding). Named AC from the umbrella: audit bug 3 dies by construction — no strictness flag exists anywhere.
- Also carried: AL-13's task-file move rides this branch (uncommitted on main).
- Next step: implementation, tests first.

### 2026-08-06 — Claude (Fable 5, implementer) — implementation complete, all amendments met
- Implemented in the plan's files-to-touch order, TDD per unit (every module's tests shown failing before implementation; scrubber + SSRF tables adapted from the OProject source per D4/D3.5). Commits (task-id-prefixed): protocol net frames → auth executor/scrubber/guard/session-gate/postForm → runner NetHandler seam → sdk useConnectedFetch + KB → playground wiring/panel/dialog/e2e → docs (this commit).
- **Named AC met — audit bug 3 dead by construction:** no strictness flag/parameter/env read exists in the connected-fetch seat; `browser-safe.test.ts` walks `connected-fetch.ts`/`net-guards.ts`/`scrub.ts`/`session-confirm.ts` for the exact source-system anti-pattern (`STRICT_AUTH_HOST_INJECTION`, `off-list-injection`, injection-mode conditionals, `process.env`) and the factory arity (1 dep object; export surface `['execute']`). Mutation M-knob (plant `skipValidation`) covered by the AL-02 lint shape reused here.
- Every binding amendment landed with its test: B1 (own size class + boundary cap−1/cap/cap+1 at protocol AND runner) · B2 (`postForm redirect:'manual'` + regression, 3 sites pass `redirect_blocked` through untranslated) · B3 (punycode both sides + stored-unicode + IDN xn-- round-trip) · R1 (scrub whitelisted headers) · R2 (GET/HEAD body reject) · R3 (session-remember keyed (app,host,method) + re-approval invalidation) · R4 (runner value-blind executable lint) · R5 (no appId in schema; host-assigned binding) · A1 (https-only, http-localhost dead; self-signed https e2e stub) · A2 (set-cookie response-drop) · A3 (base64 scrubber boundary named for AL-11).
- **AC→test mapping:** protocol `net-frames.test.ts` (19) + `punycode-hosts.test.ts` (10); auth `connected-fetch.test.ts` (33, one per D3 gate) + `scrub` (8) + `net-guards` (5) + `session-confirm` (5) + `postform-redirect` (4) + `ceiling-punycode` (4) + `browser-safe` extension (AL-03 named AC ×2); runner `host-net.test.ts` (12) + `net-value-blind.test.ts` (5); sdk contract suite ×2 forms (useConnectedFetch ×3 each) + KB≡SDK byte-compare; playground `netState` (4) + `connectionsPanel` (5) + `confirmDialog` (5) + `e2e/net.spec.ts` (8 on production bytes, self-signed https stub).
- **29 guard mutations checked RED→restored** (table below; M26–M29 added at merge-review for the hand-written shape validator).
- **Surprise (process):** `git checkout` during mutation-checking wiped uncommitted host.ts and the sdk net files TWICE (the M17 trap from AL-02). Re-applied from context both times; re-ran every affected mutation against COMMITTED code. Committing each package BEFORE mutating is now non-negotiable for me.
- **High-tier self-sign-off (PROCESS):** C1 — no strictness knob in `packages/auth` (AC5 lint + AL-03 named-AC lint); the runner is value-blind (R4 executable lint, mutation-checked); credentials never enter the iframe (C1 e2e: forged Authorization rejected at the bridge; injected key present at the stub yet scrubbed from what the app renders). C2 — the iframe stays `allow-scripts` + `connect-src 'none'`; the ONLY fetch caller is the host-side executor. C3 — protocol changed → spec-changelog INTERNAL-DRAFT entry (net frames out of SOURCES). C5 — no secrets in code/config; no env reads in packages. NO push, NO PR per the run's rules — stopped after the final commit.

### 2026-08-06 — Claude (Fable 5, implementer) — adversarial merge review: BLOCK MERGE → fixed
- **Verdict: BLOCK MERGE, one blocker, fully diagnosed by the reviewer on a CLEAN checkout.** `connected-fetch.ts` imported `zod`, which `packages/auth` never declares (deps are only `@snugprotocol/{db,protocol}`, and the AC5 lint PINS that exact set). The import type-checked (workspace type-flattening) and every batch `pnpm test` I ran was green — but ONLY because a sibling suite importing protocol (which does declare zod) warmed Vite's resolver first. **In clean isolation the executor was UNLOADABLE:** `connected-fetch.test.ts` → "no tests", `browser-safe.test.ts` dynamic-import ACs fail, the three playground net suites fail to load. My runs lied; a scrolling batch log makes "no tests" read like a pass.
- **Why the obvious fix is wrong:** adding `zod` to auth's deps would VIOLATE the AC5 dep-set lint (`browser-safe.test.ts` pins `['@snugprotocol/db','@snugprotocol/protocol']`). Correct fix (reviewer's + mine): REMOVE the zod import and hand-write the shape/GET-HEAD-body/byte-cap checks — pure defense-in-depth, since the strict `netRequestSchema` at the protocol bridge already parsed and rejected malformed frames BEFORE the runner routes to the executor. Fix commit `e207744`.
- **Re-verified in clean isolation (cold `.vite` cache, single `--filter`, not batch):** auth 152/152 incl. `connected-fetch.test.ts` 33 + `browser-safe.test.ts` 7 (loads standalone, `test count > 0`); the 3 playground net suites 14/14 standalone. Mutation table re-established: M7–M14 + M23–M25 re-run RED in isolation; M26–M29 added for the new hand-written validator (GET/HEAD-body, unknown-field, byte-cap, method-set) — all RED alone.
- Lesson recorded (batch-run resolver warming masks a suite that cannot load; every runtime import needs a declared dep). NO push, NO PR.

### Mutation-check evidence (every guard: mutate → RED → restore → green)

| # | Mutation (reverted fix) | RED test(s) |
|---|---|---|
| M1 | drop the net size class from `frameWithinLimits` | protocol B1 boundary ×3 |
| M2 | add `net-request` to json-schemas SOURCES | protocol export-set-unchanged |
| M3 | remove GET/HEAD body reject | protocol R2 |
| M4 | remove credential-header refine | protocol C1 ×2 |
| M5 | loosen `netRequestSchema` (strict→object) | protocol R5 (extra-field reject) |
| M6 | drop punycode from `normalizeAuthHost` | protocol punycode ×3 + auth ceiling-punycode (via built dist) |
| M7 | disable scrubber (return body untouched) | auth scrub ×3 + connected-fetch scrub ×3 |
| M8 | SSRF guard always allows | auth net-guards + connected-fetch SSRF |
| M9 | header-strip disabled (keep app headers) | auth connected-fetch gate-7 |
| M10 | scheme gate allows http (A1) | auth connected-fetch A1 ×2 |
| M11 | redirect not blocked (followed) | auth connected-fetch redirect |
| M12 | response size cap disabled | auth connected-fetch B1 boundary |
| M13 | status gate ignores imported_unapproved | auth connected-fetch imported-barred |
| M14 | confirm gate bypassed | auth connected-fetch confirm-deny |
| M15 | session gate stops remembering | auth session-confirm remember ×3 |
| M16 | session invalidate no-op | auth session-confirm invalidate |
| M17 | postForm redirect not blocked (B2) | auth postform-redirect ×3 |
| M18b | net binding hardcoded to a wrong id | runner host-net host-assigned |
| M19 | oversized net-response silently dropped (net site) | runner host-net terminal NET_SIZE_EXCEEDED |
| M20 | plant a fetch call in host.ts | runner net-value-blind |
| M21 | edit embedded useConnectedFetch only | sdk KB≡SDK byte-compare |
| M22 | bridge net reads a wrong field | sdk contract net round-trip |
| M23 | approve without invalidateNetGrants | playground connectionsPanel R3 ×3 |
| M24 | confirm dialog ignores remember checkbox | playground confirmDialog remember |
| M25 | net state maps NetSpecRow with a fixed status | playground netState imported-barred |
| M26 | shape validator skips GET/HEAD body reject (R2) | auth connected-fetch R2 |
| M27 | shape validator accepts unknown fields (R5 belt) | auth connected-fetch R5 extra-field |
| M28 | request-body byte cap disabled | auth connected-fetch byte-cap |
| M29 | method-set check removed | auth connected-fetch unknown-method |

**Re-established after the merge-review BLOCKER fix (2026-08-06):** M7–M14 (all in
`connected-fetch.test.ts`) and M23–M25 (the three playground net suites) were RE-RUN in
CLEAN ISOLATION with a cold `.vite` cache — the suites now genuinely LOAD (33 tests +
14 tests, `test count > 0` confirmed, not "no tests"), and each mutation went RED alone.
M26–M29 are NEW guards on the hand-written shape validator that replaced the phantom-zod
`inputSchema`. The original batch-run claims for these were unverifiable (the suites
could not load standalone); they are now established, not asserted.