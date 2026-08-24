# TASK-20260824-centralization-lint-false-positive: centralization lint reds on legal prose; retire the stray ~/node_modules

- **Status**: in-review (Gates 3-5 complete; awaiting review + merge)
- **Owner**: Jeetu
- **Risk tier**: low — test-file change in `packages/knowledge` (the lint itself), no product code, no protocol/runner/auth, no publish/CI config. Owner-selected Low; recorded because `knowledge` is a widely-depended package (the change touches only its `__tests__/`, not `src/` or `prompts/`, so no dependent behaviour moves).
- **Branch**: `fix/TASK-20260824-centralization-lint-false-positive`
- **Packages touched**: `packages/knowledge` (test layer only) · `apps/playground` (one dependency declaration, AC9) + `pnpm-lock.yaml`. Plus one out-of-repo machine-hygiene action (`~/node_modules`) journaled here, and a `docs/next-steps.md` prune.
- **Spec impact**: none — `packages/protocol` untouched, no schema/spec-changelog entry owed ([SPEC_SYNC.md](../engineering/SPEC_SYNC.md) not engaged).
- **Related**: [ADR-0004](../decisions/0004-central-layered-prompt-store.md) (the normative centralization rule this lint is a tripwire for) · [ADR-0055](../decisions/0055-legal-disclosure-posture.md) + PR #125 (introduced `apps/playground/src/legal/eula.ts`) · [next-steps.md](../next-steps.md) items for 2026-08-24 (the stray `node_modules`, the legal follow-ups) · [lessons.md](../lessons.md) "Tests that can fail"

## Spec (what & why)

Two loose ends from the PR #125 / PR #127 sessions, neither of which is a product defect.

