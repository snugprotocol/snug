# TASK-20260803-hub-sso: Google OIDC, per-user DB provisioning, /userdb endpoints, static hosting (child 5 of portable-hub)

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: **high** (auth; fail-closed CORS/CSRF surface)
- **Branch**: `feat/TASK-20260803-portable-hub` (umbrella branch)
- **Packages touched**: `apps/server`, `apps/playground` (`packages/auth` credential broker explicitly untouched — hub login ≠ app credential brokering)
- **Spec impact**: hub `/userdb` HTTP contract described in spec v0.2 prose (child 6)
- **Related**: umbrella [TASK-20260803-portable-hub](TASK-20260803-portable-hub.md) (§Amendments F2, F11, F18, F19), ADR-0009

## Spec (what & why)

Sample hub becomes a real (minimal) multi-tenant provider: direct Google OIDC (Authorization Code + PKCE via `openid-client`), signed httpOnly session cookie, `users` table, per-user server-side user-DB blob store with revision tokens (`GET/PUT /userdb`, `If-Match`), first-login provisioning, `@fastify/static` serving the built playground, login UI replacing the inert "connect account" chip. Fail-closed posture per F2: explicit `SNUG_CORS_ORIGIN` required when auth enabled (boot failure otherwise; fixes the `??` empty-string foot-gun per 2026-08-02 lesson), `SameSite=Lax` + `Secure` cookies, CSRF token on mutating routes, session-signing key env-only fail-closed (F18).

**Acceptance criteria** (umbrella AC8/AC12-partial/AC14):
1. OIDC flow against a fake issuer (unit + Playwright): login → session cookie (httpOnly/Secure/SameSite=Lax) → `/auth/me`; logout clears.
2. First login provisions an empty user-DB record; login on a second browser context restores apps from origin (with child 4's local-first push-up rule honored).
3. `/userdb` unauthenticated → 401; cross-origin credentialed fetch refused (CORS fail-closed negative); `PUT` without CSRF token refused; body limit ≥ `MAX_USERDB_BYTES` route-scoped; per-user quota enforced.
4. `GET /userdb` served `application/octet-stream` + `nosniff` + `no-store` (F19).
5. Boot fails when auth enabled without explicit `SNUG_CORS_ORIGIN` or signing key; `.env.example` documents both commented-out.
6. Static hosting serves the built playground from the server (AC2 serving story).

**Out of scope**: hub LLM subscription billing; non-Google providers; `packages/auth` broker (v1.1 scope unchanged).

## Plan

Files: `apps/server/src/{config.ts,app.ts}` (CORS fail-closed, cookie, csrf, static) → `apps/server/src/auth/{oidc.ts,session.ts}` + `routes/{auth.ts,userdb.ts}` + `stores/{users.ts,userdbs.ts}` → playground login UI + hub-origin provider wiring end-to-end. Tests FIRST per AC; fake OIDC issuer fixture.

## Decisions & surprises

—

## Session journal (append-only, newest last)
