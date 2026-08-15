# 0029 — Console-URL clickability keys on registry-pinned bytes, not row provenance

- **Status:** proposed (plan approved by owner 2026-08-15; implementation in flight)
- **Date:** 2026-08-15
- **Task:** TASK-20260815-spotify-scopes-wizard-links

## Context

ADR-0017's wizard renders the provider console URL copy-only unless the row's
`provenance === 'registry'` (`ConnectionWizardSheet.tsx`, `consoleUrlIsClickable`). The
stated rationale is anti-phishing and remains correct: a model-proposed URL rendered as a
one-tap anchor inside the platform's own credential wizard is a phishing hand-off.

But provenance is the wrong key. A starter- or inference-provenance row whose provider
matched the registry had its `registration.consoleUrl` **substituted from the registry**
by `applyRegistryValues` — those bytes are Snug-pinned, PR-reviewed data, exactly as
trustworthy as on a registry-provenance row. Keying on provenance made the shipped
Spotify starter (provenance `starter`) show "copy this address and paste it" for a URL we
ourselves pinned — the owner read it as a bug, and it is one: the rule protects against
an author the URL no longer has.

## Decision

1. **A console URL renders as a clickable link iff its bytes match the pinned registry
   value** for the row's resolved provider (`resolveRegistryEntryByName`, checking the
   entry and its `authOptions` registrations) — regardless of row provenance. The
   comparison is byte-equality; a one-char-off URL under a registry brand stays
   copy-only. No match — including genuinely user-authored providers with no registry
   entry — keeps the existing copy-address-and-paste flow and its honest hint copy.
2. **The redirect-URI box stays copy-only everywhere.** It is pasted into the provider's
   form, not navigated; a link affordance would be wrong even for pinned bytes.
3. **Desktop opens the link via the system-browser opener** (https-only guard), never
   webview navigation — the same RFC 8252 posture as the sign-in leg (ADR-0021).
4. The blocked-popup fallback anchor (service-minted authorize URL) is unchanged — it
   was already keyed on the right fact (the URL's author is our own OAuth service).

## Consequences

- Registered-provider journeys (registry, starter, matched inference) get a one-tap
  console link on web and desktop; unregistered/user-authored auth keeps copy-paste.
- The anti-phishing property is now stated as what it always meant: **we link only URLs
  we pinned.** The negative test (near-miss URL stays copy-only) pins it.
- `consoleUrlIsClickable(row)`'s provenance check is deleted, not augmented — one rule,
  one resolution, per the 2026-08-12 refuse-and-rewrite lesson.
