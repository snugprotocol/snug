// starters-index.ts — the virtual module that bakes `starters-pkg/index.json` into the
// kit (TASK-20260905-host-kit AC14): the package version + the sha384 of every wrapper +
// the inline card metadata. The JSON is emitted with every `<` escaped (`<`) so the
// inlined page can never contain `</script` or `<!--` by way of a starter's own bytes —
// the inliner refuses both, and this is what keeps the refusal from firing on a correct
// build. A missing or malformed index REFUSES: a kit built without the starters package
// would ship a shelf that cannot load anything.

import { existsSync, readFileSync } from 'node:fs';

import type { Plugin } from 'vite';

import { STARTERS_INDEX_FORMAT } from '../starterLoader.js';

export const STARTERS_INDEX_MODULE = 'virtual:snug-starters-index';
const RESOLVED_ID = `\0${STARTERS_INDEX_MODULE}`;

/** JSON text → JS-safe text with no `<` at all (still valid JSON). Twin of the script's `escapeForInlineScript`. */
export function escapeForInlineScript(json: string): string {
  return json.replace(/</g, '\\u003c');
}

export function startersIndexPlugin(indexPath: string): Plugin {
  return {
    name: 'snug-host:starters-index',
    resolveId(id) {
      return id === STARTERS_INDEX_MODULE ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      if (!existsSync(indexPath)) {
        throw new Error(`starters index not found at ${indexPath} — run \`pnpm --filter host build:starters\` first`);
      }
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { format?: unknown; starters?: unknown };
      if (parsed.format !== STARTERS_INDEX_FORMAT) {
        throw new Error(`starters index at ${indexPath}: format ${String(parsed.format)} is not ${STARTERS_INDEX_FORMAT}`);
      }
      if (typeof parsed.starters !== 'object' || parsed.starters === null) {
        throw new Error(`starters index at ${indexPath}: no starters table`);
      }
      return `export default ${escapeForInlineScript(JSON.stringify(parsed))};\n`;
    },
  };
}
