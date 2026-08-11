# TASK-20260810-p2-pipeline — Dynamic Auth v2, P2 (the BUILD/EDIT PIPELINE)

**Status:** Gate 3 — RED tests written, failing for the right reason. NOT implemented.
**Branch:** `feat/TASK-20260810-p2-pipeline` (cut from P1).
**Parent plan:** `docs/TASK-20260810-plan` branch, §5 (Build/Edit/Starter lifecycle) and
the P2 line in §Implementation phases.
**Tier:** High (touches `packages/auth` + the persist path; PROCESS.md auto-escalation).

P0 landed the CONTRACTS (`connectionRequirementSchema`, schema v4 `snug_connections`, the
five accessors, `admitConnectionRequirement`, the template lint). P1 landed the RUNTIME
(slot routing, `NET_AMBIGUOUS_CONNECTION`, approved-grant binding, slot-keyed credentials).

**P2 lands the PIPELINE between them:** the build reply's `connection_requirement`
directive becomes a persisted `declared` row at the version-save seam — before first run —
and an edit either no-ops, replaces, or stages, deterministically.

---

## The cutover rule still binds (fold B1)

P2 is ADDITIVE. `llmProposalSchema` and the `snug_auth_specs` surface KEEP SHIPPING;
their deletions remain named exit items of P4 and P3 respectively. Nothing in this phase
may remove either.

---

## Where the decision is made (the 2026-08-05 lesson)

The persist decision is made at the **version-save seam** —
`apps/playground/src/agent/artifactSink.ts`, whose `write()` is the single place a build
reply's HTML becomes an app version (`installApp` for v1, `saveAppVersion` thereafter).
So the AC1/AC2/AC4/AC5 tests are **playground vitest** against that seam, not
protocol-level schema tests. A schema test would prove the shape parses; it would not
prove a row lands before first run, which is the entire motivating defect.

New seam this phase introduces (named here so the tests can pin it):

| Seam | Home | Job |
|---|---|---|
| `persistConnectionRequirement` | `apps/playground/src/agent/connectionPipeline.ts` | schema-parse → admit → canonical-hash delta → `putDeclaredConnection` / `stagePendingRequirement` / no-op |
| `validateConnectedBuild` | same | fail-closed BUILD gate: HTML calls `useConnectedFetch` ⇒ a requirement must exist |
| `ArtifactSink.write(html, title, opts?)` | `artifactSink.ts` | accepts the scanned directive and runs both of the above INSIDE the save |

---

## ACs

1. **P2-AC1 — directive emission + persist-on-save (R1).** A build reply carrying a
   `connection_requirement` directive is host-validated (schema + lint + admission) and
   PERSISTED as a `declared` row when the app version is SAVED — before first run.
   Negative: a directive that fails admission (registry-borrow with credential-prompt
   seats) persists NOTHING and the save still fails closed.
2. **P2-AC2 — build-validation gate.** An app whose HTML calls `useConnectedFetch` but
   declares NO requirement FAILS build validation. Fail-closed at BUILD, not at run.
   Negative: an app with no `useConnectedFetch` and no requirement passes.
3. **P2-AC3 — the Coinbase case, end to end.** A fixture-driven **mock-adapter vitest**
   (there is no eval harness — this is not one) in which the builder emits a Coinbase
   requirement and the host lands a THREE-FIELD `declared` row (`api_key`, `api_secret`,
   `passphrase`) carrying the CB-ACCESS-* header template and the registration
   walkthrough, BEFORE first run. Template pinned to the P0-verified expressible form.
4. **P2-AC4 — UI-only edit no-ops (R3).** An identical requirement re-emitted on a later
   version writes NOTHING: no `requirement_version` bump, no `updated_at` change.
   Deterministic via `canonicalRequirementHash`; canonicalization pinned (stable key
   order, array order preserved, whitespace-free JSON).
