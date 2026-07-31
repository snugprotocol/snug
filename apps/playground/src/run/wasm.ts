// wasm.ts — the bundler-resolved sql.js wasm asset. Isolated in its own module so
// unit tests can inject a node locator instead of importing a ?url asset.

import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

export const locateWasm = (): string => wasmUrl;
