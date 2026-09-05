import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { startersIndexPlugin } from './src/plugins/starters-index.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  // The same virtual module the kit build reads, pointed at a FIXTURE index: the kit's
  // `starterSource.ts` is testable without a starters package build.
  plugins: [startersIndexPlugin(here('./src/__tests__/fixtures/starters-index.json'))],
  // As in vite.config.ts: `.wasm` is not a Vite asset type by default; `?inline` needs it to be.
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: {
      '@playground': here('../playground/src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
  },
});
