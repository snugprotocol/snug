// The engine as bytes (TASK-20260905-host-kit P4/AC8): Vite's `?inline` hands the kit a
// `data:` URL; `decodeWasmDataUrl` strips the prefix and decodes ONCE, and the bytes it
// returns must start with the wasm magic `\0asm` — checked against the real sql.js file.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { WASM_MAGIC, decodeWasmDataUrl } from '../wasm.js';

const require = createRequire(import.meta.url);
const realWasm = new Uint8Array(readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')));

describe('decodeWasmDataUrl', () => {
  it('decodes the real sql.js engine byte-for-byte from a base64 data URL', () => {
    const dataUrl = `data:application/wasm;base64,${Buffer.from(realWasm).toString('base64')}`;
    const bytes = decodeWasmDataUrl(dataUrl);
    expect(bytes.length).toBe(realWasm.length);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(realWasm))).toBe(0);
    expect([...bytes.subarray(0, 4)]).toEqual(WASM_MAGIC);
  });

  it('accepts any mime in the prefix (Vite may emit application/octet-stream) but insists on base64', () => {
    const b64 = Buffer.from(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])).toString('base64');
    expect([...decodeWasmDataUrl(`data:application/octet-stream;base64,${b64}`).subarray(0, 4)]).toEqual(WASM_MAGIC);
    expect(() => decodeWasmDataUrl(`data:application/wasm,${b64}`)).toThrow(/base64/);
  });

  it('refuses bytes that are not a wasm module (a wrong asset inlined by mistake must fail the build, not the user)', () => {
    const notWasm = Buffer.from('<!doctype html>').toString('base64');
    expect(() => decodeWasmDataUrl(`data:text/html;base64,${notWasm}`)).toThrow(/\\0asm|wasm magic/);
  });

  it('refuses a non-data URL — a bundler that emitted a file path instead of bytes is the very failure P4 exists to prevent', () => {
    expect(() => decodeWasmDataUrl('./assets/sql-wasm-abc123.wasm')).toThrow(/data: URL/);
  });
});

describe('the bundled bytes module', () => {
  it('sqlJsWasmBinary() returns the real engine, decoded once (same instance on the second call)', async () => {
    const { sqlJsWasmBinary } = await import('../wasmBytes.js');
    const first = sqlJsWasmBinary();
    expect([...first.subarray(0, 4)]).toEqual(WASM_MAGIC);
    expect(first.length).toBe(realWasm.length);
    expect(sqlJsWasmBinary()).toBe(first);
  });
});
