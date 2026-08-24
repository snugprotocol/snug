# TASK-20260824-dependabot-triage: Triage the 36 Dependabot alerts on `main` (real vs dev-only) before flip-public

- **Status**: planned (awaiting owner plan approval)
- **Owner**: Jeetu
- **Risk tier**: **medium** (confirmed: `apps/playground` runtime dep dispositions + desktop/website devDeps; no `packages/*` source, no CI/release config — any CI edit escalates to High)
- **Branch**: `fix/TASK-20260824-dependabot-triage`
- **Packages touched**: `apps/website`, `apps/playground`, `apps/desktop` (devDeps + lockfile), root `package.json` (vitest, `pnpm.overrides`), `pnpm-lock.yaml`; NO source in `packages/*`
- **Spec impact**: none
- **Related**: next-steps 2026-08-24 (this item); PR #121 (Dependabot astro 5.18.2→7.1.1, open, NOT mergeable as-is — bumps astro alone while Starlight 0.35 peers `astro ^5.5`); ADR-0048 (website), ADR-0053 (retain history at flip), ADR-0054 (web deploy); `internal/RUNBOOK-flip-public.md` stage 6 (Dependabot ON)

## Spec (what & why)

GitHub reports 36 open Dependabot alerts on `main` (3 critical, 9 high, 19 medium, 5 low). They pre-date every recent branch (the PR #121 astro-chain era) and none is triaged. When the repo flips public the Security tab opens on "3 critical" with no disposition. This task classifies every alert as **runtime-reachable** vs **dev/build-only**, then **fixes** the ones with a cheap safe patch and **dismisses with a recorded reason** the ones that are unreachable or unfixable, so the public tab shows an honest zero-or-explained state. It is NOT a merge blocker for any current work and NOT a general dependency-freshness sweep.

### Triage findings (Gate 1 evidence, verified 2026-08-24 against the installed tree)

The 36 alerts are **11 unique advisories across 8 packages**, double/triple-counted by manifest (`apps/*/package.json` vs `pnpm-lock.yaml` vs root). Static facts that drive the classification:

- `apps/website` is **static output** (no `output:` / no adapter in `astro.config.mjs`; Cloudflare Pages direct upload, ADR-0054) → no Astro code runs at request time. Every Astro "runtime" alert (reflected XSS, SSR Host-header SSRF, server-island params) is a **build/dev-server-time** concern here.
- `@vitest/ui` is **not installed** by any workspace package (`pnpm why -r @vitest/ui` → nothing; lockfile entry is vitest's optional peer) → the vitest UI server (the 3 criticals) never runs.
- `sharp@0.34.5` is pulled **only by astro 5.18.2** (build-time image pipeline over our own assets). `whatsapp-sidecar`'s baileys already resolves `sharp@0.35.3` (patched).
- react-router(-dom) 6.30.4 is used declaratively (`BrowserRouter`/`HashRouter`/`MemoryRouter`, `Routes`, `Link`, `useNavigate`). No data router, no loaders/SSR (`deserializeErrors` unreachable). Every `to=`/`navigate()` target is an internal literal or `/run/<id>` built from our own store ids — no attacker-controlled target (`preOpened.navigate(...)` in `connectionWizard.ts` is a `window` handle, not the router).
- `glib 0.18.5` is pinned by Tauri 2's gtk-0.18 Linux stack (`gdk 0.18.2`); a fix needs glib 0.20 = an upstream Tauri stack change. The desktop ships macOS DMG only; Linux is compiled in CI (`ubuntu-latest` workspace leg) but never released.
- Node: local 22.13.1, CI `node-version: 22` → satisfies astro 6/7 (`>=22.12`) and vite 7/8.

| # | Package (installed) | Alerts (GH #) | Sev | Class | Fix available | Disposition (proposed) |
|---|---|---|---|---|---|---|
| 1 | **vitest 2.1.9** — UI server arbitrary file read/exec (GHSA-5xrq-8626-4rwp) | 10, 17, 22 | critical ×3 | dev-only; `@vitest/ui` not installed | vitest ≥3.2.6 | **FIX** — bump root + website to vitest 3.2.7 (also clears nanoid) |
| 2 | **nanoid 3.3.16** via vitest 2 — infinite loop when size 0 (GHSA-2v37-7h3g-55p8) | 36 | high | dev-only (vitest dep) | ≥3.3.18 | **FIX** — falls out of #1 (vitest 3 → nanoid 3.3.18+); `pnpm.overrides` backstop |
| 3 | **vite 5.4.21** (desktop, playground) — fs.deny bypass Windows (GHSA-fx2h), path traversal `.map` (GHSA-4w7w), launch-editor NTLM (GHSA-v6wh) | 1, 2, 3, 5, 6, 7, 19, 24, 25 | high ×3, med ×6 | dev-server-only (never `--host`; build output is static) | ≥6.4.3 | **FIX** — bump desktop + playground vite ^5.4 → ^6.4.3 (plugin-react 4.7 peers ^6) |
| 4 | **esbuild 0.21.5** via vite 5 — dev server CORS (GHSA-67mh) · **esbuild 0.25.12** via wrangler/vitest — dev-server file read (GHSA-g7r4) | 18, 23 | med, low | dev-only | ≥0.25.0 / ≥0.28.1 | **FIX** — 0.21.5 goes with #3; 0.25.12 goes with #1 or an override |
| 5 | **sharp 0.34.5** via astro 5 — libvips CVEs (GHSA-f88m) | 32 | high | build-time only (our own images) | ≥0.35.0 | **FIX** — falls out of the astro bump (#6); else 1-line `pnpm.overrides` |
| 6 | **astro 5.18.2** — reflected XSS ×5 (slot name, spread attrs, view-transition props, `transition:*`, `define:vars`), Host-header SSRF, server-island params | 8, 9, 11–16, 20, 21, 26–31 | high ×2, med ×4, low ×2 (×2 manifests = 18) | build-time only on a static site | 6.4.6 clears high+most med; **7.1.0** clears all | **DECIDE** (interview Q1): astro 7 + Starlight 0.41 (absorbs PR #121) vs astro 6.4.8 + Starlight 0.40 + dismiss 3 residuals vs dismiss-all |
| 7 | **react-router(-dom) 6.30.4** — constructor injection in `deserializeErrors` (GHSA-337j), open redirect via backslash in `<Link>`/`useNavigate` (GHSA-wrjc), open redirect→XSS 6.30.2–6.30.4 (GHSA-jjmj) | 33, 34, 35 | med ×3 | **runtime** dep of playground (public SPA) + desktop — but vulnerable paths unreachable (no data router; no attacker-controlled `to`) | 7.18.0 (two of three); GHSA-jjmj has **no 6.x fix** | **DECIDE** (interview Q2): dismiss "vulnerable code not in use" + queue v7 migration post-launch vs migrate 6→7 in this task |
| 8 | **glib 0.18.5** (Cargo, Tauri 2 gtk stack) — Iterator unsoundness (GHSA-wrw7) | 4 | med | Linux-only build dep; no released Linux target; memory-safety not remote | needs glib 0.20 = upstream Tauri | **DISMISS** "no fix available / not a shipped target"; re-check when Tauri moves to gtk 0.20 |

**Acceptance criteria** (each becomes at least one test / verifiable check):
1. Every one of the 36 alerts has a disposition: fixed (alert auto-closes on the merged lockfile) or dismissed via `gh api` with a `dismissed_reason` + `dismissed_comment` naming this task — verified by `gh api repos/snugprotocol/snug/dependabot/alerts?state=open` returning only the deliberately-open set (target: zero critical/high).
2. `pnpm install --frozen-lockfile` succeeds and root `pnpm test` is green after the bumps (vitest 2→3 touches every package's runner; vite 5→6 touches desktop + playground builds).
3. `apps/website` builds (`astro build`) and its 29 vitest + root `check-website-sync` gate stay green; rendered pass at 1440/390px + docs light theme (the ADR-0048 AC9 walk) shows no regression.
4. Playground `pnpm --filter playground test` + e2e green; desktop `pnpm --filter desktop test` + `gate` green (vite 6 in the Tauri dev shell).
5. A checked-in dependency-audit script (`pnpm audit:deps` — `pnpm audit --audit-level high` over prod+dev, plus the Cargo `cargo audit`/`cargo deny` equivalent if cheap) exists with an allowlist file for accepted dismissals so drift is re-detectable locally (CI is billing-blocked) — scope confirmed in interview Q4.
6. If PR #121 is absorbed, it is closed with a comment pointing here; if not, the task file records why it stays open.

**Out of scope**: general `pnpm update` freshness sweeps (vite 8 / vitest 4 / React 19); Tauri stack upgrades; enabling Dependabot version-updates (`.github/dependabot.yml` — a separate call, it would reopen the PR firehose); any `packages/*` source change; CI workflow edits (would escalate to High).

## Plan

**Owner decisions (interview 2026-08-24):** Astro 7 + Starlight 0.41 (absorbs PR #121) · react-router 6 → dismiss-with-evidence + queue v7 post-launch · tooling = vitest 3.2.7 + vite 6.4.3 (conservative) · audit gate = separate `pnpm audit:deps` script, NOT in root `pnpm test`. Draft ADR-0056 records the disposition policy.

### Order of work (each step ends green before the next)

**Step 0 — Tests first (Gate 3).** New `scripts/audit-deps.mjs` + `scripts/audit-deps.test.mjs` (node:test, same shape as `check-website-sync`): the script runs `pnpm audit --json` (prod+dev, `--audit-level high`), subtracts advisories listed in `scripts/audit-allowlist.json` (each entry: GHSA id, package, reason, task, `reviewBy` date), and exits non-zero on any un-allowlisted ≥high advisory or any allowlisted entry whose `reviewBy` has passed. Tests drive the pure classifier over fixture JSON (`scripts/fixtures/audit-*.json`): (a) high un-allowlisted → red naming GHSA + package; (b) allowlisted → green; (c) expired `reviewBy` → red; (d) moderate/low never gate; (e) allowlist entry with no `reason`/`task` → red (malformed). Root script `audit:deps` added to `package.json` (not in `test`). AC5.

**Step 1 — Tooling bumps (clears alerts 1,2,3,5,6,7,10,17,18,19,22,23,24,25,36 — 15 of 36).**
- `apps/desktop/package.json`, `apps/playground/package.json`: `vite ^5.4.0` → `^6.4.3`. `@vitejs/plugin-react ^4.7.0` already peers vite 6 — unchanged. Desktop `devUrl`/port 41419 and `pnpm dev:web` unchanged.
- root + `apps/website` `vitest ^2.0.0` → `^3.2.7` (peers vite ^6||^7||^8 — satisfied after the vite bump; packages without their own vite resolve vitest's own vite). Known v3 deltas to watch in the 113 `vi.spyOn` / 37 `vi.mock` / 20 fake-timer sites: `spy.mockReset` now restores the ORIGINAL impl (v2 reset to `undefined`); `vi.fn().mockReturnValue` typing; `browser.name` config — none of our configs use `poolMatchGlobs`/`workspace`. Run `pnpm install` (lockfile churn expected), then root `pnpm test`; fix any suite that reds ONLY by adapting to the documented v3 semantics, never by weakening assertions (lessons.md "Trusting a green run").
- `pnpm.overrides` in root `package.json`: `"nanoid@<3.3.18": ">=3.3.18"`, `"esbuild@<0.25.0": ">=0.25.0"` as belt-and-braces only if `pnpm why` still shows vulnerable resolutions after the bumps (wrangler's esbuild 0.25.12 → GHSA-g7r4 is LOW, dev-only; override to ≥0.28.1 only if wrangler tolerates it, else allowlist).
- Verify: `pnpm why -r vite vitest nanoid esbuild` shows no vulnerable resolution; root `pnpm test` exit 0 (AC2); `pnpm --filter playground test` + `test:e2e` (AC4); `pnpm --filter desktop test` + `gate` (AC4).

**Step 2 — Astro 7 + Starlight 0.41 (clears alerts 8,9,11–16,20,21,26–32 — 19 of 36, incl. sharp).**
- `apps/website/package.json`: `astro ^5.12.0` → `^7.1.0` (≥7.1.0 is the first-patched for GHSA-4g3v), `@astrojs/starlight ^0.35.0` → `^0.41.7`. Starlight bundles `@astrojs/mdx ^7` + `astro-expressive-code ^0.44` itself.
- Breaking-change exposure (checked against the actual source, all low): the site uses ONE Astro API (`astro:content` `defineCollection` with Starlight's `docsLoader`/`docsSchema` — already the non-legacy shape, so v6's legacy-collections removal is moot); no `<ViewTransitions>`, `<Image>`, `Astro.glob`, `define:vars`, `transition:*`, `set:html`; Starlight 0.39's sidebar changes concern AUTOGENERATED groups — ours is fully explicit `slug:` entries; the `SocialIcons` component override + `Icon`/`Card`/`LinkCard` imports from `@astrojs/starlight/components` are still public API in 0.41. Two things to actually watch: **(i)** Astro 7's new default Markdown processor (Sätteri) with the `rehype-external-links` plugin — `externalLinkTargets.test.ts` is the guard; **(ii)** `compressHTML: 'jsx'` whitespace default — `navIntegrity`/`legalPages` dist inspections are the guard; `starlight-theme.css` hover-color tweak (0.38) is cosmetic → covered by the AC3 rendered walk.
- The `vite.ssr.noExternal: ['nanoid']` workaround (nanoid/non-secure ESM interop in Astro 5 SSR build) — re-test WITHOUT it first; keep only if the build still crashes, and journal which.
- Verify: `pnpm --filter website build` from a deleted `dist/`; `pnpm --filter website test` (29) ; root `check-website-sync` (AC3); `pnpm why -r sharp` ≥0.35 (astro 7 peers `^0.34||^0.35` — if 0.34.5 survives, add `"sharp@<0.35.0": ">=0.35.0"` to overrides); rendered pass 1440/390px + docs light theme per the ADR-0048 AC9 walk (owner-visible, screenshots in the journal).
- Close PR #121 with a comment linking this task (AC6) — do NOT merge it.

**Step 3 — Dismissals (alerts 4, 33, 34, 35 — the remaining 4).**
- `gh api -X PATCH repos/snugprotocol/snug/dependabot/alerts/{33,34,35} -f state=dismissed -f dismissed_reason=not_used -f dismissed_comment="TASK-20260824-dependabot-triage: declarative router only (BrowserRouter/HashRouter/Routes/Link); no data router → deserializeErrors unreachable; every Link/navigate target is an internal literal or /run/<store-id>; v7 migration queued post-launch"`.
- Alert 4 (glib): `dismissed_reason=tolerable_risk` with comment "Tauri 2 gtk-0.18 Linux stack pins glib 0.18; fix requires upstream; Linux is not a shipped target (macOS DMG only); local unsoundness, not remotely reachable; re-check on Tauri gtk-0.20".
- Allowlist file gains the same four entries (GHSA-337j, GHSA-jjmj, GHSA-wrjc, GHSA-wrw7) with `reviewBy` = 2026-11-30 (post-launch v7 migration window) so `pnpm audit:deps` stays green on `main` and REDS when the review date lapses.
- Verify AC1: `gh api 'repos/snugprotocol/snug/dependabot/alerts?state=open'` returns `[]` (fixed alerts close automatically once the lockfile lands on `main` — so the final AC1 check is a post-merge step, journaled).

**Step 4 — Docs (Gate 6, same branch).** next-steps: prune the 2026-08-24 item, add "react-router 6→7 migration (post-launch, reviewBy 2026-11-30)"; `internal/RUNBOOK-flip-public.md` stage 6/8: add "`pnpm audit:deps` green + Security tab shows 0 open" to the pre-flip checks (untracked file, C4 — edit locally, journal the edit); architecture.md external-deps line for vite 6/vitest 3/astro 7; code-map row for `scripts/audit-deps.mjs`; ADR-0056 status → accepted; lessons if anything surprised; `docs/tasks/done/INDEX.md` line at retirement.

### Cross-package impact
Lockfile + vitest touch EVERY package's test runner → the full root run is the gate (dependency graph: everything). vite 6 → `playground` + `desktop` builds (desktop also `test:rust` untouched — no Cargo change; `gate` for the shell). Astro → `website` only (+ root `check-website-sync`). No `packages/protocol` change → **no spec-sync step**.

### Test plan summary
| AC | Test / check |
|---|---|
| 1 | `gh api …/dependabot/alerts?state=open` → `[]` (post-merge); dismissal comments name the task |
| 2 | root `pnpm test` exit 0 after Step 1 and again after Step 2 |
| 3 | website build from clean `dist/` + website vitest 29 + `check-website-sync` + rendered walk |
| 4 | playground vitest + e2e; desktop vitest + `gate` |
| 5 | `scripts/audit-deps.test.mjs` 5 cases (written FIRST) + live `pnpm audit:deps` green on the branch |
| 6 | PR #121 closed with pointer comment |

### Risks
- vitest 3 semantic drift silently changing a mock's behavior without a red (the `mockReset` change) — mitigated by grepping `mockReset(` sites and reading each (currently 0 hits for `mockReset` in the count above; `restoreAllMocks` ×80 is unaffected).
- Astro 7 markdown processor altering rendered docs HTML in ways no test inspects — mitigated by the rendered walk + a `diff -r` of `dist/` before/after for the spec pages (generated verbatim from the spec draft; any diff there is reviewable).
- Fallback if Step 2 fights for >2h: astro 6.4.8 + Starlight 0.40 (owner's stated fallback), allowlist the 3 residual low/med astro advisories, journal the reason.

## Decisions & surprises

- The count is 36 but the substance is 11 advisories; GitHub counts each manifest separately.
- PR #121 is not mergeable on its own terms: Starlight 0.35 peers `astro ^5.5`; astro 7 needs Starlight 0.41 (`^7.0.2`). Astro 6 needs Starlight 0.38–0.40.

## Session journal (append-only, newest last)

### 2026-08-24 — Jeetu/Claude — session (Gate 1–2)
- Done: alert inventory via `gh api`; provenance via `pnpm why`; static-site + `@vitest/ui`-absent + router-usage + glib-chain checks; triage table above.
- State: draft; awaiting interview answers → plan → branch → approval.
- Interview answered: Astro 7+Starlight 0.41 / dismiss react-router + queue v7 / vitest 3.2.7 + vite 6.4.3 / separate `pnpm audit:deps` script. Plan written; ADR-0056 drafted (proposed); branch `fix/TASK-20260824-dependabot-triage` created off `main` @ 983f5be.
- Next step: **owner plan approval**, then Step 0 (audit-script tests first).
- Open questions: none blocking. Note for approval: alert 4 (glib) dismissal reason will be `tolerable_risk`; react-router `not_used`.
