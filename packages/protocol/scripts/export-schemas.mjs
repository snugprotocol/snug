// Regenerates schemas/*.json from the built package. Run via `pnpm gen:schemas`
// (which builds first). CI verifies with `git diff --exit-code -- schemas`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemas } from '../dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'schemas');
mkdirSync(dir, { recursive: true });
for (const stale of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  rmSync(join(dir, stale));
}
const schemas = buildJsonSchemas();
for (const [name, text] of Object.entries(schemas)) {
  writeFileSync(join(dir, name), text);
}
console.log(`wrote ${Object.keys(schemas).length} schemas to ${dir}`);
