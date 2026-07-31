# TASK-20260731-runner-sandbox: `packages/runner` — sandboxed iframe host + bridge (child 3 of build-hub)

- **Status**: in-review
- **Owner**: Jeetu (delegated session)
- **Risk tier**: **high** (C2 sandbox/CSP; touches `packages/protocol` via two loop-backs)
- **Branch**: `feat/TASK-20260731-runner-sandbox`
- **Packages touched**: `packages/runner` (new), `packages/protocol` (loop-backs), docs
- **Spec impact**: v0.1-draft amendments (parse-result requestId recovery; db frame size class) — staged, changelog updated
- **Related**: umbrella P0.6/P3; fresh-context plan review (12 findings, agent a6e350d585d4093a3) — ALL binding below; ADR-0006 (this task)

## Spec (what & why)

Sandboxed execution surface for untrusted LLM-authored HTML. Framework-agnostic `createRunnerHost` + React `<SnugAppFrame>`. Design = plan draft + every plan-review finding F1–F12 incorporated:

**Security (C2) — binding decisions:**
- Sandbox `allow-scripts` only; srcDoc; CSP injected via **DOM parsing** (DOMParser → `doc.head.prepend(meta)` → re-serialize with doctype), never string surgery (F1: parse-order bypass). Hostile-input tests: script-before-head, `<HEAD >`, no head, no html, comment decoys, body-first.
- CSP: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {cdn}; style-src 'unsafe-inline' {cdn}; font-src {cdn} data:; img-src data: blob:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` (F3: worker fallback hole closed). No meta-ignored directives (asserted). Frozen module constant; **no API path parameterizes it** (C2 no-bypass). Meta-CSP is defense-in-depth; authoritative HTTP-header delivery is recorded as a server/playground obligation; srcdoc-inherits-embedder-CSP recorded as a child-6 constraint.
- **Navigation escape (F2):** host counts document `load`s per srcDoc assignment; an unexpected load ⇒ permanent post-cutoff (abort all in-flight, never post again, `onNavigatedAway()`). C2 negative test. Real-browser verification of embedder-level navigation blocking is deferred to the Playwright suite (below).
- **Real-browser CSP suite (F11):** `browser-csp.spec.template.ts` authored HERE (fetch/XHR/WS/beacon blocked; external img blocked; CDN worker blocked; localStorage/cookie throw; hostile parse-order inputs; non-allowlisted CDN blocked; eval works), executed in child 6's Playwright harness — jsdom ACs are string/behavior assertions only, and that limitation is explicit.

**Identity & lifecycle (F4, F5, F7):**
- `instanceId` minted **per document load**; inbound frames with stale/mismatched instanceId dropped silently; on reload: abort in-flight (`SUPERSEDED`) before new `snug:host-ready`.
- Budget key + db namespace are **host-assigned opts** (`budgetKey`, `dbNamespace`) — never derived from app-claimed `appId` (negative tests: re-announce ≠ budget reset; db scoped to host namespace). `BudgetStore` is synchronous.
- `createRunnerHost` returns `{destroy, reset, setTheme, notifyEvent}`; destroy removes listener, aborts in-flight, clears timers. Listener attached **before** srcDoc assignment (AC). React wrapper: host keyed on iframe element, srcDoc assigned in effect, StrictMode double-mount safe (AC).
- In-flight map: duplicate in-flight requestId → non-retryable `HOST_ERROR`; `MAX_IN_FLIGHT = 8` cap; all responder calls guarded by `isClosed`; map cleanup in `finally`; abort-aware backoff sleep.

**Transport contract (F6)** — runner owns the interface:
`AgentTransport.send(wire, {signal, onDelta}) → Promise<TransportResult>` where `TransportResult = {ok:true, text} | {ok:false, code, message, retryable}` — errors as data; child 5 maps HTTP/SSE→codes (409→THREAD_CONFLICT etc.); `onDelta` receives **deltas**, host accumulates → cumulative streaming frames; post-settle callbacks ignored; no app-controllable URL/header surface (C1 note in type doc).

**Budget & streaming semantics (F8, F9):** budget-exhausted requests get immediate `ok:false` (`retryable:false`) — never silence (R3); strike = terminal PARSE_FAILED only; success resets. Oversized streaming frame → skipped (stream continues); only oversized terminal → error (message clamped). Inbound app-message/db-request size-checked before forwarding.

**Protocol loop-backs (F10, this branch, spec-changelog'd):** (1) `FrameParseResult` failure variants carry `requestId?` when recoverable so hosts can answer `UNSUPPORTED_VERSION`/`MALFORMED` on the wire; (2) db-request/db-response get their own size class `LIMITS.MAX_DB_FRAME_BYTES = 8 MiB` (base64 of a 5 MiB artifact fits; `frameWithinLimits` becomes per-type) — makes `.sqlite` round-trip implementable; (3) `capabilities.auth: false` explicit.
**Observation (F12):** `onFrame(direction, frame)` callback (structural payloads — Inspector hook for child 6); `onAppEvent(event, data)` for resize/visibility.

**Acceptance criteria:** as plan draft ACs 1–10, amended per findings: AC-1 gains hostile-injection matrix + no-meta-ignored-directives; AC-2 concretized (frozen constant, source-grep guard, rendered-attribute test); new ACs: navigation cutoff; per-load instanceId + stale-instance drop; host-assigned budget/db identity negatives; duplicate/flood requestId; StrictMode; listener-before-srcDoc; budget-exhausted error frames; streaming oversize skip; transport result taxonomy; onFrame/onAppEvent; protocol loop-back tests (recovered requestId, db frame size class). Package vitest config with jsdom; real-iframe contentWindow for source-identity tests.

**Out of scope:** SSE transport impl (child 5); DbDriver impl (child 4); Playwright execution (child 6, spec authored here); auth card (v1.1).

## Plan
Protocol loop-backs first (schemas regen + changelog) → `src/csp.ts` (+hostile tests) → `src/host.ts` state machine (+lifecycle/budget/retry/db-routing tests) → `src/react/SnugAppFrame.tsx` (+StrictMode/remount tests) → `src/browser-csp.spec.template.ts` → ADR-0006. Tests first per area. Deps: protocol (workspace), react peer, @types/react + vitest jsdom config.

## Decisions & surprises
- ADR-0006 (this task): `'unsafe-eval'` + CDN allowlist justified by Babel-standalone in-browser JSX; CDN ≠ integrity control (load-bearing controls: connect-src 'none', opaque origin, no allow-same-origin, worker/child-src 'none'); revisit trigger: precompiled apps.

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: plan draft + fresh-context High-tier review (12 findings) fully incorporated above; High-tier pre-implementation review satisfied.
- Next: loop-backs → tests-first implementation → Gate-5 adversarial review → merge.

### 2026-07-31 — Claude (Fable 5) — implementation session
- Done (tests-first per area): protocol loop-backs (`FrameParseResult.requestId?` recovery, `LIMITS.MAX_DB_FRAME_BYTES` + per-type `frameWithinLimits`; 11 new tests; no JSON-schema drift — schemas untouched, stable test green); spec-changelog entry + SPEC-DRAFT R1/R6 prose; `packages/runner` implemented in full: `csp.ts` (frozen RUNNER_CSP + DOM-parsing injectCsp, 17 tests incl. hostile matrix), `transport.ts` seams (AgentTransport/TransportResult/BudgetStore/DbDriver, C1-noted), `host.ts` (full state machine: announce/ready, per-load instanceId via srcdoc-credit MutationObserver + load counting, navigation cutoff, budget strikes, duplicate/flood, cancel, THREAD_CONFLICT backoff, db routing with host namespace, wire answers for recoverable parse failures, onFrame/onAppEvent; 53 tests), `react/SnugAppFrame.tsx` (StrictMode-safe, effect-declaration-order upholds listener-before-srcDoc, html change = reset flow, controlsRef; 8 tests), `browser-csp.spec.template.ts` (11 data-driven checks for the child-6 Playwright harness), index exports + source-guard (7 tests). ADR-0006 written; ADR index updated (0004–0006).
- jsdom findings (documented in test harness): vitest-jsdom delivers the natural iframe `load` only to listeners registered before `appendChild` and never re-fires on srcdoc reassignment → host tests simulate loads via `dispatchEvent(new Event('load'))` after letting the srcdoc mutation record deliver. Real-browser load semantics are a Playwright-suite concern (F11).
- Test totals: protocol 85 (was 74), runner 85, all green; both packages build clean.
- Gate-5 fixes applied (verdict: merge-ready, 4 minor): (1) three new browser CSP checks — hostile `<base href>` inert (base-uri 'none'), `form.submit()` to external action blocked (form-action 'none'; missing verdict = harness failure), app-supplied permissive CSP meta cannot widen the policy (intersection wins); (2) db-request duplicate + MAX_IN_FLIGHT flood guards mirroring app-message (duplicate → non-retryable, flood → retryable db-response error; 3 tests); (3) `answerUnparseable` only answers app-origin types (app-message/db-request) — host-frame echoes and app-cancel dropped even with recoverable requestId (2 tests). Fourth finding recorded by coordinator as child-6 note. Totals after fixes: runner 90, protocol 85, both green.
- Next: merge.

### 2026-07-31 — Claude (Fable 5) — Gate-5 close
- Gate-5 adversarial review (agent aa8b04264051f71c3): MERGE-READY, no blockers; C1 verified airtight, C2 CSP tree-order verified against full hostile matrix. 4 minor findings; 3 applied (browser-suite base-uri/form-action/permissive-meta checks; db flood/duplicate guards; anti-reflection in answerUnparseable), 1 recorded for child 6 (Playwright StrictMode double-srcdoc case). Runner 90/90, protocol 85/85, root green.
- High-tier self-sign-off: plan fresh-context-reviewed pre-implementation; negative tests present for every C2 claim testable in jsdom; browser-suite template gates the rest via child 6.
