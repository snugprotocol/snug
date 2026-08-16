# TASK-20260815-starter-portfolio-revamp: Dynamic provider-API chat + inline UI cards + starter portfolio rebuild (UMBRELLA)

- **Status**: draft (plan written — awaiting owner approval; no implementation started)
- **Owner**: Jeetu
- **Risk tier**: high (child A touches `packages/protocol` chat-intent + prompts that drive credentialed calls; tiers per child below)
- **Branch**: `feat/TASK-20260815-starter-portfolio-revamp` (umbrella: task files + draft ADR only; each child implements on its own branch)
- **Packages touched**: (across children) `packages/protocol`, `packages/knowledge`, `apps/playground`, `apps/desktop` (via alias), `packages/sdk` (KB docs only unless B opts in), `examples/`
- **Spec impact**: none published — `chat-intent.ts` additions stay internal-draft exactly like ADR-0019 (wire v1 unchanged, nothing in `schemas/`); no spec push
- **Related**: ADR-0016/0017/0019/0022/0026/0028/0030 · draft **ADR-0031** (in this branch) · next-steps items: subscription-twins gap (2026-08-11), turbo `inputs` gap (2026-08-06/07), real-provider verification gap (2026-08-08), `http request` KB teaching note (2026-08-07)
- **Children**: [TASK-20260815-provider-chat-lane](TASK-20260815-provider-chat-lane.md) (A) → [TASK-20260815-inline-cards](TASK-20260815-inline-cards.md) (B) → [TASK-20260815-starter-apps-rebuild](TASK-20260815-starter-apps-rebuild.md) (C)

## Spec (what & why)

Rebuild the starter-app portfolio around high-value, low-friction, connected apps that
*complement* their provider's own app — and give every Snug app (starter or user-authored)
two new platform capabilities the portfolio showcases:

**A — Dynamic provider-API chat (the third route).** Today a chat message beside an
installed app classifies into 6 intents / 4 lanes (ADR-0019): data questions run
LLM-authored SQL on a scratch copy of the app's own DB. Add a **provider lane**: for an
app with an approved connection, the LLM formulates the concrete HTTP request(s)
(method + `snug-connection://<slot>/<path>` + body) and the hub executes them through the
**same connected-fetch executor the app runtime uses** — every one of its ten gates
unchanged: frozen host ceiling, SSRF guard, mutating-method confirm gate, host-side
credential injection, response scrub, redirect block, size caps. Reads answer in chat;
writes ride the executor's existing confirm gate (owner decision 2026-08-15: **no new
approval doctrine** — read/write/execute is allowed; sandbox + bridge + executor gates are
the wall). Taught in the KB so every authored app inherits it.

