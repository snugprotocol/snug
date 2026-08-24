# Snug — Conventions

The working agreements every human and agent follows. Read this before writing or reviewing code. Language detail: [standards/typescript.md](standards/typescript.md).

---

## Hard constraints (MUST)

- **C1 — Token boundary.** Credentials/tokens never enter the app iframe, never reach the LLM, never appear in envelope payloads, logs, or error messages. Credential injection happens server-side in the broker (`packages/auth` + `apps/server`), is host-bound against the spec's declared hosts, **strict always** (no `STRICT_*` escape flags — an off-by-default flag of this kind is a known exfiltration path; we do not introduce one). Response bodies are scrubbed of injected header values before returning to the LLM.
- **C2 — Sandbox integrity.** Runner iframes: `sandbox="allow-scripts"` only (never `allow-same-origin`), CSP with `connect-src 'none'` for app-originated traffic, fixed CDN allowlist (per packages/protocol CDN_ALLOWLIST (jsdelivr, cdnjs, unpkg) — changing it is a protocol change (C3)
- **C3 — Protocol changes flow through spec-sync.** See [engineering/SPEC_SYNC.md](engineering/SPEC_SYNC.md). `snugprotocol/spec` is never edited directly.
- **C4 — pre-launch strategy stays private.** It lived in a private folder, now maintained outside this repo; nothing from it may inform public content.
- **C5 — Security is first-class.** Secrets via env vars in `apps/server` only (`.env` gitignored, `.env.example` documented); packages take secrets only via injected interfaces (`KeyProvider`, adapter config). Validate and schema-parse every envelope message at the boundary (zod). Never log tokens, keys, or full credential material.

---

## Language-expert personas

| Language | Embody the league of… | Standard |
|----------|----------------------|----------|
| **TypeScript** | Anders Hejlsberg; front-end: Evan You / Rich Harris | [standards/typescript.md](standards/typescript.md) |

Optimize for **clarity and maintainability over cleverness**.

---

## Code style (shared baseline)

- TypeScript strict mode everywhere; no `any` at package boundaries; zod schemas for every runtime boundary.
- pnpm workspaces + turbo; each package builds independently; `packages/protocol` and `packages/sdk` must stay **zero-backend-dependency** (a dev must be able to adopt them with their own backend in an afternoon).
- Envelope protocol messages are versioned and JSON-only; parsers are total (never throw on unknown fields — ignore-and-log).
- **Match existing patterns** — grep for a similar implementation before inventing a new shape.

## Dependency policy

- Prefer reducing third-party dependencies; a new dependency requires justification in an ADR. `packages/protocol` allows zod only.

## Testing

- Test-first per [engineering/TDD.md](engineering/TDD.md); vitest everywhere.
- Name tests by behavior; cover happy path, edge, error, and (for C1/C2 areas) **negative security tests** — prove the forbidden thing is forbidden.

## Memory hygiene {#memory-hygiene}

- No work outside a task file; close every session with `/close-session`.
- Decisions append-only; next-steps dated; lessons to [lessons.md](lessons.md); deep write-ups to [solutions/](solutions/).
- Load only what a task needs.

## Sync rule for the three root AI files {#sync-rule}

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md` are thin pointers with an **identical shared body**. Prefer editing `docs/` only; if the shared body must change, change it identically in all three (diff must be empty).
