# TASK-20260826-website-architecture-page: public architecture page + mobile nav disclosure

- **Status**: **done** — PR #145 squash-merged `e8463be`; deployed to production 2026-08-26T07:06Z
- **Owner**: Jeetu
- **Risk tier**: **low** (marketing pages + website styling — PROCESS.md risk table row 1). No
  `packages/protocol`, `packages/runner`, `packages/auth`, C1/C2, npm-publish or CI/release surface
  is touched, so nothing auto-escalates. Website `src/__tests__/` is vitest-only (no e2e lane), and
  the nav change edits a file three other page types inherit — so the tier is low but the blast
  radius is "every marketing page", which the test plan reflects.
- **Branch**: `feat/TASK-20260826-website-architecture-page`
- **Packages touched**: `apps/website` only (pages, layout, components, styles, tests, package.json).
  Read-only consumption of `@playground/theme/tokens.css` via the existing alias — never the reverse
  (ADR-0047 §2 dependency direction; ADR-0048 §5).
- **Spec impact**: **none.** No `packages/protocol` schema, no envelope, no userdb surface. SPEC_SYNC
  is not engaged and `docs/spec-changelog.md` gets no entry. The page *describes* wire v1 in prose
  and diagrams; it derives nothing mechanically, so `docs-sync.json` gains no source (see Plan §6).
- **Related**: ADR-0048 (website + docs hub), ADR-0047 §2 (dependency direction),
  lessons 2026-08-23 (breakpoint bands; cascade fights), lessons 2026-08-18 (icon-for-label breaks
  locators; emoji is not an icon), lessons 2026-08-24 (C4 guard machinery must keep naming its
  target), `docs/threat-model.md` §6 (the residuals the page quotes)

## Spec (what & why)

**Why.** The website explains *what* Snug is (`Differentiators.astro` states the three pillars in
prose) but never shows *how it works*. The repository's strongest public argument — that an app is a
body driven by a host agent over a frozen wire protocol, and that the user's data lives in one file
they hold — is currently only legible to someone who reads the whitepaper or the spec. A public
launch (Show HN and similar) needs one URL that carries that argument visually, in under a minute,
to a technical reader who arrived skeptical.

**What.** A new marketing page at `/architecture/` presenting six hand-authored inline-SVG figures
plus supporting prose, styled entirely from the existing token system so it is indistinguishable
from the rest of the site. It gains a nav slot. Separately — and independently — the marketing
header's mobile behaviour is fixed: today every non-CTA nav link is `display:none` below 560px with
no replacement, so Docs, Spec and Playground are simply unreachable on a phone.

The six figures (content already drafted and fact-checked against the repo this session):
1. Codegen's severed link vs. Snug's live runtime bridge (`app-message`/`app-response`)
2. The envelope as a frozen socket; interchangeable provider adapters below it
3. Serverless yet connected: `connect-src 'none'`, the host executor, credential injection + scrub
4. Ledger vs. the aggregator model — where the consolidated financial picture is assembled
5. Private mode: app, host, local model and `user.snug` inside one machine boundary
6. What the user carries: the `.snug` file and what it moves across

**Audience note.** The page is written for a cold, skeptical public reader, not a demo audience. It
therefore carries an honest-limits section ("What this doesn't do") quoting five residuals that are
already public in `docs/threat-model.md` §6. This is a deliberate credibility trade, owner-approved
2026-08-26: naming the Windows/WebView2 sandbox break ourselves — and stating that it is *why* no
Windows build ships — is the page's strongest signal to exactly the audience most inclined to
assume a privacy pitch oversells.

**Acceptance criteria** (each becomes at least one test):

1. **AC1 — the page ships.** `dist/architecture/index.html` exists after a build (extends the
   existing `buildOutput.test.ts` surface list).
2. **AC2 — it is reachable from the nav.** The marketing header links to `/architecture/`, and every
   marketing page inherits that link.
