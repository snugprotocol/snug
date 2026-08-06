## What & why

<!-- 2–5 sentences. Link the issue this closes. Maintainers/agents: link the
     task file (docs/tasks/active/TASK-…) — no work outside a task file. -->

## Risk tier

<!-- Low (docs, examples, styling) · Medium (package/app logic) · High
     (packages/protocol, packages/runner, packages/auth, .github/workflows,
     anything touching C1/C2). Touching a High path at all makes the PR High.
     See docs/engineering/PROCESS.md. -->

Tier: <!-- Low / Medium / High -->

## Tests-first evidence

<!-- Medium/High: name the tests you wrote BEFORE the fix/feature and how they
     failed (paste the one-line failure or link the red CI run). Bug fix =
     regression test. Low-tier docs changes may write "n/a — docs". -->

## C1/C2 impact statement

<!-- Required, even if the answer is "none". C1 = token boundary, C2 = iframe
     sandbox (docs/conventions.md). Either:
       "No impact — does not touch credential paths, the runner sandbox, CSP,
        the CDN allowlist, or envelope validation."
     or describe the impact and point at the negative tests proving the
     forbidden thing is still forbidden. -->

## Checklist

- [ ] Suites of every touched package **and its dependents** are green (`pnpm test` at root when in doubt)
- [ ] No new runtime dependency (or: ADR justifying it is part of this PR)
- [ ] Docs updated in this same branch if they drifted (code-map, glossary, next-steps)
- [ ] Protocol schemas untouched, **or** this PR follows docs/engineering/SPEC_SYNC.md and updates docs/spec-changelog.md
