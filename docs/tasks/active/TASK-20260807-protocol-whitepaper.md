# TASK-20260807-protocol-whitepaper: The Snug Protocol whitepaper (PDF)

- **Status**: in-review
- **Owner**: Jeetu Maker
- **Risk tier**: low (docs-only; authors NO schema, code, or normative text — it *describes* the frozen v0.1 surface and the published v0.2 draft)
- **Branch**: `feat/TASK-20260807-protocol-whitepaper`
- **Packages touched**: none. New source tree `docs/whitepaper/`; build output staged into the local `snugprotocol/spec` clone (NOT pushed).
- **Spec impact**: none — no normative change. This is a *derivative publication* of spec v0.1 + the v0.2 draft. It does not alter `packages/protocol`, so SPEC_SYNC's change flow is not triggered; but the C3 "spec repo is never edited directly" invariant still governs where the source lives (see Plan §0).
- **Related**: ADR-0002 (spec downstream), ADR-0003 (C1/C2), ADR-0007/0010 (portable user DB), ADR-0011 (LLM-optional), ADR-0013 (static hub), ADR-0014 (credential custody); `internal/06-true-potential.md` (positioning), `internal/01-extraction-launch-plan.md` §1 (anti-positioning)

## Spec (what & why)

The spec repo publishes `SPEC.md` (v0.1, normative) and `SPEC-v0.2-draft.md`, plus byte-identical JSON Schemas — but the *rationale* is missing. `spec/whitepaper/README.md` has been a one-paragraph placeholder since v0.0. A specification says what conforming implementations must do; it deliberately does not say why the design is shaped that way, what threats it answers, or what the architecture buys the user. That argument is what makes a protocol adoptable by people who did not write it.

This task produces **"The Snug Protocol: An Open Protocol for Agent-Backed Personal Software"** — an academic-grade PDF whitepaper, authored by Jeetu Maker, in the structural tradition of the MCP whitepaper: abstract, numbered sections, formal message tables, normative-rule treatment, threat model, and a related-work section that situates Snug against MCP, the OpenAI Apps SDK, and the local-first literature. Modernised with original vector diagrams (three-actor model, frame lifecycle, trust boundary, one-file data layout, execution modes).

Content is derived **exclusively** from what is merged and published: `spec/SPEC.md`, `spec/SPEC-v0.2-draft.md`, `spec/schemas/*.json`, and the accepted ADRs. The never-claim-unbuilt rule and the anti-positioning rules in `internal/01-extraction-launch-plan.md` §1 are binding on every sentence.

**Acceptance criteria** (each becomes at least one check in `scripts/check-whitepaper.mjs`):

1. **A4 PDF builds reproducibly** from source via a single documented command, with no network fetch at build time (all fonts/assets local or system), and the build is idempotent.
2. **Author + title metadata are correct in the PDF itself** — the embedded document `Title` is the whitepaper title and `Author` is exactly `Jeetu Maker` (checked by reading PDF metadata, not just the cover page).
3. **Every normative claim traces to a published source.** Every rule cited as normative (R1–R6, C1/C2, limits, the `appDataToken` rule) matches `spec/SPEC.md` or `spec/SPEC-v0.2-draft.md` verbatim in substance; a machine check asserts the specific constants (256 KiB, 8 MiB, 5 MiB, 200 chars, 80/400, 3-strike parse budget, 100/250/500 ms, 64 MiB, 5 versions) appear with the same values as the specs.
4. **The nine frame types and their direction/purpose match the published schemas** — the frame table is checked against `spec/schemas/*.json` (`type` const + `required` fields), so the paper cannot drift from the wire.
5. **v0.2 material is unambiguously marked DRAFT** wherever it appears (section badge + prose), and schema v3 / Dynamic Auth / the credential broker appear nowhere in the document — a check greps for their absence.
6. **No unbuilt claim and no anti-positioning language.** A check greps the source for the forbidden framings ("no-code", "alternative to Artifacts/Bolt/v0", "host-blind") and fails on a hit.
7. **All figures render as vector** (inline SVG, no raster placeholders) and every figure is numbered and referenced at least once from the body text.
8. **Structural completeness**: abstract, numbered sections with a generated table of contents, running heads, page numbers, figure captions, a normative-references section, and an MIT/licence + security-contact footer consistent with the spec repo.

