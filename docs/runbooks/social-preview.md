# Runbook — social preview cards (repo uploads + the site's own card)

**What this covers:** the image people see when a Snug link is pasted into X, Slack, LinkedIn, iMessage or Discord. Two independent surfaces, often confused:

| Surface | Who serves it | How it is set |
|---|---|---|
| **GitHub repo cards** — `github.com/snugprotocol/{snug,spec}` | GitHub | 🔑 hand-uploaded PNG, dashboard only |
| **Website cards** — `snugprotocol.org` and every `/docs` page | our own HTML | `og:` meta tags, shipped by a deploy |

**Release rule (PROCESS.md):** steps marked 🔑 are an explicit human ask in that session.

---

## 1. 🔑 The two repo uploads

GitHub exposes a repository's social preview **only through the dashboard** — no REST or GraphQL field writes it, and `gh` has no command for it. This is a hand act by design, not an automation gap.

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

**Verify** (a private repo previews only for signed-in members — a full check needs the repo public):

```sh
curl -s https://github.com/snugprotocol/snug | grep -o '<meta property="og:image"[^>]*>'
```

The value should be an `opengraph.githubassets.com/…` URL, **not** the default avatar-derived card.

### Regenerating them

```sh
node scripts/build-social-previews.mjs
```

Reads the brand colours out of `apps/playground/src/theme/tokens.css` (so the cards cannot drift from the site's palette), writes the `.svg` sources beside the `.png` outputs, and re-reads each PNG's IHDR bytes to prove the geometry rather than trusting the converter. Needs `rsvg-convert`, `inkscape`, or `imagemagick`; it names the missing dependency and stops rather than writing a wrong-sized file. **Re-upload by hand afterwards — regenerating does not touch GitHub.**

---

## 2. The website's own cards

Shipped in the HTML by [`src/components/SocialMeta.astro`](../../apps/website/src/components/SocialMeta.astro) (marketing pages) and [`src/components/Head.astro`](../../apps/website/src/components/Head.astro) (the Starlight docs hub, which generates every OG tag *except* `og:image`). The image itself and its real dimensions are single-homed in [`src/config/socialImage.ts`](../../apps/website/src/config/socialImage.ts).

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
