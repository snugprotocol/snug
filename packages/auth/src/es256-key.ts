/**
 * ES256 private-key import for the `cdp_jwt` template helper (ADR-0022 §2, P0
 * amendment 4).
 *
 * WHY THIS MODULE EXISTS. CDP EC keys download as SEC1 (`BEGIN EC PRIVATE KEY`) PEM,
 * and WebCrypto's `importKey` accepts ONLY PKCS#8 for private keys — probe-verified at
 * P0: SEC1 bytes throw DataError on every runtime. So this module DER-wraps SEC1 into a
 * PKCS#8 PrivateKeyInfo (AlgorithmIdentifier id-ecPublicKey + prime256v1) and accepts
 * genuine PKCS#8 (`BEGIN PRIVATE KEY`) as a passthrough.
 *
 * HONEST TYPED ERRORS, NEVER SILENCE (amendments 4/9). Every failure names what went
 * wrong and — where the user can act — the fix ("generate an EC (ES256) key in the CDP
 * portal" for Ed25519 keys). No error message ever carries key bytes or pasted content
 * (C5): the pasted text is a PRIVATE KEY, so echoing "context" would log the secret.
 *
 * NATIVE WebCrypto ECDSA is REQUIRED. The desktop subtle-fallback implements HMAC only,
 * so a missing/refusing `crypto.subtle` surfaces the honest runtime error instead of a
 * silent failure or a downlevel signature.
 */

import { base64ToBytes } from './base64url.js';

/** Typed import failure — the template engine re-wraps it as AuthTemplateError. */
export class CdpKeyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpKeyImportError';
  }
}

const SEC1_HEADER = 'BEGIN EC PRIVATE KEY';
const PKCS8_HEADER = 'BEGIN PRIVATE KEY';

/** DER OID id-Ed25519 (1.3.101.112) as it appears inside a PKCS#8 AlgorithmIdentifier. */
const ED25519_OID = [0x06, 0x03, 0x2b, 0x65, 0x70];

/**
 * AlgorithmIdentifier ::= SEQUENCE { id-ecPublicKey (1.2.840.10045.2.1),
 * prime256v1 (1.2.840.10045.3.1.7) } — fixed bytes; P-256 is the only curve at v1.
 */
const EC_P256_ALGORITHM_IDENTIFIER = [
  0x30, 0x13, // SEQUENCE, 19 bytes
  0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID id-ecPublicKey
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
];

/** Definite-form DER length octets. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * Wrap a SEC1 ECPrivateKey into PKCS#8 PrivateKeyInfo:
 * SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING <sec1 bytes> }.
 * The SEC1 bytes ride inside the OCTET STRING unmodified — RFC 5915 says the inner
 * curve parameters SHOULD be omitted once the AlgorithmIdentifier carries them, but
 * every WebCrypto implementation accepts them present, and NOT rewriting the key bytes
 * means there is no second parser here to get wrong.
 */
function wrapSec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const octetStringHeader = [0x04, ...derLength(sec1.length)];
  const contentLength = version.length + EC_P256_ALGORITHM_IDENTIFIER.length + octetStringHeader.length + sec1.length;
  return new Uint8Array([0x30, ...derLength(contentLength), ...version, ...EC_P256_ALGORITHM_IDENTIFIER, ...octetStringHeader, ...sec1]);
}

/**
 * Normalize a pasted PEM: literal `\n` escape sequences (the shape a key takes after
 * riding a JSON string) become newlines, and surrounding whitespace is dropped. The
 * base64 body is then whitespace-stripped separately, so indented paste artifacts
 * inside the body are harmless too.
 */
function normalizePem(raw: string): string {
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

/** Scan the leading bytes of a PKCS#8 blob for the Ed25519 AlgorithmIdentifier OID. */
function isEd25519Pkcs8(pkcs8: Uint8Array): boolean {
  const limit = Math.min(pkcs8.length, 32) - ED25519_OID.length;
  for (let offset = 0; offset <= limit; offset++) {
    if (ED25519_OID.every((byte, index) => pkcs8[offset + index] === byte)) return true;
  }
  return false;
}

/**
 * Import an ES256 (EC P-256) private key from a pasted PEM, accepting BOTH the SEC1
 * download shape and PKCS#8. Returns a non-extractable signing key.
 */
export async function importEs256PrivateKey(rawPem: string): Promise<CryptoKey> {
  const pem = normalizePem(rawPem);

  let pkcs8: Uint8Array;
  if (pem.includes(SEC1_HEADER)) {
    pkcs8 = wrapSec1ToPkcs8(pemBody(pem, SEC1_HEADER));
  } else if (pem.includes(PKCS8_HEADER)) {
    pkcs8 = pemBody(pem, PKCS8_HEADER);
    if (isEd25519Pkcs8(pkcs8)) {
      throw new CdpKeyImportError(
        'this is an Ed25519 private key — cdp_jwt signs ES256 only; generate an EC (ES256) key in the CDP portal and paste that instead',
      );
    }
  } else {
    throw new CdpKeyImportError(
      'the private key is not a recognizable PEM — expected a BEGIN EC PRIVATE KEY or BEGIN PRIVATE KEY block as downloaded from the CDP portal',
    );
  }

  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    throw new CdpKeyImportError(
      'WebCrypto ECDSA (ES256) is not available in this runtime — cdp_jwt cannot mint a CDP JWT here',
    );
  }

  try {
    return await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
    ]);
  } catch (err) {
    if (err instanceof Error && err.name === 'NotSupportedError') {
      throw new CdpKeyImportError(
        'this runtime does not implement WebCrypto ECDSA (ES256) — cdp_jwt cannot mint a CDP JWT here',
      );
    }
    throw new CdpKeyImportError(
      'the private key could not be imported as an EC P-256 (ES256) key — generate an EC (ES256) key in the CDP portal and paste the downloaded PEM',
    );
  }
}
