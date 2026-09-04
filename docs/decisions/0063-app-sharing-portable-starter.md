# 0063 — App sharing: a shared app is a starter that travels

- **Status:** proposed (Gate 2 draft, 2026-09-04 — becomes accepted on owner plan approval of TASK-20260904-app-sharing; Q1–Q5 in the task file may amend §3/§6)
- **Date:** 2026-09-04
- **Task:** TASK-20260904-app-sharing

## Context

An app a user built or installed lives only in their own `.snug` file. Nothing in the
product hands it to another person — not its code, not the connection shapes it needs,
not the wiki the app accumulated while it was built. The one per-app export in the tree
(`SHOW_APP_EXPORT`, hidden since TASK-20260813) is a SQLite *data* slice, byte-identical
in shape to a whole user file; the desktop open path cannot tell them apart and would
offer to **replace** the recipient's entire file — a latent data-loss shape.

The owner asked (2026-09-04) for sharing by link or by attachment: everything that makes
an app rebuildable and evolvable — code, connection requirements with their shape,
instructions, wiki docs (vision, requirements, plan, lessons, memory, next-tasks, the
build prompt) — and nothing personal: no data, no credentials, no history, no chat. The
recipient may not be on Snug at all.

Three structures constrain the design. **ADR-0016** forbids an app from proposing a
connection at runtime and names "an app-import flow above all" as the untrusted
declaration channel that may only exist once a `providerName` confusable guard and a
registry-borrow ban are in place — both landed with TASK-20260812. **ADR-0017/0045**
split a connection into a requirement half (authoring artifact) and a grant half (the
user's approval + frozen ceiling), and give installed starters a versioned, offered-only
update act. **ADR-0013/0052** keep the hosted playground static with no backend; a
hosted relay for links is its own decision (ADR-0064).

## Decision

1. **A shared app is a starter that travels.** The receiving side reuses the starter
   machinery wholesale: a card on the hub shelf, a read-only preview route
   (`shared--<bundleId>` beside `starter--<folder>`), the same install act
   (`installApp` with an `install_source` identity, factory-pinned v1, runtime contract,
   absent-only doc seeding per ADR-0035, `declared` connection rows), and the same
   offered-only update act (ADR-0045) generalized to take its bytes from a bundle. The
   hub still never writes; the write acts live in the run header.
2. **The bundle is JSON, strict at the boundary, and it is still a `.snug` file.**
   `snug-app-bundle/1` is an internal-draft schema in `packages/protocol`
   (`strictObject` at every level, size caps, OUT of `schemas/` like the net frames and
   the connection requirement). It carries: app identity fields, the **current version's
   html only**, that version's runtime contract, the registered schema DDL (structure,
   never rows), the wiki docs (opt-out), and every connection's **requirement half
   only**. It never carries: `snug_secrets`, grant fields (`status`, `allowed_hosts`,
   `approved_at`, pending edits, `imported`, `confidence`), earlier versions, chat, app
   data rows, per-app settings, the sharer's collected LAN address, or a `userLayer`. A
   credential-shaped literal in the html or a doc makes export **refuse**, naming the
   location — never silently rewrite. The file kind is decided by the first bytes
   (`SQLite format 3\0` · `SNUGENC1` · `{`), which is exactly the sniff the open path
   needs to stop offering to replace a user's file; the hidden SQLite per-app export is
   deleted.
3. **The bundle is the untrusted declaration channel, with its own name.** Connections
   land through `admitConnectionRequirement({ channel: 'shared' })` — a sixth admission
   channel and a sixth persisted provenance `'shared'` (userdb v7; spec-sync). Not
   `'starter'` reused: that would make a stranger's declaration read "ships with this
   starter, as its author wrote it" — ADR-0016's rejected alternative D (trust
   laundering) one layer down. The wizard reviews the persisted row on the strong
   field-by-field path, with honest copy: *a shared app proposed this — its author wrote
   it, not Snug.* Every ADR-0016 guard applies unchanged: borrow ban, confusable guard,
   `userLayer` refusal, approval as the only grant writer.
