# SPEC_SYNC — how this repo drives `snugprotocol/spec`

**This monorepo is the master.** The `spec` repo is a clean, human-readable publication of the protocol — `SPEC.md`, `schemas/`, the whitepaper PDF, a README — no process files, no code, no churn. It is **never edited directly**; every change lands there from here. Its `main` takes pull requests only (branch protection), and every push is the owner's own act after an explicit ask in the session (PROCESS.md release rules).

## Source of truth
- Envelope message types + zod schemas: `packages/protocol/src/` (JSON Schema exported byte-identical to `packages/protocol/schemas/` by `pnpm --filter @snugprotocol/protocol gen:schemas`; `schemas-stable.test.ts` pins the sixteen file names and committed == generated).
- Spec prose: `docs/spec-drafts/SPEC.md` — the draft of the NEXT publication, kept normative-voiced; the published copy is the spec repo's `SPEC.md` at the SHA the changelog records.
- The whitepaper: `docs/whitepaper/src/paper.html` (+ `paper.css`, `src/figures/`), built to `docs/whitepaper/dist/snug-protocol-whitepaper.pdf`; `scripts/check-whitepaper.mjs` treats the spec draft as a fixture.
- The record of every publication: [`docs/spec-changelog.md`](../spec-changelog.md).

## The flow (every protocol change — the 1.1 and 1.2 procedure)
1. **Task file** in this repo (High tier — `packages/protocol` is High). Its "Spec impact" bullet states what moves: message(s) added or changed, the version bump (post-1.0 an additive change bumps the minor, a breaking one the major; spec versions are independent of npm package versions), the compatibility note (what an older host answers, what an older hub does with a newer row), and the whitepaper edition.
2. **Gate 2** writes the spec's new normative text INTO the contract — the sentences the spec will carry verbatim — so the test lanes, the implementation and the docs lane all read one source.
3. **Implement** schema + code + tests here; `pnpm --filter @snugprotocol/protocol build && gen:schemas` after every frame or record edit; the schema snapshot and the variant-count pins move in the same PR.
4. **Edit the draft** `docs/spec-drafts/SPEC.md`: the header (version, date, task; the revision note, newest first, mirroring the previous note's phrasing; the "supersedes" clause with the compatibility rule), the sections, Part VII, Appendices A/B/C. `PROTOCOL_VERSION` moves only on a wire break.
5. **Stage the changelog entry** at the top of `docs/spec-changelog.md` as `## <date> — spec X.Y — **STAGED, not yet pushed** — TASK-<id> — <summary>` in the previous entry's style (a bold lead sentence, §-by-§ prose, the compatibility note, the `schemas/` regenerated line, the two-commit sentence). The `**PUSHED**` rewrite with the SHAs lands by a docs PR here AFTER the push — never in the feature PR.
6. **Sync the website and the whitepaper**: `apps/website/scripts/sync-spec.mjs`'s `SPEC_BANNER` → the new version, the authored pages hand-edited, `pnpm --filter website sync-docs` (`/sync-website`); the whitepaper's edition and version strings, `paper.css`'s running head, the README, `scripts/check-whitepaper.mjs`'s version pins and header; `node docs/whitepaper/build.mjs` then `pnpm run check-whitepaper` (AC1–AC8 green); the root `pnpm test` gate reds on drift until the manifest is re-hashed.
7. **Merge here first.** The feature PR carries the draft, the staged entry, the schemas and the paper. Nothing has left this repo yet.
8. **Then, on the owner's explicit yes in the session**, publish from the local clone `/Users/jeetu/SnugProtocol/spec` (its `main` takes PRs only): a branch; **two commits** — (1) `spec X.Y: <summary> (from snug TASK-<id>)` = `SPEC.md` + `schemas/` + the README's version strings; (2) `whitepaper: edition N — <summary>` = the PDF; a PR; rebase-merge so the two land as two; `pnpm run check-whitepaper -- --spec /Users/jeetu/SnugProtocol/spec` against the clone; then the docs PR here that rewrites the staged entry to `**PUSHED** <sha1> (spec + schemas + README) · <sha2> (whitepaper edition N) via snugprotocol/spec#<n>`.

## Invariants
- Spec repo history = one publication per spec change (two commits: the spec, the paper), each traceable to a task here through the changelog.
- Schemas in the spec repo are byte-identical to `packages/protocol/schemas/` at the referenced commit (`check-whitepaper --spec <clone>` reads them; a `check-spec-sync` CI gate is still to be added).
- Anything in the spec repo not explained by the changelog is drift — fix by re-publishing from here.
- A staged entry is a promise, not a record: until the `**PUSHED**` rewrite lands, the published spec is the previous version, and the website's generated spec pages say what the draft says only because this repo is the master.
