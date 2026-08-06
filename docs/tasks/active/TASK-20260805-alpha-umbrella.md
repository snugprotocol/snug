# TASK-20260805-alpha-umbrella: Alpha — "Stranger-ready + the auth port" (roadmap v2, A1–A15)

- **Status**: in-progress (owner approved 2026-08-05 Phase 0 — approval pre-approves child plans inside this umbrella)
- **Owner**: Jeetu (autonomous overnight run; Claude orchestrates)
- **Risk tier**: **high** (children touch `packages/protocol`, `packages/runner`, `packages/auth`, C1/C2 — auto-escalated; High children get fresh-context AI plan review before implementation)
- **Branch**: none for the umbrella (docs ride each child); children get `feat/TASK-<id>` off fresh `main`
- **Packages touched**: `protocol`, `auth` (new code), `runner`, `db`, `sdk`, `knowledge`, `adapters`, `apps/server`, `apps/playground`, `apps/desktop` (new), `apps/website` (new), `examples/*`, `spec` repo (per A12 decision)
- **Spec impact**: v0.3 auth/net **staged draft** in `docs/spec-drafts/` (A12b, SPEC_SYNC + spec-changelog); v0.1+v0.2-draft push to `snugprotocol/spec` per A12 owner decision
- **Related**: `internal/07-roadmap.md` v2 (source of scope) · `internal/03-audit-auth.md` (extraction map + 3 must-fix bugs) · `internal/LAUNCH_OPS.md` (A11) · ADR-0004/0007/0010/0011/0012 · umbrella pattern: TASK-20260731-build-hub

## Spec (what & why)

Deliver the complete **Alpha milestone** from `internal/07-roadmap.md` v2 (2026-08-05): everything required so the repos *could* flip public and beta invites go out — the Dynamic Auth local port (pure core → connected-fetch → inference/wizard → KB), the desktop scaffold, the WebLLM spike, the starter portfolio incl. the auth spectrum, security hardening, threat model v1, flip-public prep, spec staging/push, landing page, and first-run friction kill. Alpha is deliberately the heaviest milestone: the 1.0 launch is the wow, and the wow is built here.

**Umbrella acceptance criteria** (Alpha exit, from the roadmap):
1. Every child A1–A15 merged to `main` — or parked with a handoff note and listed in the morning report.
2. **Flip-public checklist executable**: every LAUNCH_OPS item either done or reduced to a scripted/runbook step (incl. the unresolved item-0 remote-object purge, staged not executed).
3. **Cold `git clone` → working app < 10 min**, verified by a timed scripted run.
4. **A connector starter (Weather Planner) completes its auth flow end-to-end in byok mode** — wizard → key into `snug_secrets` → connected-fetch with header injection → scrubbed response renders. Playwright-gated.
5. The three OProject audit bugs are named ACs in the auth children and provably fixed: (a) two-layer callback unwraps `userLayer`; (b) `handleCallback` receives `expectedSessionId` (binding check live); (c) strict host injection **always-on, not a flag**.
6. C1/C2 preserved and extended: iframe still has zero network; the host is the only fetch caller; negative tests cover the new `net` frame (credential-shaped headers from apps stripped/rejected; allowlist bypass attempts fail).
7. Root suites + full Playwright green after every child merge (baseline 906 vitest + 30 Playwright; counts re-recorded per merge).
8. Per-child definition of done (below) honored — including the live agent-browser sweep.

**Out of scope (hard)**: npm publish, playground deploy, flip-public — NEVER in this run. Broker/subscription custody (1.6→2.0). Signed/notarized installers (Beta). WebLLM GA polish (1.2). Kid Mode, wizard UX trials (Beta). Auth spec **publication** (A12b stages it; publication gated at Beta exit).

## Plan

### Child tasks (each gets its own task file + branch + Gate-2 plan; High children get fresh-context plan review pre-implementation)

