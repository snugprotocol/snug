---
description: Sync the public website's derived pages after docs/spec/whitepaper changes
---

Bring the public website (apps/website) back in sync with its sources: $ARGUMENTS

The website derives pages from in-repo sources; `apps/website/docs-sync.json` maps every
derived page to its sources with content hashes, and `pnpm run check-website-sync` (part of
root `pnpm test`) goes red when a source drifts. This command is the remedy.

1. Run `node scripts/check-website-sync.mjs` and read the drift report (page ← source, with
   each entry's kind).
2. For every **generated** entry (spec pages, schema reference, whitepaper PDF): nothing to
   think about — step 4's regeneration rewrites them verbatim.
3. For every **authored** entry: read the changed source (`git diff` it if possible, so you
   see WHAT changed, not just that it changed), then update the named website page by hand
   to match. Rules:
   - Never paraphrase normative text — link to the spec pages for requirements
     (lessons 2026-08-07: diff sets and modality; no MUST-class claims absent from the spec).
   - Positioning and copy follow `docs/product-vision.md` — including its anti-positioning
     ("not an app builder", "never invite the artifacts/bolt/v0 comparison").
   - Nothing from `internal/` may inform public content (C4).
4. Run `pnpm --filter website sync-docs` — regenerates the generated pages AND re-hashes the
   whole manifest (authored entries included).
5. Verify: `pnpm --filter website build && pnpm --filter website test`, then
   `node scripts/check-website-sync.mjs` must print OK.
6. If a NEW derived page was created (or an authored page gained a new source), add it to
   `AUTHORED_PAGES` in `apps/website/scripts/sync-spec.mjs` — the manifest mapping's one
   home — and rerun step 4.

Commit the page updates and the manifest together, in the task's branch, so the gate stays
green on main.
