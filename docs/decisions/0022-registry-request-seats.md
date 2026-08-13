# 0022 — Registry request seats, host-side signing functions, and auth-shaped failure surfacing

- **Status:** proposed (P0 draft of TASK-20260812-desktop-auth-awareness; finalize at P3)
- **Date:** 2026-08-12
- **Task:** TASK-20260812-desktop-auth-awareness

## Context

The registry (ADR-0020 world) pins a provider's identity, hosts, fields, endpoints and
registration walkthrough — but never **where a typed credential is sent** (request
templates) nor **how a connection is verified** (test request). Guard 2b deliberately
refuses authored credential-prompt seats (`fields`, `request`, `testRequest`) beside a
pinned brand (`requirement-admission.ts:217` — C1: an attacker-shaped requirement must
not redirect where secrets go), and the KB tells the authoring model to omit them for
pinned providers — promising pinned versions that, for `request`/`testRequest`, do not
exist. Consequences found 2026-08-12 (owner repro + recon):

- The Coinbase entry was **never connectable**: with no template seat, the executor falls
  to the `api_key` kind default (`X-Api-Key`) and the saved `api_secret` is read by no
  code path at all. Public endpoints ignore the bogus header (market data "works");
  private ones 401.
- The 401 is invisible: a static-kind 401 returns `ok:true` to the app
  (`connected-fetch.ts:804-816`), the host's `onNetError` never fires, the wizard probe
  is gated on `requirement.testRequest !== undefined` and so can never render for a
  pinned provider, and the done screen claims "connected" unverified.
- Query-string credential providers (OpenWeather `?appid=`, CoinGecko demo query form)
  are structurally unservable — no query placement mechanism exists anywhere, despite
  the registry's own comment promising one.
- Provider reality moved: retail Coinbase HMAC keys expired 2025-02-05; current CDP keys
  are a key name + EC private key signing a per-request ES256 JWT. A signing scheme is
  code, not a header string — the template grammar has one function today
  (`hmac_sha256_b64`) and needs a second.

## Decision

1. **`request` and `testRequest` become registry seats** on `WellKnownOauthProvider` and
   `WellKnownAuthOption` (option overrides entry, per ADR-0020's flow-seat rules). They
   are human-authored, dashboard/docs-cited, and substituted on the registry channel by
   the **same matched-option resolution that drives Guard 2b's refusal** — one resolution,
   both halves (lesson 2026-08-12). Borrowing channels are still refused when they author
   these seats; the registry now substitutes real values instead of nothing.
   **P0 amendments (binding):** (a) `occupiedPromptSeats` counts `request` when it
   carries `headerTemplate` OR `queryTemplate` (today a queryTemplate-only request is not
   counted at all — a hole this ADR would otherwise widen); (b) substituted
   request/testRequest values that byte-match the MATCHED option's pinned values are
   exempt from the occupied-seat refusal, derived from the SAME `matchAuthOption` handle
   as the fields exemption — admission runs twice on the production path and the
   substituted shape must survive the second pass (probe-verified P5-blocker shape);
   (c) per-seat idempotence tests assert on the PERSISTED shape through double admission
   and `stagePendingRequirement` on non-registry-provenance rows.
2. **Template grammar gains `{{cdp_jwt(api_key, private_key)}}`** — a host-side signing
   function, provider-scheme-named like `hmac_sha256_b64`, minting a fresh CDP JWT per
   request from live request context: claims `iss:'cdp'`, `sub:<api_key>`,
   `uri:'<METHOD> <host><path>'`, `nbf:now`, `exp:now+120s`; header `kid:<api_key>`,
   random `nonce`. **ES256 only at v1** (WebCrypto P-256; CDP EC keys are the universally
   safe type). An Ed25519 key yields an honest wizard/probe error naming the fix
   ("generate an EC (ES256) key in the CDP portal"), never a silent failure.
   **P0 amendments (binding):** CDP keys download as SEC1 `BEGIN EC PRIVATE KEY` PEM and
   WebCrypto imports pkcs8 only — the helper DER-wraps SEC1 → PKCS#8 (id-ecPublicKey +
   prime256v1), accepts both PEM headers, and errors honestly on undecodable PEM. The
   helper requires NATIVE WebCrypto ECDSA (the desktop subtle-fallback implements HMAC
   only) — absence is an honest error. The template engine is async-first end-to-end
   (`renderAuthHeaderTemplate` awaited at `connected-fetch.ts:563`), so the awaiting
   signer needs no seam change. WebCrypto's raw `r||s` ECDSA output is exactly JWS ES256
   format — no DER conversion.
