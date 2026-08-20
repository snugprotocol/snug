# TASK-20260820-threat-model-v1: consolidated threat model + pre-HN security hardening

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: **High** — the deliverable is a public security claim about C1/C2. A threat model that overstates what the system enforces is worse than none: it converts an honest gap into a broken promise, in the document a hostile reader opens first. Any code change arising from it inherits the tier of what it touches.
- **Branch**: `feat/TASK-20260820-threat-model-v1`
- **Packages touched**: `docs/` primarily; code only where the audit finds a real gap (each such fix gets its own commit and its own tests)
- **Spec impact**: none expected — this documents the system as built. If the audit finds a schema-level gap, that becomes its own task under SPEC_SYNC (C3).
- **Related**: A10 (roadmap Alpha), the flip-public gate ("`docs/threat-model.md` merged — SECURITY.md forward-references it"), ADR-0003 (C1–C5), the eight `docs/security/threat-model-delta-*.md`, `docs/solutions/2026-08-13-webview2-subframe-ipc-injection.md` (R-5)

## Spec (what & why)

`SECURITY.md:47` tells every reader "a full written threat model is landing at
`docs/threat-model.md`". That file does not exist. Publishing a repo whose security
policy forward-references a missing document is the first thing a hostile reader finds,
and the flip-public gate lists it as a required box.

The analysis largely exists — 1,129 lines across eight per-change deltas — but a delta
is written for someone who already knows the system and is reading one change. A threat
model is written for a stranger deciding whether to trust the whole thing. This task
consolidates them into one document with a stated scope, an asset/adversary/boundary
model, the enforced invariants and HOW each is enforced, the **accepted and unmitigated**
residuals stated plainly, and a reporting route.

**Owner decisions carried in (2026-08-20):** ship **macOS-only** for the desktop shell
(ADR-0021 D8 option b — the wry/WebView2 subframe IPC injection is a real C2 breach on
Windows and no off-switch exists); the origin history purge and CI billing are parked
deliberately and are NOT gates for this task.

**Acceptance criteria** (each becomes at least one test or a mechanical check):
1. **AC1 — the document exists and SECURITY.md's promise resolves.** `docs/threat-model.md`
   merged; the forward reference becomes a live link; no dangling "landing at" copy.
2. **AC2 — every delta is represented, and none is silently dropped.** A mechanical
   check pins the eight delta files against the consolidated document, so a future
   delta cannot be added without the model noticing.
3. **AC3 — the hard constraints are stated with their ENFORCEMENT POINT, not as
   claims.** For each of C1/C2: what is promised, the file that enforces it, and the
   test that would fail if it regressed. A promise with no named enforcement is
   downgraded to a residual.
4. **AC4 — residuals are stated as accepted, in the same document, with equal
   prominence.** Explicitly including: Windows/WebView2 (R-5, now "not shipped"), the
   BYOK browser-CORS advisory, installed-starter staleness, and anything the audit
   surfaces. A threat model that lists only wins reads as marketing.
5. **AC5 — the claims are AUDITED, not transcribed.** An adversarial pass verifies each
   enforcement claim against the code. Any claim that does not hold becomes either a
   code fix (with tests) or a stated residual — never a softened sentence.
6. **AC6 — macOS-only is stated honestly** wherever the shipped surface is described
   (threat model, SECURITY.md, README as needed), with the reason, so a Windows user
   learns it from us rather than from a broken install.
7. **AC7 — no new public claim outruns the code.** A sweep of the public-facing set
   (README, SECURITY.md, whitepaper, spec repo pointers) for security claims that the
   audit cannot substantiate.

**Out of scope**: the origin-history purge; CI billing; the landing page; npm
publication; new hardening FEATURES (anything the audit surfaces that is not a defect
becomes a next-steps item, not scope creep inside a documentation task).

## Plan

1. Read all eight deltas + ADR-0003/0006/0014/0021 + `docs/conventions.md` C1–C5.
2. **Adversarial audit in parallel** (fresh-context agents, one per surface): the
   sandbox/CSP seam, the credential/token boundary, the net executor + allowlist, the
   desktop shell, and the app-authoring/prompt-injection surface. Each returns
   claim → enforcement point → test → verdict, with file:line evidence.
3. Triage findings: real defect → its own commit + tests; unenforceable claim →
   residual; unsubstantiated public copy → corrected.
4. Write `docs/threat-model.md`. Structure: scope · assets · adversaries · trust
   boundaries · enforced invariants (with enforcement + test per row) · residuals
   (accepted, unmitigated) · reporting.
5. AC2's mechanical check; SECURITY.md/README reconciliation; docs sweep.

## Session journal (append-only, newest last)

### 2026-08-20 — Claude (Fable 5) — session
- Done: Gate 1. Confirmed `docs/threat-model.md` absent while `SECURITY.md:47` promises
  it; eight deltas total 1,129 lines. Owner set macOS-only; purge + CI parked.
