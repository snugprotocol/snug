// TASK-20260820 — the SNUGENC1 encrypted container (ADR-0043, plan Stage 3).
//
// WHY THESE TESTS EXIST, AND WHY THEY ARE THIS PARANOID.
//
// This container is the only thing standing between a stolen file and the user's
// finances, messages and journals (threat-model A6, previously "explicitly not
// defended"). It is also the only thing standing between a user and PERMANENT loss
// of all of it: there is no server, no reset link, no support desk. Both directions
// of that trade are tested here, and the second one is why several of these tests
// assert on the SHAPE of a failure rather than merely that it failed.
//
// Two failure modes are deliberately kept distinguishable, because conflating them
// is a product catastrophe rather than a mere bug:
//   'locked'  — a structurally sound container + the wrong secret. Recoverable: the
//               user tries again, or reaches for the Recovery Key.
//   'corrupt' — the bytes are damaged. NOT recoverable by trying harder, and telling
//               such a user "wrong passphrase" sends them hunting for a secret that
//               was never the problem (plan review S2).
import { describe, expect, it } from 'vitest';

import {
  CONTAINER_MAGIC,
  KDF_ITERATIONS,
  decryptContainer,
  encryptContainer,
  generateRecoveryKey,
  isEncryptedContainer,
  rewrapPassphrase,
} from '../container.js';

const PASS = 'a passphrase the user will actually remember';
const plaintext = (text: string): Uint8Array => new TextEncoder().encode(text);
const DB = plaintext('SQLite format 3\0 ...pretend this is 40 MiB of someone-s life');

/** Seal with both slots — the shape every real file has (AC11: two independent paths). */
async function sealed(bytes: Uint8Array = DB): Promise<{ container: Uint8Array; recoveryKey: string }> {
  const recoveryKey = generateRecoveryKey();
  const container = await encryptContainer(bytes, { passphrase: PASS, recoveryKey });
  return { container, recoveryKey };
}

describe('SNUGENC1 container — round trip (AC8)', () => {
  it('decrypts to byte-identical plaintext', async () => {
    const { container } = await sealed();
    const out = await decryptContainer(container, { passphrase: PASS });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(Array.from(out.bytes)).toEqual(Array.from(DB));
  });

  it('is recognisable as a container without decrypting it (the magic gate)', async () => {
    const { container } = await sealed();
    expect(isEncryptedContainer(container)).toBe(true);
    expect(isEncryptedContainer(DB)).toBe(false);
    // Short buffers must not throw — this predicate runs on every load, including
    // torn ones (persistence.ts looksComplete).
    expect(isEncryptedContainer(new Uint8Array(0))).toBe(false);
    expect(isEncryptedContainer(new Uint8Array(3))).toBe(false);
  });

  it('starts with the declared magic so looksComplete can accept it (AC9)', async () => {
    const { container } = await sealed();
    expect(new TextDecoder().decode(container.slice(0, CONTAINER_MAGIC.length))).toBe(CONTAINER_MAGIC);
  });

  it('round-trips an empty database (a brand-new file is legitimately tiny)', async () => {
    const { container } = await sealed(new Uint8Array(0));
    const out = await decryptContainer(container, { passphrase: PASS });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.bytes.length).toBe(0);
  });
});

describe('SNUGENC1 container — the two unlock paths (AC11, AC18)', () => {
  it('the Recovery Key opens a file whose passphrase is forgotten', async () => {
    const { container, recoveryKey } = await sealed();
    const out = await decryptContainer(container, { recoveryKey });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(Array.from(out.bytes)).toEqual(Array.from(DB));
  });

  it('the two slots are INDEPENDENT — neither secret opens the other slot', async () => {
    const { container, recoveryKey } = await sealed();
    // The recovery key is not a re-spelling of the passphrase, and vice versa.
    expect(await decryptContainer(container, { passphrase: recoveryKey })).toMatchObject({ status: 'locked' });
    expect(await decryptContainer(container, { recoveryKey: PASS })).toMatchObject({ status: 'locked' });
  });

  it('carries ≥128 bits of entropy in the Recovery Key (AC31)', () => {
    // Pinned as a property of the generator, not of one sample: an implementer who
    // shortens the key to be "friendlier" must fail this, because a 60-bit key is
    // brute-forceable offline against a stolen file.
    const keys = new Set(Array.from({ length: 200 }, () => generateRecoveryKey()));
    expect(keys.size).toBe(200); // no collisions, i.e. not a tiny space

    // Entropy is derived from the OBSERVED alphabet, never from a base-32 assumption.
    // The alphabet is 30 glyphs (0/O/1/l/I are excluded), so each symbol carries
    // log2(30) ≈ 4.907 bits, not 5. An earlier version of this test hardcoded
    // log2(32) and would have happily passed a 26-symbol key at 127.6 bits — under
    // the floor, and invisibly so.
    const observed = new Set<string>();
    for (const key of keys) for (const ch of key.replace(/-/g, '')) observed.add(ch);
    for (const ambiguous of ['0', 'O', '1', 'l', 'I']) expect(observed.has(ambiguous)).toBe(false);

    const symbols = [...keys][0]!.replace(/-/g, '').length;
    expect(symbols * Math.log2(observed.size)).toBeGreaterThanOrEqual(128);
  });

  it('a second device opens the container with the passphrase ALONE (AC18)', async () => {
    // The cross-device property, asserted as the absence of shared state: the only
    // inputs are the bytes and the secret. If an implementation ever stashed the file
    // key outside the container, this test still passes here but AC17 catches it —
    // so this one pins the container's self-sufficiency specifically.
    const { container } = await sealed();
    const asItArrivedOnAnotherMachine = Uint8Array.from(container);
    const out = await decryptContainer(asItArrivedOnAnotherMachine, { passphrase: PASS });
    expect(out.status).toBe('ok');
  });
});

