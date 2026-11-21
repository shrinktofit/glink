import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Node unit tests use native fs; Electron regression tests load the real built-in module.
    alias: { 'original-fs': 'node:fs' },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
