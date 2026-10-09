# 0073 — The starters package is locked by hash: published bytes are immutable, a changed starter is a new version

- **Status:** accepted (owner-delegated 2026-10-08/09 in TASK-20261008-p0-clearance: "publish when ready" + "use your best judgement"; plan reviewed by four fresh-context lenses)
- **Date:** 2026-10-09
- **Task:** TASK-20261008-p0-clearance (W1)
- **Amends:** ADR-0065 §5 / TASK-20260905-host-kit A3 (the pin rule becomes a gate); clarifies ADR-0069 §3 (see 5)

## Context

Every kit page (the artifact, the chat page, the local runner's page — one page since ADR-0072 §1) loads each starter on click from `https://cdn.jsdelivr.net/npm/@snugprotocol/starters@<pin>/<folder>.js` with `integrity="sha384-…"`, and bakes those hashes in at build time from `apps/host/starters-pkg/index.json`. Three facts make that pin fragile:

- **An npm version can never be republished.** Once `x.y.z` is on the registry its bytes are fixed.
- **A wrapper embeds its own version string** (`/* @snugprotocol/starters 0.1.0 — chess … */` and `payload.version`), so its bytes depend on the version and on the builder that wrote it, not only on `examples/`.
- **Nothing gated the rule.** TASK-20260905-host-kit wrote it as a sentence ("bump `examples/starters-package.json` whenever `examples/` changes before publishing"); a `check-starters-pin` was queued and never built. Chess changed in #185 (`0b68061`) under the same pin `0.1.0` that kits built in September had already baked.

Measured on 2026-10-09, every kit already built at the pin `0.1.0` against the two candidate contents (they differ in chess alone): the claude.ai "My Uploads" plugin (2026-10-04) and the local `dist/plugin` build (2026-10-05) carry 12/12 of `main`'s hashes; the owner's Claude Code plugin install (2026-09-14, pre-#185) carries 12/12 of `720b632`'s. No single `0.1.0` serves both.

## Decision

1. **A committed lock.** `examples/starters-lock.json` (`snug-starters-lock/1`) records, per version, `{ ref?, published, integrity?, starters: { folder: sha384 } }`. Only `scripts/publish-starters.mjs` writes it: `--stage` adds or refreshes an unpublished entry; `--publish` marks an entry published (with the registry integrity) after verifying it.
2. **The gate.** `scripts/check-starters-pin.mjs` (offline, in root `check-host-kit`, so CI and gate-local run it) builds the pinned version from `examples/` and compares it with the lock. **Drift at an unpublished version → re-stage. Drift at a published version → bump the pin.** A missing entry fails. `--online` checks the registry and jsDelivr and reports VERIFIED / NOT PUBLISHED / NOT VERIFIED (the network did not answer — never a pass, never a failure) / FAILED.
3. **Older versions are built from their own commit.** An entry other than the pinned version carries a `ref`; its bytes are rebuilt with `git archive <ref>` and THAT commit's builder (also why an ignored file can never ride into a published tarball). The pinned version builds from HEAD.
4. **The first publish.** `0.1.0` = `main` at this task (chess v3): the two newest kits — the claude.ai upload and the 2026-10-05 plugin build, the #185-era builds the owner's walks use — stay whole; the stale 2026-09-14 Claude Code install loses Chess (11/12 starters still load) until it is reinstalled from a fresh build, which walk A needs regardless. One publish, no pin bump. The `ref` machinery (3) stays for any later need to publish an older version's bytes.
5. **ADR-0069 §3's "rename before anything is published"** protects the npm name of the local host PROCESS (`@snugprotocol/local-host`). Publishing `@snugprotocol/starters` does not touch it; the rename PR still precedes the process's first publish.
6. **Publish posture.** The publish runs from a clean HEAD equal to a freshly fetched `origin/main` (a detached worktree qualifies), on Node 22, to `https://registry.npmjs.org/` only (pinned in the argv, `publishConfig` and a preflight on the npm config), after the public scrub over the tarball's own files (absent tool → refused under `--publish`). It publishes the verified tarball, never the directory; the lock is marked `published` the moment npm accepts the upload (before the minutes-long verification), `--reconcile` marks a version the registry and jsDelivr already serve when a run died or npm exited non-zero after accepting it, and a version below the registry's highest is refused (npm's `latest` would move backwards). After the first publish: `npm access set mfa=publish @snugprotocol/starters` and org-level 2FA ([runbook](../runbooks/publish-starters.md)). Trusted publishing with provenance (CI OIDC) is a later task — it needs the package to exist.

## Consequences

- A starter edit now reds `check-host-kit` until the lock is re-staged (before publication) or the pin is bumped (after) — the remedy is printed.
- An unrelated edit to `scripts/lib/page-blocks.mjs` that changes `escapeForInlineScript`'s output reds the same gate (the wrappers embed its output). That is intended: it changes the published bytes.
- Kits built at a commit whose pinned version is unpublished show "offline or unreachable" for every starter — the publish must precede any distribution built at that pin (a build-plugin preflight for it is queued, not built).
- Rejected: pinning by content address instead of version (jsDelivr's `/npm/` path is version-keyed); republishing under the same version (impossible on npm); keeping the rule as prose (it already failed once).