4. **Received bundles are inert until install.** They persist as `snug_settings` rows
   (`sharedApp:<bundleId>`, capped, oldest evicted) so the "shared with you" shelf survives
   reload and syncs with the file, but no html is stored as an app, no connection row
   exists, no DDL runs, and nothing from a bundle is rendered as HTML until the user
   clicks install.
5. **Identity: `bundleId` is content, `lineage` is origin.** `bundleId` = sha-256 of the
   canonical bundle (dedup; the same bundle twice is a no-op). `lineage` = the sharer's
   app id (a random UUID, no personal data); `install_source = 'share:<lineage>'` is
   minted by the installer from a UUID-charset field, so a bundle can never spell a
   starter's `starter:<folder>` identity and `starterDeclaration`'s two-fact vouch is
   unreachable from a bundle. A re-share by a recipient forks: their app id becomes the
   lineage.
6. **Two transports, one bundle.** The attachment path has no server anywhere: download
   through the one `downloadBlob` dispatch (desktop consent-scoped save / web anchor) plus
   the OS share sheet where `navigator.canShare({ files })` allows it; receive by
   double-click (desktop sniff → new single-use `read_opened_bundle` command and
   `onOpenAppBundle` platform seat — never an overload of `onOpenUserFile`) or by the
   Settings "add shared app" picker. The link path (ADR-0064) encrypts the same bytes
   client-side and keeps the key in the URL fragment.
7. **The desktop is offered, never auto-launched.** A link page always renders the
   in-browser preview; on macOS it additionally offers "open in Snug for Mac" (the
   `snug://` scheme). No browser exposes "is the app installed", Safari alerts on an
   unregistered scheme, and Chrome interposes its own prompt — an auto-attempt would be
   a worse first impression than a button.

## Alternatives considered

- **SQLite bundle (a sparse user DB holding one app).** Reuses the db code but keeps the
  file byte-indistinguishable from a user file except by opening it, validates "whatever
  the tables allow" rather than a strict boundary schema, costs ~100 KB of page overhead
  per share, and cannot be the relay payload without a second format. Rejected.
- **Reuse the `'starter'` provenance for shared declarations.** Zero protocol change;
  dishonest review copy and an install-source namespace collision. Rejected (D above).
- **Ship data rows as "sample data".** The examples contract already keeps sample mode
  inside `app.html` (deterministic, inert, render-only), so sample data travels for free;
  host-side rows are the user's real data and the one thing a share must never carry.
  Rejected.
- **A separate `.snugapp` extension.** Avoids the sniff at the cost of a second file
  association and a second thing to explain; the sniff is three byte comparisons and is
  needed anyway to retire the latent replace-your-file shape. Default `.snug`; owner
  may flip (task Q2).
- **Module-only inbox (no persistence).** Loses the shelf on reload and on the other
  device; a reload of a link page would re-fetch but an attachment would have to be
  re-opened. Rejected for one settings row per bundle.

## Consequences

- `architecture.md` §"Who may propose a connection" gains a fourth row: **the share act ·
  bundle `connections[]` · always strong, `shared` channel.**
- `USERDB_SCHEMA_VERSION` 6 → 7 (no-op migration; a v7 file is refused by a v6 hub — the
  existing newer-file refusal); SPEC-1.0 storage section and spec-changelog updated.
- `RunView`'s twelve `isStarterId` "unowned" branches become one `isUnownedId` predicate
  (starter OR shared); the starter-specific branches keep `isStarterId`.
- `starterUpdate.ts`'s write act is extracted to take its bytes from either a starter's
  artifacts or a bundle — "update · keeps your data" is one act with two sources.
- A third party can now author code that runs in the user's hub. C2's sandbox is the
  defense and is unchanged; the threat-model delta names the residuals (LLM token spend
  within the app's runtime contract; a connection the user may approve after strong
  review; mutating connected calls still confirm).
- Spec impact: internal draft only. Promotion of `snug-app-bundle/1` to `schemas/` is a
  separate spec-sync when a second implementation wants it.
