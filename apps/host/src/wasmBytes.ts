// wasmBytes.ts — the ONE import of the engine asset (TASK-20260905-host-kit P4). Kept in
// its own module so `wasm.ts` (the decoder) stays importable without a bundler. Decoded
// once; the same instance is handed to the platform and read by both sql.js callers.

import wasmDataUrl from 'sql.js/dist/sql-wasm.wasm?inline';

import { decodeWasmDataUrl } from './wasm.js';

let cached: Uint8Array | undefined;

export function sqlJsWasmBinary(): Uint8Array {
  return (cached ??= decodeWasmDataUrl(wasmDataUrl));
}
