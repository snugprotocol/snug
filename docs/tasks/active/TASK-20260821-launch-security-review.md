# TASK-20260821-launch-security-review: Final pre-launch security review & threat model v3

- **Status**: planned (awaiting Gate 2 approval)
- **Owner**: Jeetu
- **Risk tier**: **high** — reviews and may patch `packages/protocol`, `packages/runner`, `packages/auth`, C1/C2 surfaces (auto-escalated per [PROCESS.md](../engineering/PROCESS.md#risk-tiers))
- **Branch**: `feat/TASK-20260821-launch-security-review`
- **Packages touched**: review = the enumerated lane list in Phase 1 (`packages/auth`, `packages/protocol`, `packages/runner`, `packages/db`, `packages/knowledge`, `apps/desktop`, `apps/playground`, `apps/server`, `apps/whatsapp-sidecar`); `packages/adapters` and `packages/sdk` are **deliberately unreviewed** and named as such in the AC8 verdict. Fixes = enumerated per confirmed finding (expected: `packages/auth`, `apps/desktop`, `scripts/`, docs)
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
2. **C2 re-attacked end to end.** Same for every §5 C2 invariant, including the per-command IPC gate rows, the CSP constants, and the sandbox source guards. **R-12's arithmetic is known-stale and must be re-derived, not confirmed by reading the doc**: it says "ten commands ship; three carry per-command checks", but `apps/desktop/src-tauri/src/lib.rs` registers **13 in debug and 10 in release** (verified), `apps/desktop/src/gate/ipc.ts` now carries **five** per-command probes (ADR-0047 added three), and two of those five are Tauri *plugin* commands absent from `generate_handler!` — so the ratio compares a numerator and denominator drawn from different sets. Lane B's first deliverable is a corrected census (debug set / release set / plugin commands × probe present or absent). **The underlying gap is confirmed real**: `sidecar_wizard_fetch` is registered in both builds (`lib.rs:134`, `:155`) and appears in no `*_COMMAND` const in `ipc.ts`, while its lower-privilege sibling `sidecar_fetch` is probed. It is closed with a gate row + positive twin, or re-affirmed as a residual with the owner's recorded reason.
3. **Spec-vs-code conformance, bounded.** **Full tracing** covers every **MUST / MUST NOT** token — measured at **73** (58 in `docs/spec-drafts/SPEC-v0.3-draft.md`, 15 in `docs/whitepaper/src/paper.html`; `SECURITY.md` and `README.md` carry none) — each traced to an enforcement point or reclassified. `never`/`always` claims (~200 further lines, counted) get a **sampled** sweep: every occurrence in the spec's normative sections plus all of `SECURITY.md`/`README.md`, with the sampling rule and the unsampled remainder stated verbatim in the AC8 verdict. Per the 2026-08-07 lesson this diffs **sets and modality** — internal C1/C2 doctrine promoted to a protocol MUST is a finding, as is a spec MUST nothing enforces. Note the whitepaper source is **HTML, not markdown** (`docs/whitepaper/src/` holds `paper.html`, `paper.css`, `figures/`), so claim extraction must not mistake markup or CSS identifiers for prose.
4. **Threat model v3 published** in `docs/threat-model.md`: all 12 deltas consolidated (§1 prose says "eight" against a 12-row ledger — a live inconsistency, and one the checker is **structurally blind to**: `scripts/check-threat-model.mjs:212`'s only count assertion is `actual.size >= 8`, a floor that passes at 12 and never reads the prose). Residual numbering verified contiguous and unique, every §5 row's cited path existing, `pnpm run check-threat-model` green, and a §9 audit record naming what this pass attacked and — explicitly — **what it did not**.
5. **Accepted residuals re-read through the HN lens.** Each residual in §6 gets a one-line verdict: *survives public scrutiny as written* / *rewording needed* / *escalate to owner decision*. Findings of the third kind are surfaced to the owner rather than silently accepted; no decision is reversed in this task.
6. **Flip-public hygiene — split by what is actually executable today.** The runbook's stages assume a post-move world this task does not enter, so each is classified rather than blanket-claimed:
   - **1.6 breadcrumb sweep — EXECUTED.** Machine paths, personal emails, and key-location hints across `docs/tasks/**` and `docs/**`; output recorded here. No dependencies.
   - **1.4 scrub grep — EXECUTED IN ADAPTED FORM.** The runbook's command reads `<private-dir>/scrub-terms.txt`, a file that does not exist (verified) because stage 1.4 *creates* it and stage 1.1 (moving `internal/` off-disk) *precedes* it — both out of scope here. Adaptation: author a **repo-local, gitignored** term file from `internal/.env.local` + the codenames and run the same grep against the **in-place** tree. Same signal, no destructive prerequisite.
   - **1.5 full-history secrets scan — PREREQUISITE INSTALL, else PROBED-ONLY.** Neither `gitleaks` nor `trufflehog` is installed (verified: both absent). Phase 0 attempts `brew install gitleaks`; if it succeeds the scan runs and its output is recorded, and if it does not, 1.5 is reported **NOT EXECUTED** in the AC8 verdict rather than silently dropped.
   - **Stage 0 (origin object purge) — PROBED AND REPORTED, never executed.** Owner/destructive.
   - **Additional, beyond the runbook:** the `internal/` reference leak is **36 files**, not the "~8" the runbook enumerates — so Lane F treats that list as a floor, not a target.
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
2. Record the baseline: `pnpm run gate:local` default legs (workspace + smoke, ~2 min) and `pnpm run check-threat-model`. A red here is *this task's first finding*, not a reason to proceed. **DONE — both green; see the journal.**
3. Note in the journal the exact SHA every reviewer sees. **DONE — `de7c40a`.**
4. **Attempt `brew install gitleaks`** so AC6's stage 1.5 can execute. If it fails, 1.5 is reported NOT EXECUTED in the verdict — never silently dropped.
5. Author the gitignored, repo-local `scrub-terms` file from `internal/.env.local` + codenames, for AC6's adapted stage 1.4.

### Phase 1 — Parallel adversarial re-attack (read-only, fresh context)

Seven read-only reviewers, `isolation` not needed (no writes — the 2026-08-12 rule only binds writers). Each is briefed with: the mechanism-claim rule (lesson 2026-08-21), *default to refuted* discipline (2026-08-08), and a requirement to return **file:line evidence plus a runnable probe** for every finding — an argument alone is not a finding. Each is also told which figures in the threat model are **known-stale** (R-12's counts), so a reviewer cannot "confirm" a number by reading the document that asserts it.

| # | Lane | Reads | Must answer |
|---|---|---|---|
| A | **C1 credential boundary** | `packages/auth/**` (scrub, connected-fetch, oauth-service, provider-error-detail, app-host-freeze, requirement-admission, template-*), `packages/protocol/src/frames.ts`, `security.ts` | Can any path move a credential into an iframe, an LLM prompt, a hub push, or a default export? Re-check R-2/R-26's exact-substring boundary and R-24's `^`-anchored scanner against *new* call sites since v1. |
| B | **C2 sandbox + CSP + IPC** | `packages/runner/**`, `apps/desktop/src/gate/**`, `src-tauri/capabilities/main.json`, all `src-tauri/src/*.rs` command handlers, **`apps/whatsapp-sidecar/src/**`** | Produce the corrected IPC census (AC2). For each registered command, does a per-command keyless probe exist, and is there a positive twin? Read the sidecar's own `router.ts` — `GET /pair/status` **releases the access token** (its own comment says so) and it is the route `sidecar_wizard_fetch` fronts, so both ends of that surface are one lane's job. Does any frame anywhere gain `allow-same-origin`? |
| C | **Net executor / ceiling** | `packages/auth/src/connected-fetch.ts` (all ten gates, in order), `net-guards.ts`, `apps/desktop/src/platform-desktop.ts`, `sidecar.rs`, `lanfetch.rs` | Verify gate **ordering** by test, not comment (the 2026-08-20 comment-ordering lesson — that exact defect shipped once). Confirm redirect refusal survives on both transports. Probe SSRF literals and ceiling bypasses. |
| D | **Prompt injection & LLM egress** | `apps/playground/src/agent/**` (pseudonymizeEgress, providerTools, classifier), `state/sidecarIdentity.ts`, `packages/knowledge/prompts/**` | Trace one third-party identity from a sidecar response to a provider request. Confirm fail-closed. Verify R-8's replayed-history fence gap is still *exactly* as documented, no worse. |
| E | **Spec/claims conformance** | `docs/spec-drafts/SPEC-v0.3-draft.md`, `docs/whitepaper/src/**`, `SECURITY.md`, `README.md`, `docs/threat-model.md` vs code | Every MUST/never/always → enforcement point or reclassification. Flag doctrine promoted to protocol requirement and claims the code cannot perform. Include the "eight deltas" vs 12-row ledger inconsistency. |
| F | **Flip-public hygiene** | whole tree + `git log --all`, `docs/tasks/**`, `packages/knowledge/**` | Runbook 1.6 + adapted 1.4 + 1.5-if-installed (AC6). Does any file **in the public tree** carry codenames, machine paths, or personal identifiers? Known live hits to start from: `packages/knowledge/prompts/ui/build-app-prompt.md:5` and `tools/app-builder.md:5` both carry `source: … (internal/05)`. **Do not frame this as an npm question** — every workspace member is `private: true` today (verified), so nothing publishes; npm is a *future* risk to flag for when `private` is lifted, and the runbook's parenthetical claiming knowledge "publishes to npm" is itself a finding to correct. `internal/` leaks by reference into **36 files**, not the ~8 the runbook enumerates. |
| G | **Server + storage custody** | `apps/server/src/**` (`auth/session.ts`, `auth/oidc.ts`, `rate-limit.ts`, `stores/**`, `/userdb` CAS, `/invoke`), `packages/db/src/userdb/**` | The only place C5 permits secrets. Session/CSRF handling, OIDC binding, CAS correctness, artifact-cache isolation, and the secrets-strip + VACUUM on hub-bound pushes and default exports. Does any hub-bound path carry a secret the C1 row promises it strips? |

Each lane returns a structured findings list: claim, file:line, probe, verdict (CONFIRMED / PLAUSIBLE / HELD), severity (BLOCKER / MAJOR / MINOR / RESIDUAL-WORDING).

### Phase 2 — Refutation

Every CONFIRMED/PLAUSIBLE finding goes to an independent refuter that **defaults to refuted** and must produce a runnable probe to sustain it (2026-08-08 — 4 of 10 findings died this way once). Blockers get three refuters with distinct lenses (does it reproduce / is the enforcement elsewhere / is the claim it breaks actually made). Survivors are triaged with the owner in the journal before any code changes.

### Phase 3 — Fix blockers, test-first (Gate 3/4)

Per acceptance criterion 7, and per TDD.md:

1. Write the failing test **first**, on the pre-fix code, and record the red.
2. Mutation-check per the 2026-08-21 rule: **commit before mutating**, restore by inverse edit, never `git checkout` over uncommitted work.
3. Fix; re-run the package's suite **plus dependents**, per [TDD.md](../engineering/TDD.md)'s actual table — `protocol` → also `runner`, `sdk`, `server`, `playground`; `db` → also `sdk`, `playground`; **and its stated fallback, "in doubt: run everything."** `packages/auth` has **no** dependents entry there, so a C1/High-tier change to it takes the fallback and runs everything rather than an invented narrower rule. `desktop` additionally needs `test:rust` and the `gate` script.

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
| 4 | **New assertion: the §1 prose delta count equals `parseLedger(md).size`**, plus TM3's `>= 8` floor tightened to an exact comparison. This is the test that would have caught the "eight vs 12" defect; a ledger-row-vs-file-count test would be a **no-op**, since `checkDeltaLedger` already fails in both directions and hash-pins each file. Shown RED against the current prose before the fix. | `scripts/check-threat-model.mjs` + `scripts/check-threat-model.test.mjs` |
| 6 | Runbook 1.4/1.5/1.6 command output pasted into the journal | task file |
| 7 | Every fix's suite + dependents green; root `turbo run test --force` at the end (the 2026-08-13 integrating claim) | root |

### Cross-package impact

`auth` fixes → run `auth` + `playground` + `desktop`. `protocol` fixes → run everything. `desktop` gate rows → `pnpm --filter desktop test`, `test:rust`, and the `gate` script (which needs a real macOS WKWebView run — the 2026-08-19 stale-lock lesson applies: check for a leftover `snug-desktop` process before trusting a FATAL).

### Spec-sync impact

None expected. If AC3 finds a spec claim the code does not enforce, the decision is *correct the code* (preferred, if it is a real invariant) or *correct the draft* (if the claim overreached). Only the latter touches `docs/spec-drafts/` and it gets a `docs/spec-changelog.md` entry. **No push to `snugprotocol/spec` in this task** — the owner regenerates and publishes in the follow-on session.

---

## Findings and dispositions

Seven lanes, all read-only against committed tree `de7c40a`/`002984a`. Every accepted
finding was re-verified against primary sources before action (2026-08-13 rule).

### Fixed in this branch (test-first, red recorded, each mutation-checked)

| # | Finding | Severity | Commit |
|---|---|---|---|
| 1 | **The OAuth error seat leaked the ENCODED spelling of submitted secrets.** `body.get()` returns decoded; `URLSearchParams.toString()` percent-encodes on the wire; `scrubAuthValues` is exact-substring. A provider echoing what it received returns a spelling the candidate set could not match. Reaches the iframe, the LLM, and `snug_secrets` (`lastError`, which rides personal-origin sync). The existing tests were structurally blind: fixtures were pure `[A-Za-z0-9-]`, for which encoding is the identity. | **C1 leak** | `615dcec` |
| 2 | **R-8's load-bearing claim was false** — the confirm dialog never rendered the URL it is documented to name, so `POST /notes` and `POST /transfer?to=attacker` were indistinguishable. Also disclosed that the session grant is path-blind. | **MAJOR** | `446f8af` |
| 3 | **A knowledge guard test hardcoded the real ancestor codenames** as a plaintext list annotated as such — the test written to prevent the leak *was* the leak, in the most rewarding file in the tree for a curious reader. Now SHA-256 hashed with substring semantics preserved; the planted sample is recovered by brute force, so no plaintext remains and the scrub gate can reach zero. | **BLOCKER (flip)** | `4cffa01`, `1ce55ff` |
| 4 | **R-12's per-command IPC row for `sidecar_wizard_fetch`** — the command fronts `GET /pair/status` (releases the helper's access token) and auto-injects the spawn nonce, while its *lower*-privilege sibling was probed and it was not. | **MAJOR** | `4c5b7ea` |
| 5 | **20 prompt front-matter lines cited a gitignored path** (`internal/05`), two named the codenames outright, and all of it had been compiled into `src/generated/content.ts`. | MAJOR (flip) | `4cffa01` |
| 6 | **Threat model §1 said "eight deltas" against a twelve-row ledger**, and `check-threat-model.mjs` was *structurally blind* to it (`actual.size >= 8` — a floor that passes at twelve and never reads the prose). New TM8 assertion + TM3 tightened to exact. Mutation-checked. | MAJOR (doc) | `d9c9e97` |
| 7 | **R-12's census was stale in both numbers** and compared handler-registered against plugin commands. Replaced with a table; the six still-uncovered release commands are named. | RESIDUAL-WORDING | `d9c9e97` |
| 8 | **SECURITY.md told researchers the connected-fetch runtime "is landing next"** — it shipped and is the C1 enforcement seat, i.e. the highest-value target was reading as out-of-scope. README said spec v0.2, called `packages/auth` "in development", and omitted `apps/desktop` + `apps/whatsapp-sidecar`. | MAJOR (public) | `d9c9e97` |

### Filed, not fixed (evidence + severity in `docs/next-steps.md`)

Seven items, led by the reference server's missing authorization on `/invoke`+`/artifacts`
(bounded by ADR-0013 — the shipped hub has no backend) and the breadth of untrusted `.snug`
import. Also: three IPv6-embedding SSRF forms, a stale LAN timeout that silences the
self-naming abort, `healMissingTables` false-missing on every open, the `SNUGENC1`
spec-vs-code layout divergence, and five smaller measured items.

### Consciously rejected

- **Lane E's F4** claimed `sidecarWizardCallbackFired` was a dead sensor. It read the tree
  mid-edit, between my probe wiring and the decision functions — the known
  fresh-context-reviewer hazard. Verified complete and green afterwards; the finding was an
  artifact of timing, not of code.
- **Lane A's `scanForCredentialValues` asymmetry** (the direct BYOK lane has no
  credential-shape scan while the server lane does) — not filed, because the doc is explicit
  that this scanner is defense-in-depth and the load-bearing enforcement is
  `stripCredentialHeaders` plus the token-boundary design.

## Decisions & surprises

- **2026-08-21 — Scope set by owner interview:** full sweep (code + spec conformance + threat-model consolidation + flip-public hygiene); fix blockers in-branch and file the rest; deliverable is threat model v3 + an explicit verdict; accepted residuals re-read through the HN lens without reversing owner decisions.
- **2026-08-21 — v2's own limitation is this task's mandate.** The threat model states its v2 pass re-attacked only four surfaces and mechanically re-checked the rest. A launch review that inherited that boundary would ship v1's audit as though it were current.
- **2026-08-21 — owner decisions at Gate 2 approval:** (1) the R-12 `sidecar_wizard_fetch` gate row is an **in-scope fix**, not a follow-up; (2) **no ADR** for the launch-readiness posture — the task-file verdict, the next-steps entry and threat-model §9 are the three records, and a fourth copy earns nothing.
- **2026-08-21 — the pattern across the four security fixes is one shape: a control that existed in one seat and was never carried to its sibling.** The encoded-spelling scrub existed in `connected-fetch.ts` with a comment explaining exactly why, and `oauth-service.ts` never inherited it. The URL was rendered by the chat-lane card and not by the modal. The per-command IPC probe existed for `sidecar_fetch` and not for the more dangerous `sidecar_wizard_fetch`. In every case the *reasoning* was already written down in the codebase — the gap was that nobody re-asked "which other seat has this shape?". That question is cheaper than any of the audits that found these.
- **2026-08-21 — two of the eight findings were defects in the CHECKS rather than the code**, and both had the same failure mode: a mechanism credited with a claim it could not make. `check-threat-model.mjs` was cited as the guard against delta drift while its only count assertion was a floor; the OAuth echo tests were cited as the guard against error-body leaks while their fixtures made the encoded case unrepresentable. A green check is evidence only for the claim its mechanism actually supports.
- **2026-08-21 — the fresh-context plan review returned 2 blockers + 4 majors, all independently re-verified before acceptance** (per the 2026-08-13 rule: re-derive consequential agent claims from primary sources). What it changed:
  - **AC6 was unsatisfiable as written.** Neither `gitleaks` nor `trufflehog` is installed, and `scrub-terms.txt` does not exist because the runbook's stage 1.4 *creates* it after stage 1.1 moves `internal/` off-disk — a destructive step out of this task's scope. Rewritten into four explicitly-classified sub-items.
  - **AC3 was unbounded.** Measured 73 MUST/MUST NOT tokens (58 spec + 15 whitepaper) and ~200 further `never`/`always` lines. Full tracing now binds the 73; the rest is a sampled sweep with the remainder named in the verdict. Also: the whitepaper source is `paper.html`, not markdown — the plan's `src/**` glob contains no `.md` at all.
  - **R-12's "3 of 10" is stale in both numbers** — 13 commands in debug / 10 in release, and 5 per-command probes (ADR-0047 added 3), two of which are plugin commands outside `generate_handler!`. AC2 now demands a re-derived census rather than confirmation-by-reading. **The underlying `sidecar_wizard_fetch` gap is confirmed real.**
  - **Five workspace members sat in no lane**, including `apps/whatsapp-sidecar` — which owns the very route AC2 is about (`router.ts` comments that `GET /pair/status` releases the token) — and `apps/server`, the only place C5 permits secrets. Lane B gained the sidecar; new Lane G covers server + db. `adapters` and `sdk` stay unreviewed **by decision**, named in the verdict.
  - **AC4's proposed test was a no-op** and, more importantly, `check-threat-model.mjs:212`'s `actual.size >= 8` floor is structurally blind to the "eight vs 12" defect it was cited to catch. Replaced with a prose-count-vs-ledger-size assertion plus an exact TM3 count.
  - **Lane F's npm premise was false** — every workspace member is `private: true`, so nothing publishes; the runbook's claim that knowledge "publishes to npm" is itself a finding. Reframed as a public-tree question with npm flagged as a future risk.
  - **Phase 3 invented an `auth` dependents rule** narrower than TDD.md, which has no `auth` entry and says "in doubt: run everything" — the wrong direction to narrow for a C1 package. Corrected to the doctrine's actual table + fallback.

## Session journal (append-only, newest last)

### 2026-08-21 — Jeetu/Claude — session
- Done: Gate 1 task file + owner interview (4 questions, all answered). Gate 2 plan written after reading PROCESS, lessons (full), threat-model v2, architecture, INDEX, SECURITY.md, next-steps, LAUNCH_OPS + RUNBOOK-flip-public, workspace layout and script surface. Branch `feat/TASK-20260821-launch-security-review` cut off `main` @ `49e0f05` (clean tree — `git status` checked first per the 2026-08-18 blanket-add lesson); task file committed as `de7c40a` so Phase-1 reviewers read a coherent tree. Fresh-context plan review dispatched (High-tier requirement, PROCESS risk tiers).
- **Phase 0 baseline (recorded, both green):**
  - `pnpm run check-threat-model` → **169/169 checks passed**, plus its own 17 self-tests. Exit 0.
  - `pnpm run gate:local` → **PARTIAL PASS, 2/6 legs** (workspace PASS, smoke PASS; e2e/rust/desktop/release DESELECTED). Exit 0. The gate's own verdict states it is not ci.yml-equivalent — carried here verbatim rather than summarised as "green", per the 2026-08-20 deselection lesson. Smoke included the byte-exact `RUNNER_CSP` header assertion (threat-model R-11's one CI-invisible C2 check).
  - Scanner/fixture probe: `gitleaks` **absent**, `trufflehog` **absent**, `internal/scrub-terms.txt` **absent** → AC6 rewritten (see Decisions).
- Fresh-context plan review: **2 blockers, 4 majors, 3 minors**, every one re-verified against primary sources before acceptance. All folded into the plan; nothing accepted on the reviewer's word alone. Notable: it confirmed the `sidecar_wizard_fetch` gap is real while showing the surrounding R-12 arithmetic is stale — the finding survived, its framing did not.
- State: **planned — STOPPED for plan approval per Gate 2.** No implementation code touched; only the task file exists on this branch (`de7c40a` + the revision commit).
- Next step: on approval — Phase 0 remainder (gitleaks install attempt, scrub-terms authoring), then dispatch the seven review lanes (Phase 1).
- Open questions for the owner:
  1. **R-12 `sidecar_wizard_fetch` gate row — in-scope fix, or filed follow-up?** The plan review recommends **in-scope**, with evidence: the command is registered in both debug and release builds (`lib.rs:134`, `:155`), is guarded Rust-side by `admit_wizard_request` (`sidecar.rs:826`), and `ipc.ts` already carries a five-instance probe template the sixth follows mechanically. Low risk, and it closes AC2's named exception. **My recommendation: take the fix.**
  2. **ADR for the launch-readiness posture?** Recommendation: **no ADR** unless the verdict lands PASS-WITH-CONDITIONS *and* those conditions bind future sessions — otherwise it is a fourth copy of a posture already in the task file, next-steps, and threat model §9. If conditions do bind, the ADR earns its place.
