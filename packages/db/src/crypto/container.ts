// The SNUGENC1 encrypted container (TASK-20260820, ADR-0043).
//
// WHAT THIS IS. A whole-file envelope wrapped around the serialized SQLite bytes of
// the user's one portable file. sql.js is the vanilla SQLite WASM build — it has no
// SQLCipher and no `PRAGMA key`, and SQLite's own encryption (SEE) is a paid
// closed-source extension — so page-level encryption is not available to us at any
// price we are willing to pay. What IS available is that persistence here is already
// whole-file (`db.export()` → Uint8Array on every save), through ONE injected seam.
// This container sits at that seam. `SYNC_SIDECAR_MAGIC` established the pattern: a
// Snug-owned magic-prefixed envelope living exactly where a SQLite file would.
//
// KEY WRAPPING, NOT DIRECT ENCRYPTION. A random 32-byte FILE KEY encrypts the
// database. The passphrase and the Recovery Key each independently wrap that file key
// in their own slot. Three properties fall out of that choice, and all three are
// requirements rather than nice-to-haves:
//   1. Changing the passphrase rewraps ~48 bytes instead of re-encrypting 64 MiB.
//   2. The Recovery Key survives a passphrase change — it wraps the same file key.
//   3. The container is SELF-OPENING: everything needed to unwrap is inside it, so a
//      file synced to a second device opens there with the passphrase alone. Nothing
//      is stored outside the file. (Storing the file key in `snug_secrets` would be
//      circular anyway — that table lives inside the thing being decrypted.)
//
// WHAT IT DEFENDS, STATED HONESTLY. This moves threat-model A6 (a local process
// running as the same user) from "explicitly not defended" to "defended at rest". It
// does NOT defend a live compromised host page (R-1 is unchanged), a device where the
// passphrase is being typed, or a file an attacker replaces wholesale with one of
// their own (that is A5, handled by import demotion). AAD binding below prevents
// SPLICING one file's header onto another's payload; it cannot prevent whole-file
// substitution, and this comment exists so nobody later mistakes it for that.
import { CONTAINER as C } from '@snugprotocol/protocol';

export const CONTAINER_MAGIC = C.MAGIC;
export const CONTAINER_VERSION = C.VERSION;
export const KDF_ITERATIONS = C.KDF_ITERATIONS;
export const SLOT_KIND = C.SLOT_KIND;

/** Unwrap outcomes. `locked` and `corrupt` are kept apart on purpose — see below. */
export type DecryptResult =
  | { status: 'ok'; bytes: Uint8Array }
  /** Structurally sound container, wrong secret. The user tries again. */
  | { status: 'locked' }
  /** Damaged or not a container. Trying harder cannot help; say so. */
  | { status: 'corrupt'; reason: string };

export type RewrapResult = { status: 'ok'; bytes: Uint8Array } | { status: 'locked' } | { status: 'corrupt'; reason: string };

export interface Secrets {
  passphrase?: string;
  recoveryKey?: string;
}

const MAGIC_BYTES = new TextEncoder().encode(CONTAINER_MAGIC);
const SALT_LEN = 16;
const IV_LEN = 12;
const FILE_KEY_LEN = 32;
const GCM_TAG_LEN = 16;
const WRAPPED_LEN = FILE_KEY_LEN + GCM_TAG_LEN; // 48

// Header layout (byte offsets). Everything up to HEADER_FIXED_LEN plus the slot table
// is bound as AAD, so a single flipped byte anywhere in it is reported as damage.
const OFF_VERSION = MAGIC_BYTES.length; // 9
const OFF_KDF_ID = OFF_VERSION + 1; // 10
const OFF_ITERATIONS = OFF_KDF_ID + 2; // 12
const OFF_SALT = OFF_ITERATIONS + 4; // 16
const OFF_SLOT_COUNT = OFF_SALT + SALT_LEN; // 32
const OFF_CHECKSUM = OFF_SLOT_COUNT + 2; // 34 — integrity hint over everything before it
const HEADER_FIXED_LEN = OFF_CHECKSUM + 4; // 38
const SLOT_LEN = 1 + IV_LEN + WRAPPED_LEN; // kind + iv + wrapped key

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (c?.subtle === undefined) {
    // Fail loudly. Silently degrading to "no encryption" on a surface the user asked
    // to protect would be the worst possible outcome of a missing capability.
    throw new Error('WebCrypto (crypto.subtle) is unavailable — cannot open or create a protected Snug file');
  }
  return c.subtle;
};

