# Runbook — deploying the website and the playground (Cloudflare Pages)

**What this deploys:** `apps/website` → `https://snugprotocol.org` (Pages project `snug-website`) and `apps/playground` → `https://playground.snugprotocol.org` (Pages project `snug-playground`). Both are static direct uploads (ADR-0013: the hosted hub has no backend; `apps/server` is never deployed by this process). Decisions: [ADR-0054](../decisions/0054-web-deploy-tooling.md); hosting choice: [ADR-0048](../decisions/0048-public-website-single-static-site.md).

**Release rule (PROCESS.md):** every step marked 🔑 is an explicit human ask in that session and is journaled — what, when (UTC), verification performed.

The script is `scripts/deploy-web.mjs`. Run it from the repo root.

```sh
node scripts/deploy-web.mjs init                        # print the one-time setup commands
node scripts/deploy-web.mjs website                     # pre-flight + build + verify + PRINT (no upload)
node scripts/deploy-web.mjs all --deploy                # 🔑 upload both (only after both verified)
node scripts/deploy-web.mjs playground --preview --deploy   # 🔑 preview from a feature branch
```

## Prerequisites

1. `pnpm install` (wrangler is a root devDependency — `pnpm exec wrangler --version` ≥ 4).
2. `pnpm exec wrangler login` **on the Cloudflare account that holds the `snugprotocol.org` zone** (the account name is recorded in `internal/LAUNCH_OPS.md`, not here). If `wrangler whoami` lists more than one account or the wrong one: `pnpm exec wrangler logout` and log in again.
3. Root `.env` with `CLOUDFLARE_ACCOUNT_ID=<id from wrangler whoami>` — copy `.env.example`. The script refuses without it and refuses if the wrangler session is on a different account.

## One-time setup (🔑 each, in this order)

1. **Create the projects** — the script never does this:
   ```sh
   pnpm exec wrangler pages project create snug-website --production-branch main
   pnpm exec wrangler pages project create snug-playground --production-branch main
   ```
2. **Custom domains** (dashboard → Workers & Pages → project → *Custom domains* → *Set up a domain*): `snugprotocol.org` on `snug-website`; `playground.snugprotocol.org` on `snug-playground`. The zone is on the same account, so Cloudflare creates the CNAME records itself (the apex is CNAME-flattened).
3. **`www` → apex (301).** Pages `_redirects` cannot match a host (wrangler silently skips absolute-URL sources), so this lives in the zone, outside git:
   - DNS: add a **proxied** placeholder record for `www` (`AAAA www 100::`), so the rule has something to run on.
   - Rules → *Redirect Rules* → create: *when* hostname equals `www.snugprotocol.org` → *dynamic* redirect to `concat("https://snugprotocol.org", http.request.uri.path)`, status **301**, preserve query string.
4. **Zone features OFF** (each injects a `/cdn-cgi/` script or beacon into pages ADR-0013 promises are inert): *Scrape Shield → Email Address Obfuscation* off (it rewrites `security@snugprotocol.org` on the site and injects a script); *Speed → Optimization → Rocket Loader* off (rewrites module scripts — breaks the playground); *Speed → Cloudflare Fonts* off (rewrites font links to `/cdn-cgi/`); *Security → Bots → Bot Fight Mode* off (injects a challenge script into HTML); *Analytics → Web Analytics* — do not enable for either project. (*Auto Minify* — retired by Cloudflare in 2024; nothing to toggle.) Confirm with the `cdn-cgi` check in **Verify**.
5. **Preview Access policy** (project → *Settings* → *Enable access policy* / Cloudflare Access for `*.<project>.pages.dev` previews; first use prompts to create a Zero Trust organization — pick a team name, free plan) — **before the first `--preview` deploy**. Pre-flip, an open preview URL would publish the launch site and playground to anyone who guesses the branch name.
6. **`*.pages.dev` Bulk Redirect** (account → *Bulk Redirects* → list `snug-pages-dev`, two entries): source `snug-website.pages.dev` → target `https://snugprotocol.org`, and source `snug-playground.pages.dev` → target `https://playground.snugprotocol.org`; status 301; *Subpath matching* ON, *Preserve path suffix* ON, *Preserve query string* ON, **Include subdomains OFF** (on, it would 301 the `*.snug-website.pages.dev` previews to production and defeat step 5). The playground on a second origin would be a second per-origin `.snug` store — users must land on one host.
7. Record all of the above in the task journal + `internal/LAUNCH_OPS.md`.

