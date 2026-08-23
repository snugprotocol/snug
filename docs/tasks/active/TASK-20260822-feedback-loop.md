# TASK-20260822-feedback-loop: In-product GitHub-deep-link feedback + SSO hide

- **Status**: planned — awaiting owner plan approval (Gate 2 stop, revised after pivot)
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
- State: **STOPPED at the Gate-2 approval gate (revised plan) — no implementation code.**
- Next step: owner approves → Gate 3 (failing tests: URL builders first).
- Open questions: (1) keep the SSO-runbook no-authz caveat rider, or split out?
  (2) Discussions category slug to target (checked at implementation via `gh api`).
