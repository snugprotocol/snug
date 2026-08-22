# TASK-20260821-site-playground-polish: Website + Playground polish sweep (8 owner-reported items)

- **Status**: planned
- **Owner**: jeetu
- **Risk tier**: medium (Playground logic + vault UI; website legs are Low; no protocol/runner/auth code touched — Gmail dual-mode explicitly split out to keep this task out of High)
- **Branch**: `fix/TASK-20260821-site-playground-polish`
- **Packages touched**: `apps/website`, `apps/playground`, root `package.json` + `scripts/`
- **Spec impact**: none
- **Related**: ADR-0045 (starter update channel), ADR-0047 (desktop distribution; badge→/download link), ADR-0048 (website; website→playground dependency direction), `docs/next-steps.md` new queue item (Gmail dual-mode follow-up)

## Spec (what & why)

Owner-reported polish/fix sweep after the website launch (PR #98) and the 2026-08-21 merges. Eight reported items; investigation resolved them into five code changes, one environment fix with verification walks, one docs/dev-ergonomics addition, and one split-out follow-up:

1. **Website → Playground opens in a new tab.** All four CTAs/nav links already carry the `↗` glyph but navigate in-tab. (Owner asked for honest pushback; verdict: agree — playground is a stateful workspace, website is content.)
2. **Playground links back to the website** — one `shell-nav` entry labelled **`snugprotocol.org`** (owner-picked) serves web AND desktop (shared shell); desktop must route through `getPlatform().oauth?.openExternal` (DesktopWelcome pattern). URL is a new playground-owned constant — dependency direction stays website→playground (ADR-0048).
3. **Stale starters / Trivia Night on the shelf** — NOT a code bug. Shelf = build-time Vite glob over `examples/` (12 folders, no `trivia-night`; fresh dist chunks clean). Owner's dev server predates the removal and its dep cache is half-written (see item 8), so it serves a stale module graph. Fix = the item-8 cache reset; verified by acceptance walk.
4. **Desktop-only badge** copy `needs the desktop app — free download` → simple **`desktop`** tag; keep the existing `<Link to="/download">` behavior (owner prefers the download page; that's already the wiring since ADR-0047).
5. **Website `/docs` + `/docs/spec` Starlight error** (`The slug "docs" ... does not exist`): every `.mdx` entry (and only those) is absent from the loaded content store; `.astro/` is half-written (empty module maps). Suspects, in order: interrupted content sync cache; `quickstart.mdx`'s `import { site }` chain through the `@playground` alias failing during content sync. Reproduce → fix root cause → close the guard gap (`navIntegrity.test.ts` checks `existsSync` + stale `dist/`, so it stays green while the site errors).
6. **Recovery Key acknowledgement**: replace the type-`"i saved it"` textbox with a **mandatory checkbox** (continue disabled until checked). **Show-button overlap**: `className="row"` is used in 8 places with NO `.row` CSS rule anywhere — the existing `.field-row` (flex + gap, `app.css:2019`) is the intended layout; convert all sites and give inputs `flex: 1`.
7. **Gmail (Inbox Copilot) dual-mode — SPLIT OUT** (owner-approved 2026-08-21). Research verdict recorded for the follow-up: Gmail API itself is fully CORS-open (live-probed: arbitrary-origin `Access-Control-Allow-Origin`, `authorization` allowed on preflight, both `gmail.googleapis.com` and legacy host), so the browser data path works; the blocker is OAuth — Google requires `client_secret` at code exchange for "Web application" clients even with PKCE (PKCE ≠ client auth), and only native/desktop client types skip the secret. Viable web paths: (a) user-registered Web client with client_id+client_secret in host credential custody (refresh tokens work), or (b) token-model flow, no secret, ~1 h tokens, re-consent every session. Queued in `docs/next-steps.md`; High tier when picked up (`packages/auth` postures).
8. **Playground cannot open any app** (`504 Outdated Optimize Dep`, failed dynamic import of RunView): `apps/playground/node_modules/.vite/` holds only an aborted `deps_temp_*` (no `deps/`) — an interrupted dep re-optimization. Fix: delete the cache, restart. The `/auth/me` 404 is BY DESIGN without `SNUG_AUTH=google` (server returns 401 when registered; 404 = route not registered; `auth.ts` maps it to `unavailable` gracefully). Prevention: root **`pnpm dev`** script (owner-approved) running server (build+run) + playground together with agreed ports.

**Acceptance criteria** (each becomes at least one test unless marked walk):
1. Every website link to the playground (`MarketingLayout.astro` header/footer, `index.astro` hero, `AudienceSplit.astro` ×2, `quickstart.mdx`) carries `target="_blank"` + `rel="noopener"` — extend `siteLinks.test.ts`.
2. Playground shell nav renders a `snugprotocol.org` link → `https://snugprotocol.org`, `target="_blank"`; on a desktop platform the click prefers `oauth.openExternal` — new vitest (platform-mocked, both kinds).
3. Desktop-only badge renders the text `desktop` (still `data-testid="desktop-only-badge"`, still `Link to="/download"`, explanatory `title` retained) — update `hubDesktopStarter.test.tsx`.
4. `pnpm --filter website build` succeeds from a clean `.astro/`; `/docs/` and `/docs/spec/` pages exist in fresh `dist/`; the guard test now fails on the mdx-entries-missing class (exact form decided after repro — see plan).
5. Recovery Key step: continue is disabled until a required checkbox is checked; the typed-acknowledgement textbox and `ACKNOWLEDGEMENT` constant are gone — update `protectSetup` suite (the "typed acknowledgement" pins are rewritten, not weakened: the gate-must-block property is preserved as checkbox-unchecked-blocks).
6. No `className="row"` remains in playground sources (source-scan assertion) and the converted rows use `.field-row` with `flex: 1` inputs — no input/button overlap at 390px (existing mobile walk width).
7. Root `pnpm dev` starts server+playground together (script unit test for command construction; liveness by walk).
8. Environment walks (owner or dev, journaled): after `rm -rf apps/playground/node_modules/.vite` + restart — apps open again; starter shelf shows exactly the 12 current starters (no Trivia Night); installed starters with newer `starter.json` show the hub `update · vN` badge and the run-header update act works.

**Out of scope**: Gmail/Inbox-Copilot web support and any `packages/auth`/registry change (split to follow-up); deleting the owner's installed apps (user data, by design); deploying the website or playground (explicit-ask rule); the playground vitest file-parallelism flake (separate open thread).

## Plan

Order chosen so the environment fix lands first (it unblocks verification of everything else in the running app), then website, then playground UI. Tests FIRST within each leg (TDD.md); the website docs leg starts with a repro because the guard design depends on the actual root cause.

**Leg 0 — environment reset + dev runner (items 8, 3):**
1. `rm -rf apps/playground/node_modules/.vite`; restart dev server; walk AC8 (apps open; shelf = 12, no Trivia Night; update badges present).
2. Test-first: `scripts/dev.test.mjs` (node:test) pinning command construction of a new `scripts/dev.mjs` — spawns `pnpm --filter server build` then server on `SNUG_SERVER_PORT ?? 8787` + `pnpm --filter playground dev` (vite 5173), prefixed output, SIGINT tears both down; no new dependency. Root `package.json` gains `"dev": "node scripts/dev.mjs"`.
3. Document the stale-cache failure signature (504 Outdated Optimize Dep → delete `.vite`) in `docs/solutions/`.

**Leg 1 — website (items 1, 5):**
4. Item 5 repro: `rm -rf apps/website/.astro` → `pnpm --filter website build`. If clean build fixes it → root cause is the interrupted sync cache; guard = build-freshness/slug assertion (see 6). If it still fails → chase the `quickstart.mdx` `@playground`-alias import chain (`site.ts` → `releaseChannel.ts`); likely fix = stop importing through the alias from MDX (inline the playground URL via `site.ts` re-export that doesn't cross the alias at content-sync time). Record which hypothesis held in this file.
5. Item 1 test-first: extend `siteLinks.test.ts` — every `site.playground` link site carries `target="_blank" rel="noopener"`; then edit `MarketingLayout.astro:52,85`, `index.astro:32`, `AudienceSplit.astro:36,48`, `quickstart.mdx:14`.
6. Guard for AC4: extend `navIntegrity.test.ts` (or `buildOutput.test.ts`) so the mdx-missing class reds — minimum: sidebar `slug:` values must each resolve to a rendered page in `dist/` **and** the test refuses a `dist/` older than the newest `src/content/**` mtime (kills the stale-dist mask). Final form after step 4's repro.

**Leg 2 — playground UI (items 2, 4, 6):**
7. Item 2 test-first: new `websiteLink.test.tsx` (web kind: anchor + `target="_blank"`; desktop kind: `openExternal` preferred — `vi.resetModules` + `setPlatform` per the platform test trap). Implement: new single-homed constant (new `apps/playground/src/config/site.ts` holding `WEBSITE_URL`, sibling pattern to `releaseChannel.ts`), link in `App.tsx` `shell-nav` between `settings` and the update surface, `DesktopWelcome.tsx:38-43` click pattern.
8. Item 4: update `hubDesktopStarter.test.tsx` copy pin → `desktop`; edit `HubView.tsx:473-486` badge text + `.tile-desktop-badge` styling for the shorter tag; keep testid, Link target, and title.
9. Item 6 test-first: rewrite `protectSetup` acknowledgement tests to the checkbox contract (unchecked blocks, checked enables, no textbox); implement in `ProtectSetupFlow.tsx` (drop `ACKNOWLEDGEMENT`, lines 27/195-207). Then the `.row` sweep: add a source-scan assertion (no `className="row"` in `apps/playground/src`), convert the 8 sites (`ProtectSetupFlow.tsx:109,129,164,186,206`, `UnlockScreen.tsx:73,104`, `ConnectionWizardSheet.tsx:1550`) to `field-row`, add `flex:1` input rule if `.field-row` needs it; visual walk at 390px + desktop width.

**Leg 3 — docs & queue:**
10. `docs/next-steps.md`: add the Gmail dual-mode follow-up with the OAuth research verdict (spec §7 above). Code-map: row 23's "Recovery Key behind a typed acknowledgement" wording updated at Gate 6; new website test counts via `update-code-map`.

**Cross-package impact**: none beyond the three areas (no protocol/db/auth/runner). Website tests don't touch the sync gate (`docs-sync.json` unchanged — no spec/schema sources edited). Playground suite: run serially (`--no-file-parallelism`) before believing any red (known flake).

**Test plan summary**: website vitest (siteLinks +~6, navIntegrity/buildOutput +~2), playground vitest (websiteLink new ~4, hubDesktopStarter ~2 updated, protectSetup ~5 rewritten, source-scan 1), scripts node:test (dev ~3). Walks: AC8 environment walk, 390px overlap walk, `pnpm dev` liveness.

## Decisions & surprises

- 2026-08-21 owner interview: Gmail dual-mode SPLIT to follow-up (High tier when picked up); nav label `snugprotocol.org`; dev script approved; owner corrected that Trivia Night appears on the **shelf**, not installed — consistent with the stale-dev-server diagnosis (build-time glob + wedged HMR), folded into AC8.
- Item 1 pushback resolved: agreed with owner — new tab is right (workspace vs content; `↗` glyph already promised it).
- `/auth/me` 404 = by-design console noise without `SNUG_AUTH=google` (server registers auth routes conditionally; playground maps non-200/401 → `unavailable`). No change.

## Session journal (append-only, newest last)

### 2026-08-21 — jeetu + claude — session (Gates 1–2)
- Done: investigation (3 explore agents + live CORS probes), owner interview (4 decisions), task file + plan, branch created.
- State: plan written, NOT yet approved; no implementation code.
- Next step: owner plan approval → Gate 3 (tests first, Leg 0).
- Open questions: none blocking; item-5 guard's final form depends on the step-4 repro.
