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
2. `pnpm exec wrangler login` **on the Cloudflare account that holds the `snugprotocol.org` zone** (the account name is recorded in the owner's private launch notes, not here). If `wrangler whoami` lists more than one account or the wrong one: `pnpm exec wrangler logout` and log in again.
3. Root `.env` with `CLOUDFLARE_ACCOUNT_ID=<id from wrangler whoami>` — copy `.env.example`. The script refuses without it and refuses if the wrangler session is on a different account.

**The wrangler OAuth session cannot do the one-time zone setup, and that is deliberate.** It carries `pages (write)` + `zone (read)` — enough to create projects and deploy, not enough to touch DNS, rulesets, or zone settings. Keep it that way: the routine deploy path should stay unable to reconfigure the zone. Steps 2–6 below therefore need a **temporary, task-scoped API token**, and the permissions are not obvious:

| Step | Needs |
|---|---|
| 2 — custom domains + their CNAMEs | Account → **Cloudflare Pages: Edit**, Zone → **DNS: Edit** |
| 3 — `www` Redirect Rule | Zone → **Config Rules: Edit** (or *Transform Rules: Edit*) — **not** covered by DNS or Zone Settings |
| 4 — zone features OFF | Zone → **Zone Settings: Edit**, plus Zone → **Bot Management: Read** for Bot Fight Mode |
| 6 — Bulk Redirect | Account → **Account Rulesets: Edit** — **not** the same as any Zone permission |

Verify the token before relying on it (`GET /user/tokens/verify`), and **probe each API you need rather than trusting the scope list** — a partial edit is silent, and a mid-sequence permission failure leaves the zone half-configured. **Revoke the token when this setup is done**; routine deploys need only the OAuth session. If it must live on disk while in use, root `.env` is gitignored (`git check-ignore -v .env`) — a documented, temporary exception to the secrets posture at the end of this file, not a new default.

## One-time setup (🔑 each, in this order)

1. **Create the projects** — the script never does this:
   ```sh
   pnpm exec wrangler pages project create snug-website --production-branch main
   pnpm exec wrangler pages project create snug-playground --production-branch main
   ```
2. **Custom domains** (dashboard → Workers & Pages → project → *Custom domains* → *Set up a domain*): `snugprotocol.org` on `snug-website`; `playground.snugprotocol.org` on `snug-playground`.
   - ⚠️ **Cloudflare did NOT create the CNAMEs itself** (observed 2026-08-24, zone on the same account — the earlier claim here was wrong). Both domains sat at `status: pending` with `verification_data: "CNAME record not set"` until the records were added **by hand**: `CNAME snugprotocol.org → <project>.pages.dev` and `CNAME playground → <project>.pages.dev`, both **proxied**. HTTP validation cannot complete without them. Add them, then wait.
   - ⚠️ **Verify a domain by FETCHING it, not by reading its `status`.** The Pages domain status lags the edge by minutes: both hosts served 200 while the API still reported `pending` / `CNAME record not set`. A transient **522** on first request also cleared on its own. Poll `curl`, not the status field.
   - The apex is CNAME-flattened, so the `CNAME` at the zone apex is fine — **and it does not disturb the `MX` record**. Confirm `dig MX snugprotocol.org` still answers after any apex change: this zone carries live email routing.
3. **`www` → apex (301).** Pages `_redirects` cannot match a host (wrangler silently skips absolute-URL sources), so this lives in the zone, outside git:
   - DNS: add a **proxied** placeholder record for `www` (`AAAA www 100::`), so the rule has something to run on.
   - Rules → *Redirect Rules* → create: *when* hostname equals `www.snugprotocol.org` → *dynamic* redirect to `concat("https://snugprotocol.org", http.request.uri.path)`, status **301**, preserve query string.
4. **Zone features OFF** (each injects a `/cdn-cgi/` script or beacon into pages ADR-0013 promises are inert): *Scrape Shield → Email Address Obfuscation* off (it rewrites `security@snugprotocol.org` on the site and injects a script); *Speed → Optimization → Rocket Loader* off (rewrites module scripts — breaks the playground); *Speed → Cloudflare Fonts* off (rewrites font links to `/cdn-cgi/`); *Security → Bots → Bot Fight Mode* off (injects a challenge script into HTML); *Analytics → Web Analytics* — do not enable for either project. (*Auto Minify* — retired by Cloudflare in 2024; nothing to toggle.) Confirm with the `cdn-cgi` check in **Verify**.
5. **Preview Access policy** (project → *Settings* → *Enable access policy* / Cloudflare Access for `*.<project>.pages.dev` previews; first use prompts to create a Zero Trust organization — pick a team name, free plan) — **before the first `--preview` deploy**. Pre-flip, an open preview URL would publish the launch site and playground to anyone who guesses the branch name.
6. **`*.pages.dev` Bulk Redirect** (account → *Bulk Redirects* → list `snug-pages-dev`, two entries): source **`snug-website-c7z.pages.dev`** → target `https://snugprotocol.org`, and source `snug-playground.pages.dev` → target `https://playground.snugprotocol.org`;
   - ⚠️ **Read the project's REAL subdomain before writing this entry — it is not always `<project>.pages.dev`.** Cloudflare assigned `snug-website-c7z.pages.dev` (the plain name was taken); `snug-playground` got its plain name. A redirect written against the assumed name silently protects nothing, and the Verify step below would be curling a host this account does not own. Get the truth from `wrangler pages project list` (Project Domains column) or `GET /accounts/{a}/pages/projects/{p}` → `.subdomain`. status 301; *Subpath matching* ON, *Preserve path suffix* ON, *Preserve query string* ON, **Include subdomains OFF** (on, it would 301 the `*.snug-website.pages.dev` previews to production and defeat step 5). The playground on a second origin would be a second per-origin `.snug` store — users must land on one host.
7. Record all of the above in the task journal + the owner's private launch notes.

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
curl -sI https://snug-website-c7z.pages.dev/ | grep -iE '^(HTTP|location)'     # 301 → snugprotocol.org (Bulk Redirect; NOTE the real subdomain, not snug-website.pages.dev)
curl -s -o /dev/null -w '%{http_code}\n' https://playground.snugprotocol.org/settings   # 200 — SPA fallback serves index.html
curl -s -o /dev/null -w '%{http_code}\n' https://snugprotocol.org/docs/spec/          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://snugprotocol.org/whitepaper/snug-protocol-whitepaper.pdf   # 200
```

**Two traps, both met live on 2026-08-24 — read before trusting a green result:**

1. **A `0` from `grep -c` is only evidence if the `curl` feeding it actually ran.** Putting `--resolve a --resolve b` in a plain shell variable makes curl reject the whole string as one unknown option; every check then printed a confident `0` that was curl failing, not a passing check (the decorative-test shape, lessons 2026-08-20/24). Use a bash **array** — `R=(--resolve "host:443:$IP")` … `curl "${R[@]}"` — and sanity-check one command's output before trusting the batch.
2. **Right after a DNS cutover the local resolver has not caught up**, so these commands fail against a host that is already serving. Confirm the records at the authority first, then pin curl to the edge IP:
   ```sh
   dig @kipp.ns.cloudflare.com +short snugprotocol.org A        # authoritative truth
   IP=$(dig @kipp.ns.cloudflare.com +short snugprotocol.org A | head -1)
   R=(--resolve "snugprotocol.org:443:$IP" --resolve "playground.snugprotocol.org:443:$IP")
   curl -s "${R[@]}" -o /dev/null -w '%{http_code}\n' https://snugprotocol.org/
   ```

Confirm the zone-level posture directly (ADR-0013 — the `cdn-cgi` grep alone does NOT prove these; it passed while Email Obfuscation was `on`, because the apex was not yet serving):

```sh
Z=<zone-id>   # api.cloudflare.com/client/v4/zones?name=snugprotocol.org
for s in email_obfuscation rocket_loader fonts mirage polish; do
  printf '%-20s ' "$s"
  curl -s "https://api.cloudflare.com/client/v4/zones/$Z/settings/$s" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("result") or {}).get("value"))'
