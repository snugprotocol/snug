# Good first issues

Ten curated, currently-true entry points into the codebase — each verified against the code on 2026-08-06 and mirrored as a `good first issue` on the tracker. Ground rules from [CONTRIBUTING.md](../CONTRIBUTING.md) apply: the issue is your spec, tests come first for anything beyond docs, run the listed suite plus dependents. None of these touch High-tier paths.

Conventions: **Difficulty** easy / moderate / stretch · **Proves it** = the suite that must go red-then-green.

---

## 1. Stop rendering "0% cached" as if it were information

**Context.** The OpenAI adapter reports `prompt_tokens_details.cached_tokens` whenever the provider sends it — including `0` (`packages/adapters/src/openai.ts`, usage normalization), so an OpenAI turn renders "0% cached" in the LLM inspector where an Anthropic no-cache turn renders nothing (`apps/playground/src/run/LlmInspectorPanel.tsx`, `cachedPercent` + the `llm-cached` chip). Both follow the absent-vs-zero rule, but side by side they read inconsistently (queued `docs/next-steps.md`, 2026-08-05). Decision, so you don't have to relitigate it: a **reported zero renders no per-entry cache chip** — zero and absent read the same in the entry line; the aggregate footer keeps counting reported zeros.
**Files.** `apps/playground/src/run/LlmInspectorPanel.tsx`; tests in `apps/playground/src/__tests__/` (the `llmInspectorPanel` suite, testid `llm-cached`).
**Acceptance.** Entry with `cacheReadTokens: 0` and no cache-write shows no `llm-cached` chip; entry with a real hit still shows its %; aggregate line unchanged.
**Difficulty.** easy · **Proves it.** `pnpm --filter playground test`

## 2. Sync divergence buttons should state their consequence

**Context.** When sync detects divergence, Settings offers "use the origin copy" / "keep this device's copy" (`apps/playground/src/views/SettingsView.tsx`, the `sync.state === 'divergence'` branch) — a generic two-button choice. Queued ask (`docs/next-steps.md`, 2026-08-04): each button must state what gets overwritten, e.g. "use the origin copy — replaces this device's version" / "keep this device's copy — overwrites the origin". Wording should say what is *lost*, in plain words an 11-year-old could act on.
**Files.** `apps/playground/src/views/SettingsView.tsx`; a render test (new or beside `apps/playground/src/__tests__/syncState.test.ts`).
**Acceptance.** Both buttons name their losing side; test asserts the consequence text renders in the divergence state.
**Difficulty.** easy · **Proves it.** `pnpm --filter playground test`

## 3. Signed-out "this hub" sync should say "sign in first", not "(401)"

**Context.** Selecting the **this hub** sync origin while signed out surfaces "sync problem — hub rejected pull (401)" — the raw provider error (`packages/db/src/sync/hub-origin.ts` throws `SyncProviderError` with code `AUTH`; `apps/playground/src/views/SettingsView.tsx` renders `sync.detail` verbatim in the `sync.state === 'error'` branch). Queued from a live sweep (`docs/next-steps.md`, 2026-08-06). The fix belongs in the playground's error *presentation*, not the provider: when the origin is the hub, the error code is `AUTH`, and no user is signed in, say "sign in first to sync with this hub" (the identity state already exists — the header menu reads it). Keep the raw detail for genuinely-authenticated failures. Sibling of issue 2 — same copy surface, separate state.
**Files.** `apps/playground/src/views/SettingsView.tsx` (and/or the sync-state mapping that feeds it); tests beside the existing sync/settings suites.
**Acceptance.** Signed-out + hub origin + AUTH error renders the sign-in copy (no "401" visible); signed-in AUTH failures keep the factual detail; dropbox path unaffected.
**Difficulty.** easy · **Proves it.** `pnpm --filter playground test`

## 4. Builder chat renders raw markdown

**Context.** Agent replies render as plain text (`apps/playground/src/views/ChatLog.tsx` renders `message.displayText` directly), so `**bold**` shows its asterisks and markdown links show their brackets — including `/artifacts/…` links the model likes to emit, which are also a dead route in serverless byok mode. Queued from a live sweep as cosmetic (`docs/next-steps.md`, 2026-08-06). Scope discipline: this repo takes **no new runtime dependency** without an ADR, so no markdown library — hand-roll minimal inline rendering (`**bold**`, `*italic*`, backtick code) and render markdown links as their label text only. Block-level markdown is explicitly out of scope.
**Files.** `apps/playground/src/views/ChatLog.tsx` (or a small pure helper beside it); tests in `apps/playground/src/__tests__/`.
**Acceptance.** `**bold**`/`*italic*`/`` `code` `` render styled without their markers; `[label](/artifacts/x)` renders "label" with no dangling URL; plain text and streaming behavior (caret, error notes) unchanged.
**Difficulty.** moderate · **Proves it.** `pnpm --filter playground test`

## 5. StrictMode double-mount kills the hub → builder `?idea=` handoff on dev

