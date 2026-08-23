# Runbook — enabling Google sign-in on the hub

**Symptom this solves:** "I don't see a Google sign-in option in the UI."

The sign-in affordances are **already built** — `sign in with google` in Settings
(`apps/playground/src/views/SettingsView.tsx`, `AccountCard`) and a `sign in` chip in the
header on every page (`apps/playground/src/App.tsx`, `IdentityChip`). They are hidden, not
missing.

## Why it hides

**Gate 0 — the build flag (since TASK-20260822, ADR-0052 §5).** The probe below only
fires when the playground was **built with `VITE_SNUG_HUB_AUTH=1`**. The default build
never calls `/auth/me` and pins the auth state to `unavailable` — the launch posture is
"no sign-in anywhere", structural rather than probe-dependent. Self-hosting with login
therefore needs BOTH the server env in step 2 AND a flag-on playground build:

```sh
VITE_SNUG_HUB_AUTH=1 pnpm --filter playground build   # or dev
```

(Behavior pinned by `apps/playground/src/__tests__/hubAuthGate.test.ts`.)

> **Caveat — switching a live deployment back to a flag-off build:** existing session
> cookies stay valid server-side, but the UI can no longer show them (no identity chip,
> no sign-out) and refuses the hub sync origin rather than pushing under an invisible
> session. Users who want the session gone clear the site's cookies, or the operator
> rotates `SNUG_SESSION_SECRET` (logs everyone out).

With the flag on, the client probes `GET /auth/me` once on mount
(`apps/playground/src/state/auth.ts`, `refreshAuth`) and maps the answer to a
four-state machine:

| `/auth/me` answers | auth state | UI |
|---|---|---|
| `200` | `signed-in` | identity chip + sign-out |
| `401` | `anonymous` | **the Google sign-in buttons** |
| `404` / any other / network error | `unavailable` | chip renders nothing; Settings explains the absence |

`/auth/*` is registered **only** when the server boots with `SNUG_AUTH=google`
(`apps/server/src/app.ts`). Without it the routes don't exist, `/auth/me` 404s, and the UI
correctly concludes the hub has no account surface. This is deliberate: logged-out is a
fully functional local-only hub.

So there are three ways to see no button, and all are configuration:

1. **Playground alone** (`vite dev`, nothing on `:8787`) — the proxy gets `ECONNREFUSED`.
2. **Playground + server, `SNUG_AUTH` unset** (the default) — `/auth/me` returns 404.
3. **Built playground served by the server, `SNUG_AUTH` unset** — same 404.

Behavior is locked by `apps/playground/src/__tests__/authSurface.test.tsx` (which branch
renders) and `authState.test.ts` (the probe mapping).

## Enabling it

### 1. Google Cloud Console

Create an **OAuth 2.0 Client ID** of type *Web application*, and add the callback to
**Authorized redirect URIs**:

```
http://127.0.0.1:8787/auth/callback
```

> **Gotcha:** the redirect URI is built from the **server** origin (`requestOrigin`, see
> `apps/server/src/routes/auth.ts`), not the Vite origin. Even though you browse the app at
> `http://localhost:5173`, the callback that must be registered is the `:8787` one, because
> the Vite proxy forwards `/auth` there. Registering only `localhost:5173` fails at callback.

### 2. `apps/server/.env.local`

```sh
SNUG_AUTH=google
SNUG_SESSION_SECRET=<openssl rand -hex 32>   # >= 32 chars
SNUG_GOOGLE_CLIENT_ID=<from console>
SNUG_GOOGLE_CLIENT_SECRET=<from console>
SNUG_CORS_ORIGIN=http://localhost:5173       # explicit origin; "*" is refused
```

All five are required together — the server **fails the boot** with a named error if any is
missing, rather than starting half-configured (`apps/server/src/config.ts`). Empty counts as
unset: `SNUG_SESSION_SECRET=` fails exactly like omitting it (see the 2026-08-02 lesson on
`??` fallbacks). Templates in `.env.example` are commented out for this reason.

Optional: `SNUG_OIDC_ISSUER` (defaults to `https://accounts.google.com`; tests point it at a
local fake issuer), `SNUG_STATIC_DIR` (built playground served at `/`).

### 3. Run with that env file

```sh
pnpm --filter server dev:local     # reads .env.local
pnpm --filter playground dev       # separate process, :5173
```

`pnpm --filter server dev` reads **no** env file — use `dev:local`.

### 4. Verify

```sh
curl -i http://127.0.0.1:8787/auth/me     # expect 401 (not 404)
```

`401` means the surface exists and you are logged out — the sign-in buttons will now render.
`404` means `SNUG_AUTH` is still unset in the process you're actually running.

## What sign-in changes

Only that the hub becomes available as a **sync origin** for your snug file (`/userdb` CAS
endpoints, also gated behind `SNUG_AUTH`). App building, running, and all local data work
identically signed out — do not sign in expecting new app capabilities.

> **⚠️ What sign-in does NOT change (2026-08-21 security review, measured):** enabling
> `SNUG_AUTH=google` authenticates **`/auth/*` and `/userdb` only**. **`/invoke` and
> `/artifacts` have no authorization at all** — artifacts and threads are one global
> namespace, so on an exposed server an anonymous caller can list and read every
> artifact, read another user's thread history into their own turn, and spend the
> operator's API key. Do not put an `apps/server` instance on the open internet
> expecting login to gate it; keep it on localhost or behind your own network/proxy
> auth until per-user scoping ships.

## Related

- `apps/server/.env.example` — the commented template
- `docs/decisions/0009-sync-provider-origins.md` — what the hub origin is for
- Sessions are HMAC cookies with CSRF double-submit (`snug_session` / `snug_csrf`,
  header `x-snug-csrf`); rotating `SNUG_SESSION_SECRET` logs everyone out.
