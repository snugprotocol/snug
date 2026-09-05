# Runbook — deploy the share relay (ADR-0064)

The share relay is the ONE hosted endpoint: `share.snugprotocol.org`, a Cloudflare Worker
(`apps/share-relay/worker.mjs`) with one R2 bucket (`snug-share-bundles`). It stores
end-to-end-encrypted app bundles it cannot read, for a bounded time, and nothing else. It
is deployed **only on an explicit owner ask**, by the owner, from a clean `main`
(PROCESS.md release rules; ADR-0054's discipline). Every deploy is journaled with UTC
time and the verification performed.

## One-time setup (the owner, from the repo root)

`node scripts/deploy-relay.mjs init` prints these; in order:

0. **The relay's code must be on `main`.** The deploy refuses anything but a clean tree
   on `main == origin/main` (`gitPreflight`, shared with `deploy-web.mjs`), so a relay
   living only on a feature branch cannot be deployed: **merge first**, then
   `git switch main && git pull`. Stated because the natural reading of `init`'s output
   is "run these now", and step 1 on a branch would refuse four steps later.
1. **Bucket:** `pnpm exec wrangler r2 bucket create snug-share-bundles` on the account
   that holds the `snugprotocol.org` zone (`CLOUDFLARE_ACCOUNT_ID` in the gitignored root
   `.env`, as for `deploy-web.mjs`).
2. **Lifecycle janitor:**
   `pnpm exec wrangler r2 bucket lifecycle add snug-share-bundles expire-shares --expire-days 31`
   (verified against `wrangler r2 bucket lifecycle add --help` on wrangler 4.125 — the
   dashboard path R2 → the bucket → Settings → Object lifecycle does the same thing).
   This reclaims storage; it is NOT the expiry authority — the Worker stamps `expiresAt`
   at upload — the sharer's choice, `?expires=1d|7d|30d`, default a week, under the
   `TTL_DAYS` ceiling (30; a choice above it is refused) — and refuses reads past it
   (deleting the object it found), so a lapsed rule cannot extend a link. Confirm with `pnpm exec wrangler r2 bucket lifecycle list snug-share-bundles`.
3. **Custom domain:** `apps/share-relay/wrangler.jsonc` declares
   `share.snugprotocol.org` with `custom_domain: true`; the first deploy binds it (the
   zone must be on this account). `workers_dev` is `false` — there is no second host.
4. **Rate limit — a scripted act since 2026-09-04 (TASK-20260904-share-link-ux):**
   `node scripts/deploy-relay.mjs ratelimit` prints the WAF rule the zone would get —
   `share.snugprotocol.org`, method `POST`, path `/v1/bundles`: **20 requests per minute per
   IP, block for 10 minutes**, clamped to the zone's plan with every clamp printed (the Free
   plan allows only a 10 s period and a 10 s block, so the same rate becomes 4 per 10 s) —
   and `--apply` writes it through the rulesets API's `http_ratelimit` phase, updating our
   rule in place by its description and leaving any other rule alone. It needs ONE scoped
   API token in the gitignored root `.env` as `CLOUDFLARE_WAF_TOKEN` (dash → My Profile →
   API Tokens → Create Token → custom: `Zone.Zone:Read` + `Zone.Zone WAF:Edit`, zone
   `snugprotocol.org`). **Not `CLOUDFLARE_API_TOKEN`** — wrangler reads that name and would
   switch every deploy from the OAuth session to a token that cannot deploy Workers.
   Wrangler's own session cannot do this (its token answers `9109 Invalid access token` on
   the REST API and carries `zone (read)` only). This is the abuse control for the blind
   blob drop (threat-model R-36). Verify: 25 quick POSTs from one IP → the 21st answers
   429 (or 403 in the block window).
5. **Nothing else.** No Workers Analytics, no Logpush, no KV/D1 — `deploy-relay.mjs`
   refuses a config that carries any of them (`configPreflight`).

## Each deploy

```
node scripts/deploy-relay.mjs            # pre-flight + relay tests + PRINT the argv, stop
node scripts/deploy-relay.mjs --deploy   # the explicit ask
```

Pre-flight: wrangler ≥ 4 logged in to the account; clean tree on `main == origin/main`;
`pnpm --filter share-relay test` green; the config is the blind shape.

## Verify (journal this)

- `curl -sI https://share.snugprotocol.org/` → `404` with no body.
- `curl -sI https://share.snugprotocol.org/v1/bundles/AAAAAAAAAAAAAAAAAAAAAA` → `404`.
- From the hosted playground: open an owned app → share → **copy link** → open the link in
  a private window → the preview opens, "run with AI" is off, install works.
- From the desktop shell: click **open in Snug for Mac** on that page → the shell opens
  the same preview (the `snug://` scheme).
- `pnpm exec wrangler deployments list --config apps/share-relay/wrangler.jsonc` names
  the commit (`DEPLOY_SHA`).

## The playground and the desktop build must know the relay

