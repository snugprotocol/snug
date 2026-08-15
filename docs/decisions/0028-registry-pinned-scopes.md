# 0028 — Registry-pinned OAuth scopes: reviewed registry data, never silent defaults

- **Status:** proposed (plan approved by owner 2026-08-15; implementation in flight)
- **Date:** 2026-08-15
- **Task:** TASK-20260815-spotify-scopes-wizard-links

## Context

The registry's standing posture (carried from the source system, stated at the top of
`packages/auth/src/well-known-providers.ts` and on the type's `scopes?` field) was **"no
default scopes — silent privilege widening"**: every entry left `scopes` undefined and
callers were expected to declare their own. In practice no channel ever did — the
requirement schema's `scopes` seat (`connection-requirement.ts:460`) exists and the OAuth
service sends it on both the authorize and token legs, but nothing upstream ever filled
it. The result for Spotify: the authorize URL carries no `scope` parameter, Spotify mints
a public-data-only token, and the starter's `GET /v1/me/playlists` answers 403 — surfaced
to the owner as "the key may be wrong, expired, or revoked", which misdiagnoses a
provider whose OAuth round trip actually succeeded.

The original posture guarded against the right harm with the wrong rule. The harm is a
scope grant the user never sees. But requirement `scopes` render on the wizard's review
screen (order preserved, deliberately — `connection-requirement.ts:653`) and the
provider's own consent screen lists them again; a registry-pinned scope list is as
reviewed as pinned hosts or fields. What "no scopes ever" actually bought was providers
whose APIs are useless without scopes shipping broken by construction.

## Decision

1. **A registry entry (or auth option) may pin `scopes`** — a human-reviewed, per-entry
   list, exactly like `endpoints`/`fields`/`request`. What stays forbidden is the
   original harm, restated precisely: **a scope the user never sees**. Pinned scopes ride
   the requirement, render on the review screen, and appear on the provider's consent
   screen. An entry whose API works scope-less keeps `scopes` undefined.
2. **The seat rides every surface pinned seats ride** (lesson 2026-08-13): emitted by
   `requirementFromRegistryEntry` under the option-over-entry flow rule (an option
   without scopes emits none — a different flow never inherits scopes it didn't
   declare), REPLACED (never merged) by `applyRegistryValues` on every borrow hit, and
   reconciled by the wizard-open drift migration.
3. **A scope change on an approved row always re-consents.** The drift migration's
   silent `repersisted` promotion is structurally unreachable when scopes changed, even
   with an identical host ceiling: the stored token was minted under the old scopes and
   providers do not widen on refresh. Scope drift stages a visible diff, and approving it
   routes through a fresh authorization round trip.
4. **Spotify pins** (owner decision 2026-08-15, read + playback control):
   `playlist-read-private`, `playlist-read-collaborative`, `user-read-private`,
   `user-library-read`, `user-top-read`, `user-read-playback-state`,
   `user-modify-playback-state`. `user-read-email` deliberately excluded (no Snug
   surface needs the address). The tradeoff is recorded: every Spotify-connected Snug
   app's token can control playback; the consent screen says so.
5. **`scopes` stays OUT of `CREDENTIAL_PROMPT_SEATS`.** A borrower authoring scopes
   under a scope-pinned brand is substituted away by rule 2; under a non-scope-pinned
   brand it keeps today's behavior. This sits beside the known
   borrowed-`endpoints`-survive-substitution item (next-steps 2026-08-12) for the next
   threat-model pass — one decision for both seats, not two drifting ones.

## Consequences

- The Spotify starter works: the token can read private/collaborative playlists.
  Existing scope-less rows heal at wizard open via the staged diff + fresh sign-in.
- Provider research facts backing this change (primary Spotify docs, read 2026-08-15):
  redirect URIs must be https EXCEPT loopback IP literals (`http://127.0.0.1:PORT`
  sanctioned, `localhost` banned; enforced Apr-2025/new, Nov-2025/existing) — ADR-0021's
  desktop transport is already exactly compliant, so no https work rides this task.
  Dev-mode (Feb-2026): max **5** allowlisted users, owner must hold Premium, one Client
  ID per developer — the entry's registration walkthrough now states these.
- Registry comments claiming "scopes are ALWAYS undefined by policy" are rewritten to
  point here.
- Widening a pinned set later is a normal registry edit: drift stages it, the user
  re-consents. Narrowing likewise (tokens keep serving until re-consent).
