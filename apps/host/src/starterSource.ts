// starterSource.ts — what the playground's `starter/starterSource.ts` BECOMES in the kit
// build (TASK-20260905-host-kit AC14): the same interface, the on-demand implementation,
// over the index the build baked in. The swap is a build-time alias of the resolved module
// (`vite.config.ts`, `swapResolved`) because `import.meta.glob` is build-time and the
// single-file build inlines every lazy chunk — a runtime seat could not keep the starter
// bytes out of the page.

import index from 'virtual:snug-starters-index';

import type { ConnectionRequirement } from '@snugprotocol/protocol';

import { parseStarterRequirement } from '@playground/starter/starterRequirement';
import type { StarterSource } from '@playground/starter/starterSource';

import { createStarterSource, domScriptHost, type StartersIndex } from './starterLoader.js';

export type { StarterAuthoringBundle, StarterSource } from '@playground/starter/starterSource';

/**
 * `StarterSource.requirement()` over the baked index (TASK-20261003 S2, ADR-0072 §4):
 * SYNCHRONOUS, from the manifest the index already carries inline, so the shelf disables a
 * starter this host cannot run at first paint — and under an artifact that is every
 * connected one. A tile that flipped after a script load would be clickable for exactly as
 * long as the network took.
 *
 * The parse is the playground's own (`starterRequirement.ts`, one home), so a starter reads
 * the same on web and in the kit; each folder is parsed once, on first ask. It lives here
 * rather than in `starterLoader.ts` because that file is loaded by the Vite config, before
 * the `@playground` alias exists.
 */
export function requirementsOf(startersIndex: StartersIndex): StarterSource['requirement'] {
  const parsed = new Map<string, ConnectionRequirement | undefined>();
  return (folder) => {
    if (!parsed.has(folder)) parsed.set(folder, parseStarterRequirement(startersIndex.starters[folder]?.inline.manifest));
    return parsed.get(folder);
  };
}

let cached: StarterSource | undefined;

export function starterSource(): StarterSource {
  return (cached ??= {
    ...createStarterSource(index, {
      scripts: domScriptHost(document),
      registry: window as unknown as Record<string, unknown>,
    }),
    requirement: requirementsOf(index),
  });
}