## Routine deploy

1. From a **feature branch**: `node scripts/deploy-web.mjs <app> --preview` → read the printed command → 🔑 rerun with `--deploy` → smoke the preview URL wrangler prints (behind the Access policy).
2. Merge via the normal gate (`/close-session` → `gate:local` → PR → `main`).
3. On a **clean `main` equal to `origin/main`**: `node scripts/deploy-web.mjs all` → 🔑 `--deploy`. The script refuses a feature branch, a dirty tree, a stale `main`, an app-level `.env*` file, a staged `apps/website/public/local-artifacts/`, and a build that is not fresh (it deletes `dist/` and runs `turbo … --force`).
4. Walk **Verify**, then journal (what, UTC time, checklist results, deployment id from `pnpm exec wrangler pages deployment list --project-name <project>`).

**Half-deploy recovery:** `all --deploy` uploads the website first; if the playground upload then fails (network, wrangler), the site is live on the new build and the script exits 1 — rerun `node scripts/deploy-web.mjs playground --deploy` from the same `main` (pre-flight allows it) and journal both.

Preview mode never targets `--branch main` (Pages decides "production" purely by branch name); production mode never runs from anything but `main`. There is no dirty override: a hotfix is commit → gate → merge → deploy.

## Verify (after every production deploy)

```sh
for h in snugprotocol.org playground.snugprotocol.org; do
  printf '%s -> ' "$h"; curl -s -o /dev/null -w '%{http_code}\n' "https://$h/"
  printf '  cdn-cgi injections: '; curl -s "https://$h/" | grep -c cdn-cgi      # must be 0
done
curl -sI https://www.snugprotocol.org/docs/ | grep -iE '^(HTTP|location)'       # 301 → https://snugprotocol.org/docs/
curl -sI https://snug-website.pages.dev/ | grep -iE '^(HTTP|location)'         # 301 → snugprotocol.org (Bulk Redirect)
curl -s -o /dev/null -w '%{http_code}\n' https://playground.snugprotocol.org/settings   # 200 — SPA fallback serves index.html
curl -s -o /dev/null -w '%{http_code}\n' https://snugprotocol.org/docs/spec/          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://snugprotocol.org/whitepaper/snug-protocol-whitepaper.pdf   # 200
```

Then by hand: landing page teaser plays; `/download` links resolve (they 404 by design until the first GitHub Release — ADR-0047); playground boots in demo mode with **no sign-in affordance anywhere** (ADR-0013); the `about ↗` link lands on the apex; one spec page renders.

## Rollback (🔑, journaled)

`pnpm exec wrangler pages deployment list --project-name <project>` → dashboard → project → *Deployments* → *Rollback to this deployment* (or redeploy the previous `main` commit from a checkout of that SHA — the script's pre-flight requires `main == origin/main`, so a git-level revert + merge is the clean path).

**Playground caveat — not every rollback is safe.** An older build opening a newer user file lands in `unsupported` (`apps/playground/src/state/userdb.ts`): only roll the playground back to a deployment with the same userdb **schema version** as the one users have migrated under; otherwise roll forward with a fix. The website has no such constraint.

## What is deliberately NOT here

- A `_headers` file for the playground: a top-level CSP is inherited by the `srcdoc` app frames (`packages/runner/src/csp.ts`, child-6), so any header work is its own C2-tier task.
- Email Routing / MX records for `hello@` and `security@` — `internal/LAUNCH_OPS.md`.
- CI-driven deploys — CI is dormant (ADR-0041); the script is the source of truth for what a deploy checks.

## Secrets posture

Nothing in this repo authenticates to Cloudflare. Auth is the wrangler OAuth session on the owner's machine, or a `CLOUDFLARE_API_TOKEN` (scope: *Cloudflare Pages: Edit* on this account only) exported in the shell for a headless run. The account id in `.env` is not a secret but stays out of the public tree; the account's email address is recorded only in `internal/`.
