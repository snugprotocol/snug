# TASK-20260731-build-hub: Build the Snug v1 hub — all packages, playground, central prompt architecture

- **Status**: done
- **Owner**: Jeetu
- **Risk tier**: **high** (touches `packages/protocol` schemas, `packages/runner` sandbox/CSP, C1/C2 — auto-escalated per PROCESS.md)
- **Branch**: `feat/TASK-20260731-build-hub` (umbrella — docs/plan only; children get their own `feat/TASK-<id>` branches)
- **Packages touched**: `protocol`, `runner`, `sdk`, `db`, `knowledge`, `adapters`, `apps/server`, `apps/playground`, `examples/*`
- **Spec impact**: spec v0.1 planned (first publication — → [SPEC_SYNC.md](../../engineering/SPEC_SYNC.md); spec push needs explicit human ask)
- **Related**: ADR-0001..0003 · `internal/00`–`03` audits · next-steps "Week 1–4" items · workflow run `wf_c0550527-162` (source-tree prompt/UI survey)

## Spec (what & why)

Build the entire Snug v1 reference implementation ("the hub") as a production-grade monorepo from which later phases (evals, auth v1.1, spec publication) can be driven. Source material is extracted directly from the two prior production systems (OProject/IProject — see `internal/.env.local`; IP clearance recorded 2026-07-31). Three pillars:

1. **The packages + server + playground** per ADR-0003 v1 scope: `protocol` (envelope zod schemas + JSON Schema export), `runner` (sandboxed iframe + bridge host, C2 locked by tests), `sdk` (`useAgentBridge`, `usePersistedState`, `useAppDB`), `db` (new build: sql.js + OPFS + `.sqlite` export/import), `knowledge` (LLM app-authoring KB), `adapters` (anthropic/openai/mock), `apps/server` (/invoke SSE + artifact store), `apps/playground` (hosted demo: chat → build → run), `examples/` (chess, flying-pig, habit-tracker).
2. **Central prompt architecture** — every prompt in the system (system, agent, category, tool, response-format, knowledge-base, skill, tenant/user template) lives in ONE organized location in this repo, layered folders + self-describing file headers (layer, destination, blast radius). Non-tenant prompts move into the codebase verbatim; tenant/user-specific prompts become templates with injection points, tenant data stays out of the repo. Git is the versioning/rollback story. Designed so the eval harness (next phase) can address any prompt by path.
3. **Skill-creator reuse** — port the skill-authoring skill (IProject `assets/skill-creator` + `skill-builder-prompt`) into the central prompt/skill location, genericized for Snug.

Playground UI/UX is a first-class deliverable: benchmark-setting, intuitive enough that a SaaS PM or frontier-lab reviewer "gets it" in one session, and an end user can build a micro-app immediately. Not template-grade AI slop.

**Acceptance criteria** (each becomes at least one test):
1. `pnpm test` green at root: every package has a real test suite (touched + dependents per the graph).
2. **C2 negative tests:** runner iframe renders with `sandbox="allow-scripts"` only; adding `allow-same-origin` fails the suite; CSP blocks `connect-src`; CDN allowlist is fixed and asserted.
3. **C1 negative tests:** an app envelope carrying an `Authorization` (or any credential-shaped) header is stripped/rejected before reaching the adapter; LLM-bound payloads contain no credential material.
4. **Protocol:** all envelope messages validated by zod schemas; JSON Schemas exported to `packages/protocol/schemas/` byte-stable; `auth_required` message reserved; round-trip encode/parse property tests.
5. **DB:** create → exec SQL → persist (OPFS, IndexedDB fallback in tests) → `export()` produces a valid SQLite file → `import()` restores state — full round-trip test.
6. **Prompt centralization:** a repo-level test/lint walks the codebase and fails if any LLM-bound prompt string lives outside the central prompt location; every prompt file carries the required header (layer, destination, impact); assembly order is exercised by a "golden prompt" snapshot test per pipeline.
7. **Playground E2E (mock adapter):** chat "build me a tic-tac-toe" → artifact generated → runs in sandboxed runner → bridge round-trip (app asks agent, agent replies, app renders) — one Playwright test; works with bring-your-own-API-key entry for real providers.
8. **Skill-creator:** ported skill loads through the knowledge/skills path and its prompt files live in the central location; covered by the centralization test.
9. **Quickstart:** documented `git clone` → running playground in <10 min; a smoke script (`pnpm smoke`) proves the happy path headlessly.

**Out of scope**: `packages/auth` broker implementation (v1.1 — protocol only *reserves* `auth_required`); hub pin/share/install features; npm publish, playground deploy, spec-repo push, repo-public flip (each needs an explicit ask); eval harness (next phase — but prompt layout must anticipate it); non-JS SDKs.

