import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Playwright specs live in e2e/ and run through `pnpm test:e2e`, never vitest.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
