# TASK-20260824-web-deploy-execute: Execute the first production web deploy (Cloudflare Pages, E2E)

- **Status**: planned (awaiting plan approval — Gate 2)
- **Owner**: Jeetu
- **Risk tier**: **high** — auto-escalated. This is a deploy/release act (PROCESS.md release rules: "never deploy the Playground … without an explicit human ask in that session"), it publishes the launch surface of a pre-flip project, and it changes zone-level settings that ADR-0013's "no telemetry, falsifiable by reading the deploy config" depends on.
- **Branch**: `feat/TASK-20260824-web-deploy-execute`
- **Packages touched**: none (no product code). Docs only: `docs/runbooks/deploy-web.md`, `docs/next-steps.md`, `docs/tasks/`. Build outputs of `apps/website` + `apps/playground` are uploaded, not modified.
- **Spec impact**: none (`packages/protocol` untouched → no SPEC_SYNC step, no spec-changelog entry).
- **Related**: [ADR-0054](../../decisions/0054-web-deploy-tooling.md) (deploy tooling + every rule this task obeys) · [ADR-0048](../../decisions/0048-public-website-single-static-site.md) (hosting choice) · [ADR-0013](../../decisions/0013-hosted-hub-static-zero-backend.md) (hosted posture the deploy must preserve) · [ADR-0047](../../decisions/0047-desktop-distribution-and-update-channel.md) (`/download` 404s until the first Release) · runbook [deploy-web.md](../../runbooks/deploy-web.md) · predecessor **TASK-20260823-web-deploy** (shipped the tooling; deploy deliberately deferred to this explicit ask) · next-steps owner-🔑 item "web deploy".

## Spec (what & why)

The deploy **tooling** shipped in TASK-20260823-web-deploy (`scripts/deploy-web.mjs`, 26 tests, runbook, ADR-0054) but **nothing has ever been deployed**: `wrangler pages project list` shows only an unrelated `known-website`, and `snugprotocol.org` resolves no A/CNAME for the apex, `www`, or `playground`. The zone is active on the account that holds it (`jeetu@techvoyage.org`, account `e930cbfd…196d`, Free plan) and email routing is already live and verified (MX → `smtp.google.com`).

This task performs the deploy end-to-end: the one-time Cloudflare setup (project creation, custom domains, the `www` Redirect Rule, zone script-injector features OFF, the `pages.dev` Bulk Redirect), then the first production upload of both apps from clean `main`, then the runbook's Verify walk. It is one of the owner-🔑 items gating the public flip.

**Owner interview calls (2026-08-24):**
1. **Dashboard steps via a scoped API token.** The wrangler OAuth session has `pages (write)` but only `zone (read)` — it cannot write DNS records, Redirect Rules, zone settings, or Bulk Redirects. Owner will create a scoped API token; every step is then done via the Cloudflare API and verified, rather than by hand in the dashboard.
2. **Straight to production; no preview, no Zero Trust org.** Runbook step 5 (preview Access policy) is *deferred, not skipped* — it is only required before the first `--preview` deploy, and this task performs none. Deferring it avoids standing up a Zero Trust organization the project does not yet need. **Consequence recorded: until that policy exists, `--preview` must not be run** (pre-flip, an open preview URL publishes the launch site).
3. **Delete the staged local DMG.** `apps/website/public/local-artifacts/Snug.dmg` exists and the script rightly refuses to publish it; it is gitignored and `pnpm --filter website stage-local-desktop` recreates it.
4. **Deploy despite `/download` 404s.** Expected per ADR-0047 — the download URLs go live with the first signed GitHub Release. The site is not linked from anywhere pre-flip. Recorded in the verify results rather than treated as a failure.

