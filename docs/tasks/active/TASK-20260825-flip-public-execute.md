# TASK-20260825-flip-public-execute: flip `snug` + `spec` public

- **Status**: planned
- **Owner**: Jeetu (owner-gated throughout — this task is mostly 🔑, not code)
- **Risk tier**: **high** — irreversible-in-practice (a public repo can be re-privatised, but forks, clones, code-search indexes and archive.org are not recallable)
- **Branch**: `chore/TASK-20260825-flip-public-execute` (for the 🤖 doc edits only; the flip itself is a `gh` act on `main`)
- **Packages touched**: none — `README.md`, `apps/playground` head tags, `../.github-org/profile/README.md`
- **Spec impact**: none
- **Related**: private `RUNBOOK-flip-public.md` stages 5–8 (source of record) · ADR-0041 (CI dispatch-only) · ADR-0047 (release/signing) · ADR-0052 (feedback deep-links) · ADR-0053 (history kept) · ADR-0055 (legal pages) · ADR-0056 (dependency acceptances) · ADR-0057 (codenames in history accepted; scrub tooling gitignored)

## Spec (what & why)

Flip `snugprotocol/spec` and `snugprotocol/snug` from private to public, then apply the settings that GitHub only exposes on public repos. Every *technical* blocker is cleared: the stage-0 origin history purge holds, the stage-1 working-tree scrub is merged, the site and playground are live, and v0.1.0 is signed, notarized and verified on hardware. What remains is owner judgment and owner hands.

This task exists because the flip is a **sequence with ordering constraints**, several of which are counter-intuitive and were learned the hard way: repo social previews cannot be uploaded before the flip (GitHub hides the control on private repos), branch protection cannot be applied before the flip (free-plan public-only), private vulnerability reporting 404s before the flip, and the ADR-0052 feedback deep-links 404 by design before the flip. Doing them in the wrong order means either a dead control or an announcement that unfurls with generic branding.

**Acceptance criteria**:
1. `gh repo view snugprotocol/{spec,snug} --json visibility` reports `PUBLIC` for both.
2. A logged-out browser reaches both repos; GitHub code search over each returns **0** hits for every term in `scrub-terms-must-be-zero.txt` and **0** for the old private path.
3. Both repos carry a social-preview image; a link pasted into X/LinkedIn/Slack unfurls with the Snug card, not GitHub's fallback.
4. Secret scanning + push protection, private vulnerability reporting, and the `main-pr-only` ruleset are active on both repos.
5. `SECURITY.md`'s advisories/new link and the ADR-0052 feedback deep-link both resolve (they 404 while private).
6. The 0.4 fetch probe still FAILS against the now-public repo.
7. No dead link in `README.md`'s footer.

**Out of scope**: the Show HN post and marketing copy (LAUNCH_OPS) · restoring Actions billing (owner decision 2026-08-23: post-launch) · the v0.1.0→v0.1.1 update walk (needs a second release; its own ask) · the Instagram starter branch (held, local-only by directive) · react-router 6→7 (acceptance runs to 2026-11-30).

---

# 🤖 What I can do (agent work — no owner hands needed)

These are safe to do now, on a branch, before the flip. None of them touch the flip trigger.

