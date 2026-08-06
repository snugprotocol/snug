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

## Decisions & surprises

(running)

## Session journal (append-only, newest last)

### 2026-08-06 — Claude (Fable 5, orchestrator) — task instantiated
- Plan v2 instantiated post-review (APPROVE-WITH-CHANGES; B1–B3 + R1–R5 + A1–A3 folded binding). Named AC from the umbrella: audit bug 3 dies by construction — no strictness flag exists anywhere.
- Also carried: AL-13's task-file move rides this branch (uncommitted on main).
- Next step: implementation, tests first.
