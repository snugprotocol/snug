# 0064 — One blind relay for share links (amends ADR-0013)

- **Status:** accepted (owner Q1 = A, plan approval 2026-09-04, "go with defaults"; amends ADR-0013 — the relay is BUILT under TASK-20260904 and DEPLOYED only on a separate explicit owner ask per the release rules; **deployed 2026-09-04T19:16Z**); **§3 amended 2026-09-04 (TASK-20260904-share-link-ux) — see [Amendment](#amendment--2026-09-04-the-sharer-picks-the-lifetime-the-rate-limit-is-a-scripted-act-task-20260904-share-link-ux)**
- **Date:** 2026-09-04
- **Task:** TASK-20260904-app-sharing

## Context

ADR-0013 makes the hosted playground static files only; ADR-0052 kept that unamended by
rejecting a Cloudflare Worker feedback receiver ("dilutes the verifiable zero-endpoint
claim precisely when it matters most; a spam surface for a solo-dev launch"). Neither
`apps/server` nor any Worker is deployed anywhere today (`deploy-web.mjs` is Pages
direct upload; no `wrangler.*` exists in the repo).

Sharing an app **by link** needs the bundle's bytes to live somewhere the recipient can
fetch them. The options, with what each costs the doctrine:

| Option | Hosted surface | Works everywhere a link can be pasted? | Notes |
|---|---|---|---|
| **A — blind relay** (this ADR) | one Worker + R2 bucket | yes | stores ciphertext only |
| **B — bundle in the URL fragment** | none | **no** — Telegram (4 096 chars), Discord (2 000), SMS, X, Outlook line-wrapping; a typical bundle is 15–30 KB of URL | zero infra |
| **C — attachment only at launch** | none | n/a | ADR-0052's shape; link parked |
| Run `apps/server` in production | a full authenticated server | yes | contradicts ADR-0013 outright; far more than a blob store |
| **D — sharer's own sync origin** (Dropbox shared link + `#key`) | none | every messenger, but only sharers with an origin connected | keeps ADR-0013 unamended; Dropbox content-link CORS for web recipients needs a probe before it can be promised |

## Decision

1. **The hosted instance grows exactly one endpoint, and it is blind.** `apps/share-relay`
   is a Cloudflare Worker with an R2 binding exposing `POST /v1/bundles` (octet-stream,
   ≤ 1 MiB), `GET /v1/bundles/:id` (immutable until expiry), and `DELETE /v1/bundles/:id`
   with the revoke token minted at upload. Nothing else: no listing, no accounts, no
   cookies, no analytics, no content logging; ids are server-minted 128-bit random
   base64url; every other method or path is 404.
2. **The relay cannot read what it stores.** The sharer's browser encrypts the bundle with
   a random AES-256-GCM key (WebCrypto) before upload; the key travels only in the link's
   URL **fragment** (`https://playground.snugprotocol.org/s/<id>#<key>`), which browsers
   never send to any server and strip from `Referer`. A compromised or subpoenaed relay
   yields ciphertext; tampering fails the AEAD tag on the recipient's side. This is why
   ADR-0013's "we collect nothing" survives in substance: the relay holds bytes it cannot
   interpret, tied to no identity, for a bounded time.
3. **Bounded by construction.** 30-day TTL (R2 lifecycle rule + `expiresAt` echoed to the
   sharer), 1 MiB cap, per-IP rate limit (Cloudflare rate-limiting rule, documented in the
   runbook), CORS allowlist = the playground origins + `tauri://localhost`.
4. **Owner-operated, explicit-ask deploys.** `scripts/deploy-relay.mjs` follows ADR-0054's
   discipline (pre-flight, print the wrangler argv and stop unless `--deploy`, journaled);
   the first `wrangler.jsonc` in the repo lives in `apps/share-relay`. The relay origin is
   single-homed in `config/site.ts`; **a build without it renders no copy-link action**, so
   self-hosters and the attachment path never depend on it.
5. **The falsifiability claim is restated, not dropped.** The landing-page wording moves
   from "no endpoint" to "one blind endpoint" — verifiable by reading ~150 lines of
   Worker plus the client crypto, and by the absence of any other host in the deploy
   config. This ADR is the public record of that change.

## Alternatives considered

See the table. **B** was seriously considered because it keeps ADR-0013 byte-for-byte:
it is rejected as the primary path only because the links break in the channels people
actually paste into; it may return as a hidden fallback for self-hosters without a relay.
**D** (raised by the fresh-context plan review) also keeps ADR-0013 unamended and is the
owner's to weigh against A: no endpoint to operate, at the cost of "copy link" existing
only for users who connected a sync origin — which today is nobody by default.

## Consequences

- ADR-0013 §"Consequences" gains the exception: *the share relay (ADR-0064) is the one
  hosted endpoint; it is content-blind, TTL-bounded, and carries no identity.*
- Threat-model delta: a 1 MiB encrypted blob drop is a generic anonymous file host for 30
  days (accepted residual, mitigated by cap/TTL/rate limit; Turnstile queued if abuse
  appears); "anyone with the link can install" — the link **is** the secret, and the share
  sheet says so; a compromised relay can deny or delete but cannot read or substitute.
- Cost: Cloudflare free tier at launch scale (Workers 100k req/day; R2 10 GB); grows with
  shares, bounded by TTL.
- A revoke is best-effort: a recipient who already fetched keeps the bytes.

## Amendment — 2026-09-04: the sharer picks the lifetime; the rate limit is a scripted act (TASK-20260904-share-link-ux)

- **§3's "30-day TTL" becomes a ceiling.** `POST /v1/bundles?expires=1d|7d|30d` stamps the
  sharer's choice — **24 hours, 1 week (the default) or 1 month** — and `TTL_DAYS` (30) is
  the ceiling: a choice above it is refused with 400, never clamped silently; an absent
  choice is a week. The closed set is the contract (a free-form seconds value would make
  the relay's retention a caller's decision). A read that finds an expired object deletes
  it; the bucket's 31-day lifecycle rule remains the backstop, not the authority. The
  receiver's copy no longer promises "30 days" — it says the sender picks.
- **The per-IP rate limit is written by `deploy-relay.mjs ratelimit`** (print-and-stop,
  `--apply` on the explicit ask) through the rulesets API's `http_ratelimit` phase, not by
  hand in the dashboard: POST `/v1/bundles` on the relay host, 20 per minute per IP, block
  10 minutes, **clamped to the zone's plan with every clamp printed** (the Free plan allows
  only 10 s / 10 s). It needs one scoped API token (`Zone.Zone:Read` + `Zone.Zone WAF:Edit`)
  held as `CLOUDFLARE_WAF_TOKEN` in the gitignored root `.env` — deliberately not
  `CLOUDFLARE_API_TOKEN`, which wrangler would adopt for every deploy. Wrangler's own OAuth
  session cannot call the WAF API (verified: `9109 Invalid access token`, scopes `zone
  (read)` only).
- **The relay origin is a pinned build invariant on both shipped surfaces**:
  `deploy-web.mjs`'s `PINNED_BUILD_ENV` and `release-desktop.mjs`'s
  `DESKTOP_PINNED_BUILD_ENV` both carry `VITE_SNUG_SHARE_RELAY=https://share.snugprotocol.org`
  from one constant, so the hosted playground and the desktop shell cannot name two relays,
  and §4's "a build without it renders no link action" now describes only self-hosters.
