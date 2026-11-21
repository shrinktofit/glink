import { defineConfig } from 'vite';

// Sandboxed preload scripts need a self-contained CommonJS bundle.
export default defineConfig({
  build: {
    target: 'node22',
    lib: {
      entry: 'src/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    minify: false,
    outDir: 'lib',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: { external: ['electron'] },
  },
});
