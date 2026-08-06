# 0014 — Credentials are local-first (custody doctrine)

- **Status:** accepted (owner decision 2026-08-04/05, recorded 2026-08-05)
- **Date:** 2026-08-05
- **Task:** TASK-20260805-doctrines-devex

## Context

Dynamic Auth ships at 1.0 in local/BYOK form: apps will hold API keys, bearer tokens, and OAuth tokens for the user's own services. Somebody has to hold those credentials, and where they live is the trust decision of the whole product.

The audited source systems (codenames **OProject** and **IProject** — the two prior production systems this work extracts from) both answer "the server holds them": server-side token vaults encrypted with a single operator-held symmetric key. That is honest engineering for a hosted product, but it is **operator-readable custody** — publisher-blind, never host-blind — and the audit also showed how custody-adjacent security decays when it is configurable (a strict host-injection flag that defaulted off was a live prompt-injection exfiltration path). Meanwhile Snug already has a credential home with the right properties: the `snug_secrets` table in the user's own portable file — **already stripped from sync pushes and from default exports, and VACUUMed so stripped rows leave no recoverable bytes in the file**.

ADR-0013 removes the hosted backend entirely; this ADR fixes where credentials live regardless of who hosts.

## Decision

**Through all of 1.x, every credential — API keys, secrets, OAuth access and refresh tokens — lives in `snug_secrets` inside the user's own file.** Concretely:

1. **The hub has no custody in any mode we host.** No server-side vault, no token store, no credential ever posted to a hub. Combined with ADR-0013 this is structural on the hosted instance: there is no server to trust.
2. The existing `snug_secrets` handling is now a doctrine surface, not an implementation detail: stripped from sync pushes, stripped from default exports, VACUUM after stripping and after app deletion. Changes to any of these need an ADR.
3. Credential *use* stays host-page-only under C1: injection is host-bound and **always strict — never a flag** (the source systems' default-off strictness is a named must-fix, not an option to carry). The app iframe, the LLM, and any publisher never see a credential.
4. **The broker (RFC at 1.6, GA at 2.0) is a convenience layer for subscription hubs — it never becomes the default custody model.** A self-hosted or hosted-static hub never requires it; local-first custody remains the default in every mode, in every release.
5. **Claim discipline:** "your keys never leave your file" is true today and stays true. Marketing, docs, and the landing page may not weaken it to "encrypted on our servers"; if the broker ships, its claims are scoped to opt-in subscription hubs and stated separately.

## Alternatives considered

- **Server-side vault from day one** (the source systems' model). Rejected: operator-readable custody contradicts the ownership story, requires the backend ADR-0013 removes, and makes the strongest launch claim impossible.
- **Browser keychain / extension storage** outside the user file. Rejected: breaks portability — the file is the product; a credential outside it dies with the browser profile and does not travel with export/import.
- **Client-side encryption of `snug_secrets` with a user passphrase.** Deferred, not rejected: it hardens the file at rest but adds a forgotten-passphrase data-loss mode and does not change custody (the keys are still in the user's file). Revisit alongside the broker's KeyProvider work.
- **Broker as the default with local as fallback.** Rejected: defaults are destiny — the audit's lesson is that the safe posture must be the default, and custody is the one decision users will not audit for themselves.

## Consequences

- The auth port (Alpha) targets `snug_secrets` as its only credential store; the extracted vault/repo layers are deliberately left behind until the 1.6 broker RFC.
- OAuth flows run as public PKCE clients from the user's own device; there is no server to hold a client secret on the user's behalf. Providers that require a confidential client need the user's own dev-app registration (the guided BYO-registration wizard path).
- Sync providers carry a secrets-free file by construction; a sync origin compromise (e.g. Dropbox) exposes app data but never credentials.
- Export-with-secrets remains an explicit, named opt-in (`includeSecrets`) — the default artifact a user shares is always credential-free.
- The threat model (A10) gets a fixed anchor: credential exfiltration requires compromising the user's device or file, not a shared service.
- Source doctrine: `internal/07-roadmap.md` §2; audit context: `internal/03-audit-auth.md` (C4 — codenames only in this public record).