3. **AC3 — no orphan nav entries.** Every internal `href` in the marketing header resolves to a page
   that was actually built into `dist/` (generalises the docs-side guarantee of `navIntegrity.test.ts`
   to the marketing header, which has never had this check).
4. **AC4 — mobile keeps every nav destination.** At mobile widths no nav destination is hidden
   without a replacement: the set of links reachable inside the disclosure equals the set of links
   in the desktop nav. Asserted structurally (the disclosure contains the same hrefs), not by
   screenshot.
5. **AC5 — the disclosure is keyboard- and AT-reachable without JS.** It is a native
   `<details>/<summary>` with an accessible name; the page ships no client script for it.
   (Directly serves lessons 2026-08-18: the control keeps a real accessible name, not a bare glyph.)
6. **AC6 — one breakpoint literal, one home.** The width at which the nav swaps to the disclosure is
   stated exactly once in the stylesheet, and the desktop row and the disclosure are never both
   visible at any width (no band shows two navs, none shows zero). Test asserts the pair of rules
   is complementary — the 2026-08-23 "band between breakpoints" lesson, applied at authoring time.
7. **AC7 — the page uses the design system, not a second one.** No hard-coded hex colour and no
   external font/asset host in the new page or the layout diff; colours resolve through
   `tokens.css` custom properties. (Also keeps the site's zero-third-party-request property, which
   the privacy page asserts in prose.)
8. **AC8 — the limits section is present and complete.** The page contains the five named residuals;
   a test pins their presence so a later copy edit cannot quietly delete the honest half.
9. **AC9 — Differentiators links onward.** The landing page's three-pillar section links to
   `/architecture/`.
10. **AC10 (revised 2026-08-26) — the page advertises a working social card.** `/architecture/`
    emits an ABSOLUTE `og:image` whose file exists in `dist/`, inheriting the site-wide card like
    every other page. **No per-page image is added** — see the correction note below.
11. **AC11 — WITHDRAWN at Gate 6, not implemented.** The criterion was wrong. See the Gate-6
    journal entry: `next-steps.md` (2026-08-24) records an explicit owner decision that this
    dependency **stays**, and the premise behind AC11 ("nothing imports it") misread what the
    declaration is for. Astro 7 itself declares and imports `cookie@2` (`parseCookie`); the
    explicit entry in `apps/website/package.json` is a **shim against a hoisted stray shadowing
    it** on another machine or a CI runner — exactly the failure recorded in `lessons.md`. It was
    removed mid-session and RESTORED before commit; no test asserts on it.

**Out of scope**:
- Any change to `packages/protocol`, `packages/runner`, `packages/auth`, or any C1/C2 surface.
- The Starlight docs header (`/docs/*`): Starlight ships its own responsive nav and owns that shell.
  This task changes `MarketingLayout.astro` only. The two shells stay separate by design (ADR-0048).
- A JS overlay/slide-in mobile menu with focus trap and scroll lock. Owner chose the CSS-only
  `<details>` disclosure (2026-08-26). If a real-device walk finds it thin, that is a follow-up.
- Rewriting `Differentiators.astro`'s copy — AC9 adds one link, nothing else.
- Adding the page as a *derived* source in `docs-sync.json` (see Plan §6 for why).
- A lint rule forbidding unused dependencies generally (AC11 removes one dependency; it does not
  install a guard).
- Deploying. `scripts/deploy-web.mjs` is NOT run: PROCESS.md release rules require an explicit human
  ask in the session that deploys, and this task's ask was to build the page.

## Plan

### 0. Order of work (tests first — TDD.md)

Gate 3 writes every test below RED before any implementation. Two of them (AC1, AC10) depend on
`dist/`, and `turbo.json` already runs `build` before `test`, so they fail *named* rather than
mysteriously on a bare vitest run — matching the existing `buildOutput.test.ts` convention.

### 1. Files to touch

