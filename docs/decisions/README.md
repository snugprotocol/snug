# Architecture Decision Records (ADRs)

Append-only decision log for Snug. One file per decision: `NNNN-short-kebab-title.md`. Never rewrite or delete a past ADR — a reversal is a new ADR that supersedes it, and the superseding/amending change updates the old ADR's **status line only** in the same commit (ADR-0027). Status: `accepted` · `accepted (amended by NNNN)` · `superseded by NNNN` · `proposed`.

## Template

```markdown
# NNNN — <Title>

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Task:** TASK-YYYYMMDD-slug

## Context
## Decision
## Alternatives considered
## Consequences
```

## Index

- [0001 — Adopt the agentic engineering process](0001-adopt-agentic-engineering-process.md)
- [0002 — Two-repo topology: snug (master) drives spec (downstream)](0002-snug-master-spec-downstream.md)
- [0003 — v1 scope and hard security constraints inherited from prior production systems](0003-v1-scope-and-security-constraints.md)
- [0004 — Central layered prompt store](0004-central-layered-prompt-store.md)
- [0005 — Playground is a Vite + React SPA](0005-playground-vite-spa.md)
- [0006 — Runner CSP allows 'unsafe-eval' + a fixed CDN allowlist](0006-runner-csp-unsafe-eval-cdn.md)
- [0007 — Single portable per-user SQLite DB with per-app namespaces and app versioning](0007-single-portable-user-db.md)
- [0008 — Serverless app execution; LLM calls from the host page, never from the app iframe](0008-serverless-execution-host-llm-bridge.md)
- [0009 — User-DB sync: OPFS runtime copy, pluggable SyncProvider origins, LWW v1](0009-sync-provider-origins.md)
- [0010 — Per-app data as LLM-designed native tables; materialized runtime DB for isolation](0010-app-native-schemas-materialized-runtime.md)
- [0011 — Apps are LLM-optional: the agent is a capability, not a requirement](0011-llm-optional-apps.md)
- [0012 — Prompt caching is a per-turn decision, scoped to builder/agent turns](0012-prompt-caching-scope.md)
- [0013 — Hosted hub is static files only (zero-backend doctrine)](0013-hosted-hub-static-zero-backend.md)
- [0014 — Credentials are local-first (custody doctrine)](0014-credentials-local-first.md)
- [0015 — WebLLM experimental mode: engine, model default, fallback](0015-webllm-experimental-mode.md)
- [0016 — Who may propose a connection (the trust ladder)](0016-connection-proposal-trust-ladder.md)
- [0017 — The requirement/grant split (amends ADR-0016)](0017-connection-requirement-and-grant.md)
- [0018 — App runtime turns assemble from an authored, version-pinned runtime contract](0018-runtime-prompt-contract.md)
- [0019 — App chat is intent-routed; data agency is scratch-isolated reads + human-approved writes](0019-intent-routed-app-chat-data-agency.md)
- [0020 — Multi-option auth: the host defaults, discloses, and the user rebinds](0020-multi-option-auth-kind.md)
- [0021 — Desktop shell transports: loopback OAuth, registry redirect postures, native fetch, file-backed userdb](0021-desktop-shell-transports.md)
- [0022 — Registry request seats, host-side signing functions, and auth-shaped failure surfacing](0022-registry-request-seats.md)
- [0023 — LAN-class providers: user-supplied bridge hosts, pairing exchanges, scoped TLS trust](0023-lan-class-providers.md)
- [0024 — The think rail is user-sized and dismissible; the frame view is deleted while its feed lives on](0024-think-rail-user-sized-frames-view-removed.md)
- [0025 — LAN pairing verifies before it claims; LAN rows never route through the api-key screens](0025-lan-pairing-verify-before-claim.md)
- [0026 — Connection-relative addressing: apps name their connection, never its host](0026-connection-relative-addressing.md)
- [0027 — Docs memory is distilled, not accumulated](0027-docs-memory-distilled-not-accumulated.md)
- [0028 — Registry-pinned OAuth scopes: reviewed registry data, never silent defaults](0028-registry-pinned-scopes.md)
- [0029 — Console-URL clickability keys on registry-pinned bytes, not row provenance](0029-registry-pinned-url-clickability.md)
- [0030 — CDP JWT: host-side Ed25519 signing for Coinbase-class providers](0030-cdp-jwt-ed25519.md)
- [0031 — Provider chat lane, inline cards, and the read/write posture reset](0031-provider-chat-lane-and-write-posture.md)
- [0032 — Linked-device connections: the `linked_device` kind and the WhatsApp sidecar](0032-linked-device-connections-whatsapp-sidecar.md)
- [0033 — Armed auto-reply: the first standing, scoped write approval](0033-armed-auto-reply-standing-write-approval.md)
- [0034 — Sidecar surface v2: event long-poll, media reads, and the host live pump](0034-sidecar-surface-v2-live-pump.md)
- [0035 — Starter authoring docs become the installed app's wiki seed](0035-starter-authoring-docs-ingestion.md)
- [0036 — Per-app model selection](0036-per-app-model-selection.md)
- [0037 — Sidecar durable thread cache and launch-time sync resume](0037-sidecar-durable-sync-resume.md)
- [0038 — SimpleFIN rides plain connected-fetch via a token-claim pairing; Ledger ships the open-url concierge capability](0038-simplefin-token-claim-and-ledger.md)
- [0039 — Gmail starter: pinned modify/settings/send scopes and governed inbox cleanup](0039-gmail-starter-scopes-and-governed-cleanup.md)
- [0040 — Host-enforced third-party pseudonymisation backstop (R-9)](0040-host-pseudonymisation-backstop.md)
- [0041 — The merge gate moves from GitHub Actions to one local command](0041-local-merge-gate.md)
- [0042 — `.snug` is the canonical user-file name](0042-snug-file-extension.md)
- [0043 — Opt-in passphrase encryption at rest (the `SNUGENC1` container)](0043-passphrase-encryption-at-rest.md)
- [0044 — The spec v0.3 publication line: strict schemas publish strict; host contracts publish as prose](0044-spec-v03-publication-line.md)
- [0045 — Starter versioning and the in-place update channel](0045-starter-versioning-and-update-channel.md)
- [0046 — Multi-provider BYOK defaults, per-app provider pins, and the app-lifecycle controls](0046-multi-provider-byok-and-app-lifecycle-controls.md)
- [0047 — Desktop distribution and the shell update channel](0047-desktop-distribution-and-update-channel.md)
- [0048 — Public website: one static site for marketing, docs, spec and download](0048-public-website-single-static-site.md)
- [0049 — Web-surface registry seats and genuine web client secrets](0049-web-surface-auth-options.md)
- [0050 — Specification 1.0: promotion, document layout, and the launch publication set](0050-spec-10-publication.md)
- [0051 — Public spec pages: engineering header stays home; the website renders a public header](0051-public-spec-presentation.md)