3. **`connectionRequestSchema` gains `queryTemplate`** (same lint family as
   `headerTemplate`; template tokens must resolve against declared field keys, and both
   lints derive from ONE resolution). Query credentials are rendered into the URL **after**
   ceiling checks and are scrubbed from every host-visible echo: error strings, logs, the
   LLM inspector, and the net-result URL returned to the app (the app sees only the URL it
   asked for).
4. **Auth-shaped failure observer**: when the executor injected credentials and the
   response is 401/403, the app-visible result is unchanged (`ok:true`, status as-is) and
   a host-only callback (`onAuthShapedFailure(appId, slot, status)`) fires; RunView renders
   the repair banner with a "check this connection" CTA into the wizard. No credentials or
   response bodies ride the callback. **P0 amendments (binding):** the observer fires only
   on the FINAL delivered result of `execute()` — a 401 cured by the OAuth refresh retry
   fires nothing (negative-tested) — and `executeConnectionTestRequest` suppresses it
   (probe outcomes render in the wizard only).
5. **Coinbase entry rewritten to CDP**: fields `['api_key' (key name), 'private_key'
   (EC PEM, secret)]`; pinned request template using `cdp_jwt`; pinned
   `testRequest: GET https://api.coinbase.com/api/v3/brokerage/accounts`; OAuth option
   untouched. The institutional Exchange surface (HMAC + passphrase,
   `api.exchange.coinbase.com`) is **dropped, not carried** — out of product scope.

## Alternatives considered

- **Teach the model to author templates for pinned brands.** Rejected: reopens exactly the
  C1 channel Guard 2b closed — a prompt-injected requirement could redirect where secrets
  are sent. Reviewed registry data is the only trustworthy source for credential routing.
- **Remap credentialed 401/403 to `ok:false`.** Rejected: breaks the app contract — apps
  legitimately read 401 bodies and render their own states; the founding KB pattern
  teaches exactly that. Additive host-side observation gets visibility without breakage.
- **A bridge connection-status frame to the app.** Deferred: a protocol contract change
  with its own design surface; queued, not needed to kill the silence.
- **Per-provider defaults hardcoded in the executor.** Rejected: a hidden registry outside
  review; the visible registry is the authority (TASK-20260812-registry-authoritative-auth).

## Consequences

- The registry becomes the single reviewed authority for where credentials go, closing the
  "pinned provider can never be signed" hole class; the parity/structural test set grows
  and must move with every data edit (by design).
- Existing Coinbase rows carry the old field set; the wizard gains a field-set-drift
  re-credential path (owner re-enters the CDP key once). **P0 amendment (binding):**
  rows are admitted once and never re-read the registry, so the wizard-open path also
  detects **registry-seat drift** — a row whose provider now pins request/testRequest
  seats absent from the persisted spec is re-run through registry substitution and
  re-persisted WITHOUT re-crediting when the field set is unchanged (stored secrets stay
  valid). Without this, existing weather-planner/crypto-portfolio installs would stay
  broken forever (P0 BLOCKER seat-migration-gap).
- The staged v0.3 spec draft gains `request.queryTemplate` and the signing-function
  grammar (SPEC_SYNC; internal only, AL-12 held).
- Query-string credentials are a C1-sensitive surface with an enumerated scrub list;
  every new host-visible echo of a request URL must join the negative-test set.
