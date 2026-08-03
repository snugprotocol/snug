# Snug — Glossary

- **Micro app / Snug app** — a single-file HTML app built by an end user through conversation, run in the sandboxed runner, thinking through the host agent at runtime.
- **Host agent** — the LLM assistant of the embedding product; the "mind" of every Snug app.
- **Envelope** — the versioned JSON message wrapper for app↔agent traffic over postMessage (`[SNUG_APP_REQUEST]` / response). Defined in `packages/protocol`.
- **Bridge** — the parent-window code that relays envelopes between iframe and agent endpoint (`packages/runner`).
- **Runner** — the sandboxed iframe host component (C2 constraints).
- **Per-app DB** — isolated sql.js database per app instance, persisted to OPFS, exportable as `.sqlite` (`packages/db`).
- **Knowledge base (KB)** — the markdown corpus that teaches an LLM to author bridge-aware Snug apps (`packages/knowledge`).
- **Adapter** — server-side connector from the reference backend to an LLM provider (`packages/adapters`).
- **Broker** — the server-side credential component enforcing the token boundary (v1.1, `packages/auth`).
- **Dual-layer auth** — publisher/org credentials (client_id/secret) + per-user OAuth tokens, resolved server-side.
- **Spec-sync** — the process by which this repo publishes protocol changes to `snugprotocol/spec` (SPEC_SYNC.md).
- **Playground** — the hosted demo app (chat → build → run), bring-your-own-API-key.
- **User DB / snug file** — the single portable SQLite file per user: apps + versions, per-app data (blob-embedded databases), chats, settings, secrets, sync config (ADR-0007; spec v0.2 draft).
- **Hub provider** — a multi-tenant service provisioning Snug apps per user; optional by construction — apps run from the browser copy of the user DB with no hub backend.
- **Sync origin** — where the user DB replicates (hub `/userdb`, Dropbox, …) via the `SyncProvider` contract; OPFS is authoritative, divergence resolves only by explicit user action (ADR-0009).
- **Execution mode** — `byok` (browser-direct frontier API), `local` (browser-direct localhost LLM), or `subscription` (hub-mediated /invoke); the user DB is client-authoritative in all three (ADR-0008).
