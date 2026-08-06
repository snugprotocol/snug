# HANDOFF — Alpha umbrella (TASK-20260805-alpha-umbrella) — resume point

**Written:** 2026-08-06, mid-run, at a session boundary (usage-credit interruption). **Purpose:** a fresh session picks up the umbrella + all child tasks with zero loss. Read this, then `docs/tasks/active/TASK-20260805-alpha-umbrella.md` (the umbrella plan of record), then act on "IMMEDIATE NEXT ACTION" below.

## One-paragraph situation

Autonomous overnight run delivering the Alpha milestone (roadmap `internal/07-roadmap.md` v2, items A1–A15) as an umbrella of child tasks. Owner approved the umbrella + Phase-0 decisions and pre-authorized merge-on-green (AI review passing + all suites green) without waiting for human review. **7 of 14 active children are DONE/merged; 1 (AL-03) is code-complete, pushed, and mid-final-gate; 6 remain.** A6 (desktop) was dropped by the owner in Phase 0. The spine is AL-02→AL-03→AL-04→AL-05; AL-03 is the current critical path.

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ `c0cfd9b` — green baseline. Local `main` is behind; `git checkout main && git pull` before starting new branches.
- **`origin/feat/TASK-20260806-connected-fetch` @ `e5f23f5` (AL-03) — PUSHED, code-complete, rebased on main, NOT yet PR'd/merged.** 10 commits. This is the most important unmerged work. Root suites green (auth 152, playground 316, protocol 149, etc.; 19/19 turbo tasks), Playwright 50 pass + 1 skip × 3 consecutive runs, 29 mutation guards re-established in clean isolation, adversarial review's BLOCKER (phantom zod dep) fixed at `a03b1ef`.
- Other pushed feature branches are all already MERGED to main (their PRs closed): flip-prep #19, webllm #20, spec-push #8, starters #7, auth-core #6, doctrines #5. Safe to delete locally; don't re-merge.
- Two detached review worktrees under `scratchpad/` (al02-impl-review-wt, al03-impl-review-wt) — disposable; `git worktree remove --force` them if cleaning up.
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0; contains pre-scrub objects).

## Child status ledger

| Child | Roadmap | State | PR | Notes |
|---|---|---|---|---|
| AL-01 doctrines-devex | A1,A15 | ✅ MERGED | #5 | ADR-0013/0014, code-map regen script, 2 bug fixes |
| AL-02 auth-core | A2 | ✅ MERGED | #6 | packages/auth core; schema v3 snug_auth_specs; 3 audit bugs (1,2 fixed here; 3 = AL-03) |
| AL-08 starters-pillars | A8a | ✅ MERGED | #7 | 5 pillars; **fixed real bug: `<form onSubmit>` dead in C2 sandbox**; ephemeral-driver read-only fix |
| AL-13 spec-push | A12 | ✅ DONE | #8 | spec repo pushed `ed6e596` (v0.1 + v0.2-draft); AUTHORIZED + verified |
| AL-14 flip-prep | A11 | ✅ MERGED | #19 | SECURITY/CONTRIBUTING/CoC/templates; **issues #9–#18 live**; runbook in internal/RUNBOOK-flip-public.md |
| AL-07 webllm-spike | A7 | ✅ MERGED | #20 | Llama-3.2-3B chosen (measured); ADR-0015; flag `?webllm=1` |
| **AL-03 connected-fetch** | A4 | **⏳ code-complete, pushed, mid-final-gate** | none yet | See IMMEDIATE NEXT ACTION |
| AL-04 auth-wizard | A3 | ⬜ planned (pre-draft exists) | — | scratchpad/AL-04-plan-predraft.md; High; needs AL-03 shapes → v1 plan → fresh-context review → implement |
| AL-05 auth-kb | A5 | ⬜ pending | — | teaches the shipped useConnectedFetch; read prompt-engineering reference first |
| AL-09 starters-auth-spectrum | A8b | ⬜ pending | — | 5 auth-category starters; needs AL-04 wizard; Hue greyed-on-web (A6 dropped) |
| AL-10 security-hardening | A9 | ⬜ pending | — | fuzz/property + dep-pin/audit CI (also unblocks branch protection) + settings key-echo fix (queued) |
| AL-11 threat-model | A10 | ⬜ pending | — | doc; carries AL-03's base64-scrubber + honest-browser-SSRF boundaries |
| AL-12 spec-staging | A12b | ⬜ pending | — | v0.3 auth/net draft in docs/spec-drafts/ |
| AL-15 landing-first-run | A13,A14 | ⬜ pending | — | apps/website + zero-key default + mobile Safari (WebKit) pass; do LAST (sweeps whole surface) |

## IMMEDIATE NEXT ACTION (AL-03 — resume its final gate)

