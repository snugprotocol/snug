# HANDOFF #7 — Alpha umbrella / connection-reachability — resume point

**Written:** 2026-08-08, at the 60%-context rule. **Purpose:** a fresh session picks up with zero loss. Read this, then `docs/tasks/active/TASK-20260807-connection-reachability.md` (**plan v2 is the plan of record**), then act on "IMMEDIATE NEXT ACTION". **Supersedes `HANDOFF-alpha-umbrella-6.md`** — its next action (the four-step walking skeleton) is **DONE**.

## One-paragraph situation

**The walking skeleton is COMPLETE and PROVEN END-TO-END.** All four steps of handoff #6's IMMEDIATE NEXT ACTION landed test-first and mutation-evidenced: the install-act resolver, the wizard `declaration` field + async CTA, the sheet's strong-review gate, and the `connection-demo` app with a **T8 e2e that passes in a real browser** — install a chat-less starter → the app's own call → `NET_NOT_APPROVED` → CTA → prefilled strong review → approve → the credentials step. **The headline gap this task exists to close is closed and demonstrated.** One breadth item (the declared-not-connected Settings surface) was pulled forward because T8b depends on it. **Gate 3 is otherwise still IN PROGRESS**: the remaining breadth is unstarted.

## ⚠️ Scope discipline — unchanged

**AL-10, AL-11, AL-12, AL-15 remain HELD** pending the owner's manual tests. **AL-09 stays PARKED.** This task is the ONLY thing running. Do not start anything else.

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ **`6d3896b`** (docs-only, PR #29). **Untouched this session.**
- **`feat/TASK-20260807-connection-reachability` — THIS task's branch, PUSHED, 17 commits, local == origin.** The diff vs main is 24 files / +2424; every commit is explained by the task journal. **No lost context.**
- **`feat/TASK-20260807-starters-auth-spectrum` — AL-09's parked branch, UNTOUCHED at `7b45f90`.** Do NOT check it out unless resuming AL-09; it needs a rebase onto current main when that happens, and **its task file now records the updated collision numbers** (see below).
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0).

## Test status (verified at handoff time, not taken on trust)

| Suite | At pickup | Now |
|---|---|---|
| `apps/playground` vitest | 409 | **456** |
| `examples` | 75 | **85** |
| `packages/knowledge` | 112 | 112 (unmoved) |
| Playwright | 53 + 1 skip | **56 + 1 skip** |
| **Full root `pnpm test`** | 19/19 | **19/19 green** |

Playground build clean. (This repo wires no `typecheck`/`lint` scripts — `build` does the typechecking; `pnpm lint` runs 0 tasks.)

## What landed this session

| Commit | What |
|---|---|
| `f79886e` | **Resolver** — install-act declaration, two independent facts (V2-2/V2-3/V2-7) |
| `f89a64f` | Journal step 1 |
| `253ead5` | **Wizard** `declaration` field + async `openWizardForNetError` + `RunView` call-site rework (one commit) |
| `52162ad` | Mode-check ordering pinned (mutation M8 found an unguarded claim) |
| `fe22bd0` | **Sheet gate** — declaration forces the strong review (V2-1/V2-7) |
| `5c20a42` | Journal steps 2+3 |
| `a94cfa9` | **`connection-demo` app** + the ninth-folder fold + the curation-gate self-check |
| `4d3cabd` | **T8 e2e** (passing) + the declared-not-connected **Settings surface** |
| `f408fea` | Journal step 4 |

## Decisions that must NOT be re-litigated

1. **POSTURE (owner, 2026-08-08): an app may NEVER propose a connection at runtime.** Direction C ratified.
2. **THE FORK (owner, 2026-08-08): option (i) — extend the validate rule narrowly.** Landed last session.
3. **Everything in plan v2 §V2-1..V2-7.** All of it is now implemented except the breadth list below.

## Corrections this session made to its OWN claims — carry them, don't re-derive

