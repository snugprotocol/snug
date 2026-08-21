# The Snug Protocol whitepaper

Source for **"The Snug Protocol: An Open Protocol for Agent-Backed Personal Software"**
(Jeetu Maker), **edition 2** — the design rationale, threat model, and security argument
behind the consolidated **spec v0.3 draft** (wire protocol · portable user database ·
connected applications · runtime contracts · linked-device connections).

| | |
|---|---|
| **Source** | [`src/paper.html`](src/paper.html) · [`src/paper.css`](src/paper.css) · [`src/figures/`](src/figures/) |
| **Output** | [`dist/snug-protocol-whitepaper.pdf`](dist/) — A4, 33 pages, 10 figures |
| **Spec fixture** | [`../spec-drafts/SPEC-v0.3-draft.md`](../spec-drafts/SPEC-v0.3-draft.md) + `packages/protocol/schemas/` |
| **Tasks** | edition 2: `TASK-20260820-spec-v03-whitepaper` · edition 1: `TASK-20260807-protocol-whitepaper` |

## Build

```bash
node docs/whitepaper/build.mjs        # → dist/snug-protocol-whitepaper.pdf
pnpm run check-whitepaper             # 99 conformance checks
```

The build needs a Chrome/Chromium binary (auto-detected, or set `CHROME_PATH`) and nothing
else — no npm dependency, no network fetch, system fonts only. `--keep-html` retains the
assembled single-file HTML in `dist/` for debugging.

**Let the build finish.** It renders through Chrome and then rewrites the PDF's `/Info`
dictionary; killing it midway leaves a PDF with no author metadata. The checker catches
exactly this (AC2), so run it after every build.

## Why HTML + CSS Paged Media

No TeX engine is installed on the target machine and pandoc has no PDF backend. Chrome's
print pipeline supports the subset of Paged Media that matters here — `@page` margin boxes
for running heads and folios, page counters, and full-fidelity inline SVG — with zero new
dependencies. Keeping the source as HTML also keeps it greppable, which is what lets
`scripts/check-whitepaper.mjs` verify the prose against the spec.

## The checker is the point

The spec is normative; this paper only explains it. `scripts/check-whitepaper.mjs`
treats the spec as a **fixture** and fails when the two disagree — so a constant or frame
name cannot silently drift here as the protocol moves. Pre-publication the fixture is the
staged consolidated draft in `docs/spec-drafts/` plus the schemas in
`packages/protocol/schemas/` (the monorepo is the master, per SPEC_SYNC); after the v0.3
push, point it at a `snugprotocol/spec` clone with `--spec <path>`.

| | Enforces |
|---|---|
| **AC1/AC2** | PDF builds; embedded `/Title` and `/Author` are correct (metadata, not just the cover) |
| **AC3** | Every protocol constant matches the spec draft, including the seven-kind set |
| **AC4** | Frame inventory matches `schemas/*.json` + the four v0.3 frames; all R5 codes documented |
| **AC5** | v0.3 surfaces COVERED and marked DRAFT; superseded facts (dropped tables, old counts) absent |
| **AC6** | No anti-positioning language; `host-blind`/`zero-knowledge`/`end-to-end` disclaimed, never claimed; ADR-0040's honest class statement and ADR-0043's bounded claim travel with their features |
| **AC7** | Figures are inline vector, numbered, and each cited in prose (≥10) |
| **AC8** | Structural completeness; section numbering cannot drift |

### Two things the checker cannot see

1. **Rendered numbering.** Section numbers come from a CSS counter, and Chrome compresses
   the PDF text layer, so the printed numbers are not machine-readable here. AC8 instead
   guards the CSS rule that broke once — an unnumbered `h2` that still increments the
   counter shifts every section number. Verify visually after layout changes.
2. **Typography and page fill.** Widows, stranded figures, and layout gaps need eyes. To
   render pages for review: `pip3 install pymupdf`, then
   `python3 -c "import pymupdf; d=pymupdf.open('dist/snug-protocol-whitepaper.pdf'); [d[i].get_pixmap(dpi=105).save(f'pg{i+1:02d}.png') for i in range(d.page_count)]"`.
   PyMuPDF is a review-time convenience only — never a build dependency.

## Editing

- **Content changes** go in `src/paper.html`. Every normative claim must trace to the spec
  draft; if a number here disagrees with the spec, the spec wins and the checker enforces it.
- **Figures** live in `src/figures/*.svg` and are inlined at build time via
  `<!--FIGURE:name|label|caption-->` markers. Author them as plain SVG using the shared
  `.f-*` label classes in `paper.css`; do not paste SVG bodies into the HTML.
- **New figures** must be numbered in the caption text (not by CSS counter — the checker
  needs to read them) and cited at least once from the body.
- **TOC page hints are hand-authored** (Chrome lacks `target-counter()`): after any change
  that reflows pages, re-render and update the `<span class="pg">` values.
- **Tables** break across pages by default; add `class="keep-together"` for short ones that
  read as a unit.

## Publication (C3)

The spec repo is **downstream** and is never edited directly — see
[`../engineering/SPEC_SYNC.md`](../engineering/SPEC_SYNC.md). The paper is authored here and
the built PDF is staged into a local `snugprotocol/spec` clone.

**Pushing to `snugprotocol/spec` requires an explicit human ask in-session**
([PROCESS.md](../engineering/PROCESS.md) release rules) and a
[`spec-changelog.md`](../spec-changelog.md) entry recording what was published, when, and
with what verification.
