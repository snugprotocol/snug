# TASK-20260806-webllm-spike: WebLLM adapter spike — in-browser brain behind a flag (AL-07 / roadmap A7)

- **Status**: in-review (complete on branch; PR/merge deliberately left to the umbrella orchestrator)
- **Owner**: Jeetu (autonomous — child of TASK-20260805-alpha-umbrella; child plans pre-approved by Phase-0 decision 6)
- **Risk tier**: medium (playground logic + a new adapter; no protocol change, no C1/C2 surface)
- **Branch**: `feat/TASK-20260806-webllm-spike`
- **Packages touched**: `apps/playground` only (the adapter lives in the playground, NOT in `packages/adapters` — see Decisions)
- **Spec impact**: none (roadmap 1.2-5 queues a `webllm` conforming-mode spec note for GA — not this spike)
- **Related**: umbrella AL-07 row + Phase-0 decision 3 (model decision delegated to this spike) · roadmap A7 / S2 / 1.2-1 · ADR-0008 (host-page LLM calls) · ADR-0012 (per-turn caching — webllm ignores the flag by contract) · ADR-0013 (hosted hub modes incl. WebLLM) · ADR-0015 (written by this task)

## Spec (what & why)

Roadmap A7: an **in-browser WebLLM mode behind an experimental flag, with graceful fallback to demo when WebGPU is absent**. This is the S2 signature move's first cut: apps think inside the browser tab — no key, no signup, no server. It is a SPIKE: the goal is a working, honestly-scoped experimental mode plus the Phase-0-delegated **model decision**; GA polish (model picker, cold-start UX, cache management) is milestone 1.2 and explicitly out of scope.

The mode must ride the existing seams unchanged: the `AgentAdapter` contract, the `runAgentTurn` choke point (so `round_trip_start`/`round_trip` events feed the think panel for free), and the demo brain as the fallback. It must NOT appear as a first-class equal of byok/local/subscription — activation is a URL flag, and the persisted `PlaygroundMode` union is untouched.

**Acceptance criteria** (each becomes at least one test):

1. **Flag-off = invisible.** Without the `?webllm=1` query flag the playground has NO webllm surface: no experimental settings card, no banner, and brain resolution returns "use configured settings" for every webgpu state. *(unit: resolver table; e2e: flag-off page has no `[data-testid^="webllm-"]` element and the mode group still shows exactly the three existing choices)*
2. **Flag-on + WebGPU → webllm brain on both turn paths.** With the flag on and WebGPU available, the builder chat AND the app-frame transport run their turns through the WebLLM adapter (fake engine receives the request; reply text reaches the caller). *(unit at the wiring altitude: `createAppTransport`/`createDirectBuilder` with stores set + injected fake engine loader)*
3. **Flag-on + no WebGPU → demo fallback + plain-language banner.** Brain resolution forces the demo brain (mock adapter) on both paths, and the shell shows: "this browser can’t run local models — showing the demo brain". *(unit: resolver + transport wiring proves the demo script answers; e2e: `navigator.gpu` deleted via init script → banner visible, and a demo build still completes)*
4. **Contract-faithful adapter.** The WebLLM adapter implements `AgentAdapter` and is reached only via `runAgentTurn`: deltas stream through `onDelta`; the event union (`round_trip_start`/`round_trip`) fires with the same shapes the inspector renders; usage maps `prompt_tokens`/`completion_tokens` → `inputTokens`/`outputTokens` with cache fields ABSENT (never coerced to 0); errors are data, never thrown across the boundary. *(unit with fake engine, incl. one through `runAgentTurn` asserting the event feed)*
5. **Wire model name.** `AdapterResult.model` is the engine-REPORTED loaded model id (chunk `model` field), falling back to the configured id only when chunks carry none — never a UI guess. *(unit: fake chunk reports a different id than configured; result carries the reported one)*
6. **Tools refused honestly; builder uses the no-tools path + fenced-HTML envelope.** A request carrying tools returns a typed `WEBLLM_TOOLS_UNSUPPORTED` error without touching the engine (see Decisions: WebLLM 0.2.84 function calling is 8B-Hermes-only and forbids custom system prompts). In webllm mode the builder therefore offers NO tools, appends a fenced-HTML output instruction to the system prompt, and a reply containing a complete single-file HTML document is extracted, written through the artifact sink, and fires `onArtifact` (the app installs and runs). *(unit: adapter tool refusal; builder-path test: fake engine sees zero tools + the suffix; fenced reply → sink write + artifact event; extractor edge cases)*
7. **Engine lifecycle.** The engine is loaded ONCE per model id across turns/adapters (fresh-adapter-per-turn must not re-download GBs); a load failure returns a typed retryable `WEBLLM_LOAD_FAILED` error result. *(unit: loader spy call count across two turns; rejecting loader → error result, second call retries)*
8. **Abort.** A pre-aborted signal cancels without touching the engine; a mid-stream abort interrupts generation and returns `CANCELLED` with the already-streamed text preserved as `partialText`. *(unit with a controllable fake stream)*
9. **Model decision recorded.** Candidates from the pinned @mlc-ai/web-llm prebuilt list benchmarked on app-build-shaped prompts as far as this environment allows; what ran and what did NOT run is stated plainly; decision + rationale in this journal AND ADR-0015. *(doc — no test; the default-model constant is asserted by the resolver test)*