**B — Dynamic inline UI cards.** A hub-client capability: when an LLM turn needs to ask a
question / offer choices / propose an action, it emits a structured card that renders
inline in the chat rail (generalizing the ADR-0019 write-proposal card), and the user's
selection flows back as a structured turn input. The provider lane's write-confirm surface
becomes a card (host + method + URL named, as the executor's gate requires). No new
protocol frames: cards are host UI + a host tool.

**C — Portfolio rebuild.** Remove connection-demo, crypto-portfolio, habit-tracker,
spotify-party-dj, trip-planner, my-repos, hue-lights-party, pocket-ledger **and
weather-planner** (superseded by the new weather app — owner interview 2026-08-15).
Keep chess, flying-pig, adventure-quest, quiz-me, trivia-night. Add five gold-standard
starters (Apple-grade UI/UX, complementary-not-clone, full API surface):
**trade-copilot** (copied from the owner's `~/Snug/user.sqlite` "Coinbase Trade Copilot"
as baseline, then extended — e.g. TWAP-style smart order orchestration), **spotify**
(listening analytics + natural-language queries), **hue** (benchmark control UI + LLM
match/search actions), **weather** (OpenWeather), **github**. Final shelf: 10 apps.

**Owner decisions captured at interview (2026-08-15):**
1. The standing "crypto starters read-only forever" decision is **removed**. Starter and
   user-authored apps may hold read/write/execute access via authenticated APIs and DB
   calls; the invariants are the sandbox (C2), the bridge, and the executor's gates (C1).
   Recorded in draft ADR-0031; memory updated.
2. No new write-approval doctrine for provider APIs — the executor's existing
   session-rememberable mutating-method confirm gate is the control (its chat surface
   becomes an inline card in B). ADR-0019's DB propose→approve lane is untouched.
3. New weather replaces weather-planner; adventure-quest, quiz-me, trivia-night stay.
4. Structure: three sequenced child tasks/PRs (A → B → C), this file is the umbrella.

**Acceptance criteria**: live in the child task files (each criterion becomes a test there).

**Out of scope (all children):** subscription-mode server twins for the new lane/tools
(recorded gap family, 2026-08-11 — new lane is byok/local like the existing router);
Windows D8; held AL-10/11/12/15 items; live-provider hardware verification (owner-run,
tracked in next-steps); any push to `snugprotocol/spec`; auth broker.

## Plan

**Sequencing and why:** A first (platform seam the apps build on), B second (card surface
that A's confirm gate and C's apps consume), C last (apps exercise both). Each child
branches off `main` after its predecessor merges. Child plans (files, order, tests-first,
cross-package impact) live in the child task files; this umbrella holds the shared frame:

- **Cross-package impact (dependency graph):** A touches `protocol` → run everything
  (root `turbo run test --force`). B touches playground (+ knowledge); C touches
  `examples` + playground shelf. Desktop consumes playground source via alias — run
  `pnpm --filter desktop test` on A/B/C.
- **Shared literals pinned now** (lessons 2026-08-03): intents `provider_read`,
  `provider_write`; lane `'provider'`; tool name `provider_request`; card tool
  `present_card`; example folders `trade-copilot`, `spotify`, `hue`, `weather`, `github`;
  connection slots `coinbase`, `spotify`, `hue`, `openweather`, `github`.
- **High-tier rule:** A's plan gets a fresh-context AI review **before** implementation
  (PROCESS.md). Negative tests for C1/C2 in A and B (credentials never in LLM-visible
  context; no sandbox/CSP change anywhere).
- **Prompt work rule:** read `packages/knowledge/prompts/README.md` + the Anthropic
  prompt-engineering reference before authoring any prompt (A, B, C all touch prompts).
- **Turbo caveat** (next-steps 2026-08-06/07): `turbo.json` declares no `inputs`; on any
  `packages/sdk/embedded/**` or prompt-store edit, force-run the affected suites.
- **Spec-sync:** chat-intent additions mirror ADR-0019's posture — internal draft, wire
  v1 unchanged, no `schemas/` change, no spec push. If any child finds it needs a real
  frame/schema change it STOPS and re-plans (auto-High, SPEC_SYNC.md).

**ADR:** draft ADR-0031 (this branch) records the posture reset + the provider lane + the
card surface. Status `proposed` until A merges.

## Decisions & surprises

- 2026-08-15: Conflict between the brief's Coinbase TWAP execution and the standing
  "crypto read-only" owner decision — resolved at interview: decision removed (ADR-0031).
- 2026-08-15: Exploration corrected the brief's framing: the classifier is already
  6-intent/4-lane, so this is "add a lane", not "2-way → 3-way".
- 2026-08-15: The executor is host-granular, not endpoint-granular — the provider lane
  needs **zero** `packages/auth` changes; C1 holds by construction (executor is the only
  credential reader; scrubbed responses are what the LLM sees).

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: Gate 1+2. Interviewed owner (4 answers captured above). Mapped: intent router
  (chat-intent.ts / chatRouter.ts / useBuilderChat.ts / intentContext.ts / dataTools.ts),
  connected-fetch executor gates, starter pipeline (starterApps.ts glob / STARTER_LOOKS /
  validate suite / manifest suite), desktop DB (`~/Snug/user.sqlite`, "Coinbase Trade
  Copilot" app_id ef7c383a…, slot `coinbase`, ADR-0030 field shape, v1 HTML 52,838 B,
  runtime contract present). Wrote umbrella + three child task files; drafted ADR-0031;
  updated memory (crypto read-only decision removed).
- State: **STOPPED at Gate 2 — awaiting owner plan approval.** No implementation code.
- Next step: on approval → child A (`/pickup TASK-20260815-provider-chat-lane`), Gate 3
  tests first, fresh-context plan review before implementation.
- Open questions: none blocking; B's "in-app card" surface deliberately scoped to a KB
  pattern (no new frame) — revisit only if a real app proves the need.
