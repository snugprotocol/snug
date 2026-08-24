# 0054 — Website + playground deployment: in-repo direct-upload script, deploy from merged `main`

- **Status:** accepted (owner plan approval 2026-08-24, after the High-tier fresh-context plan review)
- **Date:** 2026-08-24
- **Task:** TASK-20260823-web-deploy

## Context

ADR-0048 chose Cloudflare Pages for `snugprotocol.org` (website) and `playground.snugprotocol.org` (playground) and deferred deployment to "its own explicit ask". As of 2026-08-24 nothing had been deployed and no tooling existed. The repo flips public imminently (ADR-0053), which raised **where deploy tooling lives** — public repo, a private repo, or the owner's machine — and **how deploys happen** — a local script, a GitHub Actions workflow (CI is billing-dormant, ADR-0041), or Cloudflare's Git integration. The plan review then surfaced that Pages has several ways to publish the wrong thing while every repo check is green, which this ADR now also settles.

## Decision

1. **Deploy tooling lives in this public repo** (`scripts/deploy-web.mjs` + `docs/runbooks/deploy-web.md`; `wrangler` is a root devDependency so a contributor's deploy is reproducible). A deploy script contains nothing secret: project names, build commands and domains are already public in `apps/website/src/config/site.ts` and ADR-0048. Auth is wrangler's OAuth session on the zone-holding account (or a `CLOUDFLARE_API_TOKEN` scoped to Pages, in the environment); the account id is read from a gitignored root `.env` (`.env.example` documents the key) and is never hardcoded — the requirement doubles as the "which account?" guard. No account email or id appears in the public tree. "Memory is git" applies to ops tooling as it did to docs (ADR-0048 rejected Mintlify on the same ground).
2. **Direct upload from a local script, not Git integration and not CI.** Git integration deploys every merge to `main` — contrary to the explicit-ask release rule — and Cloudflare does not allow switching a direct-upload project to Git integration later. CI is dormant (ADR-0041); a GitHub Actions deploy job may be added post-launch, with the script remaining the source of truth for what a deploy checks.
3. **Production deploys only from a clean tree on `main` equal to `origin/main`. No dirty override.** A hotfix is commit → `gate:local` → merge → deploy. `--preview` deploys any *other* branch to a `*.pages.dev` preview URL and refuses on `main` — Pages decides "production" solely by branch name equalling the project's production branch, so a preview from `main` would BE production.
4. **The upload is a distinct act.** The default invocation pre-flights, builds and verifies, then prints the exact `wrangler` argv; `--deploy` performs it. This is the release-desktop shape (ADR-0047 §13) with one entrypoint. `all` verifies both apps before uploading either.
5. **Pre-flight proves the target, not just the tree:** `wrangler whoami` must show the resolved account; `wrangler pages project list` must already contain the project (the deploy path never creates one); the build runs from a deleted `dist/` with `turbo --force` (turbo restores cached `dist/**` over stale files and never hashes gitignored inputs).
6. **Hosted-posture invariants are enforced by the script, not by memory** (ADR-0013: the hosted hub ships no sign-in, no backend). The build env pins `VITE_SNUG_HUB_AUTH=''` and `PUBLIC_SITE_MODE='production'`; any `.env*` under `apps/playground` or `apps/website` refuses; `apps/website/public/local-artifacts/` (the locally staged DMG) refuses; website HTML containing `localhost:5173` or `/local-artifacts/` refuses; the playground `dist/` must have no `404.html` (Pages' SPA fallback keys on its absence) and must carry the sql.js wasm.
7. **Naming and canonical URLs.** Pages projects `snug-website` and `snug-playground`. `www.snugprotocol.org` 301s to the apex via a **zone Redirect Rule** — Pages `_redirects` cannot match a host (wrangler skips absolute sources), so this is the one deploy fact that lives outside git; the runbook records it and the checklist verifies it. The production `*.pages.dev` hosts are **Bulk-Redirected** to the custom domains (a playground on a second origin is a second per-origin `.snug` store). Preview deployments sit behind the Pages **Access policy**, enabled before the first preview — pre-flip, an open preview would publish the launch site.
8. **Zone features that inject scripts are OFF** for this zone — Email Address Obfuscation, Rocket Loader, Cloudflare Fonts, Bot Fight Mode, Web Analytics (Auto Minify was retired by Cloudflare in 2024) — because ADR-0013's "no telemetry, falsifiable by reading the deploy config" must survive the CDN; the checklist greps every host for `cdn-cgi`.
9. **Rollback is an owner act, journaled.** Website: any prior deployment. Playground: only to a deployment with the same userdb schema version (an older build opening a newer user file lands in `unsupported`) — otherwise roll forward.

## Alternatives considered

- **Private repo / local-only script** — rejected: nothing in it is sensitive, and it would be a second thing to keep in sync with this repo's build layout while `internal/` is already moving off-tree.
- **Cloudflare Pages Git integration** — rejected (auto-deploys every merge; irreversible choice per project). Reconsider for the *website only* post-launch, as a new project.
- **GitHub Actions deploy on push** — deferred until CI billing returns; fine in a public repo (secrets are not exposed to fork PRs).
- **`--allow-dirty` production override** — rejected on review: it ships bytes that are not in git and the `--commit-hash` attached to the deployment would name a commit that did not produce them.
- **`_redirects` for www** — rejected on review: silently skipped by wrangler's parser; a byte-pinned test would have been decorative.
- **Hardcoding the account id** — rejected: zero-cost to keep out of the public tree.

## Consequences

- Root `pnpm test` gains `check-deploy-web`; the repo gains `.env.example`, `.wrangler/` in `.gitignore`, a `wrangler` devDependency, and a runbook.
- Project creation, custom domains, the www record + rule, zone-feature toggles, the Access policy, the Bulk Redirect, and every deploy remain explicit asks, each journaled with UTC time and verification performed (PROCESS.md release rules). The runbook is their script.
- The `_headers` question for the playground (a top-level CSP is inherited by `srcdoc` app frames — `packages/runner/src/csp.ts` child-6) is explicitly NOT answered here; it is a C2-tier task of its own.
