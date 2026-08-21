# 0014 — Credentials are local-first (custody doctrine)

- **Status:** accepted (owner decision 2026-08-04/05, recorded 2026-08-05) — **amended 2026-08-20 by [ADR-0043](0043-passphrase-encryption-at-rest.md)**: the deferred passphrase-encryption alternative below is now DECIDED and shipped (opt-in, with a mandatory Recovery Key paying down the forgotten-passphrase cost named there). Custody is unchanged — the keys are still in the user's own file.
- **Date:** 2026-08-05
- **Task:** TASK-20260805-doctrines-devex

## Context

Dynamic Auth ships at 1.0 in local/BYOK form: apps will hold API keys, bearer tokens, and OAuth tokens for the user's own services. Somebody has to hold those credentials, and where they live is the trust decision of the whole product.

The audited source systems (codenames **OProject** and **IProject** — the two prior production systems this work extracts from) both answer "the server holds them": server-side token vaults encrypted with a single operator-held symmetric key. That is honest engineering for a hosted product, but it is **operator-readable custody** — publisher-blind, never host-blind — and the audit also showed how custody-adjacent security decays when it is configurable (a strict host-injection flag that defaulted off was a live prompt-injection exfiltration path). Meanwhile Snug already has a credential home with the right properties: the `snug_secrets` table in the user's own portable file, with hub-bound copies stripped and VACUUMed so removed rows leave no recoverable bytes (the precise custody line is in the decision below — *where* a copy of the file may carry secrets is exactly the point being decided).

ADR-0013 removes the hosted backend entirely; this ADR fixes where credentials live regardless of who hosts.

## Decision

**Through all of 1.x, every credential — API keys, secrets, OAuth access and refresh tokens — lives in `snug_secrets` inside the user's own file.** Concretely:

1. **The hub has no custody in any mode we host.** No server-side vault, no token store, no credential ever posted to a hub. Combined with ADR-0013 this is structural on the hosted instance: there is no server to trust.
2. The custody line, exactly (this wording is load-bearing — the code enforces each clause differently):
   - **Hub origins NEVER receive secrets.** `secretsAllowed: false` by construction on the hub-origin SyncProvider; hub-bound bytes are stripped and VACUUMed. Unconditional — no option can override it.
   - **Personal sync origins the user explicitly connects (e.g. their own Dropbox) carry the FULL file, including `snug_secrets`.** Deliberate and opt-in (`secretsAllowed: true` on the provider AND the embedder's opt-in, both required): the user's own storage is how credentials travel between the user's own devices. This is the basis of cross-device portability, not a leak.
   - **Default exports strip secrets** (then VACUUM); a full export is an explicit, named opt-in (`includeSecrets`).
   Changes to any of these need an ADR.
3. Credential *use* stays host-page-only under C1: injection is host-bound and **always strict — never a flag** (the source systems' default-off strictness is a named must-fix, not an option to carry). The app iframe, the LLM, and any publisher never see a credential.
4. **The broker (RFC at 1.6, GA at 2.0) is a convenience layer for subscription hubs — it never becomes the default custody model.** A self-hosted or hosted-static hub never requires it; local-first custody remains the default in every mode, in every release.
5. **Claim discipline.** The honest claim — the only one made anywhere — is: **"your keys never reach OUR servers; your file, including keys, goes only to storage YOU choose."** It is a hub-custody claim, never an absolute "keys never leave your file" (a personal Dropbox the user connects legitimately carries them). Marketing, docs, and the landing page may not strengthen it into the absolute or weaken it to "encrypted on our servers"; if the broker ships, its claims are scoped to opt-in subscription hubs and stated separately.
6. **Dynamic Auth credentials follow this identical line, no weaker.** The OAuth tokens, API keys, and client credentials the upcoming auth work stores (the `auth:` key namespace of `snug_secrets`) are governed by every clause above exactly as written — hub origins never, personal origins full-file opt-in, exports stripped by default.

## Alternatives considered

- **Server-side vault from day one** (the source systems' model). Rejected: operator-readable custody contradicts the ownership story, requires the backend ADR-0013 removes, and makes the strongest launch claim impossible.
- **Browser keychain / extension storage** outside the user file. Rejected: breaks portability — the file is the product; a credential outside it dies with the browser profile and does not travel with export/import.
- **Client-side encryption of `snug_secrets` with a user passphrase.** Deferred, not rejected: it hardens the file at rest but adds a forgotten-passphrase data-loss mode and does not change custody (the keys are still in the user's file). Revisit alongside the broker's KeyProvider work. — **SUPERSEDED 2026-08-20 ([ADR-0043](0043-passphrase-encryption-at-rest.md))**: shipped as WHOLE-FILE encryption rather than secrets-only (encrypting just `snug_secrets` would leave the app data that is most of the exposure readable), opt-in, with a mandatory Recovery Key as the second unlock path.
- **Broker as the default with local as fallback.** Rejected: defaults are destiny — the audit's lesson is that the safe posture must be the default, and custody is the one decision users will not audit for themselves.

## Consequences

- The auth port (Alpha) targets `snug_secrets` as its only credential store; the extracted vault/repo layers are deliberately left behind until the 1.6 broker RFC.
- OAuth flows run as public PKCE clients from the user's own device; there is no server to hold a client secret on the user's behalf. Providers that require a confidential client need the user's own dev-app registration (the guided BYO-registration wizard path).
- Sync custody splits by origin type: a **hub** origin carries a secrets-free file by construction, so a hub compromise never exposes credentials; a **personal** origin (the user's Dropbox) holds the full file, so its compromise is equivalent to a device/file compromise — the user's storage choice is part of the threat model (A10) and the wizard's storage copy must say so plainly.
- Export-with-secrets remains an explicit, named opt-in (`includeSecrets`) — the default artifact a user shares is always credential-free.
- The threat model (A10) gets a fixed anchor: credential exfiltration requires compromising the user's device or file, not a shared service.
- Source doctrine: `internal/07-roadmap.md` §2; audit context: `internal/03-audit-auth.md` (C4 — codenames only in this public record).
