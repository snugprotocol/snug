# 0045 — Starter versioning and the in-place update channel

- **Status:** draft (accepted on plan approval of TASK-20260820-starter-updates)
- **Date:** 2026-08-20
- **Task:** TASK-20260820-starter-updates

## Context

Installing a starter copies `examples/<folder>/app.html` into the user's snug file and the run path executes that snapshot forever — [architecture.md](../architecture.md) stated plainly that "an installed starter never receives a rebuild". Shipped fixes therefore never reached installed copies, and both exits were bad: `deleteApp` cascades to the app's data/chat/credentials, and `resetToFactory` restores the install-day bytes ([lessons.md](../lessons.md) 2026-08-19, "fixed on disk vs fixed for the user"). `docs/next-steps.md` carried the fix's shape for weeks: land new bundle bytes as a NEW version via `saveAppVersion` (data untouched, old version revertable) with a visible disclosure, never clobbering a user's re-authored copy silently.

Two structures constrain the design:

- **The two-fact declaration vouch** (`starterDeclaration.ts`): guided connection setup requires BOTH the pinned factory version AND the running `current_version` to byte-match the bundled starter. Landing new bytes via `saveAppVersion` makes `current_version` match the *new* bundle while pinned v1 holds the *old* one — a naive update silently withdraws the app's declaration.
- **The hub-never-writes doctrine** (`HubView.tsx`): the one write act lives in RunView.

No starter carried a version or release notes; both are net-new data.

## Decision

1. **Every starter declares `examples/<folder>/starter.json`**: integer `version` plus a cumulative `changelog` (`[{ version, date, title?, sections: [{ title, items[] }] }]`, newest first, newest entry must match `version`) plus **`appHash`, the sha-256 of the normalized `app.html` bytes**. The validator recomputes the hash, so editing a starter's html without bumping the version and writing notes is a red test, not a convention — the authoring rule is enforced, not requested. Bundle bytes still replace each other (no upstream code history); only notes accumulate.
2. **A starter-metadata module owns its own glob.** `starterApps.ts`'s glob is test-pinned to app-html shape; starter.json loads from a new `starterMeta.ts`, following the `starterDocs`/`starterRuntimeContract` precedent.
3. **The update act is the second host write act, and it lives in the app header (RunView).** The hub tile only *reports* — "update · vN" in place of "installed" — and clicking it opens the installed copy as always. The hub-never-writes doctrine stands.
4. **Update lands as a new PINNED version through `saveAppVersion`** (which gains an optional options parameter `{ pinned, contractJson }`), note `starter update to vN`, with the starter's **new runtime contract written in the same synchronous db call** (`contractJson` overrides the ADR-0018 copy-forward default, which is for user edits; a factory update ships factory contract — and doing it in one call closes the window where new HTML durably runs under the old contract). The act is idempotent: re-applying an already-applied update writes nothing. Connection requirements re-run the install act's declared-only refresh (an `approved` or `revoked` row is never touched — a changed requirement on an approved slot waits for the user's own re-review; accepted limitation). Docs re-seed absent-only (ADR-0035). App data tables, `auth:<appId>:*` secrets, chat, and user docs are untouched by construction — all keyed on `app_id`, never version.
5. **"Factory" becomes plural: the vouch's fact 1 generalizes from "v1 matches the bundle" to "the newest pinned version matches the bundle."** Fact 2 (the running version matches) is unchanged. Forgery still requires controlling both a pinned row and `current_version`; the documented v1-alone and current-alone holes stay closed. Consistently, `resetToFactory` restores the **newest** pinned version (MAX, was MIN) — "factory" means the starter you are on, not the day you installed. Single-pin apps (every app existing before this change) behave identically.
6. **The installed starter version is a `snug_settings` row** `starterVersion:<appId>` (ADR-0036 D2 precedent; no schema bump), written on install and update, equality-deleted in `deleteApp`'s cascade. Absent key (legacy installs) derives: newest-pinned bytes equal the bundle ⇒ current bundled version; else 1.
7. **An edited copy updates only through a confirm dialog** (current ≠ newest pinned ⇒ the user re-authored); unedited copies update in one click. Either way the pre-update version stays in the versions panel and is revertable — the update never destroys user work.
8. **Release notes render in the installed app**: the run header shows the installed version and a "release notes" link opening a formatted sheet of the cumulative changelog, installed version marked.

## Alternatives considered

- **Drop the vouch to one fact (current == bundle).** Rejected: the in-file doctrine comment documents the hole each fact closes, and the pinned-plural generalization keeps both at equal strength for zero extra cost.
- **Rewrite v1's bytes at update ("re-pin the factory").** Rejected: destroys the revert path and rewrites history the versions panel promises.
- **A `starter_version` column on `snug_apps`.** Rejected: schema bump + spec-sync for one integer; the settings namespace exists for exactly this (ADR-0036 D2), with the delete-cascade obligation it carries (lessons.md 2026-08-18).
- **Update button on the hub card.** Rejected by owner: keeps the hub read-only doctrine intact; the header is where the app's other write acts live.
- **Auto-apply updates.** Rejected (next-steps.md): silently swapping running code is its own hazard; offered-only, with the version chip as the disclosure.

## Consequences

- `architecture.md`'s "an installed starter never receives a rebuild" becomes false and is rewritten to name this channel.
- A changed connection requirement on an *approved* slot does not reach the user until they re-review that connection — stated limitation, consistent with the ADR-0017 lock.
- `resetToFactory` after an update restores the updated starter, not install-day bytes; the install-day version remains reachable via the versions panel (pinned rows are never pruned).
- The update act is the first writer of a second pinned row; everything assuming "exactly one pinned version" must treat pinned as plural. The full-repo sweep found exactly two: `resetToFactory` (flipped to MAX here) and `VersionsPanel` (banner + factory tags — its DESC `find` already lands on the newest pinned; the selection is made deliberate and test-pinned, and every pinned row keeps the `factory` tag since each is a factory snapshot).
- Spec impact: none — no `packages/protocol` change.