const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Cheap, total predicate — runs on EVERY load, including torn and empty buffers. */
export function isEncryptedContainer(bytes: Uint8Array | undefined): boolean {
  if (bytes === undefined || bytes.length < MAGIC_BYTES.length) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (bytes[i] !== MAGIC_BYTES[i]) return false;
  return true;
}

/**
 * The Recovery Key: 27 symbols from a 30-glyph alphabet = **132.5 bits**
 * (27 × log2(30) = 27 × 4.907), grouped in fives for transcription.
 *
 * The alphabet excludes 0/O/1/l/I because this key's whole job is to be copied off a
 * screen or a printout by a worried human, possibly years later — an unreadable key is
 * not a recovery mechanism.
 *
 * MIND THE ARITHMETIC. The alphabet is 30 symbols, not 32, so each carries log2(30) ≈
 * 4.907 bits rather than a tidy 5. At 26 symbols this key would be 127.6 bits — just
 * under the 128-bit floor the spec requires, and exactly the kind of shortfall a
 * base-32 assumption hides. The test derives the entropy from the alphabet itself for
 * that reason: a hardcoded log2(32) would have called 127.6 bits a pass.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // 30 symbols, no ambiguous glyphs
const RECOVERY_SYMBOLS = 27;

export function generateRecoveryKey(): string {
  // Rejection sampling keeps the distribution uniform: taking `byte % 30` would make
  // the first 16 symbols measurably likelier and quietly cost entropy.
  const out: string[] = [];
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  while (out.length < RECOVERY_SYMBOLS) {
    for (const byte of randomBytes(RECOVERY_SYMBOLS)) {
      if (byte >= limit) continue;
      out.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]!);
      if (out.length === RECOVERY_SYMBOLS) break;
    }
  }
  return (out.join('').match(/.{1,5}/g) ?? []).join('-');
}

/** Normalize a typed Recovery Key: humans add spaces, drop dashes, and hold shift. */
const normalizeRecoveryKey = (key: string): string => key.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function deriveWrappingKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, material, 256);
  return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const secretFor = (kind: number, secrets: Secrets): string | undefined => {
  if (kind === SLOT_KIND.passphrase) return secrets.passphrase;
  if (kind === SLOT_KIND.recoveryKey) {
    return secrets.recoveryKey === undefined ? undefined : normalizeRecoveryKey(secrets.recoveryKey);
  }
  return undefined;
};

/**
 * Build the header. The AAD span is the header INCLUDING the slot table, so the KDF
 * parameters, the salt, and every slot's kind and IV are all authenticated. A flipped
 * iteration count therefore surfaces as damage rather than as "wrong passphrase" —
 * which matters enormously, because in this product "wrong passphrase" is the most
 * expensive lie we can tell a user who did nothing wrong.
 */
function checksumOver(header: Uint8Array): number {
  const copy = Uint8Array.from(header);
  new DataView(copy.buffer).setUint32(OFF_CHECKSUM, 0); // the field cannot cover itself
  return headerChecksum(copy, copy.length);
}

function buildHeader(salt: Uint8Array, iterations: number, slots: { kind: number; iv: Uint8Array }[]): Uint8Array {
  const header = new Uint8Array(HEADER_FIXED_LEN + slots.length * SLOT_LEN);
  header.set(MAGIC_BYTES, 0);
  header[OFF_VERSION] = CONTAINER_VERSION;
  const view = new DataView(header.buffer);
  view.setUint16(OFF_KDF_ID, C.KDF_PBKDF2_SHA256);
  view.setUint32(OFF_ITERATIONS, iterations);
  header.set(salt, OFF_SALT);
  view.setUint16(OFF_SLOT_COUNT, slots.length);
  slots.forEach((slot, i) => {
    const at = HEADER_FIXED_LEN + i * SLOT_LEN;
    header[at] = slot.kind;
    header.set(slot.iv, at + 1);
  });
  // Computed over everything EXCEPT the checksum field itself, then over the slot
  // table too — so a flipped slot IV is caught as damage exactly like a flipped salt.
  view.setUint32(OFF_CHECKSUM, 0);
  view.setUint32(OFF_CHECKSUM, checksumOver(header));
  return header;
}

