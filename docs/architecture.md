# Snug — Architecture

> Status: **implemented (living-apps evolution + hub ops + hub polish + observability/caching + Dynamic Auth v2 + lean runtime turns & intent-routed data chat + desktop distribution/update channel, pre-launch)** — 2026-08-21 (TASK-20260821-hardening-polish added the shell update channel + `/download`, ADR-0047; threat model is at v2.0); prior baseline 2026-08-15 (post-08-11 merges, each with its own section or ADR: registry-authoritative auth + multi-option auth kind ADR-0020 · desktop shell ADR-0021 · desktop-aware auth/LAN providers ADR-0022/0023 · think-rail ADR-0024 · LAN verify-before-claim ADR-0025 · connection-relative addressing ADR-0026 · registry-pinned scopes + provider-reason auth banner + pinned-URL console links ADR-0028/0029), TASK-20260804-observability-caching (on TASK-20260804-hub-polish (on TASK-20260803-hub-ops (on living-apps, TASK-20260803-living-apps, on portable-hub, TASK-20260803-portable-hub). Hub ops added: long-run builds (48-iteration ceiling — there was never a timeout), 30-minute server lifetimes, a build step timeline, an in-memory LLM round-trip inspector (a SIBLING of the structural frame inspector, never an extension), cascade app delete with a terminal-delete tombstone, and the LLM-optional app doctrine (ADR-0011)). Hub polish added: a header identity menu with the Google avatar, the ember-niche brand mark, one merged "think" rail surface, round-trip observability in the build view AND the app-frame transport, explicit starter install (a starter is read-only until owned), build-thread continuity, and CAS conflicts that reach the divergence resolver instead of throwing. Observability/caching added: LIVE round-trip observation (calls and tools appear as they start, each timed), the wire model name, prompt caching on the stable tools+system prefix of BUILDER turns only (a per-TURN request flag — the app-frame envelopes are below the cacheable minimum and deliberately excluded) (ADR-0012), cache-hit reporting as a cached %, and a rotating status line replacing the duplicate step timeline. The inspector's memory bound moved from a per-field ingest cap to a total-bytes budget so expanded payloads can be shown whole.) Three-actor model: LLM providers · hub providers · the end user who owns ONE portable SQLite file. Apps are LIVING: LLM-designed native data schemas (ADR-0010), app-attached chat with compounding per-app wiki docs, factory-pinned versions. Wire protocol unchanged at v1; storage/hub behavior is internal-draft schema v6 (`docs/spec-drafts/SPEC-v0.3-draft.md` staged — the consolidated v0.3 release candidate, TASK-20260820-spec-v03-whitepaper; `userdb-schema.ts` is the truth). Auth broker (hosted credential custody) is deliberately unbuilt — RFC at 1.6, GA at 2.0 (roadmap v2, owner decision 2026-08-05); hub LOGIN shipped separately in `apps/server`. **SimpleFIN token-claim + the Ledger starter + the open-url capability (2026-08-18, ADR-0038)**: see the section below. **Per-app model selection (2026-08-18, ADR-0036)**: each app may pin its own LLM model and every app-scoped call for it routes there; storage is a namespaced `snug_settings` key, so the wire protocol and userdb schema are both unchanged (see the section below).
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
human-authored `desktopRedirectPosture` + `browserCallable` seats (registry-level data,
NOT requirement seats — no protocol change); unsupported postures refuse at wizard entry,
and `pkce:false` + loopback is structurally refused (auth-code injection). The connected-
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
check that is quiet on failure (pre-flip the private repo 404s for everyone, so silence
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

## Dependency graph (who depends on whom → whose tests also run)

- `protocol` ← `runner`, `sdk`, `server`, `adapters`, `db`, `knowledge`, `playground` (change protocol → run everything)
- `db` ← `sdk`, `playground` (userdb schema constants come FROM protocol)
- `knowledge` ← `server`, `playground`, `desktop`; `sdk` dev-depends on it (the KB≡SDK sync suite)
- `adapters` ← `server`, `playground` (browser-direct byok/local)
- `runner` ← `playground`, `server`; `adapters`/`db`/`sdk` dev-depend on it (their suites exercise it)
- `auth` depends on `protocol` + `db` (CredentialStore seats on the user DB); `playground` now consumes it (AL-03 wires the connected-fetch executor into the runner's NetHandler seam) — change `auth` → run `auth` + `playground`. `runner` does NOT depend on `auth` (value-blind by lint, R4).
- `desktop` (apps/desktop) consumes the playground SOURCE (vite alias) + ALL seven @snugprotocol packages (protocol/runner/sdk/db/knowledge/adapters/auth per its package.json) — change any of those → run `desktop` too (`pnpm --filter desktop test`, plus `test:rust` and the `gate` script for shell-level changes).

## External dependencies
LLM providers: Anthropic + OpenAI via `adapters` — browser-direct in byok mode (CORS opt-in header), any OpenAI-compatible localhost endpoint in local mode (Ollama), hub-side in subscription mode. Experimental: `@mlc-ai/web-llm` (pinned, playground-only, code-split) runs a small model in-page on WebGPU behind the `?webllm=1` flag — same AgentAdapter contract via a brain OVERRIDE of the configured mode, tool-free fenced-HTML build path, demo-brain fallback when WebGPU is absent (ADR-0015; GA at 1.2). sql.js (WASM SQLite), OPFS (browser). Hub server: better-sqlite3 stores, openid-client (Google OIDC), @fastify/{cookie,static,cors}. Dropbox HTTP API (example personal sync origin, PKCE public client). No cloud services required for OSS usage.

## North-star (aspirational, clearly not current)
Multi-implementation protocol (non-JS SDKs), true network-offline app runtime (vendored-runtime template — apps currently load React from the CDN allowlist), desktop local hub, OneDrive/Drive/S3 SyncProviders, CRDT multi-device merge, KeyProvider/KMS for cryptographic host-blindness, CI-enforced spec-sync.