describe('SNUGENC1 container — wrong secret is LOCKED, never corrupt, never plausible (AC10)', () => {
  it('reports locked for a wrong passphrase', async () => {
    const { container } = await sealed();
    expect(await decryptContainer(container, { passphrase: 'not the one' })).toMatchObject({ status: 'locked' });
  });

  it('never yields plausible-looking plaintext for a wrong secret', async () => {
    const { container } = await sealed();
    const out = await decryptContainer(container, { passphrase: 'not the one' });
    // GCM authentication is what makes this true; assert it rather than trust it.
    expect(out).not.toHaveProperty('bytes');
  });

  it('reports locked (not corrupt) for an EMPTY passphrase', async () => {
    const { container } = await sealed();
    expect(await decryptContainer(container, { passphrase: '' })).toMatchObject({ status: 'locked' });
  });
});

describe('SNUGENC1 container — tamper detection (AC26, AC27)', () => {
  it('a flipped ciphertext byte is detected', async () => {
    const { container } = await sealed();
    const tampered = Uint8Array.from(container);
    tampered[tampered.length - 20] ^= 0xff;
    expect(await decryptContainer(tampered, { passphrase: PASS })).toMatchObject({ status: 'corrupt' });
  });

  it('a flipped ITERATION-COUNT byte fails as damage, not as a wrong passphrase (AC26)', async () => {
    // Header fields are bound as GCM AAD. Without that binding this tampering is
    // indistinguishable from a forgotten passphrase — and in a product whose only
    // recovery is the user's own memory, "your passphrase is wrong" is the single
    // most expensive lie we could tell. (Note: a parameter flip is a DoS, not a
    // downgrade — deriving with different iterations yields a different key, so the
    // unwrap fails. AAD is here to make the failure HONEST, not to stop weakening.)
    const { container } = await sealed();
    const tampered = Uint8Array.from(container);
    tampered[13] ^= 0x01; // inside the u32 iteration count
    expect(await decryptContainer(tampered, { passphrase: PASS })).toMatchObject({ status: 'corrupt' });
  });

  it('a flipped SALT byte fails as damage, not as a wrong passphrase (AC26)', async () => {
    const { container } = await sealed();
    const tampered = Uint8Array.from(container);
    tampered[20] ^= 0x01; // inside the salt
    expect(await decryptContainer(tampered, { passphrase: PASS })).toMatchObject({ status: 'corrupt' });
  });

  it('a TRUNCATED container is corrupt, not locked (AC27 / review S2)', async () => {
    // The dangerous conflation: a truncated file still carries the 9-byte magic, so
    // looksComplete admits it. If that surfaced as 'locked', the user would retype a
    // correct passphrase forever against a file that was damaged, not protected.
    const { container } = await sealed();
    expect(await decryptContainer(container.slice(0, container.length - 8), { passphrase: PASS })).toMatchObject({
      status: 'corrupt',
    });
    expect(await decryptContainer(container.slice(0, 12), { passphrase: PASS })).toMatchObject({ status: 'corrupt' });
  });

  it('non-container bytes are corrupt, not locked', async () => {
    expect(await decryptContainer(DB, { passphrase: PASS })).toMatchObject({ status: 'corrupt' });
  });
});

