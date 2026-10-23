# Threat-model delta — "Use my ChatGPT plan" (Sign in with ChatGPT on the desktop)

- **Task:** TASK-20261023-siwc-chatgpt-plan · **ADR:** 0078 · **Date:** 2026-10-23 (**draft** at Gate 2; finalised at Gate 6 with the ledger hash and the v3.14 note) · **Baseline:** `docs/threat-model.md` v3.13 (highest residual R-123)

C1 and C2 are unchanged in policy. This delta adds one credential family the system has not held before — a **rotating, per-host OAuth session** for the user's own ChatGPT plan — and one outbound route (`POST https://api.openai.com/v1/responses`) reached through the existing LLM choke point. It records where the credential rests, who may read it, how it moves, and what it can never touch.

## What changed

- A third `PlaygroundMode`, `chatgpt`, offered only where the platform carries the custody seat (the desktop). The hosted playground, the web kit and the local-host kit cannot construct it.
- A session file `~/Snug/chatgpt-plan.json` (`0700` dir, `0600` file, atomic writes) owned by the shell, read and written by three new Tauri commands and nothing else. The credential is **not** in `snug_secrets`.
- A DI-pure session module in `packages/auth` (PKCE S256, signed state, dynamic registration, ID-token validation against OpenAI's JWKS, single-flight rotation-safe refresh, revocation) and a Responses adapter in `packages/adapters` behind `runAgentTurn`.
- The loopback transport core gains a redirect **path** (`/auth/callback`) and delivers the callback's `client_id`; `/callback` callers are byte-identical.
- New named host-level error codes; a one-time notice; "Using ChatGPT plan" + Manage usage on the chip and in Settings.

## Assets

| Asset | Where it lives | Who may read it | Notes |
|---|---|---|---|
| Refresh token (30 d, rotates on every refresh) | the session file; webview memory only during a refresh | the shell's three commands; the auth session module | never in `snug_secrets`, exports, sync pushes, share bundles, URLs, logs, the inspector |
| Access token (1 h JWT, `aud=https://api.openai.com/v1`) | the session file; host-page memory per send | as above + the Responses adapter via `getBearer()` | the same altitude as a BYOK key today; never a `TurnAdapterConfig` field; scrubbed from error bodies |
| ID token + verified identity (`sub`, email, name) | the session file (claims subset) | Settings / chip (display) | display data; a returning account must match `sub` before tokens are replaced |
| Issued client id (`oaiapp_…`) + host id (`urn:uuid`) | the session file (survives sign-out) | the session module | the registration; a re-auth naming a different client is refused |
| Cached model list + levels | the session file (non-secret section) | Settings, selectors, chip | per machine; refreshed per sign-in; failing soft |
| The user's plan allowance (shared five-hour Plus limit; per-app limits) | OpenAI | — | spent by every think; the user's lever is ChatGPT → Settings → Usage |

## Principals

| Principal | Trust | What this delta lets it do |
|---|---|---|
| The user | owner | sign in / out, allow or decline plan usage, pick model and level, set per-app limits in ChatGPT |
| The host page (playground in the desktop webview) | trusted, as today (R-1) | run the protocol, hold a token in memory per send, call the API through the platform fetch |
| An app frame (`sandbox="allow-scripts"`) | untrusted (C2) | nothing new — no IPC, no header, no token; it sees a turn's text and a named, scrubbed error |
| The LLM (OpenAI, on the plan) | untrusted input source (R-8) | the same prompt and tool surface as the BYOK OpenAI brain; the same R-9 egress scrub |
| A scheduled step | the user's standing intent (ADR-0074) | spend the plan when signed in (owner default); refused by name when signed out or limited |
| OpenAI's auth server / API | the provider | issues, rotates and revokes; may echo submitted values in error bodies |
| A local process on the machine | out of the sandbox's reach | can hit the loopback listener (defeated by PKCE binding — ADR-0021 §2) and, with the user's privileges, read `0600` files (R-3 class) |

## Threats and controls

### Custody and movement

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P1 | The refresh token roams with the `.snug` file (Dropbox, `includeSecrets` export, a shared bundle) and a second machine's refresh logs this one out, or the copy leaks | It is never written to `snug_secrets` or any user-DB table — the session module's store seam is the shell's file, not the db (ADR-0078 §2) | a test signs in against fixtures, then asserts `exportUserDb({includeSecrets:true})`, a share bundle and the share scan contain no token; a source lint that `chatgpt-plan.ts` never imports the db |
| P2 | The session file is readable by other webview code paths or by a frame | Only `chatgpt_session_read/write/clear` touch the fixed path; they are main-window commands like every other; the in-shell gate asserts unreachability from a srcdoc frame | `cargo test` (fixed path, no other command reads it); gate rows `ipc-chatgpt-session-*` |
| P3 | A torn write loses the only valid refresh token (rotation + crash) | temp+rename+fsync writes; the rotated set is persisted **before** the new ID token is re-verified | `cargo test` atomicity; an auth test that fails verification after persist and asserts the new refresh token survived |
| P4 | Two concurrent thinks (or a think and a scheduled step) both refresh; the second rotation invalidates the first (`refresh_token_reused`) | one in-flight refresh per page realm; a forced refresh checks the failing token is still current; one shell per file (`single-instance`) | N concurrent `complete()`s → exactly one refresh POST |
| P5 | A token in a URL, a log or a support transcript | tokens are only ever POST-body or `Authorization` header material; no `console.*` on the auth/adapter paths; the authorize URL carries no token | source lint; request-shape tests |

### Sign-in

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P6 | Authorization-code injection on the loopback (a local process races the redirect with its own code under a valid state) | PKCE S256 with a per-attempt verifier that never leaves memory; signed single-use state with a 10-minute TTL; the listener's response page carries no token material (ADR-0021 §2) | existing transport tests + the new path/clientId tests |
| P7 | A re-auth callback names a **different** client id (account or workspace confusion) | refused; the stored registration is authoritative; a first callback with no client id is "registration incomplete" | auth tests |
| P8 | A forged or replayed ID token; an ID token for another audience; a different account replacing a signed-in one | RS256 signature against OpenAI's JWKS by `kid`, `iss`, `aud` contains the issued client, `exp`, `nonce`; a returning account's `sub` must match | one test per check, each able to fail alone |
| P9 | Plan usage without consent (`chatgpt.tokens.use.direct` not granted) | the scope is checked on the token response; thinks refuse with `CHATGPT_PLAN_NOT_GRANTED`; re-consent is a user act (`prompt=consent`) | auth + adapter tests |
| P10 | The webview navigates to the provider (embedded login) | the authorize URL opens in the system browser only (`openExternalUrl`, https-only) | existing opener tests + a welcome/settings test |

### Inference

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P11 | A provider error body echoes the bearer (measured: the 401 message repeats the submitted token) and the message reaches an app frame, the inspector or the builder chat | the adapter scrubs the bearer (and its percent-encoded form) from every error body before it becomes `message`; messages are capped | adapter tests with an echoing 401/400 fixture |
| P12 | An app envelope smuggles an `Authorization` header onto the plan route | the runner's C1 envelope strip and the adapter's fixed header set — the app never names headers | the existing C1 suite extended to the new adapter |
| P13 | The route's rejected parameters start being enforced (preview) and turns fail in the field | the adapter sends none of them by construction; the output cap is client-side | request-shape negatives |
| P14 | A limit, a revocation or an outage silently reroutes a turn to a key, a local model or the demo brain | named error results; `adapterKindFor({mode:'chatgpt'})` is `'chatgpt'` with or without a session; no other adapter is constructed | routing tests assert no other adapter is built; scheduled-step tests assert refusal by name |
| P15 | Prompt injection through the plan brain | unchanged: the same transport, system prompt, tool surface and R-9 egress scrub as the BYOK OpenAI brain; no new leaf producer | existing R-9 guards (the mode is a branch of the same `createDirectAppTransport`) |
| P16 | A pre-stream admission error (`{detail}`) or an unknown stream event breaks the parser | tolerant SSE; unknown events ignored; stream detection by status, not header; end-without-terminal is `STREAM_DROPPED` with partial text | fixtures incl. `response.metadata` and a header-less 200 |

### Sign-out and revocation

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P17 | Sign-out leaves a usable token on disk or in memory | `chatgpt_session_clear` + memory cleared; revocation attempted; an unconfirmed revocation is told | tests on file, memory and the told state |
| P18 | A disconnect made in ChatGPT settings is not announced; the app keeps a dead session | detected on the next failed request or refresh → `CHATGPT_SIGN_IN_NEEDED`; a transient network failure never erases tokens | tests for `invalid_grant`, `refresh_token_reused`, 401-after-retry vs `NETWORK_ERROR` |

## Accepted residuals

1. **R-124 — The session file is plaintext at rest**, `0600`, outside `.snug` passphrase encryption (ADR-0043) and outside any keychain. Same class as R-3. OpenAI's documented minimum is met; keychain custody is queued with its own ADR.
2. **R-125 — The access token is held in host-page memory per send.** Same class as R-1 (a compromised host page already holds every BYOK key); the webview has `csp: null` on the desktop (known, R-1).
3. **R-126 — The output ceiling is client-side.** The model keeps generating until the abort; usage is spent up to that point. Honest `max_tokens` + partial text to the bridge; no provider-side cap exists while `max_output_tokens` is rejected.
4. **R-127 — Plan usage is shared and attributed by OpenAI.** The Plus five-hour limit is shared across all the user's apps; Snug cannot know the remaining allowance and never guesses a reset time (the message links to Manage usage). Per-app limits are the user's lever.
5. **R-128 — The preview may change.** Measured behaviour (top-level function tools, accepted `max_output_tokens`/`system` items, `supported_reasoning_levels`) is used only where the docs are silent and never relied on where they forbid.
6. **R-129 — `packages/adapters` had no security lane before this task** (threat model §9). This task's security review covers the new adapter only; the Chat Completions and Anthropic adapters remain as they were.

## What this delta does NOT claim

- That tokens "never leave the device" — the access token travels to `api.openai.com` on every think, as a BYOK key does.
- That the host page is a trust boundary against itself (R-1).
- Anything about Windows, the hosted playground or the host kit — none of them can construct the mode.
- That the user's plan cannot be exhausted by their own apps; it can, and the message says where to look.