- [ ] **A1 — Fix the dead README footer link.** [`README.md:116`](../../README.md) links "Jeetu Maker" to `https://jeetu.tech.voyage`, which is **NXDOMAIN** — Cloudflare's own authoritative NS (`kipp.ns.cloudflare.com`) says the record does not exist, so it is not a host that is down, it was never created. Neighbours for contrast: `tech.voyage` → `20.69.151.16`, `www.tech.voyage` → same, `ai.tech.voyage` → `34.133.152.162` (the TechVoyage half of the footer is fine). **Blocked on one owner decision — see 🔑 O1.** Default if no answer: repoint to `https://github.com/jeetumaker`.
- [ ] **A2 — Add OG tags to `apps/playground`.** It has **zero** OG/twitter meta (grepped: no `og:image`, `og:title`, `twitter:card` anywhere in `apps/playground`). `playground.snugprotocol.org` is a shareable URL and will be shared. Mirror the website's `SocialMeta.astro` approach — and note the lesson from TASK-20260825: **`og:image` must be an ABSOLUTE URL**; scrapers drop a root-relative one rather than resolving it, which is exactly the bug that shipped to production last time.
- [ ] **A3 — Draft the `.github` org-landing edit.** Remove the "pre-launch note" paragraph from `../.github-org/profile/README.md` ("repos open at launch" goes false the instant they do). Prepare the diff now; **commit it only after the flip** (that repo has no branch protection and no task-file convention, so it goes straight to `main` without a PR). While there: `hub-talk-build-run.png` is now unreferenced after the banner swap — deleting it is 🔑 O7.
- [ ] **A4 — Pre-flight verification sweep, re-run at T-2.** All four passed when checked 2026-08-25; they are cheap and must be re-run in the flip hour, not trusted from this file:
  - `node scripts/check-public-scrub.mjs` → expect `public-scrub: OK`. **Gitignored and absent from `pnpm test` (ADR-0057) — nothing automated will ever run this.** If the working tree lacks the three files, copy them back from `internal-private/`.
  - Stage-0.4 probe → both `698028a0ca04092cf65632efb410838ba2f41c96` and `809fb47a93b3ae111e2cf2059739adacca55d67d` must FAIL to fetch (`upload-pack: not our ref`) and 422 from the commits API; `forks_count` 0. **A successful fetch means the purge came undone — STOP.**
  - `git check-ignore -v .claude/settings.local.json` → must report the `.gitignore:31` rule. It names a real ancestor-system directory in its paths. Same for `examples/.turbo/turbo-test.log` (machine path).
  - `pnpm audit:deps` → no un-accepted high/critical; Security tab 0 open.
- [ ] **A5 — Re-verify good-first-issues.** #9–#18 were open and labeled `good first issue` on 2026-08-25. Stage-3 maintenance rule says re-verify "still true" at T-2 — a stale entry is a bad first impression for the exact person the label is for.
- [ ] **A6 — Post-flip anonymous verification (AC2/AC5).** Logged-out fetch of both repos: code search per scrub term returns 0, Security-policy link renders, issue forms render, good-first-issues visible. Then re-run the 0.4 probe against the now-public repo (AC6).
- [ ] **A7 — Apply the stage-8 API settings** once the repos are public (A7 is agent-runnable but **only on 🔑 O6 go-ahead**, since it acts on live public repos):
  ```bash
  gh api -X PUT repos/snugprotocol/snug/private-vulnerability-reporting
  gh api -X PUT repos/snugprotocol/spec/private-vulnerability-reporting
  ```
  plus the `main-pr-only` ruleset from runbook 4.2 against both repos. **Do NOT add a `required_status_checks` rule** — CI is `workflow_dispatch`-only (ADR-0041), so a required check that never runs would deadlock every merge including yours.
- [ ] **A8 — Update memory + retire the task** (Gate 6) once the flip holds.

---

# 🔑 What YOU need to do (owner — I cannot do these)

Ordered by when they must happen. **O1–O5 are before the flip. O6 is the flip. O7–O9 are the same hour, after.**

## Before the flip

- [ ] **O1 — Decide the README footer link** (unblocks 🤖 A1). `jeetu.tech.voyage` does not exist in DNS. Pick one:
  - **(a)** Repoint to `https://github.com/jeetumaker` — zero infrastructure, works immediately. *Recommended.*
  - **(b)** Create the DNS record in the Cloudflare dashboard, pointing at whatever should serve it. Note: **the wrangler OAuth token lacks `dns_records` scope**, so this is a dashboard act — I cannot do it from the CLI even with your account.
  - **(c)** Drop the hyperlink, keep the plain text "Jeetu Maker".
  - *Scale note: this is one `href` on a name in the footer byline, below the License section. The string `jeetu.tech.voyage` is never visible on screen. It is a two-second fix, not a launch gate.*

