# 0051 — Public spec pages: engineering header stays home; the website renders a public header

- **Status:** accepted (owner feedback 2026-08-22: the spec index "has all our draft,
  edits details with Task number… too much for a public web site"; amends ADR-0048 §3)
- **Date:** 2026-08-22
- **Task:** TASK-20260822-public-spec-presentation

## Context

ADR-0048 §3 made the website's spec pages generated **verbatim** from the in-repo
specification — the structural guard against paraphrase drift. At 1.0 that verbatim rule
faithfully rendered the document's engineering preamble onto the public site: task ids,
superseded filenames, the load-bearing source-file list, and the revision note — process
detail a launch visitor should never meet. The owner also wants the version prominent,
MCP-style.

## Decision

1. **The verbatim rule is scoped to normative content.** Part I–VI pages and the
   appendices remain generated verbatim, unchanged. The spec **index** page now renders a
   constructed **public header**: a version · date · status blockquote (version/date
   EXTRACTED from the spec's own header, never retyped), the document nav, and the
   spec's "Stability at a glance" and "Conventions" sections carried verbatim. The
   process bullets and the revision note are dropped from the website only.
2. **The generator guards the boundary**: `sync-spec.mjs` throws if the preamble
   structure changes under its extraction, and throws if any `TASK-\d{8}` id reaches the
   built index — a regression cannot ship silently.
3. **The spec repo keeps the full engineering header.** `SPEC.md`'s task traceability is
   a feature of the publication record; the website is the public rendering of the same
   bytes.
4. **No version switcher yet.** Exactly one public spec version exists (1.0); the banner
   and header carry it. An MCP-style version picker becomes real work when a 1.x
   publishes — until then a switcher over one entry is furniture.
5. **The whitepaper self-identifies its edition on the cover** (`1.0 · edition 3`,
   folded into the Specification cell — a fourth cover-meta cell triggers Chrome print's
   whole-document shrink-to-fit; the whitepaper README records the trap).

## Alternatives considered

- **Render the full header and rely on the banner** — rejected by the owner's review;
  process detail on a public page reads as unfinished work.
- **Move the engineering header out of SPEC-1.0.md itself** — rejected: the spec document
  is the publication record, and C3 traceability (task per change) is load-bearing there.
- **Build a version switcher now** — rejected: one version; premature machinery.

## Consequences

- `sync-spec.mjs` owns a small extraction contract against the spec preamble's headings;
  a heading rename there is now a build-time error rather than silent drift.
- ADR-0048 §3's "generated verbatim" reads with this scope note henceforth.
- When 1.x lands, the index header's version line and a version nav are the seat to
  extend.
