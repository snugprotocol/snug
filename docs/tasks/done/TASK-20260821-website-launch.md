# TASK-20260821-website-launch: Marketing website + docs/spec hub (apps/website)

- **Status**: in-review (implementation complete, local E2E ready for owner test)
- **Owner**: jeetu (Claude drafting)
- **Risk tier**: **Medium** — public-facing positioning + root test wiring; touches no protocol/runner/auth code. Escalation triggers absent. Test-first applies.
- **Branch**: `feat/TASK-20260821-website-launch`
- **Packages touched**: new `apps/website` (workspace member via `apps/*` glob); root `package.json` (one check script); `scripts/` (sync checker); `.claude/commands/` (sync command); `docs/` (ADR-0048, code-map, next-steps)
- **Spec impact**: none (site *consumes* `docs/spec-drafts/` + `packages/protocol/schemas/`; C3 untouched, `snugprotocol/spec` untouched)
- **Related**: ADR-0005 (playground stays Vite SPA), ADR-0013 (static hosting doctrine), ADR-0047 (desktop distribution; `releaseChannel.ts` single home), C4 (pre-launch strategy stays private), ADR-0048 (drafted by this task), lesson 2026-08-07 (derived documents: diff sets & modality)

## Spec (what & why)

Build the public face of Snug: `apps/website` — one static Astro + Starlight site serving the marketing landing page, the developer docs & specification hub (modelcontextprotocol.io-class), and the desktop download page. The playground remains its own app on its own subdomain, linked from the site. The landing page targets an HN-grade technical audience: it must convey the three differentiators (runtime agent bridge / user-owned `.snug` file / embeddable + secure by construction) inside 10 seconds, show the teaser video (landscape on desktop, portrait on mobile), and route users to the playground and — with priority — the desktop app (private, more capable: Hue, WhatsApp). The docs hub is a curated developer hub aimed at implementors (hub clients, SaaS embedders): Get Started, core concepts, the rendered spec (v0.3 draft) + schema reference, and the whitepaper. A sync mechanism keeps hub pages honest against their sources: a hash manifest + root-test checker + a `/sync-website` Claude command + a persistent memory reminder.

**Interview decisions (owner, 2026-08-21):**
1. Stack: **Astro + Starlight**, one app, one build.
2. Domains: **snugprotocol.org** (site) / **playground.snugprotocol.org** (playground), static deploy on Cloudflare Pages. All URLs single-homed in one config module.
3. Download links: **real GitHub Releases URLs** (via `releaseChannel.ts`) — live the moment the repo flips public; honest Gatekeeper copy per ADR-0047 §7.
4. Docs scope: **curated developer hub** (purpose-written guides + rendered spec + whitepaper); maintainer-facing process docs stay out.

