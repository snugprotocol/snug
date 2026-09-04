# TASK-20260904-app-sharing: Share an app by link or by `.snug` attachment — a portable starter anyone can install

- **Status**: draft — **STOPPED at Gate 2 for plan approval** (interview questions below; plan written under stated assumptions)
- **Owner**: Jeetu
- **Risk tier**: **high** — touches `packages/protocol` (new internal-draft app-bundle format + a sixth connection provenance, userdb v7), `packages/auth` (untrusted declaration channel — the exact channel ADR-0016 clause 6 anticipated), C1 negative tests (a bundle must never carry a credential), the desktop shell's open-event allowlist + a new `snug://` URL scheme (IPC surface), and — if the owner accepts Q1 option A — a **new hosted surface** (the first since ADR-0013). High extras: negative tests · fresh-context AI plan review BEFORE implementation · journal self-sign-off.
- **Branch**: `feat/TASK-20260904-app-sharing`
- **Packages touched**: `packages/protocol` (High), `packages/auth` (High), `packages/db` (Medium), `apps/playground` (Medium), `apps/desktop` (High — shell), NEW `apps/share-relay` (Cloudflare Worker, phase 2, gated on Q1), docs/ADRs/threat-model delta/runbook.
- **Spec impact**: internal-draft only — userdb schema **v6 → v7** (`provenance` gains `shared`; SPEC-1.0 §storage lists the enum and "currently 6") + a new internal-draft `app-bundle` format (OUT of `schemas/`, the net-frames/connection-requirement precedent) → [SPEC_SYNC.md](../../engineering/SPEC_SYNC.md) step + [spec-changelog](../../spec-changelog.md) entry + `check-website-sync` will name the docs pages owed. No published `schemas/` change, no `gen:schemas`.
- **Related**: ADR-0013 (hosted hub is static — the link path needs an amendment, Q1), ADR-0016 (trust ladder — clause 6 names this task's channel and its two prerequisites, BOTH landed: confusable guard `connection-requirement.ts:296-301`, borrow ban `requirement-admission.ts:631-707`), ADR-0017 (requirement/grant split — what a bundle may carry), ADR-0035 (starter docs ingestion — the install-time doc seeding we reuse), ADR-0042 (`.snug` canonical), ADR-0045 (starter versioning + update act — the model for "install / update from a bundle"), ADR-0052 (the hosted-receiver argument this task must re-win or avoid), ADR-0054 (deploy tooling — a Worker would be its first non-Pages target), lessons 2026-08-18 (namespaced settings keys owe a cascade), 2026-08-23 (never reuse a purpose-named seam as its generic self), 2026-08-26 (overlays from the header must portal); `product-vision.md` roadmap line lists "hub features (pin/share/install)" as post-launch community work — this task pulls **share** forward (owner ask 2026-09-04).

## Spec (what & why)

Today an app a user built (or installed) lives only in their own `.snug` file. There is no way to hand it to another person — not the code, not the connection shapes it needs, not the wiki the app accumulated while it was built. The only per-app export in the tree (`SHOW_APP_EXPORT`, hidden) is a SQLite data slice that is byte-indistinguishable from a whole user file; double-clicking it today would offer to **replace** the recipient's entire file. That latent bug is the first thing this task retires.

This task adds **app sharing**: from the app's own header, one share control produces a **standalone app bundle** — the app's current code, its connection requirements *as shapes* (never a credential, never a grant, never the user's LAN address), its runtime contract, its registered data schema (structure, no rows), and — on by default, one toggle — every wiki doc the app accumulated (vision, requirements, plan, lessons, memory, next-tasks, build-prompt). Everything personal stays home by construction: app data rows, secrets, version history, chat threads, model pins. The bundle travels two ways: as a **link** (phase 2 — hosted, but *blind*: the bundle is AES-256-GCM encrypted in the sharer's browser, the relay stores ciphertext it cannot read, and the key rides only in the URL fragment which never reaches any server) or as a **`.snug` attachment** the sharer sends however they like (phase 1 — no server anywhere). On the receiving side — a person who may never have seen Snug — the bundle appears as a card in a new **"shared with you"** shelf between "your apps" and "starter apps", opens read-only exactly as a starter does (browse the app, read its docs), and installs with the same install act starters use. The install is find-or-create on a share lineage, so a re-share of an improved app is offered as an **update that keeps the recipient's data** (ADR-0045's channel, generalized).