## Plan

> Inputs: `internal/02`/`03` audits + the 2026-07-31 survey workflow (`wf_c0550527-162`; full results in `internal/05-prompt-ui-survey.md` — 80 prompt artifacts, both assembly pipelines, skill-creator flows, 18 UI flows, 15 gap findings). This umbrella plan is approved once; each child task then writes its own detailed Gate 2 plan (files, tests-first, ADR refs) before its implementation — High-tier children additionally get a fresh-context AI plan review.

### P0 — Load-bearing survey corrections (bind all children)

1. **Extraction baseline is `main` in both source trees, not the feature branches.** OProject's feature branch is fully merged and `main` evolved a month past it (incl. an externalized 15-file system-prompt template directory — the closest ancestor of our design); IProject's native-app material is merged to `origin/main` too. All extraction reads: `git show origin/main:<path>` (fallback to the feature branches only for material dropped on merge, e.g. the create-mode "Native App Detection" interview that only exists in OProject's skill-builder).
2. **Prompt wording is security-load-bearing in IProject**: the output scrubber anchors leak-detection n-grams on the guardrail preamble's first line and sealed recipe body, with a red-team test bank asserting exact wording + calibration corpora. Any prompt we port that participates in scrubbing moves **with** its scrubber/tests as one unit, or we consciously drop both (v1 has no marketplace recipes, so the sealed-recipe/scrubber pair is v1.1+ — but the layering pattern is adopted now).
3. **The envelope tag is a 4-way unshared literal** in both trees (client components, route prefix-match, KB text, response-format prompt). In Snug it becomes ONE constant in `packages/protocol`, template-injected into prompt files — never retyped.
4. **The KB's `##`/`###` heading structure is retrieval-load-bearing** (section-splitter + keyword scorer parse headings). Port markdown structure byte-faithfully; restructuring is a behavior change requiring its own tests.
5. **Skill-creator**: adopt IProject's vendored, commit-pinned posture (with Apache-2.0 `LICENSE.txt` + `NOTICE.md` carried) — never OProject's boot-time GitHub fetch. OProject has the only fully-wired authoring flow (session → per-turn prompt reassembly → scoped workspace tools → finalize tool) — that's the wiring reference; IProject's prompt layer is the content reference (its assembler has zero production callers).
6. **C2 correction confirmed**: OProject's in-chat preview uses `allow-same-origin` + no CSP (defeats the sandbox); IProject's standalone runner (`allow-scripts` only + per-route CSP + source-identity check) is the only acceptable base. Snug requires fully self-contained HTML (inline assets / data: URIs) and drops `unsafe-inline`+CDN CSP if feasible — decided in the runner child task with negative tests either way.

### P1 — Central prompt architecture (`packages/knowledge/prompts/`)

One git-versioned store, layered folders mirroring assembly order. Every file starts with a mandatory HTML-comment header: `layer`, `destination` (which pipeline stage injects it, gated on what), `blast-radius` (what output changes when you edit it), `source` (provenance). Layout:

```
packages/knowledge/prompts/
├── README.md                 # the map: layers, assembly order diagram, edit-safely guide
├── system/                   # host-side system-prompt layers, numbered by assembly order
│   ├── 10-host-identity.md         # lean base persona for the reference server/playground
│   ├── 20-capability-file-creation.md   # gated: only when artifact tools enabled
│   ├── 30-app-builder-summary.md        # gated KB summary (progressive disclosure, ~600 chars)
│   └── 40-app-response-format.md        # JSON-only rule for {{envelopeTag}} turns — protocol-coupled
├── knowledge-base/
│   └── app-authoring/        # the full KB as sectioned .md (## structure preserved); served via
│       └── ...               #   the section-search knowledge tool, not the system prompt
├── tools/                    # tool-description registry: one .md per tool name fed to the LLM
├── skills/
│   ├── skill-creator/        # vendored Anthropic methodology (verbatim + LICENSE + NOTICE, pinned)
│   ├── builder-preamble.md   # authoring-session preamble (merged: IProject dedup discipline +
│   ├── modes/{create,edit,improve,eval,optimize-description}.md   #  OProject app-detection interview)
├── templates/                # tenant/user-layer TEMPLATES only — {{placeholder}} injection points;
│   └── user-identity.md      #   instance data (user files, per-app state) NEVER enters the repo
└── ui/                       # user-message templates composed by clients (suggestion chips, build-app prompt)
```

Enforcement (this is what makes it stick):
- **Typed loader + manifest** in `packages/knowledge/src`: each layer a typed export (honoring IProject's recorded anti-generic-loader doctrine — the store centralizes *content*, the API stays typed per-layer); assembly order encoded once; `{{envelopeTag}}`-class variables injected from `packages/protocol` constants at load.
- **Centralization lint** (repo-level test): fails on LLM-bound string literals outside the store, and on any prompt file missing the header (AC-6).
- **Golden assembly snapshots**: one per pipeline (host chat, app envelope turn, skill-authoring session) so any prompt edit shows its exact blast radius in the diff — the eval harness (next phase) plugs in here, addressing prompts by stable file path.
- Tenant/user instances stay runtime data (per-user files/DB) rendered *through* repo templates — reproducing the source systems' template→instance seeding pattern without their S3-as-source-of-truth drift.

### P2 — Child tasks (each: own task file, branch, tests-first, PR; sequenced by dependency graph)

| # | Child task | Scope (tier) | Key extractions / builds |
|---|---|---|---|
| 1 | `protocol-core` | `packages/protocol` (**High**) | Envelope zod schemas (app_request/response, error-as-data set: PARSE_FAILED w/ excerpt+attempts, THREAD_CONFLICT, NETWORK_ERROR; announce handshake; render directives; reserved `auth_required`), the single envelope-tag + message-type constants, JSON Schema export, version field. Spec v0.1 draft prose. |
| 2 | `knowledge-store` | `packages/knowledge` (Medium) | P1 store + loaders + lint + goldens; port KB from IProject@main (diff vs OProject for dropped content), rebrand + strip CDN-version table into a maintained data section; vendored skill-creator; merged builder preamble/modes. |
| 3 | `runner-sandbox` | `packages/runner` (**High**) | IProject runner port: `allow-scripts`-only iframe, CSP, source-identity check, targetOrigin rationale doc, parse budget (per-thread, fixing their per-mount bug), bounded retry/backoff, error-as-data into iframe, announce→capability-reveal handshake. C1/C2 negative tests first. |
| 4 | `sdk-db` | `packages/sdk`, `packages/db` (Medium) | `useAgentBridge` (executionId correlation + streaming frames), `usePersistedState`, new-build `useAppDB` (sql.js + OPFS + IndexedDB fallback, `.sqlite` export/import round-trip); KB sections teaching schema/SQL live in the store (child 2 leaves stubs). |
| 5 | `server-adapters` | `apps/server`, `packages/adapters` (Medium) | Fastify `/invoke` + SSE (port IProject's SSE state machine: stale-run guard, STREAM_DROPPED synthesis, heartbeat-tolerant parser), artifact store (fs/SQLite, 5MB gate), anthropic/openai/mock adapters, server-side prompt assembly via knowledge loaders, C1 header-strip at the envelope boundary. |
| 6 | `playground-hub` | `apps/playground`, `examples/` (Medium) | The hub: Vite+React SPA, BYOK. Flows: build-in-chat → announce → pin → hub → run → share/install. Design brief below. Examples: chess, flying-pig (import from existing public repo), habit-tracker (shows `.sqlite` export). Playwright E2E vs mock adapter (AC-7). |

Cross-package rule: children 3–6 consume only published intra-repo APIs of earlier children; protocol changes discovered downstream loop back through child 1 (High, spec-sync).

### P3 — Playground design brief (the "not another AI-generated app" bar)

Carry-forward (survey-verified winners): self-describing app announce handshake driving capability-reveal UI; pin-as-stable-resolver (`/open` returns HTML inline — no expiring URLs); per-app persistent thread = durable app memory; side-by-side **Inspector** (watch the agent think while using the app — the single best demo affordance for LLM-lab audiences; structural payloads only, never prompt text); animated share/install checklist with "you own your copy" semantics + install-lands-in-the-running-app; suggestion chips composing through one templated prompt (from `prompts/ui/`); run-rail vs library separation; autogrow composer, `/` shortcut, skeletons everywhere. Explicit AVOID list from survey: hover-only actions, `window.confirm`, three duplicated preview implementations, prompt text in components, parse budget in volatile state.
Identity: distinctive hand-tuned visual system (no stock component-library look), dark-first with real light theme, the flying-pig/chess demo 30 seconds from landing ("it thinks through YOUR model" moment made visible — show the envelope traffic live in the Inspector). Mobile Safari is a launch gate. Detailed design doc lands in child 6's task file.

### P4 — Test plan (tests FIRST per TDD.md; AC → suite mapping)

AC-1 root `pnpm test` (turbo graph) · AC-2/3 negative suites in runner + server (written before the features; sandbox attribute assertion, `allow-same-origin` CI failure, CSP connect-src, credential-header strip, LLM-payload credential scan) · AC-4 protocol round-trip property tests + schema snapshot · AC-5 db round-trip incl. exported-file magic-bytes/SQLite-header validation · AC-6 centralization lint + header check + golden assembly snapshots · AC-7 Playwright chat→build→run→bridge round-trip on mock adapter · AC-8 skill-creator load-path test + lint coverage · AC-9 `pnpm smoke` headless happy-path + timed quickstart doc.

### P5 — Spec-sync & docs impact

Child 1 produces spec v0.1 draft (SPEC.md prose + schemas) staged in this repo; **no push to the spec repo without an explicit ask** (release rule). `docs/architecture.md` + `code-map.md` updated per child at Gate 6; ADR-0004 (central prompt store) and ADR-0005 (Vite playground) drafted now with this plan; spec-changelog entry when child 1 merges.

### Risks

(a) Mega-scope creep — mitigated by child sequencing; umbrella tracks only integration AC. (b) Prompt/scrubber coupling if v1.1 marketplace lands later — the store's README records invariant #2 now. (c) KB CDN-version bit-rot — moved to a data file with a pinned-version test. (d) OPFS/Safari — db child spikes OPFS-in-Safari first; IndexedDB fallback is load-bearing, not optional. (e) Envelope divergence from source systems is deliberate (this is the spec now) — protocol child documents deltas from both ancestors.

## Decisions & surprises

- 2026-07-31 **interview (owner-approved)**: (a) **umbrella + child tasks** — this file is the umbrella; each phase gets a child task file + branch + PR; (b) **central prompt location = `packages/knowledge/prompts/**`** (publishes with the package, typed loaders, eval-addressable; README points at it); (c) **Playground = Vite + React SPA** (BYOK static, supersedes internal/01 §5 "Next.js" — record as ADR); (d) **auth stays v1.1** — protocol reserves `auth_required`; Playground ships an inert "Connect account" teaser only.
- 2026-07-31: IP clearance already recorded (internal/00 §OPEN DECISIONS) — direct extraction permitted, no clean-room constraint.
- Source repos sit on different branches than the material (guardian repos on `main`, indranet on `feat/skill-auth-two-layer`); all extraction reads use `git show <branch>:<path>` — never checkout/switch in the source trees.

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: Gate 1 spec + owner interview (umbrella/children, prompt store location, Vite, auth v1.1). Survey workflow `wf_c0550527-162` completed (6 agents, 635k tokens): 80 prompt artifacts, both assembly pipelines, skill-creator flows, 18 UI flows, 15 gaps → digest preserved at `internal/05-prompt-ui-survey.md`. Gate 2 plan written above (P0 corrections, prompt-store architecture, 6 child tasks, design brief, test plan, spec impact). ADR-0004/0005 drafted. Branch created.
- State: **STOPPED at Gate 2 for owner plan approval.** No implementation code written.
- Next step (post-approval): open child task 1 (`protocol-core`, High — plan gets fresh-context AI review before implementation), then children 2–6 in sequence.
- Open questions: none blocking — CSP posture (self-contained-HTML vs CDN allowlist) decided inside the runner child with negative tests either way.

### 2026-07-31 — Claude (Fable 5) — build + close (owner approved plan in-session)
- Done: all six children specced, fresh-context-reviewed (High tier), implemented tests-first, adversarially reviewed, fixed, and merged: protocol-core (85) → knowledge-store (55) → runner-sandbox (90→91) → sdk-db (37+33) → server-adapters (56+32) → playground-hub (36 unit + 23 Playwright + 18 example checks). Root: 19/19 turbo tasks green; `pnpm smoke` PASS; Playwright C2 gate 15/15 CSP checks on the production runner in real Chromium.
- Umbrella ACs: 1✅(root green) 2✅(sandbox/CSP negatives + real-browser gate) 3✅(C1 strip + whole-envelope scan + review-verified) 4✅(schemas exported, byte-stable, auth_required reserved) 5✅(.sqlite round-trip + DB-Browser-verified magic) 6✅(centralization lint + headers + goldens) 7✅(build→run→bridge E2E on mock) 8✅(vendored skill-creator + builder prompts in store) 9✅(README quickstart + root `pnpm smoke` PASS).
- Reviews caught pre-merge: schemas contradicting R2 (io:'input'), C1 responseSchema leak, KB db-field nesting bug, meta-CSP parse-order bypass design flaw, sendBeacon polarity, StrictMode dev blank-iframe. Lessons recorded.
- Deferred (recorded in next-steps): spec push (explicit ask), eval harness (phase 2), auth v1.1, demo videos/private beta (weeks 5–6), deploy (explicit ask).
