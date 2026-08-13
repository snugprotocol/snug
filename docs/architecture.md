# Snug — Architecture

> Status: **implemented (living-apps evolution + hub ops + hub polish + observability/caching + Dynamic Auth v2 + lean runtime turns & intent-routed data chat, pre-launch)** — 2026-08-11, TASK-20260804-observability-caching (on TASK-20260804-hub-polish (on TASK-20260803-hub-ops (on living-apps, TASK-20260803-living-apps, on portable-hub, TASK-20260803-portable-hub). Hub ops added: long-run builds (48-iteration ceiling — there was never a timeout), 30-minute server lifetimes, a build step timeline, an in-memory LLM round-trip inspector (a SIBLING of the structural frame inspector, never an extension), cascade app delete with a terminal-delete tombstone, and the LLM-optional app doctrine (ADR-0011)). Hub polish added: a header identity menu with the Google avatar, the ember-niche brand mark, one merged "think" rail surface, round-trip observability in the build view AND the app-frame transport, explicit starter install (a starter is read-only until owned), build-thread continuity, and CAS conflicts that reach the divergence resolver instead of throwing. Observability/caching added: LIVE round-trip observation (calls and tools appear as they start, each timed), the wire model name, prompt caching on the stable tools+system prefix of BUILDER turns only (a per-TURN request flag — the app-frame envelopes are below the cacheable minimum and deliberately excluded) (ADR-0012), cache-hit reporting as a cached %, and a rotating status line replacing the duplicate step timeline. The inspector's memory bound moved from a per-field ingest cap to a total-bytes budget so expanded payloads can be shown whole.) Three-actor model: LLM providers · hub providers · the end user who owns ONE portable SQLite file. Apps are LIVING: LLM-designed native data schemas (ADR-0010), app-attached chat with compounding per-app wiki docs, factory-pinned versions. Wire protocol unchanged at v1; storage/hub behavior is spec v0.2 draft schema v2 (`docs/spec-drafts/spec-v0.2-userdb.md`). Auth broker (app credentials) remains v1.1 — hub LOGIN shipped separately in `apps/server`.
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
     surface; v5 internal draft: snug_connections — snug_auth_specs was dropped at v5)
     + auth-schema.ts + connection-requirement.ts (internal)
   apps/server (OPTIONAL hub) = /invoke + artifact cache + Google OIDC + /userdb + static
   packages/auth (AL-02/AL-03, ADR-0014) = Dynamic Auth pure core + connected-fetch
     runtime, LOCAL-FIRST: browser-safe DI-pure OAuth service + CredentialStore over the
     user file's snug_secrets `auth:` keys — credentials live in the USER'S file, never a
     server vault; host ceiling always strict (C1, no knob). The connected-fetch executor
     is the ONLY host-side fetch caller; injection is always strict (audit bug 3 dead by
     construction). Wizard/UI shipped in AL-04 (`apps/playground/src/connections/`).