- [x] **O2 — ✅ DONE 2026-08-25 (both halves; one owner-side confirmation left, see end of entry).** 🚨 Updater signing-key custody. Highest stakes on this list; not strictly a flip gate, but the flip is what draws attention to the machine holding it. `~/.tauri/snug-updater.key` (`F3922E7DDE0069B6`) has **no passphrase — the file IS the secret** — and **every client that installed v0.1.0 already verifies updates against it**. There is **no escrow**. Losing it permanently orphans those clients' update path, recoverable only by every user manually downloading a new DMG. Verified still sitting in the clear on 2026-08-25:
  - `~/Desktop/snug-updater-key-backup-20260824/` → `snug-updater.key`, `snug-updater.key.pub`, `README.txt`
  - `~/Desktop/snug-csr/` → `snug-devid.key`, `devid.pem`, the `.p12` under a **throwaway** passphrase, CA certs

  **Do:** move both into a password manager or encrypted volume → re-export the `.p12` under a real passphrase → delete both Desktop folders. I am deliberately not touching these; moving or deleting key material is yours to do and yours to verify.

  **✅ HALF DONE 2026-08-25 — the Apple Developer ID half is closed.** `snug-devid-protected.p12` re-exported under a real passphrase (leaf + Apple intermediate bundled via `-certfile`), uploaded to 1Password, and imported to the login keychain with `-T /usr/bin/codesign`. **Verified by actually signing**, not by inspection: `codesign` produced a full chain (`Developer ID Application → Developer ID Certification Authority → Apple Root CA`) with **no password prompt** (ACL correct), and still did so with `~/Desktop/snug-csr/` **moved aside** — proving the keychain, not the folder, is now the signing path. `~/Desktop/snug-csr/` is therefore **redundant and safe to delete**.
  - *Gotchas hit, recorded for the next machine:* Keychain Access offered no `.p12` export because the private key was **never in the keychain** — it lived on disk and `codesign` read it from there (`dump-keychain` showed 0 key entries; that probe is unreliable on modern macOS — **sign something instead**). `openssl pkcs12 -certfile` then failed "unable to load certificates" because the `.cer` files are **DER**, not PEM (`openssl x509 -inform DER -out …pem` first). And `openssl verify` reported a bogus chain error because `AppleRootCA-G2.cer` is **not this chain's root** (the intermediate is issued by plain "Apple Root CA") — that file is a stray; `security verify-cert -p codeSign` is the check that matters and it passed.
  - **STILL OPEN — the dangerous half:** `~/Desktop/snug-updater-key-backup-20260824/` is untouched. That is the one with **no reset**: revoking and reissuing rescues the Apple cert, but a lost updater key permanently orphans every v0.1.0 install's update path. It needs no re-export — straight drag-and-drop of all three files into 1Password, then delete the folder. **Leave `~/.tauri/snug-updater.key` in place** — that is the live copy the build reads.
  - *Not proven by any of this:* notarization, which needs `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` in the build shell. Unaffected by the keychain work, and untested until `release-desktop.mjs` runs start-to-finish at v0.1.1.

  **✅ UPDATER-KEY HALF ALSO DONE 2026-08-25.** All three files moved into 1Password; `~/Desktop/snug-updater-key-backup-20260824/` deleted. Verified locally: **both** Desktop folders gone, no stray `.p12`/key/CSR files anywhere under `~/Desktop`, and the live `~/.tauri/snug-updater.key` still present at `0600`. Critically, the live public key **matches the `pubkey` baked into `apps/desktop/src-tauri/tauri.conf.json` byte-for-byte** (`F3922E7DDE0069B6`) — that is the pairing every v0.1.0 client verifies against, so the update path is intact. The old unusable 2026-08-21 `*.OLD-unusable-20260824` files are also gone (correct — the backup README said they could go once v0.1.0 shipped).
  - **🔑 OWNER CONFIRMATION STILL OWED (2 min, do it now, not at v0.1.1):** the vault copies are now the ONLY backup — the Desktop originals are deleted, so an attachment that uploaded badly is a silent, total loss. Open **both** 1Password items, **download each attachment back**, and confirm: the `.p12` opens with the stored passphrase (`openssl pkcs12 -info -in <downloaded> -noout`), and `snug-updater.key` is 348 bytes and byte-identical to `~/.tauri/snug-updater.key`. Also confirm the 1Password **Emergency Kit is stored OUTSIDE 1Password** — a no-escrow key backed into an unrecoverable account is not escrowed.

