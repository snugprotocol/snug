# Snug — Architecture

> Status: **implemented (living-apps evolution + hub ops + hub polish + observability/caching + Dynamic Auth v2 + lean runtime turns & intent-routed data chat + desktop distribution/update channel, pre-launch)** — 2026-08-21 (TASK-20260821-hardening-polish added the shell update channel + `/download`, ADR-0047; **threat model is at v3.0** — TASK-20260821-launch-security-review re-attacked the whole surface pre-launch, fixed four defects incl. one C1 credential leak, and its §9 states what that pass did NOT check); prior baseline 2026-08-15 (post-08-11 merges, each with its own section or ADR: registry-authoritative auth + multi-option auth kind ADR-0020 · desktop shell ADR-0021 · desktop-aware auth/LAN providers ADR-0022/0023 · think-rail ADR-0024 · LAN verify-before-claim ADR-0025 · connection-relative addressing ADR-0026 · registry-pinned scopes + provider-reason auth banner + pinned-URL console links ADR-0028/0029), TASK-20260804-observability-caching (on TASK-20260804-hub-polish (on TASK-20260803-hub-ops (on living-apps, TASK-20260803-living-apps, on portable-hub, TASK-20260803-portable-hub). Hub ops added: long-run builds (48-iteration ceiling — there was never a timeout), 30-minute server lifetimes, a build step timeline, an in-memory LLM round-trip inspector (a SIBLING of the structural frame inspector, never an extension), cascade app delete with a terminal-delete tombstone, and the LLM-optional app doctrine (ADR-0011)). Hub polish added: a header identity menu with the Google avatar, the ember-niche brand mark, one merged "think" rail surface, round-trip observability in the build view AND the app-frame transport, explicit starter install (a starter is read-only until owned), build-thread continuity, and CAS conflicts that reach the divergence resolver instead of throwing. Observability/caching added: LIVE round-trip observation (calls and tools appear as they start, each timed), the wire model name, prompt caching on the stable tools+system prefix of BUILDER turns only (a per-TURN request flag — the app-frame envelopes are below the cacheable minimum and deliberately excluded) (ADR-0012), cache-hit reporting as a cached %, and a rotating status line replacing the duplicate step timeline. The inspector's memory bound moved from a per-field ingest cap to a total-bytes budget so expanded payloads can be shown whole.) Three-actor model: LLM providers · hub providers · the end user who owns ONE portable SQLite file. Apps are LIVING: LLM-designed native data schemas (ADR-0010), app-attached chat with compounding per-app wiki docs, factory-pinned versions. Wire protocol unchanged at v1; storage/hub behavior is internal-draft schema v6 (`docs/spec-drafts/SPEC-1.0.md` — Specification 1.0, promoted from the v0.3 release candidate, TASK-20260822-spec-10-final; `userdb-schema.ts` is the truth). Auth broker (hosted credential custody) is deliberately unbuilt — RFC at 1.6, GA at 2.0 (roadmap v2, owner decision 2026-08-05); hub LOGIN shipped separately in `apps/server`. **SimpleFIN token-claim + the Ledger starter + the open-url capability (2026-08-18, ADR-0038)**: see the section below. **Per-app model selection (2026-08-18, ADR-0036)**: each app may pin its own LLM model and every app-scoped call for it routes there; storage is a namespaced `snug_settings` key, so the wire protocol and userdb schema are both unchanged (see the section below).
>
> **TASK-20260811 (ADR-0018/0019) added two protocol-level USPs.** (1) **Lean runtime
> turns**: an installed app's own LLM turns are assembled from a compact, version-pinned
> **runtime contract** (`snug_app_versions.runtime_contract_json`, userdb v6) instead of
> the app-BUILDER system assembly that used to ride every move — measured ~1.26 KB/turn
> saved, which is what makes a small local brain a viable host. The contract is
> host-assigned at both call sites, copied forward on edits, restored from the TARGET
> version on revert, and DROPPED on import (including sync pulls) unless byte-identical to
> one the hub already holds. (2) **Intent-routed app data chat**: a message beside an
> installed app is classified first, and the intent picks both the context assembled and
> the tools offered — data questions run LLM-authored SQL on a throwaway copy of the app's
> own database (isolation is physical, not a name guard), and data CHANGES are proposed
> with verbatim SQL and row counts, executing only on the user's approval after a
> re-validation that halts on drift. Wire protocol still v1; storage is internal-draft v6.

## Components

```
┌────────────────────── hub client (static files — no backend REQUIRED) ───────────────────┐
│                                                                                          │
│  chat UI ──► AgentTransport seam ──┬─ byok:  in-page runAgentTurn ──► provider API       │
│      ▲                             ├─ local: in-page runAgentTurn ──► localhost LLM      │
│      │ envelopes (JSON, v1)        └─ subscription: /invoke SSE ──► hub's adapter        │
│  packages/runner ◄─┘   bridge: iframe postMessage ↔ transport (host page ONLY — C1/C2)   │
│      │ sandboxed iframe (allow-scripts, connect-src 'none', CDN allowlist)               │
│      ▼                                                                                   │
│  micro app (single-file HTML, authored by LLM via packages/knowledge)                    │
│      │ useSnugApp / usePersistedState / useAppDB / useConnectedFetch   (packages/sdk)    │
│      │ net-request/net-response frames (AL-03, internal draft) ──► runner NetHandler ──► │
│      │   packages/auth connected-fetch executor (host-only fetch caller; injects creds,  │
│      │   scrubs responses; app iframe still has connect-src 'none' — C1/C2 intact)       │
│      ▼                                                                                   │
│  packages/db USER DB (ADR-0007/0010): ONE sql.js file/user — apps + versions (factory    │
│  pinned + 5 recent, revert/reset) + chats (bootstrap turn pinned) + per-app wiki docs +  │
│  schema registry + settings + secrets + per-app data as NATIVE app_<token>__* tables,    │
│  materialized into the app's own runtime DB at load (physical isolation preserved)       │
│      │  OPFS runtime copy (crash-safe A/B slots) · export/import (secrets stripped)      │
│      ▼                                                                                   │
│  packages/db sync (ADR-0009): SyncProvider → hub origin (/userdb CAS) | Dropbox | …      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
   packages/protocol = envelope/frames (v1) + net-request/net-response (AL-03 internal
     draft, own size class, NOT in schemas/) + userdb-schema.ts (spec v0.2 storage
     surface; v6 internal draft — v5: snug_connections, snug_auth_specs dropped; v6: runtime_contract_json)
     + auth-schema.ts + connection-requirement.ts (internal)
   apps/server (OPTIONAL hub) = /invoke + artifact cache + Google OIDC + /userdb + static
   packages/auth (AL-02/AL-03, ADR-0014) = Dynamic Auth pure core + connected-fetch
     runtime, LOCAL-FIRST: browser-safe DI-pure OAuth service + CredentialStore over the
     user file's snug_secrets `auth:` keys — credentials live in the USER'S file, never a
     server vault; host ceiling always strict (C1, no knob). The connected-fetch executor
     is the ONLY host-side fetch caller; injection is always strict (audit bug 3 dead by
     construction). Wizard/UI shipped in AL-04 (`apps/playground/src/connections/`).
```

**The user file is named `.snug` and may be PROTECTED (2026-08-20, ADR-0042 + ADR-0043).**
`.snug` became canonical on every platform (it was already the desktop OS association and
half-shipped: web exported `.sqlite` and its import picker did not even list `.snug`).
Renaming is read-only — `user.sqlite`, its sync sidecar and the Dropbox path are all read
when the canonical name is absent and adopted forward on the next write, never renamed or
deleted, because the alternative is a fresh empty database opening silently over real data.
Encryption is OPT-IN whole-file AES-256-GCM in a `SNUGENC1` container at the ONE persistence
seam (`PersistenceBackend.load/save`), key-wrapped so the passphrase and a mandatory
≥128-bit Recovery Key are independent unlock paths and a passphrase change rewraps 48 bytes
instead of 64 MiB. A protected file opens as `locked` (never quarantined; damage still
reports `corrupt`, separated by a header checksum). Protection follows exports and
PERSONAL-origin sync; **hub origins keep receiving secrets-stripped plaintext**, so
`apps/server` and the `/userdb` contract are untouched. Threat-model R-3/A6 rewritten;
R-14 (losing both secrets loses the data) is a named, unmitigable residual.

Key invariants: the user DB is the single source of truth in EVERY mode (subscription
artifacts are fetched client-side and written into it — hub stores are transient
caches); LLM calls originate from the host page only; secrets never reach the hub
(stripped from sync pushes and default exports, VACUUMed).

## Who may propose a connection (the trust ladder — ADR-0016)

A connection is a credential grant, so the question "who is allowed to *ask* for one?"
is a protocol-level posture, not a UI detail. **An app may never propose a connection
at runtime** — there is no frame, no SDK call, and no announce field that can do it.
Exactly three proposers exist, and the review each one gets is fixed:

| Proposer | Channel | Review |
|---|---|---|
| the user | Settings / net-error CTA | manual entry |
| the builder LLM (already reviewed) | chat directive → `finalizeConnectionDeclaration` (post-turn, `connectionPipeline.ts`) | registry rung light · inference strong |
| the **install act** | starter's `examples/<folder>/connection.json` | **always strong** (field-by-field) |
| the **share act** (TASK-20260904, ADR-0063) | the `connections[]` of an app bundle another person shared | **always strong**; admitted on the `shared` channel (borrow ban, confusable guard, `userLayer` refusal) — never vouched |

The install-act rung (TASK-20260807-connection-reachability) exists because a chat-less
app — a starter, anything installed rather than built — otherwise had no reachable path
to a connection at all. Its declaration resolves only when TWO independent facts hold —
`install_source` maps to a bundled manifest, AND the installed HTML matches the bundled
starter's for **both** the newest pinned factory version and the version that actually
runs (ADR-0045: install pins v1 and each starter update pins the new release, so "the
factory" is the newest pin). Requiring the running version is the security property: the
iframe executes `current_version` and credential brokering keys on `appId`, so vouching
for bytes that never run would let an imported DB pair pristine code with an attacker's.
A mismatch withdraws the declaration with only a console warning today (the Settings
surface for it is still queued in next-steps).

The declaration rides in its own immutable wizard-session field, so it forces the strong
review unconditionally — no mid-session action (notably "infer from docs") can downgrade
it to the light path. **Every write still goes through an explicit user approval in the
wizard; connection rows are staged via `stagePendingRequirement` and written only on wizard
approval (`putAuthSpec` and `snug_auth_specs` died at userdb v5).** Manifests are trusted
only because they are first-party, in-repo, PR-reviewed content gated by the `examples`
validate suite. **Before any UNTRUSTED declaration channel can exist** (an app-import
flow above all), a `providerName` charset/confusable guard and a registry-borrow ban were
named hard prerequisites — both LANDED with TASK-20260812 (guard in
`packages/protocol/src/connection-requirement.ts`, borrow ban in
`packages/auth/src/requirement-admission.ts`).

## Host kit — the third shell (TASK-20260905-host-kit, ADR-0065)

`apps/host` builds **`snug-host.html`** — one self-contained page over the SAME playground
source, the way the desktop is built (vite alias, a platform installed before React boots)
— for every skill-delivered binding. Since TASK-20261003 (ADR-0072 §1) it has ONE Vite
config, ONE html entry and ONE output: the same file is the Claude artifact page (published
by a tool or created in chat — one hosted runtime), the plain file, and the page the local
host process serves; `src/__tests__/oneKit.test.ts` fails on a second config or entry. What
differs from the playground is the OUTPUT and what the platform carries:

- **The boot** (`src/boot.tsx`, ADR-0072 §2): the binding is a runtime fact, decided once,
  in order. (1) `location.pathname === '/oauth/callback'` → the callback page ALONE — no
  token claim, no `/status`, no platform, no db (under the hash router that document used to
  render the hub, so a runner sign-in could never complete). (2) Only at the literal origin
  `http://127.0.0.1` (never `localhost`, another address, `https:` or `file:`): claim the
  launch token from the fragment, then `GET /status` to its own origin, bounded at 1.5 s — a
  tokenless page asks once; a page holding a token asks again (3 s, then 6 s) and, with no
  answer, renders "the Snug runner is not answering" (`LocalRefusal`'s `not-answering`)
  rather than open on this browser's storage (TASK-20261003 Gate 5) — a `200` in the runner's pinned shape composes the local platform
  (`src/local/compose-local.ts`); a `401`/`403` carrying `x-snug-runner: 1` renders "open
  it from your agent" (`src/local/LocalRefusal.tsx`); anything else falls through. (3) The
  probe and the hosted composition (`src/compose.ts`). Both compositions mount through one
  `mountKit`. The router is chosen by a guarded capability probe (`src/router.tsx`): the
  page replaces its own history entry with itself, and where that throws (an opaque-origin
  document) it mounts a `MemoryRouter` seeded from `location.hash`, else `HashRouter` as
  before. Every read of a storage global goes through `src/safeStorage.ts` (those getters
  throw at an opaque origin).
- **The probe** (`src/probe.ts`, before boot): when `window.claude.use` is a function the
  host namespaces are asked TOGETHER behind one guard (`sample`, `artifact`, `downloads` —
  `resolved` or `null`; `use()` and `limits()` prompt nothing and spend nothing); the
  binding decided purely from five facts (protocol, hostname, the `use` global, what the
  host answered, whether a runner answered — `artifact-static` when `use` exists but sample
  AND artifact are `null`: the page served top-level on the artifact host; a loopback page
  with no runner behind it is `file`); storage TRIED rung by rung with
  a real write/read round trip (OPFS → IndexedDB → memory — never presence-detected:
  `file://` exposes OPFS and rejects it; `getDirectory` invoked as a method, an unbound
  call is "Illegal invocation"); the brain PINNED from what resolved (TASK-20260905-binding-a-artifacts):
  `sample` → two adapters (`src/brains/sample.ts`: under `auto` app envelopes on `quick`, the
  builder and the inferrer on `default` — measured; since ADR-0067 the TIER is read at call
  time from `src/brains/tierStore.ts`, the one home of the user's thinking-level choice —
  `auto` | `quick` | `default` | `complex`, kept in this browser at the artifact origin, never
  the user file — which the brain chip renders through the platform's `TierSeat` and which
  records a substituted answer (`modelTierApplied`) so the chip disables and annotates the
  tier the plan lacks; the brain itself is still never chosen — D15 amended narrowly), the ONE shaper
  (`src/brains/prompt.ts`: system + messages as one user turn; `measurePrompt` = the bytes
  sent) as the seat's ruler, the cap from `limits()` (262,144 B measured on contract 0.2.67;
  `DEFAULT_MAX_PROMPT_BYTES` = 65,536 when `limits()` is missing, throws or never answers);
  nothing → the demo brain with every leg recorded. A chat artifact is this same hosted
  runtime (measured 2026-10-03: a real origin, `window.claude = { use }`); the September
  chat runtime (`window.claude.complete`, a per-view `window.storage`) is gone, and the kit's
  adapter, storage backend and binding for it were removed (TASK-20261003 R5 C2) — a
  page that meets only `complete` boots `file` with the demo brain and never touches it.
  The 19 `SampleErrorCode`s of 0.2.67 each map to a NAMED adapter error
  (`src/brains/errors.ts`), `retryable` only for `upstream_error` and only as a manual hint
  — the runner never loops on a host brain. Nothing asks the user anything (D15).
- **The platform** (`src/platform-host.ts`, composed by `src/compose.ts`): `kind:'host'`,
  the binding, the pinned brain, the engine as bytes, the backend that WORKED (or the
  record composed over it — below), the capability block from the ONE table every host
  binding composes from (`hostCapabilities()` in `apps/playground/src/platform/hostCapabilities.ts`,
  ADR-0072 §3 — a lint refuses a capability literal anywhere else under the kit or the
  runner): the four launch booleans explicit, every surface flag off except `appExport`
  (the download-only share sheet — how a kit-edited app goes back to the agent; the LINK
  acts stay off), plus three seats the playground renders from:
  `custody` (the "your file" chip — state and acts), `saveFile` (`src/exportSeat.ts`: a user
  file leaves as the `snug-user-file/1` wrapper `snug-user.snug.json` through `downloads.save`,
  or copied where the host has no downloads; every code owned, one prompt at a time) and
  `agentHandIns` (the run header's offered update). No transport seat a host cannot honour
  (no fetch, LAN, sidecar, helper, OAuth, update seats — the local composition alone adds
  `fetchImpl` and turns `connections` on, below). The playground's own readers do the
  rest: `allows()`, `secretsUsable()`, `resolveBrain()` — the kit is a clone of the
  playground / Snug Desktop minus the brain, model/provider and account controls, builder
  included (A5). Under a capped host brain the builder BUDGETS OR REFUSES a turn on the
  seat's own ruler (`agent/promptBudget.ts`: history dropped oldest-first, the app's html
  never cut, a named refusal with zero calls) and skips the router classifier (one viewer-
  billed call per app-attached message). **A tool-free brain carries the authoring
  knowledge IN the prompt (ADR-0066):** `knowledgeDeliveryFor(brain)`
  (`agent/knowledgeDelivery.ts`) is the one derivation both slots of a build turn consume —
  the system prompt's `knowledge` delivery (`'inline'` = the 35 layer + the five-file KB
  core, ~41 KB — inside even the 65,536-byte fallback cap — pinned under a 44 KiB ceiling on
  the kit's own ruler; `'none'` = the honest unaided layer for webllm or a brain whose
  declared cap cannot hold the core) and the matching user-message template; the edit
  turn's context block follows it too. The cost is room: ~23 KB beside the system text on
  an edit turn, so at September's 65,536-byte cap a starter-sized app could not be edited
  under the host brain while the template rode whole on edit turns (ADR-0066 A8 — an open
  owner decision); no edit turn has been measured under 0.2.67's 262,144 B.
- **Binding A — the artifact record, one file** (`src/storage/`): inside a hosted artifact
  (published or chat-created) the browser bucket stays the WORKING copy and the page's own
  `<script type="text/plain" id="snug-db">` block is the DURABLE copy (`artifactHtml.ts`, a
  record OVER the bucket: seed-on-empty with one counted save and a magic-prefixed custody
  sidecar; a divergence with a direction from the block's save counter, resolved only by an
  explicit act; "save to this artifact" fetches the page's canonical source — never the
  live DOM, which carries the viewer's injected runtime — LIFTS THE KIT DOCUMENT OUT OF THE
  PLATFORM'S WRAPPER (`unwrapViewerPage` in the one grammar reads exactly two measured
  wrappers: the contract-0.2.67 skeleton — 536 bytes of charset, viewport and reset through
  `<body>`, no injected script in the stored source, byte-matched against two real
  read-backs in `scripts/fixtures/readback-0.2.67/` — and the September viewer's, which put
  two injected scripts ahead of the kit's whole document (measured 2026-09-06); a fragment,
  a skeleton inside a skeleton, trailing content and any other head are refused by name),
  verifies the kit document with the shared tokenizer, republishes the BARE page — 0.2.67's
  `artifact.d.ts` requires a complete document starting with `<!doctype html>`, and the
  platform wraps it again — refuses a projected
  page over the cap naming its three parts, maps every runtime code, stashes the conflict
  note across the reload — and only across a conflict; "load the page's copy" is TERMINAL
  and reloads, since the open db would otherwise flush the browser copy straight back). The
  seed TRUSTS the block's bytes (sha-verified for self-consistency only): the page is the
  publisher's output, and `verifyKitPage` is a SHAPE check on the fetched source, not a
  security control. `artifact-html` is a `PersistenceKind` appended without a version bump;
  `packages/db` still lists `window-storage` beside it (a persisted enum is append-only),
  which nothing in the kit reaches since the September chat backend was removed. Under a
  viewer that denies third-party storage the working copy is memory only, and the chip
  says so.
