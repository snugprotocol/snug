# 0056 — Dependency advisories: classify by reachability, fix or dismiss with a recorded reason, gate locally

- **Status:** accepted (owner plan approval 2026-08-24)
- **Date:** 2026-08-24
- **Task:** TASK-20260824-dependabot-triage

## Context

Enabling Dependabot for the flip (ADR-0053 hardening) surfaced 36 open alerts on `main` — 11 distinct advisories, multiply counted per manifest. The repo goes public with its Security tab visible, CI is billing-dormant (ADR-0041) so no automated gate reads alerts, and Snug's shipped surfaces are unusual for a JS monorepo: a **static** website (no server code at request time), a **static** playground SPA, and a **local** desktop app. Most "runtime" advisories (SSR XSS, dev-server file reads, UI-server RCE) describe code paths that never execute in those surfaces. Without a written policy each alert becomes a fresh argument, and "3 critical" sits on the public tab.

## Decision

1. **Classify by reachability in Snug's shipped surfaces, not by GitHub severity.** Four classes: *runtime-reachable* (code that runs in a shipped artifact on a path an outsider can influence), *runtime-unreachable* (shipped, but the vulnerable API is provably unused — evidence = grep/`pnpm why` recorded in the task file), *build/dev-only* (dev server, test runner, image pipeline over our own assets, static-site generators), *not-a-shipped-target* (e.g. Linux-only Cargo deps while only the macOS DMG ships).
2. **Fix when the patch is a cheap in-range or single-major bump and the surface has tests; otherwise dismiss with a reason that names the task and the evidence.** A dismissal is never "we'll get to it" — it is `not_used` / `tolerable_risk` / `no fix available` plus the evidence, so an outside reader of the public tab sees why. Multi-major upgrades of a runtime dependency (react-router 6→7 here) are their own task with a walk, never a side effect of triage.
3. **Static-site build-time advisories are dev-class.** For `apps/website` (no adapter, direct-upload static output, ADR-0054) an Astro request-path advisory cannot be exploited by a visitor; it is fixed when the upgrade is routine and dismissed as build-only otherwise.
4. **A local audit gate, separate from the offline root test.** `pnpm audit:deps` (`scripts/audit-deps.mjs`) reds on any un-allowlisted ≥high advisory; accepted dismissals live in `scripts/audit-allowlist.json` with a `reason`, `task`, and a `reviewBy` date whose lapse reds the gate — so an accepted risk cannot silently become permanent. It is NOT part of root `pnpm test` (which must stay offline-runnable) and IS a pre-flip runbook check.
5. **Dependabot version-update PRs are not auto-merged** (memory rule since PR #121): a two-major bump gets a task, a plan, and the surface's walk.

## Alternatives considered

- **Fix everything to latest** — rejected: vite 8 / vitest 4 / react-router 7 across every package right before flip trades a visible-but-explained count for invisible regression risk.
- **Dismiss everything as "dev tooling"** — rejected: three dismissals (sharp/libvips, react-router, glib) need actual evidence, and leaving 18 dismissed Astro alerts + an unmergeable Dependabot PR is worse optics than a routine upgrade the site's tests cover.
- **Audit inside root `pnpm test`** — rejected: makes the root gate network-dependent and flaky offline (owner call).

## Consequences

- The Security tab at flip shows zero open alerts, every closed one with a disposition.
- Four accepted risks carry a `reviewBy` of 2026-11-30 (react-router v7 migration window; Tauri gtk-0.20 re-check).
- Future Dependabot alerts have a classification ladder and a one-command local check.

## Outcome (2026-08-24)

All 36 alerts dispositioned: **32 fixed** by upgrade (vite 5→6.4.3, vitest 2→3.2.7, nanoid ≥3.3.18 via overrides, astro 5.18→7.2.5 + Starlight 0.35→0.41.7, which also dropped sharp 0.34.5), **4 dismissed** with evidence (3× react-router `not_used`, glib `tolerable_risk`). PR #121 closed as superseded — it bumped `astro` alone, which could never merge against Starlight 0.35's `astro ^5.5` peer.

Two decisions were corrected by contact with the tree, and both are recorded in [lessons.md](../lessons.md): nanoid comes from **postcss**, not vitest (so the "belt-and-braces" override was in fact required), and a `>=` override target resolves to the newest **major** — `">=3.3.18"` installed nanoid 6.0.1 before being pinned to `"^3.3.18"`.

The upgrade's real verification was the rendered output, not the exit code: all 26 built pages were confirmed **byte-identical in prose** against the Astro 5 baseline, with the differences isolated to CSS ordering, scoped-style hashes, and `compressHTML: 'jsx'` whitespace between flex/grid children that space via `gap`.