**Acceptance criteria** (each is a verifiable check; this is an ops task, so the "test" for most is a recorded command + its output, per the runbook's Verify section):

1. **AC1 — Projects exist, created explicitly.** `snug-website` and `snug-playground` exist on account `e930cbfd…196d` with production branch `main`, created by the two `wrangler pages project create` commands `deploy-web.mjs init` prints — never by the deploy path. Evidence: `wrangler pages project list` shows both.
2. **AC2 — The script's pre-flight passes for real, and its refusals are not bypassed.** `node scripts/deploy-web.mjs all` (dry, no `--deploy`) exits 0 from clean `main == origin/main`, having verified both builds. No flag is added, no check is edited to make it pass. Evidence: the dry run's printed wrangler argv for both apps.
3. **AC3 — The blocking local artifact is removed before the build, not worked around.** `apps/website/public/local-artifacts/` does not exist at build time; the website build is fresh (`rm -rf dist` + `turbo --force`, which the script does itself).
4. **AC4 — Both apps upload to production from clean `main`.** `all --deploy` uploads website then playground; both return a deployment id and a `*.pages.dev` URL. Evidence: `wrangler pages deployment list --project-name <p>` for each, deployment ids journaled with UTC time.
5. **AC5 — Custom domains resolve and serve.** `https://snugprotocol.org/` → 200 (website) and `https://playground.snugprotocol.org/` → 200 (playground), both over valid TLS, both served by the Pages project (not a placeholder).
6. **AC6 — `www` 301s to the apex, path preserved.** `curl -sI https://www.snugprotocol.org/docs/` → `301` with `location: https://snugprotocol.org/docs/`, via the **zone Redirect Rule** (ADR-0054 §7 — `_redirects` cannot match a host).
7. **AC7 — The production `pages.dev` hosts 301 to the custom domains.** `curl -sI https://snug-website.pages.dev/` → 301 → `https://snugprotocol.org`, same for `snug-playground.pages.dev` → `https://playground.snugprotocol.org`, via the `snug-pages-dev` Bulk Redirect with subpath matching + path/query preservation ON and **include-subdomains OFF** (on, it would 301 preview hosts to production). Rationale: a playground on a second origin is a second per-origin `.snug` store.
8. **AC8 — Zero `cdn-cgi` injection on either host.** `curl -s https://<host>/ | grep -c cdn-cgi` returns **0** for both, with Email Address Obfuscation, Rocket Loader, Cloudflare Fonts, and Bot Fight Mode confirmed OFF and Web Analytics not enabled. This is ADR-0013's "no telemetry, falsifiable by reading the deploy config" surviving the CDN.
9. **AC9 — The playground's SPA fallback works.** `https://playground.snugprotocol.org/settings` → 200 (serves `index.html`; Pages keys this on the ABSENCE of `404.html`, which the script verifies).
10. **AC10 — Deep website routes serve.** `/docs/spec/` → 200 and `/whitepaper/snug-protocol-whitepaper.pdf` → 200.
11. **AC11 — Hosted posture holds in the shipped bytes.** The deployed playground shows **no sign-in affordance anywhere** (ADR-0013) and boots in demo mode; no deployed website HTML contains `localhost:5173` or `/local-artifacts/` (the script's tripwire, re-verified against the LIVE origin, not just `dist/`).
12. **AC12 — The runbook is corrected where reality differed**, and the journal records every 🔑 act with UTC time, the command, and the verification performed (PROCESS.md release rules). Known expected deviation to record: `/download` links 404 until the first Release (ADR-0047).

**Out of scope**:
- **The preview Access policy / Zero Trust org** (runbook step 5) — deferred by owner call 2; blocks `--preview` until done, recorded in next-steps.
- **A `_headers` / CSP file for the playground** — explicitly a C2-tier task of its own (ADR-0054 consequences; a top-level CSP is inherited by `srcdoc` app frames, `packages/runner/src/csp.ts` child-6).
- **The first GitHub Release / desktop binaries** — separate owner-🔑 item (ADR-0047); this task does not make `/download` work.
- **Flipping the repo public** — separate item; this task is one of its gates.
- **CI-driven deploys** — CI is billing-dormant (ADR-0041); ADR-0054 §2 keeps the script as the source of truth.
- **`apps/server`** — never deployed by this process (ADR-0013).
- **Any change to `scripts/deploy-web.mjs` behaviour.** If a genuine tooling defect surfaces, it is fixed test-first (Gate 3) and noted here — but the deploy is not made to pass by loosening a check.

## Plan

**Shape:** this is an ops/release task, so the "tests first" of Gate 3 takes its natural form — the script's 26 existing tests plus root `pnpm test` are the regression net for the tooling, and every AC above is a *pre-registered command with an expected result*, run and recorded. No product code changes. The one code-shaped rule: any tooling defect found gets a failing test before a fix.

**Order (each 🔑 is an explicit act, journaled with UTC time + verification):**

**Phase 0 — Baseline, before touching Cloudflare**
1. Record the starting state as evidence: `wrangler whoami` (account id), `wrangler pages project list` (neither project exists), `dig` for apex/`www`/`playground` (no records) and MX (email routing live). *Already captured during Gate 2 — folded into the journal.*
2. Write root `.env` with `CLOUDFLARE_ACCOUNT_ID=e930cbfde15f98363d782e364df1196d` (gitignored; `.env.example` documents it). Confirm `.gitignore` covers `.env` — **verify, don't assume**, since a committed account id is the one thing ADR-0054 §1 keeps out of the public tree.
3. Run root `pnpm test` (or at minimum `check-deploy-web`) on this branch to confirm the tooling is green *before* it is trusted with a deploy.
4. Delete `apps/website/public/local-artifacts/` (AC3, owner call 3).

**Phase 1 — One-time Cloudflare setup (🔑 each)**
5. `node scripts/deploy-web.mjs init` → run the two printed `wrangler pages project create … --production-branch main` commands. Verify with `pages project list` (**AC1**).
6. Owner creates the scoped API token (owner call 1). Required permissions: **Account → Cloudflare Pages: Edit**, **Zone → DNS: Edit**, **Zone → Zone Settings: Edit**, **Account → Bulk Redirects: Edit** (and Zone → Zone: Read), scoped to this account / the `snugprotocol.org` zone. Exported as `CLOUDFLARE_API_TOKEN` in the shell — **never written to a file in the repo** (ADR-0054 secrets posture: "never put a token here"). I will not ask for the token value in chat; it goes in the environment.
7. **Custom domains** (**AC5**): attach `snugprotocol.org` to `snug-website` and `playground.snugprotocol.org` to `snug-playground` via the Pages API. The zone is on the same account, so Cloudflare creates the records itself (apex is CNAME-flattened). Wait for certificate issuance; poll until both serve 200 over TLS.
8. **`www` → apex 301** (**AC6**): add a **proxied** placeholder `AAAA www 100::`, then a zone Redirect Rule — hostname eq `www.snugprotocol.org` → dynamic `concat("https://snugprotocol.org", http.request.uri.path)`, **301**, preserve query string. (Free plan has Redirect Rules; if the rules quota bites, fall back to a Bulk Redirect entry and record the deviation.)
9. **Zone script-injectors OFF** (**AC8**): set Email Address Obfuscation off, Rocket Loader off, Cloudflare Fonts off, Bot Fight Mode off; confirm Web Analytics is not enabled for either project. Read each setting back after writing.
10. **`pages.dev` Bulk Redirect** (**AC7**): list `snug-pages-dev`, two entries, 301, subpath matching ON, preserve path suffix ON, preserve query ON, **include subdomains OFF**.
11. Runbook step 5 (preview Access policy) — **deliberately not done**; recorded as a deferred item with its consequence (no `--preview` until then).

**Phase 2 — The deploy (🔑)**
12. Return to clean `main == origin/main` for the production deploy — ADR-0054 §3 and the script's own git pre-flight require it, and `--preview` is refused on `main` by design. **The docs changes from this task live on the branch and merge normally; the upload happens from `main`.** Sequencing decision to confirm at approval: deploy from current `main` (`231f982`, which is what the site should be) and merge this task's doc updates afterward — the deployed bytes are then exactly a commit that is in `origin/main`.
13. `node scripts/deploy-web.mjs all` (dry) → read the printed argv for both apps (**AC2**).
14. 🔑 `node scripts/deploy-web.mjs all --deploy` → website uploads first, then playground (**AC4**). If the playground leg fails after the website succeeded, follow the runbook's **half-deploy recovery**: rerun `playground --deploy` from the same `main`, journal both.
15. Capture deployment ids: `wrangler pages deployment list --project-name snug-website|snug-playground`.

**Phase 3 — Verify (the runbook's Verify section, every AC)**
16. Run the runbook's curl block verbatim: both hosts 200, `cdn-cgi` count 0 on both (**AC8**), `www` 301 (**AC6**), `pages.dev` 301s (**AC7**), playground `/settings` 200 (**AC9**), `/docs/spec/` 200 and the whitepaper PDF 200 (**AC10**).
17. Fetch the live website HTML and re-run the local-mode tripwire against the **deployed** bytes (`localhost:5173`, `/local-artifacts/`) — the script checks `dist/`; AC11 checks the origin.
18. Browser walk: landing page teaser plays; playground boots in demo mode with **no sign-in affordance anywhere**; the `about ↗` link lands on the apex; one spec page renders; `/download` links 404 **as expected** (ADR-0047 — recorded, not a failure).

**Phase 4 — Close (Gate 6)**
19. Fix the runbook wherever reality differed (**AC12**) — API-driven steps where it says "dashboard", the Free-plan specifics, anything the token scoping taught. Runbook corrections land in this branch.
20. Journal every 🔑 act (what, UTC, verification). Update `docs/next-steps.md`: web deploy → done; **add** the deferred preview Access policy with its consequence. Add lessons if any surprise generalizes. `/close-session`, PR, merge, retire to `docs/tasks/done/INDEX.md` per ADR-0027.

**Cross-package impact:** none. `apps/website` and `apps/playground` are built from unmodified `main` sources; the dependency graph is not touched. No `packages/*` change → no dependent suites owed beyond the root gate in step 3.

**Rollback:** per the runbook — website rolls back to any prior deployment; **the playground only to a deployment with the same userdb schema version** (an older build opening a newer user file lands in `unsupported`). This is the *first* deploy, so there is no prior deployment to roll back to: the rollback for this task is deleting the custom domain / project, which is why AC5 is verified before anything is linked publicly and why the repo is still private.

**Risks and how each is handled:**
- *Publishing the launch site before the flip* — the site is not linked from anywhere and the repo is private; the flip is a separate gated item. Accepted, owner call 2/4.
- *A too-broad API token* — scoped to this account + zone, four permissions, kept in the environment only, and revocable after the task. Recorded in the journal; **recommend revoking or narrowing once Phase 1 completes**, since routine deploys need only the wrangler OAuth session.
- *Certificate issuance lag on the apex* — poll rather than declare success; AC5 is not met until both hosts serve 200 over TLS.
- *A zone feature silently re-enabled later* — AC8's `cdn-cgi` grep is in the runbook's Verify block and runs after **every** deploy, not just this one.

## Decisions & surprises

- **2026-08-24 — Deferring the preview Access policy is a real constraint, not a skipped step.** ADR-0054 §7 requires it *before the first `--preview` deploy*; this task performs none, so nothing is violated — but `--preview` is now unsafe until it exists, and that must be written where the next person will look (runbook + next-steps), not only here.
- **2026-08-24 — The wrangler OAuth session is deliberately narrow.** `pages (write)` + `zone (read)` is exactly enough to deploy and not enough to reconfigure the zone. That is a good posture to keep: the routine deploy path stays unable to change DNS or zone settings, and the broader token is a temporary, task-scoped grant.
- *(running notes — append as the deploy proceeds)*

## Session journal (append-only, newest last)

### 2026-08-24 — Jeetu — session (Gates 1–2)

- **Done:** Read PROCESS.md, ADR-0054, ADR-0048, the deploy runbook, `scripts/deploy-web.mjs` pre-flight, architecture/code-map/lessons entries for the web deploy. Established the true starting state (see below). Owner interview (4 questions) answered. Task file + branch `feat/TASK-20260824-web-deploy-execute` created off `main` at `231f982`.
- **Baseline evidence (UTC 2026-08-24):**
  - `wrangler --version` → `4.125.0` (≥4, as the script requires).
  - `wrangler whoami` → OAuth session, `jeetu@techvoyage.org`, account **`e930cbfde15f98363d782e364df1196d`** ("Jeetu@techvoyage.org's Account"). Scopes include `pages (write)`, `email_routing (write)`, but only **`zone (read)`** — DNS/rules/settings writes are NOT available to this session.
  - `wrangler pages project list` → only `known-website` (unrelated). **Neither `snug-website` nor `snug-playground` exists.**
  - Zone `snugprotocol.org` → id `13f112fa4192c32cacc949d2f75d55fe`, **active**, on the same account, plan **Free Website**, NS `kipp`/`magdalena`.
  - `dig`: **MX → `smtp.google.com` (email routing live, as the owner reported)**; TXT carries the Google site-verification; **no A/CNAME for apex, `www`, or `playground`** — nothing web is deployed.
  - Repo: `main` clean, `HEAD == origin/main == 231f982`.
  - Blocker found: **`apps/website/public/local-artifacts/Snug.dmg` exists** — the script's hosted-posture check would (correctly) refuse the website build.
  - Root `.env` absent (`.env.example` present) — Phase 0 step 2 creates it.
- **State:** Gate 2 complete, plan written. **STOPPED for plan approval** — no Cloudflare act, no `.env` write, no deletion performed yet.
- **Next step:** On approval → Phase 0 (`.env`, root gate, delete `local-artifacts/`), then Phase 1 step 5 (create the two Pages projects) and pause for the scoped API token before the zone-level steps.
- **Open questions for approval:**
  1. **Confirm the scoped API token** (owner call 1): Account→Pages:Edit, Zone→DNS:Edit, Zone→Zone Settings:Edit, Account→Bulk Redirects:Edit, Zone→Zone:Read, scoped to this account/zone; exported as `CLOUDFLARE_API_TOKEN` in the shell, not written into the repo. Revoke or narrow after Phase 1?
  2. **Confirm the deploy commit** (Phase 2 step 12): deploy from `main` at `231f982` and merge this task's doc updates afterward — so the live bytes correspond to a commit already in `origin/main`.

### 2026-08-24 — Jeetu — session (Phase 0 + Phase 1 step 5)

Plan approved ("go"). Phases 0 and 1-step-5 executed; **no upload performed** (AC4 is its own 🔑 ask).

- **Phase 0 — done, all evidence captured:**
  - Root `.env` written with `CLOUDFLARE_ACCOUNT_ID=e930cbfde15f98363d782e364df1196d`. **Proven gitignored before trusting it**: `git status --untracked-files=all` counts 0 entries for `.env`; `git check-ignore -v` → `.gitignore:10:.env`. (ADR-0054 §1 — the account id never enters the public tree.)
  - `apps/website/public/local-artifacts/` (an 8.3 MB `Snug.dmg`) **deleted** after confirming it was ignored (`apps/website/.gitignore:6`). AC3 met at build time. Re-stage with `pnpm --filter website stage-local-desktop`.
  - `node scripts/deploy-web.test.mjs` → **26/26 pass**.
  - Root `pnpm test` → **exit 0** (captured by redirect, not a pipe — the 2026-08-22/24 lessons trap). `Tasks: 25 successful, 25 total`. The `website-sync: FAIL` lines in the log are the checker's OWN fixtures (`SPEC-TEST.md`, a temp manifest) asserting the gate reddens correctly — not real drift.
- **Phase 1 step 5 — projects created (🔑, 2026-08-24):** ran the two commands `deploy-web.mjs init` printed, verbatim:
  - `wrangler pages project create snug-website --production-branch main` → created
  - `wrangler pages project create snug-playground --production-branch main` → created
  - **AC1 met.** `pages project list` shows both; API confirms `production_branch=main` on each.
- **SURPRISE (affects AC7) — the website's `pages.dev` subdomain is NOT `snug-website.pages.dev`.** Cloudflare assigned **`snug-website-c7z.pages.dev`** (the plain name was already taken account-wide or globally); the playground got the plain **`snug-playground.pages.dev`**. Consequences:
  1. **The Bulk Redirect source in ADR-0054 §7 / runbook step 6 is wrong for the website** — the entry must be `snug-website-c7z.pages.dev`, not `snug-website.pages.dev`. A redirect on the latter would silently protect nothing.
  2. **The runbook's Verify block is wrong for the same reason** (`curl -sI https://snug-website.pages.dev/`) — it would curl a host this project does not own and could read a stranger's response as evidence. Both fixed in Phase 4 (AC12).
  3. The deploy script itself is unaffected — it matches on the **Project Name** column, not the subdomain. Verified against the REAL `pages project list` output rather than assumed: both names match its regex (an isolated check against subdomains alone returns false for `snug-website`, which is why this was worth testing rather than reasoning about).
- **Phase 2 step 13 — dry run on clean `main` @ `231f982` == `origin/main`: `DRY_EXIT=0`. AC2 met.**
  - Pre-flight: `✔ wrangler session on account e930cbfd…196d; project(s) snug-website, snug-playground exist` · `✔ git: production from main@231f982`
  - Both apps `built fresh (turbo --force) and verified` — `Tasks: 8 successful, Cached: 0 cached, 8 total` (the cache really was bypassed).
  - Invariants re-checked directly in `dist/`, independent of the script's own report: website `404.html` **present**; playground `404.html` **absent** (Pages' SPA fallback keys on this); `sql-wasm-UFUCzYNW.wasm` present; **0** website HTML files carrying `localhost:5173` or `/local-artifacts/`.
  - Printed argv (what `--deploy` will run): `wrangler pages deploy apps/<app>/dist --project-name <p> --branch main --commit-hash 231f98210d6db1a7191be0e26413a6874ee6f26e --commit-message 'TASK-20260824-flip-public-scrub: …(#131)'`
- **State:** Everything achievable without the scoped API token is done. **Blocked on two owner acts**, in this order:
  1. **`CLOUDFLARE_API_TOKEN`** exported in the shell (Account→Pages:Edit, Zone→DNS:Edit, Zone→Zone Settings:Edit, Account→Bulk Redirects:Edit, Zone→Zone:Read) — needed for custom domains (AC5), the `www` rule (AC6), zone features OFF (AC8), the Bulk Redirect (AC7).
  2. **The 🔑 upload ask** for `all --deploy` (AC4).
- **Next step:** on the token → Phase 1 steps 7–10, then the 🔑 upload, then the full Verify walk.
- **Open questions:** none blocking. Recommendation stands: revoke or narrow the token once Phase 1 completes — routine deploys need only the wrangler OAuth session, which deliberately cannot alter DNS or zone settings.

### 2026-08-24 — Jeetu — session (🔑 PRODUCTION DEPLOY — AC4 met)

**Owner authorized the upload in-session ("go"). Both apps are LIVE on their `pages.dev` origins.** Custom domains are NOT yet attached (see Blocked, below), so `snugprotocol.org` still resolves nothing — the deploy is real but not yet reachable at the public URLs.

- **🔑 `node scripts/deploy-web.mjs all --deploy` — `DEPLOY_EXIT=0`**, run from a genuinely clean `main` @ `231f982` == `origin/main` (the task file was stashed so the tree was empty — the script's dirty-tree refusal is not bypassable and should not be).
  - **UTC 2026-08-24T21:01:04Z → 21:02:24Z.**
  - website: `✨ Success! Uploaded 83 files (18.21 sec)` → `https://7ac34266.snug-website-c7z.pages.dev`
  - playground: `✨ Success! Uploaded 131 files (12.32 sec)` → `https://6e7594b3.snug-playground.pages.dev`
- **Deployment ids (AC4 evidence, `wrangler pages deployment list`):**
  - `snug-website` → **`7ac34266-ddf5-4139-a8c9-eb9b0daf7251`** · Environment **Production** · Branch `main` · Source **`231f982`**
  - `snug-playground` → **`6e7594b3-f60f-45a5-afa7-da0026582d57`** · Environment **Production** · Branch `main` · Source **`231f982`**
  - Both name the commit that produced them, which is the point of ADR-0054 §3's no-dirty-override rule.

**Verification performed against the LIVE origins (not `dist/`):**

| AC | Check | Result |
|----|-------|--------|
| — | `https://snug-website-c7z.pages.dev/` | **200**, HTTP/2, `server: cloudflare` |
| — | `https://snug-playground.pages.dev/` | **200**, HTTP/2, `server: cloudflare` |
| **AC8** (partial) | `cdn-cgi` count on both origins | **0 and 0** |
| **AC9** | playground `/settings` (SPA fallback) | **200** |
| **AC10** | website `/docs/spec/`, `/whitepaper/snug-protocol-whitepaper.pdf`, `/docs/`, `/download/` | **200 × 4** |
| **AC11** | live-origin local-mode tripwire (`localhost:5173`, `/local-artifacts/`) on `/` and `/download/` | **0 × 4** |

- **AC11 — the sign-in question, settled on evidence rather than on absence of a string.** Grepping the built bundles finds "sign in with Google" (3×) and "subscription mode" (3×), which on its own would NOT justify the claim. Traced it: `platform.ts:192` gates the surface on `hubAuth: import.meta.env?.VITE_SNUG_HUB_AUTH === '1'`, the script pins that env var to `''`, and the **shipped bundle carries the constant-folded `hubAuth:!1`** — so the render path (`if (e.state === "unavailable") return null`) is dead code. The strings ship; the affordance does not. A browser walk still owes the final confirmation.
- **AC5/AC6/AC7 remain OPEN** — all four are token-gated (custom domains, `www` rule, zone toggles, Bulk Redirect). `dig` confirms `snugprotocol.org` and `playground.snugprotocol.org` still resolve nothing.
- **AC8 is only half-met:** zero `cdn-cgi` in the response bytes is necessary but not sufficient — the zone toggles (Email Obfuscation, Rocket Loader, Cloudflare Fonts, Bot Fight Mode) have not been read back or set, and any of them could be flipped on later. The grep passing today does not prove the settings.
- **BLOCKED — `CLOUDFLARE_API_TOKEN` is not reachable from the tool shell.** The owner exported it in their own terminal, but every tool Bash call starts a fresh shell from the profile, so the export does not propagate. Checked and confirmed absent: process env, root `.env`, `.dev.vars`, and the shell rc files. **Not a token problem — a plumbing one.** Options recorded for the owner: put it in the gitignored root `.env` as `CLOUDFLARE_API_TOKEN=…` (wrangler and the API calls both read it there; `.gitignore:10` already covers `.env`, verified), or run the four Phase-1 steps by hand in the dashboard against the corrected hostnames below.
- **State:** AC1, AC2, AC3, AC4, AC9, AC10, AC11 met; AC8 half; **AC5, AC6, AC7, AC12 open.** The site is deployed and correct but not yet reachable at `snugprotocol.org`.
- **Next step:** get the token into a place the tool shell reads → attach custom domains (AC5) → `www` Redirect Rule (AC6) → zone features OFF (completes AC8) → Bulk Redirect **using `snug-website-c7z.pages.dev`, not `snug-website.pages.dev`** (AC7) → browser walk → Phase 4 runbook corrections (AC12).

### 2026-08-24 — Jeetu — session (Phase 1 steps 7–10, token in hand)

Token placed in the gitignored root `.env` (owner act). **Deviation from ADR-0054's secrets posture recorded deliberately:** the ADR says "never put a token here" — written for the ROUTINE deploy path, which needs only the wrangler OAuth session and deliberately cannot alter DNS or zone settings. This is a one-time zone setup OAuth cannot perform, so the file is a **temporary, task-scoped grant**. `git check-ignore -v .env` → `.gitignore:10`; `git status --porcelain` counts 0 `.env` entries. **Revoke the token at the end of Phase 1** (still recommended, still owed).

- **Token verified before use:** `/user/tokens/verify` → `success: True`, `status: active`. Probed each API rather than trusting the scope list — the right move, as two turned out to be missing.
- **AC5 — custom domains attached (🔑):**
  - `snugprotocol.org` → `snug-website`; `playground.snugprotocol.org` → `snug-playground`. Both accepted (`status: initializing` → `pending`, validation method `http`).
  - **SURPRISE: Cloudflare did NOT auto-create the CNAMEs.** The runbook says "the zone is on the same account, so Cloudflare creates the CNAME records itself (the apex is CNAME-flattened)" — it did not, and HTTP validation cannot complete without them, so the domains would have sat at `pending` indefinitely. Created explicitly: `CNAME snugprotocol.org → snug-website-c7z.pages.dev` and `CNAME playground → snug-playground.pages.dev`, both **proxied**. Runbook correction owed (AC12).
  - **Email records verified intact after every DNS write** — `MX → smtp.google.com`, the `google._domainkey` DKIM TXT, and the site-verification TXT are all untouched. This zone carries live email routing the owner verified before this task; a careless apex change would have broken it.
- **AC6 — `www` placeholder created, RULE BLOCKED.** `AAAA www 100::` proxied ✅ (first attempt rejected: `code 9313, DNS record comment exceeds the maximum length of 100 characters` — comment shortened). The Redirect Rule itself: **`request is not authorized`** — the token lacks the ruleset permission. AC6 remains OPEN.
- **AC8 — partially completed, and it caught a REAL violation.** Zone settings ARE authorized, and reading them back was worth doing:
  - **`email_obfuscation` was `on`** — an active ADR-0013 violation (it injects a `/cdn-cgi/` script and rewrites `security@snugprotocol.org` on the live site). **PATCHed → `off`, confirmed `off` on read-back.** The zero-`cdn-cgi` grep from the earlier deploy verification did NOT catch this, because the apex was not yet serving the site — precisely the gap noted when AC8 was called "half".
  - Confirmed `off`: `fonts`, `rocket_loader`, `mirage`, `polish`.
  - **`bot_management` (Bot Fight Mode): `Authentication error`** — not readable with this token. AC8 still OPEN on that one toggle.
- **AC7 — Bulk Redirect BLOCKED.** `/accounts/{a}/rules/lists` → `Authentication error`. AC7 remains OPEN.
- **Two token permissions are missing** (identified by probing, not guessing). To finish AC6/AC7/AC8 the token needs adding:
  1. **Zone → Config Rules: Edit** (or *Transform Rules: Edit* — the `http_request_dynamic_redirect` ruleset phase) → unblocks the `www` 301.
  2. **Account → Account Rulesets: Edit** (Bulk Redirects) → unblocks the `pages.dev` Bulk Redirect list + its entries.
  3. **Zone → Bot Management: Read** (or check Bot Fight Mode in the dashboard) → completes AC8.
- **State:** AC5 in flight (polling for `active` + certificate issuance). AC6, AC7 blocked on permissions; AC8 one toggle short.

### 2026-08-24 — Jeetu — session (AC5 met — the site is LIVE at its real domains)

- **AC5 MET.** Both custom domains serve the deployed build:
  - `https://snugprotocol.org/` → **200**, `<title>Snug — the protocol that connects agents to apps</title>` (confirmed it is OUR build, not a Cloudflare placeholder)
  - `https://playground.snugprotocol.org/` → **200**
- **Verification note — two traps met and handled, worth recording:**
  1. **The Pages domain `status` field LAGS the edge.** The API reported `status: pending` / `verification_data: "CNAME record not set"` for several minutes *after* the domains were already serving 200. Polling the status field alone would have concluded failure; the truth was in the HTTP response. A transient **522** on the playground also cleared on its own. **Verify a domain by fetching it, not by reading its status.**
  2. **A `--resolve` flag stuffed in a plain shell var silently broke every curl** (`option ... is unknown`), and because the failures were piped to `grep -c`, the AC8/AC11 checks printed a confident **`0`** that was curl failing, not a passing check — the decorative-test shape (lessons 2026-08-20/24) reproduced live in a verification command. Redone with a bash **array** (`R=(--resolve ...)`); every number below is from a curl that actually ran. **A zero from a grep whose input never arrived is not evidence.**
- **Full Verify walk against the REAL custom domains (local resolver still cold, so pinned to the authoritative IP `172.67.128.192`; authoritative NS confirmed correct records first):**

| AC | Check | Result |
|----|-------|--------|
| **AC5** | apex `/` · playground `/` | **200 · 200** |
| **AC8** | `cdn-cgi` count, both hosts | **0 · 0** |
| **AC9** | playground `/settings`, `/apps` (SPA fallback) | **200 · 200** |
| **AC10** | `/docs/spec/`, whitepaper PDF, `/docs/`, `/download/`, `/docs/get-started/quickstart/` | **200 × 5** |
| **AC11** | tripwire (`localhost:5173`, `/local-artifacts/`) on `/` and `/download/` | **0 × 4** |
| **AC8** | `email-protection` rewrites on `/` and `/docs/` | **0 · 0** — the obfuscation fix holds on the live site |

- **DNS state (authoritative, verified):** apex + `playground` → Cloudflare proxy IPs; `www` AAAA proxied; **`MX → smtp.google.com` intact through every write**. Email routing was never at risk and is confirmed still correct.
- **State:** **AC1–AC5, AC9, AC10, AC11 MET. The site is live at `snugprotocol.org` and `playground.snugprotocol.org`.** Still open: **AC6** (`www` rule), **AC7** (Bulk Redirect), **AC8** (Bot Fight Mode toggle unread) — all three blocked on the two missing token permissions — plus **AC12** (runbook corrections) and the browser walk.

### 2026-08-24 — Jeetu — session (AC8 MET; AC6/AC7 still permission-blocked)

Owner said "go" after editing the token. Re-probed all three APIs rather than assuming the edit covered them — **one of three landed**.

- **AC8 MET — every ADR-0013 script injector confirmed OFF, read back from the API:**

  | Setting | Value |
  |---|---|
  | `email_obfuscation` | **off** (was `on` — fixed this session) |
  | `rocket_loader` | off |
  | `fonts` | off |
  | `mirage` | off |
  | `polish` | off |
  | `bot_fight_mode` | **false** (newly readable — the token edit added Bot Management) |

  ADR-0013's "no telemetry, falsifiable by reading the deploy config" is now actually falsified-against rather than assumed. Web Analytics was never enabled for either project.
- **AC6 still blocked:** `http_request_dynamic_redirect` entrypoint → `request is not authorized`. The zone has only three managed rulesets (`http_request_sanitize`, `http_request_firewall_managed`, `ddos_l7`); **no dynamic_redirect ruleset exists yet**, and creating one needs the missing permission.
- **AC7 still blocked, no fallback:** probed `POST /accounts/{a}/rules/lists` directly → `Authentication error`. Bulk Redirects cannot be done with this token at all.
- **A fallback EXISTS for AC6 only, and it is an ADR-level choice, not mine to make silently.** `GET /zones/{z}/pagerules` is authorized and returns **0 rules** (Free plan quota: 3). A Page Rule can express a host-matching 301 with path preservation, which satisfies AC6's *behaviour*. But **ADR-0054 §7 names a zone Redirect Rule specifically**, and the ADR explicitly rejected `_redirects` for a mechanism-level reason. Swapping in a different mechanism changes a documented decision, so it is queued as an owner call rather than executed:
  - **Option A** — add **Zone → Config Rules: Edit** to the token; implement exactly what ADR-0054 §7 says. No ADR change.
  - **Option B** — use a Page Rule; behaviour identical, but ADR-0054 §7 needs an addendum recording the substitution and why (Free-plan Page Rules are a scarcer resource: 3 total, and this would consume 1).
  - Recommendation: **A**. The ADR's mechanism was chosen deliberately, Redirect Rules are not quota-scarce, and the permission is one checkbox.
- **State:** **AC1–AC5, AC8, AC9, AC10, AC11 MET.** Open: **AC6** (owner call above), **AC7** (needs Account → Account Rulesets: Edit), **AC12** (runbook corrections), browser walk.

### 2026-08-24 — Jeetu — session (AC12 runbook corrections; AC6/AC7 still blocked)

Owner chose **Option A** for AC6 (keep ADR-0054 §7's zone Redirect Rule; add the permission rather than substitute a Page Rule) — **no ADR change needed, ADR-0054 §7 stands as written.** Re-probed twice since; both permissions are still absent from token `921ab154…`, so AC6/AC7 remain unexecuted. Did the token-free work meanwhile.

- **AC12 — runbook corrected in five places, each from something reality contradicted:**
  1. **Custom domains** — removed the false "Cloudflare creates the CNAME records itself"; documented that both domains stall at `pending` / `"CNAME record not set"` until the proxied CNAMEs are added by hand, and that the apex CNAME does **not** disturb `MX` (with a reminder to confirm, since this zone carries live email).
  2. **Verify by fetching, not by status** — the Pages domain `status` lagged the serving edge by minutes; a transient 522 cleared on its own.
  3. **The `pages.dev` subdomain is not always `<project>.pages.dev`** — corrected the Bulk Redirect source and the Verify curl to `snug-website-c7z.pages.dev`, and said how to read the real value (`wrangler pages project list` / the API's `.subdomain`). The old text would have written a redirect that protects nothing and curled a host this account does not own.
  4. **Two verification traps** — the `--resolve`-in-a-plain-var failure that printed a fake `0`, and the cold-resolver problem right after a cutover (fix: `dig` the authority, then pin curl to the edge IP with a bash array).
  5. **Zone posture must be read from the API, not inferred from the `cdn-cgi` grep** — added the settings + bot_management loop, with the reason it matters: the grep passed while Email Obfuscation was `on`, because the apex was not yet serving.
  - Also added a **prerequisites table mapping each setup step to the exact permission it needs**, the instruction to probe each API rather than trust the scope list (a partial token edit is silent — proven twice this session), and the revoke-when-done rule with the `.env` exception marked temporary rather than a new default.
  - **The sign-in check is now correct rather than misleading:** grepping for "sign in" is NOT the test (those strings ship); the runbook now pins the real one, `grep -roh 'hubAuth:!\?[01]' … # must be exactly hubAuth:!1` — **command executed before shipping it**, returns `hubAuth:!1`, exit 0.
- **`node scripts/deploy-web.test.mjs` → 26/26 pass** after the edits (the suite asserts the runbook names every out-of-git fact, so this was a real regression risk, not a formality).
- **State:** AC1–AC5, AC8–AC12 MET. **AC6 and AC7 are the only open ACs**, both waiting on two token permissions: Zone → **Config Rules: Edit** and Account → **Account Rulesets: Edit** on token `921ab1541c5037d757319885ddba68fc`.
- **Next step:** on the permissions → create the `www` → apex 301 Redirect Rule (ADR-0054 §7, path + query preserved) and the `snug-pages-dev` Bulk Redirect (sources `snug-website-c7z.pages.dev` + `snug-playground.pages.dev`, subpath ON, preserve path/query ON, include-subdomains OFF) → re-verify → browser walk → revoke the token → `/close-session`, PR, merge.

### 2026-08-24 — Jeetu — session (owner-reported landing-page defect; close-session)

Owner reported the hero reading "in**one** portable file you own". **My first check said the text was correct and it was WRONG** — I grepped for `in <strong>` without allowing for the `class="astro-…"` attribute Astro injects, found nothing, and reported the phrase fine on the strength of the meta-description match. The owner's screenshot was the correction. **A grep that does not model the real markup is not a search; reporting its miss as "correct" was the actual error.**

- **Root cause:** Astro 7's `compressHTML: 'jsx'` strips the newline between a text run and an adjacent inline element, so a source line ending in a word with `<strong>` opening the next line renders the two joined. This is **[lessons.md] 2026-08-24 (Astro 7 output diffing) recurring at a `<strong>` boundary** — that entry pinned the `</a><a>` case and the `<strong>` case slipped past it.
- **Three sites, not the one reported** — found by scanning the SERVED html, then the source, rather than fixing only what was pointed at:
  1. `index.astro` hero — `— in<strong>one portable file you own`
  2. `Differentiators.astro` — `lives in<strong>one portable <code>.snug</code> file`
  3. `WireDemo.astro` — `JSON Schemas.<a>Read the wire protocol →`
- **Fix:** explicit `{' '}` at each boundary. Rebuilt (26 pages) and scanned **all** built pages for BOTH directions of the defect (`word<tag` and `</tag>word`): **zero remaining**. Visible-text extraction confirms all three read correctly.
- **Verified:** `pnpm --filter website test` **42/42**; root `pnpm test` **exit 0** with `website-sync: OK — 24 pages verified against 40 source hashes` (the DRIFT/FAIL lines above it in the log are the checker's own fixtures — these three pages are authored, not derived, so no re-sync was owed).
- **Done this session overall:** first production deploy (both apps), custom domains live, a real ADR-0013 violation fixed (Email Obfuscation was `on`), runbook corrected in five places, landing-page spacing fixed.
- **State:** `feat/TASK-20260824-web-deploy-execute` at `13fffbf` (3 commits incl. this close). **AC1–AC5, AC8–AC12 MET. AC6 + AC7 OPEN**, blocked only on two token permissions.
- **Next step:** push → PR → merge → `node scripts/deploy-web.mjs website --deploy` from `main` (owner asked for all four in this session's close).
- **Open questions / owner acts owed:**
  1. **Token `921ab1541c5037d757319885ddba68fc` needs Zone → Config Rules: Edit and Account → Account Rulesets: Edit** to finish AC6/AC7.
  2. **Revoke that token** once AC6/AC7 land — routine deploys need only the wrangler OAuth session.
  3. The **preview Access policy** is still deferred; `--preview` must not be run until it exists.
