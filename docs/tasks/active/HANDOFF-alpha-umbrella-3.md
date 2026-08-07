# HANDOFF #3 — Alpha umbrella (TASK-20260805-alpha-umbrella) — resume point

**Written:** 2026-08-06, at a planned context-window boundary (60% rule — owner instruction: save state + fresh session, never compress mid-session). **Purpose:** a fresh session picks up with zero loss. Read this, then `docs/tasks/active/TASK-20260805-alpha-umbrella.md` (umbrella plan of record), then act on "IMMEDIATE NEXT ACTION". Supersedes `docs/tasks/done/HANDOFF-alpha-umbrella-2.md` (spent).

## One-paragraph situation

**8 of 14 children merged/done** (AL-01 #5, AL-02 #6, AL-03 #21, **AL-04 #22**, AL-07 #20, AL-08 #7, AL-13 #8, AL-14 #19; A6 dropped in Phase 0). **AL-04 (auth-wizard) MERGED 2026-08-06 via PR #22 → main @ `caaeb97`**, after the complete rigor loop: FIX_FIRST review (1 blocker + 3 majors + 9 rows) → ALL 13 items fixed test-first (mutation rows M31–M46) → fresh-context delta re-review over `f6c3721..24556a7` returned CLEAN (15/15 VERIFIED_FIXED, independently executed repros; 3 surviving MINORs closed on-branch, incl. mutation M47) → merge gate green → post-merge root suite on main green (19/19). Tail remaining, in order: **AL-05 (NEXT), AL-09, AL-10, AL-11, AL-12, AL-15 (LAST)**. Merge-on-green remains pre-authorized (Phase-0).

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ `caaeb97` — green baseline (post-AL-04 merge; root 19/19; playground vitest 400; full Playwright 53 + 1 skip; typecheck clean).
- **`feat/TASK-20260806-auth-kb` — THIS branch (freshly cut off `caaeb97`), carries only housekeeping: AL-04 task file (status flipped to done) + HANDOFF #2 + `AL-04-review-verdict.json` moved to `done/`, umbrella journal entry, this handoff.** AL-05's real work starts here with Gate 2.
- `feat/TASK-20260806-auth-wizard` — DELETED (local + remote) after the PR #22 merge.
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0).
- No stale worktrees. Task files of all merged children are in `done/`.

## IMMEDIATE NEXT ACTION — AL-05 `auth-kb` (Med tier)

Knowledge-layer child: teach the builder LLM to declare `auth_required` and design against connected-fetch, never placing credentials in app code (umbrella row AL-05 / roadmap A5, per ADR-0004 store rules). Its former blocker is **CLEARED**: the subscription-mode inference guard landed in AL-04's fix pass (`0f5c5ad` — a real inference can never run on the mock demo brain).

