// sqlJsEngine.ts — the ONE seat both sql.js callers read for the engine source
// (TASK-20260905-host-kit P4 / AC8). The bundler-resolved locator is today's path; the
// host kit adds the engine AS BYTES through `platform.sqlJsWasmBinary`, because inside an
// artifact viewer `connect-src 'self'` blocks the wasm fetch the locator would trigger.
// `@snugprotocol/db` makes the bytes win over the locator at both of its initSqlJs sites
// (`sqlJsInitConfig`), and sql.js memoizes its FIRST initialisation, so the user-db boot —
// the first caller — must be handed these options; the RunView ephemeral driver reads the
// same seat so an unowned starter never boots the engine a second way.
//
// Absent seat → `{ locateWasm }` alone: web and desktop are byte-identical to before.

import type { SqlJsEngineOptions } from '@snugprotocol/db';

import { getPlatform } from '../platform/platform.js';
import { locateWasm } from './wasm.js';

export function sqlJsEngineOptions(): SqlJsEngineOptions {
  const wasmBinary = getPlatform().sqlJsWasmBinary;
  return { locateWasm, ...(wasmBinary !== undefined ? { wasmBinary } : {}) };
}
