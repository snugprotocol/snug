# Runbook — social preview cards (repo uploads + the site's own card)

**What this covers:** the image people see when a Snug link is pasted into X, Slack, LinkedIn, iMessage or Discord. Two independent surfaces, often confused:

| Surface | Who serves it | How it is set |
|---|---|---|
| **GitHub repo cards** — `github.com/snugprotocol/{snug,spec}` | GitHub | 🔑 hand-uploaded PNG, dashboard only |
| **Website cards** — `snugprotocol.org` and every `/docs` page | our own HTML | `og:` meta tags, shipped by a deploy |

**Release rule (PROCESS.md):** steps marked 🔑 are an explicit human ask in that session.

---

## 1. 🔑 The two repo uploads — **only after the repo is public**

> **Precondition, learned the hard way (2026-08-25).** The **Social preview** section does not render at all on a private repository that has never had an image. GitHub's own doc carries the condition in a subordinate clause: *"You can upload an image to a public repository, **or to a private repository to which you have previously uploaded an image**."* Neither `snug` nor `spec` has ever had one, so there is nothing to scroll to — this is not a permissions problem (both were checked at `admin: true`) and not a UI relocation.
>
> **So these uploads belong immediately after stage 7 of the flip, and before any announcement.** In the window between going public and uploading, a shared repo link unfurls with GitHub's auto-generated fallback card (avatar + repo name, served from `opengraph.githubassets.com`). That degrades the card to generic branding rather than blanking it — but it is also cached per URL by every platform that sees it first.

GitHub exposes a repository's social preview **only through the dashboard** — no REST or GraphQL field writes it, and `gh` has no command for it ([community #172072](https://github.com/orgs/community/discussions/172072) is an open request for exactly that endpoint). This is a hand act by design, not an automation gap.

The images are already generated and committed:

| Repo | File |
|---|---|
| `snugprotocol/snug` | `docs/assets/social/snug-repo-preview.png` |
| `snugprotocol/spec` | `docs/assets/social/spec-repo-preview.png` |

For each repo:

1. Open **Settings → General** (the repo's own settings, not the org's).
2. Scroll to **Social preview**.
3. **Edit → Upload an image…** and pick the file above.
4. Confirm the thumbnail redraws in place.

Both are 1280×640 — GitHub's documented size, pinned by `socialAssets.test.ts` so a re-render cannot silently drift.

**Verify by LOOKING, not by reading the URL** (and only once the repo is public). GitHub proxies repo cards through `opengraph.githubassets.com`, and an uploaded image and a generated one can present the same way in the markup — so the tag's value is weak evidence that an upload landed. Fetch the image the tag points at and check it is the ember banner rather than the avatar-and-repo-name fallback, or paste the repo link into a private Slack channel and look at the unfurl.

```sh
curl -s https://github.com/snugprotocol/snug | grep -o '<meta property="og:image"[^>]*>'
```

Note `curl` may receive different markup than a browser does; treat a surprising result as a reason to check in a browser, not as a finding.

---

## 1b. The org profile banner