| # | File | Change |
|---|---|---|
| 1 | `apps/website/src/__tests__/marketingNav.test.ts` | **new** — AC2, AC3, AC4, AC5, AC6 |
| 2 | `apps/website/src/__tests__/architecturePage.test.ts` | **new** — AC7, AC8, AC9 |
| 3 | `apps/website/src/__tests__/buildOutput.test.ts` | extend surface list — AC1 |
| 4 | `apps/website/src/__tests__/socialAssets.test.ts` / `socialMeta.test.ts` | extend — AC10 |
| 5 | `apps/website/src/layouts/MarketingLayout.astro` | nav slot + `<details>` disclosure + styles |
| 6 | `apps/website/src/pages/architecture.astro` | **new** — the page |
| 7 | `apps/website/src/components/ArchitectureFigures.astro` | **new** — the six figures |
| 8 | `apps/website/src/styles/site.css` | shared figure/prose classes if reused; else scoped |
| 9 | `apps/website/src/components/Differentiators.astro` | one onward link — AC9 |
| 10 | *(none — AC10 needs no new file; the shared `SocialMeta.astro` already covers it)* | AC10 |
| 11 | ~~`apps/website/package.json`~~ | **withdrawn** — `cookie` stays (owner decision, next-steps 2026-08-24) |

### 2. The nav change (owner-decided 2026-08-26)

Desktop row becomes **Architecture · Docs · Spec · Playground · GitHub**. The **Download button is
removed from the header** — the owner's call, and it is safe on the landing page, which retains
three download entry points (`index.astro` hero + closer, `AudienceSplit.astro`) plus the footer.

*Stated risk, owner's call to accept:* on `/docs/*`, `/privacy/`, `/terms/` and the new page, the
header Download was the only download affordance above the footer. Mitigation inside this task: the
architecture page carries its own prominent download CTA in its closing section (it is the intended
HN landing URL, so this is where it matters most). The legal pages keep the footer link only.

`nav-cta`'s bespoke specificity block in `MarketingLayout.astro` exists solely because
`.nav-links > a` (0,1,1) outweighed the global `.btn-primary` (0,1,0). Removing the header CTA
removes that fight; the comment explaining it goes with it, so a future reader does not inherit a
rule guarding a button that no longer exists.

### 3. The mobile disclosure (AC4–AC6)

Replace the `@media (max-width: 560px) { display:none }` amputation with a real disclosure:

- `<details class="nav-mobile">` + `<summary>` (accessible name "Menu", not a bare glyph —
  lessons 2026-08-18); the ☰ is a geometric inline SVG in `currentColor`, never an emoji
  (lessons 2026-08-18: an emoji ignores `currentColor` and cannot be themed).
- One breakpoint custom property is the single home of the literal; the desktop row and the
  disclosure are governed by complementary `min-width`/`max-width` rules so no band shows both or
  neither (AC6 — lessons 2026-08-23).
- Responsive rules are **co-located with the base rules** in the same `<style>` block, deliberately
  avoiding the exact cascade trap of lessons 2026-08-23 (an earlier media rule losing to a later
  base rule, invisible until geometry is measured).
- Zero JS: `<details>` gives disclosure, keyboard operation and AT semantics natively, and every
  link is a real page load so the panel cannot be left stale open.
- Chosen breakpoint: **860px**, not 560px. Six items plus the wordmark do not fit a 768px iPad
  portrait or an ~850px phone-in-landscape — the precise band lessons 2026-08-23 says nobody's
  suite lives in. Tests assert behaviour at 375 / 768 / 850 / 1280 by evaluating the rule pair.

### 4. The page itself (AC7)

`architecture.astro` uses `MarketingLayout`. All six figures are hand-authored inline SVG
(`role="img"` + `aria-label` carrying the same claim as the visible caption), sized by `viewBox`,
scaled by CSS, wrapped in `overflow-x:auto` so no figure ever scrolls the page body sideways.

