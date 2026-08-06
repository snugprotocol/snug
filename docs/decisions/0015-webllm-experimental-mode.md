# 0015 — WebLLM experimental mode: engine, model default, fallback

- **Status:** accepted
- **Date:** 2026-08-06
- **Task:** TASK-20260806-webllm-spike (AL-07; umbrella Phase-0 decision 3 delegated the model choice here)

## Context

Roadmap S2 ("WebLLM in-browser brain") ships experimentally at 1.0 and GA at 1.2: apps think inside the browser tab on WebGPU — no key, no signup, no server. The spike had to pick an engine and pin a version, decide HOW the mode activates without becoming a fourth first-class mode, decide what happens on the majority of browsers/devices where WebGPU is absent or inadequate, resolve whether tool-calling can work, and — per the umbrella's Phase-0 — pick the default model against the current small-model field, with measurements.

Constraints that shaped it: the adapter contract (`AgentAdapter` through the `runAgentTurn` choke point) is the only way the think panel, inspector, and error surfaces keep working unchanged; the hosted hub is static files (ADR-0013), so everything must run client-side; the persisted `PlaygroundMode` union and settings mode picker are product surface that an experiment must not squat on.

## Decision

1. **Engine: `@mlc-ai/web-llm`, pinned exact at `0.2.84`,** as a playground-only dependency behind a dynamic import (vite code-splits it; flag-off visitors download none of it). The adapter lives in `apps/playground/src/agent/webllm/` — NOT `packages/adapters` — because the shared package is imported by `apps/server` and an experimental browser-only engine does not belong there before GA. The default-model id is guarded by a test against the pinned version's `prebuiltAppConfig` (a dep bump that orphans the id fails in CI, not after a user's multi-GB download).
2. **Activation: the `?webllm=1` URL flag** resolved by ONE decision function (`resolveBrain` in `state/webllm.ts`) that OVERRIDES the configured mode — including subscription — for both `runAgentTurn` call sites. No new `PlaygroundMode` member, no mode button; the settings surface is a flag-gated "experimental" card. Every downstream "is this a server turn?" branch must read the brain, not the raw mode (the spike's hook-level test caught exactly that defect on first wiring).
3. **Fallback: demo brain + a plain-language banner.** WebGPU presence means `navigator.gpu.requestAdapter()` returns an adapter in a SECURE context — the API object alone lies (Playwright's bundled headless Chromium ships `navigator.gpu` and returns a null adapter; `about:blank` probes see no `gpu` at all). Absent or unresolved WebGPU falls back to the mock demo brain with the pinned banner "this browser can’t run local models — showing the demo brain". Fallback engages silently during the probe beat rather than racing the GPU.
4. **No tools in webllm mode.** In 0.2.84, `ChatCompletionRequest.tools` is hard-gated to five 8B-class Hermes models (≈4.9–6 GB VRAM — outside the small-model target) and its function-calling path throws on any custom system message while hijacking `response_format`. Snug's builder IS a custom system prompt. Webllm builder turns therefore run tool-free with a **fenced-HTML envelope**: the system suffix instructs one complete `\`\`\`html` document; `extractAppHtml` takes the LAST complete doctype→`</html>` document (fenced, or bare — small models forget fences) and writes it through the artifact sink. Blast radius: no KB-consult round trip, no `schema_apply`/`app_doc_write` (no native-schema apps from webllm builds), and the reply text still shows the code (queued 1.2 polish). The adapter REFUSES tool-carrying requests with a typed error rather than silently dropping them.
5. **Default model: `Qwen3-1.7B-q4f16_1-MLC` is rejected; `Llama-3.2-3B-Instruct-q4f16_1-MLC` is the default** (2.26 GB VRAM, 4 K context, ~1.7 GB download). Measured rationale below. Qwen3-family requests carry `extra_body: { enable_thinking: false }` if ever selected manually (a 4 K context building an app cannot afford think tokens) — the knob is pinned by tests but dormant under the Llama default.

## Measurements (2026-08-06, M-series Mac, Chrome headless via CDP-free Playwright `channel: 'chrome'`, persistent profile)

Method: the EXACT product turn shape — real `buildHostSystemPrompt({appBuilder: true, artifacts: false})` + the fenced-HTML suffix (990–993 prompt tokens on the wire), three app-build prompts (tip calculator / capitals quiz / pomodoro), judged by the real `extractAppHtml` plus a DOM parse of the extracted document. Engine-reported timings; full JSON in the task journal.

| Model | Load | TTFT | Decode | Apps extracted | Notes |
|---|---|---|---|---|---|
| Llama-3.2-1B-q4f16 | 74.7 s cold / **1.7 s warm** (browser cache) | 0.9–2.5 s | 55–65 tok/s | 3/3 but ALL THIN (373–672 B) | splits HTML/CSS/JS into separate fences — the extracted document loses the styles/logic; one run rambled 3 102 tokens |
| Qwen3-1.7B-q4f16, think OFF | 38.1 s cold | 1.3–2.6 s | 40–42 tok/s | **0/3** | answered every build with hallucinated `responseSchema` JSON — it latched onto the app-envelope layer of the system prompt; also leaked a literal empty `<think>` block into the reply text |
| Qwen3-1.7B-q4f16, think ON (fairness check) | warm | 1.6 s | ~40 tok/s | 1/1 (thin, 982 B) | CAN build when allowed to think — but spent 1 448 tokens and 61.5 s on one small app; unaffordable in a 4 K context |
| Llama-3.2-3B-q4f16 | 141 s cold (1.7 GB fetch) | 2.6–3.2 s | 23–26 tok/s | **3/3** (620–2 280 B, all DOM-parse clean) | complete single-fence documents, correct titles; ~30–56 s per build |

The decisive result is qualitative, not the tok/s column: on the REAL layered system prompt, Qwen3-1.7B without thinking cannot tell an envelope-tagged app request from a human build request (and with thinking it pays for the distinction in tokens the context does not have), while 1B-class models fragment the file. Llama-3.2-3B is the smallest tested model that reliably followed the one-fence contract with substantial output. The warm-load number (1.7 s) is the cold-start story for 1.2: the pain is once per device, not per session.

## Alternatives considered

- **Tools via Hermes-8B models.** Rejected: 5–6 GB VRAM excludes most consumer devices, and web-llm's Hermes tool path forbids the builder's system prompt outright.
- **Constrained-JSON envelope instead of fenced HTML.** Rejected: JSON-escaping an entire HTML document is precisely where 1–3B models break; one fenced block is the easiest reliably-produced structure.
- **A `webllm` member of `PlaygroundMode`.** Rejected for the spike: it would persist into user DBs and the settings surface before the mode has earned it; the flag override keeps the blast radius to one resolver.
- **Adapter in `packages/adapters` now.** Rejected: server imports the package; promotion is a 1.2 (GA) step once the mode is real.
- **Qwen3-1.7B / Qwen3.5 family default.** Rejected on measurement (0/3 above); revisit at GA when the picker ships and prompt shaping per-family becomes worth the work.
- **Smaller default (Llama-3.2-1B).** Rejected: fastest, but produces fragmented apps; "the demo built me a broken app" is worse than a bigger first download.

## Consequences

- The think panel, live round-trip timers, wire-model-name and cache-% surfaces work unchanged in webllm mode because the adapter is reached only through `runAgentTurn`; the usage carries NO cache fields (absent, never zero) per ADR-0012's reporting rules.
- The default model means a ~1.7 GB first-use download (browser-cached thereafter) and ≈2.3 GB GPU memory. Cold-start UX, a model picker, and cache management are explicitly 1.2 (roadmap 1.2-1); until then the shell banner + settings card carry the honesty.
- App-attached context blocks ride the system suffix into a 4 K context; a large app's code+docs will not fit. Queued in next-steps: measure and add a truncation rule before webllm chats attach to big apps.
- Real-model e2e cannot run in CI (download + WebGPU): the Playwright spec exists but is skip-by-default behind `SNUG_E2E_WEBLLM_REAL=1`; contract coverage rides the faked-engine unit suite (47 tests) and the WebGPU-absent fallback e2e.
