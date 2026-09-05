// The starters index the kit build bakes in (TASK-20260905-host-kit AC14) — served by
// `src/plugins/starters-index.ts` from `starters-pkg/index.json` (the build) or from the
// test fixture (vitest). Ambient on purpose: the module has no file.
declare module 'virtual:snug-starters-index' {
  import type { StartersIndex } from './starterLoader.js';

  const index: StartersIndex;
  export default index;
}
