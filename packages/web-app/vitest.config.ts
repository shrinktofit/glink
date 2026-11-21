import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    // Component tests use the browser environment's storage, not Node's file-backed storage.
    execArgv: ['--no-experimental-webstorage'],
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
