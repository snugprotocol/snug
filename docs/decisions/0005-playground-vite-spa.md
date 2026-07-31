# 0005 — Playground is a Vite + React SPA (supersedes the Next.js line in the internal plan)

- **Status:** draft (accepted with TASK-20260731-build-hub plan approval)
- **Date:** 2026-07-31
- **Task:** TASK-20260731-build-hub

## Context

The pre-bootstrap plan named Next.js for the Playground. The Playground is bring-your-own-API-key, deploys as static files (Azure Static Web Apps), and talks to a separately-packaged reference server (`apps/server`, Fastify) — there is no SSR requirement, and the product story ("embeddable SDK, bring your own backend") is better proven by a pure client build.

## Decision

`apps/playground` is a Vite + React single-page app producing a fully static build. All agent traffic goes through the same `/invoke` contract any adopter would use (reference server locally, BYOK direct-adapter mode in the hosted demo).

## Alternatives considered

Next.js (as originally planned — heavier toolchain, SSR unused, couples the demo to a meta-framework the SDK doesn't need); plain-Vite vanilla TS (rejected: runner/SDK ship React hooks; the demo should exercise them).

## Consequences

Faster dev loop and trivially cheap static hosting; the hosted demo doubles as proof that Snug needs no particular backend. Anything needing a server in demos (artifact store, share links) must visibly run against `apps/server`, which keeps the protocol boundary honest. Owner interview 2026-07-31 selected this option.
