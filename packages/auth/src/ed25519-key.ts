/**
 * Ed25519 private-key import for the `cdp_jwt` template helper (ADR-0030, superseding
 * ADR-0022 §2's ES256-only clause and es256-key.ts).
 *
 * WHY THIS MODULE EXISTS. Ed25519 is the CDP portal's default and recommended key type
 * (ECDSA is Coinbase's documented legacy); its secret is delivered as base64 — 64 bytes
 * of seed‖pubkey — or as a PKCS#8 PEM file. WebCrypto imports Ed25519 private keys as
 * PKCS#8 only, so every accepted shape is CANONICALIZED to the 32-byte seed and
 * re-wrapped by this module in the fixed RFC 8410 PKCS#8 prefix. Detection is ARMOR
 * FIRST: a `-----BEGIN` paste is judged as a PEM before any base64 decoding, so a
 * legacy EC key earns its fix-naming error instead of a "not valid base64" misdiagnosis.
 *
 * HONEST TYPED ERRORS, NEVER SILENCE. Every failure names what went wrong and — where
 * the user can act — the fix ("create an Ed25519 API key in the CDP portal" for legacy
 * EC keys). No error message ever carries key bytes or pasted content (C5): the pasted
 * text is a PRIVATE KEY, so echoing "context" would log the secret.
 *
 * THE RUNTIME RULE IS TOTAL (ADR-0030 §3). Because the imported blob is constructed
 * HERE from a length-validated seed, any `importKey` failure after validation is a
 * runtime failure, whatever error shape the runtime throws — the desktop
 * subtle-fallback throws a plain `Error` (HMAC only), not `NotSupportedError`, and an
 * error-name allowlist would tell that user to re-create a perfectly valid key.
 */

import { base64ToBytes } from './base64url.js';

/** Typed import failure — the template engine re-wraps it as AuthTemplateError. */
export class CdpKeyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpKeyImportError';
  }
}

const PKCS8_HEADER = 'BEGIN PRIVATE KEY';
const SEC1_HEADER = 'BEGIN EC PRIVATE KEY';

/**
 * RFC 8410 PKCS#8 PrivateKeyInfo prefix for Ed25519: SEQUENCE(46) { INTEGER 0,
 * SEQUENCE(5){ OID 1.3.101.112 }, OCTET STRING(34){ OCTET STRING(32){ <seed> } } }.
 * Prefix + seed IS the minimal 48-byte encoding — no DER library needed.
 */
const ED25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/** DER OID id-Ed25519 (1.3.101.112) as it appears inside an AlgorithmIdentifier. */
const ED25519_OID = [0x06, 0x03, 0x2b, 0x65, 0x70];

/** DER OID id-ecPublicKey (1.2.840.10045.2.1) — the EC marker in PKCS#8 keys. */
const EC_PUBLIC_KEY_OID = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];

/**
 * DER OID prime256v1 (1.2.840.10045.3.1.7) — the EC marker in SEC1 keys. A SEC1
 * ECPrivateKey DER carries ONLY the curve OID, never id-ecPublicKey (byte-verified
 * against the legacy CDP download fixture at review), so an armorless SEC1 paste
 * needs this second pattern or it would misdiagnose as a wrong-length error.
 */
const EC_P256_CURVE_OID = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

/** OCTET STRING(34){ OCTET STRING(32) } — the tag run that immediately precedes the seed. */
const SEED_TAG_RUN = [0x04, 0x22, 0x04, 0x20];

const EC_LEGACY_ERROR =
  "this is an EC (ECDSA) private key — Coinbase's legacy key type. Create an Ed25519 API key in the CDP portal and paste its secret instead";

/**
 * The one honest runtime-absence sentence — exported so the template engine's sign
 * catch reuses THIS string instead of retyping it (one owner, no drift).
 */
export const ED25519_RUNTIME_ERROR =
  'this runtime does not implement WebCrypto Ed25519 — cdp_jwt cannot mint a CDP JWT here';

function findPattern(haystack: Uint8Array, pattern: readonly number[]): number {
  const limit = haystack.length - pattern.length;
  for (let offset = 0; offset <= limit; offset++) {
    if (pattern.every((byte, index) => haystack[offset + index] === byte)) return offset;
  }
  return -1;
}

/**
 * Normalize a pasted PEM: literal `\n` escape sequences (the shape a key takes after
 * riding a JSON string) become newlines, and surrounding whitespace is dropped.
 */
function normalizePaste(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim();
}

/** Extract and decode the base64 body between BEGIN/END lines. Throws CdpKeyImportError. */
function pemBody(pem: string, header: string): Uint8Array {
  const withoutArmor = pem
    .replace(`-----${header}-----`, '')
    .replace(`-----${header.replace('BEGIN', 'END')}-----`, '')
    .replace(/\s+/g, '');
  try {
    return base64ToBytes(withoutArmor);
  } catch {
    // Deliberately names no content: the pasted text is a private key (C5).
    throw new CdpKeyImportError('the private key PEM body is not valid base64 — re-paste the key file exactly as downloaded');
  }
}