**Context.** The hub's "talk. build. run." prompt hands an idea to the builder via `?idea=`; under React StrictMode on `pnpm dev` the double-mount aborts the auto-started turn (unmount cleanup in `apps/playground/src/agent/useBuilderChat.ts` aborts in-flight turns — correct in itself) while the `sentInitial` ref guard in `apps/playground/src/views/BuilderView.tsx` blocks the remount resend, so the turn shows CANCELLED and never retries. Prod builds are unaffected, but it's the marquee flow on dev demos (queued `docs/next-steps.md`, 2026-08-06). Decision altitude, already settled: fix at the **`?idea=` effect** in `BuilderView` (the handoff must survive a remount) — do NOT weaken the unmount abort, which exists so no request runs headless.
**Files.** `apps/playground/src/views/BuilderView.tsx`; tests in `apps/playground/src/__tests__/` (simulate mount → cleanup → remount).
**Acceptance.** A test mounting/unmounting/remounting the view with `?idea=x` proves exactly one *surviving* turn starts; single-mount behavior unchanged (no double-send); the unmount abort stays.
**Difficulty.** moderate · **Proves it.** `pnpm --filter playground test`

## 6. Example validator should discover apps, not hardcode them

**Context.** `examples/validate.test.mjs` pins `const APPS = […8 names…]` near the top. A contributed example in a new directory would silently skip validation — exactly wrong for a repo that treats every starter as a contract (CONTRIBUTING.md). Keep the ADR-0011 posture declaration explicit: `LLM_FREE_APPS` stays a hand-maintained set (posture is a *declaration*, not something to infer), and a discovered app absent from it is validated as agent-driven.
**Files.** `examples/validate.test.mjs` (+ a line in `examples/README.md`).
**Acceptance.** Validator derives the app list from `examples/` subdirectories containing an `app.html`; a test asserts the discovered set matches the filesystem; the current eight apps pass unchanged; a scratch directory without `app.html` is ignored.
**Difficulty.** easy · **Proves it.** `pnpm --filter examples test`

## 7. Surface *why* an inspector entry's payloads are missing

**Context.** When a single LLM round trip exceeds the inspector's total-bytes budget, its bodies are replaced by an elision marker (`apps/playground/src/run/llmInspector.ts`, `elide()` / the `ELIDED` constant), but nothing at the entry level says so — you discover it only after expanding a body (queued `docs/next-steps.md`, 2026-08-05). Add an explicit `elided: true` flag on the entry and a compact badge in the entry header ("payloads elided — memory budget").
**Files.** `apps/playground/src/run/llmInspector.ts`, `apps/playground/src/run/LlmInspectorPanel.tsx`; the `llmInspector*` test suites.
**Acceptance.** `elide()` marks the entry; panel shows a badge (testid `llm-elided`) only for elided entries; non-elided entries unaffected.
**Difficulty.** moderate · **Proves it.** `pnpm --filter playground test`

## 8. Script: `check-spec-sync` guard

**Context.** `docs/engineering/SPEC_SYNC.md` names a planned invariant check (`scripts/check-spec-sync`, also listed as "future" in `docs/code-map.md`): a change touching `packages/protocol/src/**` must carry a `docs/spec-changelog.md` edit in the same branch. Today that's convention only. `scripts/update-code-map-counts.mjs` is the house pattern to follow: plain node, node:test beside it, no dependencies.
**Files.** New `scripts/check-spec-sync.mjs` (+ a node:test exercising it against a scratch git repo).
**Acceptance.** Given a base ref (default `origin/main`), exits non-zero with a clear message when protocol sources changed but the changelog didn't; zero otherwise; runnable locally and CI-ready; the code-map row flips from "future" to real.
**Difficulty.** moderate · **Proves it.** its own node:test; manual run on a branch that touches `packages/protocol`

## 9. Script: dead-link check for `docs/`

**Context.** The wiki under `docs/` is the project's memory, held together by relative links — and nothing catches a broken link at review time. One legitimate wrinkle: links into `internal/` (pre-launch strategy, deliberately untracked — hard constraint C4) dangle in every public clone by design, so the checker needs an allowlist rather than a blind fail.
**Files.** New `scripts/check-doc-links.mjs` (follow the `scripts/update-code-map-counts.mjs` pattern: plain node + node:test, no dependencies).
**Acceptance.** Scans `*.md` under `docs/` plus the root markdown files, resolves relative file links (`#anchors` optional), exits non-zero listing dead ones; `internal/` targets are allowlisted with a dated comment; any other dead links found on the current tree get fixed in the same PR.
**Difficulty.** moderate · **Proves it.** its own node:test; a clean run on the current tree

## 10. Glossary entries for the observability era

**Context.** `docs/glossary.md` stops at the portable-hub era. Terms a newcomer now hits in code and docs with no definition: **think panel**, **LLM round trip**, **LLM round-trip inspector** (and how it deliberately differs from the value-blind frame inspector), **starter / install source**, **status line**, **living app**. The precise language to mirror is in the matching `docs/code-map.md` rows (think panel, round-trip inspector, starter identity, build-step model) and `docs/architecture.md`.
**Files.** `docs/glossary.md`.
**Acceptance.** One entry per term above, each consistent with code-map wording, each naming the package/file where the concept lives; existing entries untouched.
**Difficulty.** easy · **Proves it.** docs-only — maintainer review (Low tier; no suite)

---

*Curation note: items 1–3, 5 and 7 originate from the dated queue in [`docs/next-steps.md`](next-steps.md) (live-sweep and review findings); 4 from the same sweeps' cosmetic list; 8–9 from standing script gaps named in the wiki; 6 and 10 from community-readiness review. An earlier draft's items (`supportsCaching` exact-host match, `importUserDb` cache coherence, the code-map count script) shipped with TASK-20260805-doctrines-devex before this list went live — dropped, which is the system working. If you pick one up, comment on the issue first so work isn't duplicated.*
