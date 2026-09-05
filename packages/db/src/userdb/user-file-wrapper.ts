// user-file-wrapper.ts — `snug-user-file/1` (TASK-20260905-binding-a-artifacts AC6, ADR-0065 §5).
//
// A user file leaving a Claude artifact cannot be named `.snug`: the artifact `downloads`
// allowlist has no such extension, and `json` is on it. So the kit exports the SQLite (or
// `SNUGENC1`) bytes wrapped as `snug-user.snug.json`:
//
//   {"format":"snug-user-file/1","sha256":"<hex>","bytesBase64":"<b64>"}
//
// `format` FIRST, always — the sniff (`sniffSnugFile`, the one reader every importer
// shares) classifies the wrapper from a fixed byte prefix and never parses: a 64 MiB user
// file is an ~85 MB JSON string, and JSON.parse-to-classify is exactly the cost the sniff
// exists to avoid.
//
// TWO CHECKS ON THE WAY IN, both load-bearing. The sha proves the wrapper is self-
// consistent — but an attacker who wrote the wrapper computed that sha over bytes of THEIR
// choosing, so it proves nothing about what the bytes are. The unwrapped payload is
// therefore re-sniffed and must be a user file (`SQLite format 3\0` or `SNUGENC1`) before
// it can reach the replace-your-file confirm or `importUserFile` (plan review S4). A sha
// mismatch is `corrupt`, never "fresh" (lesson 2026-08-03/22).

import { USERDB_LIMITS } from '@snugprotocol/protocol';

import { base64ToBytes, bytesToBase64 } from '../base64.js';
import { USER_FILE_WRAPPER_FORMAT, USER_FILE_WRAPPER_PREFIX, sniffSnugFile } from './app-bundle.js';
import { USERDB_ERROR_CODES, UserDbError } from './userdb.js';

export { USER_FILE_WRAPPER_FORMAT, USER_FILE_WRAPPER_PREFIX };

/** The file name the artifact export uses everywhere (D3: the `downloads` allowlist has no `.snug`). */
export const USER_FILE_WRAPPER_FILE_NAME = 'snug-user.snug.json';

/** The wrapper text cap: the largest user file (64 MiB) as base64, plus the envelope. Checked BEFORE any parse. */
export const USER_FILE_WRAPPER_MAX_BYTES = Math.ceil((USERDB_LIMITS.MAX_USERDB_BYTES * 4) / 3) + 256;

export type UserFileUnwrap =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | { ok: false; reason: 'too-large' | 'not-json' | 'not-a-wrapper' | 'invalid' | 'corrupt' | 'not-a-user-file'; detail: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BOM = '﻿';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `slice()` hands WebCrypto a view over its own ArrayBuffer (a SharedArrayBuffer-backed
  // view is refused by the type and by the platform).
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Wrap a user file for export. Refuses anything that is not a user file by its first bytes —
 * the wrapper must never become a way to carry a bundle (or anything else) under the name
 * the import path trusts.
 */
export async function wrapUserFile(bytes: Uint8Array): Promise<string> {
  if (sniffSnugFile(bytes) !== 'user-file') {
    throw new UserDbError(USERDB_ERROR_CODES.BAD_IMPORT, 'only a Snug user file (SQLite or a protected container) can be wrapped for export');
  }
  const sha256 = await sha256Hex(bytes);
  // Insertion order IS the contract: `format` first so the prefix sniff holds.
  return JSON.stringify({ format: USER_FILE_WRAPPER_FORMAT, sha256, bytesBase64: bytesToBase64(bytes) });
}

/**
 * The one reader for wrapper text arriving from outside (a picked `.snug.json`, a pasted
 * export). Size before parse; BOM and whitespace tolerated; every refusal named; the payload
 * re-sniffed — see the module comment.
 */
export async function unwrapUserFile(text: string): Promise<UserFileUnwrap> {
  if (new TextEncoder().encode(text).length > USER_FILE_WRAPPER_MAX_BYTES) {
    return { ok: false, reason: 'too-large', detail: `the wrapper is larger than Snug accepts (${USER_FILE_WRAPPER_MAX_BYTES} bytes)` };
  }
  const trimmed = (text.startsWith(BOM) ? text.slice(1) : text).trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'not-json', detail: 'the file is not JSON' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json) || (json as { format?: unknown }).format !== USER_FILE_WRAPPER_FORMAT) {
    return { ok: false, reason: 'not-a-wrapper', detail: `the file is not a ${USER_FILE_WRAPPER_FORMAT} export` };
  }
  const { sha256, bytesBase64 } = json as { sha256?: unknown; bytesBase64?: unknown };
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256) || typeof bytesBase64 !== 'string' || bytesBase64.length === 0) {
    return { ok: false, reason: 'invalid', detail: 'the export is missing its sha256 or bytes' };
  }
  const bytes = base64ToBytes(bytesBase64); // total decoder: undefined on malformed input
  if (bytes === undefined) return { ok: false, reason: 'invalid', detail: 'the export’s bytes are not valid base64' };
  if ((await sha256Hex(bytes)) !== sha256) {
    return { ok: false, reason: 'corrupt', detail: 'the export’s bytes do not match its sha256 — the file was damaged in transit' };
  }
  if (sniffSnugFile(bytes) !== 'user-file') {
    return { ok: false, reason: 'not-a-user-file', detail: 'the export does not contain a Snug user file' };
  }
  return { ok: true, bytes, sha256 };
}