**Out of scope**:
- Any change to normative text, schemas, or `packages/protocol`. If drafting surfaces a genuine spec defect, it is recorded in "Decisions & surprises" and filed as its own task — never fixed inline here.
- Pushing to `snugprotocol/spec` (PROCESS.md release rules — needs an explicit ask in-session). This task stages and commits locally in the spec clone at most.
- Dynamic Auth / schema v3 / connected-fetch, and anything in `internal/` (C4).
- Marketing/launch copy, landing page, the launch film. Different altitude, different assets.
- A LaTeX toolchain migration.

## Plan

### §0 — Where the source lives (C3 compliance)

C3 and SPEC_SYNC state the spec repo is *never edited directly*; the monorepo is master and content lands downstream as a single traceable commit. So:

- **Source of truth**: `snug/docs/whitepaper/` (this repo) — Markdown-free, HTML+CSS source, SVG figures, build script, checker.
- **Publication**: the build emits `snug-protocol-whitepaper.pdf`; a staging step copies the PDF **and** its source into the local `../spec/whitepaper/` clone on a branch, committed but **not pushed**. The push is a later, explicitly-asked step that also gets a `docs/spec-changelog.md` entry.

### Build approach

HTML + CSS Paged Media rendered by headless Chrome (already installed; no new dependency, no network). Chrome's print pipeline supports `@page`, running heads, page counters, and inline SVG at full vector fidelity, and keeps the source diffable — which matters because the checker greps it.

### Files to touch (in order)

| # | File | Purpose |
|---|---|---|
| 1 | `docs/whitepaper/README.md` | How to build, how to check, where it publishes, the C3 note |
| 2 | `docs/whitepaper/src/paper.css` | Academic print stylesheet: A4, `@page` margins, running heads, counters for sections/figures, cover, TOC, tables, code, footnotes; light-only (print) |
| 3 | `docs/whitepaper/src/figures/*.svg` | 7 original vector figures (list below) |
| 4 | `docs/whitepaper/src/paper.html` | The document itself — the writing |
| 5 | `docs/whitepaper/build.mjs` | Renders HTML → PDF via headless Chrome; sets PDF Title/Author metadata; deterministic |
| 6 | `scripts/check-whitepaper.mjs` | The acceptance checks (AC1–AC8), runnable standalone and in CI |
| 7 | `docs/whitepaper/dist/snug-protocol-whitepaper.pdf` | Build output (committed — it is the deliverable) |
| 8 | `../spec/whitepaper/` | Staging copy on a spec-repo branch; **no push** |

### Figures (all original, all inline SVG)

1. **Fig. 1 — The three actors.** LLM provider / hub provider / end user, with the user file at the centre and the "hub is a convenience, never a requirement" edge annotated.
2. **Fig. 2 — System architecture.** Host page, runner, sandboxed iframe, transport seam, the three execution modes, user DB + OPFS + sync origins. Derived from the `docs/architecture.md` component block.
3. **Fig. 3 — Frame lifecycle sequence.** announce → host-ready → app-message → agent turn → streaming frames → terminal response, with the R3 terminal-frame guarantee and the cancel/supersede paths.
4. **Fig. 4 — The trust boundary (C1/C2).** What crosses and what never crosses: credentials, LLM payloads, publisher. Shows the header-strip point and `connect-src 'none'`.
5. **Fig. 5 — One file.** The user DB layout: `snug_*` hub namespace vs `app_<token>__*` native per-app tables, versions with the pinned factory version, chats, wiki, secrets.
6. **Fig. 6 — Materialisation.** At-rest namespaced tables → per-app runtime DB with natural names; physical isolation at runtime (ADR-0010).
7. **Fig. 7 — Execution modes.** byok / local / subscription, with the invariant that LLM calls originate from the host page in all three.

