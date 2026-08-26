# TASK-20260826-backlog-hygiene-stale-findings: strike two already-fixed security-review findings and refresh threat-model R-11

- **Status**: done
- **Owner**: Jeetu (with Claude)
- **Risk tier**: low (docs only — `docs/next-steps.md`, `docs/threat-model.md`)
- **Branch**: `fix/TASK-20260826-backlog-hygiene-stale-findings`
- **Packages touched**: none (docs only)
- **Spec impact**: none
- **Related**: TASK-20260821-launch-security-review (the findings' source), TASK-20260822-spec-10-final (`a40302e`, #103 — closed both), TASK-20260826-ci-restore (ADR-0058 — the R-11 premise changed), threat model v3.0

## Spec (what & why)

An outside reader auditing the project from its own backlog today concludes that the
normative `SNUGENC1` container layout in the published spec disagrees with `container.ts`
(a wire-incompatibility in a Normative section) and that healthy databases are resealed on
every open. Both were real findings of the 2026-08-21 launch security review, and **both
were fixed the next day** in `a40302e` (#103): spec §11.1 now documents the 61-byte slot
stride and states why it is load-bearing (the published `spec/SPEC.md` carries it), and
`healMissingTables` derives its expected set from `USERDB_DDL` with a comment naming this
exact failure. `docs/next-steps.md` items 5 and 6 of that review were never struck. For a
project whose credibility rests on publishing its defects, a stale "we have an
interoperability bug" note is worse than the bug was.

Separately, threat-model R-11 opens with "a CI job that has not executed since
~2026-08-18". CI has been live and enforcing since 2026-08-26 (ADR-0058), so that premise
is stale — but R-11's substantive point survives: the macOS leg proves WKWebView only, the
Windows/WebView2 leg is parked, the 14 real-browser CSP probes still never run under
Chromium (the engine the hosted Playground ships to), and `smoke.ts` is still not invoked
by CI. Rewrite the paragraph so it is true today without weakening the caveat.

**Acceptance criteria** (docs-only; each verified by reading the diff, no code tests apply):
1. `docs/next-steps.md` items 5 and 6 of the 2026-08-21 review carry a strikethrough plus the closing commit, in the file's existing `~~…~~ FIXED` idiom; the finding text is preserved (the record is append-only).
2. `docs/threat-model.md` R-11 no longer claims CI is not running; it names what CI now proves (WKWebView in-shell gate on macOS) and what it still does not (Chromium CSP probes, WebView2 leg parked, `smoke.ts`). Version line unchanged (this is an errata to v3, not a v4 re-attack).
3. `pnpm test` at the root stays green (the docs-sync / code-map gates do not reference these paragraphs; verify rather than assume).
4. Task file journaled, task moved to `done/` on close.

**Out of scope**: fixing the still-open items of the same review (LAN 15 s vs executor 60 s timeout, pseudonymisation digit floor, NBSP identity matching, UTF-16 contract accounting, `.snug` import confirmation gate, IPv6 SSRF forms) — each is its own task; the threat-model v4 re-attack; anything in `spec/`.

## Plan

1. `docs/next-steps.md` — strike items 5 and 6 (line ~44–45) with `~~…~~ **FIXED `a40302e` (#103)**` and one clause each saying where the fix lives.
2. `docs/threat-model.md` — rewrite the R-11 paragraph (line ~467–476); add a one-line dated errata note so a v3 reader can see what changed and when.
3. Journal, `/close-session`, single PR, merge on the owner's ask (one CI run).

## Decisions & surprises

- The findings were fixed in the same 24 h window they were found in; the backlog never caught up because the fixing task (spec-10-final) journaled its own work, not the review's item numbers. Lesson candidate: when a task closes another task's numbered finding, strike it in place.

## Session journal (append-only, newest last)

### 2026-08-26 18:31 — Claude — session
- Done: verified each of the seven 2026-08-21 findings against current code/spec; items 5 and 6 fixed in `a40302e`; R-11 premise stale since ADR-0058. Task file + branch created.
- State: edits pending.
- Next step: apply the three edits, run root `pnpm test`, journal, close-session, PR.
- Open questions: none.

### 2026-08-26 18:40 — Claude — session
- Done: AC1 — items 5 and 6 struck in `next-steps.md` with `a40302e` (#103) and the fix locations. AC2 — R-11 rewritten with a dated errata; two further v3 passages carrying the same "billing-blocked" premise (the R-5 detector-gap residual, and "what v3 did NOT do") got one-sentence dated errata each rather than rewrites — they were true when written. AC3 — root `pnpm test` green (exit 0) after the edits. Threat-model version line left at 3.0.
- State: ready for close-session → single PR → merge on the owner's ask (one CI run).
- Next step: none in-task.
- Open questions: none.

### 2026-08-26 18:50 — Claude — close-session
- Done: lesson added (`lessons.md` § Agents, reviews & process memory); dated next-steps entry; task moved to `done/` + INDEX line BEFORE merge, at the owner's explicit ask, so the docs-only change runs CI exactly once. Threat-model version line stays 3.0 (errata, not a re-attack).
- State: committed on `fix/TASK-20260826-backlog-hygiene-stale-findings`; PR #150 pending the push.
- Next step: merge PR #150 (owner asked in-session).
- Open questions: none.
