# Contributing to Snug

Contributions are welcome from day one — issues, docs, examples, and PRs.

## Ground rules

- **Fork-based PRs.** Nothing merges without maintainer review (CODEOWNERS + branch protection on `main`).
- **One branch per change**, small commits, tests first for anything beyond docs (see `docs/engineering/TDD.md`).
- **Protocol changes are special:** the envelope schemas in `packages/protocol` are the source of truth for the spec. Any change to them requires a task file + an approved plan + a spec-sync entry (`docs/engineering/SPEC_SYNC.md`). Don't PR schema changes casually.
- **Never weaken the sandbox or the token boundary** (hard constraints in `docs/conventions.md`). Such PRs are closed on sight.
- Look for **`good first issue`** labels to get started.

## Dev setup

pnpm 9+, Node 20+. `pnpm install` → `pnpm test` (root runs everything). Per-package: `pnpm --filter @snugprotocol/<pkg> test`.

## Licensing

MIT. By submitting a contribution you agree it is licensed under the repository's MIT license (inbound = outbound). No CLA.

## Conduct

Contributor Covenant — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be kind; this project was partly built by an 11-year-old's flying pig.
