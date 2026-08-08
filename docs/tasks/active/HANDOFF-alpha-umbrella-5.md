# HANDOFF #5 — Alpha umbrella (TASK-20260805-alpha-umbrella) — resume point

**Written:** 2026-08-07, at an owner-requested session boundary. **Purpose:** a fresh session picks up with zero loss. Read this, then `docs/tasks/active/TASK-20260805-alpha-umbrella.md` (umbrella plan of record), then act on "IMMEDIATE NEXT ACTION". **Supersedes `HANDOFF-alpha-umbrella-4.md` (spent — its "run AL-09 next" instruction is COMPLETE and its git-state section is stale; do not follow it).**

## ⚠️ Everything is HELD. Nothing runs without an explicit owner green light.

The owner's manual-testing stop from HANDOFF #4 still stands, and AL-09 has since been **parked by owner decision**. AL-10, AL-11, AL-12, AL-15 remain HELD. **There is no queued work a fresh session should start on its own.** Wait for the owner to choose from "What the owner may ask for next" below.

## One-paragraph situation

**9 of 14 children merged/done** (AL-01 #5, AL-02 #6, AL-03 #21, AL-04 #22, AL-05 #23, AL-07 #20, AL-08 #7, AL-13 #8, AL-14 #19; A6 dropped in Phase 0). **AL-09 (`starters-auth-spectrum`) was STARTED and is now PARKED** — not failed, not merged. Running its Gate 2 uncovered a structural gap: **a chat-less app can never become a connected app.** A proposed fix (the "starter-declared connection seam") was designed and then **FAILED a 3-lens security review of the design, before any seam code was written** — 3 BLOCKERs + 9 MAJORs, every load-bearing claim re-derived at source. **The owner chose option C: park AL-09, promote the gap to its own High-tier task.** That new task is `docs/tasks/active/TASK-20260807-connection-reachability.md` (Gate 1 spec only). AL-09 resumes after it lands — or earlier if the owner elects option B (ship the starters degraded-only, which is still available and unchanged).

## Where things live (read this before hunting for files)

**Docs are on `main`; AL-09's CODE is not.** This handoff, the umbrella, the AL-09 task file and `TASK-20260807-connection-reachability.md` were landed on `main` via a docs-only housekeeping PR precisely so a fresh `/pickup` finds them without knowing which branch to check out. **The AL-09 code (AC10, AC12, the validate-suite work, the shelf looks) exists ONLY on `feat/TASK-20260807-starters-auth-spectrum`.** Start a new session on `main`; check out the branch only when resuming AL-09 itself.

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ **`dd86377`** (PR #27, whitepaper housekeeping — landed from ANOTHER session while AL-09 was in flight; AL-09's branch has not been rebased onto it).
- **`feat/TASK-20260807-starters-auth-spectrum` — AL-09's branch, PUSHED, 6 commits, cut off the older `d6ced02`.** Deliberately **NOT mergeable** (see "intentionally red" below). Rebase onto current main when it resumes.
- `feat/TASK-20260806-starters-auth-spectrum` (the OLD branch HANDOFF #4 named) — merged into main long ago; ignore it. The live branch is the `20260807` one.
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0).

## What is banked on AL-09's branch (green, mutation-evidenced, unaffected by the failed review)

| What | Where |
|---|---|
| **AC10** — Spotify BYO-registration walkthrough polished IN THE REGISTRY (AL-04 D5 constraint honored); auth 190/190 | `packages/auth/src/well-known-providers.ts` + `params-to-auth-spec.test.ts` |
| **AC12** — `bearer_token` proven through the wizard (render/mask/approve/store). The review found this kind had **ZERO** shipped coverage | `apps/playground/src/__tests__/authWizard.test.tsx` |
| **AL-03-rule repair #2** — the validate suite's network-API rule was flagging `useConnectedFetch`'s own governed seam; bare/window-qualified calls stay forbidden, a method call on the handle does not (13 regex cases evidenced) | `examples/validate.test.mjs` |
| `STARTER_LOOKS` rows + Hue desktop-only badge | `apps/playground/src/views/HubView.tsx` |

**Intentionally RED (this is why the branch must not be merged):** `examples/validate.test.mjs` lists five starter folders that do not exist yet (ENOENT → validate 88/89), and `starterShelf.test.tsx` pins 13 starter ids. On resume: **either author the five apps or revert those two list additions — never weaken the assertions.**

## The gap AL-09 uncovered (the reason a whole new child exists)

The only non-test `putAuthSpec` lives inside the wizard (`apps/playground/src/state/wizard.ts:328`), and every wizard entry needs a **directive** (requires a build conversation), an **existing row** (Settings renders `db.listAuthSpecs()` — empty for a fresh app), or a **net-error CTA** that opens over no row and no proposal (an empty manual review where the user hand-types hostnames). So starters, imported HTML, and hand-authored apps are structurally excluded from connections. Nothing is broken — AL-08's chat-less starters, AL-04's directive-only proposals, and the wizard's row-or-proposal model are each correct alone.

**The failed seam's findings are preserved as DESIGN CONSTRAINTS** in `TASK-20260807-connection-reachability.md` — read that file, not just this summary, before designing anything. The decisive one: "registry hit discards declared hosts" **does not exist for static kinds** (`params-to-auth-spec.ts:181` vs `:97`; the B2 rung hard-codes `oauth2_auth_code` at `wizard.ts:241–248`).

**Correction carried forward:** AL-09's D7 was factually wrong — a fresh installed app gets `NET_NOT_APPROVED` (Gate 3, `connected-fetch.ts:298`), never `NET_HOST_BLOCKED` (Gate 4, post-approval only). M12's off-ceiling silence is a separate, correct guard and is not implicated.

## IMMEDIATE NEXT ACTION — none. Await the owner.

## What the owner may ask for next (all need an explicit green light)

1. **Design `connection-reachability`** (its Gate 2) — the four sketched directions are A hardened app-declaration / B user-initiated from Settings / C install-time consent / D seeded bootstrap thread. The cross-cutting question to settle first: *should an app ever be able to propose a connection at all, or may only the user (Settings) or the reviewed builder LLM (directive) do so?*
2. **Resume AL-09 as option B** — ship the five starters degraded-only (real pre-connect states, KB-matching doctrine, full static C1/hook coverage; AC1–AC6, AC8–AC12), dropping the seam and AC7/AC13–AC16. Releasable without touching any security surface.
3. **Release the held tail** — AL-10, AL-11, AL-12, AL-15 after the owner's manual tests.
4. **Fold the three AL-10/AL-11 spinoffs** found by the seam review (in `docs/next-steps.md`, dated 2026-08-07): `putAuthSpec` fails open on unapproved rows; revoke leaves no tombstone; provider-name confusables dodge the registry; plus the two-SDK-announce-faces drift risk.

## Standing process (unchanged — this is why the run is clean)

- Every child: branch off fresh main → TDD, never weaken a failing test → full root suites + Playwright + live agent-browser sweep (FRESH servers; kill stale first) + fresh-context adversarial review before merge → fold → merge serialized → branch deleted → task file to done/.
- Mutation-check every guard; commit before mutating. C4/C5: codenames OProject/IProject only; key in `internal/.env.local`, never in tracked files/logs.
- **Session ops:** umbrella + non-trivial children on **Fable, extra-high thinking**; mechanical child work may run on **Opus 5, high thinking**; dynamic **workflows** for fan-out reviews; at **>60% context** → write the next HANDOFF, stop, ask for a fresh session + `/pickup`. Never compact mid-session.
- **Workflow gotchas (one NEW this session):** the 0-lens hard-fail guard stays in every review workflow; `run_in_background` is NOT a Workflow parameter; Explore can fail on an effort/thinking mismatch — `general-purpose` with `model: sonnet` works. **NEW: apply `.filter(Boolean)` to VERIFY-stage results too, not just attack stages — two verifiers hit a usage limit, returned `null`, and the aggregation step crashed on them. All 16 completed agents were recovered from `journal.jsonl`; nothing was re-run. Read the journal before assuming a crashed workflow lost its findings.**
- **Live-sweep gotchas:** agent-browser refs go stale between snapshot and click — re-snapshot immediately before clicking and scroll the target into view; `?demoauth` only engages the DEMO brain (with a real provider configured it fires REAL builds); React selects/textareas need the native-setter + dispatchEvent pattern.

## Phase-0 owner decisions (binding, unchanged)

Scope = A1–A15 minus A6. Real byok key in `internal/.env.local` for live sweeps. A11 prep-only. Merge-on-green pre-authorized. STOP conditions: scope change; destructive/🔑 action not pre-authorized (npm publish / deploy / flip-public NEVER); **security design fork** (this is the one AL-09 hit); all children parked — plus the owner's manual-testing stop.

## Open items for the morning report (carry forward + new)

- Roadmap §2 custody wording superseded by ADR-0014 clause 5 (owner amends).
- Two claude.ai MCP connectors need re-auth (unrelated to run).
- Non-blockers ledger `docs/next-steps.md` gained four 2026-08-07 rows: the reachability gap, the three AL-10/AL-11 spinoffs, and a **correction** — the carried turbo-inputs caveat was stale (`turbo.json` has no `inputs` on any task, so the "one-line fix" does not exist; the cache-correctness concern still stands and needs real authoring).
- **Lesson this session: reviewing a DESIGN costs a fraction of reviewing an implementation.** Three BLOCKERs died with zero production code written. The "walking skeleton first" discipline is what surfaced the design early enough for that to be cheap — the adversarial-review bar has now earned its keep four times running.
- AL-09 spent no live-sweep tokens (it never reached a sweep); the seam design review spent ~1.4M subagent tokens across 18 agents.