The framing that makes this small: **a shared app is a starter that travels.** The hub already knows how to show, preview, install, declare connections for, seed docs into, and update a starter. This task adds the untrusted-origin version of that path, with the review posture ADR-0016 already specified for it.

**Interview (owner) — answers pending; plan written under the stated defaults:**

- **Q1 — the link's host.** The hosted playground has no backend (ADR-0013) and `apps/server` is not deployed anywhere; ADR-0052 rejected a Cloudflare Worker receiver by name. Pick one:
  - **A (recommended) — a *blind* relay.** A ~150-line Cloudflare Worker + R2 bucket (`apps/share-relay`, same Cloudflare account as the Pages deploys) that stores **ciphertext only**, ≤ 1 MiB per bundle, 30-day TTL, unguessable 128-bit ids, IP rate-limited, no listing, no accounts, no logs of content. The key never leaves the link's fragment, so "we collect nothing" survives *in substance* (the relay cannot read what it holds) and the falsifiability claim becomes "one blind endpoint, verifiable by reading the Worker". Needs **ADR-0064 amending ADR-0013**; deployed only on an explicit owner ask (release rules); owner operates it. Residual: a 1 MiB encrypted blob drop is a generic anonymous file host for 30 days — mitigated by the cap, TTL and rate limit, and stated as accepted.
  - **B — self-contained links (zero backend).** The compressed bundle rides in the URL fragment. Works in Chrome/Firefox/Safari/iMessage/WhatsApp/Gmail; **breaks on Telegram (4 096 chars), Discord (2 000), SMS, X, and Outlook line-wrapping** — a typical bundle is 15–30 KB of URL. Rejected as the primary path; can be kept as a hidden self-hoster fallback if wanted.
  - **C — attachment only at launch; link parked** (ADR-0052's shape). Phase 1 ships either way; the link is phase 2.
  - **Not viable:** running `apps/server` in production for this — a whole authenticated server for one blob store contradicts ADR-0013 and costs far more than A.
- **Q2 — the file extension.** `.snug` for bundles too (one brand, one Finder icon; the file's first bytes say what it is — the desktop open path sniffs SQLite / `SNUGENC1` / JSON and routes), or a distinct `.snugapp` (a second file association; no sniff needed). **Default: `.snug`.**
- **Q3 — update semantics.** When a recipient already installed an earlier bundle from the same lineage, offer "update · keeps your data" (new pinned version via ADR-0045's `saveAppVersion({pinned, contract})`, docs absent-only, declared-only connection refresh) — or only "open installed / install as a copy" at v1? **Default: include the update act** (AC12); it is ~60 lines on an existing act and is what makes sharing a *living* channel.
- **Q4 — Settings import.** A third button "add shared app" beside export/import (your ask), with BOTH importers sniffing and pointing at each other on a mismatch — or one sniffing "import" that confirms differently per kind? **Default: third button + mutual sniff.**
- **Q5 — link lifetime & size.** 30 days / 1 MiB ciphertext (phase 2). Revocation: the upload returns a revoke token the sharer's file keeps (`shareLink:<id>` row) so the share sheet lists active links with "revoke". Include at v1? **Default: yes** (AC15).

**Acceptance criteria** (each becomes at least one test; **negative tests** marked N):

*Format + export (packages/protocol, packages/db)*
1. `appBundleSchema` (internal draft, `packages/protocol/src/app-bundle.ts`, `strictObject` at every level, `format: 'snug-app-bundle/1'`) parses a well-formed bundle and rejects: unknown keys anywhere, a missing/other `format`, `html` over `MAX_BUNDLE_HTML_BYTES`, more than `MAX_BUNDLE_DOCS` docs, a doc slug outside `APP_OBJECT_NAME_RULE`-class charset, any connection whose requirement fails `connectionRequirementSchema`, a `userLayer` on any connection (registry-only seat), a total serialized size over `MAX_BUNDLE_BYTES`.
2. `exportAppBundle(db, appId, { includeDocs })` returns a bundle carrying: `app { displayName, description?, iconEmoji?, iconColor?, usesDb }`, `html` = the **current** version's bytes only, `contract` = the current version's runtime contract when present, `schema.ddl[]` = the registered schema's object DDL verbatim (no rows), `docs[]` iff `includeDocs`, `connections[]` = the **requirement half only** of every `snug_connections` row for the app, `lineage = appId`, `sharedAt`, `producer { hubVersion }`.
3. **(N, C1)** Export byte-scan: with an approved connection whose secrets live in `snug_secrets` (`auth:<appId>:<slot>:*`) and an approved `allowed_hosts`, the serialized bundle contains **none** of: the secret values, `allowed_hosts`, `approved_at`, `status`, `pending_requirement_json`, `imported`, `confidence`, any `snug_chat_*` content, any earlier version's html, any app data row, any `snug_settings` value (`appModel:`, `appProvider:`, `starterVersion:`, `appRenamed:`), or the sync sidecar.
4. **(N)** Export strips user-collected LAN facts: a `lanHost` requirement whose `declaredApiHosts` holds the collected RFC-1918 literal exports with `declaredApiHosts` **absent** (the recipient collects their own); a requirement carrying `userLayer` exports without it.
5. Export refuses, naming the location, when `html` or any included doc matches a credential shape (`security/credentialShapes.ts`, the single-homed pattern set — `display` mode) — never silently rewrites; the sheet offers "share without docs" when the hit is in a doc.

*Install (packages/db, packages/auth, apps/playground)*
6. `installAppBundle(db, bundle)` creates the app via `installApp` with `installSource = 'share:<lineage>'` (find-or-create — a second install of the same lineage returns the existing app, AC12 decides what happens next), pins v1 as factory, writes the contract via `putRuntimeContract` (validated by `runtimeContractSchema`; drop-on-failure like starters), replays `schema.ddl` through `applyAppDdl` (best-effort, name-gated, forbidden statements refused — the app's own runtime DB, never the user DB), seeds docs **absent-only** (ADR-0035 rule; a re-install never clobbers the recipient's edits), and lands every connection as a **`declared`** row with **`provenance: 'shared'`** through `putDeclaredConnection` after `admitConnectionRequirement(req, { channel: 'shared' })` — an admission refusal drops THAT slot with a visible note and never the install.
7. **(N)** `'shared'` admission: `userLayer` refused; a borrow hit (name OR host intersection with a registry entry) that authors `fields` / `request.headerTemplate` / `testRequest` is refused outright; a borrower that omits them receives the registry's pinned seats; `provider.name` must be printable ASCII + NFC (confusable guard) — all pinned by tests on the new channel, not inherited by assumption.
8. `CONNECTION_PROVENANCES` and `ADMISSION_CHANNELS` both gain `'shared'` (their structural-equality pin stays green), `USERDB_SCHEMA_VERSION` → 7 with a no-op forward migration (v6 files open; a v7 file is refused by a v6 hub — the existing newer-file refusal, test-pinned), and `ConnectionWizardSheet.provenanceCopy` gains the case (the exhaustive `switch` makes this a compile error, not a convention): *"a shared app proposed this — its author wrote it, not Snug. Check every host against what you know before you approve."* The wizard opens a `shared` row on the strong field-by-field review; **(N)** there is no path by which a `shared` row renders the registry's light approve-as-is copy.
9. Import dedup + starter identity: **(N)** a bundle can never claim a starter's identity — `installSource` is always minted from `lineage` with the `share:` prefix; a bundle whose `lineage` spells `starter:x` or contains `:` is rejected by the schema (`lineage` = UUID charset only), so `starterDeclaration`'s two-fact vouch is unreachable from a bundle.

*Sharer surface (apps/playground)*
10. The run header shows a share control (`aria-label="share"`, glyph `⇪`, `btn-icon`, title "share this app — code, connection shapes and docs; never your data or keys") **between the connections control and the theme toggle**, for **owned apps only** (never on a starter or shared preview). `runHeaderIcons.test.tsx` pins the order. Clicking opens a `ConfirmOverlay` share sheet (portal — lesson 2026-08-26) listing what travels (code size, N connection shapes, N docs, N tables — structure only) and what stays home, with the docs toggle (on by default), and the actions: **copy link** (phase 2, hidden when no relay is configured), **download `.snug`**, and **share…** via `navigator.share({ files })` where `navigator.canShare` says so (mobile OS sheet, macOS AirDrop) — hidden elsewhere.
11. Download produces `<sanitized app name>.snug` through the ONE `downloadBlob` dispatch (desktop = `export_user_bytes` consent-scoped save, web = anchor), MIME `application/json`.

*Receiver surface (apps/playground)*
12. The hub renders a **"shared with you"** section between "your apps" and "starter apps" **only when the inbox is non-empty**; each card (same `app-tile` shape; `data-testid="shared-tile"`) shows emoji/name/blurb, a `shared` badge, dismiss, and opens `/run/shared--<bundleId>`. If the lineage is already installed the card says `installed` and opens the installed app; if the bundle differs from the installed newest-pinned version it says `update` and the run header offers "update · keeps your data" (ADR-0045's act generalized: new pinned version + contract in one `saveAppVersion` call, docs absent-only, declared-only connection refresh; an edited copy updates only through the existing confirm dialog).
13. `/run/shared--<id>` is a read-only preview: HTML loaded from the inbox, no chat lane, no open-url, no connections door (the same `isUnownedId` gating starters get — one predicate, `isStarterId(id) || isSharedId(id)`, replacing the twelve `isStarterId` "unowned" branches while the starter-specific branches keep `isStarterId`), the rail shows the bundle's docs read-only, and the header carries the primary `install` button + the disclosure line "shared app · preview · nothing is saved until you install". Install → `installAppBundle` → navigate to `/run/<newId>` (replace) → the inbox row is removed.
14. The inbox persists in the user file as `snug_settings` rows `sharedApp:<bundleId>` (single-homed key builder in `app-settings-keys.ts`; NOT app-scoped, so no `deleteApp` cascade — stated in the module doc), capped at `MAX_SHARED_INBOX = 12` (oldest evicted) and `MAX_BUNDLE_BYTES` each; `resetThreadSessions`-class seams untouched (inert data). Receiving the same `bundleId` twice is a no-op that re-opens the card.
15. Settings "your file" gains **add shared app** (label-wrapped hidden file input, `accept=".snug,application/json"`) beside export/import. **Both importers sniff** (`sniffSnugFile(bytes)` → `'user-file' | 'app-bundle' | 'unknown'` from the first non-whitespace bytes: SQLite magic / `SNUGENC1` / `{`): a bundle handed to "import snug file" routes to the inbox with a note ("that's a shared app — added to shared with you"), a user file handed to "add shared app" is refused with a note pointing at the other button. **(N)** a bundle can never reach `importUserFile`.
16. **(N)** A received bundle is inert until install: no HTML from it is written anywhere, no connection row exists, no DDL runs, no contract is stored, and nothing in it is rendered as HTML (names/blurbs/doc text render as text nodes) — pinned by a hostile-bundle test whose every string is `<img onerror>`.

*Desktop shell (apps/desktop)*
17. The `.snug` open path sniffs in Rust before announcing: SQLite/`SNUGENC1` → the existing `snug:opened-files` path unchanged (test-pinned byte-for-byte); JSON → a new single-use allowlisted `read_opened_bundle` command + `snug:opened-bundles` event (paths only; bytes flow through the command; ≤ `MAX_BUNDLE_BYTES` read cap; same `pending_*` cold-start pull). **(N)** a bundle can never reach `read_opened_file`/`importUserFile`; the argv/URL-shaped rejections in `openfile.rs` stay pinned. Platform seam gains `onOpenAppBundle` — a NEW seat, never an overload of `onOpenUserFile` (lesson 2026-08-23).
18. (Phase 2) `tauri-plugin-deep-link` registers `snug://`; `RunEvent::Opened { urls }` branches on scheme BEFORE `to_file_path()` (today a `snug://` URL is silently dropped by the `filter_map`); URLs go through a single-use allowlist (`snug://s/<id>#<key>` shape only — strict charset/lengths; anything else inert) and a `snug:opened-links` event; the platform seam gains `onOpenShareLink`. The shell gate gains the keyless-refusal probe rows for every new command (lesson 2026-08-21). `capabilities/main.json` adds `deep-link:default`; no widening of `http:default` (`https://**` already covers the relay).

*Link path (phase 2, gated on Q1 = A)*
19. `share/bundleCrypto.ts`: `encryptBundle(bytes)` → `{ id, key, ciphertext }` (WebCrypto AES-256-GCM, 96-bit nonce prefix, 256-bit key, id = 128-bit random base64url); `decryptBundle` round-trips; **(N)** a flipped byte or a wrong key fails closed; **(N)** the key appears in NO request URL, header or body (a fetch-spy test over `relayClient.upload`).
20. Link format `https://playground.snugprotocol.org/s/<id>#<key>` (`config/site.ts` single-homes the relay origin + the share path; absent relay origin ⇒ the copy-link action is not rendered); route `/s/:id` (`SharedLinkView`, router-aware reads — `useParams` + `useLocation().hash`, never `window.location.search`) fetches, decrypts, validates, writes the inbox row and navigates to the preview; a 404/expired/undecryptable link renders a named error ("this link has expired or was revoked") with no retry loop. On macOS the page offers **"open in Snug for Mac"** (fires `snug://s/<id>#<key>`) beside the in-browser preview — never an auto-launch (Safari alerts on unregistered schemes; there is no installed-app detection API); the preview is always rendered.
21. `apps/share-relay` Worker: `POST /v1/bundles` (octet-stream ≤ 1 MiB → `{ id, expiresAt, revokeToken }`), `GET /v1/bundles/:id` (immutable, `Cache-Control: private, max-age=0`, 404 after TTL), `DELETE /v1/bundles/:id` with the revoke token; CORS allowlist = playground origins + `tauri://localhost`; every other method/path 404; no listing; ids server-minted. Tests run the handler against an in-memory R2 stub (size cap, method gating, id grammar, TTL, CORS, revoke). Deploy: `scripts/deploy-relay.mjs` (wrangler, first `wrangler.jsonc` in the repo, ADR-0054 discipline: print-and-stop unless `--deploy`, journaled), runbook `docs/runbooks/deploy-share-relay.md`. **Never deployed without an explicit owner ask.**
22. The share sheet's copy-link flow: build → encrypt → upload → show the link in a read-only field with an inline copy control (`⧉`, "copied ✓" for 2 s; `navigator.clipboard?.writeText?.` defensive form), the sentence *"anyone with this link can install this app until <date>. The link is the key — we can't read what's inside."*, and the app's active links (from `shareLink:<id>` rows) with **revoke**.

*Docs*
23. ADR-0063 "App sharing: a shared app is a starter that travels" (format, trust rung, inbox, update generalization); ADR-0064 "One blind relay" amending ADR-0013 (only if Q1 = A); `docs/security/threat-model-delta-app-sharing.md`; architecture §"Who may propose a connection" gains the fourth row (**the share act · bundle `connections[]` · always strong, admitted on the `shared` channel**); code-map rows; spec-changelog entry (userdb v7 + app-bundle internal draft); SPEC-1.0 storage section (provenance enum, "currently 7"); `/sync-website` if the gate names pages; next-steps pruned; lessons at Gate 6.

**Out of scope**: sharing app DATA rows (even "sample rows" — sample mode is in-app code by the examples contract, so it travels inside the HTML for free); sharing version history or chat threads; a public gallery/discovery surface; QR codes (needs a dependency — follow-up); drag-and-drop onto the hub (follow-up); Windows desktop (parked, ADR-0021 D8); universal links / `apple-app-site-association` (custom scheme only); signing bundles or any author identity (a bundle is anonymous by design at v1); publishing the app-bundle format to `schemas/` (internal draft first, promotion is its own spec-sync); Turnstile on the relay (IP rate limit at v1; Turnstile queued if abuse appears).

## Plan

### Design in one picture

```
 sharer (owned app, run header)                      recipient (any device, maybe not on Snug)
 ┌──────────────┐  exportAppBundle   ┌────────┐      ┌──────────────┐  inbox row   ┌────────────────┐
 │ ⇪ share sheet├──────────────────►│ bundle │──┬──►│ /s/<id>#key  ├────────────►│ shared with you │
 │  ☑ docs      │  scrub → refuse    │ (JSON) │  │   │ (web) or     │             │ card → preview  │
 └──────────────┘                    └────────┘  │   │ snug:// (mac)│             │ → install/update│
        │ download .snug ─────────────────────────┼──►│ double-click │             └───────┬────────┘
        │ share… (OS sheet / AirDrop)              │   │ or Settings  │                     │ installAppBundle
        └─ copy link: encrypt(key) → relay(id) ────┘   └──────────────┘             starter install chain,
                       key stays in the fragment                                    'shared' provenance
```

**Bundle = JSON, `.snug`.** Not a SQLite slice: a strict zod schema at the boundary (C5), one payload for both link and file, human-diffable, and the file kind is decidable from the first byte (`{` vs `SQLite format 3\0` vs `SNUGENC1`) — which is exactly the sniff the desktop open path needs to stop offering to replace a user's file. Shape (internal draft, `packages/protocol/src/app-bundle.ts`):

```
{ format: 'snug-app-bundle/1', bundleId, lineage, sharedAt, producer: { hubVersion },
  app: { displayName, description?, iconEmoji?, iconColor?, usesDb },
  html, contract?, schema?: { ddl: string[] },
  docs?: [{ slug, title?, content }], connections: [{ slot, requirement }] }
```
`bundleId` = sha-256 of the canonical bundle minus `bundleId` (content identity → the inbox dedup and the "same bundle twice" no-op). `lineage` = the sharer's `app_id` (a random UUID, no PII; a re-share by the recipient forks — their own app id becomes the lineage; that is the least surprising reading of "the app I got from Alice" vs "from Bob").

**Trust.** The bundle is the untrusted declaration channel ADR-0016 clause 6 named. Its two prerequisites are landed; this task adds the sixth provenance/channel `'shared'` so the review copy is honest (never `'starter'` — that would be the trust laundering alternative D rejected) and routes every declaration through `admitConnectionRequirement({ channel: 'shared' })` at install AND at the db write boundary (`defaultAdmissionGate` re-runs it). The wizard already reviews the PERSISTED row and already treats every non-registry provenance as the strong path — so the shared rung is a copy string plus tests, not a new wizard mode. The HTML itself is exactly as trusted as an LLM-built app: C2's sandbox is the defense, unchanged; the threat-model delta states the one NEW thing (a third party authors code that runs in the user's hub) and its residuals (a shared app can spend the user's LLM tokens within its runtime contract; can ask for a connection the user may approve after strong review; mutating connected calls still confirm).

**Inbox.** `snug_settings` rows `sharedApp:<bundleId>` — a persisted "shared with you" shelf that survives reload and syncs with the file. Not app-scoped ⇒ no cascade owed (the lesson's obligation is for per-ENTITY keys; this key is per bundle and the bundle is deleted by dismiss/install). Cap 12, evict oldest.

**Read-only preview** rides the starter's route shape: `shared--<bundleId>` beside `starter--<folder>`; `isUnownedId` unifies the "unowned" branches in RunView; `loadPreviewHtml(id)` dispatches to `loadStarterHtml` or the inbox.

**Update** generalizes ADR-0045's act: `starterUpdate.ts`'s write act is extracted to take `{ html, contract, docs, connections, note }` from either a starter's artifacts or a bundle, so "update · keeps your data" is one act with two sources.

**Link (phase 2)** = blind relay + `snug://` (Q1). The playground's `/s/:id` page is the receiver on every platform; desktop is offered, never auto-launched.

### Phases + order (tests FIRST in each step, TDD.md)

**Phase 0 — docs first (this branch, before code)**
0.1 ADR-0063 draft (accepted on plan approval) · 0.2 threat-model delta skeleton with the invariant table (rows filled as tests land) · 0.3 ADR-0064 draft ONLY if Q1 = A.

**Phase 1 — attachment path (no hosted surface; shippable alone)**
1.1 `packages/protocol`: `src/app-bundle.ts` (schema, constants, `canonicalBundleId`), `src/connection-requirement.ts` (`CONNECTION_PROVENANCES` + `'shared'`), `src/userdb-schema.ts` (v7 + comment history line), `src/index.ts` exports; tests `__tests__/app-bundle.test.ts` (AC1, AC9), provenance pin update. **Spec-sync step**: `docs/spec-drafts/SPEC-1.0.md` storage §(provenance enum, "currently 7"), `docs/spec-changelog.md` entry; run `check-website-sync`.
1.2 `packages/auth`: `requirement-admission.ts` `ADMISSION_CHANNELS` + `'shared'`; tests AC7 on the new channel (every guard exercised explicitly).
1.3 `packages/db`: `userdb/app-settings-keys.ts` (`sharedAppSettingKey`, `shareLinkSettingKey`); `userdb/app-bundle.ts` (`exportAppBundle`, `installAppBundle`, `sniffSnugFile`); v7 migration no-op; tests AC2–4, AC6, AC8 (v7 refusal), AC14 sniff table (SQLite / SNUGENC1 / JSON / BOM+JSON / garbage / empty).
1.4 `apps/playground` sharer: `share/exportShare.ts` (scrub gate AC5), `share/ShareSheet.tsx` (ConfirmOverlay), `run/RunHeaderActions.tsx` (control between connections and theme, owned-only), `run/exportDb.ts` `downloadBlob` reuse; tests `__tests__/shareSheet.test.tsx`, `runHeaderIcons.test.tsx` (order), AC10–11.
1.5 `apps/playground` receiver: `share/sharedInbox.ts` (store over the settings rows, cap/evict, `SHARED_PREFIX = 'shared--'`, `isSharedId`, `loadSharedBundle`), `views/HubView.tsx` (section + cards), `run/RunView.tsx` (`isUnownedId`, `loadPreviewHtml`, install button + disclosure, docs tab read-only), `share/installShared.ts` (mirrors `installThisStarter`, `mounted` ref per the 2026-09-03 lesson), `views/SettingsView.tsx` (add shared app + mutual sniff), `platform/openFile.ts` (bundle branch) ; tests AC12–16 incl. the hostile-bundle render test; `ConnectionWizardSheet.tsx` provenance copy (AC8).
1.6 `apps/desktop`: `src-tauri/src/openfile.rs` sniff + `read_opened_bundle` + `pending_opened_bundles`; `lib.rs` announce split; `platform-desktop.ts` `onOpenAppBundle`; Rust tests (sniff table, allowlist single-use, argv/URL inert pin unchanged); gate rows for the new command; `pnpm --filter desktop test` + `test:rust` + `gate` on macOS.
1.7 e2e: `e2e/share.spec.ts` — build → share sheet → download → Settings add → shared tile → preview → install → tile in "your apps" → connection row `declared`/`shared` → wizard strong copy; `dedup.spec.ts` gets the shared-tile strict selector.

**Phase 2 — link path (only after Q1 = A and ADR-0064 accepted)**
2.1 `apps/share-relay` Worker + tests (AC21), `wrangler.jsonc`, `scripts/deploy-relay.mjs`, runbook.
2.2 `apps/playground/src/share/{bundleCrypto,relayClient}.ts` + tests (AC19), `config/site.ts` relay origin, `views/SharedLinkView.tsx` + route `/s/:id` (AC20), share sheet copy-link + active links + revoke (AC22), `shareLink:<id>` rows.
2.3 `apps/desktop`: deep-link plugin, scheme, `RunEvent::Opened` branch, `read_opened_link`, `onOpenShareLink`, capability, gate rows (AC18).
2.4 e2e: `share-link.spec.ts` with the relay route-mocked (`page.route`), bad key / expired paths.

**Phase 3 — Gate 5/6**: full root `pnpm test` (protocol change ⇒ everything) + desktop gate; fresh-context AI diff review (High); threat-model delta finalized; code-map/architecture/next-steps/lessons; `/close-session`.

### Cross-package impact (architecture.md graph)
`protocol` changes ⇒ run everything. `auth` ⇒ `auth` + `playground`. `db` ⇒ `sdk` + `playground`. `desktop` consumes all ⇒ `pnpm --filter desktop test` + `test:rust` + `gate`. Website: `check-website-sync` after the SPEC-1.0 edit; `product-vision.md` untouched unless the owner wants "share" in the v1 scope line (then `/sync-website`).

### Test plan summary (tests FIRST)
| AC | Suite | Kind |
|---|---|---|
| 1, 9 | `packages/protocol` `app-bundle.test.ts` | schema strictness, lineage grammar (N) |
| 2–4 | `packages/db` `app-bundle.test.ts` | export content; C1 byte-scan (N); LAN/userLayer strip (N) |
| 5 | playground `shareScrub.test.ts` | refusal names location; docs escape hatch |
| 6, 8 | `packages/db` `app-bundle.test.ts`, `migrations.test.ts` | install chain; v7 refusal; provenance pin |
| 7 | `packages/auth` `requirement-admission.test.ts` | every guard on `'shared'` (N) |
| 8 | playground `wizardProvenanceCopy.test.tsx` | shared copy; never light path (N) |
| 10–11 | playground `runHeaderIcons.test.tsx`, `shareSheet.test.tsx` | order, gating, download dispatch |
| 12–14 | playground `hubShared.test.tsx`, `sharedPreview.test.tsx`, `sharedInbox.test.ts` | section, cards, preview gating, cap/evict, hostile render (N) |
| 15 | playground `settingsSharedImport.test.tsx`, `openFile.test.ts` | mutual sniff; bundle never reaches importUserFile (N) |
| 17–18 | desktop Rust tests + `gate` | sniff, allowlists, keyless probes (N) |
| 19–22 | playground `bundleCrypto.test.ts`, `relayClient.test.ts`, `sharedLinkView.test.tsx`; `apps/share-relay` tests | round-trip, tamper (N), key-never-sent (N), relay contract |
| e2e | `share.spec.ts`, `share-link.spec.ts`, `dedup.spec.ts` | the two journeys in a real browser |

### Fresh-context plan review (High tier)
Run BEFORE implementation, after owner approval of the interview defaults; findings folded into this file under Decisions & surprises.

## Decisions & surprises

- **2026-09-04 — ADR-0013/ADR-0052 are the link path's real constraint, not the tooling.** The playground is static (Pages direct upload, no Worker/KV/R2 anywhere in the repo); `apps/server` is never deployed. A blind (E2E-encrypted) relay is the only hosted shape that keeps "we collect nothing" true in substance; it still needs its own ADR and an owner call (Q1).
- **2026-09-04 — the hidden per-app export is a latent data-loss shape.** `SHOW_APP_EXPORT` (hidden) produces a SQLite slice indistinguishable from a user file; the open path would offer to replace the recipient's whole file. The JSON bundle + sniff retires the shape; the hidden control is deleted in this task (its two e2e locators are already on the Settings export).
- **2026-09-04 — sample data needs no seat.** The examples contract keeps sample mode inside `app.html` (deterministic, inert, render-only); user data rows are the one thing a share must never carry. Schema DDL ships (structure), rows never.
- **2026-09-04 — `'shared'` is a new provenance, not `'starter'` reused.** Reuse would make a stranger's declaration read "ships with this starter, as its author wrote it" — ADR-0016's rejected alternative D. Cost: userdb v7 + spec-sync; accepted.

## Session journal (append-only, newest last)

### 2026-09-04 00:40 — Claude (Fable 5.1) — session (Gate 1–2)
- Done: read PROCESS/TDD/architecture/code-map/lessons + ADR-0013/0016/0045/0052; three code sweeps (UI surfaces; user-DB model + install chain + admission; desktop open path + hosted posture + deploy tooling). Task file written with spec, interview, 23 ACs, phased plan, test plan. Branch cut.
- State: **draft, stopped for plan approval.** No implementation code.
- Next step: owner answers Q1–Q5 (defaults stated) → fresh-context plan review → Phase 0 docs → Phase 1 tests.
- Open questions: Q1–Q5 above.
