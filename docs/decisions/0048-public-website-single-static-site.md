# 0048 — Public website: one static site for marketing, docs, spec and download

- **Status:** accepted (owner plan approval, 2026-08-21)
- **Date:** 2026-08-21
- **Task:** TASK-20260821-website-launch

## Context

Snug approaches launch with no public web presence beyond the playground app. The launch audience is two-sided: end users (try the playground, download the desktop shell) and implementors (read the spec, build a hub client or embed Snug in a SaaS). modelcontextprotocol.io is the reference for how a protocol presents itself. The owner wants the simplest repo + deploy structure that still separates the playground (an application with its own release cadence) from the marketing/docs surface.

## Decision

1. **One static site, `apps/website`, hosts everything except the playground**: landing page, docs hub (`/docs`), rendered specification, whitepaper, and the desktop download page (`/download`). The playground stays its own app on its own subdomain. Target domains: `snugprotocol.org` apex for the site, `playground.snugprotocol.org` for the playground; hosting Cloudflare Pages; **all URLs single-homed** in `apps/website/src/config/site.ts`. Deploying and DNS are separate explicit asks (release rules, PROCESS.md).
2. **Stack is Astro + Starlight.** Astro pages for the marketing surfaces (zero-JS-by-default, full design control); Starlight for the docs hub (sidebar, client-side search, dark mode, mobile nav out of the box). Fully static output — ADR-0013's zero-backend doctrine extends to the website.
3. **Docs hub content is curated, not mirrored.** Purpose-written Get Started, concept, and implementor pages; maintainer-facing process docs (engineering gates, lessons, runbooks) never publish. Spec pages are **generated verbatim** from in-repo sources — `docs/spec-drafts/SPEC-v0.3-draft.md` and `packages/protocol/schemas/` — never from the downstream `snugprotocol/spec` clone (C3: this repo is upstream; the website is one more consumer). The whitepaper ships as the built PDF plus an abstract page.
4. **Derived pages carry a sync contract.** `apps/website/docs-sync.json` maps every derived page to its source files with content hashes; `scripts/check-website-sync.mjs` runs in root `pnpm test` (the `check-whitepaper` seat) and fails naming the drifted pages when a source changes. The `.claude/commands/sync-website.md` command performs the update; a persistent memory entry reminds the humans. The manifest refuses any source under `internal/` (C4).
5. **Desktop download URLs have one home.** The website imports `apps/playground/src/desktop/releaseChannel.ts` (ADR-0047 §2's constant module) rather than restating any release URL — the same dependency direction the desktop shell already uses.

## Alternatives considered

- **Docs on their own subdomain (docs.snugprotocol.org)** — rejected: second deploy target, second nav/brand shell, no benefit at this scale; owner prefers simpler.
- **Docs inside the playground app** — rejected: couples marketing/docs cadence to app releases and bloats an SPA with static content ADR-0005 never scoped.
- **Mintlify / hosted docs platform** — rejected: external service dependency and content held outside git; "memory is git" applies to public docs too.
- **Next.js / VitePress / plain Vite+React** — rejected in interview: more shipped JS or less docs leverage or Vue-shaped theming in a React/TS repo.
- **File-watcher or CI-time auto-sync** — rejected: CI is billing-blocked and silent auto-rewrites of published prose are the auto-apply class ADR-0045 already litigated; a red gate at `pnpm test` plus an explicit command is the repo's established shape.

## Consequences

- The repo gains a third user-facing app; turbo/`apps/*` pick it up with no config change. Root `pnpm test` gains one checker.
- Launch flip-public checklist (`internal/LAUNCH_OPS.md`) gains implicit items: deploy website, wire DNS, verify download links go live with the first GitHub Release.
- The spec draft becomes publicly rendered before spec 1.0 finalizes — pages must carry the draft label until the v0.3 line publishes (ADR-0044).
- Teaser videos are transcoded web renditions committed to the website's public assets; the `.mov` masters stay outside the repo.
