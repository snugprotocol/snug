# Snug — Glossary

- **Micro app / Snug app** — a single-file HTML app built by an end user through conversation, run in the sandboxed runner, thinking through the host agent at runtime.
- **Host agent** — the LLM assistant of the embedding product; the "mind" of every Snug app.
- **Envelope** — the versioned JSON message wrapper for app↔agent traffic over postMessage (`[SNUG_APP_REQUEST]` / response). Defined in `packages/protocol`.
- **Bridge** — the parent-window code that relays envelopes between iframe and agent endpoint (`packages/runner`).
- **Runner** — the sandboxed iframe host component (C2 constraints).
- **Per-app DB** — isolated sql.js database per app instance, persisted to OPFS, exportable as `.snug` (`packages/db`).
- **Knowledge base (KB)** — the markdown corpus that teaches an LLM to author bridge-aware Snug apps (`packages/knowledge`).
- **Adapter** — server-side connector from the reference backend to an LLM provider (`packages/adapters`).
- **Broker** — the server-side credential component enforcing the token boundary (v1.1, `packages/auth`).
- **Connection** — an approved credential grant tying one app to one provider and a frozen host list (`snug_connections`; `(app_id, slot)` is the PRIMARY KEY, so an app may hold SEVERAL independent connections). Only an explicit user approval in the wizard ever creates one. Its `requirement` (what the app NEEDS) and its `status`/`allowed_hosts` (what the user ALLOWED) are deliberately separate halves — see **Requirement/grant split**.
- **Auth wizard** — the host-side review surface where a proposed connection is inspected and approved (`apps/playground/src/connections/`). Its **strong** review is field-by-field (`spec_confirm`); its **light** review is approve-as-is, reachable only for a registry-resolved builder directive.
- **Declaration / install act** — a starter's `examples/<folder>/connection.json`, the third and newest way a connection may be proposed: it travels with the *install*, never at runtime, is resolved on demand rather than persisted, and always gets the strong review. See the trust ladder in [architecture.md](architecture.md).
- **Dual-layer auth** — publisher/org credentials (client_id/secret) + per-user OAuth tokens, resolved server-side.
- **Spec-sync** — the process by which this repo publishes protocol changes to `snugprotocol/spec` (SPEC_SYNC.md).
- **Host kit** — `snug-host.html`, the playground's own tree built as one self-contained page for the skill-delivered bindings (ADR-0065, TASK-20260905-host-kit); a clone of the playground / Snug Desktop minus the brain, model/provider and account controls (D15).
- **Binding** — where the host kit woke up and what it attaches to: `artifact` (Claude Code / Cowork hosted artifact), `artifact-chat` (claude.ai / Claude Desktop chat), `local-host` (a page served on loopback by the skill's launcher), `file` (a plain file opened in a browser). Disclosure and recipes read it; capability flags, not the binding, decide what renders.
- **Platform brain** — the brain a host PINS through `platform.brain` (`{kind:'demo'}` or `{kind:'host', label, adapter, streaming, tools, maxPromptBytes?}`); the one brain derivation honours it ahead of the webllm flag and the user file, for apps and the builder alike. The brain chip discloses it and offers no switch.
- **Starter source** — `starter/starterSource.ts`, the one module that owns the five `examples/` globs behind a `StarterSource` interface; the host kit aliases it to an on-demand implementation so no starter bytes ride the page.
- **Playground** — the hosted demo app (chat → build → run), bring-your-own-API-key.
- **User DB / snug file** — the single portable SQLite file per user: apps + versions (factory pinned), per-app data as native `app_<token>__*` tables with a verbatim-DDL schema registry, per-app wiki docs, chats (bootstrap pinned), settings, secrets, sync config (ADR-0007/0010; spec v0.2 draft schema v2).
- **Materializer** — the userdb driver backend (ADR-0010): at app load it replays the registry DDL into the app's OWN runtime DB (natural names, physical isolation); at write-back it recreates rest tables via `legacy_alter_table` RENAME inside one synchronous transaction, fail-closed on the object-name gate.
- **App wiki / docs** — per-app compounding memory in `snug_app_docs` (vision · requirements · plan · lessons · memory · next-tasks), maintained by the agent on every app change via the `app_doc_write` tool.
- **Factory version** — v1 of a built or installed app, `pinned` and never pruned; "reset to factory" copy-forwards it.
- **Hub provider** — a multi-tenant service provisioning Snug apps per user; optional by construction — apps run from the browser copy of the user DB with no hub backend.
- **Sync origin** — where the user DB replicates (hub `/userdb`, Dropbox, …) via the `SyncProvider` contract; OPFS is authoritative, divergence resolves only by explicit user action (ADR-0009).
- **Execution mode** — `byok` (browser-direct frontier API), `local` (browser-direct localhost LLM), or `subscription` (hub-mediated /invoke); the user DB is client-authoritative in all three (ADR-0008).
- **Per-app model / pinned model** — the LLM model ONE app routes its calls to, chosen in that app's run header and stored as `snug_settings['appModel:<appId>']` (ADR-0036). An app with no pin **inherits** the global Settings model and keeps following it when that changes — inheritance is an absence, never a copy.
- **Effective model** — what `resolveModelForApp(appId)` answers: the app's pin, else the Settings default, else `undefined` (meaning "let the adapter apply its own provider default"). Read per send, never captured at construction.

- **token-claim** — the third pairing family (ADR-0038): a claim-once provider mints a
  permanent `basic_auth` pair from a ONE-TIME setup token the user pastes; the wizard
  decodes it, checks it against the frozen ceiling, claims once, verifies, and writes
  credentials + `claimVerifiedAt` together. SimpleFIN is the first occupant.
- **open-url capability** — the host-mediated way an app opens a website (ADR-0038 D5):
  an internal-draft frame the runner routes to a host confirm dialog; only a real user
  gesture opens the tab (`noopener,noreferrer`), and the sandbox gains nothing (C2).
- **Demo brain** — the zero-key default "AI": the mock adapter's scripted turns
  (`byok` mode + `mock` provider, and the keyless fall-through for a keyed provider).
  Since ADR-0059 it is always ambiently disclosed — the header **brain chip** names
  what's thinking on every route, each scripted assistant turn carries a persisted
  `brainKind` provenance tag, and a first-contact callout introduces it once.
- **Brain chip** — the header status surface (`BrainChip.tsx`) consuming
  `resolveActiveBrain`, the live evaluation of `adapterKindFor` — the ONE adapter
  routing derivation (ADR-0059 rule 2).

**App bundle** — one app lifted out of a user file as strict JSON (`snug-app-bundle/1`), carried in a `.snug` file or an encrypted link: the current code, connection *requirements* (shapes, never grants or credentials), the runtime contract, the data schema as `CREATE` DDL (structure, never rows), and the wiki docs the sharer chose. Never carries data, secrets, history or chat (ADR-0063).

**Lineage** — the sharer's app id carried in a bundle, minted by the recipient's installer into `install_source = 'share:<lineage>'`. It is what makes a re-share recognisable as an *update* of an installed copy rather than a second app. Public by construction — anyone holding a bundle knows it (threat-model R-39).

**Shared shelf** — the hub's "shared with you" section between "your apps" and "starter apps". Memory-first: a received bundle persists only after an explicit act (opening an attachment, or "keep" on a link preview), and is inert until install.

**Blind relay** — the one hosted endpoint (ADR-0064): a Worker + R2 bucket that stores app bundles already encrypted in the sharer's browser, with the key carried only in the link's URL fragment. It can neither read what it holds nor substitute it.