- State: starting the adversarial audit before writing a line of the model — the point
  is to publish what is TRUE, not what the deltas assert.
- Next step: parallel audits, then triage.

### 2026-08-20 — Claude (Fable 5) — session 2 (audit + triage)

**Plan step 2 done.** Five fresh-context adversarial audits ran in parallel (sandbox/CSP,
credential boundary, net executor, desktop shell, authoring/prompt-injection). Read all
eight deltas + ADR-0003/0006/0014/0021 + conventions C1–C5 + the public-facing set.

**The headline: the deltas are unusually honest.** ~50 claims were checked against code;
the overwhelming majority HOLD with negative tests that assert *zero fetches* rather than
merely a failed result. Spot-checked ~12 file:line citations from the deltas — every one
accurate. That matters for AC5: this consolidation is mostly transcription-with-evidence,
not correction. The exceptions below are what the audit was for.

**Triage — real defects (each gets its own commit + tests):**

- **D1 (MEDIUM, fix now) — the sidecar path skips the mutating-confirm gate.**
  `connected-fetch.ts:1097` returns `sendViaSidecar()` **before** gate 6 at `:1125`,
  while the comment at `:1094` states "the mutating-confirm gate has answered". It has
  not. A `POST`/`DELETE` to `whatsapp.sidecar.localhost` reaches the helper with
  credentials injected and no user confirm — voiding ADR-0033's standing-write governance
  for exactly the connection class that ADR exists to govern (gate 6 deliberately passes
  `slot`/`body` so ADR-0033 can derive a thread). Bounded: needs an already-approved
  sidecar row on desktop; an app cannot self-grant the host. **Why no test caught it:**
  every case in `sidecar-transport.test.ts` hardcodes `confirmGate: { confirm: () => true }`
  (`:76`, `:169`), so a gate never consulted is indistinguishable from one that grants.
  Verified by reading both seats directly, not taken on the agent's word.
- **D2 (MEDIUM, fix now) — OAuth token-endpoint error bodies reach the iframe AND the LLM
  unscrubbed.** `oauth-service.ts:626-628` interpolates 500 chars of raw provider response
  into an `Error`; it rides `connected-fetch.ts:1162` → `net.ts:415` (into the frame) and
  `providerTools.ts:208` (into LLM context). Reachable: an app on an approved host drives
  a 401 → the executor's own refresh retry POSTs `refresh_token` + `client_secret`, and a
  provider that echoes submitted params in its error envelope puts them in the slice.
  The scrub cannot catch it even in principle — injection *throws* on this path so
  `scrubCandidates` is never built, and the leaking values are POST body params that were
  never injected headers. Undisclosed by any delta, and the neighbouring transport-error
  path at `:1275` scrubs for precisely this reason. Fix reuses `extractAuthFailureDetail`.

**Triage — the model must state these, not soften them (new residuals):**

- **RES-N1 — the desktop main window ships with no CSP** (`tauri.conf.json:24` `csp: null`).
  Desktop-auth R-1 ("host-page compromise = total credential compromise") was written for
  a *browser* host page that has a policy; the shell drops that layer and no delta says so.
- **RES-N2 — the Windows block is enforced only by a CI job that is not running.**
  `tauri.conf.json:29` is `"targets": "all"` and `icon.ico` ships, so `pnpm --filter
  desktop bundle` on Windows produces a shippable artifact today. The block is
  documentation-only, resting on a red CI leg — and CI has been billing-blocked since
  ~2026-08-18, so every run fails in ~2s with zero steps. A red X from billing is
  indistinguishable from a red X from R-5. **This is the AC6 story and it is worse than
  "we chose macOS".**
- **RES-N3 — `sidecar_wizard_fetch` ships in release with no per-command gate row**, though
  it fronts `GET /pair/status`, the token-releasing route the whatsapp delta says is closed
  "at its source". Its lower-privilege sibling `sidecar_fetch` has a row. This is exactly
  the drift desktop-auth S6 names as a standing rule.
- **RES-N4 — enforcement cadence is itself a residual.** The in-shell gate is not in
  `pnpm test` (separate `gate` script, CI-only), the 14 real-browser CSP checks never run
  in CI on the **web** path (no `e2e` turbo task), and `apps/server`'s CSP-header assertion
  lives in `smoke.ts`, which CI never invokes. AC3 asks for "the test that would fail if
  it regressed"; for several rows the honest answer is "a job that is not currently
  running." That belongs in the model, stated.
- **RES-N5 — no per-app rate limit on the net executor** (concurrency-capped at 8,
  ceiling-bounded, unlimited serially). Accepted posture, but currently silence.
- **RES-N6 — ports are not part of the frozen ceiling** (`isHostAllowed` compares
  hostname). Deliberate and tested (`connected-fetch.test.ts:288`), undocumented.

