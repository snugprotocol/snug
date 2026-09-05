# TASK-20260904-share-link-ux: "share…" shares the link everywhere, keep is gone, the sharer picks the expiry

- **Status**: in-review — implementation complete, root gate green, PR open
- **Owner**: Jeetu
- **Risk tier**: **medium** — `apps/share-relay` (the hosted endpoint's contract gains a TTL choice), `apps/playground` (sharer + receiver surfaces), `scripts/deploy-web.mjs` + `scripts/release-desktop.mjs` (a pinned build invariant), `scripts/deploy-relay.mjs` (the rate-limit rule as a scripted act). No protocol/auth/db change.
- **Branch**: `feat/TASK-20260904-share-link-ux` (cut from `main` @ `5a3a06b`)
- **Packages touched**: `apps/share-relay` (Medium), `apps/playground` (Medium), `scripts/` (Medium), docs (ADR-0063 §4/§6 amendment, ADR-0064 §3 amendment, threat-model delta S5/R-c, runbook).
- **Spec impact**: none published (`snug-app-bundle/1` unchanged; the relay contract is ADR-0064's, not the spec's).
- **Related**: TASK-20260904-app-sharing (done; PR #161/#164/#165), ADR-0063, ADR-0064, ADR-0054 (print-and-stop deploy tooling), next-steps 2026-09-04 items 1–2.

## Spec (what & why)

The owner walked the shipped sharing surfaces (2026-09-04) and found three things:

1. **"share…" on the playground fails with "Permission denied".** The button renders when `navigator.canShare({ files })` says yes; desktop Chrome says yes and then `navigator.share` refuses — Chrome only shares an allowlist of file extensions (images, video, pdf, txt…), `.snug` is never on it, and `canShare` does not check it. The button worked only where the OS sheet accepts any file (WKWebView on the desktop, mobile Safari).
2. **On the desktop "share…" attached the `.snug` file.** The owner wants the OS share sheet to carry the LINK — iMessage, Mail, Notes, AirDrop — exactly what "copy link" mints.
3. **"keep" beside "install" on a link preview was confusing.** Keep persisted the received bundle to the "shared with you" shelf without installing (a bookmark; the explicit act ADR-0063 §4 required before a link's bytes touch the user file). Install never needed it. The owner asked for it to go.

Plus two asks: **the WAF rate-limit rule** on the relay (still owed since the first deploy) becomes a scripted, print-and-stop act rather than a dashboard-only note; and **the sharer picks the link's lifetime** — 24 hours, 1 week (default) or 1 month — where the relay had one fixed 30-day TTL.

**Acceptance criteria** (each becomes at least one test):

*Relay (`apps/share-relay`)*
1. `POST /v1/bundles?expires=<1d|7d|30d>` stamps `expiresAt` = now + that many days; absent → `7d`; any other value → 400 with no body. `TTL_DAYS` (config var) is the CEILING (30): a choice above it is refused, never clamped silently. The 201 body's `expiresAt` reflects the choice.
2. A `GET` of an expired-but-uncollected object answers 404 AND deletes the object (the janitor assist; the lifecycle rule stays the backstop).

*Sharer (`apps/playground`)*
3. `exportShare.ts` loses `canShareFile` / `shareViaOs` (file transport through the OS sheet — DELETED, claims classified below). `ShareLinkPanel` gains **share…** beside **copy link**: mint (encrypt → upload) → `navigator.share({ title, text, url })`. Rendered only when a relay is configured AND `navigator.share` exists; a no-relay build renders neither link action. The sheet footer keeps **download .snug** alone.
4. (N) If `navigator.share` rejects with `NotAllowedError` after the upload (the browser's activation window closed during a slow upload), the link is still shown in the read-only field, copied, and a note says so; the sheet never throws. An `AbortError` (user dismissed) is silent.
5. The link panel carries an expiry choice — `24 hours` / `1 week` / `1 month`, default `1 week` — used by BOTH copy link and share…; the terms sentence names the resulting date; `mintShareLink(appId, prepared, expires)` passes it to `uploadCiphertext(ciphertext, expires)` as the `expires` query param.

*Receiver (`apps/playground`)*
6. The preview header renders NO "keep" control for any entry. `sharedInbox.ts` keeps its persistence step for attachments only (renamed `persistSharedEntry`; a link receipt is memory-only and installs directly). Install from a memory-only link entry works (already true; pinned by the existing install journey).
7. Receiver failure copy no longer promises "30 days" — it says the sender picks the lifetime.

*Build pins (`scripts/`)*
8. `deploy-web.mjs`'s `PINNED_BUILD_ENV` carries `VITE_SNUG_SHARE_RELAY=https://share.snugprotocol.org`; `release-desktop.mjs` sets the same variable for `tauri build` (and refuses if the environment overrides it to something else). Both pinned by their existing test files.

*Rate limit (`scripts/deploy-relay.mjs`)*
9. `node scripts/deploy-relay.mjs ratelimit` resolves the zone id for `snugprotocol.org` with `CLOUDFLARE_API_TOKEN` (root `.env` or env; the wrangler OAuth session cannot call the WAF API — verified 2026-09-04: the REST API answers 9109 to it), reads the zone plan, PRINTS the rule it would write in the `http_ratelimit` phase (POST `/v1/bundles` on `share.snugprotocol.org`, 20 per 60 s per IP, block 600 s — clamped to the plan's allowed period/timeout with the clamp printed), and STOPS unless `--apply`. Idempotent: an existing rule with the relay's description is updated, not duplicated. Pure helpers tested; the HTTP is behind the io seam.

*Docs*
10. ADR-0063 §4 + §6 amended (link previews are memory-only and install directly; no keep; no file through the OS sheet), ADR-0064 §3 amended (TTL is the sharer's choice ≤ 30 days), threat-model delta S5 + R-c reworded, runbook step 4 rewritten around the script, next-steps items 1–2 closed, code map row, lessons.

**Deleted-test classification (lesson 2026-08-10):** no unit test exercised the `share-os` button or `shareViaOs`/`canShareFile` (verified by grep before deletion — the sheet test covers download + the scan gate only), so nothing is MIGRATED or LOST; the ADR-0063 §6 sentence "plus the OS share sheet where `navigator.canShare({ files })` allows it" is OBSOLETE and amended. `sharedInbox.test.ts`'s `keepSharedEntry` test is MIGRATED to `persistSharedEntry` (same claim: the persist act writes the row).

**Out of scope**: remembering the sharer's last expiry choice; per-link expiry editing after mint; QR; Turnstile; the desktop `snug://` hardware walk; a desktop release (the desktop pin ships with the NEXT release).

## Plan

Tests first, in this order: relay handler (AC1–2) → relayClient/shareLinks (AC5) → ShareLinkPanel + ShareSheet (AC3–5) → RunView/sharedInbox (AC6–7) → deploy scripts (AC8–9) → docs (AC10). Then root `pnpm test`, e2e `share.spec.ts`, and a relay deploy on the owner's ask (the TTL choice is a contract change — the playground must not ship `?expires=` before the relay understands it, so the relay deploy precedes the web deploy).

## Decisions & surprises

- **2026-09-04 — Chrome's `canShare` lies about files.** `canShare({ files })` validates count/size only; the extension allowlist lives in the browser process and surfaces as `NotAllowedError: Permission denied` from `share()`. A capability check that cannot see the refusal is not a capability check — the file transport through the OS sheet is deleted rather than guarded, and the sheet shares the LINK, which every Web Share implementation accepts.
- **2026-09-04 — the wrangler OAuth token is not an API token.** Wrangler's session (`~/Library/Preferences/.wrangler/config/default.toml`) answers `9109 Invalid access token` on the REST API and its scopes carry `zone (read)` only — no `zone_waf`. The rate-limit rule therefore needs a scoped API token (`Zone.Zone:Read` + `Zone.Zone WAF:Edit` on `snugprotocol.org`), in the gitignored root `.env` as `CLOUDFLARE_API_TOKEN`. The script refuses without it and says exactly that.
- **2026-09-04 — "30 days" is not a rate-limit parameter.** The owner's ask read "set it to 30 days"; Cloudflare rate-limit periods top out at minutes and mitigation timeouts at hours. The 30-day figure is the relay's retention CEILING, which item 5's "1 month" keeps. The rule is written with the runbook's numbers (20/min/IP, block 10 min), clamped to the plan.

## Session journal (append-only, newest last)

### 2026-09-04 16:40 — Claude (Fable 5.1) — session (pickup → spec → implementation)
- Done: read the archived TASK-20260904-app-sharing journal from git history (moved to done/ in #162), PRs #164/#165, ADR-0063/0064, the runbook, and every share module; diagnosed the three owner-reported items (above); owner approved the five-item scope; branch cut; this file.
- Baseline on `main` @ `5a3a06b`: the six share suites 58/59 — the one red is `shareLink.test.tsx:123` and it is the gitignored `apps/playground/.env.local` (`VITE_SNUG_SHARE_LINK_ORIGIN=http://localhost:5173`, which vitest reads) — not a code red; CI has no `.env.local`. **Lost context, now journaled:** nothing in the tree said that file reds a test locally.
- State: implementing, tests first (relay → playground → scripts → docs).
- Next step: AC1–2 in `handler.node-test.mjs`.

### 2026-09-04 17:30 — Claude (Fable 5.1) — session (implementation, tests first)
- Done, each suite red before its module changed, then green:
  - **relay** `handler.mjs`: `?expires=1d|7d|30d` (closed set, default 7d, `TTL_DAYS` = ceiling, refused above it, 400 bodiless on anything else), expired reads delete the object; 10/10 node:test (was 8).
  - **playground**: `relayClient` (`ShareExpiry`, `SHARE_EXPIRY_CHOICES` with labels, `uploadCiphertext(…, expires)`), `shareLinks.mintShareLink(…, expires)`, `exportShare` (`canShareFile`/`shareViaOs` DELETED → `canShareLink`/`shareLinkViaOs` returning `shared | dismissed | not-allowed`), `ShareLinkPanel` (share… + expiry select; NotAllowedError → link shown + copied + `share-os-note`), `ShareSheet` (footer = download only), `RunView` (no keep button), `sharedInbox` (`keepSharedEntry` → `persistSharedEntry`, attachment-only; comments rewritten), `SharedShelf` ("this visit only" for a memory-only link entry), `SharedLinkView` (no "30 days" promise). New `shareLinkPanel.test.tsx` (5), `shareSheet.test.tsx` +1 (no-relay build renders neither link act even when the browser could share — pinned by `vi.mock` of the config, because vitest reads `.env.local`), `sharedSurfaces.test.tsx` +1 (link preview: no keep, install from memory, never persisted), `sharedInbox.test.ts` MIGRATED (keep → persist), `shareLink.test.tsx` +1 (the `expires` param on every choice) and the link origin pinned by mock (the `.env.local` red is gone).
  - **scripts**: `deploy-web.mjs` `PINNED_BUILD_ENV.VITE_SNUG_SHARE_RELAY` from a new `SHARE_RELAY_ORIGIN` constant (+test); `release-desktop.mjs` `DESKTOP_PINNED_BUILD_ENV` + `desktopBuildEnv` (refuses a different relay in the env and any `apps/desktop/.env*`) applied to `tauri build` (+test; `.d.mts` extended); `deploy-relay.mjs ratelimit [--apply]` — `rateLimitRuleFor(plan)` (plan ceilings from the Cloudflare docs, read 2026-09-04: Free 10 s/10 s, Pro 60 s/1 h, Business 10 min/1 day), `mergeRateLimitRules` (replace ours by description keeping its id, keep strangers), `resolveWafToken` (`CLOUDFLARE_WAF_TOKEN`, never `CLOUDFLARE_API_TOKEN`), `ratelimitMain` over an `io.http` seam (+4 tests, 10/10). `.env.example` documents the token.
  - **docs**: ADR-0063 + ADR-0064 amendments; threat-model delta S5/R-c + model R-36 + ledger re-pin (checker 235/235); runbook step 4 rewritten + the build-pin section + contract order; code map (4 rows); next-steps (item 2 closed, a new dated entry with the owner acts); 3 lessons.
- **Not done (needs the owner):** the rate-limit rule is NOT applied — `deploy-relay.mjs ratelimit` refuses without `CLOUDFLARE_WAF_TOKEN` (verified by running it). The relay and playground are NOT redeployed (explicit-ask acts; and the contract order matters: relay first, because the new UI sends `?expires=`).
- State: root `pnpm test` running with `.env.local` moved aside (deploy-web's posture check refuses it, and it reds/greens tests it should not); then e2e `share.spec.ts`; then push + PR.
- Gate: root `pnpm test` **exit 0** (protocol 372 · auth 946 · db 444 · playground **1800** · desktop 192 · relay **10** · scripts checks incl. threat-model 235/235, deploy-web, deploy-relay, release-desktop, website-sync OK); e2e `share.spec.ts` green in Chromium (the attachment journey is unchanged).
- Next step: PR → CI → owner review → merge; then the owner acts listed above (token + `ratelimit --apply`; relay deploy; playground deploy).
- **PR #166 OPEN** (https://github.com/snugprotocol/snug/pull/166); CI pending at the time of writing.
- **CI GREEN on PR #166** (`workspace` + `desktop-shell (macos-latest)` both pass). Awaiting owner review + merge; then the owner acts above.
