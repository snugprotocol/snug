# 0063 — App sharing: a shared app is a starter that travels

- **Status:** proposed (Gate 2 draft, 2026-09-04, revised the same day after the fresh-context plan review — becomes accepted on owner plan approval of TASK-20260904-app-sharing; Q1–Q7 in the task file may amend §2/§4/§6/§8)
- **Date:** 2026-09-04
- **Task:** TASK-20260904-app-sharing

## Context

An app a user built or installed lives only in their own `.snug` file. Nothing in the
product hands it to another person — not its code, not the connection shapes it needs,
not the wiki the app accumulated while it was built. The one per-app export in the tree
(`SHOW_APP_EXPORT`, hidden since TASK-20260813) is a SQLite *data* slice, byte-identical
in shape to a whole user file; the desktop open path cannot tell them apart and would
offer to **replace** the recipient's entire file — a latent data-loss shape (verified:
`exportDb.ts:30` emits SQLite magic, `openFile.ts:34,84` confirms then replaces).

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
hosted relay for links is its own decision (ADR-0064). **ADR-0018 D3** forbids LLM
system-slot text arriving on an untrusted channel (§8).

## Decision

1. **A shared app is a starter that travels.** The receiving side reuses the starter
   machinery wholesale: a card on the hub shelf, a read-only preview route
   (`shared--<bundleId>` beside `starter--<folder>`), the same install act
   (`installApp` with an `install_source` identity, factory-pinned v1, absent-only doc
   seeding per ADR-0035, `declared` connection rows), and the same offered-only update
   act (ADR-0045) generalized to take its bytes from a bundle. The hub still never
   writes; the write acts live in the run header.
2. **The bundle is JSON, strict at the boundary, and it is still a `.snug` file.**
   `snug-app-bundle/1` is an internal-draft schema in `packages/protocol`
   (`strictObject` at every level, size caps, OUT of `schemas/` like the net frames and
   the connection requirement). It carries: app identity fields; the **current version's
   html only**; the registered schema DDL (structure, never rows — every entry must be a
   `CREATE …` statement, and a replay failure fails the install rather than shipping an
   app whose first query is `no such table`); the wiki docs (each doc opt-out; `memory`
   off by default because it is defined as what the app learned about the user); every
   **non-revoked** connection's **requirement half only** — exported as the **bare
   borrower** (`slot`, provider name, kind, hosts, scopes) whenever the provider resolves
   to a registry entry, so the recipient's registry substitutes its own pinned seats
   instead of trusting the sharer's copy; and, only if the owner accepts Q6(b), the
   runtime contract as *reviewed text* (§8). It never carries: `snug_secrets`, grant
   fields (`status`, `allowed_hosts`, `approved_at`, pending edits, `imported`,
   `confidence`), earlier versions, chat, app data rows, per-app settings, the sharer's
   collected LAN address, or a `userLayer`. A credential-shaped literal in the html or a
   doc raises a **named warning** with "share anyway" — never a silent rewrite, and not a
   hard refusal, because the sharer owns the code and the shipped starters themselves
   trip a naive scan. The file kind is decided by the first bytes (`SQLite format 3\0` ·
   `SNUGENC1` · `{`), which is exactly the sniff the open path needs to stop offering to
   replace a user's file; the hidden SQLite per-app export is deleted.
3. **The bundle is the untrusted declaration channel, with its own name.** Connections
   land through `admitConnectionRequirement({ channel: 'shared' })` — a sixth admission
   channel and a sixth persisted provenance `'shared'`. This is an enum widening on a
   TEXT column enforced at write time — **no `USERDB_SCHEMA_VERSION` bump**, the
   `linked_device` precedent; a bump would make every fielded v6 hub refuse the file and
   throw sync pulls into `BAD_IMPORT` for users with no shared row at all. Not
   `'starter'` reused: that would make a stranger's declaration read "ships with this
   starter, as its author wrote it" — ADR-0016's rejected alternative D (trust
   laundering) one layer down. The wizard reviews the persisted row on the one strong
   review screen every non-registry provenance gets, with honest copy: *a shared app
   proposed this — its author wrote it, not Snug.* Every ADR-0016 guard applies: borrow
   ban, confusable guard, `userLayer` refusal, approval as the only grant writer — and it
   is exercised at the db write boundary through the playground's composition-root gate,
   which is where the borrow ban actually lives (`defaultAdmissionGate` is Guard 1 only).
