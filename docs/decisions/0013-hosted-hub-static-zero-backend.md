# 0013 — Hosted hub is static files only (zero-backend doctrine)

- **Status:** accepted (owner decision 2026-08-04/05, recorded 2026-08-05)
- **Date:** 2026-08-05
- **Task:** TASK-20260805-doctrines-devex

## Context

Snug's hub client already runs entirely in the page: apps execute in sandboxed iframes (ADR-0008), the user's whole state is one portable SQLite file materialized in the browser (ADR-0007/0010), and LLM calls go browser-direct in BYOK/local modes. `apps/server` exists — /invoke, artifact cache, Google OIDC, /userdb CAS sync — and works. The open question was what the **hosted** playground at the project's own domain runs.

Three forces decide it:

- **Zero-budget scale.** The launch plan optimizes for mass traction with no funding: nothing on the hosted instance may cost compute that grows with users. A static bundle on a CDN scales to a front-page spike for free; a subscription `/invoke` path bills per token and melts.
- **"We collect nothing" as architecture, not policy.** With no backend there are no accounts, no telemetry endpoint, no server logs of user activity — the privacy claim on the landing page becomes falsifiable by reading the deploy config rather than trusting a policy.
- **The custody promise.** A hosted instance with login + server-side sync is a standing invitation to centralize user data and credentials. ADR-0014 forbids hub custody of credentials; a backend-less hosted hub makes that structural.

## Decision

**The hosted playground is static files only.** Concretely:

1. The hosted instance offers exactly the client-side modes: **demo** (mock adapter), **WebLLM** (in-browser model), **BYOK** (user's own key, browser-direct), and **local** (localhost endpoint, e.g. Ollama).
2. **No subscription mode, no OIDC login, and no hub-origin sync on the hosted instance.** The `/invoke`, auth, and `/userdb` surfaces are simply not deployed there.
3. Personal sync on the hosted instance is **Dropbox (or another user-held origin) or file export/import** — origins the user owns, per ADR-0009.
4. **The full server remains a first-class OSS artifact for self-hosters.** `apps/server` keeps its tests, docs, and parity work (e.g. the queued subscription-mode tool twins); "static only" is a statement about the instance the project hosts, never about the codebase.

## Alternatives considered

- **Hosted subscription hub (server-side keys, accounts).** Rejected: per-user compute cost, a credential-custody surface contradicting ADR-0014, and an accounts/telemetry surface contradicting the collect-nothing claim. It also converts a protocol project into a SaaS — the category claim is an app store you own, not a service you rent.
- **Hosted hub with login + hub-origin sync but no LLM proxy.** Rejected: still requires accounts and a database of user files; most of the cost and all of the custody problem for a convenience Dropbox already provides.
- **No hosted instance at all.** Rejected: the first-run demo is launch-critical; a static playground is the zero-friction path to "built an app in two minutes".

## Consequences

- Hosting is a CDN deploy; load-testing the launch is a static-hosting question. No server capacity planning, ever, for the hosted instance.
- WebLLM and BYOK carry the "first wow" burden — first-run UX work lands there (demo default, friction kill) rather than on onboarding flows behind a login.
- Self-hosters are the only audience for server-side features; server work is prioritized as OSS completeness, not hosted-instance need.
- The landing page may state "no accounts, no telemetry, nothing to breach on our side" as a claim of architecture.
- Anything that would require the hosted instance to grow a backend (subscription custody, hosted background jobs) is automatically a 2.0-era question with its own ADR — the default answer is no.
- Source doctrine: `internal/07-roadmap.md` §2 (pre-launch strategy file, C4 — this ADR is the public record of the decision).