done   # every one must read: off
curl -s "https://api.cloudflare.com/client/v4/zones/$Z/bot_management" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -c 'import json,sys;print("fight_mode:",(json.load(sys.stdin).get("result") or {}).get("fight_mode"))'   # must be False
```

Then by hand: landing page teaser plays; `/download` links resolve (they 404 by design until the first GitHub Release — ADR-0047); playground boots in demo mode with **no sign-in affordance anywhere** (ADR-0013); the `about ↗` link lands on the apex; one spec page renders.

**On the sign-in check:** grepping the bundle for "sign in" is NOT the test — those strings ship. The affordance is gated at build time by `VITE_SNUG_HUB_AUTH` (`apps/playground/src/platform/platform.ts`), which the deploy script pins to `''`. Confirm the shipped bundle carries the constant-folded `hubAuth:!1`:
```sh
grep -roh 'hubAuth:!\?[01]' apps/playground/dist/assets/*.js | sort -u   # must be exactly: hubAuth:!1
```

## Rollback (🔑, journaled)

`pnpm exec wrangler pages deployment list --project-name <project>` → dashboard → project → *Deployments* → *Rollback to this deployment* (or redeploy the previous `main` commit from a checkout of that SHA — the script's pre-flight requires `main == origin/main`, so a git-level revert + merge is the clean path).

**Playground caveat — not every rollback is safe.** An older build opening a newer user file lands in `unsupported` (`apps/playground/src/state/userdb.ts`): only roll the playground back to a deployment with the same userdb **schema version** as the one users have migrated under; otherwise roll forward with a fix. The website has no such constraint.

## What is deliberately NOT here

- A `_headers` file for the playground: a top-level CSP is inherited by the `srcdoc` app frames (`packages/runner/src/csp.ts`, child-6), so any header work is its own C2-tier task.
- Email Routing / MX records for `hello@` and `security@` — the owner's private launch notes.
- CI-driven deploys — CI is dormant (ADR-0041); the script is the source of truth for what a deploy checks.

## Secrets posture

Nothing in this repo authenticates to Cloudflare. Auth is the wrangler OAuth session on the owner's machine, or a `CLOUDFLARE_API_TOKEN` (scope: *Cloudflare Pages: Edit* on this account only) exported in the shell for a headless run. The account id in `.env` is not a secret but stays out of the public tree; the account's email address is recorded only in the owner's private notes.