A third image, on a different surface and with a different mechanism: `snugprotocol/.github` → `profile/README.md` renders `profile/org-profile-banner.png` (1280×520) at the top of [github.com/snugprotocol](https://github.com/snugprotocol). It is a **committed file in a public repo**, not a dashboard upload — updating it is a normal commit, and it takes effect immediately.

It carries the org's positioning line over both repo messages side by side, so the org front door says what each repo *is* before a visitor clicks into either. It replaced a hub screenshot (`hub-talk-build-run.png`, now unreferenced in that repo) — a screenshot shows the UI, and the org page is read by people who do not yet know what Snug is.

```sh
cp docs/assets/social/org-profile-banner.png <path-to>/.github/profile/
# then commit + push in that repo; verify:
curl -sI https://raw.githubusercontent.com/snugprotocol/.github/main/profile/org-profile-banner.png | head -1
```

### Regenerating all three

```sh
node scripts/build-social-previews.mjs
```

Writes both repo cards (1280×640) and the org banner (1280×520). Reads the brand colours out of `apps/playground/src/theme/tokens.css` (so nothing can drift from the site's palette), writes the `.svg` sources beside the `.png` outputs, and re-reads each PNG's IHDR bytes to prove the geometry rather than trusting the converter. Needs `rsvg-convert`, `inkscape`, or `imagemagick`; it names the missing dependency and stops rather than writing a wrong-sized file.

**Then look at what it produced.** SVG text neither wraps nor shrinks to fit, so an edit that lengthens a line renders it straight off the canvas — the geometry check, the size check and every byte-level assertion still pass, because the canvas is the right size and the overflow is simply ink outside it. Open each PNG, and view the banner at the **800px** width the README actually displays it at.

**Re-upload the two repo cards by hand afterwards** — regenerating does not touch GitHub. The org banner needs a commit to `snugprotocol/.github`.

---

## 2. The website's own cards

Shipped in the HTML by [`src/components/SocialMeta.astro`](../../apps/website/src/components/SocialMeta.astro) (marketing pages) and [`src/components/Head.astro`](../../apps/website/src/components/Head.astro) (the Starlight docs hub, which generates every OG tag *except* `og:image`). The image itself and its real dimensions are single-homed in [`src/config/socialImage.ts`](../../apps/website/src/config/socialImage.ts).

> **The card is DRAWN, not captured (TASK-20260827).** It was the landing teaser's poster frame — a real still, but a still *of the Playground hub*, so the card kept showing the product's old `talk. build. run.` hero long after the site stopped saying it. **A card whose picture contradicts its own title is worse than a plain one**, and because social caches are keyed per URL and sticky, a stale image outlives the fix by weeks. It is now generated by `scripts/build-social-previews.mjs` (`ogCardSvg` → `apps/website/public/social/site-og-card.png`, 1200×630, OG's documented size) carrying the positioning itself, so it cannot go stale behind a UI change. Regenerate with the other three; unlike them it **ships with a website deploy** rather than being uploaded by hand. Its `og:image:alt` describes the words ON the card — that string was missed by the first positioning pass and is now pinned by `positioning.test.ts`.

**These only reach the public after a deploy** — 🔑, its own ask, see [deploy-web.md](deploy-web.md).

> **History worth keeping:** until 2026-08-25 `og:image` was the root-relative `/videos/poster-landscape.jpg`, and shipped that way to production. Open Graph requires an absolute URL and every real scraper **drops** a relative one rather than resolving it, so every share of the site previewed with no image. If a card ever goes blank again, check absoluteness first.

### Verify after a deploy

```sh
curl -s https://snugprotocol.org/ | grep -o '<meta property="og:image"[^>]*>'
curl -s https://snugprotocol.org/docs/spec/ | grep -o '<meta property="og:image"[^>]*>'
```

Both must print an **`https://snugprotocol.org/…`** URL. A leading `/` is the bug above.

Then confirm the image is actually reachable — a well-formed URL pointing at a 404 is the same blank card:

```sh
curl -sI https://snugprotocol.org/videos/poster-landscape.jpg | head -1   # expect 200
```

Then look at a real card:

- **X** — [Card Validator](https://cards-dev.twitter.com/validator)
- **LinkedIn** — [Post Inspector](https://www.linkedin.com/post-inspector/)
- **Facebook** — [Sharing Debugger](https://developers.facebook.com/tools/debug/)
- **Slack / iMessage** — paste the link into a private channel or a note to self

### Re-scraping after a fix

Every platform caches aggressively, and the cache is keyed per URL — a fixed card will keep showing the broken version until it is re-scraped:

- **LinkedIn** and **Facebook** re-scrape from their inspector's own button.
- **X** re-fetches on its own schedule; the validator's fetch usually refreshes it.
- **Slack** caches per workspace with no purge; appending `?v=2` for a test paste renders the current tags.

Do this **before the HN window**, not during it.

## What the tests already guarantee

`apps/website/src/__tests__/socialMeta.test.ts` asserts over the **built `dist/`**, not source (Starlight injects markup no source grep sees), for all 26 pages: `og:image` is absolute, on our origin, and resolves to a file that ships; `twitter:card=summary_large_image`; `og:url` matches the page's own route; the declared dimensions match the file's real pixels.

`socialAssets.test.ts` pins the framework wiring — `site:` in `astro.config.mjs` and the `Head` override registration — because deleting the override is a one-line edit that silently blanks 22 docs pages while every source-level check stays green.

**Not covered by any test:** whether the uploads in §1 were actually done. That is this runbook's job.
