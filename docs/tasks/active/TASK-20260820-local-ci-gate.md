# TASK-20260820-local-ci-gate: `gate:local` — one command that replaces the blind CI, plus the close-session automation

- **Status**: in-review (Gate 3–5 done; `gate:local --all` verification running)
- **Owner**: Jeetu
- **Risk tier**: **HIGH** — auto-escalated. Touches CI/release config (`.github/workflows/ci.yml` is the reference this replaces) and creates the artifact that becomes the *sole* merge gate for a solo developer. A false green here is undetectable by construction: nothing downstream re-checks it.
- **Branch**: `feat/TASK-20260820-local-ci-gate`
- **Packages touched**: root `package.json` (scripts), `scripts/` (new gate driver), `apps/playground/vitest.config.ts` (conditional — see AC1), `.claude/commands/close-session.md`, `docs/` (next-steps, lessons, code-map, ADR). **NOT** `apps/playground/vitest.config.ts` — see AC1.
- **Spec impact**: none — no `packages/protocol` bytes change.
- **Related**: next-steps 2026-08-19 (CI billing block), next-steps 2026-08-14 (playground vitest flake), `docs/lessons.md:10`, ADR-0021 D8 addendum (Windows), ADR-0027 (distill-don't-accumulate), PROCESS.md Gate 5/Gate 6

## Spec (what & why)

GitHub Actions has been billing-blocked since ~2026-08-18: every run fails in ~2 s with zero steps executed, rendering as an ordinary red X. ~12 tasks have merged on local evidence alone. **The owner has decided NOT to restore billing** — as the solo developer he will run CI locally before merging to `main`. This task makes that decision safe and executable rather than a checklist held in memory.

Three deliverables, in dependency order:

1. **Settle the playground vitest flake.** It was recorded as the blocker for trusting any local gate. Investigation on 2026-08-20 (this session) could NOT reproduce it — see "Decisions & surprises". The AC is written to follow the evidence, not the prior note.
2. **`pnpm run gate:local`** — one command chaining the workspace leg + the macOS desktop-shell leg + `gate:release`, with an unambiguous pass/fail verdict. This is what "run CI locally" means from now on.
3. **Wire it into `/close-session`** as a hard precondition, then automate the merge tail: journal/docs → PR → merge → back to `main` → fetch.

**Why HIGH tier beyond the CI-config rule:** the failure mode is silent. A gate that skips a leg and still prints green is worse than no gate, because it manufactures false confidence at exactly the moment (pre-merge) the owner has decided to trust it alone.

**Acceptance criteria** (each becomes at least one test):

1. **The flake is settled on evidence.** `docs/next-steps.md`'s 2026-08-14 flake entry and `docs/lessons.md:10` are corrected to state what is now measured: 8 consecutive full-parallel green runs on clean `main` (5 idle + 3 under 8 spinning cores), 1303/1303, plus one full `turbo run test --force` at 23/23. **No config change is made to `apps/playground/vitest.config.ts` unless a red is reproduced** — a `testTimeout`/`maxThreads` change made against an unreproducible symptom is an unfalsifiable edit that would mask a future real red. If a red IS reproduced during this task, the config fix lands with the failing run recorded.
2. **`pnpm run gate:local` exists at the root** with a defined leg set, each independently selectable:

| Leg | Contents | Default | ~Time |
|---|---|---|---|
| `workspace` | `turbo run build --force` → `turbo run test --force` → `check-threat-model` → `check-sandbox-guard` | **ON** | ~2 min |
| `smoke` | `pnpm --filter server smoke` | **ON** | ~10 s |
| `e2e` | `pnpm --filter playground test:e2e` | OFF | ~6 min |
| `rust` | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | OFF | ~1 min |
| `desktop` | `pnpm --filter desktop test` → `gate` (`SNUG_GATE_REBUILD_WEB=1`) | OFF | ~5 min |
| `release` | `pnpm --filter desktop gate:release` | OFF | ~5 min |

`smoke` defaults ON with `workspace` — it is ~10 s and closes threat-model R-11's CSP-header gap, so there is no ergonomic reason to make it opt-in. Selection is by flag (`--legs=workspace,e2e` / `--all` / `--only=e2e`), so both the interactive `/close-session` prompt and any scripted use drive the SAME driver. `--all` runs everything and is the full-CI-equivalent form.
3. **`gate:local --all` is a proven SUPERSET of the CI workflow.** A test parses `.github/workflows/ci.yml` and asserts every step of the `workspace` job and the macOS half of `desktop-shell` maps to a leg in the local gate; extra local legs (smoke, e2e) are allowed and asserted present, but a CI step with NO local counterpart fails the test. The `IPC_CHECK_IDS` stale-twin lesson applied — otherwise the local gate silently drifts behind the workflow it replaces when billing is restored at flip-public. **The superset claim attaches to `--all` ONLY**; see AC10 for what a partial run may and may not claim.
4. **The gate fails loud and cannot report a false green.** Any leg exiting non-zero fails the whole run with a non-zero exit and names the failing leg. A leg that is *skipped* (Rust toolchain absent; **`SNUG_E2E_HAS_APP` unset, which silently converts 10 of 15 e2e specs from assertions into skips**) is a FAILURE, never a silent pass — there is no "not applicable" success path. The gate asserts `appIsPresent()` is true and that the e2e run reports a non-zero passed count. Pinned by a test that injects a failing leg and one that injects a skipped leg.
5. **Windows is named as deliberately unverified**, not silently dropped. The gate prints, and the ADR records, that the `windows` leg of `ci.yml` has no local counterpart and that R-5 regression detection is consequently unmonitored — per the ADR-0021 D8 addendum this is accepted through 1.0.
6. **`/close-session` runs `gate:local` first and refuses to proceed on failure.** No journal is written, no PR opened, no merge performed if the gate is red.
7. **On green, `/close-session` completes the tail automatically:** Gate-6 docs/journal → commit → push → open PR on the current branch if absent → merge → `git switch main` → `git fetch`/`pull`. Destructive/outward steps (push, PR, merge) are named explicitly in the command text so the behavior is auditable.
8. **`/close-session` pins the model** via `model: claude-opus-5` frontmatter so it runs on Opus 5 even when the session model is Fable. Verified supported: the override applies for the rest of the turn and is not persisted to settings.
9. **The 8 pre-existing e2e failures are resolved to a known state before the gate adopts e2e.** Measured on clean `main` (`a8bad77`) this session: 64 passed / 8 failed / 1 skipped in 5.6 min. A gate whose first run is red teaches its owner to ignore it on day one. Each of the 8 is either FIXED, or quarantined behind a named, dated, individually-listed allowlist that the gate prints on every run and that a test asserts is non-growing. **Disposition (owner decision 4, 2026-08-20): quarantine the 4 known DEGRADED rows immediately** — they already carry the 2026-08-18 next-steps entry, so re-diagnosing them here is duplicated work — **and diagnose only the 4 undocumented ones** (3× `connection-declaration` T8/T8b, 1× `connection-wizard.spec.ts:328` P3-AC6/Q5). Each of the 4 diagnosed is then fixed, or quarantined with its own dated next-steps entry naming what was found. No row enters the allowlist without a written reason.
10. **A partial run states what it did NOT verify — the verdict never overclaims.** The final line of a selective run reads e.g. `PARTIAL PASS — 2/6 legs (workspace, smoke). NOT VERIFIED: e2e, rust, desktop, release.` Only `--all` may print `FULL PASS — equivalent to ci.yml (macOS; Windows leg has no local counterpart)`. The skipped-leg names are carried into the PR body and the task journal by `/close-session`, so the durable record shows which evidence backed which merge. This is the AC4 fail-loud principle extended to decision 5: with legs now opt-out, the gate's job is no longer only to fail loudly but to be *honest about its own coverage* — an unqualified "PASS" after a 2-minute partial run is exactly the false green AC4 exists to prevent. Pinned by tests on both verdict strings.
11. **A leg the user deselected is recorded as DESELECTED, never as passed or skipped.** The three states are distinct in the driver's output and exit logic: PASS, FAIL, DESELECTED. AC4's rule is unchanged for legs that were *selected* — a selected leg that cannot run (toolchain absent, `appIsPresent()` false) is a FAILURE.

**Out of scope**:
- Restoring GitHub Actions billing (owner decision — explicitly declined this session).
- Any Windows verification path.
- ~~Playwright/e2e~~ and ~~the `apps/server` smoke leg~~ — **both moved IN SCOPE by owner decision 3 (2026-08-20).**
- Fixing the *root cause* of any of the 8 e2e failures that turns out to be a deep product defect. AC9 allows an honest dated quarantine so this task cannot balloon; each quarantined row gets its own next-steps entry.
- Changing the CI workflow file itself. It stays as the reference contract AC3 derives from, and as the restoration path when billing is fixed before flip-public.

## Plan

**Order (tests first per TDD.md):**

1. `scripts/gate-local.test.mjs` — the AC3 derivation test (parse `ci.yml`, assert step-for-step coverage) and the AC4 fail-loud test (a stubbed failing leg must exit non-zero and name the leg). RED first.
2. `scripts/gate-local.mjs` — the driver. Takes `--legs=`/`--all`/`--only=`; unknown leg names are an error, never a silent no-op (a typo'd `--legs=e2ee` must not report a pass having run nothing). Sequential (not parallel): a parallel gate would contend for the cores the desktop gate's real WKWebView and the Playwright browsers need. Runs every SELECTED leg even after one fails (no fail-fast) — a solo dev wants every problem in one pass, not one per round trip — then prints a per-leg PASS/FAIL/DESELECTED table and the AC10 verdict line. `--all` is ~15–20 min; the default (`workspace,smoke`) is ~2 min.
3. Root `package.json`: add `"gate:local": "node scripts/gate-local.mjs"`.
4. `.claude/commands/close-session.md`: add `model: claude-opus-5` frontmatter and a **step 0 that ASKS which legs to run** (multi-select, defaults per the AC2 table: workspace+smoke checked, the rest unchecked) before running `pnpm run gate:local --legs=<selection>`. Red → refuse, write nothing, merge nothing. Green → Gate-6 docs/journal (recording the AC10 verdict incl. deselected legs) → commit → push → PR (body carries the same verdict) → merge → `git switch main` → `git fetch`/`pull`, with **no further confirmation after the leg selection (owner decision 2 as amended by decision 5)**. The leg prompt IS the human beat; it lands before ~20 minutes of work rather than after. The command text names push/PR/merge explicitly so the automation is auditable by reading the file. **Project file only** — `/Users/jeetu/.claude/commands/close-session.md` is the global twin and stays generic.
5. Docs: ADR for the local-gate decision (this is a real architectural decision — the merge gate moves off CI onto one machine); `docs/next-steps.md` — rewrite the 2026-08-19 CI item from 🔴 OWNER ACTION to a recorded decision, correct the 2026-08-14 flake item per AC1, add the flip-public restoration trigger; `docs/lessons.md:10` corrected per AC1; `docs/code-map.md` row for the gate driver.

**Cross-package impact:** none at runtime — no package source changes. The gate is a repo-level tool.

**Test plan:** `node --test scripts/gate-local.test.mjs`, matching the existing `check-threat-model` / `check-sandbox-guard` pattern (both are `node --test` + a driver, and both are already wired into the root `test` script — the new one joins them there).

**Spec-sync:** not applicable, no protocol bytes.

**Verification of the whole thing:** run `pnpm run gate:local` end-to-end on this branch and paste the verdict into the journal. The gate must prove itself before it is trusted to gate anything.

## Decisions & surprises

**(2026-08-20, Gate-2 investigation) The vitest flake did not reproduce — 8/8 green.** The recorded diagnosis (next-steps 2026-08-14, `lessons.md:10`) says the default parallel run fails a different 14–31 tests each time, all `Test timed out in 5000ms`, and that `--no-file-parallelism` was 1254/1254 green. Measured today on clean `main` (`a8bad77`, 11 CPUs, node 22.13.1):

- 5 consecutive `vitest run` (full parallel, no flags): **1303/1303 passed**, 125/125 files, ~29–31 s each.
- 3 further runs under induced contention (8 busy-loop processes pinning cores): **1303/1303 passed**.
- 1 full `pnpm exec turbo run test --force` as CI runs it: **23/23 tasks successful**.

Test count moved 1254 → 1303 since the note was written, and four playground-touching PRs landed in between (#76, #78, #80, #86) — so the suite is not the one that was measured. Three readings, and I cannot yet separate them: (a) something in those four PRs incidentally fixed it; (b) it is machine-state-dependent in a way 8 runs did not sample; (c) the original 5 s timeouts were themselves an artifact of a loaded machine at that moment.

This is why AC1 refuses to make a config change. Raising `testTimeout` or capping `maxThreads` now would be an edit whose effect cannot be observed — and per `lessons.md:10`'s own logic, it would permanently blunt the signal that distinguishes a genuine red from contention. The honest move is to record the measurement, keep `--no-file-parallelism` as the documented confound-remover, and let the next real red carry the evidence.

**Consequence for the task's premise:** the flake was cited (by me, earlier this session) as the P0 that had to be fixed before a local gate could be trusted. On this evidence it is not currently blocking. The gate work proceeds on its own merit; the flake item becomes a watch, not a fix.

**(2026-08-20, Gate-2 investigation) The e2e suite is 8-red on clean `main`, and its env gate is dormant.** Measured this session on `a8bad77`: **64 passed / 8 failed / 1 skipped in 5.6 minutes**. This is the finding that most changes the shape of decision 3 — adopting e2e into the gate means adopting 8 reds, and a gate that is red on its first run is a gate its owner learns to ignore. Hence AC9.

Four failures are the documented 2026-08-18 starters-connect DEGRADED rows (github/spotify/weather content pins + the read-only row). **Four are undocumented**: `connection-declaration.spec.ts` T8 ×2 and T8b ×1, and `connection-wizard.spec.ts:328` (P3-AC6/Q5, "the run surface carries NO inference affordance"). That last one is a C2-adjacent assertion about an absent affordance, so it wants diagnosis rather than reflexive quarantine.

Separately: `SNUG_E2E_HAS_APP` is NOT a manual env var — `playwright.config.ts` derives it from `appIsPresent()` (index.html + src/main.tsx + vite.config.ts all present). All three exist today, so `hasApp` is true and the 10 "env-gated" specs DO run. The gate is a vestige of the pre-integration workstream split, not a live suppression — which retires part of the standing "an env-gated spec is a spec nobody runs" worry, though the sweep item itself stands (the mechanism is still there to be tripped by a rename).

**(2026-08-20) Decision 2 was REVERSED by decision 5 — and the reversal changes what a green gate means.** Decision 2 (fully automatic, no confirmation) stood for one exchange before the ~15–20 min wall-clock estimate landed; decision 5 replaces the pre-merge confirmation with a **pre-run leg selection**, which is a better-placed human beat — it sits before the cost is paid rather than after, and it gives the owner the time/assurance dial directly.

The consequence worth stating plainly: **`gate:local` green no longer implies "CI would have been green."** With legs opt-out, a 2-minute default run verifies the workspace and the server smoke leg and nothing else. That is a legitimate trade — most merges are docs or a single package — but it means the gate's honesty obligation grows: it must now report its own coverage, not just its result. Hence AC10 (verdict names the unverified legs, and only `--all` may claim CI equivalence) and AC11 (DESELECTED is a third state, distinct from passed and skipped). Carrying the deselected list into the PR body and the journal is what keeps the durable record truthful about which evidence backed which merge — otherwise `git log` shows a uniform wall of merges whose actual verification varied.

**(2026-08-20) Model pinning is supported.** `model:` in a slash-command's frontmatter accepts the same values as `/model` (full IDs like `claude-opus-5`, or aliases); the override applies for the rest of the current turn and is not saved to settings, so the session model resumes on the next prompt. Caveat: a model excluded by an org `availableModels` allowlist is silently ignored and the session model is kept — so AC8 should be verified by observation once, not assumed.

**(2026-08-20) Open question deferred to the owner** — see Open questions in the journal: whether `/close-session` should auto-merge without a confirmation step. AC7 as written does. That is a genuinely irreversible outward action performed without a human in the loop, on a repo whose CI gate is now a single local command.

## Session journal (append-only, newest last)

### 2026-08-20 — Jeetu + Claude (Opus 5) — session (Gate 1–2)

- **Done**: Read PROCESS.md, TEMPLATE.md, `ci.yml`, both close-session twins, the playground vitest config, both desktop gate drivers, code-map and lessons. Attempted to reproduce the playground flake: 8 full-parallel runs (5 idle, 3 contended) + 1 full turbo run, all green — recorded above. Confirmed slash-command model pinning is supported. Wrote spec + plan; risk tier set HIGH (CI/release config).
- **State**: Task file written. **No branch cut yet, no implementation code written** — stopped at Gate 2 for plan approval per `/start-task` step 5. Working tree clean on `main` at `a8bad77`.
- **Next step**: Owner approves or amends the plan — specifically AC1 (leave the vitest config alone) and the AC7 auto-merge question below. On approval: cut `feat/TASK-20260820-local-ci-gate`, write the RED tests first.
- **Owner decisions (2026-08-20, Gate 2 approved)**:
  1. **AC1 — accept "measure, don't patch".** No vitest config change. The flake becomes a watch item with the 8-run measurement recorded; the next real red carries the evidence.
  2. **AC7 — fully automatic merge, no confirmation.** `/close-session` runs gate → docs → commit → push → PR → merge → switch → fetch with no prompt. Recorded plainly because it is an irreversible outward action gated solely by `gate:local`: the gate's fail-loud property (AC4) is now load-bearing for the repo's history, which is why AC4 grew a second pinned test.
  3. **Scope — the gate EXCEEDS ci.yml.** Playwright/e2e and the `apps/server` smoke leg both come in. AC3 becomes a superset assertion; AC9 is new, because e2e cannot be adopted while 8-red without either fixing or honestly quarantining those rows.
  4. **AC9 — quarantine the 4 documented DEGRADED rows, diagnose only the 4 undocumented ones.** Keeps the task from doubling; every quarantined row still needs a written reason.
  5. **AC7/decision 2 AMENDED — legs are user-selected at `/close-session` time**, defaults workspace+smoke ON, e2e/rust/desktop/release OFF. The confirmation moves from before-merge to before-run. Full automation after that point stands. Owner keeps direct control of the time/assurance trade on every merge.

### 2026-08-20 (cont.) — Claude (Opus 5) — Gate-2 close

- **Done**: Put the ambiguous plan questions back to the owner rather than guessing; recorded answers as decisions 1–5. Investigated both newly in-scope legs before committing: timed e2e (5.6 min, 64 passed / 8 failed / 1 skipped on clean `main`) and traced `SNUG_E2E_HAS_APP` to `appIsPresent()` (dormant, not suppressing). Restructured AC2 into a selectable-leg table; AC3's superset claim now attaches to `--all` only; added AC9 disposition, AC10 (honest partial verdicts) and AC11 (DESELECTED as a third state). Confirmed `gh` is authenticated as `jeetumaker`, so the PR/merge tail is executable.
- **State**: Plan approved and amended through decision 5. **No branch cut, no implementation code.** Working tree clean on `main` at `a8bad77` apart from this task file.
- **Next step**: Cut `feat/TASK-20260820-local-ci-gate` and write the RED tests first — AC3 (ci.yml superset parse), AC4 (injected failing leg + injected skipped leg), AC10/AC11 (verdict strings for full, partial, and deselected runs).
- **Open questions**: none blocking. Two deferred to implementation: (a) the exact diagnosis of the 4 undocumented e2e failures is unknown until they are opened — if one proves to be a genuine product defect rather than a test-fixture issue, it gets its own task rather than expanding this one; (b) whether `--all` should be the default for a `main`-touching merge specifically, revisit once the real cadence is felt.
