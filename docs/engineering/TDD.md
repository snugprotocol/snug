# Snug — Test-First Policy (TDD)

**Red** (test fails for the right reason) → **Green** (minimum implementation; run the full package suite) → **Refactor** → **commit**. Extends [conventions.md](../conventions.md#testing).

## Rules
1. New feature = tests shown failing first, one per acceptance criterion.
2. Bug fix = failing regression test first.
3. High-tier = negative tests too (C1: injected credentials never appear in envelope payloads/responses; C2: sandbox attributes locked by test).
4. Never delete or weaken a failing test to get green.
5. Ratchet rule: coverage only goes up in files you touch.
6. Refactoring battle-tested logic = characterization tests first.

## Test commands

| Package / area | Location | Command |
|---|---|---|
| **Everything** | repo root | `pnpm test` |
| One package | `packages/<name>` | `pnpm --filter @snugprotocol/<name> test` |
| Playground | `apps/playground` | `pnpm --filter playground test` |
| Server | `apps/server` | `pnpm --filter server test` |
| Host kit | `apps/host` | `pnpm --filter host test` (tsc + vitest: probe, platform, loader, plugins); `pnpm --filter host build` then `pnpm --filter host test:e2e` (Playwright on the BUILT page); root `pnpm run check-host-kit` (structural gate + two-build reproducibility) |

Dependents rule (Gate 5): `protocol` changes → also run `runner`, `sdk`, `server`, `playground`. `db` changes → also `sdk`, `playground`. Playground SOURCE changes → also `desktop` and `host` (both alias it in; the kit's e2e opens the rebuilt page). In doubt: run everything.

## Testing the hard-to-test parts
- **LLM round-trips**: use the `mock` adapter in `packages/adapters` (scripted JSON replies) — never hit real APIs in tests.
- **iframe/postMessage**: jsdom + a bridge harness (to be built in `packages/runner/test-utils`); characterize envelope ordering, retry/backoff, parse-failure budget.
- **OPFS/sql.js**: in-memory sql.js in tests; OPFS behind an injected storage interface.
- Grow this section at Gate 6 as seams are discovered.