**Also carried (lower):** `export_user_bytes` has zero tests; the runner source-guard scans
only `packages/runner/src` while the whitepaper claims "a frame carrying
`allow-same-origin` fails the build"; the anti-knob lint covers `auth`+`runner` only;
`pending_opened_files` peeks non-consuming while the delta says "single-use"; two
hand-rolled percent-decoders with opposite failure modes on one IPC surface.

**AC7 blocker found — ADR-0021 D8 was never amended.** The macOS-only decision exists only
in this task file's prose. Four documents still describe D8 as OPEN and one says the
trigger resolves to "Electron fallback": `docs/decisions/0021:23`, `next-steps.md:16`,
`architecture.md:118`, `threat-model-delta-desktop-auth.md:133`,
`solutions/2026-08-13-…:84`. Per C-rules ("memory is git") and ADR-0027 the threat model
cannot cite a decision that has no record. **An ADR-0021 addendum must land before the
model's macOS-only sections can stand.**

- Next step: D1 + D2 test-first (red → green → commit each separately), then the ADR-0021
  D8 addendum, then write `docs/threat-model.md` against the audited findings.
- Test status at pickup: branch carried docs only (one commit, spec); no code touched yet,
  so no package suites were in scope. Baseline runs with the D1/D2 work.
- Lost context: none — the diff was one commit and the journal explains it.

### 2026-08-20 — Claude (Fable 5) — session 2 close

**All seven ACs met.** Four commits on top of the spec, each its own concern:

1. `5743473` **D1 fixed** — gate 6 now runs before the sidecar send. Red first (gate called
   0 times; a denied POST still delivered), then green. Three tests pin it, including a GET
   positive twin so the fix cannot over-gate reads. The SSRF stand-down the old branch
   position was buying is kept explicitly via `sidecarClass`.
2. `b8fa072` **D2 fixed** — the OAuth error body is bounded at its seat. Red first
   (reproduced `"Refresh failed: HTTP 502: …rt-USER-REFRESH-SECRET-value…"` end to end),
   then green. Reuses the existing recognized-envelope extractor, lifted to
   `provider-error-detail.ts` with both callers named; its old "never raw bytes" contract
   is replaced by a statement of why extraction is safe on raw bytes — it is an ALLOWLIST,
   so it fails closed on unrecognized shapes rather than open on unanticipated values.
3. `23f23d0` **ADR-0021 D8 addendum** — macOS-only recorded, and all five contradicting
   documents reconciled in the same commit. The addendum also records what the decision
   does NOT close (see R-5b), so the model cannot cite it as stronger than it is.
4. `f5ffa46` **`docs/threat-model.md`** + AC2's checker + the AC7 sandbox-guard widening.

**AC-by-AC:** AC1 link live, "landing at" gone. AC2 all 8 deltas hash-pinned, checker
mutation-proven in three directions (new delta / edited delta / refactored-away path).
AC3 every invariant row names an enforcement point and a test, both verified to exist —
rows that could not were moved to residuals. AC4 residuals carry equal prominence, with
the audit's undisclosed findings included (R-1 desktop no-CSP, R-5b doc-only enforcement,
R-9 pseudonymisation altitude, R-11 cadence, R-12 the wizard-fetch gate row). AC5 the
audit ran before a line was written and its two defects were fixed, not documented. AC6
macOS-only stated in the model, SECURITY.md and README with the reason. AC7 swept —
no forbidden claims found; the one claim that outran the code (the whitepaper's
"fails the build") was closed by widening the guard rather than softening the sentence.

**Tests:** workspace green uncached, 23/23 tasks. auth 903 ✓ (5 red → green across D1+D2).
check-threat-model 128 ✓ (13 unit tests). check-sandbox-guard 4 ✓, mutation-proven.

**Next-steps items this opened** (each needs its own task — all are scope-creep if done
inside a documentation task, per the spec's out-of-scope list):
- Restrict desktop bundle targets + pin by test, so macOS-only is enforced by the build
  rather than by prose (R-5b). Highest value of these: it is the enforcement half of an
  already-made decision.
- Move WhatsApp pseudonymisation into the host pump / `sidecarAppFetch` seam so it binds
  every app rather than being an app-layer convention (R-9). Largest genuine risk
  reduction available, and the residual a reviewer weighs most heavily.
- A per-command gate row for `sidecar_wizard_fetch` (R-12).
- Fence the classifier's replayed history lines (R-8's sharpening).
- Wire the web-path CSP e2e checks and `apps/server`'s CSP-header assertion into CI so
  R-11 shrinks; blocked behind the CI billing fix.
- Tests for `export_user_bytes`; widen the anti-knob lint beyond `auth`+`runner`.

**Remaining for this task:** Gate 5 review, then Gate 6 close. No code path is left
half-done; the branch is coherent at every commit.