describe('SNUGENC1 container — nonce discipline (AC25 / review B6)', () => {
  it('two encryptions of IDENTICAL plaintext differ in IV and ciphertext', async () => {
    // A nonce repeat under GCM leaks plaintext XOR *and* forges the auth key. The
    // A/B slot scheme can write one logical save into two slots, so a derived or
    // counter nonce is not merely weak here — it is reachable in normal operation.
    const recoveryKey = generateRecoveryKey();
    const a = await encryptContainer(DB, { passphrase: PASS, recoveryKey });
    const b = await encryptContainer(DB, { passphrase: PASS, recoveryKey });
    expect(Array.from(a)).not.toEqual(Array.from(b));
    // ...and both still open.
    expect(await decryptContainer(a, { passphrase: PASS })).toMatchObject({ status: 'ok' });
    expect(await decryptContainer(b, { passphrase: PASS })).toMatchObject({ status: 'ok' });
  });

  it('pins the KDF iteration count so it cannot silently regress', () => {
    // Measured at 175 ms; the number is a security parameter, not a tuning knob.
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});

describe('SNUGENC1 container — passphrase change without re-encrypting (AC12)', () => {
  it('rewraps the passphrase slot, leaving the payload and the Recovery Key intact', async () => {
    const { container, recoveryKey } = await sealed();
    const rewrapped = await rewrapPassphrase(container, { current: PASS, next: 'a brand new passphrase' });
    expect(rewrapped.status).toBe('ok');
    if (rewrapped.status !== 'ok') return;

    // New passphrase opens it; old one does not.
    expect(await decryptContainer(rewrapped.bytes, { passphrase: 'a brand new passphrase' })).toMatchObject({
      status: 'ok',
    });
    expect(await decryptContainer(rewrapped.bytes, { passphrase: PASS })).toMatchObject({ status: 'locked' });
    // AC12: the Recovery Key SURVIVES a passphrase change.
    expect(await decryptContainer(rewrapped.bytes, { recoveryKey })).toMatchObject({ status: 'ok' });
  });

  it('does not re-encrypt the payload (the whole point of key-wrapping)', async () => {
    const { container } = await sealed();
    const rewrapped = await rewrapPassphrase(container, { current: PASS, next: 'another one' });
    expect(rewrapped.status).toBe('ok');
    if (rewrapped.status !== 'ok') return;
    // Same length, and the payload tail is byte-identical — only slot bytes moved.
    expect(rewrapped.bytes.length).toBe(container.length);
    const tail = (b: Uint8Array): number[] => Array.from(b.slice(b.length - 64));
    expect(tail(rewrapped.bytes)).toEqual(tail(container));
  });

  it('refuses to rewrap when the current passphrase is wrong', async () => {
    const { container } = await sealed();
    expect(await rewrapPassphrase(container, { current: 'wrong', next: 'x' })).toMatchObject({ status: 'locked' });
  });
});

// --- The published wire layout ---------------------------------------------
//
// WHY (TASK-20260821-launch-security-review). Spec §11.1 documented a slot-table entry as
// `{ kind:u8, iv:12 }` — 13 bytes — while this encoder strides 61. That is disqualifying
// rather than cosmetic, because §11.2 rule 4 makes the header *through the end of the slot
// table* the GCM AAD: an implementation written from the published text computes a
// different AAD span and cannot open a conforming file at all, surfacing as a wrong-secret
// error on a healthy container — exactly the misreport rule 6 forbids.
//
// The spec was corrected to match this encoder (the code was self-consistent throughout).
// These assertions pin the bytes the spec now promises, so the two cannot drift apart
// again silently: the next person to change the layout fails here and is sent to the spec.
describe('the SNUGENC1 wire layout matches the published specification', () => {
  const HEADER_FIXED_LEN = 38;
  const SLOT_STRIDE = 61;
  const WRITTEN_PER_SLOT = 13; // kind:u8 + iv:12

  it('writes a 61-byte slot stride whose trailing 48 bytes are reserved and ZERO', async () => {
    const bytes = await encryptContainer(new Uint8Array([1, 2, 3, 4]), {
      passphrase: 'correct-horse-battery-staple',
      recoveryKey: 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ',
    });

    // Slot count is a u16 big-endian at offset 32 — two slots, always (a one-slot
    // container is refused by construction).
    expect(bytes[32]).toBe(0);
    expect(bytes[33]).toBe(2);

    for (let slot = 0; slot < 2; slot++) {
      const at = HEADER_FIXED_LEN + slot * SLOT_STRIDE;
      for (let i = WRITTEN_PER_SLOT; i < SLOT_STRIDE; i++) {
        expect(bytes[at + i], `slot ${slot} reserved byte ${i} must be zero`).toBe(0);
      }
    }
  });

  it('puts the header at 160 bytes for two slots — the AAD span an implementer must reproduce', async () => {
    // MEASURED from the bytes, not computed from the same constants the encoder uses: a
    // test that restates the implementation's arithmetic passes under any stride and
    // proves nothing (checked — the first draft of this test survived a 61→13 mutation).
    // The second slot's IV is the last thing written into the slot table, so the first
    // wrapped-key byte begins immediately after it, and finding where the zero-padding
    // ends locates the header's true end independently.
    const payload = new Uint8Array([9, 9]);
    const bytes = await encryptContainer(payload, {
      passphrase: 'another-passphrase-entirely',
      recoveryKey: 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ',
    });

    // Walk forward from the end of the second slot's WRITTEN region to the first
    // non-zero byte: that is where the wrapped keys start, i.e. the end of the header.
    const secondSlotWrittenEnd = HEADER_FIXED_LEN + SLOT_STRIDE + WRITTEN_PER_SLOT;
    let cursor = secondSlotWrittenEnd;
    while (cursor < bytes.length && bytes[cursor] === 0) cursor++;
    // 48 zero bytes of reserved space separate them (a wrapped key beginning with a zero
    // byte would shorten this by one; allow that single-byte slack rather than flaking).
    expect(cursor - secondSlotWrittenEnd).toBeGreaterThanOrEqual(47);
    expect(cursor - secondSlotWrittenEnd).toBeLessThanOrEqual(48);
    expect(HEADER_FIXED_LEN + 2 * SLOT_STRIDE).toBe(160);
    expect(bytes.length).toBeGreaterThan(160);
  });
});
