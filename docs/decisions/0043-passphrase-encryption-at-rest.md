# 0043 — Opt-in passphrase encryption at rest (the `SNUGENC1` container)

- **Status:** accepted
- **Date:** 2026-08-20
- **Task:** TASK-20260820-snug-file-and-encryption
- **Amends:** [ADR-0014](0014-credentials-local-first.md) (its "client-side encryption … Deferred, not rejected" alternative is now decided), [ADR-0009](0009-sync-provider-origins.md) (the canonical export is `.snug` and may be protected)

## Context

[Threat-model](../threat-model.md) R-3 states that `~/Snug/user.snug` is a plaintext file and adversary **A6 — a local process running as the same user — is "explicitly not defended."** That was an honest, deliberate posture: [ADR-0014](0014-credentials-local-first.md) put custody in the user's own file precisely so there would be no operator-readable vault, and the OS user account was accepted as the perimeter.

ADR-0014 also considered exactly this feature and **deferred rather than rejected** it, naming the cost precisely: *"it hardens the file at rest but adds a forgotten-passphrase data-loss mode and does not change custody."* This ADR takes that deferral off the shelf, because the cost is now payable.

**SQLite's own encryption is not available to us.** The engine is `sql.js` — the vanilla SQLite WASM build — which has no SQLCipher and no `PRAGMA key`; SQLite's SEE extension is paid and closed-source. Swapping the engine would replace the storage layer under `packages/db`, `apps/playground` and `apps/desktop` at once. So "put a password on the SQLite file" is not a thing that can be done; a Snug-owned envelope is.

## Decision

1. **Whole-file envelope encryption at the persistence seam.** A `SNUGENC1` container wraps the serialized database. Persistence here is already whole-file (`db.export()` → `Uint8Array`) through **one** injected seam, and there is already precedent for a Snug-owned magic container at that exact seam (`SYNC_SIDECAR_MAGIC`). AES-256-GCM; PBKDF2-SHA256 at **600,000** iterations (OWASP baseline; measured 175 ms — a deliberate once-per-unlock cost, stored in the header so it can be raised later without orphaning old files).
2. **Key wrapping, not direct encryption.** A random 32-byte *file key* encrypts the database; the passphrase and the Recovery Key each independently wrap it in their own slot. Three required properties follow: changing the passphrase rewraps ~48 bytes instead of re-encrypting 64 MiB; the Recovery Key survives a passphrase change; and the container is **self-opening**, so a file synced to another device opens there with the secret alone.
3. **A Recovery Key is mandatory, not optional.** ≥128 bits — **27 symbols from a 30-glyph alphabet** (`0/O/1/l/I` excluded), rejection-sampled, giving 27 × log2(30) ≈ **132.5 bits**. The alphabet is 30, not 32: at 26 symbols this would be 127.6 bits, under the floor, and a base-32 assumption hides exactly that shortfall — so the test derives entropy from the observed alphabet rather than a hardcoded log2(32). `encryptContainer` **refuses** to build a single-slot container. This is what makes ADR-0014's named cost payable: without a second independent way in, this feature ships a data-loss mode with no mitigation.
4. **Opt-in (D3).** Offered prominently at first run on web and desktop, via its own setting key with its own lifecycle — never entangled with the desktop welcome latch. "Not now" is re-offered next launch; an explicit "don't ask again" is respected. Existing plaintext files keep opening untouched.
5. **Protection follows the file off the device (D5), except to a hub (D6).** Exports and personal-origin sync pushes are sealed. **Hub origins keep receiving secrets-stripped plaintext**: ADR-0014 already guarantees hub copies carry no credentials, so it is the least sensitive copy, and teaching the server a new body format would change the `/userdb` contract for no privacy gain. `apps/server` is untouched by this ADR.
6. **Order is normative**: export (strip + VACUUM need plaintext) → hash the **plaintext** for the change gate → encrypt. Hashing ciphertext would make every 30-second tick see a fresh random IV, conclude "changed", and re-push the whole database forever.
7. **Nonce discipline is normative**: the payload IV and every slot-wrap IV are **12 fresh CSPRNG bytes per operation** — never a counter, never derived. The OPFS A/B slot scheme can write one logical save into two slots, so a repeat is reachable in ordinary use, and a GCM nonce repeat leaks plaintext XOR *and* forges the authentication key.
8. **A protected file is `locked`, never `corrupt`.** Distinct open status; nothing is quarantined, moved or rewritten. Structural damage still reports `corrupt`, separated by an unkeyed header checksum — so a user with a damaged file is never told their passphrase is wrong, and a user who mistyped is never told their data is broken.
9. **No attempt limit.** An attacker holding the file guesses offline as fast as they like, so a lockout would punish only the owner — who has no reset link and no support desk.

## Alternatives considered

- **Swap to SQLCipher / wa-sqlite.** Rejected: months-long engine migration across three packages, every persistence path, sync, the OPFS slot scheme and the whole test suite — to buy page-level encryption this design does not need.
- **Encrypt only `snug_secrets`.** Rejected: it defends credentials and leaves the app data — finances, journals, messages — readable, which is most of what R-3 exposes.
- **Passphrase only, no Recovery Key.** Rejected: this is precisely the unmitigated data-loss mode ADR-0014 refused to ship.
- **OS-keychain convenience unlock.** Deferred: on that device it hands the perimeter back to the OS account, undoing the A6 defence being bought. Revisit post-1.0 as a knowing opt-in.
- **Argon2id instead of PBKDF2.** Rejected on availability, not merit: WebCrypto has no Argon2, and hand-rolling a memory-hard KDF (or shipping a WASM one to every surface) is a larger liability than the iteration count it would replace.
- **Header MAC keyed by the file key instead of a plain checksum.** Rejected: the file key is only available *after* unwrapping, so it cannot decide whether the header was damaged before the unwrap is attempted. The checksum is an integrity *hint* — unkeyed and trivially recomputable by an attacker — and it does not need to be more: AAD is what makes tampering fail, and this only decides which honest sentence the user reads.

## Consequences

- **Threat-model R-3 and adversary A6 are rewritten**: with protection on, a local process reading the file gets ciphertext. Threat-model v2 states the new boundary and its limits.
- **The honest claim, bounded by [ADR-0014 §5](0014-credentials-local-first.md)**: *"your file can be encrypted with a passphrase only you hold."* It is **not** zero-knowledge, **not** end-to-end encrypted, and it does **not** defend a live compromised host page (R-1 is unchanged) or a device while the passphrase is being typed. Marketing may not strengthen it.
- **A protected `.snug` is not openable by standard `sqlite3` tooling** — a real cost against ADR-0007's portability story, which is why this is opt-in and reversible (`protect(undefined)` writes plaintext back).
- **Residual, stated rather than implied away**: if the user loses both the passphrase and the Recovery Key, the data is unrecoverable. There is no backdoor, by design. This is added as a named residual in the threat model.
- **AAD scope, stated honestly**: binding the header prevents splicing one file's header onto another's payload. It does **not** prevent whole-file replacement — an attacker can always author a complete valid container of their own. That is A5 (a hostile file), already handled by import demotion.
- Spec impact: the container format, its KDF parameters, and the conformance rule that a hub MUST detect `SNUGENC1` and prompt (rather than treat it as corrupt) are normative surface in spec v0.2-userdb.
