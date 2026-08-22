# 0049 — Web-surface registry seats and genuine web client secrets

- **Status:** accepted (2026-08-22 — plan approved by owner; design revised to entry-level
  seats after the High-tier fresh-context plan review rejected the option-vehicle draft)
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
binding; `handleCallback` conditionally sends a stored `client_secret`). What was
missing is registry vocabulary: no seat could say "this provider's registration can
serve a web origin, and here is the web walkthrough."

## Decision

1. **Web capability is expressed as two ENTRY-level registry seats, resolved at wizard
   render time — never persisted.** `webRedirectPosture: 'origin-callback'` (sole
   member today) declares the provider's client registration can accept the connecting
   web origin's `/oauth/callback` as an exact Authorized redirect URI;
   `webRegistration` carries the web-surface console walkthrough (structural rule:
   `webRegistration` requires `webRedirectPosture`; both require an OAuth kind). The
   wizard's register screen consults them only when `getPlatform().oauth === undefined`
   — the same predicate that already selects the origin-literal redirect display, so
   the walkthrough and the displayed URI cannot disagree. Neither seat is emitted into
   `ConnectionRequirement` (pinned by a negative test on `requirementFromRegistryEntry`)
   — the same render-time registry-data class `desktopRedirectPosture` occupies under
   ADR-0021 §1. No protocol change; admission re-substitution stays byte-identical, so
   the drift migration answers 'none' for every approved row. The anti-phishing
   property is preserved: the rendered walkthrough is still sourced exclusively from
   the human-reviewed registry (AL-04 D5).
2. **Credential fields are shared across surfaces, deliberately.** Gmail's desktop and
   web flows collect the identical `client_id` + `client_secret` pair, so the entry's
   pinned `fields` serve both and are left byte-untouched — an edit to entry field copy
   makes every approved row's field list match no pinned option and stages a full
   re-credential walk (`fieldsMatchPinnedList` compares all field properties), which is
   a deliberate re-consent event this task does not take.
3. **A Web-application client secret is a GENUINE secret, and its custody is argued on
   its own terms.** ADR-0021 §7 ("no client secrets held for the user") was bent for
   gmail's desktop entry on Google's documented position that an installed-app secret is
   not a secret; that rationale does not transfer. The web flow's `client_secret` is
   BYOK — the user registers their own client and the hub holds *their* secret in *their*
   own portable DB, behind the C1 boundary (never the iframe, the LLM, or a publisher),
   scrubbed from logs and surfaced errors (`SECRET_FORM_PARAMS`, both raw and encoded
   spellings), sent only in the form body to the ceiling-gated token endpoint. This ADR
   amends ADR-0021 §7 to read: the hub holds no *Snug-owned* client secrets;
   user-registered BYOK secrets are held in the user's own credential custody like any
   other secret (GitHub `oauth_app` precedent).
4. **Dual-surface means two registrations and ONE active client pair.** A user on both
   surfaces registers two Google clients (Desktop app + Web application) — honest to
   Google's client-type model. Credential storage is one cell per app+slot:
   `generateAuthUrl` persists the pasted pair at flow start, so connecting on one
   surface overwrites the other's client credentials, and an abandoned start leaves the
   old refresh_token paired with new client creds (refresh then fails until the user
   completes a sign-in). Accepted as the roaming-file model, disclosed in the web
   walkthrough, and the abandoned-start state is pinned by test rather than papered
   over. Gmail is the first adopter; google/googledrive/slack remain wizard-incomplete
   (next-steps item 7) but adopt these seats when completed.

## Alternatives considered

- **A `WellKnownAuthOption` web flow (the first draft of this ADR):** rejected by the
  fresh-context plan review on four blockers, all downstream of options being
  kind-discriminated (`matchedRegistryOption`) while a web flow shares
  `oauth2_auth_code` with the entry: (1) a same-kind option is invisible to every
  option-matching consumer, so a web-bound row on desktop resolves as the loopback flow
  and fails mid-flow with `redirect_uri_mismatch` — the failure ADR-0021 §1 exists to
  prevent; (2) `resolveDesktopPosture`'s `?? entry` fallback makes the option inherit
  `'loopback'` — "web-only, no desktop transport" is unrepresentable; (3) fields and
  registration are persisted requirement seats, so runtime auto-selection either
  persists a wrong-surface row into a portable file or violates the wizard's
  render-the-row doctrine — and a byte-identical-fields option can never survive
  `matchAuthOption` anyway; (4) any `authOptions` seeds the chat AuthChoiceCard on
  every surface with no surface filter, persisting wrong-surface choices durably.
- **Token-model web flow (no secret):** ~1 h tokens, re-consent every session; rejected
  by owner in the task interview.
- **One shared Web-application client for both surfaces:** exact-URI matching vs the
  desktop dynamic-port loopback is unverified and would change the shipped desktop
  flow; rejected — two registrations.
- **Keep gmail desktop-only:** the ADR-0039 deferral this task exists to end.

## Consequences

- ADR-0021 §7 and ADR-0039 §5 status lines updated in the same change (ADR-0027).
- `STARTER_LOOKS.gmail.desktopOnly` is dropped; trade-copilot/hue/whatsapp locks remain
  (transport reasons unchanged).
- The seat walk (lesson 2026-08-13): registry type + structural tests ride; the emitter
  explicitly does NOT ride (negative test); the register screen rides; the review
  screen does not (review renders the approved row — the walkthrough is registration
  guidance, not approved credential semantics); drift/admission untouched by
  construction; scrub gains no new secret params; the chat choice card is untouched (no
  options added).
- High tier: negative tests (C1 secret custody, web seats never persisted) +
  fresh-context plan review (run 2026-08-22, findings adopted) + journal self-sign-off.