**Acceptance criteria** (each becomes at least one test; AC9–AC10 are verification steps, not suites):
1. **AC1 — Site builds statically.** `pnpm --filter website build` produces `dist/` containing `/index.html`, `/docs/`, `/download/`, the spec pages, and the whitepaper PDF. (Build-output test walks the dist tree.)
2. **AC2 — Responsive teaser.** The landing page embeds both video renditions; a pure `pickTeaserSource(viewport)` function chooses portrait for portrait/narrow viewports and landscape otherwise (unit-tested); videos are muted/autoplay/loop/playsinline with posters, and each encoded file is **≤ 20 MB** (Cloudflare Pages per-file limit is 25 MB — asserted by test).
3. **AC3 — Single-homed URLs.** Every cross-surface link (playground, GitHub, download) resolves through `src/config/site.ts`; the download page's URLs are **identity-equal** to the playground's `releaseChannel.ts` exports (seam-identity assert, lessons 2026-08-13) — no second spelling of any release URL exists in the website source (greppable test).
4. **AC4 — Docs hub structure.** `/docs` serves: Get Started (developer quickstart), Core Concepts, implementor guides (build a hub client / embed in a SaaS), rendered spec v0.3 draft (split per Part, plus a schema reference page listing all 14 frame schemas), and the whitepaper page (PDF + abstract). A nav-integrity test asserts every sidebar entry resolves to a built page.
5. **AC5 — Sync manifest + checker.** `apps/website/docs-sync.json` maps each derived website page → its source files (spec draft, schemas, whitepaper PDF, product-vision) with content hashes. `scripts/check-website-sync.mjs` (wired into root `pnpm test`) exits non-zero naming the drifted pages when any source hash changes, and fails loudly on a missing source or a manifest entry referencing the private strategy tree (C4 guard). Mutation-tested: touch a source → red; restore → green.
6. **AC6 — Claude sync command.** `.claude/commands/sync-website.md` exists: reads the checker's drift report, updates the affected pages from their sources, re-hashes the manifest. (Presence + referenced-paths-exist test.)
7. **AC7 — Memory reminder.** Auto-memory gains `website-docs-sync.md` (+ MEMORY.md line): whenever docs/spec/whitepaper edits land, run the sync check / command. (Manual — memory dir is outside repo.)
8. **AC8 — C4 / leak safety.** Website content references nothing under the private strategy tree; the existing repo-wide leak scan passes over the new tree. (Checker guard from AC5 + existing scan.)
9. **AC9 — Rendered verification (lesson: run the product).** Landing page, docs hub, and download page screenshotted in a real browser at desktop and mobile widths — video plays, nav works, dark/light both legible — before Gate 5.
10. **AC10 — Derived-document honesty (lesson 2026-08-07).** Spec-derived pages are rendered from the source verbatim (no paraphrase of normative text); hand-written concept pages carry a "normative source" link and no MUST-class claims absent from the spec. (Spot-check during review; spec pages are generated, which is the structural guard.)
11. **AC11 — GitHub is linked (approval addendum).** Header nav and footer link the GitHub org (`github.com/snugprotocol` — the surface that shows both `snug` and `spec` repos); the URL lives in site config like every other link (covered by AC3's test).
12. **AC12 — Local E2E mode (approval addendum).** `PUBLIC_SITE_MODE=local` (a `dev:local` script) switches the playground links to `http://localhost:5173` and the download link to a locally staged DMG at `/local-artifacts/Snug.dmg`; `apps/website/scripts/stage-local-desktop.mjs` copies the newest built DMG from `apps/desktop`'s target tree into `public/local-artifacts/` (gitignored). Default mode stays production URLs (AC3's identity test pins that). Unit test: mode switch resolves the local URLs; prod default resolves releaseChannel/production URLs.

**Out of scope**: deploying anywhere (Cloudflare/DNS setup is a separate explicit ask per release rules); any change to `apps/playground`, `apps/server`, `apps/desktop`, or any package; email-capture/analytics backends (site stays zero-backend, ADR-0013 spirit); Windows/Linux download surfaces (macOS-only per ADR-0021 D8); rendering the whitepaper as HTML (PDF + abstract page at v1); i18n.

## Plan

### Design decisions (→ ADR-0048, drafted with this plan)

- **D1 — One static site for everything but the playground.** Marketing, docs, spec, whitepaper, download all in `apps/website` at the apex domain; playground alone stays a subdomain. Simplest deploy story (one Pages project + the existing playground), one nav, docs share the marketing shell's brand.
- **D2 — Astro + Starlight.** Astro pages for landing/download (full creative control, zero-JS-by-default islands); Starlight for `/docs` (sidebar, search, dark mode, mobile nav for free). React is available as an island framework but the landing page prefers vanilla + CSS.
- **D3 — Spec pages are *generated*, concept pages are *authored*.** A build-time loader (`sync-spec.mjs`, run by the sync command and committed as output) splits `docs/spec-drafts/SPEC-v0.3-draft.md` into per-Part pages and generates the schema reference from `packages/protocol/schemas/*.json`. In-repo sources only — the `../spec` clone is downstream (C3) and absent in deploy contexts.
- **D4 — Sync is hash-manifest + checker + command, not a file-watcher.** Repo doctrine is "memory is git": the checker rides `pnpm test` (the same seat as `check-whitepaper`), so drift is caught at the gate every session; the Claude command performs the update; the memory file reminds the humans. No CI dependency (CI is billing-blocked).
- **D5 — Release URLs stay single-homed.** Website imports `releaseChannel.ts` constants from the playground source via a vite alias (same direction as desktop→playground, ADR-0047 §2; the module is dependency-free constants — verified). If the alias fights Astro's build, fallback is the repo's established byte-compare pattern; either way no third spelling.
- **D6 — Videos ship transcoded, not raw.** `ffmpeg` (present) encodes both `.mov` (48 s, H.264 1080p) to web-optimized MP4 (`crf` tuned to land ≤ 20 MB, `faststart`, AAC audio retained — teaser has music; page autoplays muted with an unmute affordance) plus poster JPEGs, into `apps/website/public/videos/`. Originals stay outside the repo.

### Landing page concept (creative direction — details flex during implementation)

