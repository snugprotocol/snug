# HANDOFF #4 — Alpha umbrella — ⚠️ SPENT / SUPERSEDED (2026-08-07)

> **DO NOT FOLLOW THIS FILE.** Superseded by **`HANDOFF-alpha-umbrella-5.md`** — read that instead.
>
> Its "IMMEDIATE NEXT ACTION — run AL-09" is **complete**: AL-09 ran, uncovered a structural gap, and was **PARKED by owner decision** (its branch is `feat/TASK-20260807-starters-auth-spectrum`, not the `20260806` one named below, which merged into main long ago). Its git-state and 9/14 tally are stale. Kept only as the historical record of the AL-05 → AL-09 boundary.

---

# HANDOFF #4 (historical) — Alpha umbrella (TASK-20260805-alpha-umbrella) — resume point

**Written:** 2026-08-06, at a planned context-window boundary (60% rule — owner instruction: save state + fresh session, never compress mid-session). **Purpose:** a fresh session picks up with zero loss. Read this, then `docs/tasks/active/TASK-20260805-alpha-umbrella.md` (umbrella plan of record — including the OWNER SCOPE AMENDMENT), then act on "IMMEDIATE NEXT ACTION". Supersedes `docs/tasks/done/HANDOFF-alpha-umbrella-3.md` (spent).

## ⚠️ OWNER SCOPE AMENDMENT (2026-08-06, mid-run — binding)

**After AL-05 (done): run AL-09 ONLY, then STOP.** AL-10, AL-11, AL-12, AL-15 are HELD until the owner gives an explicit green light — the owner wants to run manual tests first. When AL-09 merges: write the morning report, close the session cleanly, and WAIT.

## One-paragraph situation

**9 of 14 children merged/done** (AL-01 #5, AL-02 #6, AL-03 #21, AL-04 #22, **AL-05 #23**, AL-07 #20, AL-08 #7, AL-13 #8, AL-14 #19; A6 dropped in Phase 0). **AL-05 (auth-kb) MERGED 2026-08-06 via PR #23 → main @ `2b84c6d`** after the full rigor loop: plan review (REVISE, blocker folded) → TDD (M48–M61 all mutation-evidenced) → live sweep on a REAL byok key ALL PASS — including the marquee first-run proof: the real builder, taught only by the KB, emitted the exact directive contract end-to-end ("weather dashboard using OpenWeather" → valid `auth_wizard` directive → connect card → wizard) and a no-network build emitted nothing — → 3-lens adversarial review (2 real MAJORs: KB frames-timeline overclaim; import-presence-only AC7 guard) → 8/8 fixed test-first → delta verify 8/8 → merge gate green. Remaining per the scope amendment: **AL-09 (NEXT and LAST before the stop)**; AL-10/11/12/15 held.

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ `2b84c6d` — green baseline (post-AL-05; root 19/19; knowledge vitest 96; playground vitest 407; Playwright 53 + 1 skip; typecheck + lint clean).
- **`feat/TASK-20260806-starters-auth-spectrum` — THIS branch (freshly cut off `2b84c6d`), carries only housekeeping: AL-05 task file (status done) moved to `done/`, umbrella journal entry + scope amendment, this handoff.** AL-09's real work starts here with Gate 2.
- `feat/TASK-20260806-auth-kb` — DELETED (local + remote) after the PR #23 merge.
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0).
- Task files of all merged children are in `done/`.

## IMMEDIATE NEXT ACTION — AL-09 `starters-auth-spectrum` (Med tier)

Five auth-category starters (umbrella row AL-09 / roadmap A8b): Crypto Portfolio (none/CoinGecko), Weather Planner (api_key), My Repos (PAT), Spotify Party DJ (oauth2 + BYO dev registration), Hue Lights Party (LAN, desktop-labeled; greyed on web with "why desktop" copy — A6 dropped).

Gate order (Med tier): `/start-task`-style Gate 2 plan in a new `docs/tasks/active/TASK-20260806-starters-auth-spectrum.md` (this branch already exists for it) → plan review at orchestrator's call (AL-04/AL-05 precedent: run it — both reviews found real blockers/majors) → TDD → live sweep (fresh servers; kill stale first) → fresh-context adversarial review → merge. **Then STOP per the scope amendment.**

