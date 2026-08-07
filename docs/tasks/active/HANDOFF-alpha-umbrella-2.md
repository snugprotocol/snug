# HANDOFF #2 — Alpha umbrella (TASK-20260805-alpha-umbrella) — resume point

**Written:** 2026-08-06, at a planned context-window boundary (60% rule — owner instruction: save state + fresh session, never compress mid-session). **Purpose:** a fresh session picks up with zero loss. Read this, then `docs/tasks/active/TASK-20260805-alpha-umbrella.md` (umbrella plan of record), then `docs/tasks/active/TASK-20260806-auth-wizard.md` (AL-04, the live child), then act on "IMMEDIATE NEXT ACTION". Supersedes `docs/tasks/done/HANDOFF-alpha-umbrella.md` (spent).

## One-paragraph situation

**7 of 14 children merged/done** (AL-01 #5, AL-02 #6, AL-03 #21, AL-07 #20, AL-08 #7, AL-13 #8, AL-14 #19 — seven children, seven PRs; A6 dropped in Phase 0. NOTE: handoff #1 said "7 done" *before* AL-03 merged — an off-by-one vs its own 6-row ✅ ledger that this session briefly inherited as "8"; the authoritative count is this child list). **AL-04 (auth-wizard) is implemented, live-swept, and adversarially reviewed — one fix-first pass remains before its merge.** Tail after AL-04: AL-05, AL-09, AL-10, AL-11, AL-12, AL-15 (LAST). Merge-on-green remains pre-authorized (Phase-0). This session ran the full rigor loop on AL-04 and it worked: plan review found 2 blockers pre-implementation; impl review + live sweep found 1 blocker + 3 majors post-implementation, one of them (popup) independently by both gates.

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ `4a763ea` — green baseline (post-AL-03 merge; root 19/19 turbo).
- **`feat/TASK-20260806-auth-wizard` @ `bf7f233` + this handoff commit — PUSHED.** Contents: plan-of-record task file (`3afbeda`), 9 implementation commits (`97f16be`..`f6c3721` — 13 ACs, D1–D10, mutation table M1–M30 all executed with evidence), sweep popup fix `58be23c`, sweep journal `bf7f233`. Suites at head: root 19/19 (1442 tests; playground 377 after popup fix), Playwright 53 + 1 skip (auth-wizard e2e 3/3), typecheck clean.
- Review artifacts committed on this branch: **`docs/tasks/active/AL-04-review-verdict.json`** (full FIX_FIRST verdict incl. reproSteps; reviewed at `f6c3721`, i.e. BEFORE the popup fix `58be23c`).
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0).
- No stale worktrees, no other feature branches. Task files of all merged children are in `done/`.

## IMMEDIATE NEXT ACTION — AL-04 fix-first pass, then merge

The adversarial review (3 worktree-isolated lenses + refute-first verification, 3/3 coverage) returned **FIX_FIRST**: 1 BLOCKER + 3 MAJORs, 9 dated non-blocking rows. Full text with file:line anchors and reproSteps: `docs/tasks/active/AL-04-review-verdict.json`. The live sweep (12/12 after fix) already fixed the synchronous-popup-open half of fixFirst item 3 at `58be23c`.

Dispatch a fix agent (Fable, extra-high; test-first; mutation-check; commit granularly; push) to apply, in this order:

1. **fixFirst 1 (BLOCKER)** — AC7 re-approval diff bypassed on the directive mount over an already-approved row (host ceiling silently re-frozen, M20's test only covers the settings mount). Fix + test per verdict JSON.
2. **fixFirst 2 (MAJOR)** — LLM-authored `fields[]` labels bypass spec_confirm and render verbatim at the credentials step (credential-misdirection phishing). Apply the M5-style omit to `fields` per verdict JSON.
3. **fixFirst 3 residual (MAJOR)** — `58be23c` fixed synchronous open; VERIFY the `window.open === null` branch now sets a visible error state (no `awaiting_callback`, no `activeFlow`, button re-enabled, close returns 'closed') — complete it if not, plus the vitest with `openPopup: () => null`. Also journal the D6 deviation history (the journal's completeness claim was false — the review flagged this).
4. **fixFirst 4 (MAJOR)** — `startOAuthFlow` lifecycle guards: entry guard (refuse/teardown on double-start), staleness guard (bail after each await if session changed/closed), UI busy guard at click. Two tests per verdict JSON.
5. **nonBlocking rows 1–3 (pre-merge REQUIRED — orchestrator decision this session):** row 1 = repair the false M4 ledger row + add the AC3 pin test (planned regression currently survives all 375 tests); row 2 = subscription-mode inference guard (**AL-05 must NOT land before this**); row 3 = the dodged `imported_unapproved` settings-row test (folds into fix 1 naturally).
6. **nonBlocking rows 4–9 (fix-now preferred; drop to next-steps only if one resists):** all are small, well-anchored defects in new code — inverted capability check, floating `clearApp` promise, missing abort/catch on the inference turn, tripwire URL-exclusion regex, unbounded persisted-directive strings, static-credentials required-field validation.

Then: **delta re-review** (single fresh-context reviewer or small workflow over `git diff f6c3721..HEAD` — the fix delta + `58be23c`/`bf7f233`, checking the fixes are real and introduce nothing) → full root suites + Playwright green → **PR + merge (pre-authorized)** → delete branch → AL-04 task file + this handoff + `AL-04-review-verdict.json` to `done/` on the next child's branch → post-merge root suite on main.

## Then: the tail (in order)

1. **AL-05 auth-kb** (Med) — knowledge layer teaching the builder to emit `auth_wizard` directives; read the prompt-engineering reference first (standing memory); BLOCKED on the subscription-mode guard (fix item 5 above). Sweep non-blocker to fold: inference prompt over-includes documented hosts (bias toward production-only).
2. **AL-09 starters-auth-spectrum** (Med) — 5 auth-category starters; Hue authored + greyed-on-web (A6 dropped).
3. **AL-10 security-hardening** (High — full rigor loop incl. pre-implementation plan review). Queued inheritances: grant-bookkeeping (clock seat declined in AL-04/N6), `NET_AUTH_FAILED` structured sub-code, turbo-inputs fix (examples byte-sync class), fuzz/property tests over envelope + auth/net frames + the new directive schemas, dep-pin/audit CI, settings key-echo fix.
4. **AL-11 threat-model** (Med, doc; needs AL-10) — carries AL-03's boundaries (base64-scrubber, honest-browser-SSRF, inspector value-blindness) + AL-04's notes (docsText-to-BYOK-wire C1 tension, inference-poisoning posture, popup-blocker class).
5. **AL-12 spec-staging** (Med) — v0.3 auth/net draft in `docs/spec-drafts/` (AuthSpec, `auth_required`, render directive, net frame semantics); C3/SPEC_SYNC.
6. **AL-15 landing-first-run LAST** — sweeps the whole surface; then **/close-session (Gate 6) + morning report** (required contents in umbrella task file).

## Standing process (unchanged — this is why the run is clean)

- Every child: branch off fresh main → TDD, never weaken a failing test → full root suites + Playwright + live agent-browser sweep (FRESH servers — stale-server artifact bit AL-03's first sweep) + fresh-context adversarial review before merge → fold → merge serialized → branch deleted → task file to done/.
- High children get a fresh-context PLAN review before implementation (AL-04's found 2 blockers; verdict flow: v1 → 3-lens review → v2 fold → independent fidelity verify).
- Mutation-check every guard; commit before mutating. C4/C5: codenames OProject/IProject only; key in `internal/.env.local` never in tracked files/logs.
- **Session ops (owner instructions this run):** umbrella + non-trivial children on **Fable, extra-high thinking**; genuinely mechanical child work may run on **Opus 5, high thinking**; use dynamic **workflows** for fan-out (reviews, parallel doc children); at **>60% context** → write HANDOFF #3 in this pattern, stop, ask owner for a fresh session + `/pickup`. Never compact mid-session.
- **Workflow gotcha (cost a false MERGE_OK this session):** `isolation:'worktree'` fails — the session cwd (`/Users/jeetu/SnugProtocol`) is not the git repo. Agents must self-create worktrees: `git -C /Users/jeetu/SnugProtocol/snug worktree add --detach <path> <branch>` (+ remove when done). Also: hard-fail a review workflow when 0 finder lenses return — an empty findings list must never reach synthesis as a pass. And: verify structured-output JSON shape before celebrating (task output files nest the payload under `result`).

## Phase-0 owner decisions (binding, unchanged)

Scope = A1–A15 minus A6. Spec push done (AL-13). WebLLM = Llama-3.2-3B (AL-07). Real byok key in `internal/.env.local` for live sweeps. A11 prep-only. **Merge-on-green pre-authorized.** STOP conditions: scope change; destructive/🔑 action not pre-authorized (npm publish / deploy / flip-public NEVER); security design fork; all children parked.

## Open items for the morning report (carry forward + new)

- Roadmap §2 custody wording superseded by ADR-0014 clause 5 (owner amends).
- Two claude.ai MCP connectors need re-auth (unrelated to run).
- Non-blockers ledger: docs/next-steps.md (AL-04 added: host-over-inclusion prompt bias; Sheet sticky-footer; plus the 9 review rows if any get dropped from the fix pass).
- Lessons this session: popup-blocker class is invisible to headless CI (live sweep is the only gate that catches it); M22 child-process isolation gate defeated by pnpm hoisting (source-level import lint is the wall); turbo cache masked a pre-existing main breakage (examples byte-sync, repaired on AL-04's branch at `a7bfee2`, turbo-inputs fix queued to AL-10).