/** The AAD: the whole header, so KDF params, salt, slot kinds and slot IVs are all bound. */
const aadFor = (header: Uint8Array): Uint8Array => header;

/**
 * A plain (unkeyed) checksum over the header, stored in the header's own tail.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT. AAD binding alone makes header tampering fail
 * the unwrap — but so does a wrong passphrase, and the two are then indistinguishable.
 * That conflation is the expensive one: telling a user "wrong passphrase" about a file
 * that is actually DAMAGED sends them hunting for a secret that was never the problem,
 * in a product where the secret is the only thing standing between them and permanent
 * loss (plan review S2/B5, AC26/AC27).
 *
 * This is an INTEGRITY hint, not a security control: it is unkeyed, so an attacker who
 * rewrites the header can trivially recompute it. It does not need to resist that —
 * AAD is what makes tampering fail, and this only decides which honest sentence the
 * user reads. Against ACCIDENTAL damage (bit rot, a truncated sync, a torn write),
 * which is the overwhelmingly likelier cause, it is exactly right.
 */
function headerChecksum(header: Uint8Array, upTo: number): number {
  // FNV-1a 32-bit: tiny, dependency-free, and entirely adequate for detecting damage.
  let hash = 0x811c9dc5;
  for (let i = 0; i < upTo; i++) {
    hash ^= header[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export async function encryptContainer(bytes: Uint8Array, secrets: Secrets): Promise<Uint8Array> {
  const passphrase = secrets.passphrase;
  if (passphrase === undefined || passphrase.length === 0) {
    throw new Error('a passphrase is required to protect a Snug file');
  }
  const recoveryKey = secrets.recoveryKey;
  if (recoveryKey === undefined) {
    // Refused by construction, not by policy: ADR-0014 deferred this feature over the
    // forgotten-passphrase data-loss mode, and the second slot is the entire reason
    // that deferral is now payable. A container with one slot is not shippable.
    throw new Error('a Recovery Key is required — a passphrase-only Snug file has no recovery path');
  }
  const salt = randomBytes(SALT_LEN);
  const fileKey = randomBytes(FILE_KEY_LEN);
  // Fresh CSPRNG IVs per operation, never counters and never derived (plan review B6):
  // the A/B slot scheme can write one logical save into two slots, so a repeat is
  // reachable in ordinary use, and under GCM a repeat forges the auth key.
  const slots = [
    { kind: SLOT_KIND.passphrase, iv: randomBytes(IV_LEN), secret: passphrase },
    { kind: SLOT_KIND.recoveryKey, iv: randomBytes(IV_LEN), secret: normalizeRecoveryKey(recoveryKey) },
  ];
  const payloadIv = randomBytes(IV_LEN);
  const header = buildHeader(salt, KDF_ITERATIONS, slots);
  const aad = aadFor(header);

  const wrapped: Uint8Array[] = [];
  for (const slot of slots) {
    const kek = await deriveWrappingKey(slot.secret, salt, KDF_ITERATIONS);
    const sealed = await subtle().encrypt(
      { name: 'AES-GCM', iv: slot.iv as BufferSource, additionalData: aad as BufferSource },
      kek,
      fileKey as BufferSource,
    );
    wrapped.push(new Uint8Array(sealed));
  }

  const contentKey = await subtle().importKey('raw', fileKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
  const payload = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: payloadIv as BufferSource, additionalData: aad as BufferSource },
      contentKey,
      bytes as BufferSource,
    ),
  );

  const out = new Uint8Array(header.length + wrapped.length * WRAPPED_LEN + IV_LEN + payload.length);
  out.set(header, 0);
  let at = header.length;
  for (const w of wrapped) {
    out.set(w, at);
    at += WRAPPED_LEN;
  }
  out.set(payloadIv, at);
  out.set(payload, at + IV_LEN);
  return out;
}

interface ParsedContainer {
  header: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  slots: { kind: number; iv: Uint8Array; wrapped: Uint8Array; wrappedAt: number }[];
  payloadIv: Uint8Array;
  payload: Uint8Array;
}

/**
 * Structural parse. Every failure here is `corrupt`, never `locked` — this function
 * has not yet touched a secret, so it cannot possibly be the user's fault (review S2).
 */
function parse(bytes: Uint8Array): ParsedContainer | { error: string } {
  if (!isEncryptedContainer(bytes)) return { error: 'not a Snug encrypted container' };
  if (bytes.length < HEADER_FIXED_LEN) return { error: 'truncated container header' };
  if (bytes[OFF_VERSION] !== CONTAINER_VERSION) return { error: `unsupported container version ${bytes[OFF_VERSION]}` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(OFF_KDF_ID) !== C.KDF_PBKDF2_SHA256) return { error: 'unsupported key-derivation function' };
  const iterations = view.getUint32(OFF_ITERATIONS);
  const slotCount = view.getUint16(OFF_SLOT_COUNT);
  if (slotCount === 0 || slotCount > 8) return { error: `implausible slot count ${slotCount}` };
  const headerLen = HEADER_FIXED_LEN + slotCount * SLOT_LEN;
  const minLen = headerLen + slotCount * WRAPPED_LEN + IV_LEN + GCM_TAG_LEN;
  if (bytes.length < minLen) return { error: 'truncated container body' };

  const slots: ParsedContainer['slots'] = [];
  for (let i = 0; i < slotCount; i++) {
    const at = HEADER_FIXED_LEN + i * SLOT_LEN;
    const wrappedAt = headerLen + i * WRAPPED_LEN;
    slots.push({
      kind: bytes[at]!,
      iv: bytes.slice(at + 1, at + 1 + IV_LEN),
      wrapped: bytes.slice(wrappedAt, wrappedAt + WRAPPED_LEN),
      wrappedAt,
    });
  }
  const header = bytes.slice(0, headerLen);
  const declared = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(OFF_CHECKSUM);
  if (declared !== checksumOver(header)) {
    // Damage, not a wrong secret. Said plainly so the user stops guessing passphrases.
    return { error: 'the container header is damaged (integrity check failed)' };
  }

  const payloadIvAt = headerLen + slotCount * WRAPPED_LEN;
  return {
    header,
    salt: bytes.slice(OFF_SALT, OFF_SALT + SALT_LEN),
    iterations,
    slots,
    payloadIv: bytes.slice(payloadIvAt, payloadIvAt + IV_LEN),
    payload: bytes.slice(payloadIvAt + IV_LEN),
  };
}

/** Unwrap the file key from whichever slot the caller holds a secret for. */
async function unwrapFileKey(
  parsed: ParsedContainer,
  secrets: Secrets,
): Promise<{ status: 'ok'; fileKey: Uint8Array } | { status: 'locked' } | { status: 'corrupt'; reason: string }> {
  const aad = aadFor(parsed.header);
  for (const slot of parsed.slots) {
    const secret = secretFor(slot.kind, secrets);
    if (secret === undefined || secret.length === 0) continue;
    const kek = await deriveWrappingKey(secret, parsed.salt, parsed.iterations);
    try {
      const raw = await subtle().decrypt(
        { name: 'AES-GCM', iv: slot.iv as BufferSource, additionalData: aad as BufferSource },
        kek,
        slot.wrapped as BufferSource,
      );
      return { status: 'ok', fileKey: new Uint8Array(raw) };
    } catch {
      // Try the next slot: a caller may hold the Recovery Key but not the passphrase.
    }
  }
  // No slot opened. That is 'locked', never 'corrupt' — parse() already ruled out
  // structural damage, so the bytes are sound and it is the secret that does not fit.
  return { status: 'locked' };
}

export async function decryptContainer(bytes: Uint8Array, secrets: Secrets): Promise<DecryptResult> {
  const parsed = parse(bytes);
  if ('error' in parsed) return { status: 'corrupt', reason: parsed.error };

  const unwrapped = await unwrapFileKey(parsed, secrets);
  if (unwrapped.status !== 'ok') return unwrapped;

  const contentKey = await subtle().importKey('raw', unwrapped.fileKey as BufferSource, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  try {
    const raw = await subtle().decrypt(
      { name: 'AES-GCM', iv: parsed.payloadIv as BufferSource, additionalData: aadFor(parsed.header) as BufferSource },
      contentKey,
      parsed.payload as BufferSource,
    );
    return { status: 'ok', bytes: new Uint8Array(raw) };
  } catch {
    // The file key unwrapped, so the secret was RIGHT — the payload itself is damaged.
    return { status: 'corrupt', reason: 'the protected contents failed their integrity check' };
  }
}

/**
 * Change the passphrase by rewrapping one slot. The payload is not touched, so this
 * costs ~48 bytes of work instead of re-encrypting the whole database, and the
 * Recovery Key keeps working because it wraps the same unchanged file key (AC12).
 */
export async function rewrapPassphrase(
  bytes: Uint8Array,
  { current, next }: { current: string; next: string },
): Promise<RewrapResult> {
  if (next.length === 0) return { status: 'corrupt', reason: 'the new passphrase must not be empty' };
  const parsed = parse(bytes);
  if ('error' in parsed) return { status: 'corrupt', reason: parsed.error };

  const unwrapped = await unwrapFileKey(parsed, { passphrase: current });
  if (unwrapped.status !== 'ok') return { status: 'locked' };

  const slot = parsed.slots.find((s) => s.kind === SLOT_KIND.passphrase);
  if (slot === undefined) return { status: 'corrupt', reason: 'this container has no passphrase slot' };

  // The header is deliberately LEFT ALONE — salt, IVs and slot table all stay put. That
  // keeps the AAD (and therefore the payload's seal and the Recovery Key's slot) valid,
  // which is exactly what makes a passphrase change cost 48 bytes instead of 64 MiB and
  // lets the Recovery Key survive it (AC12). Only this one slot's wrapped key is
  // replaced, re-sealed under a key derived from the new passphrase.
  const kek = await deriveWrappingKey(next, parsed.salt, parsed.iterations);
  const sealed = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: slot.iv as BufferSource, additionalData: aadFor(parsed.header) as BufferSource },
      kek,
      unwrapped.fileKey as BufferSource,
    ),
  );
  const out = Uint8Array.from(bytes);
  out.set(sealed, slot.wrappedAt);
  return { status: 'ok', bytes: out };
}