**Restyle from the artifact, not a paste.** The drafted artifact is light-first cream with Google
Fonts; this site is dark-committed warm charcoal on system stacks. Every colour becomes a token
(`--surface`, `--border`, `--ember`, `--fg-muted`, `--danger`, `--ok`), every face becomes
`--font-display` / `--font-ui` / `--font-mono`. **No `<link>` to any font host** — the site's
zero-third-party-request property is what makes the privacy page's "no analytics script" claim
verifiable in the built output, and I verified this session that `dist/` currently reaches only
`snugprotocol.org`, `github.com`, `json-schema.org` and the playground subdomain. AC7 pins it.

SVG strokes/text use `currentColor` or token values so the figures inherit theme correctly — the
marketing shell is dark-committed today, but the tokens carry a full light theme and the figures
must not be the thing that breaks if that ever changes.

### 5. Content accuracy (already verified this session)

Every factual claim in the page was checked against the repo before drafting, and the plan preserves
those exact framings:
- ~1.26 KB/turn runtime contract; 13 frames / 7 kinds / wire v1 — `packages/protocol/src/constants.ts`,
  `schemas/`, `docs/architecture.md`.
- SimpleFIN is **an aggregator/bridge, not a direct bank pipe** — `examples/ledger/connection.json`
  pins `beta-bridge.simplefin.org`, `basic_auth`. Figure 4 states this explicitly and claims only
  "no intermediary that **accumulates**". This is the single most likely HN objection and the page
  concedes it before it is raised.
- The five limits are quoted from `docs/threat-model.md` §6 (R-5 Windows/WebView2, R-14 class
  unrecoverable-secrets, the deliberately-unbuilt auth broker, pre-1.0 packages) plus the honest
  statement that the **model does see app data** — only the *credential* is protected.
- Anti-positioning (`docs/product-vision.md`): the page never invites comparison to Claude
  Artifacts / Bolt / v0. The Mint-class comparison in Figure 4 is about **data custody**, not app
  building, and names no company in the diagram itself.

### 6. Cross-cutting checks

- **C4 (private strategy stays private).** Every claim on the page traces to a public in-repo source
  (README, `docs/architecture.md`, `docs/threat-model.md`, `docs/product-vision.md`, the spec).
  Nothing derives from the private tree. `navIntegrity.test.ts`'s existing C4 scan already walks
  `src/` and will cover the new files automatically — and per lessons 2026-08-24 that guard's own
  machinery is left untouched.
- **`docs-sync.json`.** Deliberately NOT extended. `check-website-sync.mjs` tracks pages *derived*
  from in-repo sources so a source edit cannot silently strand them. This page is authored prose
  about a frozen v1 protocol, not a projection of a source file; adding it would claim a mechanical
  relationship that does not exist and go red on unrelated edits. Recorded here because a reviewer
  will reasonably ask.
- **Whitepaper checker / spec fixtures**: untouched (no protocol constant is restated in a form the
  checker reads).

### 7. Test plan (tests FIRST)

| AC | Test | Kind |
|---|---|---|
| 1 | `buildOutput.test.ts` — `architecture/index.html` in the shipped surface list | dist |
| 2 | `marketingNav.test.ts` — layout source contains an `/architecture/` link | source |
| 3 | `marketingNav.test.ts` — every internal header href has a built `dist/**/index.html` | dist |
| 4 | `marketingNav.test.ts` — desktop href set === disclosure href set | source |
| 5 | `marketingNav.test.ts` — `<details>`+`<summary>`, accessible name present, no `<script>` | source |
| 6 | `marketingNav.test.ts` — breakpoint literal appears once; rules are complementary at 375/768/850/1280 | source |
| 7 | `architecturePage.test.ts` — no `#hex`, no external font/asset host in page+layout | source |
| 8 | `architecturePage.test.ts` — five limit headings present | source |
| 9 | `architecturePage.test.ts` — `Differentiators.astro` links to `/architecture/` | source |
| 10 | `socialMeta.test.ts` — `/architecture/` added to the MARKETING page list (absolute og:image, file exists) | dist |
| ~~11~~ | *(withdrawn — no test; the dependency stays)* | — |

