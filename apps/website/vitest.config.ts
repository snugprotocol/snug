import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@playground': fileURLToPath(new URL('../playground/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.{ts,mts}', 'src/**/*.test.{ts,mts}'],
  },
});
