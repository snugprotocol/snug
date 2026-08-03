# 0008 — Serverless app execution; LLM calls from the host page, never from the app iframe

- **Status:** accepted
- **Date:** 2026-08-03
- **Task:** TASK-20260803-portable-hub

## Context
The three-actor vision requires that a user holding their DB file can run apps with **no hub backend**: offline, or online calling an LLM directly from the browser (local model or frontier API via BYOK). Read literally ("API calls made directly from the app code"), this collides with hard constraints C1 (credentials never enter the iframe) and C2 (iframe `connect-src` blocked) — the "secure by construction" pitch.

## Decision
"No backend" is realized **at the host-page layer, not the iframe layer**:
- The hub client is static files. App execution, DB reads/writes (OPFS via SQLite WASM), and LLM calls all happen in the browser.
- LLM calls are made by the **host page** through the existing runner bridge/transport seam. Three transports: (a) **BYOK direct** — browser → provider API, key read from user-DB settings, never sent to any hub server; (b) **local LLM** — browser → OpenAI-compatible localhost endpoint (e.g. Ollama), fully offline; (c) **hub subscription** — browser → hub server `/invoke` (the one sanctioned server path, opt-in).
- C1 and C2 are **unchanged**: iframes keep `sandbox="allow-scripts"` + `connect-src` blocked; keys and tokens never enter the iframe; the app *experiences* direct LLM access via the bridge.
- The hub server never executes app code, never writes app data, and is not required to run any app.

## Alternatives considered
- **Direct calls from the app iframe** (allowlist provider origins in `connect-src`, pass keys in) — rejected: breaks C1/C2 and ADR-0003; any prompt-injected app becomes an exfiltration channel through the provider API.
- **Localhost-only exception for local LLMs in the iframe** — rejected: still widens C2 for marginal benefit; the bridge path serves local models equally well.

## Consequences
- Provider adapters must be browser-runnable (no Node-only deps in the call path); anthropic-direct requires the CORS-enabled API mode.
- BYOK keys live in the user DB (portable) — at-rest posture documented honestly (no KMS claim until KeyProvider ships, per ADR-0003's honesty rule). This is a **deliberate weakening vs v1's sessionStorage-only key** (a persistent plaintext key in OPFS is readable by any hub-origin XSS); accepted for portability, offset by storage negatives (key never in localStorage/sessionStorage, never in any frame posted to the iframe, never in hub-origin push payloads).
- To keep "never sent to any hub server" true under ADR-0009 sync, the secrets table is **stripped from hub-origin push and default export**; including secrets is an explicit user opt-in (personal origins / full-portability export). Pull-merge preserves local secrets (ADR-0009) so stripping never deletes them locally.
- Subscription mode is **client-authoritative for state**: chat may run through the hub server, but resulting artifacts are fetched by the client and written into the user DB (new version of the pinned target app); server artifact/thread stores are transient cache. The user DB is the single source of truth in every mode.
- Honest offline claim: "serverless" means no hub backend is needed and local-LLM keeps LLM traffic on-device; generated apps still load their runtime from the CDN allowlist (ADR-0006), so true network-offline runtime is future work (vendored-runtime template), not a current claim.
- The Playground's BYOK mode generalizes from "demo affordance" to the default execution architecture.