Plus a **negative test** for AC4, the regression this task exists to prevent: a nav destination that
is hidden at mobile width with no disclosure entry fails. This is the shape of the current bug, so
it must go red against today's `MarketingLayout.astro` before the fix lands.

**Suites to run (Gate 5).** `pnpm --filter website test` (build runs first via turbo) plus root
`pnpm test` before review — `apps/website` has no dependents in the graph, but the root gate is what
catches doc drift and the website-sync gate.

### 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Removing the header Download reduces download reach on non-landing pages | Owner-decided; architecture page carries its own CTA; footer retains the link everywhere |
| A 560→860px breakpoint move changes existing tablet rendering | Rules asserted complementary at four widths incl. the two "between" bands (lessons 2026-08-23) |
| Six hand-authored SVGs are a lot of geometry to get right | Coordinate/overflow/overlap validation was already run on the drafted figures this session; re-run after the token restyle |
| Page copy drifts from the threat model later | AC8 pins the five limits; threat-model wording is quoted, not paraphrased |
| ~~Dropping `cookie`~~ | **Withdrawn at Gate 6** — the risk row itself had the fact backwards. `cookie@2` IS Astro's own dep, and the local declaration exists to win resolution against a hoisted stray; a green build on THIS machine (whose stray tree was deleted 2026-08-24) proves nothing about others. |

## Decisions & surprises

- **2026-08-26 — the mobile nav bug is an amputation, not an omission.**
  `MarketingLayout.astro` `@media (max-width:560px)` sets `display:none` on every nav link except
  the CTA and the GitHub icon, with nothing in its place: Docs, Spec and Playground are unreachable
  on a phone today. Worth an explicit note because the fix is "add a disclosure", not "restore a
  hidden thing".
- **2026-08-26 — owner chose to drop the header Download rather than the GitHub icon** when the
  new nav slot made the row six wide. Verified no test pins the header CTA and the landing page
  keeps three other download paths; the residual gap on docs/legal pages is stated in Plan §2.
- **2026-08-26 — owner chose the CSS-only `<details>` disclosure** over a JS overlay, keeping the
  marketing shell zero-JS.
- **2026-08-26 — the website runs no analytics (verified, not assumed).** Checked four ways before
  the page claims it: no analytics dependency in `package.json`; no third-party `<script>`/`<iframe>`
  in `src/`; the built `dist/` reaches only `snugprotocol.org`, `github.com`, `json-schema.org` and
  `playground.snugprotocol.org` across all 26 HTML files; and the only `fetch(` in the JS bundles is
  Astro's own low-priority link prefetcher. `cookie` appears in `package.json` with **no importer**
  — dropped under AC11. NOT verifiable from the repo: edge/host analytics (Cloudflare/Netlify/Vercel
  dashboard toggles) — owner to confirm before deploy, since the page asserts no telemetry.
- **2026-08-26 — "no telemetry, ever" was narrowed to "no telemetry"** in the drafted copy. A
  forward-looking promise on a pre-1.0 project is the one claim here that could age into a broken
  one; the present-tense fact carries the same weight and is verifiable in the build.

## Session journal (append-only, newest last)

### 2026-08-26 06:31 UTC — Jeetu (with Claude) — session

