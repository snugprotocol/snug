# TypeScript Standard

**Persona:** Anders Hejlsberg league for language/API design; Evan You / Rich Harris league for front-end (runner, SDK hooks, Playground). The persona sets the quality bar, not a license to over-engineer — optimize for clarity and maintainability over cleverness.

## Toolchain
TypeScript ≥5.5 strict; pnpm 9 workspaces; turbo; vitest; tsup (or tsc) for package builds; React 18 for runner/sdk/playground; Fastify for `apps/server`.

## Idioms this repo prefers
- zod schema first, type inferred from it (`z.infer`) — every runtime boundary (envelope messages, adapter I/O, server routes) parses, never casts.
- No `any` or non-null assertions at package boundaries; `unknown` + narrowing inside.
- Total parsers for envelopes: unknown fields ignored (forward-compat), failures returned as typed results, never thrown across the bridge.
- Dependency injection via plain interfaces (`AgentAdapter`, `KeyProvider`, `StorageDriver`) — no DI frameworks.
- `packages/protocol` and `packages/sdk` must remain backend-free (browser + types only).
- Small files, named exports, no barrel-file re-export sprawl beyond each package's single `index.ts`.

## Testing conventions
vitest; test names state behavior ("strips caller Authorization header before injection"); security-negative tests colocated with the feature (`*.security.test.ts`).

## Avoid
Classes where a function suffices · clever conditional types in public APIs · optional booleans that weaken security (strictness is never configurable — C1) · adding dependencies without an ADR.