Dark, editorial, protocol-grade aesthetic (reference: MCP site's restraint + more personality). Sections, in order:
1. **Hero** — "MCP connects agents to tools. **Snug connects agents to apps.**" One sentence under it (apps that think through the host's agent; data in one file you own), two CTAs (*Download for macOS* primary, *Try the Playground* secondary), teaser video as the hero visual (responsive rendition pick).
2. **The wire, live** — an animated envelope exchange: an app frame ↔ host agent postMessage sequence typed out as real protocol JSON (from the actual schemas), showing "the app is a body, the agent is its mind" mechanically, not metaphorically.
3. **Three differentiators** — runtime agent bridge / one portable `.snug` file / embeddable + secure by construction (C1/C2 stated plainly: tokens never enter the iframe, never reach the LLM).
4. **For users** — playground vs desktop split: desktop is private-by-construction and unlocks device-class apps (Hue, WhatsApp); playground is the zero-install taste.
5. **For implementors** — "raise the bar" pitch: spec + schemas + reference implementation + whitepaper; code-snippet teaser of the SDK; CTA into /docs Get Started.
6. **Footer** — spec, GitHub, security contact, license.

### Files to touch (order)

1. `apps/website/public/videos/` — ffmpeg transcode of both teasers + posters (**first**, so real sizes inform AC2's test).
2. `apps/website/` scaffold — `package.json` (build/test/lint scripts matching turbo tasks), `astro.config.mjs` (Starlight integration, `@playground` alias), `tsconfig.json`.
3. `apps/website/src/config/site.ts` — all URLs (apex, playground subdomain, GitHub org/repo, security contact).
4. **Tests first** (Medium tier): `apps/website/src/__tests__/` — `pickTeaserSource.test.ts`, `siteLinks.test.ts` (config integrity + releaseChannel identity), `buildOutput.test.mjs` (AC1/AC2 sizes — runs post-build), `navIntegrity.test.mjs` (AC4); `scripts/check-website-sync.test.mjs` (AC5, incl. mutation cases + C4 guard).
5. Landing page — `src/pages/index.astro` + `src/components/` (Hero, TeaserVideo w/ `pickTeaserSource`, WireDemo, Differentiators, AudienceSplit, Footer) + global CSS (design tokens, light/dark).
6. `src/pages/download.astro` — macOS download (releaseChannel URLs, Gatekeeper honesty, releases-page link, "why desktop" pitch).
7. Docs hub — `src/content/docs/`: `index.mdx` (hub landing), `get-started/` (quickstart: run the playground locally, install a starter, build an app; implementor quickstart), `concepts/` (envelopes & frames, the user file, connections & credential custody, runtime contracts — each linking its normative source), `build/` (hub client guide, SaaS embedding guide), `spec/` (generated), `whitepaper.mdx` (+ PDF copied into `public/`).
8. `apps/website/scripts/sync-spec.mjs` — the spec/schema page generator; `apps/website/docs-sync.json` — the manifest.
9. `scripts/check-website-sync.mjs` + root `package.json` wiring (append to the `test` chain beside `check-whitepaper`).
10. `.claude/commands/sync-website.md`.
11. Memory: `~/.claude/projects/-Users-jeetu-SnugProtocol/memory/website-docs-sync.md` + MEMORY.md line.
12. Docs: ADR-0048 (already drafted), `docs/code-map.md` (+ apps/website row), `docs/next-steps.md` (deploy + DNS as a queued explicit-ask item), architecture.md one-line component mention.

### Cross-package impact

None at runtime. Website *reads* `apps/playground/src/desktop/releaseChannel.ts` (constants-only module, dependency direction mirrors desktop→playground precedent), `docs/spec-drafts/`, `packages/protocol/schemas/`, `docs/whitepaper/dist/`. No package gains a dependent whose tests must newly run; turbo picks the new app up via `apps/*`.

### Test plan (tests FIRST)

Written in step 4 before any page exists; red until the implementation lands:
- `pickTeaserSource`: portrait viewport → portrait asset; landscape → landscape; square/undefined → landscape default.
- `siteLinks`: every nav/CTA href ∈ site config; download URLs `toBe` releaseChannel exports; no `github.com/snugprotocol/snug/releases` literal outside the config seam (grep test — one contract, one home).
- `check-website-sync`: green on fresh manifest; **mutation checks** — edit a source → names the derived page, exit 1; delete a source → loud failure (not silent pass); manifest entry under the private strategy tree → refused. (Restore mutations by inverse edit, never `git checkout` — lesson 2026-08-21.)
- Build-output walk: required routes exist in `dist/`; each video ≤ 20 MB; PDF present.
- Nav integrity: parse Starlight sidebar config → every entry has a built page.
- **AC9 browser pass** (agent-browser screenshots, desktop + 390px mobile) before Gate 5 — lessons: only the rendered pixel verifies a UI claim.

### Spec-sync impact

None. No `packages/protocol` change; nothing pushed to `snugprotocol/spec`. The website renders the *draft* spec clearly labeled as v0.3 draft / 1.0 RC.

### Gate 5 plan

Fresh-context adversarial review (Medium tier) + the AC9 rendered pass. Reviewer briefed to verify mechanism claims against code (lesson 2026-08-20): the alias import actually builds, the checker actually fails on drift, the videos actually picked per viewport.

## Decisions & surprises

- Videos on disk are `.mov` H.264 1080p, 48 s, 32/38 MB — transcode required (D6).
- `releaseChannel.ts` verified dependency-free (constants only) → alias import is viable (D5 mechanism check done at plan time).
- Playground already ships its own `/download` view (in-app); the website's `/download` is the public marketing surface — both draw URLs from the same `releaseChannel.ts`, so no drift class exists.

## Session journal (append-only, newest last)

### 2026-08-21 — claude — session
- Done: Gate 1 (task file + 4-question interview, all recommendations accepted); Gate 2 reading (architecture, lessons in full, product-vision, ADR-0047, spec README/v0.3 headings, whitepaper README, releaseChannel.ts, workspace/turbo config); plan written; ADR-0048 drafted; branch cut.
- State: awaiting plan approval — no implementation code written.
- Next step: on approval → step 1 (video transcode) then tests-first scaffold.
- Open questions: none blocking.

### 2026-08-21 (evening) — claude — session
- Done: plan approved + two scope addenda (AC11 GitHub org link, AC12 local E2E mode). Full implementation:
  videos transcoded (4.4/4.2 MB mp4 + posters); apps/website scaffolded (Astro 5.18 + Starlight 0.35);
  tests FIRST (29 vitest + 7 node:test); landing page (hero + responsive teaser + wire demo with real
  frame JSON + differentiators + audience split + implementor pitch), /download (releaseChannel identity),
  docs hub (12 authored pages + 10 generated spec pages/assets from the v0.3 draft + 14 schemas + whitepaper
  PDF); sync doctrine live (docs-sync.json manifest, root `check-website-sync` gate wired into `pnpm test`,
  `.claude/commands/sync-website.md`, auto-memory reminder written); AC9 browser pass (desktop 1440px +
  mobile 390px + docs light theme, screenshots reviewed — caught and fixed a nav-CTA specificity wash-out);
  live mutation check of the REAL gate (red naming 4 pages → restored green); wiki updated (ADR-0048
  accepted + indexed, code-map row, architecture dependency-graph line, next-steps deploy item, README row).
- Fixes worth remembering: nanoid/non-secure ESM-interop crash in Astro SSR → `vite.ssr.noExternal: ['nanoid']`;
  stale astro content cache made `draft === false` filter drop every entry (clear node_modules/.astro when
  content.config.ts changes); `.nav-links > a` (0,1,1) silently outweighed `.btn-primary` (0,1,0);
  stage-local-desktop must skip create-dmg's `rw.*.dmg` intermediates; the sync tests caught quickstart
  hardcoding the playground URL (fixed by making it .mdx importing site config) and the C4 grep flagging
  its own needle (scoped to shipped content).
- Verification: forced root run `turbo run test --force` — 25/25 tasks, 0 cached, exit 0; all root checkers
  green incl. the new gate; local E2E verified live (PUBLIC_SITE_MODE=local: banner, localhost:5173 links,
  staged real DMG at /local-artifacts/Snug.dmg — 7.9 MB aarch64 build found in the desktop target tree).
- State: complete on branch, NOT merged. Deployment deliberately out of scope (next-steps item).
- Next step: owner local E2E walk (instructions in the session summary), then Gate 5 review + PR.
- Open questions: none.

### 2026-08-21 (close) — claude — session close
- Done: everything above committed as `60f84bf` (67 files); Gate 6 pass — two lessons appended
  (stale content-layer cache × schema-default filter; newest-by-mtime picks build intermediates),
  wiki drift was already fixed in the main commit (architecture, code-map, next-steps, README row,
  ADR-0048 + index), no `packages/protocol` change so no spec-changelog entry.
- State: branch `feat/TASK-20260821-website-launch` at the close commit; working tree clean;
  local E2E ready (`dev:local` + staged DMG verified live this session).
- Next step (single): owner walks the local E2E flow — `pnpm --filter playground dev` +
  `pnpm --filter website dev:local`, click through landing → playground → /download → save the DMG.
  Then Gate 5 (fresh-context review) + PR on an explicit ask.
- Open questions: none.
