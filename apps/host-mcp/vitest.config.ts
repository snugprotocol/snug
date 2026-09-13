// Vitest for the process's pure modules. `?raw` imports (the instructions text) need the
// same treatment the build gives them, so the config is shared rather than restated.
import { defineConfig } from 'vite';

export default defineConfig({
  test: { include: ['src/**/__tests__/**/*.test.ts'], environment: 'node' },
});
