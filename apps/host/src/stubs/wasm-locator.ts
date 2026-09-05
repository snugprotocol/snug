// The kit's `run/wasm.ts` (TASK-20260905-host-kit P4/AC8): the playground's locator imports
// the engine as a `?url` asset; in the kit the engine rides as bytes through
// `platform.sqlJsWasmBinary`, which `sqlJsInitConfig` prefers at both `initSqlJs` sites,
// so the locator is never called — and the asset must not be emitted (nor inlined a second
// time as a data URL). Reaching this is a wiring defect; it says so.

export const locateWasm = (): string => {
  throw new Error('the host kit carries sql.js as bytes — locateWasm must never run (TASK-20260905-host-kit P4)');
};
