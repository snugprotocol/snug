# TASK-20260820-spec-v03-whitepaper: Consolidated spec v0.3 draft + whitepaper edition 2 (1.0 release candidate)

- **Status**: in-review (all ACs met 2026-08-20: spec consolidated, whitepaper edition 2 built — 33 pp / 10 figures, checker rewritten, 99/99 green, per-page visual pass done; awaiting owner review. Owner mid-task instruction honored: no Trivia Night mention anywhere — verified by grep, no starter is named in either document)
- **Owner**: Jeetu
- **Risk tier**: medium (docs + whitepaper build/check scripts; zero runtime code)
- **Branch**: `docs/TASK-20260820-spec-v03-whitepaper`
- **Packages touched**: `docs/spec-drafts`, `docs/whitepaper`, `scripts/check-whitepaper.mjs`, `docs/spec-changelog.md`
- **Spec impact**: the whole point — but **staging only**. Nothing is pushed to `snugprotocol/spec` and nothing in `packages/protocol` changes. Publication (and the 1.0 promotion) is the owner's explicit act after review (C3, PROCESS release rules; AL-12 auth-surface publication was HELD until Beta exit — the owner's commission of a 1.0 release candidate is read as superseding that hold **for staging**, not for pushing).
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
