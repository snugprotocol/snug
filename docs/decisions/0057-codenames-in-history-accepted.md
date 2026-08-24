# 0057 — The ancestor codenames stay in git history at flip-public; the scrub tooling does not ship

- **Status:** accepted (owner decision 2026-08-24)
- **Date:** 2026-08-24
- **Task:** TASK-20260824-flip-public-scrub

## Context

The stage-1 public scrub (runbook 1.2) removed the two ancestor-system codenames from the working tree: 34 lines across 27 files, in `packages/auth` and `packages/protocol` source and test comments, two ADRs, and the *Source systems* paragraph in the three root AI files. The working tree now contains **zero** occurrences, enforced while the task ran by `scripts/check-public-scrub.mjs`.

Two facts surfaced late, in that order, and together they define this decision.

**1. The guard had to name what it forbids.** A checker for the codenames must contain them, so `check-public-scrub.mjs` and its test spelled them in four lines — meaning the tool built to withhold the names would itself publish them. The owner's call was to gitignore the tooling rather than hash the names, accepting a weaker failure message and no public tripwire in exchange for the tool not shipping at all.

**2. Untracking the tool does not remove the names from the repository.** Measured 2026-08-24: **all 372 commits on `main` contain the codenames.** They were present from the bootstrap commit, long before this task — the scrub removed them from the *tree*, not from *history*, and ADR-0053 retains full history at the flip. Gitignoring the tooling and rebuilding this task's branch to add zero new occurrences (verified: 0 additions, 34 removals) leaves that untouched.

So the repository about to be published already contains the codenames 372 times, and no amount of tree-level scrubbing changes it.

## Decision

**Accept the codenames in git history. Flip with full history as ADR-0053 provides.**

The grounds, each verified rather than asserted:

1. **The codenames are the sanitised form, not the secret.** They are opaque labels chosen precisely so the ancestors could be discussed in tracked files. Neither names a company, product, repository, or path.
2. **The real identifiers were never committed.** `git log --all -S<term>` returns nothing for any of them; the 12 long-form terms on the must-be-zero list return **0** over the tree; `git log --all` over the private strategy path is empty. `gitleaks` over all refs reports **no leaks found** (376 commits).
3. **The knowledge-store guard still ships and still covers the real identifiers.** `packages/knowledge/src/__tests__/no-ancestor-tokens.test.ts` keeps its full seven-hash set and remains in `pnpm test` (195/195). What was withdrawn is the *codename* tripwire, not the identifier one.
4. **The alternatives cost more than the exposure.** See below.

**Corollary — the scrub tooling stays gitignored.** `scripts/check-public-scrub.{mjs,test.mjs}` and `scripts/scrub-tokens.json` are untracked and removed from the root `test` script, because a script absent from a public clone would fail `pnpm test` for every contributor. It is kept in the owner's private tree and run by hand before a flip or release.

## Alternatives considered

- **Flatten history at the flip (reopen ADR-0053)** — rejected: ADR-0053 decided to keep 120 merged PRs with their review record as evidence of how the project was built, which is a launch asset. Discarding it to hide two opaque labels inverts the value.
- **`git filter-repo` over all 372 commits** — rejected: rewrites every SHA, invalidating the commit references inside 120 merged PR discussions and the seeded issues, and re-runs the stage-0 problem (the old objects would need a *second* GitHub Support purge, which took days and one ticket to achieve the first time).
- **Hash the codenames in the guard and keep it public** — considered and offered; the owner chose the gitignore route. Recorded because it remains the path back if the public tripwire is ever wanted: hash them into `scrub-tokens.json` beside the seven existing entries, at the cost of a redacted failure message.
- **Leave the guard public as-authored** — rejected by the owner on the principle that a tool built to hide a thing must not publish that thing.

## Consequences

- **The public repo has no automated codename tripwire.** A codename reintroduced after the flip is not caught by `pnpm test`. Mitigation: the tooling is run by hand as a pre-flip and pre-release step; recorded in `.gitignore`, `docs/next-steps.md`, and the private runbook.
- Anyone reading git history can see the codenames. That is now a **recorded accepted residual**, not an oversight — which is the whole point of writing this down.
- The working tree stays clean, and the discipline holds going forward: no new file should spell them. The rule that the retirement `done/INDEX.md` entry says "the two codenames" rather than naming them still applies, and was followed.
- If the ancestors are ever named publicly for other reasons (a talk, a post, an acknowledgements section), this decision is unaffected — it concerns only what the repository discloses by itself.