- **A user edit does NOT withdraw a declaration.** `saveAppVersion` adds v2 and leaves pinned factory v1 untouched — which is exactly *why* V2-2 reads version 1. My first-draft test asserted the opposite. The real attack is the inverse (foreign v1, matching current), separately pinned.
- **The CTA is consumed on a successful open** (`RunView.tsx`), and that is **pre-existing deliberate behavior**, not something this task introduced — the async rework only made the dismissal conditional on the awaited boolean instead of a truthy Promise. Do not "fix" it as a regression. What makes it acceptable is that **Settings is now the way back**.
- **A parked-wizard refusal is UNREACHABLE through real UI** — the wizard is a modal covering the banner, so a second CTA click can never be delivered. It is pinned in `wizardDeclaration.test.ts` (T4b), where it *is* reachable. Do not re-attempt it in Playwright.
- **`proposalDriven` needed widening too** (`AuthWizardSheet.tsx`), not just `specConfirm` — a declaration-only session would otherwise render the strong review with nothing behind it. The plan never anchored this. **A fresh reviewer should check my judgement that this did not meet the "stall on a structural surprise" bar.**

## IMMEDIATE NEXT ACTION — the remaining breadth, in this order

Plan v2 §V2-5/§V2-6 has the mechanism. **None of this is started.**

1. **The install disclosure** on `RunView.tsx` (~`:560–570`) — testid `starter-install-disclosure` (pinned in §Shared literals): tell the user at INSTALL time that this app ships a declared connection.
2. **The V2-5 post-revoke rule** — the prefilled upgrade applies only while the app has never had a row this session. **It is UX friction, NOT a security boundary — it dies on page reload; the plan says so and the code comment must too.** Guard T7b. The real fix is AL-10's revoke tombstone.
3. **The KB amendment (MINOR 15) — larger than one sentence.** `packages/knowledge/prompts/knowledge-base/app-authoring/90-auth-and-connected-apis.md` gains the install-act rung, but **the same file's emission rules assume a directive-closing reply a chat-less starter cannot produce**; the generated snapshot + the KB suite move with it. `packages/knowledge` is in the touched set.
4. **`examples`→protocol workspace dep (MINOR 10)** — the manifest rule imports `llmProposalSchema` directly and **must fail loudly if the import fails** (no graceful-degrade try/catch — a curation gate that can silently skip is not a gate). **Needs a named turbo build-ordering guarantee or fresh clones go red.**

Then **Gate 4/5**: fresh-context adversarial review of the IMPLEMENTATION (five design reviews have now paid; an implementation review has not run at all), fold, merge serialized, task file to `done/`.

## Known collision — ALREADY RECORDED, do not re-derive

`TASK-20260807-starters-auth-spectrum.md` (AL-09) has been **updated in place** this session: its `APPS` 8→13 became **9→14**, its 13 shelf ids became 14, and it now names the two new guards its starters must satisfy (the curation-gate self-check, and `LOOK_COVERED` for the ⬡-fallback guard).

## Standing process (unchanged)

Branch off fresh main → TDD, never weaken a failing test → full root suites + Playwright + fresh-context adversarial review before merge → fold → merge serialized → branch deleted → task file to `done/`. Mutation-check every guard; **commit before mutating**. C4/C5: codenames OProject/IProject only. **Session ops:** umbrella + non-trivial children on **Fable, extra-high thinking**; dynamic **workflows** for fan-out; at **>60% context** → HANDOFF, stop, fresh session + `/pickup`. Never compact mid-session.

**Process slip to carry:** I ran `git checkout <path>` on a file holding **uncommitted** work and reverted it (recovered in full from a mutation-run backup, re-verified 456/456 before committing). **"Commit before mutating" applies to the restore step too — a mutation backup is not a commit, and `git checkout <path>` is destructive.**

## Lessons this session (fold into `docs/lessons.md` at Gate 6)

- **The mutation matrix caught what review did not — twice, and both were MY claims.** A comment said the mode check runs first so a no-CTA code never touches the DB; reordering it left every test green. **A claim no test enforces is not a guard.**
- **A curation gate that can silently skip is not a gate.** Mutating an app out of the examples `APPS` list left the suite GREEN — it just reported a smaller number, shipping an unvalidated app. **Silence that reads as approval is the worst failure mode a gate can have.** Now asserted against the filesystem.
- **A guard whose coverage loop iterates the wrong list covers nothing.** The shelf's ⬡-fallback guard iterated `PILLAR_FOLDERS`, so a ninth folder would have shipped an icon-less tile with nothing failing.
- **Writing the e2e found two false beliefs of mine about the product** that unit tests could not have — one about modal reachability, one about pre-existing CTA behavior I nearly misread as my own regression. **An e2e's first red is evidence about the product, not automatically a bug in the code.**
- **Reviewing a DESIGN costs a fraction of reviewing an implementation — now five times running.** Corollary earned this session: the implementation still needs its own review, and it has not had one.
