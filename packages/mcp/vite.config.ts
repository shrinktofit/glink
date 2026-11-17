import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node26',
    lib: {
      entry: {
        main: 'src/main.ts',
        server: 'src/server.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    minify: false,
    outDir: 'lib',
    sourcemap: true,
    rollupOptions: {
      output: {
        banner: (chunk) => chunk.name === 'main' ? '#!/usr/bin/env node' : '',
      },
      external: [
        ...builtinModules,
        /^node:/,
        /^@modelcontextprotocol\//,
        /^@glink\/protocol\//,
        'zod',
      ],
    },
  },
});
