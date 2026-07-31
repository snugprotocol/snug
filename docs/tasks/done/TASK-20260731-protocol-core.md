# TASK-20260731-protocol-core: `packages/protocol` — envelope schemas, constants, JSON Schema export (child 1 of build-hub)

- **Status**: in-review
- **Owner**: Jeetu (delegated session)
- **Risk tier**: **high** (protocol schemas = the public spec)
- **Branch**: `feat/TASK-20260731-protocol-core`
- **Packages touched**: `packages/protocol` (leaf — everything else will depend on it)
- **Spec impact**: spec v0.1 draft (staged here; push needs explicit ask)
- **Related**: umbrella TASK-20260731-build-hub (P0/P2), ADR-0003; wire-spec extraction + fresh-context plan review (13 findings) in journal

## Spec (what & why)

Define the Snug envelope protocol as zod schemas + typed helpers, unifying the two ancestor protocols and fixing their audited defects (no versioning, no correlation, single-slot clobbering, host/KB response-shape disagreement, never-fired ready signal, 4-way duplicated tag literal). Revised per the 2026-07-31 fresh-context review — the frame set is **open where the demo flow and v1.x need it open**.

**Wire design (Snug v0.1) — normative rules first:**
- **R1 (versioning):** every frame carries `v: 1`. Frames with missing/unsupported `v` → typed `UNSUPPORTED_VERSION` from parsers. `snug:host-ready` advertises `protocolVersions: number[]`.
- **R2 (unknown-type rule):** a frame with valid `v` but unrecognized `type` MUST be silently ignored — v1.x adds frames additively. The `snug:` type-prefix namespace is reserved. Unknown *fields* on known frames are ignored (forward-compat).
- **R3 (terminal-frame guarantee):** every accepted `requestId` receives exactly one terminal frame (`ok:true, streaming:false` or `ok:false`). Streaming frames are display-provisional; the terminal frame is authoritative.
- **R4 (identity):** hosts route by `event.source` (null-origin iframes). Host mints `instanceId` (in `snug:host-ready`); apps echo it in every request; a new announce from the same iframe invalidates in-flight work. `appId` is display/routing metadata, NOT a security principal.
- **R5 (open error codes):** wire `code` is a string; known codes are exported constants: `PARSE_FAILED`, `THREAD_CONFLICT`, `NETWORK_ERROR`, `RESET_FAILED`, `CANCELLED`, `SUPERSEDED`, `UNSUPPORTED_VERSION`, `CONSENT_REQUIRED` (reserved), `AUTH_REQUIRED` (reserved v1.1), `HOST_ERROR`. Unknown code ⇒ handle per `retryable` flag, render as `HOST_ERROR`. Codes SCREAMING_SNAKE, fields camelCase.
- **R6 (size caps):** `MAX_FRAME_BYTES` (256 KiB) on any frame; announce strings length-capped (displayName 80, description 400, iconEmoji 8, iconColor 32); `RAW_EXCERPT_CHARS` 200; `MAX_ARTIFACT_BYTES` 5 MiB.

**Frames** (postMessage, iframe ↔ host):
- `snug:app-announce` (app→host, on mount): `{appId, displayName, description?, iconEmoji?, iconColor?}` (capped).
- `snug:host-ready` (host→app, on load AND as announce-ack, idempotent): `{instanceId, protocolVersions, capabilities: {streaming, db, auth}, theme: 'light'|'dark', locale?}`.
- `snug:app-message` (app→host): `{requestId, instanceId, appId, action, payload?, state?, responseSchema?}` — requestId unique per instance (SDK uses UUID); duplicate concurrent id → typed reject.
- `snug:app-cancel` (app→host): `{requestId, instanceId}`.
- `snug:app-response` (host→app), discriminated on `ok`/`streaming`: `{requestId, ok:true, streaming:true, text, seq?}` (cumulative prose only — hosts MAY suppress for schema-constrained requests; `mode:'delta'` reserved) | `{requestId, ok:true, streaming:false, data}` | `{requestId, ok:false, error:{code, message, rawExcerpt?, attemptsRemaining?, retryable}}`. Unparseable inbound frame with unrecoverable requestId ⇒ host drops silently (never invents ids).
- `snug:db-request` (app→host) / `snug:db-response` (host→app): `{requestId, instanceId, op: 'exec'|'export'|'import'|'kvGet'|'kvSet', sql?, params?, key?, value?}` → `{requestId, ok, rows?|value?|bytesBase64?, error?}`. Storage is **host-brokered** (C2: null-origin iframes have no storage); `usePersistedState` rides the kv ops.
- `snug:host-event` (host→app) / `snug:app-event` (app→host): `{event, data?}` — generic additive channel (theme-change, visibility, resize request `{height}`); consumers ignore unknown `event` values.

**Chat envelope** (host→agent endpoint): `` `${SNUG_APP_REQUEST_TAG}\n${JSON.stringify(env)}` `` where `env = {snug: 1, appId, instanceId, requestId, action, payload?, state?, responseSchema?}`; `SNUG_APP_REQUEST_TAG = '[SNUG_APP_REQUEST]'` exported once; `isAppRequest` detects tag+marker.

