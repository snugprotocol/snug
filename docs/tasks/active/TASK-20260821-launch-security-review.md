# TASK-20260821-launch-security-review: Final pre-launch security review & threat model v3

- **Status**: planned (awaiting Gate 2 approval)
- **Owner**: Jeetu
- **Risk tier**: **high** — reviews and may patch `packages/protocol`, `packages/runner`, `packages/auth`, C1/C2 surfaces (auto-escalated per [PROCESS.md](../engineering/PROCESS.md#risk-tiers))
- **Branch**: `feat/TASK-20260821-launch-security-review`
- **Packages touched**: review = all; fixes = enumerated per confirmed finding (expected: `packages/auth`, `apps/desktop`, `apps/playground`, docs)
- **Spec impact**: none planned. If a spec claim is found unenforced, the correction goes to `docs/spec-drafts/SPEC-v0.3-draft.md` + a spec-changelog entry ([SPEC_SYNC.md](../engineering/SPEC_SYNC.md)) — the owner regenerates the published spec/whitepaper in a fresh session after this task, so this task **corrects the source draft and never pushes downstream**.
- **Related**: [threat-model.md](../threat-model.md) v2.0 · [`docs/security/`](../security/) (12 deltas) · ADR-0040/0045/0046/0047 · `internal/RUNBOOK-flip-public.md` · [lessons.md](../lessons.md) (esp. 2026-08-21 plan-review + signed-artifact entries) · [next-steps.md](../next-steps.md)

---

## Spec (what & why)

Final adversarial security review and consolidated threat model before `snugprotocol/snug` flips public. The bar is **HN Show-HN scrutiny and mass adoption**: the spec must cover what it claims, the code must enforce what the spec claims, every accepted residual must be written down rather than discovered by a stranger, and nothing embarrassing (secrets, machine paths, codenames, personal identifiers) may ship in the public tree or its reachable history.

Three lessons set the method:

1. **2026-08-21 (plan review)** — the highest-yield question is *"the doc says X happens — does the code that must do X actually do it?"* Every reviewer in this task is briefed to verify mechanism claims against named files, not to critique prose.
2. **2026-08-20 (disjoint reviews)** — plan-level and diff-level reviews catch different defect classes. Here the analogue is *claim-level* (threat model / spec / SECURITY.md say it) versus *code-level* (fresh attack surface). Both run.
3. **2026-08-20 (mechanical checks)** — `check-threat-model` proves no delta *moved*; it cannot prove residuals were *carried*. The v2 pass itself shipped with four surfaces re-attacked and the other five only mechanically re-checked. **This task re-attacks the whole surface**, because v2's own §note admits it did not.

Deliberate v2 gap this closes: v2 says "the rest of this document is v1's, re-checked mechanically but not re-attacked."

**Acceptance criteria** (each becomes at least one test or a recorded, evidence-bearing verification):

1. **C1 re-attacked end to end.** Every §5 C1 invariant is re-verified by a fresh-context adversarial reader against the current code, each returning claim → enforcement file:line → test → verdict. Any invariant whose named test would pass with the enforcement removed is reported as a finding (mutation-checked, per the 2026-08-04 rule).
2. **C2 re-attacked end to end.** Same for every §5 C2 invariant, including the per-command IPC gate rows, the CSP constants, and the sandbox source guards. R-12's named exception (`sidecar_wizard_fetch` has no per-command gate row while fronting the token-releasing `GET /pair/status`) is either closed with a gate row + positive twin, or re-affirmed as a residual with the owner's recorded reason.
3. **Spec-vs-code conformance.** Every normative claim (MUST/never/always) in `docs/spec-drafts/SPEC-v0.3-draft.md`, the whitepaper source, `SECURITY.md`, and `README.md` is traced to an enforcement point or reclassified. Per the 2026-08-07 lesson, this diffs **sets and modality** — an internal C1/C2 doctrine promoted to a protocol MUST is a finding, as is a spec MUST nothing enforces.
4. **Threat model v3 published** in `docs/threat-model.md`: all 12 deltas consolidated (the ledger currently lists 12 while §1 prose still says "eight" — a live inconsistency), residual numbering verified contiguous and unique, every §5 row's cited path existing (`pnpm run check-threat-model` green), and a §9 audit record naming what this pass attacked and — explicitly — **what it did not**.
5. **Accepted residuals re-read through the HN lens.** Each residual in §6 gets a one-line verdict: *survives public scrutiny as written* / *rewording needed* / *escalate to owner decision*. Findings of the third kind are surfaced to the owner rather than silently accepted; no decision is reversed in this task.
6. **Flip-public hygiene verified.** `internal/RUNBOOK-flip-public.md` stages 1.4 (scrub grep = 0), 1.5 (full-history secrets scan clean), and 1.6 (breadcrumb sweep: machine paths, personal emails, key-location hints across `docs/tasks/**`) all executed with output recorded in this task file. Stage 0 (origin object purge) is **probed and reported**, not executed — it is owner/destructive.
7. **Blocking findings fixed in this branch, test-first**, each with a regression test that fails on the pre-fix code (the 2026-08-19 rule: a test that would pass without your change is not coverage). Non-blocking findings land in `docs/next-steps.md` with severity and evidence.
8. **A launch-readiness verdict** stating PASS / PASS-WITH-CONDITIONS / FAIL, enumerating **what was not checked** and which claims rest on unrun lanes (R-11's cadence gap, the billing-blocked CI, Windows). Per the 2026-08-20 gate lesson, an unqualified PASS that hides deselected coverage is the failure mode this criterion exists to prevent.

**Out of scope**

- **Executing the flip.** No visibility change, no `gh repo edit`, no npm publish, no spec push, no GitHub Release — all need their own explicit ask (PROCESS release rules, C3).
- **Regenerating the spec/whitepaper.** The owner does that in a fresh session after this passes. This task corrects the *source draft* only if a claim is wrong.
- **Owner hardware walks** already queued in next-steps (desktop update walk, Telepath deep delete, Coinbase/Ledger live passes). They stay owner-owned; the verdict names them as unverified rather than absorbing them.
- **Reversing owner decisions** (macOS-only, R-7 feature-lane posture, local-gate-over-CI, opt-in encryption). Re-examined for *defensibility of wording*, never re-litigated.
- **New security features.** Anything that would add a control rather than verify one becomes a next-steps item — with one exception: a fix that closes a confirmed blocking finding.
- **Restoring CI billing.** Owner action; the verdict names it as a flip-public blocker (it already is one in next-steps).

---

## Plan

### Phase 0 — Baseline (before any reviewer runs)

The 2026-08-20 lesson: *a fresh-context reviewer runs against the tree it can see, so a mid-edit working tree produces confident findings about code that no longer exists.* So:

1. Cut `feat/TASK-20260821-launch-security-review` off `main` (`49e0f05`), commit this task file. Reviewers run against a coherent, committed tree.
2. Record the baseline: `pnpm run gate:local` default legs (workspace + smoke, ~2 min) and `pnpm run check-threat-model`. A red here is *this task's first finding*, not a reason to proceed.
3. Note in the journal the exact SHA every reviewer sees.

### Phase 1 — Parallel adversarial re-attack (read-only, fresh context)

Six read-only reviewers, `isolation` not needed (no writes — the 2026-08-12 rule only binds writers). Each is briefed with: the mechanism-claim rule (lesson 2026-08-21), *default to refuted* discipline (2026-08-08), and a requirement to return **file:line evidence plus a runnable probe** for every finding — an argument alone is not a finding.

| # | Lane | Reads | Must answer |
|---|---|---|---|
| A | **C1 credential boundary** | `packages/auth/**` (scrub, connected-fetch, oauth-service, provider-error-detail, app-host-freeze, requirement-admission, template-*), `packages/protocol/src/frames.ts`, `security.ts` | Can any path move a credential into an iframe, an LLM prompt, a hub push, or a default export? Re-check R-2/R-26's exact-substring boundary and R-24's `^`-anchored scanner against *new* call sites since v1. |
| B | **C2 sandbox + CSP + IPC** | `packages/runner/**`, `apps/desktop/src/gate/**`, `src-tauri/capabilities/main.json`, all `src-tauri/src/*.rs` command handlers | Enumerate **every** registered IPC command; for each, does a per-command keyless probe exist? (R-12 says 3 of 10.) Does any new command since v2 lack one? Does any frame anywhere gain `allow-same-origin`? |
| C | **Net executor / ceiling** | `packages/auth/src/connected-fetch.ts` (all ten gates, in order), `net-guards.ts`, `apps/desktop/src/platform-desktop.ts`, `sidecar.rs`, `lanfetch.rs` | Verify gate **ordering** by test, not comment (the 2026-08-20 comment-ordering lesson — that exact defect shipped once). Confirm redirect refusal survives on both transports. Probe SSRF literals and ceiling bypasses. |
| D | **Prompt injection & LLM egress** | `apps/playground/src/agent/**` (pseudonymizeEgress, providerTools, classifier), `state/sidecarIdentity.ts`, `packages/knowledge/prompts/**` | Trace one third-party identity from a sidecar response to a provider request. Confirm fail-closed. Verify R-8's replayed-history fence gap is still *exactly* as documented, no worse. |
| E | **Spec/claims conformance** | `docs/spec-drafts/SPEC-v0.3-draft.md`, `docs/whitepaper/src/**`, `SECURITY.md`, `README.md`, `docs/threat-model.md` vs code | Every MUST/never/always → enforcement point or reclassification. Flag doctrine promoted to protocol requirement and claims the code cannot perform. Include the "eight deltas" vs 12-row ledger inconsistency. |
| F | **Flip-public hygiene** | whole tree + `git log --all`, `docs/tasks/**`, `packages/knowledge/**` | Runbook 1.4/1.5/1.6 mechanically; plus: does any *published npm package* carry codenames or machine paths? Does `internal/` leak by reference into public docs (the runbook lists ~8 files that will 404)? |

Each lane returns a structured findings list: claim, file:line, probe, verdict (CONFIRMED / PLAUSIBLE / HELD), severity (BLOCKER / MAJOR / MINOR / RESIDUAL-WORDING).

### Phase 2 — Refutation

Every CONFIRMED/PLAUSIBLE finding goes to an independent refuter that **defaults to refuted** and must produce a runnable probe to sustain it (2026-08-08 — 4 of 10 findings died this way once). Blockers get three refuters with distinct lenses (does it reproduce / is the enforcement elsewhere / is the claim it breaks actually made). Survivors are triaged with the owner in the journal before any code changes.

### Phase 3 — Fix blockers, test-first (Gate 3/4)

Per acceptance criterion 7, and per TDD.md:

1. Write the failing test **first**, on the pre-fix code, and record the red.
2. Mutation-check per the 2026-08-21 rule: **commit before mutating**, restore by inverse edit, never `git checkout` over uncommitted work.
3. Fix; re-run the package's suite **plus dependents** per the architecture dependency graph. `auth` → `auth` + `playground`; `protocol` → everything; `desktop` → also `test:rust` + `gate`.

Expected candidates (not commitments — each waits on Phase 2):
- R-12's `sidecar_wizard_fetch` per-command gate row + positive twin (`apps/desktop/src/gate/ipc.ts`).
- The §1 "eight deltas" vs 12-row ledger inconsistency (documentation blocker for AC4).
- Any spec MUST with no enforcement point (AC3).

### Phase 4 — Threat model v3 (the deliverable)

Rewrite `docs/threat-model.md` to 3.0:
- §1 corrected to the true delta count; ledger regenerated and `check-threat-model` green.
- §5 rows re-verified; new rows for anything this pass hardens.
- §6 residuals renumbered contiguously (v2 already fixed one duplicate-id defect — verify no others), each carrying its AC5 HN-lens verdict where wording changed.
- §9 audit record: what *this* pass attacked, what it did **not** (per AC8 and the mechanical-check lesson — state the limit beside the mechanism).
- A new `docs/security/threat-model-delta-launch-review.md` only if this task *changes* the attack surface (a fix does; a verification does not).

### Phase 5 — Verdict + Gate 5/6

- Launch-readiness verdict in the task file and mirrored into `docs/next-steps.md`: PASS / PASS-WITH-CONDITIONS / FAIL, with the unverified-lane enumeration.
- `pnpm run gate:local --all` (~15–20 min) for the final claim, since a default-leg run verifies two of six legs and this task's whole point is not shipping that ambiguity. If any leg is deselected, the verdict says so verbatim (2026-08-20 gate lesson).
- Gate 6 `/close-session`: lessons, next-steps pruned, ADR if a decision is made (candidate: an ADR recording the launch-readiness posture and the conditions attached to it), done-index entry.

### Test plan (tests FIRST)

| AC | Test / verification | Where |
|----|---------------------|-------|
| 1, 2 | Per-finding regression tests, each shown RED on pre-fix code | `packages/auth/src/__tests__/`, `apps/desktop/src/gate/ipc.ts` |
| 2 | Keyless srcdoc probe + positive twin per newly-gated command | `apps/desktop/src/gate/ipc.ts` (in-shell gate) |
| 3 | Claim-inventory check: normative claims → enforcement map, recorded in the task file; mechanized only if the mapping proves stable | task file + `scripts/` if warranted |
| 4 | `pnpm run check-threat-model` green; ledger row count == `docs/security/*.md` count | `scripts/check-threat-model.mjs` |
| 6 | Runbook 1.4/1.5/1.6 command output pasted into the journal | task file |
| 7 | Every fix's suite + dependents green; root `turbo run test --force` at the end (the 2026-08-13 integrating claim) | root |

### Cross-package impact

`auth` fixes → run `auth` + `playground` + `desktop`. `protocol` fixes → run everything. `desktop` gate rows → `pnpm --filter desktop test`, `test:rust`, and the `gate` script (which needs a real macOS WKWebView run — the 2026-08-19 stale-lock lesson applies: check for a leftover `snug-desktop` process before trusting a FATAL).

### Spec-sync impact

None expected. If AC3 finds a spec claim the code does not enforce, the decision is *correct the code* (preferred, if it is a real invariant) or *correct the draft* (if the claim overreached). Only the latter touches `docs/spec-drafts/` and it gets a `docs/spec-changelog.md` entry. **No push to `snugprotocol/spec` in this task** — the owner regenerates and publishes in the follow-on session.

---

## Decisions & surprises

- **2026-08-21 — Scope set by owner interview:** full sweep (code + spec conformance + threat-model consolidation + flip-public hygiene); fix blockers in-branch and file the rest; deliverable is threat model v3 + an explicit verdict; accepted residuals re-read through the HN lens without reversing owner decisions.
- **2026-08-21 — v2's own limitation is this task's mandate.** The threat model states its v2 pass re-attacked only four surfaces and mechanically re-checked the rest. A launch review that inherited that boundary would ship v1's audit as though it were current.

## Session journal (append-only, newest last)

### 2026-08-21 — Jeetu/Claude — session
- Done: Gate 1 task file + owner interview (4 questions, all answered). Gate 2 plan written after reading PROCESS, lessons (full), threat-model v2, architecture, INDEX, SECURITY.md, next-steps, LAUNCH_OPS + RUNBOOK-flip-public, workspace layout and script surface.
- State: **planned — STOPPED for plan approval per Gate 2.** No branch cut, no code touched.
- Next step: on approval — cut the branch, commit the task file, record the baseline (Phase 0), dispatch the six review lanes (Phase 1).
- Open questions: (1) Should the R-12 `sidecar_wizard_fetch` gate row be treated as an in-scope blocker fix or a filed follow-up? Plan currently treats it as a Phase-2-triaged candidate. (2) Does the owner want the launch-readiness posture recorded as an ADR, or is the task-file verdict + next-steps entry sufficient?
