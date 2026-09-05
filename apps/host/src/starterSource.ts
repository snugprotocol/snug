// starterSource.ts — what the playground's `starter/starterSource.ts` BECOMES in the kit
// build (TASK-20260905-host-kit AC14): the same interface, the on-demand implementation,
// over the index the build baked in. The swap is a build-time alias of the resolved module
// (`vite.config.ts`, `swapResolved`) because `import.meta.glob` is build-time and the
// single-file build inlines every lazy chunk — a runtime seat could not keep the starter
// bytes out of the page.

import index from 'virtual:snug-starters-index';

import type { StarterSource } from '@playground/starter/starterSource';

import { createStarterSource, domScriptHost } from './starterLoader.js';

export type { StarterAuthoringBundle, StarterSource } from '@playground/starter/starterSource';

let cached: StarterSource | undefined;

export function starterSource(): StarterSource {
  return (cached ??= createStarterSource(index, {
    scripts: domScriptHost(document),
    registry: window as unknown as Record<string, unknown>,
  }));
}