**Reply parsing:** `parseAgentReply(text)` — total, never throws. Precedence: (1) `JSON.parse(text.trim())`; (2) on failure, extract first fenced block or first balanced `{…}`; never strip backticks from inside valid JSON. Rejects null/array/scalar. Returns `{ok:true, data} | {ok:false, error}` with `rawExcerpt` capped.

**Security helpers (C1):** `STRIP_HEADERS` constant (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`) + `stripCredentialHeaders(headers)` (deterministic MUST, used at server/adapter boundary); `scanForCredentialValues(obj)` — value-shape detection (JWT regex, `Bearer ` prefix, high-entropy strings) returns high-confidence findings to reject + key-name-only hits as warnings (a chess `{token:'rook'}` must NOT reject).

**JSON Schema export:** zod **v4 native `z.toJSONSchema()`** (no extra dep), piped through a normalizer (recursive key sort, 2-space stringify, trailing newline) into `packages/protocol/schemas/*.json`, committed; CI = regenerate + `git diff --exit-code`.

**Acceptance criteria** (each ≥1 test):
1. Round-trip + malformed-input matrix for every frame/envelope; public parsers return typed results, never throw (fuzz: null/array/scalar/truncated/fenced/oversized).
2. Unknown fields ignored on every schema; unknown frame `type` with valid `v` → `{ignored: true}` result (R2).
3. `parseAgentReply` matrix: plain, ```json-fenced, ```-fenced, prose-wrapped, backticks-inside-JSON-strings (must survive), → typed `PARSE_FAILED` + capped `rawExcerpt` on failure.
4. `v` missing / `v: 2` → `UNSUPPORTED_VERSION` via parse result (host never invents a wire reply); `isAppRequest` rejects non-`snug: 1` bodies.
5. `AUTH_REQUIRED`/`CONSENT_REQUIRED` exist as reserved known codes; unknown string code parses fine and maps to `HOST_ERROR` handling class (R5).
6. C1: `stripCredentialHeaders` strips the full header list case-insensitively; `scanForCredentialValues` rejects planted `Bearer …`/JWT/high-entropy values nested deep, warns-only on `{token: 'rook'}`.
7. Schema export deterministic: double-generation byte-identical; committed files match (`pnpm gen:schemas && git diff --exit-code -- schemas`).
8. Zero runtime deps besides zod; `src/` free of `node:*` imports (test-enforced walk + jsdom import smoke test — eslint rule deferred until linting lands); size caps enforced by schemas (oversized announce strings rejected).
9. R3 helpers: response-builder utilities make it impossible to construct a streaming-only sequence without a terminal frame in the runner's state machine (typed builder API asserted).

**Out of scope**: runner/SDK implementations (children 3–4); spec repo push; auth flows; delta streaming (`mode` reserved only).

## Plan

Files (tests FIRST, suite starts red): `src/constants.ts` → `src/frames.ts` (discriminated unions incl. db + event frames) → `src/envelope.ts` → `src/reply.ts` → `src/security.ts` → `src/index.ts` → `scripts/export-schemas.ts` + `schemas/` → `SPEC-DRAFT.md`. Tests: `src/__tests__/{frames,envelope,reply,security,schemas-stable}.test.ts`. Deps: `zod@^4` (runtime), recorded here. Leaf package; spec-sync staged at Gate 6.

## Decisions & surprises

- Host-parses + structured frames resolves the ancestor KB/host mismatch by construction (single package feeds both sides).
- Storage is host-brokered over db frames — forced by C2 (null-origin iframe has no localStorage/OPFS); ancestor KB's localStorage teaching was only viable via `allow-same-origin`, which C2 forbids.
- zod v4 native JSON Schema export chosen over `zod-to-json-schema` (maintenance mode) — one fewer dep, deterministic with our normalizer.
- Fresh-context review (13 findings: 3 blockers, 6 majors) fully incorporated; reviewer agent a406c8431cbf58c9c.

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: spec + plan; fresh-context AI plan review completed and incorporated (open frame set, R1–R6 rules, db/event frames, open code set, instanceId, security-helper split, zod v4).
- State: plan finalized under umbrella approval; **High-tier pre-implementation review satisfied**. Implementation starting: tests first.
- Next step: branch, red tests, implement, gen schemas, green, AI code review, merge.

### 2026-07-31 — Claude (Fable 5) — review+fixes
- Done: implemented (tests-first, suite was red at 48). Gate-5 adversarial review (agent ad9d954e7aa646e5c): 12 findings — 1 blocker (exported JSON Schemas carried additionalProperties:false, contradicting R2; fixed with io:'input' + regression test), 3 majors (prose-quote poisoning of the balanced-brace scanner; fail() emitting frames that fail validation → clamped; AC-9 gap → respondTo wrapper guaranteeing terminal frames), plus spread-order marker override, security-scan rebalance (known provider prefixes reject; entropy-only under neutral keys warn), frameWithinLimits, classifyErrorCode, db per-op discriminated unions, path-carrying diagnostics, binary bytes in a test file escaped. 74 tests green; schemas regenerated.
- State: ready to merge; High-tier self-sign-off: plan reviewed pre-implementation, negative tests present (C1 strip/scan, R2, version rejection), all review findings closed or explicitly re-scoped in AC text.
- Next step: merge to main, proceed to child 2 (knowledge-store).
