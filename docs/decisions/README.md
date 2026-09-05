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
- [0054 — Website + playground deployment: in-repo direct-upload script, deploy from merged `main`](0054-web-deploy-tooling.md)
- [0055 — Legal disclosure posture: published terms + privacy as disclosure, one clickwrap at the installer, contextual consent as the primary instrument](0055-legal-disclosure-posture.md)
- [0056 — Dependency advisories: classify by reachability, fix or dismiss with a recorded reason, gate locally](0056-dependency-advisory-disposition.md)
- [0057 — The ancestor codenames stay in git history at flip-public; the scrub tooling does not ship](0057-codenames-in-history-accepted.md)
- [0058 — CI returns as the merge gate, and this time it enforces](0058-ci-restored-and-enforcing.md)
- [0059 — The active brain is always disclosed, and scripted output carries its provenance](0059-brain-disclosure.md)
- [0060 — Helpers are on-demand, separately released, version-pinned downloads](0060-on-demand-helper-distribution.md) — supersedes ADR-0047 §12: pre-release-tagged GitHub artifacts, pinned by content in the shell, downloaded on a click, verified twice, swapped in with two renames.
- [0061 — Snug is positioned by what the user owns, not against MCP](0061-ownership-positioning.md) — supersedes the "MCP connects agents to tools" line: the application and its accumulated state belong to the user while a conforming host supplies runtime intelligence; MCP is complementary, never the foil; the claims discipline (application-specific backend only, hosted models see inference data, fully-local claims only in the local configuration) is part of the positioning and is test-enforced.
- [0062 — A turn belongs to its thread, not to the view: navigation never aborts, only stop does](0062-thread-owned-turns-navigation-never-aborts.md) — TASK-20260903-build-thread-continuity: per-thread session store outlives every view; the unmount abort is removed; swap seams reset the registry; the hub create bar mints a fresh thread; parallel threads allowed.
- [0063 — App sharing: a shared app is a starter that travels](0063-app-sharing-portable-starter.md) — accepted 2026-09-04 (TASK-20260904-app-sharing): strict JSON `.snug` bundle (code + connection SHAPES + contract + schema DDL + docs; never data/secrets/history), the `shared` provenance/admission channel ADR-0016 clause 6 anticipated, inert inbox, starter-shaped preview/install/update.
- [0064 — One blind relay for share links (amends ADR-0013)](0064-blind-share-relay.md) — accepted 2026-09-04 (owner Q1 = A; amends ADR-0013): E2E-encrypted bundles (key in the URL fragment), Cloudflare Worker + R2, 1 MiB / 30 days, no identity, no content logging; built in-task, deployed only on a separate explicit ask.
- [0065 — A skill-delivered host kit and the host bindings: Snug apps run inside the agent the user already has](0065-skill-delivered-host-kit-and-bindings.md) — **proposed** 2026-09-05 (TASK-20260904-skill-only-snug, program): `apps/host` single-file kit built like the desktop; three bindings chosen by a boot probe (Claude artifacts / local host with brain shims around the user's own CLI / OpenClaw widget); the kit attaches to the host's brain and never asks the user to choose; custody disclosed beside the brain; apps handed in as `snug-app-bundle/1`; the skill launches the runner; prompt-store skill source with a generated, drift-gated `skills/snug/` and root plugin manifests.