/**
 * Re-seal NEW contents into an EXISTING container, preserving its header and every
 * slot exactly as they are — only the payload is replaced.
 *
 * This is what every write-back uses, and the reason it exists is a correctness
 * requirement rather than an optimisation. A session that unlocked with the passphrase
 * alone does not hold the Recovery Key and cannot derive it; rebuilding the container
 * from "the secrets we have" on each save would therefore drop the recovery slot and
 * strand the user the first time they forgot their passphrase — the exact failure this
 * whole feature exists to prevent (ADR-0014's named cost).
 *
 * Keeping the header identical also keeps the AAD identical, so the untouched slots
 * stay valid; only the payload IV is fresh (AC25 — never a counter, never derived).
 */
export async function resealContainer(
  container: Uint8Array,
  fileKey: Uint8Array,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const parsed = parse(container);
  if ('error' in parsed) throw new Error(`cannot re-seal: ${parsed.error}`);
  const iv = randomBytes(IV_LEN);
  const contentKey = await subtle().importKey('raw', fileKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
  const payload = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aadFor(parsed.header) as BufferSource },
      contentKey,
      bytes as BufferSource,
    ),
  );
  const headAndSlots = parsed.header.length + parsed.slots.length * WRAPPED_LEN;
  const out = new Uint8Array(headAndSlots + IV_LEN + payload.length);
  out.set(container.slice(0, headAndSlots), 0);
  out.set(iv, headAndSlots);
  out.set(payload, headAndSlots + IV_LEN);
  return out;
}

/** Unwrap just the file key, so a session can re-seal without re-deriving every save. */
export async function openFileKey(
  container: Uint8Array,
  secrets: Secrets,
): Promise<{ status: 'ok'; fileKey: Uint8Array } | { status: 'locked' } | { status: 'corrupt'; reason: string }> {
  const parsed = parse(container);
  if ('error' in parsed) return { status: 'corrupt', reason: parsed.error };
  return unwrapFileKey(parsed, secrets);
}