/**
 * Pull the 32-byte seed out of a DER blob already established to carry the Ed25519
 * OID. Tolerates the non-minimal RFC 8410 forms (attributes / embedded public key):
 * the seed always sits directly after the OCTET STRING(34){OCTET STRING(32)} tag run.
 */
function seedFromDer(der: Uint8Array): Uint8Array {
  const at = findPattern(der, SEED_TAG_RUN);
  if (at === -1 || der.length < at + SEED_TAG_RUN.length + 32) {
    throw new CdpKeyImportError(
      'the private key file is not a recognizable Ed25519 PKCS#8 key — re-download the key from the CDP portal and paste it whole',
    );
  }
  return der.subarray(at + SEED_TAG_RUN.length, at + SEED_TAG_RUN.length + 32);
}

/** The armored (PEM) branch of the shape detection. */
function seedFromPem(pem: string): Uint8Array {
  if (pem.includes(SEC1_HEADER)) {
    // Armor-first on purpose: the legacy CDP download must hit THIS error, never fall
    // through to a base64 misdiagnosis (ADR-0030 §2).
    throw new CdpKeyImportError(EC_LEGACY_ERROR);
  }
  if (!pem.includes(PKCS8_HEADER)) {
    throw new CdpKeyImportError(
      'the pasted text is not a recognizable private key PEM — expected the BEGIN PRIVATE KEY block from the key file the CDP portal delivered',
    );
  }
  const der = pemBody(pem, PKCS8_HEADER);
  if (findPattern(der, EC_PUBLIC_KEY_OID) !== -1) throw new CdpKeyImportError(EC_LEGACY_ERROR);
  if (findPattern(der, ED25519_OID) === -1) {
    throw new CdpKeyImportError(
      'the private key is not an Ed25519 key — create an Ed25519 API key in the CDP portal and paste its secret',
    );
  }
  return seedFromDer(der);
}

/** The armorless (base64) branch: portal secret shapes, whitespace-normalized. */
function seedFromBase64(paste: string): Uint8Array {
  const compact = paste.replace(/\s+/g, '');
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(compact);
  } catch {
    // Covers the base64url alphabet too — a deliberate typed rejection, not a silent
    // second decoder: the portal only ever delivers STANDARD base64 (ADR-0030 §2).
    throw new CdpKeyImportError(
      'the pasted secret is not standard base64 — paste the API key secret exactly as the CDP portal delivered it',
    );
  }
  if (bytes.length === 64 || bytes.length === 32) {
    // 64 = seed‖pubkey (the portal download); 32 = bare seed. The first 32 bytes sign.
    return bytes.subarray(0, 32);
  }
  if (
    bytes[0] === 0x30 &&
    (findPattern(bytes, EC_PUBLIC_KEY_OID) !== -1 || findPattern(bytes, EC_P256_CURVE_OID) !== -1)
  ) {
    // BOTH EC encodings: an armorless PKCS#8 body carries id-ecPublicKey, an armorless
    // SEC1 body carries only the curve OID — either one is the legacy key type and
    // must earn the fix-naming error, never the wrong-length misdiagnosis.
    throw new CdpKeyImportError(EC_LEGACY_ERROR);
  }
  if (bytes[0] === 0x30 && findPattern(bytes, ED25519_OID) !== -1) {
    // A PEM body pasted without its BEGIN/END lines — the whole DER, base64'd.
    return seedFromDer(bytes);
  }
  throw new CdpKeyImportError(
    `the decoded secret is ${bytes.length} bytes — expected the 64-byte API key secret (or 32-byte seed) from the CDP portal; if you pasted from the key PEM file, include the BEGIN/END lines`,
  );
}

/**
 * Import an Ed25519 private key from any shape the CDP portal has delivered: PKCS#8
 * PEM, base64 64-byte seed‖pubkey, base64 32-byte seed, or an armorless PEM-body
 * paste. Returns a non-extractable signing key.
 */
export async function importEd25519PrivateKey(raw: string): Promise<CryptoKey> {
  const paste = normalizePaste(raw);
  const seed = paste.includes('-----BEGIN') ? seedFromPem(paste) : seedFromBase64(paste);

  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    throw new CdpKeyImportError(ED25519_RUNTIME_ERROR);
  }

  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

  try {
    return await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'Ed25519' }, false, ['sign']);
  } catch {
    // TOTAL by design (ADR-0030 §3): the blob was constructed above from a validated
    // seed, so the failure cannot be the user's key — naming any other cause would
    // send the user to re-create a valid credential. No error-name allowlist: the
    // desktop subtle-fallback throws a plain Error, not NotSupportedError.
    throw new CdpKeyImportError(ED25519_RUNTIME_ERROR);
  }
}