```

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
| the builder LLM (already reviewed) | chat directive → `resolveWizardIntent` | registry rung light · inference strong |
| the **install act** | starter's `examples/<folder>/connection.json` | **always strong** (field-by-field) |

The install-act rung (TASK-20260807-connection-reachability) exists because a chat-less
app — a starter, anything installed rather than built — otherwise had no reachable path
to a connection at all. Its declaration is **never persisted**: it is resolved on demand
and only when TWO independent facts hold — `install_source` maps to a bundled manifest,
AND the installed HTML matches the bundled starter's for **both** the pinned factory
version and the version that actually runs. Requiring the running version is the security
property: the iframe executes `current_version` and credential brokering keys on `appId`,
so vouching for bytes that never run would let an imported DB pair pristine code with an
attacker's. Any mismatch is reported in Settings, never silently withdrawn.

The declaration rides in its own immutable wizard-session field, so it forces the strong
review unconditionally — no mid-session action (notably "infer from docs") can downgrade
it to the light path. **Every write still goes through an explicit user approval in the
wizard; the only non-test `putAuthSpec` call site lives there.** Manifests are trusted
only because they are first-party, in-repo, PR-reviewed content gated by the `examples`
validate suite. **Before any UNTRUSTED declaration channel can exist** (an app-import
flow above all), a `providerName` charset/confusable guard and a registry-borrow ban are
hard prerequisites — see `docs/next-steps.md`.

## Desktop shell (TASK-20260812-desktop-hub-scaffold, ADR-0021)

`apps/desktop` wraps the SAME playground source (vite alias, `HashRouter`, desktop entry)
in a Tauri 2 shell — BYOK/local only, no subscription surface. The playground gained ONE
seam: `src/platform/platform.ts` (`SnugPlatform`, set-once before boot; web default =
prior behavior byte-for-byte). Desktop supplies: native fetch (`tauri-plugin-http`,
CORS-free) through the connected-fetch `fetchImpl` seam AND the LLM adapters; a `'file'`
`PersistenceBackend` persisting `~/Snug/user.sqlite` via atomic Rust commands (userdb +
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
2026-08-12, Windows pends first CI run (first workflow: `.github/workflows/ci.yml`).
Threat surface: `docs/security/threat-model-delta-desktop-shell.md`.

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
family, `{{cdp_jwt(api_key, private_key)}}`: a host-side ES256 mint (`es256-key.ts`
DER-wraps CDP's SEC1 PEM into the PKCS#8 WebCrypto requires) whose `uri` claim binds the
signature to the live outbound request, `exp` at +120 s. `queryTemplate` renders into the
URL **after** every gate, suppresses the kind default so a query credential is never also
a header, and joins an enumerated scrub site list. Rows are admitted once and never re-read
the registry, so the wizard's open path runs `migrateConnectionRegistryDrift` — seat drift
re-substitutes and re-persists without re-crediting; field-set drift routes to
re-credential.

**Silent auth failures surface.** A credentialed 401/403 still reaches the app unchanged
(`ok:true`, status as-is — the app contract is not broken to gain visibility), and a
host-only `onAuthShapedFailure` observer fires on the FINAL delivered result, rendering
`AuthRepairBanner` in RunView with a CTA into the wizard on the exact failing (appId, slot).

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

## Dependency graph (who depends on whom → whose tests also run)

- `protocol` ← `runner`, `sdk`, `server`, `adapters`, `db`, `playground` (change protocol → run everything)
- `db` ← `sdk`, `playground` (userdb schema constants come FROM protocol)
- `knowledge` ← `server`, `playground`
- `adapters` ← `server`, `playground` (browser-direct byok/local)
- `runner` ← `playground`
- `auth` depends on `protocol` + `db` (CredentialStore seats on the user DB); `playground` now consumes it (AL-03 wires the connected-fetch executor into the runner's NetHandler seam) — change `auth` → run `auth` + `playground`. `runner` does NOT depend on `auth` (value-blind by lint, R4).
- `desktop` (apps/desktop) consumes the playground SOURCE (vite alias) + `auth`/`db`/`adapters` — change any of those → run `desktop` too (`pnpm --filter desktop test`, plus `test:rust` and the `gate` script for shell-level changes).

## External dependencies
LLM providers: Anthropic + OpenAI via `adapters` — browser-direct in byok mode (CORS opt-in header), any OpenAI-compatible localhost endpoint in local mode (Ollama), hub-side in subscription mode. Experimental: `@mlc-ai/web-llm` (pinned, playground-only, code-split) runs a small model in-page on WebGPU behind the `?webllm=1` flag — same AgentAdapter contract via a brain OVERRIDE of the configured mode, tool-free fenced-HTML build path, demo-brain fallback when WebGPU is absent (ADR-0015; GA at 1.2). sql.js (WASM SQLite), OPFS (browser). Hub server: better-sqlite3 stores, openid-client (Google OIDC), @fastify/{cookie,static,cors}. Dropbox HTTP API (example personal sync origin, PKCE public client). No cloud services required for OSS usage.

## North-star (aspirational, clearly not current)
Multi-implementation protocol (non-JS SDKs), true network-offline app runtime (vendored-runtime template — apps currently load React from the CDN allowlist), desktop local hub, OneDrive/Drive/S3 SyncProviders, CRDT multi-device merge, KeyProvider/KMS for cryptographic host-blindness, CI-enforced spec-sync.
