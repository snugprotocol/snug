# Threat-model delta — the `.snug` file and opt-in passphrase encryption

- **Task:** TASK-20260820-snug-file-and-encryption · **ADRs:** [0042](../decisions/0042-snug-file-extension.md) + [0043](../decisions/0043-passphrase-encryption-at-rest.md)
- **Date:** 2026-08-20 · **Written:** 2026-08-21 (TASK-20260821-hardening-polish, P6)
- **Scope:** what whole-file encryption at rest adds to — and removes from — the attack
  surface, and what is **accepted and not mitigated**.

> **Why this file is dated later than the change it describes.** The encryption work
> amended `docs/threat-model.md` **in place** (R-3 rewritten, adversary A6 re-scoped,
> the R-14 loss residual added) without leaving a delta behind. That was a break in the
> per-change ledger convention: every other security-bearing change in this repo owns a
> delta that the model's §8 hash-pins, so a reader can see what one change contributed.
> This document restores the ledger retroactively. **It records no new decisions** — it
> states what shipped, in the delta form, so the convention holds and the hash-pin
> mechanism covers this surface like every other.

---

## 1. The posture change in one sentence

The user's file may now be **encrypted at rest under a passphrase the host never
stores**, which moves the perimeter for a stolen-disk / stolen-file adversary from *the
OS user account* to *a secret only the user holds* — and, in exchange, introduces the
one failure mode a local-first product cannot undo: a file whose secrets are all lost is
gone.

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **The `SNUGENC1` container** — one AES-256-GCM ciphertext over the whole serialized database | Tamper with the header (algorithm/iteration downgrade, slot substitution) and have the host decrypt under attacker-chosen parameters | The header is bound as GCM **AAD**, so any edited byte fails the AEAD unwrap: parameters are authenticated, not merely present. `packages/db/src/crypto/container.ts`. |
| **S2** | **Two independent unlock slots** (passphrase, Recovery Key) wrapping one random file key | Attack the weaker slot; or force a rewrap that silently drops the stronger one | Each slot wraps the same 32-byte file key independently, so a passphrase change rewraps 48 bytes and cannot touch the Recovery Key slot. The Recovery Key is ≥128 bits by construction (27 symbols over a **30**-glyph alphabet = 132.5 bits — the alphabet is 30, not 32, and assuming base-32 would silently ship 127.6). |
| **S3** | **Re-sealing on every save** — a session holding only ONE accepted secret must still write a container both secrets open | Get a passphrase-only session to write back a container whose recovery slot is gone, then wait for the user to forget their passphrase | Saves **re-seal into the existing container** (same header, same slots, fresh nonce) rather than rebuilding it from the secrets this session holds. The first implementation rebuilt, and silently dropped the recovery slot on every write — the defect that produced the general rule in `lessons.md` (2026-08-20: ask what a session holding only one accepted secret writes back). |
| **S4** | **Nonce reuse across the OPFS A/B slots** | Catastrophic AES-GCM nonce reuse via a counter that repeats when one logical save lands twice | A fresh CSPRNG 12-byte nonce per operation, never a counter — precisely because the A/B persistence design can carry one logical save into two slots. |
| **S5** | **The locked-vs-corrupt distinction** | Convince a user their intact file is damaged (inviting them to destroy it), or that a damaged file is merely mistyped (sending them hunting for a good secret) | Both cases fail the same AEAD unwrap, so an **unkeyed header checksum** picks the honest sentence. It does not need to resist an attacker — the AAD binding does that — it only needs to tell the truth to the user. |
| **S6** | **Encryption meets sync and export** | Ship plaintext to a place the user believed was protected | Protection follows exports and **personal-origin** sync; the seal runs at the ONE persistence seam (`PersistenceBackend.load/save`), and the sync loop's normative order is export → hash **plaintext** → encrypt. Hub origins deliberately keep receiving secrets-stripped plaintext, so `apps/server` and the `/userdb` CAS contract are untouched. |

## 3. What this REMOVES from the attack surface

Stated explicitly because a delta that lists only additions understates the change: for a
protected file, **an adversary with the file bytes but no secret has nothing**. That
covers a stolen laptop with the disk readable, a backup copied off a NAS, a synced copy
sitting in the user's own Dropbox, and a file mailed to the wrong person. Before this
change every one of those was a total compromise of everything in the file, credentials
included; threat-model R-3 and adversary A6 carry the rewritten claim.

## 4. Residual risk — accepted and NOT mitigated

### R-a — Protection is OPT-IN, so the default is still plaintext
A user who never takes the offer is exactly where they were. This is deliberate — a
mandatory secret on a local-first file is a data-loss generator for the median user —
and the offer is placed where it can be taken, but the honest statement of the default
belongs here. (The offer must never gate the hub: a full-screen protection gate in front
of a brand-new profile was shipped once, and it asked people to protect a file before
they had seen a single app.)

### R-b — Losing both secrets loses the data, by design
No escrow, no reset, no vendor recovery. This is the **defining** residual of
client-side encryption with no server: the property that makes S1–S6 worth anything is
the same property that makes loss terminal. Carried in the main model as a numbered
residual and stated in the product copy at the moment of setup — not only here.

### R-c — The unlocked session is as exposed as it ever was
Protection is at REST. Once unlocked, the file key and the plaintext database live in
process memory, so host-page compromise (main-model R-1) is unchanged, and a running,
unlocked session on an unlocked machine is a fully readable session.

### R-d — No attempt limit on unlock
Deliberate: an attacker with the file can guess offline at their own pace, so an in-app
lockout would punish only the owner. The bound is PBKDF2-SHA256 at 600k iterations plus
passphrase quality — which is why the Recovery Key is mandatory and high-entropy, and
why the passphrase is not the only path.

### R-e — Keychain unlock is deliberately NOT implemented
Storing the key in the OS keychain would restore convenience by handing the perimeter
back to the OS account — undoing the exact defence being bought (ADR-0043). Deferred as
a decision, not an omission.