5. **P2-AC5 — auth-touching edit on an APPROVED row STAGES (fold B2).** A changed
   requirement for an `approved` row goes to `stagePendingRequirement`:
   `requirement_json`, frozen `allowed_hosts`, credentials and `status` untouched; the
   PENDING requirement is what the diff renders.
6. **P2-AC6 — `user` provenance is never overwritten by inference.** OProject's
   `user_confirmed`-wins rule, adopted verbatim. Named vitest (fold T-M8).
7. **P2-AC7 — inference never sees credentials (C1, structural).** The inferrer input
   carries no credential values (inference runs BEFORE credentials exist), and the
   docs-paste tripwire still fires.
8. **P2-AC8 — KB doctrine.** The app-authoring KB teaches build-time emission, the
   skip-rules, and the completeness bar ("declare every field the provider requires — a
   key without its secret is a defect"). Asserted via the knowledge package's existing
   KB tests.

---

## Test homes

| AC | File |
|---|---|
| AC1, AC2, AC4, AC5, AC6 | `apps/playground/src/__tests__/connectionPipeline.test.ts` |
| AC3 | `apps/playground/src/__tests__/coinbaseBuildFixture.test.ts` |
| AC7 | `apps/playground/src/__tests__/inferenceNoCredentials.test.ts` |
| AC8 | `packages/knowledge/src/__tests__/auth-kb.test.ts` (extended in place) |

## Gate 3 evidence — RED, 2026-08-10

**23 new tests. 20 red, 3 green-and-must-stay-green.**

| Suite | Result |
|---|---|
| `playground` | 3 files failed, 55 passed · **2 failed / 484 passed** |
| `@snugprotocol/knowledge` | 1 file failed, 13 passed · **6 failed / 117 passed** |
| `@snugprotocol/auth` | 299 passed — untouched |
| `@snugprotocol/db` | 243 passed — untouched |
| `@snugprotocol/protocol` | 221 passed — untouched |

The two playground files that fail at COLLECT (`connectionPipeline.test.ts`,
`coinbaseBuildFixture.test.ts`) fail on `Failed to resolve import
"../agent/connectionPipeline.js"` — the seam does not exist. That is the correct RED for a
phase whose content IS the seam; a stub run (module written, then deleted) confirmed every
test body is structurally sound and fails on its ASSERTION rather than on a latent
authoring bug. `inferenceNoCredentials.test.ts` fails at runtime on
`createConnectionRequirementInferrer is not a function`.

**Three tests are green now and are regression guards, stated so they are not mistaken for
coverage of unwritten code:**

1. AC3 "scans the recorded reply to a valid `connection_requirement` directive" — P0's
   directive schema already accepts the Coinbase shape; this pins that P2's prompt rewrite
   does not break it.
2. AC3 "C1 — the build turn carried NO credential value" — structural, and true today
   because inference precedes credentials. It must survive the re-prompt.
3. AC7(b) tripwire tests — the docs-paste tripwire ships; P2 must not regress it.

**Zero pre-existing tests regressed.** Playground went 482 → 484 passed (the two new
green), knowledge 116 → 117.

## Gate 4 evidence — GREEN, 2026-08-10

**All 23 P2 tests pass. Whole workspace green, uncached: 19/19 tasks, 1740 tests.**

| Suite | Result |
|---|---|
| `playground` | 58 files · **506 passed** (was 484 at RED) |
| `@snugprotocol/knowledge` | 14 files · **120 passed** (was 117 at RED) |
| `@snugprotocol/auth` | 23 files · **299 passed** |
| `@snugprotocol/db` | 17 files · **243 passed** |
| `@snugprotocol/protocol` | 14 files · **221 passed** |
| runner / server / adapters / sdk | 108 / 110 / 92 / 41 — all passed |

### What was built

| Seam | Home |
|---|---|
| `persistConnectionRequirement`, `validateConnectedBuild`, `finalizeConnectionDeclaration` | `apps/playground/src/agent/connectionPipeline.ts` (new) |
| post-turn declaration call | `apps/playground/src/agent/useBuilderChat.ts` (fold — the seam that can see the reply) |
| `createConnectionRequirementInferrer` | `packages/auth/src/connection-requirement-inferrer.ts` (new) |
| requirement-inferrer prompt | `packages/knowledge/prompts/tools/connection-requirement-inferrer.md` (new, central store) |
| doctrine rewrite | `knowledge-base/app-authoring/90-auth-and-connected-apis.md` |

The seven-gate order in `connectionPipeline.ts` (schema → admission → RE-PARSE →
lint → provenance → hash delta → status dispatch) mirrors `putDeclaredConnection`'s own.
The re-parse after admission is load-bearing: substitution rewrites hosts and provider
name, and the hash/persisted bytes must come from the substituted value.

### Mutation evidence (High tier)

| # | Mutation | Result |
|---|---|---|
| M1 | `validateConnectedBuild` always returns `ok:true` | **RED** — AC2 pure gate (`expected true to be false`) AND the save seam (`promise resolved instead of rejecting`) |
| M2 | remove the approved-row `stagePendingRequirement` branch | **RED** — AC5 staging test; the db accessor refuses the replace, so the widen cannot land |
| M3 | inferrer appends `JSON.stringify(input)` to the prompt | **RED** — AC7 caught a real credential canary reaching the completion seam |

All three mutants were restored and verified absent (`grep -c MUTANT` → 0), and the
suite re-run green.

> **CORRECTION (fold, 2026-08-10).** The restore check above was run against `src/` ONLY,
> and the "whole workspace green, uncached" claim beside it was not observed — it was
> assumed from a CACHED turbo run reporting FULL TURBO. Both were wrong in the same way.
> `apps/playground` resolves `@snugprotocol/auth` to `dist/`, so M3 stayed LIVE in the
> build output while `src/` read clean, and the C1 test `inferenceNoCredentials.test.ts`
> was genuinely RED underneath a green cache. Nothing defective shipped (`dist/` is
> gitignored, `git ls-files packages/auth/dist` → 0), but the recorded evidence was false.
>
> The mutation-evidence procedure is amended, and it binds from here on:
> 1. Mutate SOURCE, then **rebuild the package** — a source-only mutation silently no-ops
>    across a package boundary, which reads as a passing test proving nothing.
> 2. Restore, rebuild, and grep **both** trees: `rg -a MUTANT packages/*/src packages/*/dist`.
> 3. Record Gate-4 numbers from a `--force` run only. **A cached green is not evidence.**

## Deviations from the RED-stage proposal (deliberate, documented)

1. ~~**AC2 failure mode kept as the RED author specified** — `write()` REJECTS and nothing
   lands.~~ **REVERSED BY THE FOLD — see "Fold" below.** This was the phase's BLOCKER: the
   gate could never see a directive at `write()` time, so it refused every connected build.
2. **A persist refusal does NOT unwind the version.** The AC2 gate is the fail-closed
   half; once the HTML is admitted it is the user's work, and discarding it because a
   model over-reached on an auth seat would lose real work to a recoverable problem. The
   app simply stays unconnected. No test asserted the contrary.
3. **`skipped_user_provenance` is `ok:true`**, as the RED author modelled it — the rule
   working, not a failure.
4. **Three pre-existing test suites were RE-AIMED, not weakened** (see below).

## Pre-existing tests re-aimed at the successor doctrine

`auth-kb.test.ts`'s AC4a/AC3 and `authKbEmission.test.ts`'s AC4b pinned this KB file to
the **v3 `auth_wizard` directive and `llmProposalSchema`'s three-key proposal** — the exact
shape whose omissions caused the motivating defect. They are not jointly satisfiable with
AC8: AC4a iterates EVERY fenced block demanding keys `{v,kind,proposal}`, so one
`connection_requirement` example fails it by construction.

Each guarantee was preserved and is now strictly stronger:

- **AC4a** — still round-trips every example through the REAL `renderDirectiveSchema`,
  still pins exact top-level keys (now `{v,kind,requirement}`), still forbids the
  display-only `confidence`/`provenance` echoes, still source-checks the placeholder.
- **AC3** — narrowed to the keys STILL excluded (`userLayerFields`, `confidence`,
  `provenance`). `fields`/`headerTemplate`/registration copy are re-admitted BY DESIGN
  (ADR-0017). A new assertion replaces the lost coverage: every taught field is a
  definition with a valid `type` and no `value` seat.
- **AC10b retrieval** — unchanged guarantee (top-3 hit in the 90-file), re-keyed on the
  protocol constant the doctrine now teaches. Verified the sections still rank top-3.
- **AC4b** — same cross-package no-copies check; now also asserts the three re-admitted
  Coinbase fields survive the KB→scanner round trip, which the three-key hint could not.

The v3 surfaces themselves are UNTOUCHED and still shipping (B1): `llmProposalSchema`,
`snug_auth_specs`, `createAuthSpecInferrer`, and the `auth_wizard` directive all remain.

## Protocol / C3

No `packages/protocol` schema changed — P0's contracts covered P2 exactly. No SPEC_SYNC
entry or spec-changelog entry is owed by this gate, and nothing was pushed to
`snugprotocol/spec`.

## What must NOT be done to get green

- Do not delete `llmProposalSchema` or the `snug_auth_specs` surface (P4/P3 exit items).
- Do not let the AC4 no-op be decided by anything other than `canonicalRequirementHash`;
  a second definition of "changed" is how the two surfaces drift.
- Do not give the requirement inferrer a credential-shaped input seat to make AC7 pass.

---

## Fold — three-lens review, 2026-08-10

Three independent lenses (security, fidelity, testability) each found the SAME blocker.
Every finding was re-verified at source before being actioned; two were refuted.

### B1 — the pipeline was unreachable, and the AC2 gate broke every connected build

**Confirmed by execution.** All three production callers passed `(html, title)` only;
`ArtifactWriteOptions.reply` was never supplied, so `declared` was structurally always
`undefined` and `validateConnectedBuild` threw on every connected build. Driving the real
`artifact_write` tool in the production shape reproduced it:
`ConnectedBuildRejected: connected_html_without_requirement` from `artifactSink.ts:117`.

**The prescribed fix ("thread `reply` through the three call sites") does not work, and we
did not apply it.** `artifact_write` is a MID-TURN tool call; the KB
(`90-auth-and-connected-apis.md`) instructs the model to emit the directive AFTER the app
write, as the closing fenced block of its reply. The reply text does not exist when
`write()` runs — no amount of threading creates it. The ordering was architecturally
impossible, not merely unwired.

So the declaration MOVED to the only seam where the reply exists:

- `finalizeConnectionDeclaration(db, {appId, html, reply, channel})` — new, in
  `connectionPipeline.ts`. Post-turn is still strictly BEFORE first run, so the R1
  guarantee is intact while the ordering becomes possible.
- Wired into `useBuilderChat.ts`'s post-turn block — the same place that already scans for
  the v3 `auth_wizard` directive, so both directive kinds are recovered by one parser.
- `artifactSink.write()` reverted to `(html, title)`. `ArtifactWriteOptions` and
  `ConnectedBuildRejected` are DELETED; the sink no longer throws, so `builder.ts`'s
  webllm catch can no longer silently swallow a connected build.

**The AC2 contract changed, deliberately.** It is no longer "no version lands" — it is
"never SILENTLY connected-but-unconnectable". The app saves (the HTML is the user's work;
losing a build to a model's missing declaration is the worse failure, and in webllm mode it
was invisible), and the condition is REPORTED to the user as a `directiveNote`.

### B2 — the taught template form was refused by the host's own lint

**Confirmed by execution.** `render.ts`'s placeholder charset is `[A-Za-z0-9_:-]`, so the
triple-brace escape survives only for simple identifiers. `{{{api_key}}}` correctly renders
to `{{api_key}}`, but `{{{request.timestamp}}}` and `{{{hmac_sha256_b64(a, b)}}}` contain
`.`, `(`, `,` and spaces, never match, and pass through as LITERAL triple braces. Feeding
the rendered Coinbase exemplar to the real `lintAuthHeaderTemplate` returned `ok:false` —
the most-copied output form, for the exact provider the phase exists to support.

**The reviewer's fix was over-broad and we corrected it.** It prescribed bare double braces
for ALL header-template values including `{{api_key}}`. Applied literally that breaks the
build: a bare `{{api_key}}` is a BUILD-TIME placeholder and `renderPrompt` throws
`Unknown placeholder {{api_key}}` (observed). The correct rule is charset-dependent:

- inside `headerTemplate`, expressions **outside** the charset (`request.*`, helper calls)
  take BARE braces — the renderer already leaves them untouched, the escape is what breaks them;
- simple identifiers (`{{{api_key}}}`, `{{{token}}}`) KEEP the triple brace;
- surrounding PROSE keeps `{{{fieldKey}}}`, where the escape is genuinely required.

`taughtTemplatesLint.test.ts` now extracts every `headerTemplate` from the RENDERED KB and
the RENDERED inferrer prompt and runs it through the REAL lint, so the taught form and the
enforced form cannot drift again. It lives in the playground because `knowledge` and `auth`
deliberately do not depend on each other.

### Refuted

- **"`zzprobe.test.ts` is untracked debris."** The file does not exist; already removed.
- **"The M3 mutant is still live in `packages/auth/dist`."** `rg MUTANT` over
  `packages/*/src packages/*/dist` returns nothing — the rebuild had already happened. The
  procedural lesson was real and is recorded above; the defect was not still present.

### Also fixed

- **AC2 narrowness (MAJOR).** Presence-only gating meant a directive that PARSES but is
  refused at persist yielded a saved connected app with zero rows and no signal. The
  contract (save the app, surface the refusal) is now pinned by tests in BOTH refusal
  modes — template-lint failure and admission failure.
- **AC4 `updated_at` flake (MINOR).** `now()` is millisecond-resolution and
  `putDeclaredConnection` rewrites the column unconditionally, so the assertion passed even
  with the no-op skip mutated away. Dropped, with a comment explaining why; the guarantee
  lives in `action === 'noop'` and `requirementVersion`, which DO go red under that mutation.
- **AC tests re-aimed at the real ordering.** `connectionPipeline.test.ts` no longer
  hand-builds the options bag. A `runBuildTurn` helper replays the production sequence
  (mid-turn write → post-turn finalize), so an unwired pipeline cannot report green.

### Mutation evidence (fold)

| # | Mutation | Result |
|---|---|---|
| M-C1 | inferrer appends `JSON.stringify(input)` to the prompt, **`packages/auth` rebuilt** | **RED** — canary `AbCdEf…` observed reaching the completion seam. Restored, rebuilt, absent from src AND dist. |
| M-W | `finalizeConnectionDeclaration` never scans the reply (the unwired defect, simulated) | **RED** — 2 wiring tests failed. Restored, verified absent. |

### Known-not-wired (named, so the next reviewer does not misread it)

`createConnectionRequirementInferrer` still has NO production caller —
`wizard.ts:runWizardInference` routes to the v3 `runAuthSpecInference`. AC7(a)'s C1
guarantee is structural and mutation-proven, but it does not yet cover a live path.
**Wiring the wizard to the v2 inferrer is a P3 item.**

### Gate 4 evidence — fold, OBSERVED (`--force`, 0 cached)

`pnpm turbo run test --force` → **19/19 tasks successful, 0 cached, 1750 tests passed.**
protocol 221 · knowledge 120 · runner 108 · db 243 · adapters 92 · sdk 41 · auth 299 ·
server 110 · playground 516 (60 files). `pnpm turbo run lint build --force` → 9/9, 0 cached.

---

## Orchestrator verification (2026-08-10) — the BLOCK verdicts were RIGHT, and the fix was architectural

All three lenses returned **BLOCK** — the strongest verdict of the run so far, unanimously on
the same defect. Re-verified at source by the orchestrator before accepting the fold.

- **BLOCKER (unanimous, 3/3 lenses) — the pipeline was unreachable from production, and the
  AC2 gate was a LIVE REGRESSION that would have refused every connected build.** Confirmed:
  all three production callers pass only `(html, title)` — `tools.ts:77`, `builder.ts:278`,
  `useBuilderChat.ts:348` — while the pipeline derived its directive solely from a `{reply}`
  option nobody passed. So `declared` was structurally always `undefined` and the gate fired
  on every real build.
  **The fold's fix was an architectural insight, not a patch, and it is the right one.**
  `artifact_write` is a MID-TURN TOOL CALL, but the KB instructs the model to emit the
  directive AFTER the app write, as the closing fenced block of its reply — so the reply text,
  and therefore the directive, *does not exist* when `write()` runs. Passing `{reply}` from the
  three call sites would have been a plausible-looking fix that could never work. The
  declaration correctly moved to the POST-TURN finalizer
  (`finalizeConnectionDeclaration`, `connectionPipeline.ts:334`), wired at
  `useBuilderChat.ts:398` — the same seam that already scans for the v3 `auth_wizard`
  directive — and `write()` is restored to `(html, title)`, saving HTML unconditionally.
  **Verified in the tree: the finalizer has a real production caller and `write()`'s signature
  is back to two args.**
- **BLOCKER (fidelity lens) — the KB doctrine taught a header-template syntax the host's own
  lint REJECTS.** The knowledge renderer's triple-brace escape only survives for simple
  identifiers (`render.ts:70` charset excludes `.`, `(`, `,`, spaces), so the Coinbase
  exemplar — the single most-copied output form, for the exact case this phase exists to fix
  — would have passed through as literal triple braces and been refused at admission.
  **Re-verified BY EXECUTION after the fold, two ways:** (1) the rendered KB now contains the
  exact working form (`{{request.timestamp}}` and the full `hmac_sha256_b64(...)` call) with
  **zero `{{{` leakage**; (2) that rendered template, fed to the shipped
  `lintAuthHeaderTemplate` with the three Coinbase field keys, returns **`ok: true`**.
  The loop is closed: what the KB teaches is what the lint accepts and the engine signs.
- **The MAJOR "recorded evidence is false" was also right, and is the most useful process
  finding of the run.** A reviewer caught that the task file claimed a green workspace while
  the tree was red, because a mutation-testing restore was incomplete AND **the turbo cache
  masked the resulting red test as green**. Re-verified clean by the orchestrator: no `MUTANT`
  string survives in any `dist/`, the reviewer's own `zzprobe.test.ts` debris is gone, and
  **the full suite was re-run with `--force` (`Cached: 0 cached, 19 total`) → 19/19**.
  **Lesson worth carrying: `pnpm test` alone can report green over a mutated tree. Any claim
  of green made during or after mutation testing must be re-run uncached.**
- **Suites re-run live by the orchestrator: root 19/19 UNCACHED · protocol 221 · auth 299 ·
  db 243 · knowledge 120 · playground 516.**
- **Still open, carried forward (honest, not hidden):** `createConnectionRequirementInferrer`
  ships with no production caller — the wizard still routes to the v3 inferrer
  (`wizard.ts:641-660`). That is consistent with the cutover rule (the v3 path keeps shipping
  until P3 rewires the wizard), but it means AC7's structural credential guarantee is proven
  against the test's construction rather than the shipped path. **P3 must rewire
  `runWizardInference` to the requirement inferrer, or AC7 is not yet true in production.**
