# 0050 — Specification 1.0: promotion, document layout, and the launch publication set

- **Status:** accepted (owner interview + plan approval, 2026-08-22)
- **Date:** 2026-08-22
- **Task:** TASK-20260822-spec-10-final

## Context

The consolidated v0.3 draft was commissioned explicitly as the 1.0 release candidate
(TASK-20260820-spec-v03-whitepaper) and published for review at `snugprotocol/spec@cd011cc`.
The owner has now called the launch: finalize the specification at 1.0 together with the
whitepaper and the website's docs/spec pages, everything airtight for the HN Show
publication. Since the RC was authored, four merges landed (ADR-0045..0049); the known
protocol-surface deltas are the SNUGENC1 §11.1 layout correction (recorded in the
spec-changelog as pending the next push), the `POST /session/forget` sidecar route
(ADR-0046 §7: "the next consolidated push"), and ADR-0049's web-surface registry seats.

## Decision

1. **The v0.3 RC is promoted to Specification 1.0** — `docs/spec-drafts/SPEC-1.0.md`,
   status NORMATIVE. All five Parts are normative at 1.0. Exactly one section keeps an
   explicit **provisional** marking: §17 (standing approvals) — present and documented,
   subject to change without a major bump, RFC-experimental style. The version string
   stays **1.0 through pre-launch editorial corrections**; post-1.0, additive changes bump
   the minor, breaking changes bump the major.
2. **In the spec repo, SPEC.md becomes THE document.** The 1.0 text replaces the v0.1
   wire-core SPEC.md; `SPEC-v0.2-draft.md` and `SPEC-v0.3-draft.md` retire to short
   pointer stubs (git history keeps their full text). One front door for launch readers.
   The whitepaper checker's `--spec` mode reads the clone's `SPEC.md` only — the stubs
   are never fixtures.
3. **The whitepaper becomes edition 3 — the 1.0 edition.** Full review pass against the
   1.0 text; the checker's fixture moves to `SPEC-1.0.md`, its AC5 draft-marking
   requirement inverts (the paper must claim 1.0 and must NOT self-describe as
   draft/RC/not-yet-normative), and AC6's claim discipline carries unweakened.
4. **Publication is staged, not pushed.** Everything lands in this repo plus ONE unpushed
   commit on the local spec-clone `main`; the push to `snugprotocol/spec` remains its own
   explicit owner ask (PROCESS release rules), as do website deployment, GitHub Releases,
   and any repo visibility flip. The spec-changelog entry records the staged state so the
   pending push is findable (the 2026-08-20 staged-branch lesson).
5. **ADR-0044's publication line carries into 1.0 unchanged**: fourteen JSON Schemas,
   strict pairs publish strict, Part III–V contracts publish as prose + reference
   contracts. This ADR also retires ADR-0048's interim consequence that website spec pages
   "carry the draft label until the v0.3 line publishes" — the label is now the 1.0
   normative banner.

## Alternatives considered

- **Cut §17 from 1.0** — rejected in interview: the shipped feature would go undocumented;
  a marked-provisional section is the honest shape.
- **Promote §17 fully normative** — rejected: the arming channel is genuinely unsettled.
- **Separate SPEC-1.0.md beside a v0.1 SPEC.md in the spec repo** — rejected in interview:
  two competing documents at the exact moment the launch audience arrives.
- **Whitepaper as "edition 2, revised"** — rejected in interview: e1 draft → e2 RC → e3
  launch is clean provenance.
- **Push to the spec repo in this task** — rejected in interview: the owner reviews the
  staged set first; version stays 1.0 through any resulting edits.

## Consequences

- `SPEC-1.0.md` is the single in-repo source for the website spec pages and the
  whitepaper fixture; every consumer path updated in this task
  (`sync-spec.mjs`, `check-whitepaper.mjs`, code-map, architecture, test comments).
- The spec repo gains its first major-version document; its README fronts 1.0.
- Post-launch spec work happens against 1.x semantics — additive minor bumps, one commit
  per change, changelog-traced, exactly as pre-1.0 but with the break/additive line now
  meaningful.
- The whitepaper checker no longer accepts a draft-marked paper; edition 2 would fail it
  (deliberate — the checker pins the current edition, not all history).
