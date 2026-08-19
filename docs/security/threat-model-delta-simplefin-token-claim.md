# Threat-model delta — SimpleFIN token-claim connections

- **Task:** TASK-20260818-ledger-starter (Phase A) · **ADR:** [0038](../decisions/0038-simplefin-token-claim-and-ledger.md)
- **Date:** 2026-08-18 · **Status:** the honest delta at Phase A close. Phase C (the
  open-url capability) gets its own section here when it lands — it is a different
  surface class and must not ride this document's Phase A conclusions.
- **Scope:** what the token-claim pairing family adds to the attack surface, what bounds
  each addition, and what is **accepted and not mitigated**.

> **How to read this.** A *delta*, not a full threat model. It assumes the Dynamic Auth
> v2 delta (the frozen ceiling, admission's borrow ban, the scrubber's boundary) and
> inherits the pairing-family discipline recorded in the desktop-auth delta (ADR-0025
> verify-before-claim; the seat that deliberately cannot express a host).

---

## 1. The posture change in one sentence

The wizard gained the ability to fire an **uncredentialed POST at a URL derived from
user-pasted data** (the setup token) and to store the **credential a provider's response
body mints** — both bounded by the row's frozen ceiling, which remains the wall.

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **The pasted setup token as a request target** — base64 of a claim URL the user did not read | Paste-phish a token whose claim URL points at an attacker host (exfiltrating nothing but *receiving* the POST, or answering it with attacker credentials) | The decoded URL must be https, on the row's **frozen ceiling** (punycode-normalized exact-host membership — `beta-bridge.simplefin.org` only), default port, no userinfo. The ceiling froze at approval from the **registry's** pinned host, before any token existed (ADR-0023's binding order). A token naming any other destination is a fixed-sentence refusal that echoes nothing. |
| **S2** | **The claim POST itself** — a wizard-time request outside the connected-fetch executor | Use it as an egress primitive; follow a redirect off-host; smuggle a credential onto it | It is the third **named** network seat in `packages/auth` (allowlist test extended deliberately): one POST, empty body, **no headers of any kind**, `redirect:'error'` asserted as an arriving option (the tauri-shim lesson). There is nothing to inject — the request is what *creates* the credential. |
| **S3** | **The minted access URL** — a provider response body parsed into a credential | Answer the claim with a URL whose host/port/path re-aims later traffic; oversize the body; hide the credential | Parsed by the URL API, never regex; refused unless https + on-ceiling + default port + path exactly `/simplefin` (the checked invariant — review Blocker 3) + BOTH userinfo halves present; body bounded at 4 KiB before parse. The minted pair reaches exactly one seat — the write-together `commit` — and is verified (ADR-0025, 2xx-only, `redirect:'error'`) **before** anything durable exists. |
| **S4** | **Stored basic_auth custody** | Harvest the pair from state, exports, errors | Nothing new by construction: the pair lands under the ADR-0014 `auth:<appId>:<slot>:<field>` keys and rides the existing executor's per-use injection, scrub, export-strip and revoke paths — no `request` seat, the `basic_auth` kind default is the only injection. No result object, error message, or rendered surface carries the token, a decoded URL, or either credential half (byte-probed). |
| **S5** | **The wizard paste screen** | Trick the family router into the typed screen (storing garbage) or the reverse | Routing keys on the **resolved registry seat** (single-resolution rule), never on the kind; `saveConnectionCredentials` refuses the family outright, with a positive-twin test proving custom basic_auth providers still type. The no-re-claim gate keys on `claimVerifiedAt` (its own marker — a stale sibling marker cannot vouch), so a reopened wizard can never burn a second token. |

## 3. Residual risk — accepted and NOT mitigated

### R-1 — A token claimed for the wrong SimpleFIN account
The claim URL inside a token names a *bridge account*, not a user. If an attacker
convinces a user to paste the **attacker's** token, the connection binds to the
attacker's bridge account: the app then reads the attacker's transaction feed (data the
attacker chose to show), not the user's. No user credential or user data crosses in
either direction — the harm is deception, not disclosure — and SimpleFIN's own
single-use token semantics bound replays. Accepted; the wizard copy tells the user the
token comes from *their* SimpleFIN Bridge account.

### R-2 — Third-party SimpleFIN servers are refused
The protocol allows any bank to run its own SimpleFIN server; this integration pins the
SimpleFIN Bridge host only, so a token from a self-hosted server refuses at S1. A named
1.0 limitation (ADR-0038), revisited only through a reviewed registry change — the
alternative (honoring the token's host) is a second host channel around the ceiling.

### R-3 — Host-page compromise
Unchanged ceiling, restated: the host page holds every credential and calls fetch, so
host-page compromise has always meant credential compromise. The claim adds no new
capability an attacker in that position lacked.

### R-4 — The bridge itself
SimpleFIN Bridge holds the user's bank credentials server-side (that is its product) and
mints read-only feeds. Snug's boundary starts at the access URL; a bridge compromise is
outside it and is disclosed to the user in the registration walkthrough ("your bank
passwords stay with SimpleFIN — they never touch Snug").
