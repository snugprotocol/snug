# TASK-20260820-desktop-bundle-targets-macos: restrict the desktop bundle to macOS targets and pin them by test

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: medium (owner decision — `apps/desktop` config change; see [engineering/PROCESS.md](../engineering/PROCESS.md#risk-tiers). Not auto-escalated: it touches no `packages/protocol` schema, no `packages/runner` sandbox/CSP, no `packages/auth`, and no CI/release workflow file — `.github/workflows/ci.yml` is deliberately untouched, see Out of scope)
- **Branch**: `feat/TASK-20260820-desktop-bundle-targets-macos`
- **Packages touched**: `apps/desktop` (config, icons, one new test, one generator script) + `docs/`
- **Spec impact**: none (no `packages/protocol` change → no [SPEC_SYNC.md](../engineering/SPEC_SYNC.md) step, no spec-changelog entry)
- **Related**: [ADR-0021 D8 addendum](../decisions/0021-desktop-shell-transports.md) (the platform decision this enforces) · [threat-model.md](../threat-model.md) R-5 / R-5b · [next-steps.md](../next-steps.md) 2026-08-20 item (1) and the 2026-08-20 DECIDED line · [solutions/2026-08-13-webview2-subframe-ipc-injection.md](../solutions/2026-08-13-webview2-subframe-ipc-injection.md) (root cause) · mirrors `apps/desktop/src/__tests__/netTransportCapability.test.ts` (the discipline being copied)

## Spec (what & why)

ADR-0021's D8 addendum settled the platform question on 2026-08-20: **the desktop shell ships
macOS-only through alpha, beta and 1.0**, because wry's WebView2 backend discards
`for_main_frame_only` and injects Tauri's plaintext invoke key into `sandbox="allow-scripts"`
app iframes — a C1 *and* C2 break with no off-switch at the wry, tauri, or WebView2 layer.

That addendum then says, in its own words, that the decision **"is currently enforced by
documentation alone"**: `apps/desktop/src-tauri/tauri.conf.json` still carries `"targets": "all"`
and `bundle.icon` still ships `icons/icon.ico`, so `pnpm --filter desktop bundle` on a Windows
host still produces an artifact — *nothing in the build refuses*. The only regression detector is
the CI Windows leg staying red for the right reason, and CI has been billing-blocked since
~2026-08-18 (red in ~2 s with zero steps), so a billing red is visually indistinguishable from an
R-5 red. Threat-model **R-5b** states this gap; next-steps queues closing it as its own task.

This is that task: the **enforcement half of a decision already made**. No new decision is being
taken here — the ADR is the decision, this makes the build agree with it. The discipline copied
is `netTransportCapability.test.ts`'s: Tauri bakes bundle config at build time, so the JSON is
the only place the restriction can be *stated*, and a test reading that JSON off disk is the only
place it can be *held*. `icon.ico` goes with it, because R-5b names the `.ico` as part of the same
evidence that a Windows artifact remains producible, and a Windows-only asset in a macOS-only
bundle is exactly the kind of leftover a future reader reads as intent.

**Acceptance criteria** (each becomes at least one test):

1. **`bundle.targets` is the macOS pair and nothing else.** `tauri.conf.json`'s `bundle.targets`
   equals `["app", "dmg"]` — an array, never the string `"all"`, and never containing any of
   `nsis`, `msi`, `deb`, `rpm`, `appimage`. Asserted positively (both macOS targets present) and
   negatively (each of the five non-macOS target names absent), so a widening is caught whichever
   direction it arrives from.
2. **No Windows-only icon ships.** `bundle.icon` contains no `.ico` entry, `src-tauri/icons/icon.ico`
   does not exist on disk, and every path `bundle.icon` names *does* exist (the second half is the
   guard that makes the first half safe to change — a delete that orphaned a config reference would
   otherwise fail only at bundle time, on macOS, months later).
3. **The generator agrees with the shipped set.** `scripts/generate-icons.mjs` no longer emits or
   copies `icon.ico`, and its `SHIP` list matches `bundle.icon` exactly — so re-running the
   generator cannot silently resurrect the file the config just dropped. Asserted by reading the
   generator source, in the same style as `netTransportCapability.test.ts`'s `run-gate.mjs` port
   pin.
4. **The test names its own reason.** The suite carries the ADR-0021 D8 citation in its header, so
   a future reader who wants to widen the targets finds the platform decision rather than deleting
   an unexplained assertion. (Verified by review, not by a meta-test.)
5. **Nothing else about the bundle moves.** `productName`, `identifier`, `version`,
   `fileAssociations`, `bundle.active`, and the `app.windows`/`security` blocks are byte-unchanged;
   `appIcon.test.ts`'s existing 16 per-platform assertions stay green untouched (it decodes only
   the PNGs and the icns — the `.ico` was never parsed there, by its own header note).

**Out of scope**:

- **`.github/workflows/ci.yml` — untouched.** ADR-0021 is explicit that the Windows gate leg must
  stay red for the entire pre-1.0 run and must NOT be softened, because `keyReachable` is the only
  check that reasons about key *reachability*. This task changes what the build produces, not what
  CI proves. The new vitest suite needs no CI edit: it rides `pnpm --filter desktop test`, which
  already runs on both matrix legs.
- **The CI billing block** (owner action, next-steps 2026-08-19). This task reduces the dependence
  on that detector; it does not fix it.
- **A build-time host refusal** (a script or `build.rs` that fails `pnpm --filter desktop bundle`
  loudly on a non-macOS host). Considered and not taken: it is a second mechanism for the same
  claim, and if the Tauri assumption in "Risks" holds, target filtering already yields zero
  artifacts. Revisit only if that assumption turns out false.
- **Any reconsideration of the platform decision itself.** Post-1.0, its own ADR (ADR-0021 D8).
- **The other five threat-model v1 follow-ups** (WhatsApp pseudonymisation into the host,
  `sidecar_wizard_fetch` gate row, classifier fence, R-11 cadence, `export_user_bytes` tests) —
  each is its own task, per that next-steps line.
- **`SECURITY.md`** — its platform paragraph is already correct and its claim does not change; only
  the *strength of enforcement* does, which SECURITY.md does not characterise.

## Plan

### Test plan (Gate 3 — these are written and RED before any config edit)

New file `apps/desktop/src/__tests__/bundleTargets.test.ts`, deliberately modelled on
`netTransportCapability.test.ts`:

- `// @vitest-environment node` with the same reason comment (the suite reads files off disk;
  jsdom rewrites `import.meta.url` to an http URL that `fileURLToPath` refuses).
- Reads `../../src-tauri/tauri.conf.json` via `readFileSync(fileURLToPath(new URL(...)))` — the
  identical accessor shape, so the two suites read as siblings.
- Header comment states the drift being killed, in the reference file's voice: `"targets": "all"`
  admitted `nsis`/`msi` on a platform where C2 is *known false*, and the ADR's own addendum recorded
  that only documentation stood in the way.

| # | Test | Kills |
|---|------|-------|
| AC1 | `bundle.targets` deep-equals `['app','dmg']` | the config drifting back to `"all"` |
| AC1 | `targets` is an Array, and is not the string `'all'` | the string form specifically — it is the *default*, so it is what a regenerated or copy-pasted config lands on |
| AC1 | for each of `nsis`,`msi`,`deb`,`rpm`,`appimage`: not included | a widening that adds one target without touching the two macOS ones |
| AC2 | no `bundle.icon` entry ends in `.ico` | the config half |
| AC2 | `src-tauri/icons/icon.ico` does not exist | the disk half — config and tree can drift apart |
| AC2 | every `bundle.icon` path exists on disk | an orphaned reference introduced *by* this task's delete |
| AC3 | `generate-icons.mjs` source contains no `icon.ico` | regeneration resurrecting it |
| AC3 | the generator's `SHIP` filenames set-equals `bundle.icon`'s basenames | the two lists silently diverging in either direction |
| AC5 | `productName`/`identifier`/`bundle.active`/`fileAssociations` unchanged-in-shape | a careless rewrite of the whole config file |

The AC3 pair is the one worth arguing for: without it, `pnpm --filter desktop generate-icons`
(run for any future icon change) writes `icon.ico` straight back into a tree whose config no longer
names it, and only the AC2 disk assertion would catch it — after the fact, on someone else's branch.

Negative-test posture: AC1's five absent-target assertions and AC2's two absences are the negative
half; this task's whole point is refusing a capability, so the negatives *are* the substance rather
than a supplement.

### Files to touch, in order

1. `apps/desktop/src/__tests__/bundleTargets.test.ts` — **new**, written first, run RED.
2. `apps/desktop/src-tauri/tauri.conf.json` — `"targets": "all"` → `["app", "dmg"]`; drop
   `"icons/icon.ico"` from `bundle.icon`. Nothing else in the file moves.
3. `apps/desktop/src-tauri/icons/icon.ico` — deleted.
4. `apps/desktop/scripts/generate-icons.mjs` — drop `['icon.ico', winOut]` from `SHIP`; update the
   two comments that count the shipped files ("exactly six files" → five) and the closing
   `console.log` summary line that names `icon.ico`. The win master itself stays: it still produces
   the three 32/128 PNGs, which are not Windows-only assets.
5. `apps/desktop/src/__tests__/appIcon.test.ts` — **comment-only**: its header note says `icon.ico`
   "is generated from the same win master … not re-parsed here". Re-word to say it is no longer
   shipped at all (ADR-0021 D8). No assertion changes — `WIN_PNGS` never included it.
6. `docs/threat-model.md` — rewrite **R-5b**: from "enforced by documentation, not by the build" to
   the enforced-and-pinned statement, naming `tauri.conf.json` and the new test path, and keeping
   the honest remainder (a macOS host builds macOS artifacts; the *distribution* claim still rests
   on nobody publishing one). R-5 itself is unchanged — the defect is unchanged.
7. `docs/decisions/0021-desktop-shell-transports.md` — a dated line under the D8 addendum's
   enforcement paragraph recording that the queued restriction landed, with this task id. The
   addendum's original text stays (decisions are append-only, ADR-0027) — the correction is
   additive, so the record still shows what was true on 2026-08-20 and when it changed.
8. `docs/next-steps.md` — prune per ADR-0027: strike item (1) from the 2026-08-20 follow-ups line,
   and update the 2026-08-20 DECIDED line's "**Still OPEN**" clause, which currently cites
   `"targets": "all"` and `icon.ico` by name. The CI-detector half of that clause **survives** —
   the billing block is still open and is still the R-5 detector.
9. `docs/code-map.md` — the "Desktop shell" row's test column gains the new suite; the "Desktop app
   icons" row loses `icon.ico` from its shipped-file enumeration (it names all six today).

### Verification (Gate 5)

- `pnpm --filter desktop test` — the tsc gate plus the full desktop suite (85 today + the new ~9).
- `pnpm run check-threat-model` — R-5b's rewrite must not break TM4/TM5/TM6. Checked ahead: the
  delta ledger hashes `docs/security/*.md` (untouched here), TM5's required markers are `WebView2` /
  `CORS` / `staleness` (all survive), and TM6 is a loose `/macOS[- ]only/` regex. If R-5b's new text
  cites the test path inside an *invariant row*, TM4 requires that path to exist — it will, but the
  citation is going in the residuals prose, not the invariants table, to keep R-5 honest as a
  residual.
- **Dependents:** none. `apps/desktop` is a leaf in the dependency graph (nothing imports it); the
  changed files are its own config, its own icons, its own generator and docs. Root `pnpm test` run
  anyway as the cheap confirmation.
- `pnpm --filter desktop bundle` on this macOS host — the real proof that `["app","dmg"]` still
  produces the `.app` and `.dmg`. This also finally discharges the 2026-08-14 next-steps item
  ("desktop icon has never been seen on a real dock") if the owner eyeballs the result; noted, not
  claimed, since that item wants a human look.
- The in-shell gate (`pnpm --filter desktop gate`) is **not** re-run: it grades CSP/IPC behaviour in
  a running shell and nothing in this diff reaches it. Stated so the omission is a decision, not a
  gap.

### Risks / assumptions

- **Assumption (unverified, load-bearing for the "no Windows artifact" claim):** `tauri build` on a
  Windows host with `targets: ["app","dmg"]` *filters* the requested list against the host's
  supported set and produces nothing, rather than erroring or ignoring the list. I could not confirm
  this from the tree — `tauri-bundler` is not vendored in the local cargo registry (the JS CLI
  downloads a prebuilt binary), so the source that decides this is not readable here. **Either
  behaviour satisfies the task** (no Windows artifact is produced in both cases), which is why this
  is not a blocker; but the R-5b rewrite must be worded to match whichever it is, and must not claim
  "the build refuses" if the build merely produces nothing. To resolve at Gate 4 without a Windows
  host: read the CLI's bundling code for the host-filter step, or accept the weaker, provable wording
  ("no Windows target is requested") — the weaker wording is the honest default and is what I will
  write unless the stronger one gets confirmed.
- The `.ico` delete is irreversible only in the working tree; git history keeps it, and
  `generate-icons.mjs` can re-emit it from the unchanged win master if Windows is ever reconsidered
  post-1.0. Worth stating in the ADR line so the post-1.0 reader knows the asset path is not lost.

## Decisions & surprises

- **No new ADR.** ADR-0021 D8 already decided macOS-only and explicitly queued this enforcement as
  follow-up work; a second ADR would restate a decision rather than record one. The landing is
  recorded as a dated line under D8's addendum instead. (Owner-confirmed at Gate 2 interview.)
- **Risk tier medium, deliberately.** The task is C2-adjacent by subject matter, but it touches no
  High-tier path: no protocol schema, no runner sandbox/CSP, no auth, no CI/release config, no npm
  publish config. It *removes* a capability rather than adding one. Owner set the tier at the Gate 2
  interview after the auto-escalation triggers were checked one by one.
- **`icon.ico` in scope, `ci.yml` out of scope** — both owner decisions at the same interview. The
  first because R-5b names the `.ico` as part of the same evidence; the second because ADR-0021
  requires the red Windows leg to stay exactly as it is.
- Surprise worth recording: `appIcon.test.ts` already documents that it never parses `icon.ico`
  ("ICO entries may be BMP DIBs; the PNGs stand evidence for it"), so the delete costs zero
  assertions. The 32/128 PNGs are generated from the *win* master but are not Windows-only files —
  they must stay.

## Session journal (append-only, newest last)

### 2026-08-20 — Jeetu + Claude — session (Gates 1–2)

- Done: read PROCESS/ADR-0021 (incl. the D8 addendum), threat-model R-5/R-5b, next-steps,
  `netTransportCapability.test.ts`, `appIcon.test.ts`, `generate-icons.mjs`, `ci.yml`,
  `check-threat-model.mjs`, and the `BundleType` enum in `tauri-utils-2.9.3` (valid targets confirmed
  as `deb|rpm|appimage|msi|nsis|app|dmg` — so macOS-only is exactly `["app","dmg"]`). Gate-2
  interview answered: icon.ico in scope, docs updated here, ci.yml untouched, tier medium. Branch
  created off `main` at `69c3112`; task file written with the plan above.
- State: **Gate 2 — awaiting plan approval. No implementation code written.**
- Next step: on approval, write `bundleTargets.test.ts` first and confirm it fails RED against the
  current `"targets": "all"` config, then work items 2–9 in order.
- Open questions: the Tauri host-filtering behaviour noted under Risks — affects only the *wording*
  of the R-5b rewrite, not the change itself. Default is the weaker, provable wording.

### 2026-08-20 — Claude — session (Gates 3–5)

- Done — **Gate 3 (tests first)**: wrote `apps/desktop/src/__tests__/bundleTargets.test.ts` (11
  tests) and confirmed it RED against the real pre-change tree — not by trusting the run order,
  but by restoring `tauri.conf.json`, `generate-icons.mjs` and `icon.ico` from `HEAD` and
  re-running: **7 failed / 4 passed**, each failure naming a fact this task changes. (First
  attempt at that verification used `git stash`, which silently did not take and produced a
  misleading all-green run; the copy-from-`HEAD` method is what the RED claim rests on. Nothing
  was lost — stash list stayed empty and the config was intact throughout.)
- Done — **Gate 4 (implement)**, in plan order: `bundle.targets` → `["app","dmg"]`; `icon.ico`
  dropped from `bundle.icon` and deleted from the tree; `generate-icons.mjs` SHIP list + three
  comments updated; `appIcon.test.ts` header note updated (comment-only, zero assertions moved).
- Done — **docs**: threat-model **R-5b rewritten**, ADR-0021 D8 addendum given a dated
  `**Update 2026-08-20**` paragraph (original text left standing, per ADR-0027 append-only),
  next-steps item (1) pruned + the DECIDED line's "Still OPEN" clause narrowed to the CI
  detector only, code-map's two desktop rows updated.
- Done — **Gate 5 (verify)**: `pnpm --filter desktop test` **139/139 green** (128 + 11 new),
  tsc gate passed · `test:rust` **97 passed / 1 ignored** · `check-threat-model` **130/130** ·
  `check-sandbox-guard` green. No dependents to run — `apps/desktop` is a graph leaf.

**Two findings worth carrying, both of which changed the work:**

1. **The plan's AC3 was wrong about the contract it was pinning.** I planned to assert the
   generator's SHIP list set-EQUALS `bundle.icon`'s basenames. It does not and must not:
   `icon.png` is shipped by the generator and read by tauri as the implicit macOS master, but
   is *not* named in `bundle.icon`. The test now pins the exact relationship (`bundle.icon` +
   `icon.png`), which is strictly stronger than the equality I planned — it still catches a
   sixth file appearing. Caught by the test failing on its first run for a reason I had not
   predicted, which is the argument for writing it first.
2. **A first draft of the "no longer emits icon.ico" test asserted over the WHOLE generator
   file** and so failed on the explanatory comment I had just added — a comment whose entire
   job is to tell a post-1.0 reader which line to restore. Scoped to the `SHIP` block instead.
   A belt that forbids *documenting* the thing it forbids is the wrong belt.
   Also fixed: the non-macOS-target assertions used `.not.toContain` against a value that is a
   STRING (`"all"`) before this change — a substring check that passed vacuously against
   exactly the config this task removes. Now normalised to an array first, and verified failing.

- **Open question RESOLVED** (the one the plan flagged): tauri does *not* reject a foreign
  bundle target at config-parse time — `pnpm exec tauri build --bundles nsis` on this macOS host
  was accepted and proceeded into the build. So the weaker, provable wording is the correct one
  and is what the docs now say: the shipped config **requests** macOS targets only; it is not a
  build-level **refusal**, because an explicit `--bundles` flag overrides config. Both R-5b and
  the ADR update state this distinction outright rather than letting "enforced by the build"
  imply a hard stop. This is also why the out-of-scope host-guard stays out of scope: adding a
  second half-mechanism would imply the hard stop that neither provides.
- Done — **the real bundle, on this macOS host**: `pnpm exec tauri build` exit **0**, reporting
  **"Finished 2 bundles"** — `Snug.app` and `Snug_0.1.0_aarch64.dmg`, and nothing else. The app's
  `Contents/Resources/` carries `icon.icns` alone, and `find`ing the whole bundle tree for `*.ico`
  returns nothing. So the restricted target list still produces both macOS artifacts (the failure
  mode the "keeps both macOS targets" test guards against is not hypothetical — a typo'd list
  would have produced zero) and the dropped icon really is gone from the shipped output, not just
  from the config.
- State: **Gate 5 complete — implementation green and the bundle verified.** Committed on
  `feat/TASK-20260820-desktop-bundle-targets-macos`; no PR opened yet.
- Next step: open the PR (AI review first, then human). Then `/close-session` for Gate 6.
- Open questions: none blocking. The owner's 2026-08-14 "icon never seen on a real dock" item is
  *adjacent* — this build produces the artifact that would settle it — but it wants a human look,
  so it is not claimed here.

### 2026-08-20 — Claude — session (Gate 6 close)

- Done: PR **#84** opened (`feat/TASK-20260820-desktop-bundle-targets-macos` → `main`), carrying
  the two commits (Gates 1–2 plan; Gates 3–5 implementation).
- Done — **lessons** (two, both `## Tests that can fail`, both earned in this session):
  (1) verify a RED by restoring the old bytes with `git show HEAD:<path>`, never `git stash` — a
  stash that silently does not take runs the suite against the ALREADY-FIXED tree and reports
  green, which is exactly the reassuring output a RED check exists to rule out; (2) scope a
  "this string must not appear" assertion to the construct it governs (the `SHIP` array), never
  the whole file, or the belt forbids DOCUMENTING the thing it forbids.
- Done — **doc drift** found and fixed in-branch beyond the planned set: `docs/architecture.md`'s
  D8 paragraph stated the platform resolution but still implied documentation-only enforcement.
  It now names the build restriction, the pinning test, and the request-vs-refuse distinction.
  (The planned doc edits — threat-model R-5b, ADR-0021 D8 dated update, next-steps prune,
  code-map's two rows — landed with the implementation commit.)
- Checked and NOT changed, each for a stated reason: `SECURITY.md` (its platform claim is
  unchanged; only enforcement strength moved, which that document does not characterise) ·
  `.github/workflows/ci.yml` (ADR-0021 requires the red Windows leg to stay exactly as it is) ·
  `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` (untouched, so the sync rule is satisfied trivially) ·
  `docs/spec-changelog.md` + SPEC_SYNC (no `packages/protocol` change — spec impact is none).
- **No ADR written**, deliberately: ADR-0021 D8 already decided macOS-only and queued this
  enforcement as follow-up. A second ADR would restate a decision rather than record one, so the
  landing is a dated `**Update 2026-08-20**` under D8's addendum with the original text standing.
- State: **Gate 6 complete.** Branch pushed, PR #84 open, everything committed. The task file
  moves to `done/` when the PR merges.
- Next step: merge PR #84, then add the `tasks/done/INDEX.md` line and delete this file (ADR-0027
  — git history is the archive).
- Open questions: none for this task. Two adjacent items remain OTHERS' work and are untouched
  here — the CI billing block (owner action; it is still the only detector for an actual R-5
  shell-behaviour regression) and the owner's 2026-08-14 "icon never seen on a real dock" walk,
  for which this session did produce a bundled `Snug.app` but no human has looked at it.
