# TASK-20260822-public-spec-presentation: clean public spec header + self-identifying whitepaper edition

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: low/medium (website generation + whitepaper cover; no protocol change)
- **Branch**: `fix/TASK-20260822-public-spec-presentation`
- **Packages touched**: `apps/website` (sync-spec.mjs + regenerated pages), `docs/whitepaper` (cover), `scripts/check-whitepaper.mjs` (if a pin moves)
- **Spec impact**: none (presentation only; SPEC-1.0.md text untouched)
- **Related**: ADR-0048 §3 (generated-verbatim doctrine — amended for the HEADER only, ADR-0051), owner feedback 2026-08-22

## Spec (what & why)

Owner review of the local site: (1) the whitepaper appears "not published" — root cause
is two-fold: THREE stacked astro servers (a `preview` serving an old `dist/` + two dev
instances; the owner's :4323 tab is a stale one) while every PDF on disk is
byte-identical edition 3; and the PDF never VISIBLY names its edition, so even the fresh
artifact does not self-identify. (2) the public /docs/spec/ index renders the spec's
engineering header verbatim — Task ids, supersedes-filenames, the load-bearing
source-file list, revision details — process detail that does not belong on a public
site. The owner wants the MCP-style presentation: the latest spec, version prominent.

**Decisions (owner direction + this task's calls, recorded in ADR-0051):**
- The WEBSITE's spec index gets a public header: title, version · date · status line,
  stability table, conventions, document nav. Process bullets stay OUT. Normative Part
  pages remain generated verbatim (the ADR-0048 guard holds for normative prose).
- The spec REPO's SPEC.md keeps the full engineering header — task traceability there is
  a feature; the website is the public rendering.
- No multi-version switcher yet: exactly one public version exists (1.0). The banner +
  header carry the version; a switcher becomes real when a 1.x lands (noted in ADR-0051).
- The whitepaper cover gains an **Edition** entry ("3 — the 1.0 edition") so the artifact
  self-identifies; rebuild + re-sync.

**Acceptance criteria:**
1. Regenerated `/docs/spec/` index contains NO Task ids / internal file paths / process
   bullets; version + status prominent at top; Parts nav intact.
2. Part pages byte-unchanged (still verbatim from SPEC-1.0.md bodies).
3. PDF cover shows the edition; checker green (both fixture modes); PDF re-synced to the
   website (manifest hash follows).
4. `check-website-sync` + website tests + build green.
5. Stale servers reaped (command-line-verified); one fresh dev server for the owner.

**Out of scope**: spec-repo README/SPEC.md changes; deployment; a version switcher.

## Plan

1. Reap the three astro instances; restart one fresh dev server.
2. `paper.html` cover: add the Edition block; rebuild; checker.
3. `sync-spec.mjs`: replace the verbatim-preamble index body with the public header
   (version/date/status line + stability table + conventions + nav), sourced from the
   same SPEC-1.0.md fields; re-run sync.
4. ADR-0051 (amends ADR-0048 §3 for the index header); website build + tests + gate.
5. Gate 6.

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (Fable 5) — session
- Done: diagnosis (PDF byte-identical everywhere; three stacked servers — an `astro
  preview` serving an OLD dist plus two dev instances, the owner's :4323 tab was stale;
  Task ids only in the index header). All three reaped (command-line verified); one
  fresh dev server on :4321. `sync-spec.mjs` index generation rewritten to the PUBLIC
  header (version/date extracted, stability+conventions verbatim, process bullets and
  revision note dropped; structure-changed and TASK-id-leak guards throw at generation).
  Whitepaper cover self-identifies: `1.0 · edition 3` — **folded into the Specification
  cell after a 4th cover-meta cell turned out to trigger Chrome print's whole-document
  shrink-to-fit** (33pp→29pp at ×0.91 on every font; isolated by A/B rebuilds from
  `git show HEAD:`; lesson recorded; README trap note added). ADR-0051 written +
  indexed (amends ADR-0048 §3, header scope only).
- Verification: checker 104/104 BOTH fixture modes; TOC hints re-verified ALL OK at
  33pp; cover render reviewed; website build 24 pages + 33/33 tests +
  `check-website-sync` 24/40 green; PDF hash identical dist↔website-public. Spec clone:
  PDF refresh staged as `adc6901`, UNPUSHED (cover-only change; push on the owner's
  word).
- State: done pending merge.
- Next step: PR → merge → done-index → retire.
