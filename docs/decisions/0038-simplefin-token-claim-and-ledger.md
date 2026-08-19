# 0038 — SimpleFIN rides plain connected-fetch via a token-claim pairing; Ledger ships the open-url concierge capability

- **Status:** **draft** (proposed 2026-08-18 at Gate 2 of TASK-20260818-ledger-starter;
  accepted only on owner plan approval)
- **Date:** 2026-08-18
- **Task:** TASK-20260818-ledger-starter

## Context

Ledger is the personal-finance connected starter: it consolidates every bank/credit-card
account the user connects — via **SimpleFIN** — into the user's own file, and layers
governed-LLM planning, insights and projections on top. SimpleFIN's shape: the user
copies a one-time **setup token** (a base64-encoded claim URL) from their SimpleFIN
Bridge account; the token is claimed ONCE by an empty-body POST, which returns a
permanent **access URL** carrying HTTP Basic credentials; all data then comes from
`GET /accounts` on that URL. The owner asked explicitly: sidecar (the WhatsApp pattern)
or direct connection? And later in the same session: a subscription concierge that can
open a merchant's cancellation page for the user.

## Decision

1. **No sidecar — plain connected-fetch.** SimpleFIN meets all five criteria that make
   the sidecar unnecessary: request/response only (no persistent session or push), a
   real pinnable public HTTPS host, a credential the host may legitimately hold, auth
   expressible as the existing `basic_auth` kind default (`Authorization: Basic`), and
   no local-process ceremony. Live probes (2026-08-18) confirmed full CORS on both the
   claim POST and `GET /accounts` (origin echoed, `authorization` allowed,
   credentials allowed; the claim POST is a preflight-free simple request), so the
   integration is **web + desktop**, `browserCallable: true` with a dated probe comment.
   The sidecar remains the pattern for device-session providers only (ADR-0032).
2. **A third pairing discriminant: `token-claim` — in the REGISTRY union, zero protocol
   bytes.** Beside `exchange` (Hue) and `device-link` (WhatsApp), the `WellKnownPairing`
   union in `packages/auth/src/well-known-providers.ts` gains a shape for claim-once
   providers. Like both siblings it is registry data, deliberately never persisted on
   the connection row (ADR-0023 D2: a requirement seat carrying claim mechanics would be
   a channel through which a prompt-injected declaration could aim an uncredentialed
   POST) — so `connection-requirement.ts` is untouched and Phase A has no spec impact
   (fresh-context review Blocker 1; the plan's first draft mis-homed this).
   The shape:
   the user pastes a one-time token, the WIZARD (never the app) decodes and claims it,
   and the minted credentials fill the entry's declared `basic_auth` fields. The
   ADR-0023 binding order is preserved unchanged — collect → approve → **freeze** →
   claim → verify — and the seat still **cannot express a host**: the ceiling freezes
   from the registry's pinned bridge host (**exactly one** — `beta-bridge.simplefin.org`;
   symbolic connection-relative addressing requires a singleton ceiling, and the
   declared test probe fires at `allowedHosts[0]` — review Blocker 2), and the decoded
   claim URL and returned access URL must land on it (https-only, punycode-normalized,
   default port, empty userinfo, `redirect:'error'` on both requests) or the claim
   refuses. The returned access URL's path must be exactly `/simplefin` — the base-path
   assumption is a checked invariant, not a hope (review Blocker 3). Verify-before-claim
   (ADR-0025) is required, at the same `/simplefin/accounts?balances-only=1` spelling as
   `testRequest`; minted credentials and connected state (`claimVerifiedAt`, its own
   `AuthConnectionState` seat) are written together by the proving function (the
   `completeDeviceLink` lesson). The setup token is consumed, never persisted.
3. **Kind is `basic_auth` with mint-filled fields.** `username`/`password` are parsed
   from the access URL by the claim step; no `request` seat — the kind default produces
   the correct header, and the existing executor, scrub, custody and revoke paths apply
   without modification.
