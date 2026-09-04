# Threat-model delta — app sharing: bundles, the shared channel, and the blind relay

- **Task:** TASK-20260904-app-sharing · **ADRs:** [0063](../decisions/0063-app-sharing-portable-starter.md), [0064](../decisions/0064-blind-share-relay.md)
- **Date:** 2026-09-04
- **Scope:** what it adds to the attack surface when one user can hand another user an
  app — as a `.snug` file or as a link through a hosted relay — and what is **accepted
  and not mitigated**.

> **How to read this.** A *delta*. It assumes the trust ladder recorded in
> `architecture.md` ("who may propose a connection"), the requirement/grant split of
> ADR-0017, the install-act rung of ADR-0016, and the starter update act of ADR-0045.

---

## 1. The posture change in one sentence

For the first time, **code authored by a third party** — not Snug (a starter), not the
user's own builder LLM — can be installed into a user's hub and can propose connections
to it; and, with the link path, the hosted instance runs **one endpoint** that stores
bytes for strangers.

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **A bundle is third-party html that will run in the recipient's hub** | Ship an app that reads the recipient's data, other apps' data, or credentials; exfiltrate through the network | Nothing new: C2's sandbox (`allow-scripts`, `connect-src 'none'`) and the physical per-app data namespace are the defense, and they are unchanged. A shared app is exactly as trusted as an LLM-built app. |
| **S2** | **A bundle proposes connections** (`connections[]`) — the untrusted declaration channel ADR-0016 clause 6 named | Wear a registry brand with attacker hosts; author a credential prompt beside registry-grade hosts; aim a `userLayer` at attacker endpoints; spell a starter identity to inherit its vouch | Its OWN provenance/channel `shared` (never `starter` — trust laundering); admitted by `admitConnectionRequirement` on that channel at install AND at the db write boundary through the composition root's gate: borrow ban (name OR host intersection), confusable guard, `userLayer` refusal by shape, LAN-class check; the wizard reviews on the one strong screen with copy naming a third-party author; `install_source` is minted from a UUID-charset `lineage` under `share:` so `starterDeclaration`'s vouch is unreachable |
| **S3** | **A bundle carries DDL** (`schema.ddl[]`) that `applyAppDdl` executes | Smuggle `INSERT`s or a second statement under "structure only"; run DDL before install | The schema admits only single `CREATE …` statements (trigger bodies bounded, comment tokens refused); DDL runs ONLY inside the install act, against the app's OWN runtime database, and a failure removes the half-made app |
| **S4** | **A bundle carries a runtime contract** — third-party text for an LLM system slot, which ADR-0018 D3 forbids on untrusted channels | Steer the recipient's model inside the app; reach anything the host layers guard | Admitted ONLY through the preview-then-install act (owner Q6b, ADR-0063 §8): the preview shows the contract verbatim as text under "what this app tells the AI" before install; `importUserDb`'s drop rule is untouched for every other channel. The host puts no secret in any LLM context (C1), so the blast radius is the app's own frame |
| **S5** | **A received bundle before install** | Write third-party bytes into the user file on a bare link visit; fill the shelf to evict what the user has not seen; render markup from the bundle | Memory-first: a link visit persists nothing (`sharedApp:` rows are written only on an explicit act — an opened file, or "keep"); the cap REFUSES the 13th with a note, never evicts; every bundle string renders as a text node (hostile-bundle test) |
| **S6** | **A shared preview runs code the user did not write** | Spend the user's LLM tokens on a click | The preview mounts a consent-gate transport that answers every `llm-request` with a named refusal until the user arms "run with AI" (per mount, never persisted); a starter keeps the real transport |
| **S7** | **The share sheet exports the sharer's app** | Leak a credential the sharer pasted into their code or docs; leak the sharer's collected LAN address or a registry-synthesized `userLayer`; leak data rows, grants, history, chat | The bundle has no seat for secrets, grants, versions, threads, rows or settings (byte-scan test); `lanHost` rows export without their collected address; `userLayer` is stripped; a credential-shaped literal raises a NAMED warning with "share anyway" (the sharer owns the code) |
| **S8** | **The `.snug` extension now names two kinds of file** | Get a bundle opened as a user file (replace-your-data), or a user file added as an app | One sniff (`sniffSnugFile`: SQLite magic / `SNUGENC1` / `{`) shared by the desktop open path and both Settings pickers; a bundle has no SQLite magic so `isUserFilePayload` refuses it before any confirm; each picker names the other on a mismatch |
| **S9** | **The relay** (`share.snugprotocol.org`) — the one hosted endpoint since ADR-0013 | Read what is shared; substitute a bundle; enumerate shares; use the relay as a free file host; keep a share alive past its expiry; forge a revoke | AES-256-GCM in the sharer's browser with the key ONLY in the URL fragment (never sent; stripped from `Referer`); the AEAD tag fails on substitution; 128-bit server-minted ids, no listing, every other path a bodiless 404; a size cap; `expiresAt` enforced at READ (the bucket lifecycle rule is a janitor); revoke tokens stored only as sha-256 and compared constant-time; no body logging, observability off, and `deploy-relay.mjs` refuses a config that grew a second binding |
| **S10** | **The `snug://` scheme** — the OS hands a URL to the running shell | Drive-by activation from any web page; smuggle a path or a foreign scheme | A URL is data: delivered through the deep-link plugin's own seats, never the open-file allowlist (which still filters to `file://` paths); only `snug://s/<id>#<key>` parses (strict id/key grammar), only the pinned relay origin is fetched, and the outcome is a preview card — never an install |
| **S11** | **Link records on the sharer's side** | Read the revoke token or the key from a hub-synced or default-exported file | The public record (`id`, `expiresAt`) is a settings row; the token and key live in `snug_secrets` under `share:<id>`, which hub-origin sync and default exports strip (test: a default export carries neither) |