4. **Received bundles are inert until install, and memory-first.** A received bundle
   lives in a module store; it is persisted as a `snug_settings` row
   (`sharedApp:<bundleId>`) only after an explicit act — opening an attachment, or
   clicking *keep* on a link preview — never on a bare link visit, so a drive-by URL
   cannot write third-party bytes into the user's file. The shelf is capped and the cap
   **refuses with a note** rather than evicting a share the user never saw. Until
   install no app, version, connection, doc or migration row exists for it, no DDL runs,
   and nothing from it is rendered as HTML. A **shared preview runs without the LLM
   transport** (a starter keeps its transport for the pillar demo; a stranger's code
   must not spend the user's tokens on a click) — an explicit "run with AI" arms it.
5. **Identity: `bundleId` is content, `lineage` is origin.** `bundleId` = sha-256 of the
   canonical bundle, **computed by the receiver, never carried as a field** (dedup; the
   same bundle twice is a no-op; a re-share cannot spoof it). `lineage` = the sharer's
   app id (a random UUID, no personal data); `install_source = 'share:<lineage>'` is
   minted by the installer from a UUID-charset field, so a bundle can never spell a
   starter's `starter:<folder>` identity and `starterDeclaration`'s two-fact vouch is
   unreachable from a bundle. The installed bundle id is recorded per app
   (`sharedBundle:<appId>`, cascaded on delete) so an update is detected by id, never by
   byte-equality of the html (lesson 2026-08-21: docs-only releases hide behind bytes).
   A re-share by a recipient forks: their app id becomes the lineage.
6. **Two transports, one bundle.** The attachment path has no server anywhere: download
   through the one `downloadBlob` dispatch (desktop consent-scoped save / web anchor) plus
   the OS share sheet where `navigator.canShare({ files })` allows it; receive by
   double-click (the one Rust delivery is unchanged; the platform seat is renamed
   `onOpenSnugFile` because it now delivers either kind, and a TS dispatcher sniffs and
   routes above it — no new IPC command) or by the Settings "add shared app" picker. The
   link path (ADR-0064) encrypts the same bytes client-side and keeps the key in the URL
   fragment.
7. **The desktop is offered, never auto-launched.** A link page always renders the
   in-browser preview; on macOS it additionally offers "open in Snug for Mac" (the
   `snug://` scheme, delivered through `tauri-plugin-deep-link`'s own seats and
   validated in TS — a URL is data, not a read capability). No browser exposes "is the
   app installed", Safari alerts on an unregistered scheme, and Chrome interposes its
   own prompt — an auto-attempt would be a worse first impression than a button. The
   link page strips the key from the address bar after reading it.
8. **The runtime contract is the one open trust question (Q6).** ADR-0018 D3 forbids
   system-slot text arriving on an untrusted channel, and `importUserDb` drops foreign
   contracts for that reason. Either the shared app runs on the lean generic layers
   until re-authored (a), or — recommended — the contract travels and is admitted only
   through the preview-then-install act, rendered verbatim as plain text under "what
   this app tells the AI" before install, amending ADR-0018 for this one channel (b).

## Alternatives considered

- **SQLite bundle (a sparse user DB holding one app).** Reuses the db code but keeps the
  file byte-indistinguishable from a user file except by opening it, validates "whatever
  the tables allow" rather than a strict boundary schema, costs ~100 KB of page overhead
  per share, and cannot be the relay payload without a second format. Rejected.
- **Reuse the `'starter'` provenance for shared declarations.** Zero protocol change;
  dishonest review copy and an install-source namespace collision. Rejected (D above).
- **Bump `USERDB_SCHEMA_VERSION` for the new provenance.** Honest-looking, and it
  would have stranded every v6 hub in the field. Rejected (plan review, finding 4).
- **Ship data rows as "sample data".** The examples contract already keeps sample mode
  inside `app.html` (deterministic, inert, render-only), so sample data travels for free;
  host-side rows are the user's real data and the one thing a share must never carry.
  Rejected. (Builder-seeded reference rows live in the migration log, not the registry,
  and do NOT travel at v1 — stated in the share sheet; an opt-in that ships the log is
  a follow-up.)
- **A separate `.snugapp` extension.** Avoids the sniff at the cost of a second file
  association and a second thing to explain; the sniff is three byte comparisons and is
  needed anyway to retire the latent replace-your-file shape. Default `.snug`; owner
  may flip (task Q2).
- **Persist every received bundle on receipt.** Simpler shelf semantics; lets any
  visited link write up to 1 MiB of third-party content into the user file with no
  click, and thirteen visits evict the user's real inbox. Rejected for memory-first +
  explicit keep.
- **Sniff the file kind in Rust with a second command and event.** More IPC surface
  (gate rows, a second cold-start pull) for no security gain — the TS gate already
  refuses non-user-file bytes before any confirm. Rejected for a TS dispatcher.

## Consequences

- `architecture.md` §"Who may propose a connection" gains a fourth row: **the share act ·
  bundle `connections[]` · always strong, `shared` channel.**
- No storage version bump; SPEC-1.0 §8.2's provenance line and the spec-changelog
  record the enum widening. `provenanceCopy` keeps compile-time exhaustiveness and
  gains a runtime fallback for values a newer file may carry.
- `RunView`'s "unowned" branches become one `isUnownedId` predicate (starter OR shared);
  `isSharedId` additionally strips the LLM transport; starter-specific branches keep
  `isStarterId`.
- Two generic install functions (declare connections, seed docs) replace the
  starter-only ones, which become thin wrappers; the generic declare accepts the
  `'shared'` provenance only. "Update · keeps your data" is one act with two sources.
- Phase-2 link records split by sensitivity: the public `{ appId, id, expiresAt }` in
  `snug_settings`; the revoke token and the key in `snug_secrets` under `share:`, which
  hub-origin sync and default exports never carry.
- A third party can now author code that runs in the user's hub. C2's sandbox is the
  defense and is unchanged; the threat-model delta names the residuals (LLM token spend
  only after "run with AI" or install; a connection the user may approve after strong
  review; mutating connected calls still confirm; third-party system-slot text iff §8b).
- Spec impact: internal draft only. Promotion of `snug-app-bundle/1` to `schemas/` is a
  separate spec-sync when a second implementation wants it.