### Document structure

Abstract · 1 Introduction (the market-of-one problem) · 2 Design goals and non-goals · 3 Architecture: the three actors · 4 The wire protocol (4.1 frames, 4.2 the nine message types, 4.3 normative rules R1–R6, 4.4 the chat envelope, 4.5 the agent reply contract) · 5 Security model (5.1 threat model, 5.2 C1 token boundary, 5.3 C2 sandbox integrity, 5.4 residual risks — stated honestly, incl. the at-rest secrets trade-off from ADR-0014) · 6 The portable user database (DRAFT, v0.2) · 7 Conformance · 8 Related work (MCP, OpenAI Apps SDK, local-first / Ink & Switch) · 9 Limitations and future work · 10 Conclusion · Normative references · Appendix A: message schema summary.

### Test plan (tests FIRST — Gate 3)

`scripts/check-whitepaper.mjs` is written **before** `paper.html`, and starts red. It parses the built PDF for metadata (AC1, AC2), reads `spec/SPEC.md`, `spec/SPEC-v0.2-draft.md`, and `spec/schemas/*.json` and asserts the paper's constants and frame table agree with them (AC3, AC4), and greps the source for DRAFT marking, excluded surfaces, forbidden claims, raster images, and unreferenced figures (AC5–AC8). Low-tier task, but this checker is what stops the paper drifting from the spec — it is the substantive test and it runs in CI.

Order: checker (red) → CSS + figures → prose → build script → green → self-review pass for tone/accuracy → stage into spec clone.

### Cross-package impact

None. No `packages/*` file is read at build time or modified. The checker reads the **spec repo** as its fixture, which is the correct direction of dependency (paper conforms to published spec).

## Decisions & surprises

- **2026-08-07 — Source lives in the monorepo, not the spec repo.** The literal ask was "inside the spec repo", but C3/SPEC_SYNC forbid direct spec edits and PROCESS.md §4 forbids pushing without an explicit ask. Resolved with the owner at Gate 1: author in `snug/docs/whitepaper/`, stage the built PDF into the spec clone on a branch, leave the push as a separate explicit decision. The deliverable still *lands* in the spec repo; only its authorship path changes.
- **2026-08-07 — No LaTeX on this machine.** `pandoc` is present but has no PDF backend, and no TeX engine is installed. Chosen: HTML/CSS Paged Media + headless Chrome (owner-selected) — zero new dependencies and full control over figures.
- **2026-08-07 — Schema v3 / Dynamic Auth deliberately excluded**, matching the version note in `SPEC-v0.2-draft.md`. AL-09 is mid-flight on another branch; publishing its surface would break the never-claim-unbuilt rule. AC5 enforces the exclusion mechanically.

## Session journal (append-only, newest last)

### 2026-08-07 — Jeetu Maker (with Claude) — session
- Done: Gate 1 spec + Gate 2 plan written. Read PROCESS.md, SPEC_SYNC.md, both spec documents, all 10 published schemas, ADRs 0003/0007/0010/0011/0014, `internal/06` and `internal/01` §1 for positioning and anti-positioning rules. Confirmed toolchain (pandoc present, no TeX; Chrome available). Owner interview settled four decisions: monorepo-authored + staged, v0.1 + v0.2-draft scope, Chrome/CSS Paged Media, full visual treatment.
- State: plan complete, awaiting approval. No implementation code written.
- Next step: on approval — create branch off `main`, write `scripts/check-whitepaper.mjs` red first, then figures, then prose.
- Open questions: none blocking. The spec-repo push remains explicitly deferred.

### 2026-08-07 — Jeetu Maker (with Claude) — session
- Done: **all eight acceptance criteria met; 70/70 conformance checks green.** Built the
  22-page A4 PDF (`docs/whitepaper/dist/`, 939 KB) with 7 original inline-SVG figures,
  authored via HTML + CSS Paged Media through headless Chrome — no TeX, no npm dependency,
  no network at build time. Checker written red first (Gate 3), then figures, CSS, prose,
  build script. Staged into the spec clone on branch `docs/whitepaper-v0.1` (commit
  `ae6ec8b`), **not pushed**.
