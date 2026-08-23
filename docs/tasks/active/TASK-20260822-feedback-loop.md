# TASK-20260822-feedback-loop: In-product GitHub-deep-link feedback + SSO hide

- **Status**: in-review — implementation + AI review complete, ALL suites green (incl. full e2e); awaiting owner review + push/PR ask
- **Owner**: jeetu
- **Risk tier**: **Medium** (playground logic; NO protocol/runner/auth changes, no C1/C2 weakening, no CI/release config)
- **Branch**: `feat/TASK-20260822-feedback-loop`
- **Packages touched**: `apps/playground` (+ `apps/desktop` via source reuse — its suite must run). `packages/auth` consumed (scrub), not changed.
- **Spec impact**: none. Sandbox guard suites stay green as proof.
- **Related**: ADR-0052 (GitHub deep-links, hosted receiver rejected — supersedes this task's first plan, which lives in git history at `d9240e0`), ADR-0013 (reaffirmed), internal roadmap B6 (shape adopted, promoted from Beta), `.github/ISSUE_TEMPLATE/*` (the funnel).

## Spec (what & why)

End users hitting an error in the playground have no in-product path to report it. The
owner first commissioned a hosted anonymous receiver, then asked for a re-evaluation
against the project's privacy-first goals; the call reversed (ADR-0052): **no hosted
receiver at launch** — ADR-0013's verifiable zero-endpoint claim keeps its strongest form
— and in-product feedback becomes **prefilled GitHub deep-links** (roadmap B6's shape).
Inline "report this" affordances at existing error surfaces and one quiet general
feedback entry assemble prefilled issue-form / Discussions URLs; the user previews
in-product, confirms, reviews again on GitHub's compose screen, and submits there. Snug
operates nothing and receives nothing. Ratings (👍/👎) are cut. Google SSO login UI is
flag-gated off by default.

**Acceptance criteria** (each becomes at least one test):
1. **URL assembly**: `buildBugReportUrl(ctx)` / `buildFeatureRequestUrl(ctx)` /
   `buildFeedbackDiscussionUrl(ctx)` produce correct GitHub URLs — template + field-id
   query params (`what-happened`, `environment`, `area`; `problem`), title, encoding;
   total URL capped (≤ 7,000 chars) with a visible `…[truncated]` marker on long error
   text; `area` mapped from the reporting surface.
2. **Inline error reporting**: the build-failure surface (`ChatLog`), wizard
   connect-error, RunView install/export errors, and userdb-load-failed each render a
   quiet "report this" affordance; tapping shows an in-product preview of exactly what
   will be prefilled; **navigation happens only on confirm** (no fetch, no window.open
   before it); rendering an error surface alone triggers nothing.
3. **Scrub**: a credential-shaped string planted in error text is scrubbed from the
   assembled URL and the preview (negative test, C1-adjacent).
4. **General entry**: header item + Settings card offer bug / feature request / open
   feedback, routing to the right prefilled destination with the same preview-confirm.
5. **SSO hidden by default**: with `hubAuth` off (web default), no sign-in renders in
   `IdentityChip` or Settings `AccountCard` **even when `/auth/me` answers 401**, and the
   probe is not fired; flag on → prior behavior byte-identical. Desktop: hard-off.
6. **Desktop path**: confirm opens via the platform opener (system browser), not an
   in-shell navigation.
7. **No sandbox impact**: no new frame types; runner/CSP guard suites +
   `check-sandbox-guard` stay green.

**Out of scope**: any hosted receiver / worker / Firebase (parked to 1.1 per ADR-0052);
ratings; automatic capture of any kind; Discussions category creation/verification
(implementation checks the slug via `gh api` and falls back to `/discussions/new` bare);
issue-template edits; deploy/content passes; server OIDC code; the wizard's queued
error-surfacing items (next-steps 2026-08-15).

## Plan

**Verified facts:** issue forms are YAML with prefillable field ids (bug: `what-happened`,
`repro`, `area`, `environment`; feature: `problem`, `proposal`, `kind`, `alternatives`);
`blank_issues_enabled: false` and Discussions is the sanctioned free-form channel.
Sign-in is already invisible on static deploys by construction (probe → `unavailable`);
the flag makes it structural. Desktop opener already allows `https://*`. Host page has no
CSP. While the repo is private the links 404 for outsiders — designed quiet state, same
as `/download`.

**UX doctrine:** no bubble, no badge, no nag. Persistent affordance = one small ghost
"feedback" item in the header + a Settings card. Report links appear ONLY inside an
already-rendering `error-note`, as a quiet inline link. Preview is a small popover: the
prefilled fields verbatim, "open on GitHub →" confirm, esc/click-away cancels. `repro`
is deliberately left empty — GitHub's form marks it required, which hands us
reproductions. Keyboard-accessible, theme-aware, existing Button/Sheet idiom.

### Files to touch, in order (tests FIRST within each step)

**Step 1 — core (`apps/playground/src/feedback/`):**
- `config/site.ts` — add `REPO_URL`, `REPO_NEW_ISSUE_URL`, `REPO_DISCUSSIONS_URL`
  (single-homed, releaseChannel.ts pattern).
- `feedback/githubReport.ts` — the three URL builders: context type
  (`surface`, `errorText`, `appName?`, `starterId?`, `starterVersion?`), scrub via the
  `packages/auth` scrubber export (thin local wrapper if its surface doesn't fit prose;
  no `packages/auth` change), environment line (platform web/desktop, playground
  version, UA-coarse), surface→`area` map, caps + truncation marker.
  Tests: AC1, AC3.

**Step 2 — UI:**
- `feedback/ReportPreviewPopover.tsx` — preview + confirm (web `window.open`
  noopener/noreferrer; desktop platform opener). Tests: AC2 confirm-gating, AC6.
- `feedback/ReportErrorLink.tsx` — inline affordance taking a context.
- `feedback/FeedbackMenu.tsx` — header entry (bug / feature / feedback) + same popover.
- Mounts: `App.tsx` (header + userdb-load-failed at `App.tsx:92`), `ChatLog.tsx:92`
  (build failure), `RunView.tsx` (install/export error notes),
  `ConnectionWizardSheet.tsx:1383` (connect-error), `SettingsView.tsx` (card).
  Tests: AC2 per-surface render + nothing-on-render, AC4.

**Step 3 — SSO flag-gate:**
- `platform/platform.ts` — `capabilities.hubAuth: boolean`; web default
  `import.meta.env.VITE_SNUG_HUB_AUTH === '1'`; `apps/desktop/src/platform-desktop.ts`
  → `false`.
- `state/auth.ts` — `refreshAuth()` short-circuits to `unavailable` when off (probe not
  fired). `IdentityChip`/`AccountCard` unchanged (already key on `unavailable`).
  Tests: AC5 both flag states + desktop.
- `docs/runbooks/enable-google-sso.md` — build-flag step + (rider, owner may strike) the
  owed one-paragraph no-authz caveat from next-steps item 1.

**Step 4 — docs (in-branch):** ADR-0052 → accepted; architecture.md paragraph
(feedback channel + `hubAuth`); code-map rows; `internal/07-roadmap.md` B6 note
(shape shipped early, hosted variant parked to 1.1); next-steps: prune nothing owed,
add the 1.1 revisit line; glossary if warranted. No spec-changelog (no protocol change).

### Cross-package impact & test plan
No `packages/*` changes → `pnpm --filter playground test`, `pnpm --filter desktop test`,
root `gate:local` (workspace+smoke) before review. No website-sync sources touched.

### Spec-sync impact
None; AC7 is the negative proof.

## Decisions & surprises

- **Owner-directed pivot (2026-08-22):** hosted receiver evaluated and REJECTED for
  launch (claim dilution, wrong persona, solo-dev ops tax, roadmap inversion) — full
  reasoning in ADR-0052; the original Worker+D1 plan is preserved at commit `d9240e0`.
- Prefill query strings reach GitHub on navigation → preview-confirm is load-bearing,
  and scrub runs before URL assembly, not just before display.
- `repro` field left unfilled on purpose — GitHub's required-field gate turns every
  report into a reproduction request we didn't have to write.

## Session journal (append-only, newest last)

### 2026-08-22 — claude — session
- Done: Gate 1 (interview: receiver choice, scope, consent, SSO) + Gate 2 first plan
  (Worker+D1, committed `d9240e0`); owner asked for a strategic re-evaluation → pivot to
  GitHub deep-links chosen; ADR-0052 rewritten to record the rejection + new shape; plan
  rewritten; branch exists.
- State: STOPPED at the Gate-2 approval gate (revised plan).
- Next step: owner approves → Gate 3.

### 2026-08-22 — claude — session (post-approval implementation)
- Done: Gates 3–4 test-first throughout (red shown before each step). AC1/AC3: `feedback/githubReport.ts`
  builders + pattern scrub (15 tests; a quadratic scrub regex caught by test runtime and rewritten linear).
  AC2/AC4/AC6: preview popover / ReportErrorLink / FeedbackMenu / FeedbackCard + mounts (ChatLog build
  failure, RunView install+export, wizard connect-error, App boot load-failed, header, Settings section) +
  mount source-scan (19 tests). AC5: `capabilities.hubAuth` OPTIONAL seat (absence=off — keeps every
  test-built platform on launch posture), `refreshAuth` probe short-circuit, web default from
  `VITE_SNUG_HUB_AUTH`, desktop stays absent-by-design (5 tests). Runbook: Gate-0 build-flag section +
  the owed /invoke no-authz caveat. Docs: ADR-0052 accepted, architecture section, code-map row,
  roadmap B6 note, next-steps entry.
- Deliberate test migrations (not weakenings, each named): `authState.test.ts` + `syncState.test.ts` now
  install a hubAuth-enabled platform (they pin the FLAG-ON mappings; the default-off gate is pinned in
  `hubAuthGate.test.ts`); `platform.test.ts` capability pin gains `hubAuth:false`;
  `settingsRedesign.test.tsx` sections six → seven ("feedback").
- Surprises: (1) GitHub YAML issue forms prefill by FIELD ID — `what-happened`/`environment`/`area`
  pinned so a template field rename reds a test. (2) The 375px header had ZERO slack (TASK-20260822-mobile-
  e2e-reds); the header trigger hides ≤760px (Settings card + inline links are the mobile doors), and the
  first hide rule LOST THE CASCADE to the later-in-file base rule — caught by the mobile e2e (50px
  overflow), fixed by scoping `.shell-nav .feedback-menu-wrap`. (3) `import.meta.url` in vitest resolves
  to vite's serving path — source-scan reads use `process.cwd()` (hueStarterManifest precedent).
- Verification: playground 1520/1520 (tsc-gated) · desktop 175/175 · mobile e2e 4/4 ·
  `gate:local` workspace+smoke PASS (sandbox guards green = AC7's negative proof) · full Playwright
  leg RUNNING at journal time (result recorded next entry).
- Next step: e2e result → AI review (this diff) → owner review/merge.
- Open questions: none blocking. Flip-day: verify one prefill end-to-end once the repo is public.

### 2026-08-22 — claude — review (Gate 5, AI first)
- Full e2e leg GREEN before review (75 passed / 1 skip-by-default). Then /code-review at
  high effort — 8 finder lanes. **Applied findings (each with a test first or a migrated pin):**
  (1) CORRECTNESS: the scheme scrub mangled prose — "Basic authentication failed" became
  "Basic «redacted» failed"; fixed with a prose-mode digit guard. (2) The URL cap was not
  guaranteed under hostile-length appName/environment and a truncation cut could strand a
  lone surrogate; every input is now bounded, any shortening carries the visible marker, and
  slices are surrogate-clean. (3) The desktop confirm rode `oauth.openExternal`, whose
  pending-flow loopback BIND is an OAuth side effect a feedback click must never trigger —
  new side-effect-free `platform.openExternalUrl` seat (`openInSystemBrowser`); rejections
  no longer discarded: a failed/blocked open keeps the preview up with a plain-link fallback.
  (4) Escape double-closed through the wizard Sheet (both listen globally) — the popover now
  stops propagation; click-away added; listener registration de-churned via an onClose ref.
  (5) The hubAuth gate left contradictions: hub sync origin offered/resumable while sign-in
  is structurally hidden (silent egress under an invisible session) — `hubOriginAvailable()`
  now requires BOTH seats; `login()` gated at the module boundary; `logout()` deliberately
  ungated (the cure for a stale session); runbook gained the stale-session caveat.
  (6) REUSE: the scrub was a THIRD divergent credential-pattern list (ASIA keys already
  passed it) — single-homed into `security/credentialShapes.ts` with display/prose modes;
  llmInspector migrated (its 8 MiB fixtures also caught a regex stack overflow in the
  long-run shape → prose-only). (7) Simplifications: shared `routes.ts` (menu/card),
  one entries list per builder (preview=payload by construction), dead branch and no-op
  regex tail removed, honest FeedbackCard copy (GitHub account required — never "anonymous").
- Deliberate test migrations, named: llmInspector keeps aggressive display semantics (its
  digit-less-Bearer pin stands via display mode); desktopSettingsView + platformBackendWiring
  hub-origin AC10 rows are now flag-on rows with a new default-off twin.
- Deferred to next-steps (recorded there): legacy opener call-site migration ×3,
  `useDismissableMenu` at the third popover, inferrerAdapter pattern-list migration,
  render-twin mount fixtures.
- Verification after fixes: playground **1532/1532** (tsc-gated) · desktop **175/175** ·
  no e2e spec pins "this hub" (checked) · `gate:local` workspace+smoke **PASS** ·
  full Playwright leg re-run on the post-fix tree: **75 passed / 1 skip-by-default**.
- State: implementation + AI review complete, all suites green, 10 commits on the branch.
- Next step: owner review of diff AND task file → push + PR on the owner's go.

### 2026-08-22 — claude — session (owner UX pass: header icons)
- Owner calls (interview): feedback trigger → 💬 icon button; settings nav → ⚙ gear icon;
  "snugprotocol.org" label → "about ↗" (domain moves to tooltip + accessible name).
- Done test-first: label pins updated (websiteLink, feedbackMenu — the glyph is decoration,
  aria-label is the accessible NAME per the runHeaderIcons doctrine; e2e's
  `getByRole('link', { name: 'settings' })` keeps working via aria-label). Gear ships as
  text-presentation `⚙︎` (U+2699+FE0E) beside `.nav-link-icon` sizing. The icon pass bought
  the 375px header its width back, so the ≤760px feedback-trigger hide is REMOVED — mobile
  keeps all three feedback doors; the mobile e2e overflow assertion is the guard.
- Verification: mobile e2e 4/4 · playground 1532/1532 · desktop 175/175 · full e2e leg:
  73/74 first-attempt + the skip-by-default row, exit 0 — the one first-attempt red was
  `connection-wizard` journey 4, which then failed once more in a file-only run and
  **passed 5 consecutive file runs (6/6 each)** on the same tree. Classification: the
  PRE-EXISTING documented flake (next-steps 2026-08-10, openWizardFromCard DOM-detach,
  ~1-in-5) — it predates this task, the same full leg ran 75/75 green on this branch
  earlier tonight, and no icon-pass change touches the wizard journeys. Caveat owned:
  the failure TEXT was not captured before re-running (the flake entry's own instruction)
  — if it reds again, capture first. That diagnose-the-flake item remains queued and is
  not absorbed into this task.

### 2026-08-23 — claude — session (owner UX pass 2: nav order, gear presentation, new-tab audit)
- Owner calls: (1) about ↗ moved BEFORE the settings gear — about sits with the text
  links, the icon cluster (⚙️ 💬 ☾) stays together (order pinned in websiteLink's wiring
  test); (2) gear switched to EMOJI presentation ⚙️ (U+2699+FE0F) — the thin text-form
  gear was indistinguishable from the theme toggle's ☾ at a glance; (3) audited every
  github.com anchor for new-tab behavior — the feedback paths already opened new tabs
  (window.open '_blank' / fallback anchors), the ONE gap was DownloadView: the
  "all releases" link and the DMG button navigated same-tab, which pre-flip means a
  GitHub 404 replacing the playground. Both now `target="_blank" rel="noreferrer"`
  (pinned in downloadSurfaces).
- Verification: pins red→green · playground 1532/1532 · desktop 175/175 · mobile e2e 4/4 ·
  desktop-badge e2e 1/1.

### 2026-08-23 — claude — session (owner report: split view on real mobile)
- Diagnosis, verified before changing anything: the either/or swap already existed and
  was correct AT ≤760px (the e2e-verified band) — but a phone in LANDSCAPE (~850px) and
  an iPad in portrait (768–834px) sit ABOVE the shell's 760px breakpoint, so they got
  the DESKTOP split (340px rail, default-shown) — the "split view on mobile" the owner
  walked into. This was precisely the owed owner hardware walk (next-steps 2026-08-21
  item 3: "Playwright measures geometry at 375px, which is not the same as a thumb on
  glass").
- Fix: the RUN VIEW's either/or band widened to ≤1000px — phone landscape + tablet
  portrait get the full-view swap (think hidden by default, toggle in the header in
  BOTH states); iPad landscape (1024+) and the desktop shell (opens at 1200px) keep the
  genuine rail split. The swap's CSS moved out of the ≤760px shell block into its own
  ≤1000px media block at the end of app.css; RunView's matchMedia query matches; the
  two are byte-pinned lockstep by NEW `mobileThinkBreakpoint.test.ts` (CSS cannot
  import TS — the byte-compare IS the single-homing, releaseChannel precedent).
- Tests first: NEW 820px e2e describe (no rail, app default, toggle honest both ways,
  think full-width) shown red then green; `mobileViewToggle.test.tsx`'s matchMedia stub
  migrated to the new literal.
- Verification: playground 1535/1535 · desktop 175/175 · mobile e2e 5/5 (375 + 820) ·
  full e2e leg **76 passed / 1 skip-by-default, zero failures** (journey 4 first-attempt
  green this run). Branch at 16 commits; still owed: the owner's real-phone landscape
  re-check, then push + PR on the owner's go.

### 2026-08-23 — claude — session (owner reports: dev server 404 + same-tab external links)
- **"Playground starting but not loading" was NOT a code defect.** Diagnosed live: the
  owner's vite was started with a trailing `# localhost:5173` — zsh does not treat mid-line
  `#` as a comment in interactive shells by default, so vite received `#` as its ROOT
  argument and served a nonexistent directory (404 on everything, including /index.html).
  Killed the wedged process, restarted a clean `pnpm dev` (5173 answers 200; hub verified
  rendering in a real browser). Remedy for the owner: no trailing `#` comments on commands,
  or `setopt interactive_comments`.
- **Same-tab external links on the WEBSITE (playground + GitHub).** Swept the BUILT site
  (dist scan, all 24 pages): the playground links were already new-tab; the offenders were
  the marketing header GitHub icon + footer repo/spec links, an ImplementorPitch button,
  both /download buttons (`MarketingLayout`/`ImplementorPitch`/`download.astro` — 7 source
  anchors), PLUS two Starlight-layer sources the source scan cannot reach: the docs-header
  social icon (stock SocialIcons renders no target → overridden with
  `HeaderSocialIcons.astro`, same icon + the attribute, URL from the single-homed site
  config) and Markdown/MDX content autolinks (→ `rehype-external-links` with
  target=_blank/noopener in astro.config; NEW dependency). Verified: rebuilt dist sweep
  reports ZERO external anchors without target. NEW `externalLinkTargets.test.ts` pins the
  .astro-source rule AND the two Starlight-layer wirings (deleting either silently reverts
  ~40 built anchors). Website suite 35/35; docs header visually verified unchanged.
