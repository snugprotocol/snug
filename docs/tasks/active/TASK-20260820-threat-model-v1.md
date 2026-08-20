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