| # | Child (task id suffix) | Roadmap | Tier | Depends on |
|---|---|---|---|---|
| AL-01 | `doctrines-devex` — ADR "hosted-hub-static" + ADR "local-first credentials" (A1); code-map test-count regen script (A15); queued fixes: `importUserDb`/`namespaceByFile` cache-coherence, `supportsCaching` exact-host match | A1, A15, A9-part | Med | — |
| AL-02 | `auth-core` — `packages/auth` pure core: auth-schema (Zod, protocol-grade seat decided per SPEC_SYNC) · well-known-providers (pinned registry) · template-engine · params-to-auth-spec · oauth-service (DI-pure, PKCE default, refresh/rotation/revoke, audit bugs 1+2 fixed) · local storage via `snug_secrets`; skill identity opaque, branded types dropped; iproject host-freeze model carried | A2 | **High** | AL-01 |
| AL-03 | `connected-fetch` — envelope `net` frame; host validates frozen per-app allowlist, injects from `snug_secrets` via header templates, scrubs responses (OProject scrubber), SSRF/private-range block, size caps, mutating-call confirmation gate; strict injection always-on (bug 3 fixed by construction); cross-app theft guard | A4 | **High** | AL-02 |
| AL-04 | `auth-wizard` — auth-spec-inferrer on the AgentTransport `complete(prompt)` seam; confidence gate <0.7 → forced confirmation; docs-fetch fallback ladder (pinned registry → web-capable BYOK → user-pasted docs → desktop-native fetch); render-directive contract standardized in `packages/protocol`; wizard/card/dialog **rebuilt** on playground components (not lifted) | A3 | **High** | AL-03 |
| AL-05 | `auth-kb` — knowledge layer: builder LLM declares `auth_required`, designs against connected-fetch, never places credentials in app code; per ADR-0004 store rules; **read the prompt-engineering reference first** (standing memory) | A5 | Med | AL-04 |
| AL-06 | ~~`desktop-scaffold` (A6)~~ — **DROPPED from this run by owner (Phase 0)**: picked up later in Alpha or during Beta. Consequences threaded: AL-04's docs-fetch ladder documents desktop-native fetch as a future rung; AL-09's Hue starter ships authored + greyed-on-web only (desktop verification deferred with A6) | A6 | — | — |
| AL-07 | `webllm-spike` — in-browser adapter behind a flag; graceful fallback to demo when WebGPU absent; model per Phase-0 decision | A7 | Med | — (parallel-safe) |
| AL-08 | `starters-pillars` — Adventure Quest, Quiz Me, Trivia Night, Family Trip Planner (single-user), Pocket Ledger; each = example + fixture + App Autopsy ("view the build conversation") | A8a | Med | — (parallel-safe) |
| AL-09 | `starters-auth-spectrum` — Crypto Portfolio (none/CoinGecko), Weather Planner (api_key), My Repos (PAT), Spotify Party DJ (oauth2 + BYO dev registration), Hue Lights Party (LAN, desktop-labeled; greyed on web with "why desktop" copy) | A8b | Med | AL-04 |
| AL-10 | `security-hardening` — envelope + auth/net-frame property & fuzz tests; dependency pin + audit CI; secrets-path review | A9 | **High** | AL-04 |
| AL-11 | `threat-model` — threat model v1 doc: prompt-injection posture + Dynamic Auth model (propose/approve/freeze, registry pinning, inference poisoning, connected-fetch exfiltration analysis) | A10 | Med (doc) | AL-10 |
| AL-12 | `spec-staging` — v0.3 auth/net draft staged in `docs/spec-drafts/` (AuthSpec, `auth_required`, render directive, net frame + allowlist semantics); spec-changelog entries; C3 unchanged | A12b | Med | AL-04 |
| AL-13 | `spec-push` — assemble v0.1 + v0.2-draft content for `snugprotocol/spec`; push 🔑 or stage on a branch per Phase-0 decision | A12 | Med | AL-01 |
| AL-14 | `flip-prep` — SECURITY.md, CONTRIBUTING, CoC, CODEOWNERS, issue/PR templates, 10 good-first-issues drafted, LAUNCH_OPS runbook items scripted (item-0 purge staged, internal/-strip staged per Phase-0 decision) | A11 | Low | — (parallel-safe) |
| AL-15 | `landing-first-run` — `apps/website` static landing (<100 KB, "we collect nothing", differentiators, desktop links); playground at `/app`; zero-key demo default; mobile Safari pass (WebKit Playwright); chips → first app < 2 min | A13, A14 | Med | AL-08 preferred |

### Sequencing

Serial merges on the critical path; independents interleaved when the path blocks or while reviews run:

1. **AL-01** (small, un-blocks caching/materializer surface) →
2. **Auth port spine: AL-02 → AL-03 → AL-04 → AL-05** (the milestone's heart; each High child: plan → fresh-context plan review → TDD → live sweep → adversarial review → merge)
3. Interleaved as capacity allows: **AL-14, AL-08, AL-07, AL-06** (order chosen so parked items can't block the spine)
4. **AL-09** (needs the wizard) → **AL-10 → AL-11 → AL-12 → AL-13** → **AL-15** last (sweeps the whole surface).

Parallel work uses subagents in **isolated worktrees** (lessons 2026-08-04); merges are strictly serialized; every shared literal (frame names, header names, flag names) is pinned in BOTH task files before fan-out (lessons 2026-08-03).

### Definition of done — EVERY child

(a) full root suites green; (b) Playwright suite green; (c) **live sweep** of the running playground via agent-browser exercising the affected flows as a real user — UI glitches, console errors, secrets in DOM/storage/logs, CSP violations, allowlist bypasses; launch-blockers fixed before close, non-blockers logged in next-steps; (d) **fresh-context adversarial review** with runnable probes before merge (bar: last merge's review found 6 real defects); (e) docs/ADR/lessons/next-steps updated in-branch; spec-changelog if protocol touched; (f) PR with real description → merge after AI review + green (owner pre-authorized for this run) → branch deleted → task file to `done/`.

### Stop conditions (the only reasons to wait for the owner)

Scope change to this approved umbrella · destructive or 🔑-gated action not pre-authorized in Phase 0 (npm publish / deploy / flip-public are NEVER in scope) · a security design fork that could bake in a wrong trust decision · all remaining children parked.

### Phase-0 preflight results (2026-08-05 evening)

- `gh` authed as `jeetumaker` (repo/workflow scopes); remotes: `snugprotocol/snug` + `snugprotocol/spec` (both private). Repo root verified (the workspace parent directory also holds the `spec/` clone).
- `main` up to date with origin; one pre-existing uncommitted change (`docs/next-steps.md`, 3 roadmap entries) — will ride AL-01's branch.
- Baseline green: install + build + root `pnpm test` (906) and playground Playwright (30) all pass, exit 0.
- Playwright: chromium present; **webkit installed during preflight** (for the A14 mobile pass).
- Source trees: OProject — all audited auth paths present on `main` in both source repos ✅. IProject — auth material is **NOT on `main`**; it lives on the currently checked-out auth working tree (extraction reads that tree; tree/branch names live only in `internal/.env.local` per C4/C5, whose notes stand corrected for OProject only).
- Toolchain gaps: rust 1.76 (too old for Tauri 2 — needs `rustup update`); Ollama not installed; no LLM API key on hand for live BYOK sweeps. → Phase-0 questions.
- LAUNCH_OPS item 0 (purge pre-scrub objects on the GitHub remote) remains unresolved — staged in AL-14's runbook, NOT executed (repo stays private this run).

### Phase-0 owner decisions (2026-08-05)

1. **Scope freeze:** A1–A15 confirmed **except A6 (desktop scaffold) — dropped from this run**, to be picked up later in Alpha or during Beta. Hue starter ships authored + greyed-on-web; desktop-native fetch documented as a future ladder rung.
2. **A12 spec push: AUTHORIZED** — push v0.1 + v0.2-draft to `snugprotocol/spec` (private) this run; auth content excluded; journal the push (UTC + verification).
3. **WebLLM model:** the spike benchmarks current small models and decides; rationale recorded in the child journal/ADR.
4. **Credentials:** owner supplied a live Anthropic-or-OpenAI key locally (gitignored; never committed) → live sweeps run REAL byok mode. No OpenWeather/PAT keys → connector starters verify against local stub providers / recorded fixtures through the real wizard+injection+scrub path; real-API verification queued in next-steps.
5. **A11 depth: prep-only** — files + real good-first-issues on the private repo; internal/-strip, branch protection, and the item-0 purge staged as an executable runbook, not executed.
6. **Umbrella approved** — "Approved — run autonomously"; merge-on-green pre-authorized; owner reviews the merged set in the morning.

## Decisions & surprises

- IProject extraction baseline corrected: the currently checked-out auth working tree (named in `internal/.env.local`), not `main` (verified 2026-08-05; audit paths absent on IProject `main`).

## Session journal (append-only, newest last)

### 2026-08-05 23:xx — Claude (Fable 5) — Phase 0
- Done: Gate-2 reads (roadmap v2, auth audit, LAUNCH_OPS, lessons, next-steps, architecture, code-map, .env.local); preflight all green (see above); umbrella drafted.
- State: awaiting owner's batched Phase-0 answers + plan approval.
- Next step: record answers, spawn AL-01.