- **The hand-in** (`src/handin.ts`, ADR-0065 §6; one core since ADR-0072 §3): the page's
  `snug-app-bundle+json` blocks (written by `scripts/snug-embed.mjs` through the ONE grammar
  `scripts/lib/page-blocks.mjs`, which also owns the top-level tokenizer every reader uses)
  resolve at boot — before the first paint when the db opens promptly — through
  `applyAgentBundles` to an `agent:<lineage>` app, the app the bundle was lifted from, or a
  new OWNED install; an unedited copy takes the update, an edited copy is OFFERED in the
  run header (`AgentUpdateControls`, ADR-0045 §7's confirm), a deleted app stays deleted
  (`agentDismissed:` tombstone), a bundle with connections is refused (D4) at the boundary,
  before any pending offer. Under the local runner the same core takes the runner's
  `hand-in` events while the page is up (`src/local/handinEvents.ts`): the hub refreshes in
  place (`libraryRevision`), a running app whose version changed offers a reload, an
  explicit runner hand-in clears the tombstone (the one rule the bindings do not share),
  and the page reports each outcome to `POST /hand-in/outcome`; the page reads no embedded
  block there at all. A `share:` copy is never a
  lifted-from target (its id is the sharer's lineage). The trust boundary is the artifact's
  write permission — a page writer could replace the kit's own script — so the guards that
  hold are the ones inside it. One residual is the viewer's own bridge: an app frame can
  `postMessage` a runtime-shaped message to `top`; the kit page never answers one (e2e), and
  whether the viewer does is answerable only by the hosted walk.
- **One file** (`vite.config.ts` — the only config — + `src/plugins/`):
  `inlineDynamicImports`, every asset a data URL, the sql.js engine through `?inline` (Vite
  6 must be told `.wasm` is an asset), the entry script and stylesheet folded into the html
  by `inline-single-file` with its refusals (a surviving `</script`, an UNCLOSED `<!--`,
  `</style`, Vite's unresolved `__VITE_PRELOAD__` marker — which is why the hook is
  `order:'post'`, after Vite's own generateBundle — any other emitted file, any leftover
  `./assets/` reference), and the build stamp `<version> <sha>[-dirty]`. Two modules are
  swapped by RESOLVED path (`swap-resolved`, a dead swap fails the build): the starter
  source and the sql.js locator. WebLLM is aliased to a stub. Measured 2,219,519 B
  (2026-09-05); 3,255,702 B without the starter swap; sha-identical across clean builds.
- **Starters on demand** (AC14, A3): `src/starterSource.ts` implements the playground's
  `StarterSource` over the index the build bakes in (`starters-pkg/index.json`, emitted by
  `scripts/build-starters-pkg.mjs` from `examples/`) — the catalogue, release meta,
  contracts and manifests inline (≈ 30 KB), each starter's html + docs loaded on click
  through ONE `<script src="https://cdn.jsdelivr.net/npm/@snugprotocol/starters@<pinned>/<id>.js"
  integrity="sha384-…" crossorigin="anonymous">`, a page hook the wrapper registers into,
  and NAMED refusals (offline, timeout, bad payload, wrong version) the run view renders —
  never a dead control. Publishing the package is an owner act; the version pin lives in
  `examples/starters-package.json` and every version's wrapper hashes in
  `examples/starters-lock.json` (ADR-0073): `check-starters-pin` (root `check-host-kit`)
  reds when `examples/` drifts from the lock — re-stage before publication, bump the pin
  after — and `scripts/publish-starters.mjs` stages, dry-runs and publishes
  ([runbook](runbooks/publish-starters.md)).
- **A host offers only what it can run** (`apps/playground/src/platform/availability.ts`,
  ADR-0072 §4 — every shell, not only the kit): one pure derivation. An app's NEEDS
  (`network`, `native-fetch` — the registry says its provider refuses browsers — `oauth`,
  `lan`, `helper`) come from a starter's `connection.json`, read synchronously at first
  paint through `StarterSource.requirement(folder)` (`starter/starterRequirement.ts`), or
  from an installed app's connection rows (`declared` and `approved` count, `revoked` does
  not), fetched with ONE `listConnections()`. A host's OFFERS are read from seats its
  platform already carries (`offersOf`: `connections` → network, `fetchImpl` → native-fetch,
  `lanFetch` + `lanPair` → lan, the three sidecar seats → helper, `connections` and
  `capabilities.oauthRedirect !== false` → oauth), never from `kind`; each shell's test
  feeds its REAL platform object through it. A blocked app is disabled on the shelf with its
  reason as visible text (`views/AvailabilityNote.tsx`) and on its run route, which replaces
  the app frame with the reason and keeps the header, so a blocked app can still be exported
  (a blocked starter offers no `install`). The web shelf keeps its `desktop` badge; the
  wizard's walls read the same offers, and a source lint keeps capability decisions off
  `kind !== 'desktop'`. The host passport (`views/HostPassport.tsx`) says the same table in
  words beside the chips on host platforms. Under the runner the `oauth` offer follows
  `/status`'s `oauthRedirect`, false when the process fell back from its fixed port.
- **Gates**: `scripts/check-host-kit.mjs` (a top-level DOM tokenizer that never scans
  script/style bodies; AC1's rules, the 16 MiB cap and a 2,750,000-byte ceiling, the stamp,
  exactly one file in `dist/`, two clean builds sha-compared) in root `test`, gate-local's
  workspace leg and ci.yml — its tokenizer now lives in `scripts/lib/page-blocks.mjs`, and
  the root chain also runs `page-blocks.test.mjs` and `snug-embed.test.mjs`;
  `apps/host/e2e/kit.spec.ts` on the BUILT page — served by a loopback static server
  (file-class since K2) and from `file://` — with every request aborted except jsDelivr `/npm/` and the
  intercepted starters package (gate-local's e2e leg; a missing dist is CANNOT RUN by name);
  `apps/host/e2e/artifact.spec.ts` — the hosted runtime FAKED on the built page
  (`window.claude.use` with recording `sample` / `artifact` / `downloads`), spliced pages
  served through `page.route`: no call on load, one call per move, the save round trip and
  the seed in a fresh browser — inside the September wrapper and inside the 0.2.67 skeleton
  cut from a real read-back — read-only after the first refusal, the wrapper export, the
  hand-in (install, update, idempotence), `artifact-static`, a page that meets only the
  September chat runtime booting with the demo brain and touching neither `complete` nor
  `storage`, and the C2 reach test (the app frame's `parent`/`top` are opaque);
  `kit-boot.spec.ts` (K2 — a loopback page with no runner asks `/status` once and boots
  `file`; `file://` asks nothing) and `kit-availability.spec.ts` (the blocked shelf, the run
  route, the host passport, the 375 px fit, screenshots in both themes at 1280 and 375).
  The local-host Playwright project (`local*.spec.ts`) runs the same built page served by
  the process's TEST build. The REAL runtimes are the owner's walk, journaled with the
  artifact URL; `scripts/runtime-probe.html` (`snug-chat-probe/3`, in the `check-host-kit`
  chain) is the maintained diagnostic that measured this one.

Steps 1–4 of the task landed the seams the kit needs in the packages and the playground,
all additive and all "absence = today's behavior": `kind:'host'`, `binding`, a pinned
**`brain`** honoured by the one brain derivation ahead of the webllm flag and the user
file (apps AND the builder), `sqlJsWasmBinary` (`packages/db` makes bytes win over the
locator at both `initSqlJs` sites), five optional surface flags read through `allows()`
plus `secretsUsable()` (hides the secrets export AND strips `snug_secrets` from an imported
file before adoption — C1), the runner's `host-ready` advertising `streaming` truthfully,
`starter/starterSource.ts` owning the five `examples/` globs, a storage disclosure in the
"your file" card under host, and a named reason on a failed app load.

## The local host process — Binding B (TASK-20260907-binding-b-plugin-host, ADR-0068)

`apps/host-mcp` builds **one `dist/snug-mcp.mjs`** that the agent's host (Claude Code — in
a terminal or Claude Desktop's Code tab — and Cowork) spawns over stdio when the `snug`
plugin is installed. It is Snug Desktop's
native side written in Node and reached over `127.0.0.1` — nothing more ambitious than that.
It has three jobs.

- **Serve the kit.** The ONE page (ADR-0072 §1 withdrew the second build ADR-0068 had): the
  plugin ships `snug-host.html` once, as the skill's asset
  (`skills/snug/assets/snug-host.html`), with its sha256 beside it (`<page>.sha256`, written
  by `scripts/build-plugin.mjs`). `src/page.ts` is the one locator — the plugin layout, the
  repo layout (`apps/host/dist/`), then a sibling of the bundle — and the process reads the
  page ONCE at boot and serves only bytes that match the pin; a mismatch is the
  `page-damaged` refusal, and that process takes no lock and binds nothing (D8: it catches a
  partial copy or a stale mix, not a same-user writer). What makes the page the runner's is
  the kit's runtime boot, not the build: there it composes `connections` on and `fetchImpl`.
- **Be the network side of the executor.** The page's `connected-fetch.ts` stays THE seat that
  reads a credential and calls fetch, with all ten gates. What crosses to the process is the
  platform's raw `fetchImpl` (`/fetch`), the user file (`/userdb/*`, `createFileBackend` over
  an HTTP `FileBackendFs`), and the OAuth callback route the wizard's WEB path already uses.
  `src/fetch-proxy.ts` re-runs the executor's own gates on the far side of a socket anything
  local can open: https-only, the IMPORTED `isForbiddenNetHost`, a 3xx returned as data,
  `Set-Cookie` dropped, the 1 MiB cap enforced while reading, and a 75 s clock — strictly
  above the executor's 60 s, so the executor's own self-naming timeout is what the user
  reads. It is **transit-only, not value-blind**: it handles injected values because
  forwarding them is the job, and never logs, persists, echoes or retains them.
- **Expose four control-plane tools.** `snug_status`, `snug_open`, `snug_hand_in`,
  `snug_list_apps`, frozen by an allowlist test. There is no data-plane tool, as a rule: an
  agent that could fetch with the user's credentials would be a network principal, which C1
  forbids. The bearer appears in no tool result — `snug_open` makes the process open the
  browser, and the CLI fallback prints the URL into the user's own terminal. `snug_hand_in`
  answers with what the page reported (`installed`, `updated` to vN, `current`, `offered`,
  `refused: <reason>`) or, past a 5 s bound, `sent … — not confirmed`; `snug_list_apps`
  still answers an empty list with a note (the page owns the database).

**Inbound trust.** `Host` must equal the served `127.0.0.1:<port>`. Measured: after a DNS
rebind an attacker's page is same-origin to the browser and sends no `Origin` and no
`Sec-Fetch-Site`, so `Host` is the only header naming it. `Sec-Fetch-Site` must be the
literal `same-origin` — a different loopback PORT reads as `same-site`. Every route but the
documents (`/`, and `/oauth/callback`, which a provider's redirect reaches with no bearer)
requires the bearer header, which forces a CORS preflight that is answered without CORS
headers.

**One process, one file — lead, attach, succession (TASK-20261003 R1).**
`~/Snug/host/lock.json` is created exclusively before anything binds — written whole to a temp
file and linked into place, so an existing lock fails the link and no reader sees it half-written —
and records the port,
the pid, the bearer's SHA-256 and the control socket. `acquireLock` (`src/lock.ts`) asks the
recorded control socket FIRST: an answer carrying the lock's token hash is the owner, and the
newcomer ATTACHES without reading any process table; silence and a dead pid is taken over
(replacing a record is one step under the `lock.takeover` mutex); silence and a LIVE pid is
the one place identity is read (`src/identity.ts`: `/bin/ps -ww -o command=`, or
`/proc/<pid>/cmdline`; the script argv token must be a file named on `BUNDLE_BASENAMES` —
`snug-mcp.mjs`, `snug-mcp.test.mjs`, `snug-local-host.mjs` — never a substring match). A
stranger is refused and never signalled; a wedged runner of ours is signalled only after
three socket probes over 5 s fail AND its recorded port is silent, then waited for (≤ 5 s)
before its lock is taken; only the canonical `<home>/host/ctl.sock` is ever unlinked. Two
agent windows are one Snug: an attached session holds ONE persistent `attach` connection,
and the primary exits, after a 3 s grace, only when its own session is gone AND no attached
session remains — re-decided on every change; transient ops (a status poll, a forwarded
hand-in) neither hold it nor reset the grace. **Succession:** an attached session whose
primary went re-runs the start on its agent's next tool call, becomes the primary, and its
`snug_status` carries a note to call `snug_open` again (a new runner is a new bearer). If
Snug Desktop holds the file the page **refuses to open** and names the holder rather than
running read-only, because both of `packages/db`'s save paths swallow a failed write.

**Handshake first; the refusal table.** No failure after Node is found precedes the MCP
handshake. A runner that can neither lead nor attach answers `initialize` and `tools/list`;
`snug_status` returns `{ running: false, refusal: { code, message, remedy } }` and every
other tool returns that sentence as an error; each tool call re-runs the start (at most once
a second), so a cause the user fixed clears without restarting the agent — except no home
and a damaged page, which cannot change inside a running process. The rows
(`src/refusals.ts`): `home-unresolved`, `home-unwritable`, `lock-held-by-stranger`,
`lock-contended`, `older-build`, `socket-path-too-long`, `socket-in-use`, `listen-failed`,
`page-damaged`. No Node at all is the launcher's sentence, not the process's. One
`startProcess({ hooks })` (`src/process.ts`) composes the release entry (`src/main.ts`: the
real home, browser and brains) and the test entry (`src/main.test-hooks.ts`), whose hooks
all share the `SNUG_MCP_TEST_` prefix `check-host-mcp` sweeps out of the release bundle.

**The control socket and `snug status | open | stop`.** A `0600` unix socket for attached
sessions and the human CLI (`src/control-socket.ts`), ops `hello`, `status`, `open`,
`launch-url`, `call`, `attach`, `stop`: every known op answers
an ack written by the socket after the handler — `{ ok: true, op }`, or `{ ok: false, op, error }` when the handler refuses (e.g. `stop` with a page open), an unknown one `{ error: 'unknown op' }`, and a `hello` without a
`build` is an older build — the `older-build` row, never a false success. `call` runs the
PRIMARY's own `callTool` (a forwarded bundle is re-validated there), so an attached session
and the primary cannot drift. `open` makes the primary open the browser (`src/opener.ts`:
`/usr/bin/open` on macOS, `/usr/bin/xdg-open` on Linux — absolute paths; the child's
environment an allowlist (`openerEnvFor`, from `machineEnvironment()` via `main.ts`); an
`error` listener for the child's whole life) and answers
`{ port }`; `launch-url` is the ONE op that answers the bearer, used only by the human CLI
(`src/cli.ts`), which prints it only when stdout is a terminal. `snug status` reports the
version, the build (`src/build.ts`: the first seven hex digits of the sha256 of the running
bundle, hashed as it loads), pid, platform, home, sessions, pages and brains. `snug stop`
refuses while a page is open unless `--force`, then reaps every brain child, emits
`shutdown`, drains in-flight `/userdb` writes (≤ 2 s), closes the control socket, releases
the lock and closes the listener — the process exits regardless at 5 s (`EXIT_DEADLINE_MS`); against an older build it sends SIGTERM only when the socket's hash matches the
lock AND the lock's pid has our command line. An unknown verb prints usage and exits 2. A
page whose runner went (`shutdown`, an event stream lost past 4 s, a refused `/userdb`
write) says "the runner stopped" and takes no further edits (K7).

Threat surface: `docs/security/threat-model-delta-local-host-process.md`; the brains, the one
page, the runner's lifecycle and the chat runtime: `docs/security/threat-model-delta-brains-and-chat.md`.

### Bindings and brains are two axes (TASK-20260913-binding-b-marketplace-plugin, ADR-0069)

A **binding** is where the body runs and how the host reaches it: **A** the kit as an
artifact page, **B** the kit served on loopback by the plugin-spawned local host process,
**C** a widget. A **brain** is what answers the apps' thinks: the viewer-billed `sample` (A
only — a chat-created artifact is the same hosted runtime; September's
`window.claude.complete` is gone), **the user's own agent CLI as a child process** (B —
through the brain registry below: `claude`, and `codex`, built and unverified; Hermes /
OpenClaw / Ollama are deferred), or the demo brain. MCP is B's spawn-and-control channel and
nothing else — never the brain (sampling is unsupported) and never the network path (the
page's executor calls the process over loopback). The process and its artefacts are being
renamed `local-host` in a follow-up PR so no name says "mcp" for a thing whose identity is
not MCP.

**Which runner a surface gets (ADR-0072 §7, as amended by TASK-20261003 C5/D6).** The skill
(`packages/knowledge/prompts/skills/snug/SKILL.md`) routes by surface: Claude Code in a
terminal or in Claude Desktop's Code tab, and the Cowork tab, run the local runner (B); a
surface that loads the plugin but shows no Snug tools is told "Snug needs Node.js 20 or
newer"; claude.ai chat and the Desktop chat tab take the ARTIFACT runner (A) — publish the
skill's own `assets/snug-host.html` with `{ sample, artifact, downloads }`, hand apps in with
`scripts/snug-embed.mjs` and a republish — because a chat-created artifact is the same
artifact system (measured 2026-10-03: the same stored skeleton, the same capabilities). No
separate chat delivery is built. Not yet walked: the Cowork tab, and whether chat-Claude can
reach and publish the skill's asset file.

**The child-CLI brain pre-warms its children; every child serves exactly one request.**
Measured 2026-09-13 on CLI 2.1.270: a cold `claude -p` costs ~3.5 s of process overhead on
top of the model's time; a `--input-format stream-json` child left idle for five seconds
answers its first message in 1.7 s wall — the CLI does its start-up before any input, at
~257 MB of idle memory. So `apps/host-mcp/src/brains/claude-child.ts` keeps a `ChildPool`
keyed by the sha256 of the system prompt, the model and the level (ADR-0070; an app's
runtime contract rides as the **system** prompt on this binding, so its key is stable across
thinks): a request takes the pre-warmed virgin child
for its key or spawns one, sends its whole rendered conversation as ONE stream-json user
message, and the child is reaped when the request ends while a replacement is pre-warmed.
No transcript is ever reused — on this binding the builder's system prompt carries the app's
html and changes every build, so "continue the conversation" would never fire (the plan
review's finding). Bounds: two pre-warmed keys (LRU), a five-minute idle TTL, a reap on
stop / parent death / abort / error, a cold-start bound to the first delta then an idle
bound between deltas. The shim `stream()`s each `text_delta` as its own SSE frame (one
`JSON.stringify` per frame, so a delta cannot forge a boundary); the chat route writes the
first chunk with the 200 and each later one as it arrives, answers a failure before any
delta with a 502 and ends a failure after one with no finish (the adapter reads that as a
dropped stream, never a complete answer). The `claude` driver's probe (`probeBrain()` in
`src/brains/claude.ts`, a real one-word think on the brain's own wire) names five states —
`ready | logged-out | outdated | absent | unknown` — and every agent CLI is found by
`src/brain-resolve.ts` from `install-roots.json` (PATH, then the installers' directories),
because a process a desktop host spawns has **no user PATH** (measured: empty on the
owner's Mac). The plugin's `.mcp.json` runs `/bin/sh scripts/snug`, a launcher generated
from the same list that finds a Node ≥ 20 the same way. The skill (`skills/snug/`) is built
from its prompt-store source by `scripts/lib/skill-build.mjs` into the gitignored plugin
tree, which `check-host-mcp` builds and validates on every run — and, since TASK-20261003,
STARTS under an isolation contract (a positive leg and a no-home leg, a second process
attaching), serves a copy with one page byte changed to prove the pin, writes
`dist/plugin/snug.zip` (`scripts/lib/zip.mjs`, byte-reproducible, re-read and CRC-checked —
the archive Claude's "Upload plugin" takes), holds the directory's install-blocking rules,
and prints the bundle's size against the 256 KiB reviewer-hold line.
`scripts/walk-desktop-host.mjs` is the opt-in desktop-host walk (never in a gate — it spends
the user's subscription): the shipped launcher under a GUI-shaped environment and a temp
`SNUG_HOME`, one Chess move on the real brain, then a leg with every brain hidden.

**The brain registry — one contract, two drivers (TASK-20261003, ADR-0071).** A brain is a
`BrainDriver` (`src/brains/brain.ts`: `id`, `name`, `via`, `verified`, `streaming`,
`maxPromptBytes?`, `probe()`, `catalog()` in the brain's own vocabulary,
`acceptsModel`/`acceptsEffort`, `create()` → the `Brain` the chat route streams from). The
registry (`src/brains/registry.ts`) is a REQUIRED, injected dependency of the runner: the
release entry passes `machineDrivers` — the one whole-environment read; the child
environment is built once by allowlist (`CHILD_ENV_ALLOWLIST`, this Node's directory
prepended to PATH) and handed to every driver — and the test entry passes fake drivers from
`SNUG_MCP_TEST_BRAINS`; nothing defaults to the real machine. Probes are LAZY: the first page
contact starts a round and waits at most 250 ms for a fast verdict; later rounds come when
the page asks (`POST /brain/recheck`, at most one per 30 s floor, an ask inside it owed
once); every round reaches the page as a `status` event. Selection never changes vendor
without a user act: `auto` is the default brain (`claude`) when it is ready and verified,
else NONE; a pin is that one brain while it is ready, else NONE; NONE answers `503
no-brain`. The page mirrors the rule and sends nothing while no brain resolves — its demo
brain answers, with the remedy shown — and a think the runner could not place is a named
error that makes the page look again (D4: never a 502, never a mid-turn substitution).
`/status` and the `status` event carry `brains[]` (state, detail, verified, streaming, each
model with its own levels, `maxPromptBytes`) and `active`; the chat body adds `brain` and
per-brain `prefs` (a top-level `model`/`effort` is the `claude` entry's legacy form); only
the resolved brain's entry is applied, validated by its own driver, and `x-snug-brain` names
the brain that answered. Both drivers report the argv limit as `maxPromptBytes` (120,000 B on
Linux, 900,000 B elsewhere; `E2BIG` is a named refusal). **`claude`** (`brains/claude.ts`,
`claude-child.ts`, `claude-catalog.ts`) is behaviour-identical to the shim above, `verified`
and streaming. **`codex`** (`brains/codex.ts`, `codex-events.ts`) is one child per think,
answering whole: the posture argv (every tool-shaped feature disabled, web search off, user
config and rules ignored, project docs off, `--sandbox read-only`, `--ephemeral`, a neutral
directory, and Snug's OWN `CODEX_HOME` — `<Snug home>/host/codex-home`, logged in once with
`CODEX_HOME=… codex login` — because Codex loads the global `AGENTS.md` of its home into every
think and the owner's B7 walk, 2026-10-05, found theirs in every answer), the system prompt as ONE TOML-escaped `-c developer_instructions=`, the
conversation on stdin; readiness from `codex login status` (ready only on the ChatGPT login),
the catalogue from `codex debug models --bundled`; an ALLOWLIST tripwire — `agent_message` is
the answer, `reasoning` is dropped, any other item kills the detached child's process group
and fails the think; failures reach the page only as fixed sentences; at most four live
children. It is `verified: false` — `CODEX_VERIFIED_VERSIONS` stays empty until a logged-in
walk is journaled — so it answers only when pinned and is labelled experimental. Ollama,
Hermes and OpenClaw are deferred; ADR-0071 §2 records the rule they must meet. On the
page, `apps/host/src/local/compose-local.ts` derives `platform.brain` (a live getter: the
host arm while the choice resolves to a ready brain, the demo arm otherwise;
`brainRevision` tells the UI to re-read) and the `brainSwitch` seat the chip renders as a
switcher (`apps/playground/src/views/BrainChip.tsx`): every brain with its state and
remedy, `auto` first, the chosen brain's model and level from ITS catalogue, and what
ANSWERED. The choice is per machine and per brain
(`apps/host/src/brains/brainChoiceStore.ts`, `localStorage`, `{ v: 2, … }` migrated from
the single-brain shape) and never enters the user file.

## Desktop shell (TASK-20260812-desktop-hub-scaffold, ADR-0021)

`apps/desktop` wraps the SAME playground source (vite alias, `HashRouter`, desktop entry)
in a Tauri 2 shell — BYOK/local only, no subscription surface. The playground gained ONE
seam: `src/platform/platform.ts` (`SnugPlatform`, set-once before boot; web default =
prior behavior byte-for-byte). Desktop supplies: native fetch (`tauri-plugin-http`,
CORS-free) through the connected-fetch `fetchImpl` seam AND the LLM adapters; a `'file'`
`PersistenceBackend` persisting `~/Snug/user.snug` via atomic Rust commands (userdb +
sync sidecar share it); loopback OAuth (`RedirectUriProvider`/`CallbackSink` seams,
`tauri-plugin-oauth`, fixed port 41420 for exact-match providers, system browser only per
RFC 8252); Ollama autodetect; `.snug` file association through a single-use Rust
allowlist → confirm dialog → `importUserFile` (F15 arms). Registry entries carry
human-authored `desktopRedirectPosture` + `browserCallable` seats, plus web-surface
`webRedirectPosture: 'origin-callback'` + `webRegistration` (ADR-0049; gmail first) that
the wizard's register screen resolves at render time on the web runtime (registry-level
data, NOT requirement seats — no protocol change); unsupported postures refuse at wizard
entry, and `pkce:false` + loopback is structurally refused (auth-code injection). The connected-
fetch executor gained a desktop-only `transportPolicy` admitting `http` to user-approved
RFC-1918 IPv4 literals (Hue-class LAN; browser profile unchanged). C2's in-shell proof =
the 14 browser CSP checks + IPC-unreachability-from-iframe checks + one wizard e2e
journey, run by the shell-gate harness (`pnpm --filter desktop gate`): macOS GREEN
2026-08-12; Windows RAN 2026-08-13 and FAILED deliberately — wry's WebView2 backend
ignores `for_main_frame_only`, so `__TAURI_INTERNALS__` reaches app iframes: ADR-0021 D8
trigger MET. **Resolved 2026-08-20 — the shell ships macOS-only through alpha, beta and
1.0 (ADR-0021 D8 addendum); Windows desktop is reconsidered post-1.0. The Windows leg
stays RED by design for that whole run and must not be softened.** Since 2026-08-20 the
BUILD states it too: `bundle.targets` is `["app","dmg"]` and `icon.ico` is gone, pinned by
`apps/desktop/src/__tests__/bundleTargets.test.ts` (config + tree + icon generator). Note
the exact strength — the shipped config *requests* macOS targets only; an explicit
`--bundles nsis` still overrides it, so this is not a build-level refusal (threat-model
R-5b carries the wording).
Threat surface: `docs/security/threat-model-delta-desktop-shell.md`.

### Distribution and the shell update channel (TASK-20260821, ADR-0047)

The shell is downloaded from the web hub (`/download`) and **updates itself in place,
by offer** — the first supply-chain surface in the product, and the first time anything
Snug ships can replace Snug. Hosting is GitHub Releases; the artifacts are a DMG for
humans plus `.app.tar.gz`+`.sig` for the updater, all static (ADR-0013-compatible).

**One endpoint, one home.** `apps/playground/src/desktop/releaseChannel.ts` owns the
URLs and the desktop config is BYTE-COMPARED against it — `tauri.conf.json` cannot
import TS, so the compare *is* the single-homing. The dependency direction stays
desktop→playground (the `@playground` alias); the playground never imports from
`apps/desktop`.

**The trust split is the design constraint.** minisign covers the downloaded ARTIFACT;
`latest.json`'s version, date, notes and URL are TLS-trusted only. A compromised
publishing account therefore cannot install a binary but CAN author the update prompt —
so fetched notes render as plain text with no linkification, the version is
syntax-validated, and the UX offers no button pointing outside the flow (threat-model
R-28).

**Offered, never automatic** (ADR-0045's doctrine, inherited): a toggleable launch
check that is quiet on failure (this mattered pre-flip, when the private repo 404s for everyone; the repos went public 2026-08-26, so silence
is the designed state, and the Settings button is where a failure gets NAMED), a
non-blocking header chip, and a Tesla-style notes sheet. **`relaunch()` reaps the
sidecar first** — `AppHandle::restart()` skips `RunEvent::Exit` on the main thread, so
the shell's exit-time reap cannot be assumed and an orphaned helper would wedge the
linked-device session. C2 gains three per-command keyless-refusal gate rows plus a
positive twin: capabilities are per-WINDOW, so placement proves nothing about iframes.

Threat surface: `docs/security/threat-model-delta-desktop-update-channel.md`.

### Desktop-aware dynamic auth (TASK-20260812-desktop-auth-awareness, ADR-0022 + ADR-0023)

The shell shipped those transports; the auth intelligence layer did not know it. Four
additions close that, and all four are additive to C1 — the registry stays the only
reviewed authority for where a credential goes, and the frozen per-connection ceiling
stays the wall.

**Platform truth reaches the model.** `HostSystemPromptOptions` gained a `platform`
(`'web' | 'desktop'`) seat; on desktop the assembly appends KB layer `95-platform-desktop`
LAST, and the recovery inferrer's **user** slot (system slot stays static by design)
carries platform facts. Web assemblies are byte-identical without it, so there is no web
variant to keep in sync. Admission and persistence stay platform-BLIND — user files roam
between web and desktop, so platform-conditional behavior lives only in prompts, wizard
and executor; a desktop-minted LAN row opened on web is *disclosed* as desktop-only,
never refused.

**The registry pins where credentials go.** Entries (and auth options) carry optional
`request` (`headerTemplate` + the new `queryTemplate`) and `testRequest` seats, emitted by
the one `requirementFromRegistryEntry` emitter and substituted on every channel's borrow
hit by `applyRegistryValues` — with refusal and substitution driven by the SAME
matched-option handle. The template grammar gained a fifth helper and second signing
family, `{{cdp_jwt(api_key, ed25519_private_key)}}`: a host-side EdDSA mint
(`ed25519-key.ts` canonicalizes every CDP secret shape — PKCS#8 PEM, base64 64-byte
seed‖pubkey, bare seed — to the seed and re-wraps it in the fixed PKCS#8 prefix
WebCrypto requires; ES256 was v1, dropped by ADR-0030 when Coinbase's portal moved to
Ed25519-by-default) whose `uri` claim binds the
signature to the live outbound request, `exp` at +120 s. `queryTemplate` renders into the
URL **after** every gate, suppresses the kind default so a query credential is never also
a header, and joins an enumerated scrub site list. Rows are admitted once and never re-read
the registry, so the wizard's open path runs `migrateConnectionRegistryDrift` — seat drift
re-substitutes and re-persists without re-crediting; field-set drift routes to
re-credential.

**Silent auth failures surface.** A credentialed 401/403 still reaches the app unchanged
(`ok:true`, status as-is — the app contract is not broken to gain visibility), and a
host-only `onAuthShapedFailure` observer fires on the FINAL delivered result. Since
TASK-20260819 the DIAGNOSIS lives in the wizard's derived attention gate (Step 0) and the
run surface carries only `AuthRepairChip` in the app header: the chip hands the failure off
to the wizard session on a real open (never on a refused one), and a staged re-approval
diff OUTRANKS the gate — the diff is the cure for the failure it would otherwise explain.

**LAN-class providers.** `connectionRequirementSchema` gained an optional `lanHost` seat
with `declaredApiHosts` **required-XOR-`lanHost`**: a device whose address the user's
router assigns is pinnable by nobody, so the wizard COLLECTS it (RFC-1918 IPv4 literal
only) and it freezes into the ceiling like any other host. The binding order is collect →
approve → freeze → pair, because a pre-collection row derives an EMPTY ceiling that refuses
everything. Pairing and pinned traffic ride ONE Rust command, `lan_fetch`
(`src-tauri/src/lanfetch.rs`), in two explicit modes: `pair` captures the leaf certificate's
fingerprint+CN **inside** a rustls verifier (reqwest never exposes the peer cert to
callers) and `pinned` refuses any other leaf. Host class, `Policy::none()`, the 1 MiB cap
and a fresh client per call are all enforced in Rust before a socket opens. The pin lives
in the connection's `auth:<appId>:<slot>:_connection` KV (ADR-0014 custody, not a db
column). The platform seam gained TWO seats, and their asymmetry is the guard:
`connectedFetchDepsFor` threads `lanFetch` alone, so a request-time path to
accept-and-capture does not exist. Threat surface:
`docs/security/threat-model-delta-desktop-auth.md`.

## Linked-device helpers and the host live pump (ADR-0032 / ADR-0034)

Some providers authenticate a DEVICE, not a request. Personal WhatsApp links a companion
device by QR scan and then keeps a live session that neither the sandboxed iframe (C2) nor
the request/response connected-fetch executor can host. That session lives in a local helper
process — `apps/whatsapp-sidecar` (Node + Baileys) — which is a **capability, not a host**:
it listens on a unix socket (`~/Snug/whatsapp-sidecar.sock`, 0600) that only the Rust side
can name, and is reached by purpose-built commands (`sidecar_ctl`, `sidecar_fetch`, and the
wizard-only `sidecar_wizard_fetch`), never by widening the frozen connection ceiling. The
helper is LLM-free by construction: every analysis or compose turn runs in the governed host.

**Reads flow app → bridge → executor → Rust → socket.** The app addresses
`snug-connection://<slot>/<path>`; the executor resolves the symbolic host
(`whatsapp.sidecar.localhost` — RFC 6761 reserved, never dialled) to the sidecar transport,
injects the minted helper token, and applies the same gates as any other connected request.
The app holds no token, no address, and no socket path.

**Live updates are a HOST PUMP forwarding invalidations** (ADR-0034). While RunView has an
app mounted whose connection is approved with the symbolic host in its frozen ceiling,
`state/sidecarLive.ts` long-polls the helper's `GET /events` **through that same executor
assembly** and forwards lean hints (`{seq, jid, kind, ts}`) into the frame via
`RunnerHost.notifyEvent('connection-event', …)`. Two verified facts force the hint shape and
are worth restating because they generalize to any future push channel: `hostEvent` frames
ride the ordinary `MAX_FRAME_BYTES` (256 KB) class and the runner's `post()` drops an
oversized frame **silently**, so content-bearing batches could vanish undetectably; and
`hostEvent` frames carry no `instanceId`, so a hand-rolled app listener cannot distinguish a
stale sender. With hints, the frame cannot outgrow its class and a stale event costs at most
one redundant *governed* refetch — it can never inject state. The pump is epoch-tokened
against StrictMode's double-mount, and no new iframe capability exists: the app still cannot
open a connection, only hear a doorbell on the channel that already existed.

**Honesty seats travel with the data.** History sync is PUSHED in chunks and its completion
is sometimes only INFERRED (`explicit:false`), and a scan that started an identity but never
completed pairing is WEDGED — indistinguishable from a slow first sync unless it is named.
Both ride `WaHistoryState` on every read, `needsRelink` included, and `GET /chats` carries
that state too because an empty list is precisely where the ambiguity bites.

**The wedge predicate reads session MATERIAL, never `creds.registered`** (TASK-20260818).
That flag is set by a single site in Baileys — the phone-number-code pairing flow — so a
QR-paired session, which is the only kind this helper creates, keeps it `false` permanently.
Reading it as "broken" fired on every healthy session, and because the remedy it triggers is
destructive (re-pairing clears the auth store) it deleted working sessions in a loop. The
predicate now asks what a session needs to RESUME — `account` plus a non-empty
`signalIdentities` — which is the same answer for both pairing flows.

**The helper is reaped on exit** (`RunEvent::Exit` → `sidecar::shutdown`, TASK-20260818).

### On-demand helper distribution (TASK-20260826, ADR-0060)

Helpers are **not** in the `.app`. Each is its own GitHub **pre-release**
(`helper-whatsapp-sidecar-v0.1.0`: two per-arch `tar.gz` + `.sig` + `helper.json`), self-contained
— the built helper, a production `node_modules` without sharp, and the official Node 22
binary pinned by sha256 in `apps/whatsapp-sidecar/node-runtime.json` — and minisign-signed
with the updater key. The shell **pins by content** (`src-tauri/helpers.json`, written by the release script and
`include_str!`'d by `helper_install.rs`: tag, version, per-arch sha256/sizes; `check-helper-pin`
in the root gate; `release-desktop.mjs` requires the published `helper.json` to equal it). On a user click —
the install landing, the pairing screen, or the header chip when a linked session is on disk
(`HelperInstallCard`, `helperInstall.ts`) — `helper_install` downloads from the pinned tag
with manual host-allowlisted redirects, verifies signature then pin, unpacks under admission
rules with an inflated-bytes cap into `<name>.partial-*`, two-rename-swaps it into
`~/Snug/helpers/<name>`, stamps `helper.json { kind: "downloaded" }` and starts it via its own
`bin/node`. A `kind: "dev"` tree (`install:helper`) is never overwritten and spawns the system
`node`. A version mismatch is *offered*, never refused. Staging + the printed
`gh release create --prerelease --latest=false` line: `scripts/release-helper.mjs`;
`release-desktop.mjs` refuses to stage a shell whose pinned helper tag is unpublished.
Spawning without reaping orphaned the child on every quit, so the next launch raced a rival
against the same auth store — a second, independent path to the same wedge.

Threat surface: `docs/security/threat-model-delta-whatsapp-sidecar.md` (+ its surface-v2
addendum). Desktop-only by construction — a browser tab cannot open a unix socket.

## Per-app model selection (TASK-20260817, ADR-0036)

The model was ONE global setting applied to every app in every lane. An app may now PIN
its own, and every app-scoped LLM call for that app routes there — the app's runtime
turns, the builder lane, app-attached chat, and the two inference call sites that have an
app id. All four resolve through one function, `resolveModelForApp(appId)`
(`playground/src/state/appModel.ts`), whose precedence is **pick → Settings default →
`undefined`**; the tail is contract, not a gap, because the adapters apply their own
`*_DEFAULT_MODEL` when `model` is absent, which is what an empty Settings field has
always meant.

Two properties are load-bearing. **Inheriting is an ABSENCE, not a copy**: an app that
was never picked-for stores no row and therefore FOLLOWS a later change to the global
default, which is also what keeps "pinned" distinguishable from "inherited". And
resolution happens **per send, never at construction** — RunView memoizes its transport
and `useBuilderChat` its agent, so a value read once would freeze the app on whatever was
chosen when the view mounted.

Storage is a namespaced key in the EXISTING `snug_settings` KV
(`appModel:<appId>`, shape single-homed in `packages/db/src/userdb/app-settings-keys.ts`),
so there is **no `USERDB_SCHEMA_VERSION` bump, no migration and no spec-changelog entry**
— the model is a host-side user preference, deliberately NOT a `RuntimeContract` field,
which would version-link it and push the change through `packages/protocol` (ADR-0036 D1).
The price of the shared namespace is that `deleteApp` must cascade to the key explicitly
(step 3c, an equality delete beside the `auth:<appId>:*` prefix delete). Under the
webllm/demo brain the pick is ignored and the control renders nothing — the brain
overrides the configured mode entirely (ADR-0015).

**Multi-provider BYOK (TASK-20260821, ADR-0046).** Keys for Anthropic AND OpenAI can be
saved side by side; the DEFAULT provider RESOLVES — an explicit `providerChoice` row
(absence = derived) → anthropic-if-keyed → openai-if-keyed → the demo brain — into the
same `providerStore` every consumer always read. Default models are per provider
(`providerModel:<provider>` rows; local/subscription keep the global `model`), and a
per-app pick now stores provider AND model (`appProvider:<appId>` beside `appModel:`,
both deleteApp-swept): a pin is a pin, inheriting stays an absence. Provider resolution
happens PER SEND at every adapter-construction site (transport, builder, the inference
ladder) — the memoized transports would otherwise freeze a mid-session pin. The build
page carries the same selector; a fresh thread's pick is session-scoped and becomes the
new app's pin on install. Legacy rows (`provider`, `model`) adopt forward once at
hydrate and are never deleted. The run header name prefers the DB-backed app-meta store
over the announce frame, which is what lets a USER RENAME (`appRenamed:<appId>` marker,
unique display names, announce-clobber guard at both altitudes) survive every run.
Deleting the LAST sidecar-fact app additionally performs the full device unlink
(`POST /session/forget`, nonce-only + persist tombstone; `sidecar_ctl("forget")` as the
Rust disk backstop) — ADR-0046 §7.

## Token-claim connections, Ledger, and the open-url capability (TASK-20260818, ADR-0038)

**A third pairing family.** The registry's `WellKnownPairing` union gained `token-claim`
(beside Hue's `exchange` and WhatsApp's `device-link`): a claim-once provider's setup
token — base64 of a claim URL the user pastes — is decoded by the WIZARD, checked against
the row's frozen ceiling (https, exact host, default port, no userinfo, `redirect:'error'`
on every request), POSTed once, and the returned access URL (path checked against the
entry's pinned `accessPath`) is parsed into the entry's two `basic_auth` fields — written
TOGETHER with `claimVerifiedAt` (the third verify-marker sibling) only after an ADR-0025
verify read. Registry data only, zero protocol bytes; `performTokenClaim` is the third
NAMED network seat in `packages/auth` (a mint, oauth-service's class). SimpleFIN is the
first occupant — pinned to `beta-bridge.simplefin.org` (the apex `bridge.` is a 302
alias; owner-found on the first real walk), `browserCallable: true` (probed), executor
wall clock raised to a named, self-describing 60 s for aggregate first pulls. The drift
migration's gate now detects a MOVED REGISTRY HOST (it was fields/seats/scopes-blind) and
stages it to the reapproval diff — a ceiling move never promotes silently.

**Ledger** (`examples/ledger/`) is the seventh connected starter: sample mode seeds a
deterministic household (planted subscription leaks) evicted wholesale by the first real
sync; deterministic radar/time-machine/cash-flow analytics (extracted-core tested); five
agent lanes over one discriminated schema; SimpleFIN addressed connection-relatively
(`snug-connection://simplefin/...` — an installed starter receives a rebuild only when
the user takes an offered update (ADR-0045), which can lag a registry move by any amount
of time, so an app must never name a host it didn't need to know).

**The open-url capability** (ADR-0038 D5): an app may REQUEST the host open an https URL
— internal-draft `snug:open-url-request`/`-result` frames (strict, https-only,
userinfo-free, URL-only), a value-blind runner seam (named refusal when absent,
single-pending per instance), and a host confirm dialog (provenance copy, punycode host,
synchronous `window.open('noopener,noreferrer')` inside the gesture; desktop rides the
system opener). The published half is host-ready's optional `openUrl` capability flag
(gen:schemas + spec-changelog). C2 untouched; popup-blocker escape proven in a real
browser on production runner bytes.

## Feedback channel + the hubAuth gate (TASK-20260822, ADR-0052)

**There is no hosted feedback receiver, and that is the decision, not a gap.** ADR-0013's
zero-endpoint claim keeps its strongest form through launch: in-product feedback is
**prefilled GitHub deep-links** — inline "report this" affordances inside the error
surfaces that already render (build failure, wizard connect-error, run install/export
failures, boot load-failure), one quiet header menu + a Settings card (bug / feature /
open feedback), all assembling issue-form field-id prefills or a Discussions composer
(`src/feedback/`, URLs single-homed in `config/site.ts`). Because a prefilled URL
transmits its query string ON OPEN, every path shows an in-product preview of the exact
fields first and navigates only on confirm (desktop rides the system opener); error text
passes a pattern-based credential-shape scrub BEFORE assembly (patterns, deliberately not
credential-store knowledge — a new reader of `snug_secrets` for a non-custody purpose was
refused), and the required `repro` form field is left empty on purpose so GitHub's own
validation asks the reporter for the reproduction. A hosted anonymous channel (Worker+D1
design, first ADR-0052 draft in git history) is parked to 1.1, evidence-gated. Ratings
(👍/👎) were cut with it.

**Sign-in is hidden structurally.** `capabilities.hubAuth` (optional platform seat,
absence = off) gates the `/auth/me` probe itself — the default build never fires it and
pins `unavailable`, so a static host answering 401 can no longer conjure the sign-in
button; web builds opt in with `VITE_SNUG_HUB_AUTH=1` (runbook updated, incl. the
measured caveat that server login gates `/auth/*` + `/userdb` only, never `/invoke`).

## App sharing — a shared app is a starter that travels (TASK-20260904, ADR-0063 / ADR-0064)

An owned app's run header carries a **share** control (between the connections door and the theme toggle). It opens a sheet that builds a `snug-app-bundle/1` — strict JSON, still a `.snug` file: the app's identity, the **current** version's html, its runtime contract, the registered schema as `CREATE …` DDL (structure, never rows), the wiki docs the sharer ticks (each with size and first line; `memory` off by default — it is what the app learned about the user), and every non-revoked connection's **requirement half** (a registry-known provider travels as the bare borrower so the recipient's registry substitutes its own pinned seats; a `lanHost` row exports without the sharer's collected address). Nothing personal has a seat: no secrets, grants, versions, chat, data rows or settings — the C1 test is a byte scan. A credential-shaped literal raises a named warning with "share anyway" (the sharer owns the code; the share scan is a third mode of the single-homed `credentialShapes`, digit-guarded so the shipped starters pass).

**Two transports, one bundle.** The attachment path has no server: download through the one `downloadBlob` dispatch (or the OS share sheet where `navigator.canShare` allows — AirDrop on a Mac), receive by double-click (the desktop's one Rust delivery is unchanged; the platform seat is now `onOpenSnugFile` and a TS dispatcher sniffs the FIRST BYTES — SQLite / `SNUGENC1` / `{` — so a bundle can never reach the replace-your-file confirm and a user file can never land on the shelf) or by Settings → **add shared app** (both pickers sniff and point at each other). The link path (phase 2) encrypts the same bytes in the browser (AES-256-GCM), uploads the ciphertext to the **blind relay** — `apps/share-relay`, a Cloudflare Worker + R2 bucket, the one hosted endpoint since ADR-0013, deployed only by `scripts/deploy-relay.mjs --deploy` on an explicit ask (runbook `docs/runbooks/deploy-share-relay.md`) — and puts the key in the URL fragment: `https://playground.snugprotocol.org/s/<id>#<key>`. The `/s/:id` page strips the fragment, fetches, decrypts and opens the preview FROM MEMORY; on a macOS browser it offers **open in Snug for Mac** (the `snug://s/<id>#<key>` scheme, delivered through `tauri-plugin-deep-link`'s own seats — a URL is data, not a read capability, so there is no allowlist command). The sharer's link records split by sensitivity: `shareLink:<appId>:<id>` in settings, the revoke token + key in `snug_secrets` under `share:<id>`.

**The receiving side reuses the starter machinery.** A received bundle sits on the **"shared with you"** shelf between "your apps" and "starter apps" (`share/sharedInbox.ts`: memory-first — persisted as `sharedApp:<bundleId>` only on an explicit act, an opened file or "keep"; the 13th is refused with a note, never evicted; `bundleId` is recomputed from the bytes). Its card opens `/run/shared--<bundleId>` — read-only like `starter--<folder>` (`isUnownedId` is the one predicate for the branches both share), opening on a docs tab that shows the bundle's docs and "what this app tells the AI" as text, and running **without the LLM transport** until "run with AI" is armed (a consent-gate transport answers `CONSENT_REQUIRED`; a starter keeps the real transport). **Install** is the starter chain under the `shared` provenance — `installAppFromBundle` in packages/db: `installApp` on `share:<lineage>` (a UUID-charset field, so a bundle can never spell `starter:<folder>` and `starterDeclaration`'s vouch is unreachable), v1 pinned, contract, DDL replay (a failure removes the half-made app), docs absent-only through the same `seedDocsAbsentOnly` starters use, and every connection through `putDeclaredConnection(…, 'shared')`, where the composition root's injected gate runs the borrow ban; a refused slot is dropped with a note, never the install. A later bundle of an installed lineage is detected by **identity** (`sharedBundle:<appId>`), and the installed app's header offers "update · keeps your data" — ADR-0045's act with a bundle as source. `CONNECTION_PROVENANCES`/`ADMISSION_CHANNELS` gained `shared` with **no `USERDB_SCHEMA_VERSION` bump** (a write-time enum widening; a bump would have stranded every fielded v6 hub). Threat surface: `docs/security/threat-model-delta-app-sharing.md` (model v3.1, R-34..R-38).

## Scheduled tasks — one scheduler in every runner, kept in the user's file (TASK-20261009, ADR-0074)

A Snug app thinks only while someone is looking. ADR-0074 adds the one timer the knowledge base now sanctions — the host's scheduler, never an app's own — and keeps its whole record in the user's file. Scheduling is a host feature, not protocol: nothing enters `packages/protocol/schemas/`, the envelope or the runtime contract; a host that never schedules is still conforming, and the spec is touched only in §8.1's transparency list of settings keys. **The storage rows** are five namespaced `snug_settings` key families (SPEC §8.1's own rule — no table, no v7 stamp that would strand every fielded v6 hub): `schedule:<taskId>` (the task — `title`, `enabled`, `provenance` user|builder|chat|app|imported, `steps[1..5]` of `notify` | `app-run` | `app-think`, the intuitive `spec` AND the compiled 5-field `cron` persisted together so the editor never reverse-parses cron, `missedPolicy` ask|run-once|skip, `staleAfterMs`, `alert` inbox|notification, `appVersions` recorded at enable, `ranThrough`, the pause reason and the failure/unseen counters), `scheduleRuns:<taskId>` (ONE bounded JSON array per task, newest first, each entry keyed `(taskId, dueAt)`: trigger due|late|catch-up|manual, status, `collapsedCount`, per-step results, `host {kind, binding}`, `calls {ai, net}`, pending `proposals` with one `expiresAt`, `seenAt`), `schedulerState` (the reconcile watermark, the global pause, the UTC-day counters — deliberately NO leader seat: leadership is runtime), and the per-app `scheduleDeclined:<appId>:<hash>` / `scheduleMuted:<appId>` (the user's answers to an app's suggestions, read in PR-B). The shapes live in `packages/protocol/src/schedule.ts` (an internal draft like `chat-intent.ts`, OUT of `json-schemas.ts` SOURCES; `strictObject` at every level; per-seat caps and whole-object byte caps — 16 KiB per task, 8 KiB per run; a credential-shaped string, a URL with userinfo or an authorization-like key ANYWHERE in a task, a run or a proposal is a parse refusal; tolerant readers answer `undefined`, never throw). The accessors live in `packages/db/src/userdb/schedules.ts` beside `userdb.ts` and are spread into the factory: writes fail closed (parse before any row), reads fail open (an unreadable row is "no such task" and is reported through `listUnreadableScheduleKeys`); the caps are enforced by refusing or pruning — ≤ 200 tasks, ≤ 50 entries and ≤ 64 KiB per task's history, 2 MiB across — and pruning takes `ok`/`skipped` first, failures second, never a `pending`, `needs-you` or `running` row. `deleteApp` sweeps the rows as step 3c' (a task whose every step names the app goes with its history; a multi-app task is left byte-identical and the engine marks the dead step at run time; declines by escaped prefix, the mute by equality). `reconcileImportedSchedules` sits at the exact slot `reconcileImportedConnections` occupies, so every path inherits it: on EVERY import, pull and export the `proposals` leave every run row (a foreign file can never plant an approval card) and a stale `running`/`pending` claim retires to `interrupted`; an UNTRUSTED import lands every task not canonically byte-identical to a local one `enabled:false, provenance:'imported'`, resets the watermark to now and drops declines and mutes; a TRUSTED pull keeps tasks and takes `max(local, imported)` for the watermark. `UserDb.getFileId()` exposes the `db_id` row `seedMeta` writes, which the engine keys its leader lock on.

**The engine** is `apps/playground/src/schedule/`, one source inherited by Snug for Mac and the host kit through the existing aliases, composed in `scheduler.ts` — a module store on the `threadSessions` discipline (ADR-0062): `initScheduler()` is IDEMPOTENT (the same promise for StrictMode's doubled effect, the `App.tsx` boot chain after `initSettings`, and both re-init chains — recover-fresh and `restoreUserDbFromBytes` — pinned by a composition-root spy test), and it resets wherever the thread sessions reset (it subscribes to `registryEpochStore`; a run in flight is recorded `interrupted`, reason `file swap`, and the engine re-inits from a microtask once the user db reports `ready`). Boot creates `schedulerState` with `watermark = now` when there is none (a first open never fabricates a backlog), sweeps `running` claims older than their bound to `interrupted` (`stale claim`), elects a leader, starts the ticker and reconciles once. The pure pieces each own one rule. `leader.ts` (written fresh, because `packages/db`'s `locks.ts` hangs at an opaque origin): a bounded 2 s `navigator.locks` probe, then a BLOCKING request on `snug-scheduler:<db_id>` so a follower is promoted the moment the leader tab closes; where locks are absent or refuse (an opaque origin, `file://`) this context leads and the honesty line says sibling tabs cannot be seen; only the leader reconciles and runs, a follower re-reads. `tick.ts`: a timer re-armed to the next minute boundary FROM `Date.now()` after each fire — ticks are hints, the clock is the truth — a fire ≥ 120 s late is one `late` tick, and `visibilitychange`→visible, `focus` and `online` each wake the engine. `plan.ts` (pure, the occurrence engine injectable): the window is `(max(watermark, enabledAt ?? createdAt, startsAt, ranThrough), now]` — `enabledAt` so a task created after a three-day closure inherits no misses, `ranThrough` so a file another device already reconciled is not re-planned; an occurrence already holding a run row in ANY status is deduped; within the 15-minute grace everything collapses to one `late` run for the latest; older occurrences are MISSED and collapse per task to ONE candidate (`dueAt` = the latest, `collapsedCount`); a candidate older than the task's freshness window is `skipped` (`stale`) with no card; the rest follow the policy — `ask` → a PERSISTED `pending` row the missed card reads, `run-once` → a `catch-up` run, `skip` → a history line; a one-off is always asked; a newer candidate supersedes an older pending; occurrences past `endsAt` become one `skip{ended}`. **Policy defaults derive from cost** (`floors.ts`): a reminder-only schedule catches up silently (`run-once`), anything that spends the brain or the network asks; the freshness window is one period clamped to [1 minute, 7 days] (a one-off keeps a day); the frequency floor is 5 minutes for the user's own schedule and 15 for anything the builder, the chat or an app proposed — and for `imported`. `queue.ts` claims BEFORE it runs: the row for `(taskId, dueAt)` is written `running` with `startedAt` before any step; an existing row in any status but `pending` means recorded — claimed by a sibling, finished here, carried in by a pull — and the item is dropped without a call; a refused claim write runs nothing; one item at a time, FIFO, under 120 s (300 s when a step asks the AI) with an `AbortController`; the finalise writes the result row, charges the day's counters, folds the outcome into the task and advances `ranThrough` — the dedupe record that lives on the task row, where pruning cannot reach it. `reconcileNow` applies the planner's actions in order and writes the **watermark last**, only when it moved; a throw before it leaves it where it was, so the next reconcile finds the same misses and the rows already written dedupe them (mutation-checked: write the watermark first → red). `protection.ts` holds the self-protection rules as pure values: five consecutive failures pause a task (`failures`), thirty results nobody opened pause it (`ignored` — `seenAt` is set only by a user gesture), the daily ceilings `ai: 100` / `net: 500` are counted on the UTC date of the file (a roaming file cannot earn a second day at another device's midnight) with an 80 % warning, and a global pause holds the queue without bursting. `cron.ts` is the hand-rolled 5-field cron and occurrence search (day-stepped in the task's IANA zone through one cached `Intl.DateTimeFormat` per zone; DST gap skipped, overlap once; a 400-day search bound; `compileSpec` / `specFromCron` / `describeSpec`), `parseScheduleText.ts` the deterministic English grammar behind the plain-language box and the chat offer (`scheduleOffer` answers only when a time expression and a verb of intent are both present — never a brain call).

***Ask [app]'s AI* runs on the app's own transport** (`appThink.ts`, `executors.ts`): `createAppTransport` for the step's app — its runtime contract, its per-app model/provider pin, the R-9 egress scrub per send, resolved PER CALL so a brain change binds the next question — with a host-assembled request and NO tools: the app's overview, its DDL (≤ 8 KiB), the step's user-typed `SELECT`s run on the scratch copy (read-only by construction, ADR-0019) with the rows rendered as data inside the data lane's `<query_result>` delimiter, and the prompt; action `scheduled-think`. The reply is text; a `proposals` array in it is dry-run on the scratch copy for its counts, at most three kept, and stored on the run row as pending *changes waiting for your OK* that the engine never executes. Multi-app schedules are independent steps — no step's content enters another step's prompt or another app's vendor. Under the demo brain the step is `refused` by name; the deleted app is `blocked` (`appMissing`). `finalizeOutcome` is the one place result text is made safe to store: a credential-shaped summary, alert or failure message is WITHHELD whole, the rest shape-scrubbed and capped. *Remind me* (`notify`) is an inbox result plus an alert the executor only SUGGESTS — the queue decides, once per run, only when the task's `alert` is `notification` and the platform's seat has `notify`.

**The honesty seat.** `SnugPlatform.scheduler?: SchedulerSeat` (`{ notify?, wakeMode: 'page' | 'background', hostLabel }`) is the ONE optional seat hosts differ through. Snug for Mac composes `{ wakeMode: 'page', hostLabel: 'Snug for Mac' }` with no `notify` (PR-B's `tauri-plugin-notification` brings it); the host kit composes `schedulerSeatFor(binding)` (`apps/host/src/platform-host.ts`) — "this artifact" under either artifact arm, "this page" for a plain file and for the local runner's page, page-bound, no `notify`, because a page inside a viewer or opened from disk cannot raise one; the web shell's seat is `platform/webNotify.ts` (`webSchedulerSeat`: "this tab", `notify` only where the `Notification` API exists, answering `denied` unless the Settings card's opt-in and an already-granted permission both hold at the call — it never asks; `requestPermission()` is the Settings card's click), not yet composed into `WEB_DEFAULT` at this write. `hostCapabilities().schedule` is `true` and `allows('schedule')` gates the engine (`false` → no ticker, no election, no row); `signals.ts` adds `scheduleRevisionStore`, bumped after every write so every view re-reads the file. `copy.ts` single-homes every user-facing sentence — the vocabulary is *schedule* (the item), *result* (one execution), *missed*, *suggestion*, *changes waiting for your OK*; "run" is the app verb only, and a test scans the tree for an internal word spelled to the user — and `honesty.ts` derives `hostHonesty`'s input per call from the platform (the seat's label, `wakeMode`, the custody store's memory rung, whether sibling tabs can be seen), so every surface that shows the line — the editor, the empty page, the consent surface, not only Settings — shows the same one; every run row records which host ran it. **The UI (R2)** is the same source: `/schedule` (`views/ScheduleView.tsx` — the create bar, the results list, the schedules), the editor as a ROUTE (`/schedule/new`, `/schedule/:id`) and a result route (`/schedule/:id/result/:dueAt`), each behind `ScheduleGate`, the one reader of `allows('schedule')` for routes; a header nav item (`ScheduleNavItem`) and the running whisper (`RunningChip`); on the hub the missed card (`MissedCard`, reading the persisted `pending` rows) and a schedule section (`ScheduleHubSection`); in Settings `ScheduleSettingsCard` (the global pause, the browser-notification opt-in asked for on the click, the honesty line, clear history). Threat surface: `docs/security/threat-model-delta-scheduling.md` (model v3.4, R-50..R-59).

**PR-B** adds *Run [app]* (a hidden `SnugAppFrame` fed over a kv handshake on the frames that already exist, behind a standalone confirm gate that always refuses a mutating call), the proposal ladder (builder tool, chat lane, app suggestion strip, SDK hook), desktop notifications and its own threat delta; until then an `app-run` step is refused by name.

## Build thread sessions — a turn belongs to its thread, not the view (TASK-20260903, ADR-0062)

Until 2026-09-03 every piece of a builder turn — messages, busy flag, step timeline, the in-flight `AbortController`, the round-trip inspector — lived in React component state inside `useBuilderChat`, and an unmount effect aborted the request ("never leave a request running headless"). React Router unmounts the view on every route change, so leaving `/build` for "your apps" killed a 30-minute build (the user bubble persisted, the assistant row never was); the same cleanup under StrictMode's simulated unmount broke the hub→build `?idea=` handoff in dev. The build page also knew exactly one thread id and could not reach any earlier conversation.

**Now:** `apps/playground/src/agent/threadSessions.ts` is a module-level registry of per-thread sessions (one `createStore` each, the same hand-rolled store the theme/mode/rail use). `useBuilderChat(threadId, …)` keeps its public API but resolves the thread's session and writes to it **by reference** from the `send()` closure, so the turn keeps streaming after every view is gone and a re-mounted view finds the live turn (hydration from the DB runs once per session, never over a streaming one). **The only abort is the user's explicit stop** (`stopThread`) or a user-DB swap seam (`resetThreadSessions` — called at import/pull, backup restore, recover-fresh, app delete and thread delete; the module doc lists them, per lesson 2026-08-20). The run view's think panel merges the session's builder round trips with its own per-mount app-frame transport trips (`mergeLlmInspectorStates`, after reduction), so a chat turn that kept running while the user was elsewhere is still fully inspectable on return. The inspector state lives on the session too: still **in memory only** (AC14 re-asserted at the byte level across a navigation round trip), still redacted, still bounded per session, and idle sessions are evicted LRU beyond `MAX_IDLE_SESSIONS` (a busy one never is). Several threads may be in flight at once — the busy guard is per thread; the hub server's per-thread 409 lock is unchanged and unaffected.

**Surface:** `state/buildThread.ts` is the per-tab active build thread (same `snug:thread` sessionStorage key, so an existing tab keeps its thread). The hub's create bar **mints a fresh thread** before handing the idea over — before this, an idea typed on "your apps" continued whatever thread the tab held and silently became an *edit* of the app it was pinned to. `views/ThreadSidebar.tsx` lists every thread in the user file (build and run-view threads alike; label = title → pinned app's name), badges the ones in flight, and offers switch / `+ new` / rename (`upsertThread` title) / delete (`db.deleteThread`: the thread row and its messages, pinned rows included, **never the app** — `resolveMainThread` then falls back per its own rules). Below 760px the list is a collapsed `<details>` above the chat. The header's **build** link opens a NEW conversation unless the current one still has a turn in flight (`openBuildMenu`): a finished build is history, one click away in the sidebar. The inspector renders **newest round trip first** on both surfaces — the latest progress is always in view, and nothing auto-scrolls.

## Dependency graph (who depends on whom → whose tests also run)

- `protocol` ← `runner`, `sdk`, `server`, `adapters`, `db`, `knowledge`, `playground` (change protocol → run everything)
- `db` ← `sdk`, `playground` (userdb schema constants come FROM protocol)
- `playground/src/schedule/` (the scheduler, ADR-0074) consumes `protocol` (the shapes) + `db` (the accessors, `getFileId`); `desktop` and `host` inherit it through the source alias — change the engine, the shapes or the accessors → run `playground`, `desktop` and `host`.
- `knowledge` ← `server`, `playground`, `desktop`; `sdk` dev-depends on it (the KB≡SDK sync suite)
- `adapters` ← `server`, `playground` (browser-direct byok/local)
- `runner` ← `playground`, `server`; `adapters`/`db`/`sdk` dev-depend on it (their suites exercise it)
- `auth` depends on `protocol` + `db` (CredentialStore seats on the user DB); `playground` now consumes it (AL-03 wires the connected-fetch executor into the runner's NetHandler seam) — change `auth` → run `auth` + `playground`. `runner` does NOT depend on `auth` (value-blind by lint, R4).
- `desktop` (apps/desktop) consumes the playground SOURCE (vite alias) + ALL seven @snugprotocol packages (protocol/runner/sdk/db/knowledge/adapters/auth per its package.json) — change any of those → run `desktop` too (`pnpm --filter desktop test`, plus `test:rust` and the `gate` script for shell-level changes).
- `host-mcp` (apps/host-mcp, TASK-20260907-binding-b-plugin-host) consumes `@snugprotocol/auth` (DEEP-imported: `dist/net-guards.js` + `dist/scrub.js`, because the barrel reaches `db` and drags in sql.js and the provider registry — 4,368 B against 329,902 B measured) and `@snugprotocol/protocol` (the bundle parser). It serves `apps/host`'s ONE page (`snug-host.html`, ADR-0072 §1) — turbo runs `host-mcp#test` after `host#build` → change either package, or the kit page, and run `host-mcp` too (`pnpm --filter host-mcp test`, then `pnpm --filter host-mcp build`); root `check-host-mcp` sweeps the release bundle for the `SNUG_MCP_TEST_` prefix, builds the plugin tree and starts it.
- `host` (apps/host, TASK-20260905-host-kit) consumes the playground SOURCE (vite alias, two modules swapped by resolved path) + ALL seven @snugprotocol packages, like `desktop` — change any of those, or playground source, → run `host` too (`pnpm --filter host test`, then `pnpm --filter host build` + `test:e2e` on the built page); root `check-host-kit` rebuilds the page twice and reads the runner's built `dist/csp.js` in the e2e.
- `share-relay` (apps/share-relay, ADR-0064) is a standalone Worker with NO workspace dependencies — plain `.mjs`, tested with `node:test`; its only contract with the playground is the HTTP shape in `handler.mjs` and the id/key grammar restated in `apps/playground/src/share/relayClient.ts` (a change to either → run both).
- `website` (apps/website, ADR-0048) is the public marketing + docs/spec site — a static Astro build OUTSIDE the runtime product. It reads the playground source read-only via the same `@playground` alias (`releaseChannel.ts` constants, theme tokens) and derives its docs pages from `docs/spec-drafts/` + `packages/protocol/schemas/` + the whitepaper; drift is gated by root `check-website-sync` (manifest `apps/website/docs-sync.json`, remedy `/sync-website`). Change `releaseChannel.ts`, the spec draft, the schemas, `docs/product-vision.md`, or the whitepaper → the gate names the website pages owed an update. Both the website and the playground deploy to Cloudflare Pages as static direct uploads via `scripts/deploy-web.mjs` (ADR-0054; runbook `docs/runbooks/deploy-web.md`) — production only from merged `main`, hosted-posture invariants (ADR-0013) enforced by the script. **Live since 2026-08-24**: `snugprotocol.org` (project `snug-website`, whose `pages.dev` subdomain is `snug-website-c7z.pages.dev` — Cloudflare suffixed it) and `playground.snugprotocol.org` (project `snug-playground`). The zone's script-injecting features are OFF and read back from the API, which is how ADR-0013's no-telemetry claim is actually falsified — the `cdn-cgi` response grep alone does not prove it.

## External dependencies
LLM providers: Anthropic + OpenAI via `adapters` — browser-direct in byok mode (CORS opt-in header), any OpenAI-compatible localhost endpoint in local mode (Ollama), hub-side in subscription mode. Experimental: `@mlc-ai/web-llm` (pinned, playground-only, code-split) runs a small model in-page on WebGPU behind the `?webllm=1` flag — same AgentAdapter contract via a brain OVERRIDE of the configured mode, tool-free fenced-HTML build path, demo-brain fallback when WebGPU is absent (ADR-0015; GA at 1.2). sql.js (WASM SQLite), OPFS (browser). Hub server: better-sqlite3 stores, openid-client (Google OIDC), @fastify/{cookie,static,cors}. Dropbox HTTP API (example personal sync origin, PKCE public client). No cloud services required for OSS usage.

## North-star (aspirational, clearly not current)
Multi-implementation protocol (non-JS SDKs), true network-offline app runtime (vendored-runtime template — apps currently load React from the CDN allowlist), desktop local hub, OneDrive/Drive/S3 SyncProviders, CRDT multi-device merge, KeyProvider/KMS for cryptographic host-blindness, CI-enforced spec-sync.
