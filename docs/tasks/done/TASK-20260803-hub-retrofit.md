# TASK-20260803-hub-retrofit: Marketplace dedup, SSO surfacing, design pass (child 4 of living-apps)

- **Status**: in-review (complete on umbrella branch)
- **Owner**: Jeetu
- **Risk tier**: medium (auth-adjacent UI; one server auth change)
- **Branch**: `feat/TASK-20260803-living-apps` (umbrella branch)
- **Packages touched**: `apps/playground`, `apps/server` (post-login return path only)
- **Spec impact**: none beyond child 1's `install_source` (already in schema v2)
- **Related**: umbrella [TASK-20260803-living-apps](TASK-20260803-living-apps.md), child 1, TASK-20260803-hub-sso (server baseline)

## Spec (what & why)

Marketplace click connects to the existing install instead of duplicating: find-or-open by `install_source`, installed/open tile states, in-flight latch, DB unique index as race backstop. Google SSO surfaced properly in the revamped UI: identity chip in the shell header on every page (sign-in / avatar / menu), logout rebuilds the sync loop (bug), post-login returns to the originating page (server: one-shot state cookie carries return path), first sign-in suggests hub sync origin. Design pass: SettingsView + VersionsPanel onto system classes; AccountCard explains static-demo instead of vanishing; starter cosmetics derived, not hardcoded.

**Acceptance criteria** (umbrella AC8/AC9):
1. N clicks (incl. two racing) on a starter tile → exactly one app row; installed tile opens the existing app (unit + Playwright regression).
2. Identity chip renders all four auth states on every page; sign-in from any page returns to it (server unit for return path; open-redirect negative: only same-origin paths honored).
3. Logout sequence (review F14): `logout()` → await `refreshAuth()` → rebuild sync loop, so the rebuilt hub provider re-reads the post-logout CSRF/cookie state (unit asserts token recapture); CSRF/CORS negatives stay green.
4. No inline-style blocks remain in SettingsView/VersionsPanel (style audit); warm-ember tokens only.

**Out of scope**: marketplace curation, non-Google SSO, new sync providers.

## Shared literals (from umbrella — verbatim)

`install_source` format `starter:<folder>` (NULL for built apps) · index `idx_snug_apps_install_source` (partial unique) · CSRF header `x-snug-csrf` · auth states `unknown|unavailable|anonymous|signed-in`.

## Plan

`HubView.tsx` find-or-open + tile states → shell identity chip (`App.tsx`, `state/auth.ts`) → `state/sync.ts` logout rebuild → `apps/server/src/routes/auth.ts` return path (+ open-redirect guard) → Settings/Versions restyle (`theme/app.css` classes). Tests FIRST per AC.

## Decisions & surprises

—

## Session journal (append-only, newest last)

### 2026-08-03 — Jeetu/Claude — session (complete)
- Done: find-or-open installs + tile states + latch (AC8 Playwright regression, SPA-nav to dodge the ephemeral-OPFS reload trap), identity chip, signOut→initSync ordering (F14 unit), post-login return path + open-redirect/control-char negatives (server 91), AccountCard three-state + hub-sync suggestion, Settings class cleanup.
- State: complete on umbrella branch.
- Next step: rides the umbrella PR.
