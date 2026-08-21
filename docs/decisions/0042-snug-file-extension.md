# 0042 — `.snug` is the canonical user-file name

- **Status:** accepted
- **Date:** 2026-08-20
- **Task:** TASK-20260820-snug-file-and-encryption

## Context

[ADR-0021](0021-desktop-shell-transports.md) D6 already registered `.snug` with the OS ("same sqlite byte format; a filename convention, not a new format", `rank: Owner`), and the desktop shell already exported `snug-user.snug`. But the rename was never finished, and the half-state was **shipping a bug**: the web build exported `snug-user.sqlite`, and the web import picker's `accept` list did not include `.snug` at all — so a user who exported on desktop and tried to import in a browser found their own file greyed out in the file chooser. Nothing failed loudly; it simply looked like the wrong kind of file.

Six independent spellings of the suffix existed across TypeScript, Rust and JSON, with no shared constant.

The name also has to carry weight it did not before: [ADR-0043](0043-passphrase-encryption-at-rest.md) makes a `.snug` optionally an encrypted container rather than always a plain SQLite database, so "the extension tells you the byte format" stops being true and "the extension tells you whose file it is" becomes the point.

## Decision

1. **`.snug` is the canonical name for the one portable file a user owns.** `USERDB_FILE = 'user.snug'`; exports are `snug-user.snug` on **every** platform; per-app exports are `<name>.snug`.
2. **The extension is single-homed** in `packages/protocol` (`USERDB_EXTENSION`, `USERDB_LEGACY_EXTENSION`) so the six spellings cannot drift again.
3. **The legacy name is read, never written.** `openUserDb` loads `user.sqlite` when `user.snug` is absent and adopts forward on the next ordinary persist; the sync sidecar and the Dropbox remote path do the same. **Nothing is renamed, copied or deleted** — the old file stays on disk as the user's own backup, and once the canonical file exists it always wins.
4. **Both extensions stay admissible on input**: the import picker, the open-with gate and the Rust allowlist all accept `.snug` and `.sqlite`. Users have real pre-rename exports and backups; refusing them would strand exactly the people the adopt-forward path exists to protect.
5. **Server-internal stores keep `.sqlite`** (`artifacts.sqlite`, `threads.sqlite`, `users.sqlite`, `userdbs.sqlite`). They are infrastructure, not the user's data, and renaming them would imply a portability promise that does not apply.
6. **The extension is a convention, not a format claim.** Content sniffing stays authoritative everywhere — every validator reads magic bytes, never the name.

## Alternatives considered

- **Leave `.sqlite` everywhere.** Rejected: it abandons a decision ADR-0021 already made and half-shipped, and leaves the import bug in place.
- **Rename with no legacy fallback.** Rejected, and it is worth naming why plainly: the new name is absent, so the open path takes its "no file yet" branch and hands back a pristine empty database. The user's real data sits on disk, intact and unreferenced, while the app shows them nothing — no crash, no error, no clue. `docs/lessons.md` already carries the 2026-08-03 version of this failure.
- **Migrate by renaming the file on disk.** Rejected: a rename is a destructive act performed on the user's only copy, at boot, before anything has been verified. Read-and-adopt-forward achieves the same end state and leaves the old bytes untouched.
- **Also rename the server's own stores.** Rejected: see 5.

## Consequences

- Every existing user's file, sidecar and Dropbox copy continue to work; the first launch after upgrade adopts forward silently.
- **A second device on a pre-rename build writes `user.sqlite` while an upgraded one writes `user.snug`**, and they will not reconcile until both upgrade. The rename is not opt-in the way encryption is, so this is a real (if narrow) consequence rather than a hypothetical — it is stated here rather than discovered.
- The e2e export locator changed (`export .snug`); that lane does not run in CI, so the locators were updated in the same commit (`docs/lessons.md:7`).
- Spec impact: the canonical name is normative surface in spec v0.2-userdb.
