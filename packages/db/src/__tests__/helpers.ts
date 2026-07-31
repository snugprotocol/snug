// Shared helpers for db driver tests: a node wasm locator for sql.js (vitest runs in
// node — the browser default resolution cannot see node_modules) and typed db-request
// frame builders mirroring what the runner host forwards to the driver.
import { createRequire } from 'node:module';
import { FRAME_TYPES, PROTOCOL_VERSION, type DbRequestFrame } from '@snugprotocol/protocol';

const require = createRequire(import.meta.url);

/** Injectable wasm locator pointing at the installed sql.js wasm asset (AC-8). */
export const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

let seq = 0;
const base = () => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.dbRequest,
  requestId: `req-${++seq}`,
  instanceId: 'ins-test',
});

export const execFrame = (sql: string, params?: unknown[]): DbRequestFrame => ({
  ...base(),
  op: 'exec',
  sql,
  ...(params !== undefined ? { params } : {}),
});

export const exportFrame = (): DbRequestFrame => ({ ...base(), op: 'export' });

export const importFrame = (bytesBase64: string): DbRequestFrame => ({ ...base(), op: 'import', bytesBase64 });

export const kvGetFrame = (key: string): DbRequestFrame => ({ ...base(), op: 'kvGet', key });

export const kvSetFrame = (key: string, value: unknown): DbRequestFrame => ({ ...base(), op: 'kvSet', key, value });

/** The 16-byte SQLite file header prefix: "SQLite format 3" + NUL. */
export const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);

export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