- Done: Gate 1 spec + Gate 2 plan written. Read `PROCESS.md`, `TEMPLATE.md`, `architecture.md`,
  `lessons.md` (nav/mobile/cascade/icon entries), `MarketingLayout.astro`, `site.css`,
  `tokens.css`, `site.ts`, all eight website test files, `check-website-sync.mjs`,
  `astro.config.mjs`, `Differentiators.astro`, `index.astro`. Located the mobile bug exactly
  (`MarketingLayout.astro` `@media (max-width:560px)`). Verified the analytics question end-to-end
  against the built `dist/`. Six figures drafted and fact-checked against the repo in the preceding
  session (artifact form), including the SimpleFIN correction.
- State: **plan awaiting owner approval — Gate 2 stop. No implementation code written, no branch
  created yet.**
- Next step: on approval — create `feat/TASK-20260826-website-architecture-page` off `main`, then
  Gate 3 (write all tests RED, incl. the AC4 negative test that must fail against today's layout).
- Open questions: none — all three answered at approval (see the 2026-08-26 approval entry).

### 2026-08-26 — Jeetu — approval

- **Plan APPROVED.** Owner answers to the three open questions:
  1. **Nav label is "How it works"** (not "Architecture"). The route stays `/architecture/` — a
     durable, linkable URL — while the visible label speaks to a general public audience. Tests
     assert the label and the href separately so neither silently becomes the other.
  2. **OG preview generated via the existing `scripts/build-social-previews.mjs`**, not supplied
     artwork — keeps one generator for every social card.
  3. **Edge/host analytics verified clean by the owner.** The page's no-telemetry claim now rests
     on a repo check (done this session) AND an owner check of the hosting dashboard.
- **CORRECTION to answer 2, found while writing the tests.** The premise of the question was wrong:
  `scripts/build-social-previews.mjs` generates **GitHub repo previews** (1280×640 → `docs/assets/`
  `social/`, uploaded BY HAND to each repo's settings — `docs/runbooks/social-preview.md`), and
  `apps/website/src/config/socialImage.ts` says in its header that those are deliberately NOT the
  website's card. The website serves ONE shared `OG_IMAGE` (the teaser poster frame) to every page
  through `SocialMeta.astro`. Generating a per-page card would mean adding an `image` prop to a
  component every page uses PLUS a new output size to the script — real work, not "use the existing
  script". Re-asked; **owner chose: inherit the shared card and drop the per-page image.** AC10 is
  revised to what the existing component already guarantees, and `/architecture/` is added to
  `socialMeta.test.ts`'s marketing list so the guarantee is asserted for the new page too.
- Next step: Gate 3 — all tests RED, including the AC4 negative test against today's layout.

### 2026-08-26 — Jeetu (with Claude) — session (Gates 3–5)

- **Gate 3 (tests first) — done.** 30 tests written RED against the pre-change tree; the AC4
  regression failed with the exact diagnosis "no mobile disclosure in the header". Two tests passed
  from the start and were checked to be legitimately (not vacuously wrong) green: AC3 had no
  `/architecture/` to resolve yet, and the layout genuinely had no third-party host.
- **Gate 4 (implement) — done.** Nav slot ("How it works" → `/architecture/`), header Download
  removed per the owner's call, `<details>` disclosure carrying all six destinations, breakpoint
  moved 560px → **860px** as a single-homed custom property with a complementary
  `min-width:860px` / `max-width:859.98px` pair. New page + figures component, both token-only.
  `Differentiators` links onward. `cookie` dropped.
- **Gate 5 (verify) — done.** `pnpm --filter website test` → **521/521 green**; root `pnpm test`
  → **exit 0, zero failures** across the monorepo. Build: 27 pages (was 26).
- **Verified in a real browser (Playwright against the built `dist/`)**, because rendered pixels are
  the only verification that means anything for a visual change:
  - Nav at 375 / 560 / 768 / 850 / **859 / 860** / 1024 / 1280 px: exactly one nav at every width,
    **zero horizontal scroll everywhere** (the standing tripwire).
  - The disclosure opens on click AND on keyboard Enter, shows a visible focus ring, Tab moves into
    the panel, first stop is "How it works", and the sheet stays inside the viewport at 390px.
  - Landing page re-checked at 375/768/1280 — the hamburger fix is site-wide, onward link renders.
  - Six figures re-validated for bounds / text overflow / same-baseline overlap in the RENDERED
    HTML after the token restyle: clean.
  - Built `dist/` still reaches only snugprotocol.org, github.com, json-schema.org and the
    playground subdomain — the new page adds no third-party host (AC7).

#### Decisions & surprises from this session

- **A pre-existing hard-coded colour surfaced under AC7.** `.local-banner` carried the literal
  `#1d1207` — byte-identical to `--ember-ink`'s dark value. Fixed by using the token (a rename, not
  a recolour; it now also follows the light theme instead of staying dark ink on a light banner)
  rather than narrowing the assertion to only the new files.
- **The guard tripped on its own explanatory comment.** The first version of that fix quoted the
  hex literal in a code comment, and AC7's file-wide grep caught it — a small live instance of
  lessons 2026-08-24 (a guard's own machinery names the forbidden thing). Reworded the comment; the
  rule stayed strict.
- **NEW BUG CLASS FOUND, then guarded: Astro trims the newline between running text and an inline
  tag on the next line.** `…the app itself has\n<em>no network…` rendered as **"hasno network"**.
  Three shipped into the first build (`hasno`, `bytheir`, `passphraseand`) and were invisible in
  source review — only the rendered text showed them. Fixed with the `<code\n>` / `<em\n>`
  line-break-inside-the-tag form, and added a permanent test
  (`rendered prose — no lost spaces at inline-tag boundaries`) that scans the BUILT html of all five
  marketing pages. Scoped to text-level inline tags; `<a>`/`<span>` are excluded because adjacent
  nav/footer links are separate flex items whose lack of whitespace is correct. **Candidate for
  `lessons.md` at Gate 6.**
- **Mobile menu polished after looking at it.** First render had a translucent panel (headline
  glyphs read through the items) and loose spacing that pushed six items down the screen. Now
  `--surface-2` opaque, `--border-strong`, tighter gap/padding, `--text-s`.
- **A stale `dist/` masked a real failure once.** Turbo cached the build, so the new prose test ran
  against old HTML and failed after the source was already fixed. Rebuild before trusting a
  dist-reading test — the same class `navIntegrity.test.ts` already guards with its mtime check.

#### Not done (deliberate)

- **Not deployed.** `scripts/deploy-web.mjs` was NOT run — PROCESS.md requires an explicit human ask
  in the deploying session.
- **Not committed yet** — awaiting owner review of the rendered page.
- Gate 6 (`/close-session`) still to run: lessons entry for the Astro inline-tag trimming, doc
  drift check, then commit.

### 2026-08-26 07:00 UTC — Jeetu (with Claude) — close-session (Gate 6)

- **Owner verified the rendered page.** Gates 3–5 stand as journalled above.
- **Docs drift fixed in-branch:** `code-map.md` (the website row now names `/architecture/`, both new
  source files, and the corrected suite counts 469→520 / 26→27 pages) and `next-steps.md` (two dated
  entries: the page + nav fix with its open follow-ups, and the `cookie` re-confirmation).
- **No ADR.** Nothing decided here rises to one: the nav-slot and disclosure-style calls are
  owner preferences recorded in this file, and ADR-0048 already owns the website's shape. No
  protocol change ⇒ **no spec-changelog entry, no spec-sync** (`packages/protocol` untouched).
- **Lessons: two, both written as rules.**
  1. The Astro inline-tag whitespace entry was **updated rather than duplicated** — it already
     existed (2026-08-24) and I hit it anyway, three times in one page. The compounding finding is
     that a prose rule could not hold the line and it is now a **test** over built html; the entry
     says so and records the two scoping traps (`<a>`/`<span>` exclusions).
  2. New entry: **`display:none` at a breakpoint with nothing in its place is an amputation**, no
     test in the repo could see it, and the cheap durable guard is asserting desktop-href-set ==
     disclosure-href-set — written as a negative first so it fails against the pre-fix layout.
- **AC11 WITHDRAWN — the criterion was wrong, and I had already implemented it before catching it.**
  I removed `cookie` from `apps/website/package.json`, then found `next-steps.md` (2026-08-24)
  recording an explicit owner decision that it **stays**, with the reason: Astro 7 imports
  `parseCookie` from `cookie@2`, and the local declaration is a shim that wins Node resolution
  against a hoisted stray. **Reverted before commit** (package.json restored, `pnpm-lock.yaml` back
  to unmodified, the AC11 test deleted, the plan's AC/table/risk rows marked withdrawn). The trap
  worth naming: the local build is green **either way** on this machine, because the stray tree that
  caused the original failure was deleted on 2026-08-24 — so "it builds" was never evidence.
  My Gate-2 plan asserted "verified no importer in `src/`" and treated that as sufficient; it was
  the wrong question. **Read `next-steps.md` for the artefact you intend to delete, not just the
  code around it.**
- **State:** branch `feat/TASK-20260826-website-architecture-page`, all work committed. Website
  suite **520 green**; root `pnpm test` **exit 0**. Site builds 27 pages.
- **Next step:** open PR → merge → deploy production (all three explicitly asked for this session).
- **Open questions:** none.

### 2026-08-26 07:06 UTC — Jeetu (with Claude) — merge + production deploy

- **PR #145 opened, CI green, squash-merged to `main` as `e8463be`** (branch deleted). Both required
  checks passed before merge — `workspace` and `desktop-shell (macos-latest)` — waited out rather
  than merged past (state went `BLOCKED` → `CLEAN`; `BLOCKED` was checks-in-progress, not a policy
  refusal: `main` carries no branch protection object, and the required contexts come from ADR-0058's
  ruleset).
- **DEPLOYED to production — website only.** Owner's explicit ask in this session (PROCESS.md
  release rules).
  - **What:** `node scripts/deploy-web.mjs website --deploy` from a clean tree on `main == origin/main`
    @ `e8463be`. Dry pass run FIRST and read (pre-flight, hosted-posture, Pages limits) before adding
    `--deploy`.
  - **When:** 2026-08-26 **07:06 UTC**.
  - **Result:** 15 files uploaded (70 already present, 85 total), 27 pages. Deployment
    `c07910a2.snug-website-c7z.pages.dev`.
  - **The playground was NOT deployed** — it needs no change here and a deploy is its own ask.
- **Verified LIVE on the apex domain, not the pages.dev URL** (a pages.dev check would not prove the
  custom domain serves it):
  - `https://snugprotocol.org/architecture/` → **200**, 52,250 bytes.
  - Nav link present on the landing page in BOTH the desktop row and the mobile disclosure, plus the
    `Differentiators` onward link — found by SHAPE (`<a[^>]*href="/architecture/"[^>]*>`), because a
    naive `href="/architecture/">` grep returns nothing against Astro's injected `class` attribute.
    That false negative is `lessons.md`'s 2026-08-24 entry; it fired again here and the shape search
    is what answered it.
  - External hosts on the live page: **only** github.com, snugprotocol.org, playground.snugprotocol.org.
  - **ADR-0013 posture re-confirmed post-deploy: 0 `cdn-cgi` hits.**
  - "What this doesn't do" section present in the served html.
  - **Real browser against production** at 375/768/850/**860**/1280px: exactly one nav at every width,
    **zero horizontal scroll everywhere**, all 6 figures rendered.
- **State:** shipped, merged, live, verified. Nothing outstanding for this task.
- **Next step:** none — task complete; the follow-ups it leaves behind (OG card for this URL, optional
  JS overlay menu) are recorded in `next-steps.md`, not here.
- **Open questions:** none.