AL-03 is code-complete and pushed. Its remaining gate before merge is the **live browser sweep**, which was INTERRUPTED by the usage-credit cutoff. The sweep agent's last words (unverified, mid-diagnosis — treat as a LEAD not a finding): *"The inspector's `summarize` has no case for net frames (falls to generic `frame`), but worse — NO entries at all are showing. Let me check the wiring."*

So: the sweep was **not clean** — it was hunting a possible real issue (net round trips may not appear in the think-panel/inspector at all, and/or net frames render with a generic summary). This must be resolved before merge:
1. Re-run the AL-03 live sweep (agent-browser skill; the full brief is in this session's history — Connections panel, injected-fetch flow against the https e2e stub, confirm dialog + grant-invalidation, C1 probes that injected values are absent from DOM/console/exports/inspector, plus a byok build). Repo is on `feat/TASK-20260806-connected-fetch` already (or check it out).
2. **Specifically confirm or refute the inspector lead**: do net round trips appear in the think panel's LLM/round-trip inspector, and is their content SCRUBBED? "No entries showing" for net frames may be (a) a real observability gap to fix before merge, (b) expected-by-design if net frames aren't inspector-routed yet (then it's a logged non-blocker + AL-11/AL-05 note), or (c) a sweep-harness artifact. Decide which. If it's a launch-blocker (e.g. injected value visible anywhere, or the capability silently broken in-browser), fix on the branch, re-verify, re-review the delta.
3. When the sweep is clean (or blockers fixed): PR + merge AL-03 to main (owner pre-authorized), delete branch, move its task file to done/ on AL-04's branch.

## Then: the tail (in order)

1. **AL-04 auth-wizard** — finalize scratchpad/AL-04-plan-predraft.md into a v1 (fill the [AL-03-DEP] gaps from AL-03's shipped net frames/error codes/Connections panel API — now readable on the merged branch), instantiate task file, **fresh-context plan review BEFORE implementation** (High tier), then implement → live sweep → adversarial review → merge. Inherited constraints are pinned in the pre-draft AND in AL-03's task-file "Forward constraints" section (chat-canary, caller-held expectedFlowId, punycode host display, inference-poisoning posture).
2. **AL-05 auth-kb**, **AL-09 spectrum starters** (needs AL-04), **AL-10 hardening**, **AL-11 threat-model** (needs AL-10; carries AL-03's documented boundaries), **AL-12 spec-staging**.
3. **AL-15 landing + first-run LAST** — it sweeps the whole surface.
4. **End of run:** `/close-session` (Gate 6) + the morning report (see umbrella task file for the required contents).

## Standing process (do not drop — this is why the run has been clean)

- Every child: branch `feat/TASK-<id>` off fresh main → TDD (tests first, never weaken a failing test) → **full root suites green + Playwright green + live agent-browser sweep + fresh-context adversarial review in an ISOLATED worktree** (lessons 2026-08-04: reviewers that mutate need their own worktree) → fold findings → merge on green → delete branch → task file to done/.
- High-tier children (protocol/runner/auth/C1/C2) get a **fresh-context plan review BEFORE implementation**. This has caught blockers every time (AL-02 plan: REJECT→3 blockers; AL-03 plan: 3 blockers; AL-03 impl: phantom-zod BLOCKER).
- Mutation-check every guard test (revert fix → red → restore); a test never seen red proves nothing. Commit before mutating (git checkout wipes uncommitted work — bit two agents).
- Merges are strictly serialized; rebase each branch onto latest main before merge; regen code-map counts after.
- C4/C5: real source-system names/paths (the codename→real mapping lives ONLY in internal/.env.local, gitignored) NEVER enter tracked files — codenames OProject/IProject only.

## Phase-0 owner decisions (binding for the whole run)

1. Scope = A1–A15 **minus A6 (desktop, dropped)**. 2. Spec push AUTHORIZED (done, AL-13). 3. WebLLM model = spike decides (done: Llama-3.2-3B). 4. Owner left an Anthropic key in `internal/.env.local` → live sweeps run real byok. 5. A11 prep-only. **Merge-on-green pre-authorized.** STOP conditions: scope change; destructive/🔑 action not pre-authorized (npm publish / deploy / flip-public are NEVER in scope); a security design fork; all children parked.

## Open items to carry to the morning report

- internal/07-roadmap.md §2 still carries the superseded custody absolute ("your keys never leave your file"); ADR-0014 clause 5 supersedes it — owner should amend §2 to "your keys never reach anyone else's server" (flagged by AL-14 review; roadmap is owner's doc).
- Two claude.ai MCP connectors (names withheld here to avoid confusion with source-system codenames; visible in the owner's claude.ai connector settings) report needing re-authorization — unrelated to the run.
- Non-blockers logged across sweeps are in docs/next-steps.md (settings key-echo → AL-10; StrictMode ?idea= handoff = issue #13; etc.).