Gate order (Med tier): `/start-task`-style Gate 2 plan in a new `docs/tasks/active/TASK-20260806-auth-kb.md` (this branch already exists for it) → plan review optional at Med (orchestrator's call; the AL-04 precedent says even Med-adjacent LLM-prompt work benefits) → TDD → live sweep → fresh-context adversarial review → merge.

**Binding forward constraints for AL-05 (from AL-04's task file §Forward constraints — copy into the new task file at creation):**
- Teach `auth_required` declaration + the directive contract as SHIPPED (`renderDirectiveSchema`, `packages/protocol/src/render-directive.ts`) — builder copy never retypes the literals.
- The directive is a DOORBELL, not an authority (B2): hints are advisory; the host re-runs the ladder at wizard open and computes provenance itself. Teach the builder to emit **provider names, not endpoint values**, for famous providers.
- **Read the Anthropic prompt-engineering reference BEFORE authoring any prompt/KB text** (standing memory instruction).
- LLM-facing proposal shapes exclude `fields[]`/registration/headerTemplate (`llmProposalSchema` omit-set, extended in the fix pass) — KB copy must not teach the builder to emit them.
- Sweep non-blocker to fold (next-steps, dated 2026-08-06): the D8 inference prompt over-includes documented hosts (returned all 3 base hosts at conf 0.85 where a cautious user wants production-only) — prompt-side bias toward the primary host, never a schema change.
- The `?demoauth` demo-brain e2e seam (`apps/playground/src/agent/demoAuth.ts`) is a TEST seam — AL-05 owns the real builder teaching and may retire or formalize it.
- Keyed-subscription inference disclosure (next-steps row): a subscription user WITH a stored BYOK key gets a browser-direct wire while the copy says "your configured model" — either a server twin for the inference turn or honest copy; AL-05/AL-10 seat, decide during Gate 2.

## Then: the tail (in order)

1. **AL-09 starters-auth-spectrum** (Med) — 5 auth-category starters; Hue authored + greyed-on-web (A6 dropped); Spotify wizard walkthrough polish goes in the registry `registration` block, not component copy; Weather Planner e2e re-runs AC11's api_key flow against the starter.
2. **AL-10 security-hardening** (High — full rigor loop incl. pre-implementation plan review). Queued inheritances (see `docs/next-steps.md` dated rows): grant bookkeeping + `ConnectedFetchDeps.clock` seat (N6), structured `NET_AUTH_FAILED` sub-code candidate, turbo-inputs fix (`packages/sdk/embedded/**` into the examples task inputs), fuzz/property tests over envelope + auth/net frames + directive schemas (poisoned-docs fixtures now SIX incl. `inferrer.poison-fields`), dep-pin/audit CI, settings key-echo fix, **tripwire URL-borne-secret patterns** (delta re-review row: webhook paths, `sig=`, `X-Amz-Signature=` — pattern additions, not heuristic changes), bounds remainder (`kindHint`, `z.url()` slots), `HostCapabilities.net` drift.
3. **AL-11 threat-model** (Med, doc; needs AL-10) — AL-03's boundaries + AL-04's notes: docsText-to-BYOK-wire C1 tension (accepted-by-design, must be STATED), inference-poisoning posture (prompt rules weakest layer; registry-at-both-mounts + fail-closed transformer + forced spec_confirm + B1 ordering are the walls), confidence = COPY GRADING ONLY, popup-blocker class invisible to headless CI.
4. **AL-12 spec-staging** (Med) — v0.3 auth/net draft in `docs/spec-drafts/` (AuthSpec, `auth_required`, render directive incl. the fix-pass shape changes — `fields`/`userLayerFields` out of `llmProposalSchema`, length bounds; net frame semantics); C3/SPEC_SYNC.
5. **AL-15 landing-first-run LAST** — sweeps the whole surface; then **/close-session (Gate 6) + morning report** (required contents in umbrella task file).

## Standing process (unchanged — this is why the run is clean)

- Every child: branch off fresh main → TDD, never weaken a failing test → full root suites + Playwright + live agent-browser sweep (FRESH servers — stale servers bit AL-03's sweep AND left a port-8787 squatter found this session) + fresh-context adversarial review before merge → fold → merge serialized → branch deleted → task file to done/.
- High children get a fresh-context PLAN review before implementation. Mutation-check every guard; commit before mutating. C4/C5: codenames OProject/IProject only; key in `internal/.env.local` never in tracked files/logs.
- **Session ops (owner instructions this run):** umbrella + non-trivial children on **Fable, extra-high thinking**; genuinely mechanical child work may run on **Opus 5, high thinking**; dynamic **workflows** for fan-out (reviews, parallel doc children); at **>60% context** → write HANDOFF #4 in this pattern, stop, ask owner for a fresh session + `/pickup`. Never compact mid-session.
- **Workflow gotchas (validated again this session):** `isolation:'worktree'` fails — the session cwd (`/Users/jeetu/SnugProtocol`) is not the git repo; agents self-create worktrees (`git -C /Users/jeetu/SnugProtocol/snug worktree add --detach <path> <sha>` + remove when done). Hard-fail a review workflow when 0 finder lenses return — this guard EARNED ITS KEEP this session (first delta-review launch lost both lenses to a usage-limit reset; the guard threw instead of passing an empty verdict; `resumeFromRunId` relaunched cleanly). Verify structured-output JSON shape before celebrating (task output files nest the payload under `result`).

## Phase-0 owner decisions (binding, unchanged)

Scope = A1–A15 minus A6. Spec push done (AL-13). WebLLM = Llama-3.2-3B (AL-07). Real byok key in `internal/.env.local` for live sweeps. A11 prep-only. **Merge-on-green pre-authorized.** STOP conditions: scope change; destructive/🔑 action not pre-authorized (npm publish / deploy / flip-public NEVER); security design fork; all children parked.

## Open items for the morning report (carry forward + new)

- Roadmap §2 custody wording superseded by ADR-0014 clause 5 (owner amends).
- Two claude.ai MCP connectors need re-auth (unrelated to run).
- Non-blockers ledger: `docs/next-steps.md` — all AL-04 rows are dated 2026-08-06 (incl. the delta re-review's tripwire row); none dropped.
- Lessons this session: the 0-lens hard-fail guard on review workflows caught a real empty-verdict hazard (usage-limit reset mid-workflow); the delta re-review's independent repro re-execution caught nothing the fix pass missed but CONFIRMED all 15 items — the two-stage fix-then-fresh-review pattern held; a leftover live-sweep server (port 8787) survived into this session — kill-stale-servers belongs at session START, not just sweep start.
