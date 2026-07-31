# Anthropic skill-creator — vendored snapshot

This subtree is a verbatim copy of the Anthropic skill-creator methodology
distributed under the Apache 2.0 license (see `LICENSE.txt`).

## Source

- **Upstream repository:** https://github.com/anthropics/skills
- **Path in upstream:** `skills/skill-creator/`
- **Pinned commit (last commit touching this subtree):** `b9e19e6f44773509fbdd7001d77ff41a49a486c1`
- **Repository HEAD at vendor time:** `da20c92503b2e8ff1cf28ca81a0df4673debdbf7`
- **Date vendored:** 2026-05-29
- **Vendored by:** Snug (snugprotocol) — re-vendored 2026-07-31 from the same
  pinned upstream commit

## Snug integration

Bundled as a static asset in the central prompt store
(`packages/knowledge/prompts/skills/skill-creator/`), inlined at build time by
`scripts/gen-content.mjs` — **no runtime download**, **no boot-time fetch**.
The methodology forms the middle block of `buildSkillBuilderPrompt()`
(`src/assemble.ts`); the Snug-specific preamble and mode tails live beside this
directory and never restate what the methodology already covers.

If a newer upstream version is preferred, refresh this directory, bump the
commit hash in this NOTICE, and regenerate content (`pnpm gen:content`) — the
vendored-checksum test will hold you honest.

## License

Apache 2.0 with original Anthropic copyright; see `LICENSE.txt`. Snug does not
relicense this content. Modifications to the vendored files require updating
the `## Source` section above to mark the snapshot as non-verbatim.

## Why vendored vs. fetched

Vendoring keeps boot zero-IO, makes builds reproducible, and means a GitHub
outage cannot break skill authoring. A runtime fetcher was deliberately not
built (ADR-0004: prompts are code, versioned in git).