- **Defects found and fixed, each now guarded by a check that was proven to fail without
  the fix:**
  1. Every section number was off by one — an unnumbered `h2` suppressed `::before` but
     still incremented the counter, so "Contents" consumed §1. Invisible in source; only
     the rendered PDF showed it. AC8 now asserts the CSS rule.
  2. Five of seven figures were never cited in prose. The reference check had counted the
     caption as a citation, so it passed; it now strips captions before counting.
  3. A build killed mid-run left a PDF with no `/Author` metadata — caught by AC2, which
     is why the metadata check reads the `/Info` dictionary rather than the cover page.
  4. R5 overclaim: the paper listed `MALFORMED` among R5's known error codes, but SPEC.md
     defines it in R1 and omits it from R5. AC4 had only checked that each code *appears*
     somewhere; it now compares the paper's R5 list against the spec's as sets.
  5. (Fresh-context review) §6.2 stated the reserved-prefix rule absolutely, dropping the
     spec's single normative exemption, `snug_kv` — and §4.1 lists the `kvGet`/`kvSet`
     operations that table backs, so the paper contradicted itself.
  6. (Review) §5.4 discussed v0.2 storage material under a Normative·v0.1 badge without
     the Draft badge the paper's own Conventions callout promises.
  7. (Review) §5.2 asserted always-strict credential injection as a C1 requirement and
     §5.3 asserted a fixed CDN allowlist as part of C2. **Neither appears in either
     published spec file** — both were internal implementation doctrine. Now stated as
     recommendation and host policy respectively, explicitly not v0.1 requirements.
- A fresh-context review also fact-checked Appendix A against all 10 schemas' `required`
  arrays, the frame table's directions, every R6 constant, all eleven §-references and
  seven figure citations, and the unpublished-surface exclusion: **all clean.**
- State: content complete and verified; branch `feat/TASK-20260807-protocol-whitepaper`
  (4 commits) not yet merged. Spec clone holds an unpushed staging commit.
- Next step: owner review of the PDF. Then PR + merge here; the spec-repo push is a
  separate explicit decision needing a `spec-changelog.md` entry.
- Open questions: whether to push to `snugprotocol/spec` now or hold until the paper has
  had wider review — owner's call, deliberately not taken here.

### 2026-08-07 — Jeetu Maker (with Claude) — close-session (Gate 6)
- Done: owner approved the paper and asked to close, PR, and merge. Gate-6 sweep completed
  in-branch: **lessons** — two entries appended (presence-vs-conformance checks; CSS
  generated content being invisible to both source greps and PDF text extraction).
  **Docs drift** — the whitepaper was undiscoverable from the wiki, so
  `docs/INDEX.md` (Living state) and `docs/code-map.md` (next to the spec-publication row)
  now point at `docs/whitepaper/`. **next-steps** — shipped entry plus a dated entry for
  the deferred spec push, recording the unpushed spec-clone branch and commit SHA.
- **No ADR**: no architectural decision was made. The toolchain choice (HTML + CSS Paged
  Media via headless Chrome, chosen because no TeX engine exists on this machine) is
  recorded in the task file's Decisions section and `docs/whitepaper/README.md`; it binds
  one docs artifact, not the system.
- **No spec-changelog entry, deliberately**: `packages/protocol` was untouched. This is a
  derivative publication of an already-published spec, not a protocol change, so
  SPEC_SYNC's change flow is not triggered. The changelog entry belongs to the *push*,
  which remains deferred and needs an explicit ask.
- State: 8 commits on `feat/TASK-20260807-protocol-whitepaper`; 70/70 checks green;
  22-page PDF at `docs/whitepaper/dist/`, `/Author` = Jeetu Maker. Spec clone holds the
  unpushed staging commit `ae6ec8b` on `docs/whitepaper-v0.1`.
- Next step: PR → merge to `main` → move this file to `done/`.
- Open questions: the spec-repo push timing (recorded in next-steps, needs an explicit ask).
