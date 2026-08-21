# TASK-20260820-spec-v03-whitepaper: Consolidated spec v0.3 draft + whitepaper edition 2 (1.0 release candidate)

- **Status**: in-review + **PUBLISHED** (2026-08-20 late: on the owner's explicit ask, the three Appendix C steps executed — net/open-url pairs into json-schemas SOURCES (snug `0bd164a`), host-ready drift carried, publication-line decision recorded — and the spec repo pushed: edition-1 whitepaper branch rebased+landed as `ea0109d`, v0.3 publication as `cd011cc`, stale branch deleted. Checker 103/103. PR #90 remains open for the snug-side review/merge. Owner mid-task instruction honored: no Trivia Night mention anywhere — no starter is named in either document)
- **Owner**: Jeetu
- **Risk tier**: medium (docs + whitepaper build/check scripts; zero runtime code)
- **Branch**: `docs/TASK-20260820-spec-v03-whitepaper`
- **Packages touched**: `docs/spec-drafts`, `docs/whitepaper`, `scripts/check-whitepaper.mjs`, `docs/spec-changelog.md`; **scope extended on the owner's 2026-08-20 follow-up ask**: `packages/protocol` (json-schemas SOURCES + 4 test pins; risk re-read as High for that commit, evidence 4 suites local)
- **Spec impact**: the whole point. Originally staging-only; the owner's follow-up ask ("go ahead with all those 3 steps and then push") authorized the `packages/protocol` publication-line change and the spec-repo push — executed as `spec@ea0109d`+`cd011cc` (ADR-0044; C3 satisfied by the explicit in-session ask). The 1.0 promotion remains a separate owner act.
- **Related**: ADR-0016/0018/0019 (doctrine), ADR-0031–0043 (surfaces to consolidate), `docs/threat-model.md` v1, TASK-20260807-protocol-whitepaper (edition 1), `docs/engineering/SPEC_SYNC.md`

## Spec (what & why)

The published spec is v0.1 (wire) + v0.2-draft (userdb, incl. §6 naming + §7 SNUGENC1). The
staged drafts (`spec-v0.2-userdb.md`, `spec-v0.3-auth.md`, `spec-v0.4-runtime.md`) lag the
reference implementation, which has since shipped: net frames + open-url frames (internal
draft), the `linked_device` kind and the whole sidecar surface (ADR-0032/0034/0037),
connection-relative addressing (ADR-0026), the provider chat lane + inline cards (ADR-0031),
runtime contracts (ADR-0018 / userdb v6), host pseudonymisation (ADR-0040), `.snug` naming +
SNUGENC1 (ADR-0042/0043), and threat-model v1. The whitepaper (edition 1) deliberately
excluded every auth/net surface. The owner wants ONE coherent v0.3 spec set and a whitepaper
that covers the full protocol, as the final-review draft before 1.0. Legacy compatibility
with the v0.1/v0.2 document structure is explicitly NOT a constraint (owner, 2026-08-20).

**Acceptance criteria:**
1. `docs/spec-drafts/SPEC-v0.3-draft.md` — one consolidated spec (wire · storage · connected
   apps · runtime contracts · linked-device/sidecar surface), every constant/shape verified
   against `packages/protocol` + `packages/auth` + `packages/db` at head; supersedes and
   replaces the three staged draft files.
2. Whitepaper edition 2: `docs/whitepaper/src/paper.html` + figures rewritten to cover the
   full v0.3 surface; correct Ember Niche mark; builds to `dist/snug-protocol-whitepaper.pdf`.
3. `scripts/check-whitepaper.mjs` updated: validates edition 2 against the staged v0.3 spec
   (fixture = `docs/spec-drafts` until the owner pushes), AC5 flipped from "auth surface
   absent" to "auth surface covered", claim-discipline checks (AC6) retained unweakened.
4. `pnpm run check-whitepaper` green; PDF page-render eyeball pass done; spec-changelog entry
   (internal-staged, no push) appended.
5. Nothing pushed anywhere; PR opened for owner review.

**Out of scope**: pushing to `snugprotocol/spec`; editing `packages/protocol`; renaming spec
versions in the published repo; launch copy.

## Plan

1. Research: four parallel read-only audits (protocol census; sidecar; auth-vs-draft diff;
   ADR 0031–0043 sweep) + direct reads of threat-model v1, changelog, whitepaper infra.
2. Author `SPEC-v0.3-draft.md`; delete the three superseded staged drafts.
3. Rewrite `paper.html` (+ new figures: connected-apps lifecycle, sidecar architecture),
   update `paper.css` running head, rebuild checker, build PDF, iterate on page renders.
4. Changelog entry, close-out, PR.

## Session journal

### 2026-08-20 (session 1 — authoring, publication-line flip, spec push)

**Done.**
- Research: four parallel read-only audits (protocol census; sidecar ADR/code deep-dive;
  auth-vs-draft diff; ADR 0031–0043 sweep) + direct reads of threat-model v1, whitepaper
  infra, positioning docs. Key corrections they surfaced vs the old drafts: 7 kinds not 6;
  5 template helpers not 4 (`cdp_jwt` is IN the enum, both args declared-fields);
  storage v6 with `snug_auth_specs` dropped at v5; `SIDECAR_SYMBOLIC_HOST` as the ceiling
  identity; three pairing families; nine-field `_connection` state.
- `SPEC-v0.3-draft.md` written (Parts I–V + conformance + appendices); the three old
  staged drafts deleted; architecture/code-map pointers updated (`c5a5b5e`).
- Whitepaper edition 2: paper.html rewritten, 3 new figures + fig2/fig5 reworked, CSS
  running head, TOC repaginated against the rendered PDF; checker rewritten (fixture =
  staged draft + `packages/protocol/schemas`; AC5 inverted to coverage; negation-only
  zero-knowledge/E2E; ADR-0040/0043 claim checks); 33/33 pages visually reviewed
  (`a757394`). Owner mid-task instruction honored: no starter named anywhere (Trivia
  Night verified absent).
- Owner ask #2 executed: publication line flipped (SOURCES → 14 files; four test pins
  rewritten; protocol 345 · auth 915 · db 391 · runner 119 local; `0bd164a`), checker
  103/103, host-ready drift carried, publication-line decision recorded (ADR-0044).
- Spec repo: pending `docs/whitepaper-v0.1` branch rebased+landed as `ea0109d`
  (edition-1 whitepaper, keeps linear one-commit-per-task history), v0.3 publication as
  `cd011cc` (spec + 14 byte-identical schemas + edition-2 PDF + README/pointer notes),
  pushed to origin/main, branch deleted. Changelog PUSHED entry with SHAs (`63186fc`).

**Exact state.** `snugprotocol/spec@cd011cc` published. Snug branch
`docs/TASK-20260820-spec-v03-whitepaper` pushed; **PR #90 open** with all snug-side
commits; CI billing-blocked so its checks are red-with-zero-steps — evidence is local.

**Single next step.** Owner reviews the published draft + PR #90; on the owner's "merge", merge
#90, move this task file to done/, and index it.

**Open questions.** (1) 1.0 promotion timing — a spec-repo status flip, its own ask.
(2) Trivia Night starter removal (owner-stated plan; queued in next-steps).