The link actions (copy link, share…) render only when the UI was BUILT with
`VITE_SNUG_SHARE_RELAY=https://share.snugprotocol.org` (`config/site.ts`
`SHARE_RELAY_ORIGIN`; empty = no link transport). Since 2026-09-04 both shipped builds pin
it from ONE constant: `deploy-web.mjs` `PINNED_BUILD_ENV` (the hosted playground) and
`release-desktop.mjs` `DESKTOP_PINNED_BUILD_ENV` (the shell's `tauri build`, which also
refuses an environment naming a different relay and any `apps/desktop/.env*`) — and since
TASK-20260905 `apps/desktop/vite.config.ts` DEFAULTS the same value, so `tauri dev` shows
the link actions too (an explicit env value still wins; the release refuses a different one). A self-hosted
build without the variable ships the attachment path alone, by design. **Contract order:**
the relay must understand `?expires=` BEFORE a UI that sends it ships — deploy the relay
first, then the playground, then the next desktop release.

## Deploy log

- **2026-09-04T19:16:11Z — first deploy, LIVE and verified on the public host.** Worker
  `snug-share-relay` version `8e431bbd-4c1e-432e-b7a5-f2845a670baa`, from `main @ 2fe537d`,
  bindings confirmed at upload (`env.BUNDLES` → `snug-share-bundles`, `TTL_DAYS=30`, the
  origins allowlist). Bucket created 19:15:45Z with lifecycle rule `expire-shares`
  (expire after 31 days, all prefixes), read back with `lifecycle list`.

  **Verified against `https://share.snugprotocol.org` itself** (~13 min after the deploy):
  root and an unknown id → bodiless 404 · `POST` → 201 with a 22-char id, a +30d
  `expiresAt` and a 43-char revoke token · `GET` → the exact bytes, with
  `content-type: application/octet-stream`, `cache-control: private, no-store, max-age=0`,
  `x-content-type-options: nosniff` and `x-snug-expires-at` · a **foreign** Origin's POST →
  403 and its preflight → 404, while the playground origin's preflight → 204 with the
  expected `access-control-allow-*` · a WRONG revoke token → 404 **and the object survives**
  (no existence oracle, no accidental delete) · the real token → 204, after which `GET` →
  404 and `wrangler r2 bucket info` reports `object_count: 0` (deleted from storage, not
  just from the API's view) · a 1.2 MiB body → 413 · an empty body → 400 · `/v2/bundles`
  → 404.

  ~~Still owed: the WAF rate-limit rule.~~ **Applied by the owner 2026-09-04/05** via
  `deploy-relay.mjs ratelimit --apply` (step 4 above).

- **2026-09-04/05 — second deploy (owner, after PR #166 merged @ `f21120d`)**: the
  `?expires=1d|7d|30d` contract. Verified from this machine 2026-09-05T00:45Z against
  `https://share.snugprotocol.org`: `POST ?expires=2d` → 400 · `POST ?expires=1d` → 201 with
  `expiresAt` exactly +1 day · the real revoke token → 204 · then `GET` → 404. The playground
  was deployed AFTER it (2026-09-05T00:44:40Z, deployment `3c511c52`), in the contract order
  the runbook requires.

### Note — the custom domain takes longer than ~10 minutes to start routing

Between the deploy and roughly 13 minutes later, every path on `share.snugprotocol.org`
returned **500 / `error code: 1104`** while DNS resolved and TLS completed. It resolved
itself with no intervention. **This is normal propagation for a newly bound Workers custom
domain — do not treat it as a fault and do not start removing/re-adding the domain.**

Two things made it look worse than it was, worth knowing for the next deploy: `wrangler
tail` showed the Worker receiving nothing during the 500s (consistent with the edge failing
before the Worker, which is exactly what propagation looks like), and the dashboard showed
the domain attached with **0 errors** the whole time — the dashboard was right and the curl
was early. If it is ever genuinely stuck, check **Workers & Pages → snug-share-relay →
Settings → Domains & Routes**. Do NOT "fix" routing by enabling `workers_dev`: the config
pins it false on purpose (a `*.workers.dev` name is a second, unpinned host for a blind
relay) and `deploy-relay.mjs`'s preflight refuses the change.

## Local end-to-end (playground + desktop against a relay on this machine)

`wrangler dev` runs the Worker with a simulated R2 bucket; nothing touches the real bucket
or host. Two constraints shape the recipe: the local playground's BROWSER needs its origin
in the CORS allowlist, and the desktop's HTTP scope admits plain `http://` only on two
loopback literals (the RFC-1918 entries never match — next-steps 2026-09-05), so the relay
must sit on the debug stub port `127.0.0.1:43120`:

```
cd apps/share-relay && pnpm exec wrangler dev --ip 127.0.0.1 --port 43120 \
  --var "ALLOWED_ORIGINS:https://playground.snugprotocol.org,tauri://localhost,http://tauri.localhost,http://localhost:5173"
```

Then `VITE_SNUG_SHARE_RELAY=http://127.0.0.1:43120` in `apps/playground/.env.local` (with
`VITE_SNUG_SHARE_LINK_ORIGIN=http://localhost:5173`; restart `pnpm dev`) and
`VITE_SNUG_SHARE_RELAY=http://127.0.0.1:43120 pnpm --filter desktop dev`. Links read
`http://localhost:5173/s/<id>#<key>`; "open in Snug for Mac" hands the same id to the dev
shell, which fetches from the same local store. Do not run the in-shell gate at the same
time (it owns 43120), and put `.env.local` back before testing production behaviour.

## Rollback

`pnpm exec wrangler rollback --config apps/share-relay/wrangler.jsonc` to the previous
deployment, or delete the Worker: links then fail with "could not reach the share relay";
attachments are unaffected. Existing objects stay in the bucket until the janitor
reclaims them; deleting the bucket revokes every link at once.
