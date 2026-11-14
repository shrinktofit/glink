import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node26',
    lib: {
      entry: {
        main: 'src/main.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    minify: false,
    outDir: 'lib',
    sourcemap: true,
    rollupOptions: {
      external: [
        ...builtinModules,
        /^node:/,
        /^@glink\/protocol\//,
      ],
    },
  },
});
