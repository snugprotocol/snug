# TASK-20260825-social-preview-og: Social preview — 2 repo uploads + the relative-`og:image` bug

- **Status**: in-review (implementation complete, suites green; awaiting review + the 🔑 uploads)
- **Owner**: Jeetu
- **Risk tier**: **low** (see [engineering/PROCESS.md](../../engineering/PROCESS.md#risk-tiers)) — `apps/website` only: marketing/docs meta tags and committed image assets. No protocol/runner/auth/C1/C2/npm/CI surface is touched, so no auto-escalation applies. It ships to a **live public site**, which is a care-level, not a tier-level, concern.
- **Branch**: `fix/TASK-20260825-social-preview-og`
- **Packages touched**: `apps/website` (only). No dependents — nothing imports the website (dependency direction is one-way: website → playground source, read-only).
- **Spec impact**: none (no `packages/protocol` schema touched → no [SPEC_SYNC](../../engineering/SPEC_SYNC.md) step, no spec-changelog entry).
- **Related**: flip checklist item 6 (social-preview images on both repos) · ADR-0048 (single static site; single-homed URLs in `site.ts`) · ADR-0054 + [deploy-web.md](../../runbooks/deploy-web.md) (this ships only via a deploy, which is its own explicit ask) · lessons 2026-08-23 (*a claim about rendered output cannot be proven by grepping source*), 2026-08-23 (*two-layered guard: source-scan + framework-wiring pin*), 2026-08-22 (*a delivered image's container dimensions are not its content's dimensions*)

## Spec (what & why)

Two related pieces of the launch's social surface, one bug and one asset chore.

**The bug (live in production right now).** [`MarketingLayout.astro:28`](../../../apps/website/src/layouts/MarketingLayout.astro#L28) declares `og:image` as a **root-relative** path, `/videos/poster-landscape.jpg`. The Open Graph spec requires an absolute URL, and every real scraper (X, Slack, LinkedIn, Facebook, iMessage, Discord) enforces it — a relative value is dropped, not resolved. Verified live on 2026-08-25: `curl https://snugprotocol.org/` returns 200 and serves `content="/videos/poster-landscape.jpg"`, so **every share of the landing page and `/download` previews with no image today**, in the window immediately before a HN launch. `astro.config.mjs` already sets `site: 'https://snugprotocol.org'`, so `Astro.site` is the correct, single-homed base — no new URL spelling is introduced (ADR-0048 §1).

Three adjacent gaps in the same `<head>` are in scope because they are the same defect class — meta a scraper needs and does not get — and fixing them separately would mean a second deploy of the same file:
- **no `twitter:card`** → X renders the small summary card, not the large image, even once `og:image` resolves;
- **no `og:url`** and **no `og:site_name`** → no canonical identity on the card;
- **no `og:image:width`/`height`/`alt`** → scrapers that pre-allocate layout may defer or crop, and the card is unlabelled for screen readers.

**The `/docs` shell emits no OG tags at all.** Starlight's stock `<head>` carries none of the above, so every docs page and every rendered spec page — the implementor-facing half of the launch audience (ADR-0048 context) — previews bare. Fixed with a `Head.astro` component override, the same seam already used for `HeaderSocialIcons.astro`.

**The 2 uploads.** Flip-checklist item 6 wants a social-preview image on `snugprotocol/snug` and on `snugprotocol/spec`. GitHub's repo social preview is **dashboard-only** (Settings → General → Social preview; no REST/GraphQL field exposes it), so the uploads themselves are 🔑 owner acts. This task delivers what makes them a two-minute job: two committed 1280×640 PNGs built from the site's own brand tokens, plus the exact click-path documented in a runbook.

**Acceptance criteria** (each becomes at least one test):
1. **Every built marketing page carries an absolute `og:image`.** Asserted over `dist/**/*.html`, not source: the value parses as a URL with an `https:` protocol and the `snugprotocol.org` host. A relative value fails.
2. **The referenced image actually ships.** The `og:image` URL's pathname resolves to a file present in `dist/` — a correct-looking absolute URL pointing at a 404 is the same broken card.
3. **Every built marketing page carries `twitter:card=summary_large_image`, `og:url` (absolute, matching the page's own route), `og:site_name`, `og:image:width`, `og:image:height`, and a non-empty `og:image:alt`.**
4. **Every built `/docs/**` page carries the same absolute `og:image` + `twitter:card`** — the Starlight half, asserted over the built docs output.
5. **The framework wiring is pinned**: `astro.config.mjs` still registers the `Head` component override, and `site:` is still set. (Lessons 2026-08-23 — a source-scan test alone silently reverts when someone deletes the override; the built-output assertions in AC1/AC4 cover the rendered half, this covers the wiring whose removal would blank them.)
6. **Both social-preview PNGs exist, are exactly 1280×640, and are under 1 MB** — dimensions probed from the file, not assumed from the filename (lessons 2026-08-22).
7. **The runbook documents both uploads** — a `docs/runbooks/social-preview.md` section naming each repo, the file to upload, the dashboard path, and how to verify the card afterwards.

**Out of scope**:
- **Performing the two uploads** — dashboard-only, 🔑 owner. This task hands over ready files + steps.
- **Deploying the fix.** The website is live, but a deploy is its own explicit ask under ADR-0054/PROCESS release rules. The fix sits in `main` until the owner asks; the runbook notes that the card is still broken in production until then.
- **Re-scraping caches.** X/LinkedIn/Facebook cache aggressively; forcing a re-scrape is a post-deploy owner step, noted in the runbook, not automated here.
- **A per-page bespoke OG image** (e.g. generated cards per docs page). One brand image sitewide; revisit if it ever matters.
- **The playground app's `<head>`** (`apps/playground`) — a separate surface with its own shell; noted for next-steps if it also lacks OG.
- Any change to the poster/teaser video assets themselves.

## Plan

Tests FIRST per [TDD.md](../../engineering/TDD.md) — one per acceptance criterion, each shown failing for the right reason before implementation.

**Test seam.** The precedent is `apps/website/src/__tests__/buildOutput.test.ts`, which asserts against the real built `dist/`. That is the correct seam here: lessons 2026-08-23 twice record that a claim about rendered output cannot be proven by grepping source (Starlight and remark inject markup no source grep sees). Turbo runs `build` before `test` (`turbo.json`: test dependsOn build), so `dist/` exists in any root run; the new file follows `buildOutput.test.ts` in giving a NAMED failure when it does not.

**Order of work:**

1. **`apps/website/src/__tests__/socialMeta.test.ts` (new) — RED first.**
   Walks `dist/**/*.html`, partitions into marketing pages (`index.html`, `download/index.html`) and docs pages (`docs/**`), and asserts AC1–AC4. Parses each `og:*`/`twitter:*` meta with one regex helper; AC1's absolute-URL check is `new URL(value)` + protocol/host assertion (a relative value throws → fail with a clear message). AC2 maps the URL's pathname back onto `dist/` and checks `existsSync`. Expected initial failure: marketing pages fail AC1 on the relative value; docs pages fail AC4 with no tags at all.

2. **`apps/website/src/__tests__/socialAssets.test.ts` (new) — RED first.**
   AC6: both PNGs exist, are ≤1 MB, and are exactly 1280×640 — dimensions read from the **PNG IHDR header bytes** (width/height are big-endian uint32 at offsets 16 and 20), so the assertion is on real pixel content, not a filename or a container assumption (lessons 2026-08-22). Also AC5's wiring pins: read `astro.config.mjs` and assert both `site:` and the `Head:` component registration are present. Expected initial failure: files absent, override unregistered.

3. **`apps/website/src/layouts/MarketingLayout.astro` — GREEN for AC1–AC3.**
   Replace the four hand-rolled meta lines with a shared component (below). Absolute URLs built with `new URL(path, Astro.site)`; `og:url` from `new URL(Astro.url.pathname, Astro.site)`.

4. **`apps/website/src/components/SocialMeta.astro` (new) — the single home.**
   One component emitting the full set, taking `title`/`description` as props, reading the image path + alt from one module-level constant pair. Both shells import it, so the tag set is spelled **once** — the same single-homing doctrine `site.ts` applies to URLs (ADR-0048 §1). It reads `Astro.site` rather than restating the domain.

5. **`apps/website/src/components/Head.astro` (new) + `astro.config.mjs` registration — GREEN for AC4/AC5.**
   Starlight `Head` override following the `HeaderSocialIcons.astro` precedent: render Starlight's stock `<Default />` head, then append `<SocialMeta />` with the page's own title/description from Starlight's route data. Registered alongside the existing `SocialIcons` entry in `astro.config.mjs`.

6. **The two 1280×640 PNGs — GREEN for AC6.**
   `docs/assets/social/snug-repo-preview.png` and `spec-repo-preview.png`, generated from the site's own brand tokens (the `--ember` accent, the `snug.` wordmark and the rounded-square mark already inline in `MarketingLayout.astro`) so the cards match the site rather than inventing a second brand. Generated by a committed script (`scripts/` sibling style) writing SVG → PNG, so the images are reproducible rather than hand-made binaries with no source. 1280×640 is GitHub's documented recommendation (displayed at 1280×640, safe area centred).
   *Note:* these are the **repo** previews. The website's `og:image` continues to use the existing 1920×1080 poster — a real, on-brand image that already ships; swapping the site's card art is a design call, not this bug's fix, and AC3's width/height pin the poster's true dimensions.

7. **`docs/runbooks/social-preview.md` (new) — AC7.**
   Both uploads (repo → Settings → General → Social preview → upload the named file), the post-deploy verification (X Card Validator / LinkedIn Post Inspector / a real Slack paste), the re-scrape note, and the standing caveat that **the site's own card stays broken in production until the website is deployed** (ADR-0054 ask).

8. **Doc drift in-branch (Gate 6 rides this branch):** add the runbook to any runbook index; drop the flip-checklist item-6 line to "images generated + runbook written; 2 uploads remain 🔑".

**Cross-package impact: none.** Per the dependency graph in [architecture.md](../../architecture.md#dependency-graph-who-depends-on-whom--whose-tests-also-run), `apps/website` is a leaf — it *consumes* playground source read-only and nothing consumes it. No dependents' suites are pulled in by the graph rule.

**Test commands (Gate 5):** `pnpm --filter website test` during the loop; root `pnpm test` before review — and per the 2026-08-25 verification standard, **`turbo run test --force`** for any "nothing broke" claim, since a `FULL TURBO` cached run executes nothing. Website changes also touch the `check-website-sync` gate's neighbourhood; root run covers it. Known load flakes (`@snugprotocol/db` crypto, `packages/knowledge` brute-force recovery) are pre-existing — confirm against clean `main` before calling one a regression.

**Not run automatically:** `node scripts/check-public-scrub.mjs` by hand before any flip/release (ADR-0057) — this task adds new committed files and a new runbook, which is exactly the surface that gate reads.

## Decisions & surprises

- **No ADR.** Nothing architectural is decided here: the absolute-URL fix is a bug fix against the OG spec, and `SocialMeta.astro` applies ADR-0048's existing single-homing doctrine rather than establishing a new one. If the docs-shell `Head` override turns out to fight Starlight's own head ordering, that becomes an ADR-worthy call and this line changes.
- **Correction to stored memory:** `snug-current-state` says "Website + playground deploy — nothing deployed". That is **stale** — `docs/architecture.md` records both live since 2026-08-24, and `snugprotocol.org` was probed 200 this session. It is why this bug is a live-production defect rather than a pre-launch tidy. To be fixed at Gate 6. (No stale claim of this kind exists in the repo's own docs — checked.)

- **The plan's AC4 premise was WRONG, and the built output corrected it.** The plan said the docs shell "emits no OG tags at all", read off the *source* (`MarketingLayout.astro:28` is the only `og:`-emitting line in the repo). The built `dist/` says otherwise: Starlight generates `og:title`, `og:type`, `og:url`, `og:locale`, `og:description`, `og:site_name` **and** `twitter:card=summary_large_image` from a data array in `utils/head.ts`. The one tag it never emits is **`og:image`** — so the docs pages were advertising a large-image card pointing at nothing, a sharper defect than "bare". This directly changed the implementation: a `Head.astro` emitting the full set would have shipped **duplicate** meta on 22 pages. The override adds the image tags only. *This is the 2026-08-23 lesson landing again — a claim about rendered output cannot be proven by grepping source — and it caught a plan I had written after reading that very lesson.*

- **The two shells emit different markup for the same tag** (`<meta ...>` from Astro pages, `<meta .../>` from Starlight), so the test's matcher had to handle both. A source-shaped matcher would have half-passed silently.

- **Mutation-tested the guards rather than trusting green.** Three deliberate regressions, each reverted: (1) making `OG_IMAGE.path` relative **passed** — correctly, because `new URL(path, Astro.site)` normalises it, so the output stays right; that is the implementation being robust, not the test being weak. (2) Bypassing `new URL` in the component — the original bug exactly — **failed all 4 marketing pages**, quoting the bad value. (3) Deleting the `Head` registration **failed all 22 Starlight pages**. Both halves of the two-layered guard are proven to bite.

- **`qlmanage` is not a renderer.** The first generator used it; it printed "produced one thumbnail", wrote nothing, and exited non-zero — a success message that is not evidence a file exists. Switched to `rsvg-convert` → `inkscape` → `magick`, and the script re-reads each PNG's IHDR bytes so a converter that lies about geometry fails the run.

## Session journal (append-only, newest last)

### 2026-08-25 — Jeetu + Claude — session (Gates 1–2)

- **Done**: Gate 1 spec + Gate 2 plan written; branch `fix/TASK-20260825-social-preview-og` cut off `main` @ `84c7d5c`. Read PROCESS/TDD/architecture (dependency graph)/lessons + ADR-0048, the website layout, its test suite, the Starlight override precedent, and the live served bytes.
- **Evidence gathered**: `curl https://snugprotocol.org/` → 200, serving `og:image="/videos/poster-landscape.jpg"` (relative → dropped by every scraper). `poster-landscape.jpg` probed at 1920×1080. `astro.config.mjs` already sets `site:`. Only one `og:`-emitting file exists sitewide; `/docs` emits none.
- **Scope pinned with owner (3 questions)**: widen the head beyond the one-line fix (og:url, twitter:card, site_name, image dims, alt); generate both preview images + runbook rather than runbook-only; include the Starlight docs shell.
- **State**: awaiting plan approval — **no implementation code written** (Gate 2 stop).
- **Next step**: on approval, write the two test files RED first (AC1–AC6), then implement in the order above.
- **Open questions**: none blocking. One deferred design call noted in step 6 — whether the site's own card art should eventually be a purpose-made 1200×630 rather than the 16:9 video poster (out of scope here; poster is real and on-brand).

### 2026-08-25 — Jeetu + Claude — session (Gates 3–5)

- **Gate 3 (RED first)**: both test files written and shown failing for the right reasons before any implementation. `socialMeta.test.ts` failed quoting the live defect (`og:image "/videos/poster-landscape.jpg" is not absolute`); `socialAssets.test.ts` failed on absent images + unregistered override. The 288-failure count was parametrized breadth (26 pages × ~11 assertions), not spurious. Validated the `og:url` route-matching logic against real data before implementing: 22 Starlight pages passed it, exactly the 4 marketing pages failed — so the assertion was correct rather than merely permissive.
- **Gate 4 (implement)**: `config/socialImage.ts` (image facts, single-homed) → `components/SocialMeta.astro` (full set, marketing) → `MarketingLayout.astro` (4 hand-rolled tags replaced with the component) → `components/Head.astro` + `astro.config.mjs` registration (image tags only, docs) → `scripts/build-social-previews.mjs` → both PNGs → `docs/runbooks/social-preview.md`.
- **Scope was 4 marketing pages, not 2.** `/privacy` and `/terms` also use `MarketingLayout`, so the one-file fix reached all four; `404.html` turned out to be Starlight-generated, so the override covers it too. 26 pages, both shells, no page left out.
- **Gate 5 (verify)**:
  - `pnpm --filter website test` → **469/469, 8 files** (includes `tsc --noEmit`).
  - Root `turbo run test --force` → **25/25 tasks, 0 cached** — genuinely executed, per the 2026-08-25 verification standard. No load flakes surfaced this run.
  - `node scripts/check-public-scrub.mjs` (by hand, ADR-0057 — nothing automates it, and this task adds new committed files) → **OK**.
  - Duplicate-tag sweep over all 26 built pages → **zero duplicates**, which was the live risk in the Starlight half.
  - Both PNGs **looked at**, not just measured — on-brand, legible, consistent.
- **State**: implementation complete on `fix/TASK-20260825-social-preview-og`, all suites green, nothing committed yet.
- **Next step**: owner review of the diff + task file. Then the two 🔑 uploads (§1 of the runbook) and, separately, a 🔑 deploy — until the site is redeployed the card stays broken in production, since the fix ships as HTML.
- **Open questions**: none blocking. The deferred card-art call from Gate 2 still stands (16:9 poster vs a purpose-made 1200×630); unchanged by this work.
