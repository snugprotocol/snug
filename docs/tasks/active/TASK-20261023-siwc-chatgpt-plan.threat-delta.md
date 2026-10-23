# Threat-model delta — "Use my ChatGPT plan" (Sign in with ChatGPT on the desktop)

- **Task:** TASK-20261023-siwc-chatgpt-plan · **ADR:** 0078 · **Date:** 2026-10-23 (**draft** at Gate 2; finalised at Gate 6 with the ledger hash and the v3.14 note) · **Baseline:** `docs/threat-model.md` v3.13 (highest residual R-123)

C1 and C2 are unchanged in policy. This delta adds one credential family the system has not held before — a **rotating, per-host OAuth session** for the user's own ChatGPT plan — and one outbound route (`POST https://api.openai.com/v1/responses`) reached through the existing LLM choke point. It records where the credential rests, who may read it, how it moves, and what it can never touch.

## What changed

- A third `PlaygroundMode`, `chatgpt`, offered only where the platform carries the custody seat (the desktop). The hosted playground, the web kit and the local-host kit cannot construct it.
- A session file `~/Snug/.chatgpt-plan/session.json` — a dot-prefixed `0700` subdirectory, a `0600` file written `create_new` + rename + fsync, opaque bytes with a size cap — owned by the shell, read and written by three new Tauri commands and by nothing else: `userfile.rs`'s `valid_name` refuses a leading `.` and any separator, so the existing `read_user_file` / `write_user_file` cannot reach it (pinned by `cargo test`). The credential is **not** in `snug_secrets`. The commands' wall is the invoke key (capabilities do not scope custom commands) — the same wall as `read_user_file`'s.
- A DI-pure session module in `packages/auth` (PKCE S256, signed state, dynamic registration, ID-token validation against OpenAI's JWKS, a **serial mutation queue with a session epoch**, single-flight rotation-safe refresh, revocation) and a Responses adapter in `packages/adapters` behind `runAgentTurn`. The module holds no token in memory between uses: each use reads the file inside the queue.
- The sign-in gets **its own loopback transport instance** (reserved appId; a port-filtered listener, since both listeners share the plugin's one `oauth://url` event). The transport core gains a redirect **path** (`/auth/callback`), delivers the callback's `client_id`, and — opt-in, this instance only — delivers `?error=` callbacks; `/callback` callers and the wizard's dropped-error behaviour are byte-identical.
- New named host-level error codes; a one-time notice; "Using ChatGPT plan" + Manage usage on the chip and in Settings.

## Assets

| Asset | Where it lives | Who may read it | Notes |
|---|---|---|---|
| Refresh token (30 d, rotates on every refresh) | the session file; host-page memory **per use** — `chatgpt_session_read` returns the whole file to the keeper inside its serial queue, for the duration of one send or one refresh, never cached | the shell's three commands; the auth session module | never in `snug_secrets`, exports, sync pushes, share bundles, URLs, logs, the inspector |
| Access token (1 h JWT, `aud=https://api.openai.com/v1`) | the session file; host-page memory per send | as above + the Responses adapter via `BearerSource.get()` | the same altitude as a BYOK key today; never a `TurnAdapterConfig` field; never in a 401/403 message (fixed sentences); redacted-then-capped elsewhere |
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
| P2 | The session file is readable by other webview code paths or by a frame | The dot-dir path is refused by `userfile.rs`'s `valid_name` (leading `.`, separators), so only `chatgpt_session_read/write/clear` reach it; their wall is the invoke key, which the in-shell gate proves unreachable from a srcdoc frame | `cargo test` (fixed path; `read_user_file_impl`/`write_user_file_impl` refuse the name); gate rows `ipc-chatgpt-session-*` — refused ×3 from the frame, effect-sensor dispatchables in the gate's throwaway HOME that never record a body |
| P3 | A torn write loses the only valid refresh token (rotation + crash); a `0644` temp file holds tokens if the process dies before rename | `create_new` temp with `mode(0o600)` → rename → fsync; the rotated set is persisted **before** the new ID token is re-verified; the shell's close-requested flush awaits an in-flight persist | `cargo test` atomicity + a `before_rename` hook asserting the temp's mode; an auth test that fails verification after persist and asserts the new refresh token survived; a close-flush test |
| P4 | Two concurrent thinks (or a think and a scheduled step) both refresh; the second rotation invalidates the first (`refresh_token_reused`) | one in-flight refresh per page realm inside the serial queue; a forced refresh checks the failing token is still current; one shell per `~/Snug` (`single-instance`) | N concurrent `complete()`s + a scheduled run → exactly one refresh POST |
| P4b | A sign-out races an in-flight refresh and the refresh's late write puts tokens back on disk; a model-cache read-modify-write spanning a refresh writes the stale refresh token back | every mutation passes through the queue; sign-out bumps the session epoch, so the refresh's result is discarded AND its returned refresh token revoked; the model-cache update re-reads inside the queue | deferred refresh fetch → `signOut()` → resolve: no token on disk or in memory; interleaved cache write → the rotated refresh token survives |
| P5 | A token in a URL, a log or a support transcript | tokens are only ever POST-body or `Authorization` header material; no `console.*` on the auth/adapter paths; the authorize URL carries no token | source lint; request-shape tests |

### Sign-in

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P6 | Authorization-code injection on the loopback (a local process races the redirect with its own code under a valid state) | PKCE S256 with a per-attempt verifier that never leaves memory; signed single-use state with a 10-minute TTL; the listener's response page carries no token material (ADR-0021 §2) | existing transport tests + the new path/clientId tests |
| P7 | A re-auth callback names a **different** client id (account or workspace confusion); a local process delivers a forged `client_id` | refused; the stored registration is authoritative; a first callback with no client id is "registration incomplete"; the issued id is persisted only after the exchange succeeds AND the ID token's `aud` contains it | auth tests incl. a forged id whose exchange/`aud` fails and persists nothing |
| P7b | A ChatGPT sign-in and a connection-wizard flow consume or cancel each other's callbacks (one `oauth://url` event, one cancel-old transport) | the sign-in has its own transport instance; each listener filters the event by its own bound port | two concurrent flows → each gets only its own callback; the wizard's transport still drops `?error=` callbacks |
| P7c | A declined consent (`?error=access_denied`) leaves the sign-in waiting out the 10-minute TTL with the listener bound | opt-in error delivery ends the flow by name; the UI's cancel tears the listener down | transport + UI tests |
| P8 | A forged or replayed ID token; an ID token for another audience; algorithm confusion; a different account replacing a signed-in one | `alg` must be RS256 (`none`/HS256 refused) and the key is imported as RSASSA-PKCS1-v1_5/SHA-256 regardless of the header; JWKs filtered `kty:RSA`/`use:sig`; `kid` miss → one rate-limited refetch; `iss`; `aud` contains the issued client (`azp` when `aud` has several); `exp` with bounded skew; `nonce`; a returning account's `sub` must match; a refresh's ID token must equal the stored `iss`/`sub`/`aud` | one test per check, each able to fail alone, incl. `alg:none`, HS256, a `kid` rotation and a refresh `sub` change |
| P9 | Plan usage without consent (`chatgpt.tokens.use.direct` not granted) | the scope is checked on the token response; thinks refuse with `CHATGPT_PLAN_NOT_GRANTED`; re-consent is a user act (`prompt=consent`) | auth + adapter tests |
| P10 | The webview navigates to the provider (embedded login) | the authorize URL opens in the system browser only (`openExternalUrl`, https-only) | existing opener tests + a welcome/settings test |

### Inference

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P11 | A provider error body echoes the bearer (measured: the 401 message repeats the submitted token) and the message reaches an app frame, the inspector or the builder chat | 401 and 403 forward **no provider prose** — fixed sentences per named code; every other detail is redacted (`scrubAuthValues` over the bearer of the attempt that failed, after JSON extraction) **then** capped, plus a JWT-shape backstop single-homed in `packages/protocol`; the app frame is the C1-critical sink | the echoing 401 driven through `createDirectAppTransport` and `executeAppThink`, then the app-frame reply, the stored run row and `exportUserDb({includeSecrets:true})` bytes scanned; straddling and `\u`-escaped echoes; the echo on the post-refresh retry |
| P11b | A bare access-token JWT appears in the inspector's display unmasked | `credentialShapes` display mode gains the protocol's `JWT_SHAPE` (share-scan and prose modes unchanged) | masking on the inspector fixtures stays linear; starters' share scan still clean |
| P11c | A BYOK OpenAI key in the file is used while the mode is `chatgpt` (the inference ladder's `decideWire`) | every derivation seat — `adapterKindFor`, `resolveActiveBrainFrom`, `appBrainKind`, `readerBrainRoute`/`chatDoorOpen`, `decideWire`, `keylessBrainGate`, `configFrom` — answers `chatgpt` and reads no key | the behavioural matrix: mode `chatgpt` × {ready, signed out, not granted, limited} × {key present, absent}; a `getByokKey` spy never called |
| P12 | An app envelope smuggles an `Authorization` header onto the plan route | the runner's C1 envelope strip and the adapter's fixed header set — the app never names headers | the existing C1 suite extended to the new adapter |
| P13 | The route's rejected parameters start being enforced (preview) and turns fail in the field | the adapter sends none of them by construction; the output cap is client-side | request-shape negatives |
| P14 | A limit, a revocation or an outage silently reroutes a turn to a key, a local model or the demo brain | named error results; `adapterKindFor({mode:'chatgpt'})` is `'chatgpt'` with or without a session; no other adapter is constructed | routing tests assert no other adapter is built; scheduled-step tests assert refusal by name |
| P15 | Prompt injection through the plan brain | unchanged: the same transport, system prompt, tool surface and R-9 egress scrub as the BYOK OpenAI brain; no new leaf producer | existing R-9 guards (the mode is a branch of the same `createDirectAppTransport`) |
| P16 | A pre-stream admission error (`{detail}`) or an unknown stream event breaks the parser | tolerant SSE; unknown events ignored; stream detection by status, not header; end-without-terminal is `STREAM_DROPPED` with partial text | fixtures incl. `response.metadata` and a header-less 200 |

### Sign-out and revocation

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P17 | Sign-out leaves a usable token on disk or in memory | `chatgpt_session_clear` + memory cleared; revocation attempted; an unconfirmed revocation is told | tests on file, memory and the told state |
| P18 | A disconnect made in ChatGPT settings is not announced; the app keeps a dead session — or a deleted client leaves a kept registration that locks the user out | detected on the next failed request or refresh → `CHATGPT_SIGN_IN_NEEDED`; a transient network failure never erases tokens; a user-initiated "forget this registration" drops the client id and host id | tests for `invalid_grant`, `refresh_token_reused`, 401-after-retry vs `NETWORK_ERROR`; the forget path |

### Unattended steps and foreign files

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P19 | A runaway schedule exhausts the user's shared five-hour allowance overnight, on the top thinking level | `gatedAdapter`'s daily AI ceiling counts each `complete()` (a refresh-and-retry is one call); unattended steps run on the model's **default** level under the output ceiling; `CHATGPT_USAGE_LIMIT` is refused by name and **not retried** by the queue; `USAGE_UNAVAILABLE` backs off with a bound; the editor's honesty line says the schedule spends the plan | scheduled-step tests; the honesty-line copy pin |
| P20 | A scheduled catch-up at launch runs before the session is read and is refused as signed out — or worse, treated as a reroute | `'unknown'` means WAIT: the keeper's first read completes before `initScheduler()`, and `getAccessToken` awaits it | a boot-order test |
| P21 | Someone else's `.snug` carrying `mode:'chatgpt'` and schedules is opened and confirmed; its schedules run on this machine's plan | unchanged: an imported file arms the F15 endpoint-confirm gate, which refuses every direct turn — scheduled steps included — until the user confirms the settings as theirs | an import test with `mode:'chatgpt'` |

## Accepted residuals

1. **R-124 — The session file is plaintext at rest**, `0600`, outside `.snug` passphrase encryption (ADR-0043) and outside any keychain. Same class as R-3. OpenAI's documented minimum is met; keychain custody is queued with its own ADR.
2. **R-125 — The access token is held in host-page memory per send.** Same class as R-1 (a compromised host page already holds every BYOK key); the webview has `csp: null` on the desktop (known, R-1).
3. **R-126 — The output ceiling is client-side.** The model keeps generating until the abort; usage is spent up to that point. Honest `max_tokens` + partial text to the bridge; no provider-side cap exists while `max_output_tokens` is rejected.
4. **R-127 — Plan usage is shared and attributed by OpenAI.** The Plus five-hour limit is shared across all the user's apps; Snug cannot know the remaining allowance and never guesses a reset time (the message links to Manage usage). Per-app limits are the user's lever.
5. **R-128 — The preview may change.** Measured behaviour (top-level function tools, accepted `max_output_tokens`/`system` items, `supported_reasoning_levels`) is used only where the docs are silent and never relied on where they forbid.
6. **R-129 — `packages/adapters` had no security lane before this task** (threat model §9). This task's security review covers the new adapter only; the Chat Completions and Anthropic adapters remain as they were.
7. **R-130 — A rotation-loss window.** If the refresh's 15 s timeout fires after the server has already rotated, or the app dies between the token response and the shell's write, the old refresh token is dead and the next attempt answers `refresh_token_reused`. Not a leak: it costs a re-sign-in. Narrowed by persist-before-verify, the close-flush await and the one-retry rule; two shells sharing one `~/Snug` (a dev build beside the installed app) are not coordinated across processes — an advisory `flock` around refresh is queued.
8. **R-131 — First-sign-in account substitution.** Anyone who can read the authorize URL (state, challenge and nonce travel in it) can authorize *their* account against our challenge and deliver that code; on a first sign-in there is no stored `sub` to compare. This needs a same-user process or a browser extension (R-3's class). Mitigation: the chip and Settings always show the signed-in email; a returning sign-in checks `sub`.
9. **R-132 — Data-use attribution is UNSTATED by OpenAI.** Plan traffic carries the same context the BYOK OpenAI brain carries, including rows other apps share with the thinking app, under the user's consumer ChatGPT account. OpenAI's documents (checked 2026-10-23: the SIWC docs, the SIWC Terms of 2026-09-29, the help articles, the API data guide, the consumer privacy policy) never say which training or retention policy governs this route — the signals point at the consumer rules (the Terms incorporate the consumer Terms of Use; the usage is billed as ChatGPT usage; Codex on a personal plan follows the "Improve the model" toggle), while the API's no-training default speaks of API customers, which plan users are not; what is documented is only that the app cannot see the user's conversations or memories and that `store:false` is mandatory. *Bounded by:* the consent band, the privacy rows and the egress line say exactly this and tell the user to assume their ChatGPT data controls apply; the copy never claims "not used for training" or "zero retention" (negative copy pin); the user's lever is ChatGPT → Settings → Data controls. Re-check the docs at each desktop release that ships the mode.

## What this delta does NOT claim

- That tokens "never leave the device" — the access token travels to `api.openai.com` on every think, as a BYOK key does.
- That the host page is a trust boundary against itself (R-1).
- Anything about Windows, the hosted playground or the host kit — none of them can construct the mode.
- That the user's plan cannot be exhausted by their own apps; it can, and the message says where to look.
- That passphrase protection (ADR-0043) covers this credential — it does not, and the Protection card says so.
- That the baseline's §2 Assets line ("credentials live in `snug_secrets`") still holds without qualification; Gate 6 amends it.