**Out of scope**: GA polish (model picker, cold-start/download UX, cache management, PWA — roadmap 1.2); WebLLM in subscription mode semantics beyond "the flag overrides whatever mode is configured" (documented below); a webllm spec note (1.2-5); desktop; KB prompt-size tuning for 4K-context models; changing the persisted `PlaygroundMode` union or the settings mode picker.

## Plan

**Shared literals (pinned before code, lesson 2026-08-03):**
- URL flag: query param `webllm=1` (exact value `1`).
- Test ids: `webllm-fallback-banner`, `webllm-experimental-card`.
- Banner copy (exact): `this browser can’t run local models — showing the demo brain`
- Error codes: `WEBLLM_TOOLS_UNSUPPORTED` (not retryable), `WEBLLM_LOAD_FAILED` (retryable); both classify to HOST_ERROR at frame boundaries (R5), same pattern as `STREAM_DROPPED`.
- Engine dep: `@mlc-ai/web-llm@0.2.84` (pinned exact; latest as of 2026-08-06).

**Files (all `apps/playground`):**
1. `src/state/webllm.ts` — flag parse (`parseWebllmFlag`), WebGPU probe (`detectWebGpu` — `navigator.gpu.requestAdapter()` non-null, try/catch false), stores (`webllmFlagStore`, `webgpuStore: 'unknown'|'yes'|'no'`, `webllmLoadStatusStore` for download progress text), boot `initWebllm()`, and THE decision function `resolveBrain(flagOn, webgpu): {kind:'settings'}|{kind:'webllm';model}|{kind:'demo';reason:'no-webgpu'|'probing'}` + `useBrain()`. The condition lives here and is tested here (lesson 2026-08-05: test where the DECISION is made).
2. `src/agent/webllm/engine.ts` — engine singleton keyed by model id; default loader dynamic-imports `@mlc-ai/web-llm` (code-split — the main bundle must not swallow the engine); `setWebllmEngineLoaderForTests()` seam; progress → `webllmLoadStatusStore`.
3. `src/agent/webllm/webllmAdapter.ts` — the `AgentAdapter`; narrow structural engine types (no direct type dep on the lib in the contract surface); `WEBLLM_DEFAULT_MODEL`.
4. `src/agent/webllm/appHtml.ts` — `extractAppHtml(text)` (last complete single-file HTML fence or bare doctype document + `<title>`), pure.
5. `src/agent/adapter.ts` — `TurnAdapterConfig.mode` widened with `'webllm'` → returns the webllm adapter.
6. `src/agent/builder.ts` — webllm branch in `createDirectBuilder`: no tools, system suffix (fenced-HTML instruction), post-turn `extractAppHtml` → `sink.write` + `onArtifact`. Existing byok/local/subscription branches byte-identical in behavior.
7. `src/agent/transport.ts` + `src/agent/useBuilderChat.ts` — consume `resolveBrain` when picking the agent/adapter (`'demo'` → byok+mock, `'webllm'` → mode `'webllm'`); F15 confirm-guard stays in force for webllm (a synced file's settings remain executable config).
8. `src/views/WebllmBanner.tsx` + mount in `App.tsx`; experimental card in `SettingsView.tsx` (rendered only when the flag is on).
9. Tests: `src/__tests__/webllmState.test.ts`, `webllmAdapter.test.ts`, `webllmBuilder.test.ts` (+ transport assertions in it or `webllmTransport.test.ts`); e2e `e2e/webllm.spec.ts`; optional skip-by-default real-load spec.
10. Benchmark harness (NOT shipped as product code): scratch page + agent-browser/Playwright drive, results into this journal + ADR-0015.

**Order (TDD):** task file → red unit tests for resolver/adapter/extractor → implement 1–4 → wire 5–7 with red wiring tests first → banner/settings + e2e → benchmark/model decision → ADR + docs → full suites.

**Cross-package impact:** none at build time (playground leaf). `packages/adapters` is imported but unchanged. No protocol change → no spec-sync.

**Port note:** the Playwright reference server pins 8787; if this environment has 8787 busy at e2e time, adapt locally (env-var override threaded through helpers + vite proxy) without inventing repo-wide infra.

## Decisions & surprises

- **Adapter lives in `apps/playground`, not `packages/adapters`.** The engine dep is browser-only, ~GB-scale at runtime, experimental, and `packages/adapters` is imported by `apps/server`; an experimental in-browser engine does not belong in the shared package until GA (1.2 can promote it). The CONTRACT still comes from `@snugprotocol/adapters` types, and the turn still runs through `runAgentTurn`.
- **Tools are off in webllm mode — investigated, not assumed.** @mlc-ai/web-llm 0.2.84 gates `ChatCompletionRequest.tools` on `functionCallingModelIds` = five 8B-class Hermes models (≈4.9–6 GB VRAM — outside the small-model target), and its hardcoded Hermes path THROWS on any custom system message (`CustomSystemPromptError`) and hijacks `response_format`. Snug's builder IS a custom system prompt; the combination is structurally incompatible. Blast radius of the no-tools choice: in webllm mode there is no KB consult round-trip, no `schema_apply`/`app_doc_write` (no native-schema apps, no wiki writes — LLM-optional doctrine unaffected), and artifacts arrive via the fenced-HTML envelope instead of `artifact_write`. App-frame turns are untouched (they were already tool-free JSON-only).
- **Fenced-HTML envelope over "constrained JSON".** Asking a 1–3B model to emit one fenced HTML document is strictly easier than asking for valid JSON containing an escaped HTML string (escaping is where small models die). The reply text keeps the code visible in chat — ugly, accepted for the spike; queued as 1.2 polish.
- **The flag overrides the configured mode entirely** (including subscription): `?webllm=1` means "run the webllm experiment". Least-invasive alternative (only overriding direct modes) would make the flag's meaning depend on a second setting — worse to reason about, worse to test.
- **`modelStore` is NOT consulted** — the shared model setting belongs to byok/local wire ids; a webllm model id is a different namespace. The spike always loads `WEBLLM_DEFAULT_MODEL`; the picker is 1.2-1.
- **Context reality check:** builder system prompt ≈ 1.2K tokens (measured: 4,951 chars), app-frame ≈ 950 — both fit the 4K default context of the candidates, but a full app build reply can crowd 4K; noted in ADR as a GA consideration (webllm `context_window_size` override costs KV memory).
- **`cache: true` is passed through and ignored** — per the AdapterRequest contract ("providers that do not support caching ignore it") and ADR-0012; usage cache fields stay ABSENT.
- **Qwen3's think knob is a lose–lose on this surface** (measured): think OFF → the model mistakes the build request for an app-envelope request (0/3); think ON → chain-of-thought streams into the chat bubble and eats the 4 K context (1 448 tokens for one small app). The `enable_thinking:false` plumbing stays (tested, Qwen3-ids-only, dormant under the Llama default) so the 1.2 picker inherits a documented tradeoff rather than a surprise.
- **`navigator.gpu` only exists in SECURE contexts** — a WebGPU probe run on about:blank reports absence on every browser. All product probing happens on the app origin (localhost/https), so this bites only tooling — but any future headless test that asserts WebGPU must navigate somewhere real first.

## Session journal (append-only, newest last)

### 2026-08-06 00:3x — Claude (Fable 5) — session (Gate 1+2)
- Done: mandatory reads (PROCESS/TDD/lessons all, umbrella AL-07 + Phase-0 decision 3, roadmap A7/§1-S2/§2, architecture seams, adapters contract + `runAgentTurn`, playground adapter/transport/builder/mode wiring, ADR-0012/0013); worktree install + root build green; `@mlc-ai/web-llm@0.2.84` pinned and its shipped `prebuiltAppConfig` (163 models) + function-calling gate read from source; spec/plan written.
- State: plan complete (pre-approved via umbrella Phase-0); starting Gate 3 red tests.
- Next step: red tests for resolver + adapter + extractor.
- Open questions: whether headless/headed Chromium on this Mac yields WebGPU for a real generation (AC9 scales honestly if not).

### 2026-08-06 01:5x — Claude (Fable 5) — session (Gates 3–5 + benchmark start)
- Done: red→green TDD across 43 unit tests (45 after the Qwen3 think-knob pair landed later in the session) (resolver table, adapter contract incl. wire-model/usage/abort/load-retry/tool-refusal, extractor edges, transport + builder + HOOK wiring); mutation-checked the three load-bearing guards (resolver 'unknown'→webllm, transport ignoring the brain, engine singleton removal — each seen red). Playwright: 33 passed + 1 deliberate skip (flag-off zero surface; forced-no-WebGPU banner + demo build; skip-by-default real-load spec). `SNUG_SERVER_PORT` override added to e2e helpers + vite proxy (8787 was held by a sibling checkout — the suite must be runnable from a second worktree).
- **Real defect found by the hook-level test (would have shipped):** `useBuilderChat`'s artifact handler branched on the CONFIGURED mode — with subscription configured and the webllm demo-fallback active, a demo artifact was routed through the hub artifact fetch (`ARTIFACT_FETCH_FAILED`). Fixed by deriving `serverTurn` from brain+mode; the exact defect class of lessons 2026-08-05 (stale discriminator).
- Qwen3 family thinks by default — `extra_body.enable_thinking=false` (0.2.84-supported) is sent for Qwen3-* ids only; a 4 K context building an app cannot afford think tokens. Two tests pin it.
- WebGPU environment truth (probed, not assumed): `navigator.gpu` exists only in SECURE contexts — every about:blank probe lies. On this M-series Mac: bundled Playwright Chromium HEADLESS = `gpu` present but `requestAdapter()` → null (exactly the case detectWebGpu treats as absent); bundled HEADED = works (metal-3); real Chrome (`channel: 'chrome'`) works EVEN HEADLESS. Benchmarks run headless via Chrome channel + persistent profile.
- Benchmark methodology: temporary bench page (untracked, deleted before close) running the EXACT product turn shape — real `buildHostSystemPrompt({appBuilder:true,artifacts:false})` + `WEBLLM_BUILD_SUFFIX`, judged by the real `extractAppHtml`; 3 app-build prompts (tip calculator / capitals quiz / pomodoro); measures load ms, TTFT, decode tok/s (engine-reported), completion tokens, extraction success + DOM-parse of the extracted app.
- First real generation CONFIRMED (Llama-3.2-1B-q4f16): load 74.7 s cold, TTFT 2.47 s, 62.7 tok/s decode, 697 tokens — extracted a parseable but THIN app (672 bytes; the 1B split HTML/CSS/JS into separate fences, losing the styles/logic). Prompt = 993 tokens on the wire, so the builder prompt fits 4 K with ~3 K to spare.
- State: Qwen3-1.7B + Llama-3.2-3B (3 prompts each) benchmarking in the background.
- Next step: results → model decision → ADR-0015 → docs close-out → full suites → final commit.

### 2026-08-06 02:1x — Claude (Fable 5) — session (model decision, AC9)
- **Benchmark complete — all four planned runs plus a fairness check actually ran** (nothing scaled down; full JSON preserved below). Product turn shape (real KB system prompt + fenced-HTML suffix = 990–993 wire tokens), 3 app prompts, judged by the real extractor + DOM parse:
  - **Llama-3.2-1B-q4f16**: 74.7 s cold load / **1.7 s warm** (browser cache hit); 55–65 tok/s. 3/3 extracted but ALL thin (373–672 B) — it splits HTML/CSS/JS into separate fences, so the installed app loses its styles/logic; pomodoro rambled 3 102 tokens.
  - **Qwen3-1.7B-q4f16 think OFF** (the only config a 4 K context affords): **0/3** — every reply was hallucinated `responseSchema` JSON; it latched onto the system prompt's app-envelope layer and treated the human build request as an app request. Also leaks a literal empty `<think>` block into reply text.
  - **Qwen3-1.7B think ON** (fairness re-run): 1/1 but thin (982 B), 1 448 tokens / 61.5 s for one small app — and the full chain-of-thought streams into the chat bubble. Broken either way for this product surface.
  - **Llama-3.2-3B-q4f16**: 141 s cold (1.7 GB); 23–26 tok/s; TTFT 2.6–3.2 s; **3/3 complete single-fence documents** (620–2 280 B, all DOM-parse clean, correct titles); 30–56 s per build.
- **DECISION (Phase-0 item 3): default = `Llama-3.2-3B-Instruct-q4f16_1-MLC`** — the smallest tested model that reliably keeps the whole app in one fence with substantial output. Constant flipped in `agent/webllm/model.ts`; guard test green. Rationale + table in **ADR-0015** (indexed).
- What was NOT measured (honest scope): only 1 prompt for Qwen3-think-ON and 1B-cold (their other rows are warm); no Qwen3.5/gemma3/Phi-4-mini runs (time-boxed — queued for the 1.2 picker work); single machine (M-series, fast network); quality judged by extraction + DOM parse + eyeball of heads, not by interacting with every generated app.
- Environment findings worth keeping: `navigator.gpu` exists only in secure contexts (about:blank probes lie); bundled Playwright Chromium headless = null adapter (validates the requestAdapter-based probe); real Chrome has WebGPU even headless (`channel: 'chrome'`).
- State: real-model e2e through the actual product UI running in the background (headed bundled Chromium, fresh download).
- Next step: e2e result → bench scratch cleanup → code-map count regen → full suites → final commit.

### 2026-08-06 02:2x — Claude (Fable 5) — session (Gate 6 close)
- **Real-model e2e through the ACTUAL product UI: PASSED** — `SNUG_E2E_WEBLLM_REAL=1`, headed bundled Chromium, ephemeral profile: `/build?webllm=1` → active note → composer send → fresh 1.7 GB Llama-3.2-3B download + shader compile + real generation → streamed agent bubble. 10.2 minutes end-to-end, which is exactly why the spec stays skip-by-default in CI. This doubles as the live sweep of the webllm-active path; the WebGPU-absent path's live check is the (always-on) fallback e2e with its console-clean assertion.
- Bench scratch (bench.html, src/bench.ts, bench-run.mjs, probes) deleted — never committed; methodology + results live in ADR-0015 and this journal. Raw JSONL kept outside the repo in the session scratchpad.
- Code-map counts regenerated via `pnpm run update-code-map` (playground 248 → 293); webllm row and Playwright counts updated by hand (33 + 1 skip-by-default).
- Suites at close: root `pnpm build` green · root `pnpm test` green (19/19 turbo tasks; playground 293 = baseline 248 + 45 webllm) · playground Playwright 33 passed + 1 deliberate skip (runs against `SNUG_SERVER_PORT=18787` — 8787 held by a sibling checkout; override rides this branch) · real-model spec additionally verified once, above.
- Lessons: added the secure-context capability-probe rule (about:blank hid WebGPU from every first probe).
- ACs: 1–8 test-covered and green; AC9 recorded in ADR-0015 + this journal, and exceeded — a real end-to-end generation ran through the product UI, not just the bench page.
- **Flake found and fixed in a PRE-EXISTING spec during final verification** (candid record): two consecutive full e2e runs each dropped one unrelated test — dedup once (unreproducible in 3 later runs), then `no-server.spec.ts`'s OPFS-reload test twice in a row. The trace showed the truth: OPFS persistence was FINE (the installed app was on the reloaded page); the spec's `toHaveURL(/\/run\//)` also matches the read-only starter route, so under this session's machine load it captured `/run/starter--chess` before the install navigation landed and then asserted a link the hub never renders. Fixed by waiting for the installed-id URL (`/\/run\/(?!starter--)[0-9a-f-]{8,}/` — the exact pattern owner-report.spec.ts already uses); the OPFS byte-wait now also waits for the real app id, making the spec STRONGER, not weaker. 3× targeted green + full suite green after the fix.
- State: **complete on branch; stopping before PR/push per orchestrator instructions** (no push/PR from this child). Status set to in-review; task file stays in `active/` until the umbrella merges it.
- Next step (for the orchestrator): PR + fresh-context adversarial review per umbrella DoD; on merge, move this file to `done/`. Note for the reviewer: the dedup one-off failure was not reproduced (5 subsequent green runs incl. 2 full suites) — if it recurs on a quiet machine, treat it as real.
- Open questions: none blocking. GA follow-ups queued in next-steps (fence-strip UX, 4 K-context truncation rule for app-attached chats, model picker).