**(1) The centralization lint is red on prose it was never meant to police.** `packages/knowledge/src/__tests__/centralization-lint.test.ts` flags any template literal over 400 chars, outside `packages/knowledge`, that matches `PROMPT_MARKER = /You are|MUST respond|CRITICAL|system prompt/i`. `EULA_TEXT` in `apps/playground/src/legal/eula.ts` is a 2874-char literal containing the sentence *"That request tells GitHub your IP address, the time, and the version **you are** running"* ([eula.ts:50](../../apps/playground/src/legal/eula.ts#L50)). That is second-person legal prose, not LLM-bound text — the string's only consumers are the Settings→about screen and the byte-pinned DMG SLA resource. The lint has been red since PR #125 merged (`9d2f56a`), and a permanently-red tripwire trains its only reader to ignore it — the exact failure named in [lessons.md](../lessons.md) ("A red gate with no enforcement behind it is worse than no gate"). Fix the marker, not the EULA: the EULA string is byte-pinned to `apps/desktop/src-tauri/EULA.txt` and to the shipped DMG, so rewording it to appease a lint would drag in `dmgEula.test.ts` and a re-verified release artifact for a test bug.

**(2) A stray `/Users/jeetu/node_modules/` shadows workspace resolution.** 478 MB, 315 packages, outside any repo. It already produced one real, misleading break: Astro 7 imports `parseCookie` from `cookie@2`, node walked up past the repo root and resolved `cookie@0.5.0` from there, and the website build failed with *"does not provide an export named"* — worked around on 2026-08-24 by adding an explicit `cookie: ^2.0.1` to `apps/website`. Evidence it is abandoned scratch, gathered this session: `~/package.json` declares react-native + `@atproto` + `@aws-sdk` + `@react-navigation`, a dependency set no project in the home tree declares (grep for `@atproto/sync` / `react-native-safe-area-context` across every non-`node_modules` `package.json` under `~` returns `~/package.json` alone); four lockfiles from three package managers sit beside it (`yarn.lock` Feb 2025, `package-lock.json` Jan 2026, `pnpm-lock.yaml` Feb 2026) — layered abandoned experiments; and all ten sibling JS projects in the home tree (six MaisonForge repos, KNOWN-Technologies, Indranet, SCCAY, MotionIQ) carry their own `node_modules`, so none is relying on hoisting. **Owner decision this session: delete the directory AND the orphaned manifests.**

**Acceptance criteria** (each becomes at least one test):

1. **AC1 — the false positive is gone.** `pnpm --filter @snugprotocol/knowledge test` passes, `centralization-lint.test.ts` included; `apps/playground/src/legal/eula.ts` is not reported.
2. **AC2 — a real system prompt at a literal's start still trips the lint.** A fixture string beginning `` `You are … `` (backtick immediately followed by the marker — the natural spelling of a system prompt) over 400 chars is still detected. *This is the mutation twin: the first candidate regex `(?:^|\n)\s*You are` MISSED this case, because `TEMPLATE_LITERAL` extracts literals WITH their backticks, so the marker is never at `^` nor after `\n`. Found by probing before writing the plan, not after.*
3. **AC3 — a real system prompt mid-literal (line-anchored, optionally indented) still trips the lint.** Fixtures with `\nYou are …` and `\n  You are …`.
4. **AC4 — second-person prose mid-sentence does not trip it, in either case.** Fixtures `…the version you are running…` and `…the version You are running…` (the regex stays `/i`, so the negative must hold for the capitalized spelling too).
5. **AC5 — the three non-`You are` markers are untouched.** `MUST respond`, `CRITICAL`, `system prompt` fixtures still trip regardless of position.
6. **AC6 — no NEW violation is introduced repo-wide.** Under the tightened marker the lint reports zero violations across `packages/*/src` + `apps/*/src`, i.e. the change removes exactly one finding and adds none. (Verified by probe this session: OLD = 1 violation, NEW = 0.)
7. **AC7 — the known-limitations header records this class.** The test's header comment gains the false-POSITIVE surface (human prose using second person mid-sentence) alongside the false-NEGATIVE surface it already documents, so the next reader does not re-loosen the marker.
8. **AC8 — `~/node_modules`, `~/package.json` and the four lockfiles are gone**, and `pnpm test` at the Snug repo root plus a website build both stay green afterward. Journaled below with UTC timestamps and the pre-delete inventory (this is an out-of-repo machine action, so the journal entry IS its record).
9. **AC9 (added mid-task, owner-approved) — `apps/playground` declares the `zod` it imports.** `apps/playground/src/agent/cards.ts` does `import { z } from 'zod'` while `apps/playground/package.json` declared nothing; it was resolving by walking up into the stray tree. `desktop#build` compiles playground source through the vite alias, so the deletion turned that into `error TS2307: Cannot find module 'zod'`. Fixed by declaring `zod: ^4` (matching `packages/protocol` and `apps/server`; zod@4.4.3 was already in the store). A cache-busted `turbo run test --force` builds `desktop` clean, and root `pnpm test` exits 0.

**Out of scope**:
- Rewording `EULA_TEXT` or touching `apps/desktop/src-tauri/EULA.txt` (byte-pinned to a shipped artifact; see above).
- Reverting the `apps/website` `cookie: ^2.0.1` dependency. **Owner decision: keep it.** An explicit dependency on a directly-imported package is correct independent of the shadowing, and it protects any other machine or CI runner with a stray hoisted tree. Recorded here so a future reader does not "clean it up" as dead.
- Broadening the lint's coverage (concatenation-built prompts, runtime-read `.md`, `scripts/`) — the documented false-NEGATIVE surface stays as-is; ADR-0004 remains the normative rule and this test remains a tripwire, not a proof.
- Any ADR. No architectural decision is being made — this is a heuristic's precision being corrected, and ADR-0004's rule is unchanged. The rationale lives in the test's own header comment, which is where the next reader will look.
- The other open 2026-08-24 next-steps items (counsel review of `/terms`, first signed release, `hdiutil` deprecation, the DMG owner walk, TRACKER D-02) — untouched.

## Plan

**Tests FIRST** ([TDD.md](../engineering/TDD.md)). The subject under test is a regex inside a test file, so the honest shape is: extract the marker so it is importable, then write a table-driven spec that pins its behaviour on named fixtures. Without the extraction, AC2–AC5 could only be asserted by re-typing the regex in a second file — the "a fence that restates its data cannot test it" failure from [lessons.md](../lessons.md).

Order:

1. **Extract the marker.** In `packages/knowledge/src/__tests__/centralization-lint.test.ts`, export `PROMPT_MARKER` (and `MAX_LITERAL_CHARS`, `TEMPLATE_LITERAL`) so a sibling spec can import the real value rather than a copy. No behaviour change in this step.
2. **Write the failing spec** — `packages/knowledge/src/__tests__/centralization-lint-marker.test.ts` — importing `PROMPT_MARKER` from (1). Table of fixtures covering AC2–AC5:
   - trips: `` `You are Snug, a host…` `` (backtick-adjacent, AC2) · `\nYou are …` (AC3) · `\n  You are …` (AC3, indented) · `MUST respond …` · `CRITICAL: …` · `…the system prompt at load` (AC5)
   - does not trip: `…the version you are running…` (AC4) · `…the version You are running…` (AC4, capitalized)
   Run it: the two AC4 rows are RED against the current marker, everything else green. **Capture that red output into the journal** — per [lessons.md](../lessons.md), a test never seen to fail tests nothing.
3. **Tighten the marker** to `` /(?:^|[\n`])\s*(?:You are\b)|MUST respond|CRITICAL|system prompt/i ``. Rationale, to go in the code comment: `You are` is the one marker that occurs naturally in ordinary second-person prose, so it alone is anchored to the start of a line or of the literal; the `[\n\`]` class (not bare `\n`) is what catches a prompt written as the literal's first characters, since `TEMPLATE_LITERAL` matches include the surrounding backticks. `\b` prevents `You aren't` from matching. The other three markers stay unanchored — they do not occur in prose.
4. **Add the AC6 repo-wide assertion** to `centralization-lint.test.ts`: it already walks every file and collects `violations`; assert the list is empty (it does) — this is the existing test, and it turns green at step 3. No new walk needed; AC6 is satisfied by the existing spec passing.
5. **Update the header comment** (AC7): add the false-POSITIVE surface to the existing KNOWN-limitations block, naming the eula.ts case and the reason the anchor is written the way it is.
6. **Mutation-check** (both directions): (a) revert the regex to the old one → the two AC4 rows go red AND `centralization-lint.test.ts` goes red again; (b) drop the backtick from the `[\n\`]` class → the AC2 row goes red. Both restored by inverse edit, never `git checkout` — the file carries uncommitted work ([lessons.md](../lessons.md), 2026-08-21).
7. **Run the suites** ([architecture.md](../architecture.md) graph): `knowledge` ← `server`, `playground`, `desktop`, and `sdk` dev-depends on it. The change is confined to `__tests__/` and moves no exported behaviour, so dependents cannot be affected — but per Gate 5's "in doubt → root", run root `pnpm test` anyway, which also serves as AC8's post-delete green.
8. **The `~/node_modules` deletion (AC8)** — sequenced AFTER step 7's baseline so a regression is attributable:
   - record the inventory first (`ls ~/node_modules > ` a journal-pasted list, `du -sh`, the four lockfile paths + sizes) — the journal is the only record once the bytes are gone;
   - `rm -rf ~/node_modules ~/package.json ~/package-lock.json ~/pnpm-lock.yaml ~/yarn.lock`;
   - re-run root `pnpm test` and `pnpm --filter website build` (the build that broke originally) — both green, or the deletion is reverted-by-reinstall and the finding journaled.
9. **Prune `docs/next-steps.md`** (ADR-0027, distill-don't-accumulate): the 2026-08-24 stray-`node_modules` item is fully resolved by this task → delete it. The PR #125 legal follow-ups stay untouched.
10. **Gate 6** `/close-session`: journal, `lessons.md` entry if the AC2 near-miss generalizes (candidate rule: *a lint's subject is the extracted TOKEN, not the source text — check what your matcher is actually handed before anchoring a pattern to `^`*), commit, PR.

**Cross-package impact**: none at runtime. `packages/knowledge/src/` and `prompts/` are untouched, so `server`/`playground`/`desktop`/`sdk` see no change; only `knowledge`'s own test lane moves.

**Spec-sync impact**: none — `packages/protocol` untouched.

**Files to touch**:
- `packages/knowledge/src/__tests__/centralization-lint.test.ts` (export the constants; tighten `PROMPT_MARKER`; extend the header comment)
- `packages/knowledge/src/__tests__/centralization-lint-marker.test.ts` (new)
- `docs/next-steps.md` (prune the resolved item)
- `docs/tasks/active/TASK-20260824-centralization-lint-false-positive.md` (this file; journal)
- Out of repo: `~/node_modules`, `~/package.json`, `~/package-lock.json`, `~/pnpm-lock.yaml`, `~/yarn.lock` (deleted)

## Decisions & surprises

- **The first candidate regex was wrong, and the probe is what said so.** `(?:^|\n)\s*You are` clears the EULA and looks right — but `TEMPLATE_LITERAL` hands the matcher the literal *including its backticks*, so `` `You are Snug…` `` has the marker at index 1, neither at `^` nor after a `\n`: the single most likely spelling of a real system prompt would have walked straight through the tightened lint. Caught by running positive twins before writing the plan rather than after. Promoted to AC2 so the shape is pinned forever, and it is the strongest candidate for a `lessons.md` rule at Gate 6.
- **Why fix the marker rather than exempt the path.** An exemption for `apps/*/src/legal/` creates an unlinted region and buys exactly one fix; the next piece of second-person prose anywhere in the repo needs another exemption. The marker was simply imprecise — `You are` is the one entry in the set that occurs in ordinary English — so precision belongs in the marker.
- **Why no ADR.** ADR-0004's rule ("all LLM-bound prompt content lives in `packages/knowledge/prompts/`") is untouched; only the precision of the tripwire that approximates it changes. Per [ADR-0027](../decisions/0027-docs-memory-distilled-not-accumulated.md), a decision that changes no doctrine belongs in the code comment and the task journal, not a new ADR. Flag at review if you disagree.
- **`~/node_modules` evidence, for the record** (the directory will not exist to re-check): 478 MB / 315 top-level entries / `.pnpm` with 505 entries / `.bin` carrying `react-native`, `metro`, `terser`, `pino`. `~/package.json` declares nine deps and `packageManager: yarn@1.22.19`, while a `pnpm-lock.yaml` and an npm `package-lock.json` sit beside it — three package managers over three separate sessions, none of them this repo's.

## Session journal (append-only, newest last)

### 2026-08-24 16:5X UTC — Jeetu (with Claude) — session (Gates 1–2)

- **Done**:
  - Reproduced the lint red: `npx vitest run --root packages/knowledge src/__tests__/centralization-lint.test.ts` → 1 failed, `apps/playground/src/legal/eula.ts: 2874-char template literal with prompt markers`. Traced the trigger to `eula.ts:50` ("the version you are running") via `grep -inE "You are|MUST respond|CRITICAL|system prompt" apps/playground/src/legal/*.ts` — confirmed false positive; the string's consumers are the about screen and the DMG SLA resource, no LLM path.
  - Probed the fix repo-wide before planning (scratch script, both regexes over the same walk): OLD → 1 violation (eula.ts), NEW → 0. No new findings introduced.
  - Positive-twin check surfaced the backtick gap in the first candidate regex (see Decisions) → corrected to `` [\n`] `` before it reached the plan.
  - Gathered the `~/node_modules` evidence: orphaned `~/package.json` (no other home-tree `package.json` declares `@atproto/sync` or `react-native-safe-area-context`), four lockfiles / three package managers, all 10 sibling projects self-contained.
  - Owner decisions taken: tighten the regex (not a path exemption, not an EULA reword); delete `~/node_modules` **and** the orphaned manifests; **keep** the `apps/website` `cookie` dep; one task, Low tier.
  - Branch `fix/TASK-20260824-centralization-lint-false-positive` cut off clean `main` @ `f55193c`; task file written.
- **State**: Gate 2 complete, plan written, **awaiting owner approval. No implementation code written.**
- **Next step**: on approval → plan step 1 (export the constants), then step 2 (the failing marker spec) — capture the red before touching the regex.
- **Open questions**:
  1. Confirm "no ADR" is right (see Decisions) — the alternative is a two-line ADR recording that the lint's `You are` marker is line-anchored on purpose, so a future reader does not widen it.
  2. AC8 runs root `pnpm test` twice (once before the delete as baseline, once after). Fine, or is the post-delete website build alone enough?

### 2026-08-24 17:2X UTC — Jeetu (with Claude) — session (Gates 3–5)

- **Done** (plan followed in order; deviations noted):
  - **Step 1 — extracted the primitives.** Moved `CODE_EXTENSIONS` / `PROMPT_MARKER` / `MAX_LITERAL_CHARS` / `TEMPLATE_LITERAL` out of `centralization-lint.test.ts` into `__tests__/helpers.ts` (the package's established shared test-layer module, already imported by 8 specs) rather than exporting from a `.test.ts` — importing across test files would make vitest collect the exporter twice. Checked first that sharing is safe: `TEMPLATE_LITERAL` carries `/g` but is only used via `String.prototype.match`, which resets `lastIndex`; `PROMPT_MARKER` has no `/g`, so `.test()` is stateless.
  - **Deviation, self-corrected:** I first wrote the TIGHTENED regex into helpers in the same step — i.e. before the failing spec existed. Reverted it to the old value and proceeded in plan order, so the red below is a real red and not a retrofit.
  - **Step 2 — captured the RED.** New `centralization-lint-marker.test.ts`, 10 rows, importing the real `PROMPT_MARKER` (never a retyped copy). Against the OLD marker: **3 failed | 7 passed** — failing exactly the three AC4 prose rows, with AC2/AC3/AC5 green. That asymmetry is the evidence the AC4 rows exercise the defect rather than passing for free.
  - **Step 3 — tightened** to `/(?:^|[\n\`])\s*(?:You are\b)|MUST respond|CRITICAL|system prompt/i`. Both lint specs green: **11/11**.
  - **Steps 4+6 — AC6 and the mutation checks.** The existing repo-wide spec turns green at step 3, which IS AC6. Mutations, both restored by inverse edit (never `git checkout` — the tree carried uncommitted work):
    - **A, revert to the old unanchored marker** → 4 failed: the three AC4 rows **and** the repo-wide lint. Confirms the fixtures and the real eula.ts finding are one defect.
    - **B, drop the backtick from the anchor class** (`[\n\`]` → `[\n]`) → **exactly 1 failed: AC2**. Note the repo-wide lint stayed GREEN under this mutation — the near-miss is invisible to the existing test, and only AC2 catches it. That is the justification for the new spec file existing at all.
  - **Steps 5+7 — header comment (AC7)** records the false-POSITIVE surface beside the false-NEGATIVE one, names the eula.ts case, points at helpers.ts for the `[\n\`]` rationale and at the marker spec for the rows, and tells the next reader not to re-loosen without adding a fixture. Also refreshed the stale sentence in the false-negative block that still quoted the old unanchored marker.
  - **Step 8 — suites.** `knowledge` 19 files / **195 tests** green. Root `pnpm test` **exit 0**, 25/25 tasks (exit code read, not the summary line).
  - **Step 8 — `~/node_modules` deleted.** Inventory captured first (below). Removed `~/node_modules` + `~/package.json` + `~/package-lock.json` + `~/pnpm-lock.yaml` + `~/yarn.lock`; verified `/Users/jeetu/SnugProtocol/snug/node_modules` untouched. **After:** root `pnpm test` **exit 0** (25/25) and `pnpm --filter website build` **exit 0** (26 pages) — the build the shadowing originally broke.
  - **Step 9 — pruned** the resolved `next-steps.md` item (ADR-0027), carrying forward the two facts that must outlive it: the deletion's verification, and that `apps/website`'s `cookie: ^2.0.1` **stays** (so nobody removes it as dead). `check-website-sync` green after the edit.
- **Flakes seen and dismissed, with evidence** (neither related to this change):
  - `packages/db` — 3 timeouts (`encrypted-sync`, `legacy-adoption`, +1) on the first root run, all `Test timed out in 5000ms`. Serial: **419/419**. Parallel re-run: **419/419**. Not reproducible; `packages/db` has no dependency on `knowledge` and this diff touches only `knowledge/__tests__/`. This is the known db load flake already tracked in open-threads.
  - `packages/knowledge/no-ancestor-tokens.test.ts` — timed out at 5040ms on a `--force` (cold-cache, 19 concurrent tasks) run. It imports `renderedStore` from the helpers file I edited, so I did NOT hand-wave it: timed the file on **clean main** (stashing this task's work) at 822/831/785 ms versus 800 ms on this branch — statistically identical. It is an inherently ~800 ms test against a 5000 ms budget that only loses under heavy contention. Pre-existing; my additions to helpers.ts are module-level constants that `renderedStore` never touches.
- **AC9, added mid-task (owner-approved) — the deletion unmasked a latent resolution defect, and a CACHED build hid it.**
  - The first cache-busted run (`turbo run test --force`) failed `desktop#build` with `error TS2307: Cannot find module 'zod'` in `apps/playground/src/agent/cards.ts`, plus a cascade of `TS7006`/`TS2339` from the lost types. `apps/playground` imports `zod` and **declares it nowhere**; it had been resolving by walking up into `~/node_modules` (zod is in the deleted inventory). `apps/desktop` compiles playground source via the vite alias, so it is the build that noticed.
  - **The part worth remembering: my earlier "root pnpm test exit 0, 25/25" after the deletion was replaying a CACHED `desktop#build` produced BEFORE it.** turbo's `test` `dependsOn: ["build"]`, so this was inside the gate the whole time — the gate simply never re-ran the build. Exactly the 2026-08-24 lesson already in `lessons.md` ("turbo restores cached `dist/**` over stale files"), met from the other direction: not stale outputs served as fresh, but a stale PASS served as a fresh one. A deletion that changes module RESOLUTION invalidates every cached build in the repo, and turbo has no way to know that — the inputs it hashes are all inside the repo.
  - Fixed by declaring `"zod": "^4"` in `apps/playground` — the same shape as the `cookie` fix in `apps/website`, and matching what `packages/protocol` and `apps/server` already declare (zod@4.4.3 was already in the store; pnpm linked it without a download). `pnpm-lock.yaml` updated. `pnpm --filter desktop build` exit 0; `turbo run test --force` builds every package clean; root `pnpm test` **exit 0** (25/25 + all seven `check-*` scripts, threat-model 175/175).
  - Not caused by this task — unmasked by it. The declaration was always missing; the stray tree was papering over it, which is precisely the hazard the deletion was for. Had this landed any other way, it would have surfaced on the next contributor's clean clone or on a CI runner with no home-level tree.
- **db flake, second sighting**: the forced run also failed `container.test.ts` (a DIFFERENT test from the first sighting's three), again `Test timed out in 5000ms`, again **419/419 green serially**. Varying set = contention, not a break; consistent with the tracked db load flake.
- **State**: Gates 3–5 complete. All 9 ACs met. Six files changed: four test-layer/docs, plus one `apps/playground` dependency declaration and its lockfile entry. No product SOURCE changed, no protocol, no spec impact.
- **Next step**: AI review of the diff + this file, then PR. Gate 6 `/close-session` after — including the candidate `lessons.md` rule below.
- **Open questions**: both Gate-2 questions were answered by the owner's approval — no ADR (the rationale lives in the test header, which is where the next reader looks), and the double root run stays (baseline + post-delete, so a regression would be attributable).

#### Candidate `lessons.md` rule (for Gate 6)

**Three rules; (1) and (2) were earned the hard way, mid-task.**

**(1) Deleting something OUTSIDE the repo invalidates caches INSIDE it — force a rebuild before believing the green.** After removing a stray `~/node_modules`, root `pnpm test` exited 0 with 25/25 and it was meaningless: turbo's `test` `dependsOn: ["build"]`, and `desktop#build` was replayed from cache, built while the stray tree still existed. The honest run (`--force`) failed immediately on `Cannot find module 'zod'`. Turbo hashes inputs it can see, all of them inside the repo, so a change to module RESOLUTION is invisible to it by construction — the cache cannot know the answer changed. Sibling of the 2026-08-24 rule about cached `dist/**` over stale files, one level up: there a stale OUTPUT was served as fresh, here a stale PASS was. Any change to the environment a build resolves against (a deleted hoisted tree, a package-manager switch, a Node major, a moved global store) makes every cached build in the repo a lie until it is re-run with `--force`.

**(2) An implicit dependency is invisible until the thing that satisfied it goes away — and the gate that should catch it may be cached past.** `apps/playground` imported `zod` and declared it nowhere, resolving up into a directory belonging to no project. It would have broken on the next clean clone or any CI runner without a home-level tree; it happened to break here because this task deleted the crutch. When a fix's whole purpose is to remove an ambient fallback, the verification is not "the suite still passes" but "the suite still passes **with every cache cold**" — the ambient thing was, by definition, never in the repo's inputs.


**(3) A lint's subject is the TOKEN its extractor hands over, not the source text you picture — check what the matcher actually receives before anchoring a pattern to `^`.** Tightening `PROMPT_MARKER` to clear a false positive, the obvious `(?:^|\n)\s*You are` cleared the EULA and read correctly — but `TEMPLATE_LITERAL` extracts literals **with their surrounding backticks**, so `\`You are Snug…\`` carries its marker at index 1: neither at `^` nor after a newline. The most natural spelling of a system prompt would have walked straight through the lint, and the repo-wide test would have stayed green while the tripwire quietly stopped tripping — a false NEGATIVE introduced while fixing a false POSITIVE, which is strictly worse than the red it replaced. Caught only by running positive twins against the real extractor's output before the plan was written. Anchoring is a claim about where the subject STARTS; when an extractor wraps, trims, or joins its input, that claim is about the wrapper, not the text.

#### `~/node_modules` inventory (deleted 2026-08-24 — this is the only surviving record)

```
478M   /Users/jeetu/node_modules
315    top-level entries        502  .pnpm entries
-rw-r--r--  264038  Jan  9 2026  ~/package-lock.json
-rw-r--r--     560  Mar 16      ~/package.json
-rw-r--r--  149009  Feb  5 2026  ~/pnpm-lock.yaml
-rw-r--r--  155536  Feb  6 2025  ~/yarn.lock

~/package.json dependencies (declared by NO project in the home tree):
  @atproto/api ^0.13.35 · @atproto/identity ^0.4.6 · @atproto/sync ^0.1.13
  @aws-sdk/client-dynamodb ^3.743.0 · @aws-sdk/lib-dynamodb ^3.743.0
  @react-navigation/bottom-tabs ^7.8.5 · @react-navigation/native ^7.1.20
  react-native-safe-area-context ^5.6.2 · react-native-screens ^4.18.0
  packageManager: yarn@1.22.19

.bin: acorn baseline-browser-mapping browserslist cborg dotslash esparse esvalidate
  fxparser image-size is-docker js-yaml jsesc json5 loose-envify metro
  metro-symbolicate mime mkdirp nanoid node-gyp-build* pino print-chrome-path
  parser react-native rimraf semver terser tlds update-browserslist-db yaml
```