- [ ] **O3 — `security@snugprotocol.org` round-trip from an outside account.** The Cloudflare **destination-address verification click** is still pending: dashboard → snugprotocol.org → Email → Email Routing → Destination addresses → status must read *Verified*. Then send to `security@` from an outside account and confirm arrival. `SECURITY.md` publishes this address the moment the repo goes public — an unverified route means vulnerability reports land nowhere. (`hello@` you verified 2026-08-23; do it again as a belt, it is the only contact address in /terms + /privacy.)

- [ ] **O4 — Counsel items** (~30 min): trademark sanity check against the LAUNCH_OPS registration list, and the **/terms review**. The clauses are swappable paragraphs in `legal/terms.ts`, so a late edit is cheap — but it is much cheaper before publication than after. Also: TRACKER D-02 (USPTO individual applicant) needs re-confirmation now that the TechVoyage LLC fact is known.

- [ ] **O5 — Owner walk ladder.** These back the "it works" claim; no test can do them (each is either hardware-gated or untestable by construction). Full procedures in `docs/next-steps.md`:
  - Coinbase Ed25519 re-credential + Trade Copilot portfolio + TWAP smart-order (every slice must raise the confirm dialog)
  - Hue Moodboard — install starter, real rooms, first apply prompts once naming the bridge IP
  - weather + github — one live connect+render each
  - WhatsApp restart watch (PR #114) — ≥2 resync cycles, `synced regular to vN`, no new `parking after 2 attempts`
  - Telepath deep-delete on hardware + the 3 linking-sync items
  - `.snug` encryption walk on the DESKTOP shell · sample-mode on the four starters · dock-icon eyeball on a real bundle · mobile either/or on a real phone
  - **README quickstart timings re-measured on a clean machine** — the umbrella AC3 timed run has never executed, and the README makes the claim
  - *Not a flip gate: the v0.1.0→v0.1.1 update walk needs a SECOND release (its own explicit ask, ADR-0047 §13).*

## The flip

- [ ] **O6 — Say go.** Then, **`spec` first** (the snug README links to it, so flipping snug first leaves a public README pointing at a 404):
  ```bash
  gh repo edit snugprotocol/spec --visibility public --accept-visibility-change-consequences
  gh repo edit snugprotocol/snug --visibility public --accept-visibility-change-consequences
  ```
  Immediately before this: 🤖 A4 re-run, green. **This is the irreversible step** — I will not run it without an explicit go from you in the moment, and I will not infer it from this file being approved.

## Immediately after — same hour, before any announcement

- [ ] **O7 — Upload the social previews on BOTH repos.** Settings → General → Social preview → upload. Files ready: `docs/assets/social/snug-repo-preview.png` and `spec-repo-preview.png`.
  **Why this is here and not earlier:** GitHub renders that control **only on public repos** (its own doc: *"…or to a private repository to which you have previously uploaded an image"*). Both repos are private and never had one, so the control is simply **absent** — not a permissions problem (`admin: true` on both), not a UI relocation. **There is no API** ([community #172072](https://github.com/orgs/community/discussions/172072) is an open, unanswered request), which is exactly why this is 🔑 and not 🤖. Until uploaded, every shared repo link unfurls with GitHub's generic fallback card.
  While in that repo's settings: also decide whether to delete the now-unreferenced `hub-talk-build-run.png` from `../.github-org`.

- [ ] **O8 — Enable secret scanning + push protection**, both repos: Settings → Advanced Security. Public-only, and it is the one control that catches a future accidental commit — worth doing in the same sitting rather than "later".

- [ ] **O9 — Re-scrape the social caches.** The site's `og:image` fix is live and verified on the apex (deployment `571e909d`, 2026-08-25T22:28Z), but **X / LinkedIn / Facebook cache per-URL** and still serve the old imageless card until their inspectors re-fetch. Links in `docs/runbooks/social-preview.md` §2. **This is a browser act, not a deploy** — and it must happen before the announcement, or the launch post unfurls blank.

---

## Plan

**Sequence.** 🤖 A1–A3 land on a branch first (ordinary PR, `gate:local` before merge). 🔑 O1–O5 run in parallel with that — O2 and O3 are independent of everything and can start immediately. At T-2: 🤖 A4 + A5 re-run green → 🔑 O6 → then, in one sitting, 🔑 O7/O8 + 🤖 A7 → 🤖 A6 verification → 🔑 O9 → 🤖 A3 commit → 🤖 A8.

**The counter-intuitive orderings, restated because each was learned by hitting it:**
| Item | Why it cannot happen before the flip |
|---|---|
| Social previews (O7) | control absent on private repos; no API |
| Private vuln reporting (A7) | `404` while private (probed 2026-08-23) |
| Branch protection ruleset (A7) | public-only on the free plan (`403 Upgrade to GitHub Pro`, probed 2026-08-23) |
| Secret scanning (O8) | public-only |
| Feedback deep-link test | ADR-0052 links 404 by design while private |
| `.github` pre-launch paragraph (A3) | the line stays true until the moment it isn't |

**Do not, at any point:**
- Add a `required_status_checks` rule — CI is dispatch-only; it would deadlock every merge.
- Trust `pnpm test` exiting 0 as evidence — a `FULL TURBO` cached run executes nothing. Use `turbo run test --force` for any "nothing broke" claim.
- Assume `check-public-scrub` ran. It is gitignored and outside `pnpm test` by design (ADR-0057: a tool built to hide a thing must not itself publish that thing). By hand, every time.
- Run background gates by relative path — the tool shell's cwd silently resets to the parent dir between calls; a past "red" was `MODULE_NOT_FOUND` with zero checks executed.

**Known-accepted, not to be re-litigated at flip hour:** codenames remain in all 372 commits of history (ADR-0057, accepted — sanitised form, real identifiers never committed, gitleaks clean over 376 commits) · ~35 MB of `release-out/` binaries are permanently in history at `36fe45c` (not worth a rewrite pre-flip) · Actions billing stays broken through launch (owner call 2026-08-23) · R-29's TOFU half remains open (nothing published proves this Developer ID is Snug's).

## Decisions & surprises

- **2026-08-25 — the footer link is NXDOMAIN, not down.** Authoritative Cloudflare NS returns NXDOMAIN for `jeetu.tech.voyage`; the record was never created. Two sibling subdomains resolve fine, which is what made it look like a transient outage in the 2026-08-24 probe. Also corrected here: an earlier characterisation of this as "the last visible line of the front page" overstated it — the hostname is only an `href`, never rendered text.
- **2026-08-25 — two of the three footer/README link failures healed themselves.** `snugprotocol.org` and `playground.snugprotocol.org` both returned `000` on 2026-08-24 and both return `200` now; the web deploy fixed them. Only the personal byline remains dead. This is why the runbook calls it a deploy-then-verify gate rather than a doc fix.

## Session journal (append-only, newest last)

### 2026-08-25 — Claude — session
- Done: audited flip readiness against the private runbook stages 5–8; re-ran both hard gates live (`check-public-scrub` → OK; stage-0.4 probe → both SHAs fail to fetch + 422, `forks_count` 0); re-probed all four README/footer hosts; confirmed `.claude/settings.local.json` still gitignored; confirmed #9–#18 open and labeled; confirmed both Desktop key folders still present in the clear; confirmed `apps/playground` has zero OG tags; traced `jeetu.tech.voyage` to a single `README.md:116` reference and to NXDOMAIN at the authoritative NS. Wrote this task file.
- State: `main` = `d579c31`, clean, in sync with origin. Both repos still `PRIVATE`. Every technical blocker cleared; remaining work is 🔑 owner judgment/hands plus three small 🤖 doc edits.
- Next step: 🔑 O1 (footer link decision) unblocks 🤖 A1; 🔑 O2 (key custody) and O3 (security@ round-trip) can start immediately and are independent of everything else.
- Open questions: O1 (a/b/c) · whether the second-owner decision for the org resolves before or after the flip (enforced 2FA + one owner = a lost device is an unrecoverable org) · whether CI staying `workflow_dispatch`-only is the posture you want on a public repo, given outside PRs will then be gated only by you running `gate:local` on the fetched branch.
