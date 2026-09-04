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
   (`TTL_DAYS`, 30) at upload and refuses reads past it, so a lapsed rule cannot extend
   a link. Confirm with `pnpm exec wrangler r2 bucket lifecycle list snug-share-bundles`.
3. **Custom domain:** `apps/share-relay/wrangler.jsonc` declares
   `share.snugprotocol.org` with `custom_domain: true`; the first deploy binds it (the
   zone must be on this account). `workers_dev` is `false` — there is no second host.
4. **Rate limit — the one genuinely dashboard-only step:** Security → WAF → Rate
   limiting rules → for `share.snugprotocol.org`, method `POST`, path `/v1/bundles`:
   **20 requests per minute per IP, block for 10 minutes**. This is the abuse control for
   the blind blob drop (threat-model R-36); it lives outside the code and outside
   wrangler, which is exactly why it is written here.
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

## The playground build must know the relay

The copy-link action renders only when the playground was BUILT with
`VITE_SNUG_SHARE_RELAY=https://share.snugprotocol.org` (`config/site.ts`
`SHARE_RELAY_ORIGIN`; empty = no link transport). `deploy-web.mjs` pins the build env —
add the variable there when the relay is live, in the same change that turns the link on.
Until then the hosted playground ships the attachment path alone, by design.

## Deploy log

- **2026-09-04T19:16:11Z — first deploy.** Worker `snug-share-relay` version
  `8e431bbd-4c1e-432e-b7a5-f2845a670baa`, from `main @ 2fe537d`, bindings confirmed at
  upload (`env.BUNDLES` → `snug-share-bundles`, `TTL_DAYS=30`, the origins allowlist).
  Bucket `snug-share-bundles` created 19:15:45Z with lifecycle rule `expire-shares`
  (expire after 31 days, all prefixes) — read back with `lifecycle list`.
  **Verified through `wrangler dev --remote` against the REAL bucket** (the custom domain
  was not serving — see below): root → bodiless 404; `POST /v1/bundles` → 201 with a
  22-char id, a +30d `expiresAt` and a 43-char revoke token; `GET` returned the bytes;
  `DELETE` with a WRONG token → 404 (no existence oracle); with the real token → 204;
  `GET` after revoke → 404. The contract holds end to end against real R2.
  **NOT verified:** the public hostname (below), and the WAF rate-limit rule is not yet
  created.

### Known issue — `share.snugprotocol.org` returns 500 / error 1104

The first deploy bound the custom domain (`Deployed snug-share-relay triggers` names it),
DNS resolves to Cloudflare's proxy, and TLS completes — but every path returns a 500 with
`error code: 1104`, including paths that never touch R2. **`wrangler tail` shows the
Worker receiving nothing**, so the request is failing at the edge BEFORE the Worker runs:
this is a routing/provisioning fault, not application code. Ruled out: the Worker itself
(the full round trip passes against the real bucket via `--remote`), a stale deploy (one
version, 100%), a conflicting CNAME (none — only Cloudflare A records), the zone
(`snugprotocol.org` and `playground.snugprotocol.org` both serve 200), and slow
certificate provisioning (unchanged across ~10 minutes of polling).

Next steps when picking this up: check **Workers & Pages → snug-share-relay → Settings →
Domains & Routes** in the dashboard for the domain's status (it may show a pending or
errored certificate), and if it is stuck, remove and re-add the custom domain there. Do
NOT "fix" this by turning on `workers_dev` — the config pins `workers_dev: false` on
purpose (a `*.workers.dev` name is a second, unpinned host for a blind relay) and
`deploy-relay.mjs`'s config preflight refuses that change.

## Rollback

`pnpm exec wrangler rollback --config apps/share-relay/wrangler.jsonc` to the previous
deployment, or delete the Worker: links then fail with "could not reach the share relay";
attachments are unaffected. Existing objects stay in the bucket until the janitor
reclaims them; deleting the bucket revokes every link at once.
