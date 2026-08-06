# Contributing to Snug

Welcome. This project runs an unusual, documented engineering process — reading the next two sections before your first PR will save you a review round-trip.

## Dev setup

Node **>= 20** and pnpm **9** (the repo pins `packageManager: pnpm@9` — `corepack enable` gets you the right one). Then:

```bash
pnpm install
pnpm build          # turbo builds every package in dependency order
pnpm test           # everything (root turbo task)
pnpm smoke          # headless happy path: build an app via the mock adapter
```

Per-package: `pnpm --filter @snugprotocol/<name> test` (packages), `pnpm --filter playground test`, `pnpm --filter server test`, `pnpm --filter examples test`. Never hit real LLM APIs in tests — use the `mock` adapter (`packages/adapters`).

## How this repo works (the short version)

The full process is [`docs/engineering/PROCESS.md`](docs/engineering/PROCESS.md) — six gates from spec to close-out. What it means for you:

- **Work is specified before it's coded.** Maintainer work happens in task files under `docs/tasks/`. As an outside contributor you don't need to write one: **for a small fix or a labeled issue, the issue is your spec** — link it from the PR. For anything Medium-sized or larger, open an issue first and get a nod before writing code; unsolicited large PRs are the most likely kind to be declined.
- **Risk tiers decide rigor.** Low = docs, `examples/`, Playground styling. Medium = most package/app code — tests first, review. High = `packages/protocol` (the schemas *are* the public spec), `packages/runner` (the sandbox), `packages/auth` (credential handling), CI/release workflows, anything touching the two hard constraints below. Touching a High path at all makes the whole change High: expect negative tests and slower, stricter review. First PRs should stay out of High paths.
- **Tests first, honestly.** Medium/High changes show a failing test before the fix ([`docs/engineering/TDD.md`](docs/engineering/TDD.md)); bug fixes include the regression test; never delete or weaken a failing test to get green. Run the suites of every package you touched **plus its dependents** (dependency graph in [`docs/architecture.md`](docs/architecture.md); in doubt, `pnpm test` at root).
- **AI review is part of the culture — stated plainly.** Much of this codebase is written by LLM agents driven through the process above by the maintainer. Every PR, human- or agent-authored, gets an AI review pass first and a human maintainer review second, over both the diff and its stated intent. Declare AI assistance if you used it; it's normal here — what's reviewed is the code, not its author.

**Closed on sight:** anything weakening the iframe sandbox or the token boundary (hard constraints C1/C2 in [`docs/conventions.md`](docs/conventions.md)) — including "just for a demo"; drive-by dependency additions (a new runtime dependency needs an ADR-level justification; `packages/protocol` allows zod only); schema edits that skip spec-sync.

## Good first PRs

Start from [`docs/good-first-issues.md`](docs/good-first-issues.md) or the `good first issue` label. A good first PR is small, has a test that fails before it and passes after, states which suites it ran, and doesn't wander outside the files the issue names. Docs fixes, error-message empathy, and test-coverage additions are genuinely valued — this is a protocol project; clarity is the product.

**Starter apps** (`examples/`) have a curation rule: every starter must trace to a real requested use — propose it in an issue with who asked for it / where the need showed up. A starter is a contract, not a demo: it doubles as documentation example and test fixture, so a starter PR includes its validator/fixture coverage (`pnpm --filter examples test` must prove it).

## Protocol changes and the spec repo

The zod schemas in `packages/protocol` are the **source of truth** for the Snug protocol. [`snugprotocol/spec`](https://github.com/snugprotocol/spec) — currently carrying spec v0.1 and the v0.2 draft — is a downstream publication: generated from here, never edited directly, so **don't PR the spec repo**. A protocol change is High tier here and follows [`docs/engineering/SPEC_SYNC.md`](docs/engineering/SPEC_SYNC.md), landing with a [`docs/spec-changelog.md`](docs/spec-changelog.md) entry. If you want to change the protocol, open an issue describing the problem first — spec churn is the most expensive kind.

## Licensing and conduct

MIT, inbound = outbound: by submitting a contribution you license it under the repository's [MIT license](LICENSE). No CLA. Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — enforced. Security findings go through [SECURITY.md](SECURITY.md), not issues.
