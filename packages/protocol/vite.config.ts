import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: {
        health: 'src/health.ts',
        git: 'src/git.ts',
        workspace: 'src/workspace.ts',
        tools: 'src/tools.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    minify: false,
    outDir: 'lib',
    sourcemap: true,
    rollupOptions: {
      external: ['zod'],
    },
  },
});
