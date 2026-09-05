// swap-resolved.ts — replace a module by its RESOLVED path (TASK-20260905-host-kit P5/AC14).
// A bare `resolve.alias` matches import specifiers, and the modules the kit swaps out are
// imported by RELATIVE specifier from inside the playground (`./starterSource.js`,
// `./wasm.js`) — a specifier alias would either miss them or catch unrelated files with the
// same basename. So this resolves the import the ordinary way first and swaps on the exact
// absolute id. A swap that is never hit is a DEAD swap and fails the build: the bytes it
// was meant to keep out would be in the page, and only a size ceiling would notice.

import type { Plugin } from 'vite';

export function swapResolved(table: Record<string, string>): Plugin {
  const hits = new Map<string, number>(Object.keys(table).map((key) => [key, 0]));
  return {
    name: 'snug-host:swap-resolved',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) return null;
      const target = table[resolved.id];
      if (target === undefined) return null;
      hits.set(resolved.id, (hits.get(resolved.id) ?? 0) + 1);
      return target;
    },
    buildEnd() {
      for (const [key, count] of hits) {
        if (count === 0) this.error(`swap-resolved: ${key} was never imported — the swap is dead and its bytes are in the page`);
      }
    },
  };
}