**Binding forward constraints for AL-09:**
- **Keyless collision (from AL-05's Gate 2, next-steps row dated 2026-08-06):** keyless connected hosts are NOT expressible at 1.0 (five-kind credentialed spec union; fail-closed runtime; builder cannot propose fields). The **"Crypto Portfolio (none/CoinGecko)" starter collides head-on — resolve demo-key vs manual-data at Gate 2 before authoring.** CoinGecko's free tier issues demo API keys, so an api_key-kind starter is likely the honest resolution; a spec-level `none` kind is queued for AL-12/post-alpha and must NOT be invented here.
- Spotify wizard walkthrough polish goes in the registry `registration` block, NOT component copy (AL-04 forward constraint).
- Weather Planner e2e re-runs AC11's api_key flow against the starter (umbrella row).
- Each starter = example + fixture + App Autopsy, per the AL-08 pillar-starter pattern (`examples/*`, playground starter registry) — follow AL-08's structure (TASK-20260806-starters-pillars.md in done/).
- Owner has no OpenWeather/PAT/Spotify keys on hand (Phase-0 decision 4): starters verify against local stub providers / recorded fixtures through the REAL wizard+injection+scrub path; real-API verification queued in next-steps.
- The KB teaching shipped in AL-05 (`90-auth-and-connected-apis.md`) is the doctrine starters must MATCH: app-called hosts declared, provider names not endpoints, degraded pre-connect state, no credentials in app code. A starter contradicting the KB is a defect.
- Turbo-inputs caveat (next-steps, AL-04 row): the `examples` turbo test task does not yet include `packages/sdk/embedded/**` in inputs — force-run the examples suite (`--force`) if embedded SDK is touched, and consider landing the one-line inputs fix with AL-09 since it owns `examples/*`.

## After AL-09: STOP protocol

1. Merge AL-09 (merge-on-green pre-authorized), branch deleted, task file to done/.
2. Write HANDOFF #5 + the **morning report** (required contents in the umbrella task file §Definition of done + Open items below).
3. `/close-session` (Gate 6). Then WAIT for the owner's green light on AL-10/11/12/15.

## Standing process (unchanged — this is why the run is clean)

- Every child: branch off fresh main → TDD, never weaken a failing test → full root suites + Playwright + live agent-browser sweep (FRESH servers; kill stale servers at session START — a 5173 squatter was killed again this session) + fresh-context adversarial review before merge → fold → merge serialized → branch deleted → task file to done/.
- Mutation-check every guard; commit before mutating. C4/C5: codenames OProject/IProject only; key in `internal/.env.local` never in tracked files/logs (this session: filled the byok field via shell substitution so the value never hit logs).
- **Session ops (owner instructions):** umbrella + non-trivial children on **Fable, extra-high thinking**; mechanical child work may run on **Opus 5, high thinking**; dynamic **workflows** for fan-out reviews; at **>60% context** → write the next HANDOFF in this pattern, stop, ask owner for a fresh session + `/pickup`. Never compact mid-session.
- **Workflow gotchas (validated AGAIN this session):** the 0-lens hard-fail guard stays in every review workflow; `run_in_background` is NOT a Workflow tool parameter (workflows always run in background); the Agent tool's Explore type can fail on an effort/thinking API mismatch — general-purpose with `model: sonnet` works. Verify structured-output JSON nests under `result` in task output files.
- **Live-sweep gotchas (new this session):** agent-browser refs go stale between snapshot and click when the page re-renders — re-snapshot immediately before clicking, and scroll the target into view first (the connect card/wizard buttons silently no-op otherwise — known below-the-fold row). The `?demoauth` seam only engages the DEMO brain (correct); with a real provider configured it fires REAL builds — set provider to mock first or rely on the Playwright e2e for seam coverage. React selects/textareas need the native-setter + dispatchEvent pattern from eval; a plain `.value=` does nothing.

## Phase-0 owner decisions (binding, unchanged)

Scope = A1–A15 minus A6, NOW FURTHER NARROWED by the scope amendment (AL-09 then stop). Real byok key in `internal/.env.local` for live sweeps. A11 prep-only. Merge-on-green pre-authorized. STOP conditions: scope change; destructive/🔑 action not pre-authorized (npm publish / deploy / flip-public NEVER); security design fork; all children parked — **plus the amendment's hard stop after AL-09.**

## Open items for the morning report (carry forward + new)

- Roadmap §2 custody wording superseded by ADR-0014 clause 5 (owner amends).
- Two claude.ai MCP connectors need re-auth (unrelated to run).
- Non-blockers ledger: `docs/next-steps.md` — AL-05 added: the keyless/AL-09 coordination row (dated 2026-08-06), the D8 kindHint-echo observation + chat fence cosmetic row, the connect-card below-the-fold extension. The frames-timeline net-summary polish row (AL-03) remains open — AL-05's KB wording now matches shipped reality, so shipping that polish LATER should also revisit the KB sentence to re-strengthen it honestly.
- Lessons this session: the adversarial-review bar EARNED ITS KEEP a third time (2 MAJORs invisible to green suites: an LLM-bound overclaim about a security affordance, and an import-presence-only test); truth-of-teaching is a first-class review lens for KB work; retrieval delivery (not just content) must be a tested AC for any searchKnowledge-served teaching — the plan review's blocker was exactly this.
- AL-05 sweep spent real Anthropic tokens (~600k in / ~35k out across the marquee + negative + stray builds; two stray builds were stopped mid-flight — the `?demoauth` gotcha above).
