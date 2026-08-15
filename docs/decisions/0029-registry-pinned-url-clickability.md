# 0029 — Console-URL clickability keys on registry-pinned bytes, not row provenance

- **Status:** accepted (2026-08-15, at merge; owner approved the plan, verified the fixed wizard flow live, and commissioned the merge explicitly)
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
   value for the row's OWN FLOW** — the entry when the row's kind is the entry's, an
   option when it is that option's (`resolveRegistryEntryByName`; Gate-5 tightening:
   matching ANY pinned URL let an imported row pair one flow's registration steps with
   a one-tap link to a different flow's console — still a pinned page, but a
   walkthrough whose link cannot be followed) — regardless of row provenance. The
   comparison is byte-equality; a one-char-off URL under a registry brand stays
   copy-only, and so does a kind-mismatched pinned URL. No match — including genuinely
   user-authored providers with no registry entry — keeps the copy-address-and-paste
   flow, with its hint REWORDED to the new truth ("we haven't pinned this address" —
   the old "a model proposed it" is false for user- and starter-authored URLs that
   reach this branch).
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
- Fail-closed residue (accepted): if the registry later EDITS a provider's consoleUrl,
  persisted rows keep the old bytes (drift detection keys on fields/seats, not
  registration) and silently fall back to copy-only until any other drift stages them —
  degraded convenience, never a wrongly-linked URL.