4. **Custody stays per-app; "any app can use SimpleFIN" means the registry, not a
   shared credential.** The `(app_id, slot)` custody model is deliberate and
   fail-closed; a second app claims its own setup token through the same wizard. A
   shared-connection concept is a real architectural change deferred to its own ADR
   (recorded in next-steps).
5. **The concierge gets a host-mediated `open-url` capability, not a sandbox change.**
   An app may REQUEST that the host open an https URL; the host shows the full URL in a
   confirm dialog and, only on the user's gesture, opens it — a new tab from the host
   page on web, the existing https-only system-browser opener on desktop. Internal-draft
   frame in the net-frames class (out of `schemas/`), value-blind runner seam,
   capability off for uninstalled starters, non-https and userinfo-bearing URLs refused.
   C2 is untouched (no new sandbox flags); C1 is untouched — merchant credentials are
   never collected: the user signs in on the merchant's own site themselves.

## Alternatives considered

- **Sidecar relay (WhatsApp pattern):** rejected — pays the desktop-only, Rust-command,
  process-supervision cost for a provider that is plain HTTPS with CORS. The BYOK CORS
  ladder's rung 1 stays available for genuinely CORS-hostile providers.
- **User pastes the access URL directly (no claim support):** rejected — the user
  cannot perform the claim by hand, the token is single-use, and a raw
  URL-with-embedded-credentials paste box teaches exactly the habit C1 exists to kill.
- **Wizard decodes the token and trusts its host (no ceiling check):** rejected — the
  pasted token is user-supplied data; honoring its host would be a second host channel
  around the frozen ceiling. Cost: third-party SimpleFIN servers on other hosts are
  refused at 1.0 — a named limitation, revisited only with a reviewed registry change.
- **`allow-popups` on the app iframe for the concierge:** rejected outright — a sandbox
  flag is a C2 change with app-wide blast radius; the host-mediated confirm-gated frame
  gives the same UX with the host in the loop.
- **Agentic unsubscribe (form-filling on merchant sites):** rejected at 1.0 — playbooks,
  drafts and open-url guidance only; the data feed itself verifies success (no charge in
  the next cycle) which is a stronger, credential-free proof of cancellation.

## Consequences

- Phase A touches **zero** protocol bytes: the token-claim union member is registry data
  in `packages/auth`. Phase C touches protocol twice: the open-url frame (internal
  draft, out of `schemas/`, net-frames precedent) AND an optional `openUrl` capability
  flag on `hostReadySchema` — which IS published surface: `gen:schemas` + a real
  spec-changelog entry (the `net` flag precedent).
- `packages/auth` gains the `simplefin` registry entry + a pure claim module; the
  structural registry suites extend to cover it.
- The wizard gains one screen variant (paste token → claim → verified), reusing the
  register-walkthrough and error-surfacing machinery.
- Ledger (`examples/ledger/`) becomes the seventh connected starter, with the full
  ADR-0031/0035 authoring-provenance bundle including the owner's verbatim prompts.
- Threat-model delta: `docs/security/threat-model-delta-simplefin-token-claim.md`
  (user-supplied claim target bounded by the frozen ceiling; single-use-token honesty;
  open-url phishing surface bounded by the full-URL confirm dialog).

## Amendment (2026-08-18, owner's first real walk)

The first pinned host was `bridge.simplefin.org` — a **302 alias** of the real serving
host `beta-bridge.simplefin.org` (the "beta" name is historical; it is where accounts
live, tokens mint, and claim URLs point). Every real token therefore refused at the
ceiling gate, correctly, against a wrong pin. Three fixes rode the correction:
1. The pin moved to `beta-bridge.simplefin.org` (probe recorded beside the seat).
2. `migrateConnectionRegistryDrift`'s detection gate gained **host drift** — it was
   blind to a moved registry host, so an already-approved row could never heal; a
   ceiling move now stages to the reapproval diff screen (never a silent promotion).
3. Ledger switched from a literal-host sync URL to **connection-relative addressing**
   (`snug-connection://simplefin/...`, ADR-0026) — installed starters never receive
   rebuilds, so an app that names a host bakes yesterday's host into bytes forever;
   an app that names its SLOT is immune to host moves by construction.
