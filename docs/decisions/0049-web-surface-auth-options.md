# 0049 — Web-surface auth options and genuine web client secrets

- **Status:** draft (Gate 2 of TASK-20260822-gmail-dual-mode — pending plan approval)
- **Date:** 2026-08-22
- **Task:** TASK-20260822-gmail-dual-mode

## Context

The Gmail starter shipped desktop-only at v1 (ADR-0039 §5): a Google **Desktop app**
OAuth client registers only loopback redirects, so the web playground origin was not
registrable and the tile was honestly locked on web. Live probes (2026-08-21, recorded
in next-steps) established the Gmail REST API itself is fully CORS-open from any web
origin (`gmail.googleapis.com` reflects arbitrary `Origin`, preflight allows
`authorization`); the only blocker is Google requiring `client_secret` at code exchange
even with PKCE for **Web application** clients. Meanwhile the web OAuth lane already
exists generically in the codebase (origin `/oauth/callback` route + BroadcastChannel
binding; `handleCallback` conditionally sends a stored `client_secret`). What is missing
is registry vocabulary: no seat can say "this flow's registration serves a web origin."

## Decision

1. **Web capability is expressed as a `WellKnownAuthOption`, not an entry-level
   posture.** Redirect registrability is a per-*client-type* (flow-shaped) fact, so it
   rides the option vehicle that already carries per-flow `desktopRedirectPosture`,
   `fields`, `registration`, and `endpoints`. New optional option seat:
   `webRedirectPosture: 'origin-callback'` (sole member today) — "this option's
   walkthrough registers the connecting web origin's `/oauth/callback` as an exact
   Authorized redirect URI." `browserCallable` remains entry-level (per-provider API
   fact), and ADR-0021 §1 is preserved: posture stays reviewed registry data, never a
   `ConnectionRequirement` seat — no protocol schema change.
2. **The wizard binds by runtime, automatically.** Using its existing discriminator
   (`getPlatform().oauth === undefined`): on web, an entry's web option (if any) is
   auto-selected — its fields, walkthrough, and redirect display replace the entry-level
   (desktop) data; on desktop, web options are filtered out of choice cards. An entry
   with no web option keeps today's behavior (entry-level data serves web), so existing
   providers are untouched.
3. **A Web-application client secret is a GENUINE secret, and its custody is argued on
   its own terms.** ADR-0021 §7 ("no client secrets held for the user") was bent for
   gmail's desktop entry on Google's documented position that an installed-app secret is
   not a secret; that rationale does not transfer. The web option's `client_secret` is
   BYOK — the user registers their own client and the hub holds *their* secret in *their*
   own portable DB, behind the C1 boundary (never the iframe, the LLM, or a publisher),
   scrubbed from logs (`SECRET_FORM_PARAMS`), sent only in the form body to the
   ceiling-gated token endpoint. This ADR amends ADR-0021 §7 to read: desktop/web hold
   no *Snug-owned* client secrets; user-registered BYOK secrets are held in the user's
   own credential custody like any other secret (GitHub `oauth_app` precedent).
4. **Gmail is the first adopter; dual-surface means two registrations.** The gmail entry
   gains `browserCallable: true` (probed host: `gmail.googleapis.com`) and one web
   option (client_id + client_secret fields, "Web application" console walkthrough with
   the wizard-displayed exact redirect URI, the unverified-app warning, and the 7-day
   Testing-status refresh expiry). The ADR-0039 scope pin (`gmail.modify`,
   `gmail.settings.basic`, `gmail.send`; never `https://mail.google.com/`) is shared by
   every option. A user on both surfaces registers two Google clients — honest to
   Google's client-type model, no cross-surface coupling. google/googledrive/slack
   remain wizard-incomplete (next-steps item 7) but adopt this seat when completed.

## Alternatives considered

- **Entry-level `webRedirectPosture`:** wrong shape — the entry would then need
  per-surface fields/registration anyway, reinventing options.
- **Token-model web flow (no secret):** ~1 h tokens, re-consent every session; rejected
  by owner in the task interview (path (a) chosen).
- **One shared Web-application client for both surfaces:** a Web client can register
  loopback URIs, but exact-URI matching vs the desktop dynamic-port loopback is
  unverified and would change the shipped desktop flow; rejected — two registrations.
- **Keep gmail desktop-only:** the ADR-0039 deferral this task exists to end.

## Consequences

- ADR-0021 §7 and ADR-0039 §5 status lines updated in the same change (ADR-0027).
- The new seat rides every surface the existing option seats ride (schema/type, registry
  lint, wizard admission/resolution, register/review copy, drift migration, scrub) or
  the task file records why not (lesson 2026-08-13).
- `STARTER_LOOKS.gmail.desktopOnly` is dropped; trade-copilot/hue/whatsapp locks remain
  (transport reasons unchanged).
- High tier: negative tests (C1 secret custody, mail.google.com never pinned) +
  fresh-context plan review before implementation.