## 3. Residual risk — accepted and NOT mitigated

### R-a — The recipient is the reviewer, and strong review can still be approved
A shared app can declare a real provider's connection through the bare-borrower path and
receive the registry's pinned seats; the user may then approve it after the field-by-field
review. The app can only reach the frozen ceiling, mutating calls still confirm, and the
credential never enters the iframe (C1) — but an app the user connects to their own Gmail
can read their mail inside the sandbox, exactly as an LLM-built app can. Accepted: the
review is the control, and the copy names a third-party author.

### R-b — The link IS the secret
Anyone holding `…/s/<id>#<key>` can fetch and decrypt the bundle until it expires or is
revoked. Links pasted into a chat are as private as that chat. The share sheet says so;
a revoke is best-effort (a recipient who already fetched keeps the bytes).

### R-c — A blind blob drop is a generic anonymous file host for 30 days
The relay cannot validate content it cannot read; anyone can store ≤ ~1 MiB of ciphertext
per upload. Mitigated by the cap, the TTL, a per-IP rate-limiting rule (dashboard; runbook),
and the fact that far better free hosts exist. Turnstile is queued if abuse appears.

### R-d — Third-party system-slot text (S4) is reviewed, not verified
Showing the contract as text before install is a consent surface, not a semantic filter:
a user can install an app whose contract instructs the model in ways they did not read.
The blast radius is the app's own frame — the host puts no secret in the context and the
app has no network of its own.

### R-e — The sharer's docs may carry personal data
The wiki is the app's living memory; `memory` is off by default and every doc is a
per-doc choice with a first-line preview, but a sharer who ticks a doc ships its contents.
The share scan looks for credential shapes only, not names or addresses.

### R-f — `lineage` links a re-share to its origin app
`lineage` is the sharer's app id (a random UUID, no personal data), stable across
re-shares of the same app so a recipient can be offered an update. Two bundles from the
same origin are therefore linkable to each other; they are not linkable to a person.

### R-g — Seed rows do not travel
Builder-seeded reference rows live in the migration log, not the registry; a shared app
whose behaviour depends on them arrives with empty lookup tables. Stated in the sheet.

### R-h — The relay's blindness is a claim about the DEPLOYED code
ADR-0013's "verifiable by reading the deploy config" becomes "verifiable by reading
~150 lines of Worker plus the client crypto". `deploy-relay.mjs`'s config preflight and
the handler's tests are the enforcement; a hostile owner could deploy something else.
Same class as main-model R-1 (a compromised host page), named because the relay is the
first server-side code the project operates.

## 4. What this delta does not change

C1 and C2 are untouched: no new iframe capability, no new credential reader, no new
fetch caller (the relay client is a host-page fetch to a pinned origin, not a connected
fetch). The runner, the executor and the credential store did not change. The open-file
allowlist did not change. No storage-schema version changed.
