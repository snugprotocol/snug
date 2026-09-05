// wasm.ts — the sql.js engine as bytes (TASK-20260905-host-kit P4/AC8). Vite's `?inline`
// import hands the kit a `data:` URL; this decodes it ONCE into the `Uint8Array` that
// `platform.sqlJsWasmBinary` carries to both `initSqlJs` sites. A `data:` URL through
// `locateFile` is NOT an option: Emscripten fetches whatever the locator returns, and the
// hosted artifact viewer's `connect-src 'self'` blocks that fetch (T1 S1).
//
// The decoder REFUSES anything that is not a base64 data URL of a wasm module. Each
// refusal names a build defect (a bundler that emitted a file path, an asset inlined by
// the wrong rule) that must fail the build, never surface as "your file couldn't be read".

import { base64ToBytes } from '@snugprotocol/db';

/** `\0asm` — the wasm binary magic. */
export const WASM_MAGIC: readonly number[] = [0x00, 0x61, 0x73, 0x6d];

export function decodeWasmDataUrl(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith('data:')) {
    throw new Error(`sql.js engine: expected a data: URL from Vite's ?inline import, got "${dataUrl.slice(0, 48)}"`);
  }
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('sql.js engine: malformed data: URL (no payload)');
  const header = dataUrl.slice('data:'.length, comma);
  if (!header.endsWith(';base64')) {
    throw new Error(`sql.js engine: the data: URL must be base64 (header "${header}")`);
  }
  const bytes = base64ToBytes(dataUrl.slice(comma + 1));
  if (bytes === undefined) throw new Error('sql.js engine: the data: URL payload is not valid base64');
  for (let i = 0; i < WASM_MAGIC.length; i++) {
    if (bytes[i] !== WASM_MAGIC[i]) {
      throw new Error('sql.js engine: the inlined bytes do not start with the wasm magic (\\0asm) — the wrong asset was inlined');
    }
  }
  return bytes;
}
