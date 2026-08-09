# HANDOFF #8 — Alpha umbrella / connection-reachability — resume point

**Written:** 2026-08-08, at the 60%-context rule. Read this, then `docs/tasks/active/TASK-20260807-connection-reachability.md`, then act on "IMMEDIATE NEXT ACTION". **Supersedes `HANDOFF-alpha-umbrella-7.md`** — its next action (the four breadth items) is **DONE**, and so is Gate 4.

## One-paragraph situation

**The feature is COMPLETE, e2e-proven, and has passed its first implementation review.** Since handoff #7: all four breadth items landed (install disclosure · post-revoke rule · KB amendment · examples→protocol dep), then a **fresh-context 4-lens adversarial review of the CODE** — the first ever; the five prior reviews were of the DESIGN — found **2 MAJORs and 4 MINORs**, all now fixed and mutation-evidenced. **What remains is Gate 5 (merge) and Gate 6 (close-session), plus one owner decision.**

## ⚠️ Scope discipline — unchanged

**AL-10, AL-11, AL-12, AL-15 remain HELD** pending the owner's manual tests. **AL-09 stays PARKED** at `7b45f90`. This task is the ONLY thing running.

## Git state

- `origin/main` @ **`6d3896b`**. **Untouched all session.**
- **`feat/TASK-20260807-connection-reachability` — 28 commits, PUSHED, local == origin.** Every commit explained by the task journal.
- `backup-pre-scrub-20260731` — never push/delete casually (LAUNCH_OPS item-0).

## Test status (verified at handoff, not assumed)

| Suite | At session start | Now |
|---|---|---|
| `apps/playground` vitest | 409 | **482** |
| `examples` | 75 | **87** |
| `packages/knowledge` | 112 | **116** |
| Playwright | 53 + 1 skip | **56 + 1 skip** |
| **Full root `pnpm test`** | 19/19 | **19/19 green** |

Build clean. (No `typecheck`/`lint` scripts exist in this repo — `build` typechecks; `pnpm lint` runs 0 tasks.)

## The two MAJORs the review caught — carry these, do NOT re-litigate

1. **The resolver must vouch for the code that RUNS.** Fact 2 originally compared only pinned v1, while the iframe executes `current_version`. A whole-DB import could pair a pristine v1 (public bytes, free to copy) with attacker code as the current version; both facts held and the sheet vouched for code that shipped nothing. **Both versions must match now.** This REVERSED my own earlier call ("a user edit shouldn't retract the install act") — and the test I wrote for that call had blessed the attack shape. Consequence to keep: **an app the user edits stops declaring, and that is correct.**
2. **The production glob had no test.** Every suite injects the fixture seam, which short-circuits before `import.meta.glob`. Misspelling the glob left all 477 tests green. Three unfixtured tests now exercise the real bundled files — **do not "simplify" them into the fixture seam.**

## IMMEDIATE NEXT ACTION

1. **ASK THE OWNER about the remaining MAJOR-1 residue** (the one thing I did not decide unilaterally): with both versions now required to match, **a user who edits their installed `connection-demo` loses the guided setup** and gets the plain wizard plus a Settings notice. That is the security-correct behavior and it is what shipped — but it is a UX regression for a legitimate user, and the honest alternative (re-vouch on every version write) needs the revoke-tombstone work queued to AL-10. **Flag it; do not redesign it.**
2. **Gate 5 — merge.** Squash-or-merge the branch to `main` serialized, delete the branch, move the task file to `docs/tasks/done/`. Standing rule: **never push to main directly**; PR + review.
3. **Gate 6 — `/close-session`**, folding the lessons below into `docs/lessons.md`.
4. **Then AL-09's rebase** (it is PARKED, and only after the owner's manual tests release the HOLD). Its task file already carries the updated collision numbers (`APPS` 9→14, 14 shelf ids) plus the two new guards its starters must satisfy.

## Lessons this session (fold into `docs/lessons.md` at Gate 6)

- **An implementation review finds things five design reviews cannot.** Both MAJORs were invisible at design time: one was a mismatch between two call sites' default arguments, the other was an absence of a test. **Design review is cheap and worth it — and it is not a substitute.**
- **The sharpest defect was a test that could not fail.** The production glob was unexercised because every suite injected a fixture seam that short-circuits ahead of it. **The file's own comment named the gap** ("tests inject so the assertions pin the RULE") and nobody, including me, read it as a warning.
- **Mutation testing found four unenforced claims this session** (M8 mode-check ordering · M22 prefix guard · M29 revoke call site · M34 the glob). Pattern: **a guard nothing invokes, and a test that passes through a path other than the one it names.** M22 took three attempts to write a fixture that could actually fail.
- **Refuters earn their keep.** 4 of 10 findings were refuted, two with probe tests — one showed a proposed *fix* was itself non-discriminating. A review without an adversarial verify stage would have sent me to "fix" non-defects.
- **Parallel review agents share a working tree.** One agent reported another agent's live mutation as a production BLOCKER. **Verify the tree before believing a finding about it.**
- **Repeating a journaled process lesson is a signal the fix was wrong.** I ran `git checkout <path>` over uncommitted work **twice** in one session after journaling it the first time. The durable fix is to commit before *any* mutation cycle, not to remember harder.
