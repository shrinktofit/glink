import { cp } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = join(root, 'lib');

export default defineConfig({
  plugins: [{
    name: 'glink-app-resources',
    async closeBundle() {
      await cp(join(root, '../web-app/dist'), join(output, 'web'), { recursive: true });
    },
  }],
  build: {
    target: 'node22',
    lib: {
      entry: { main: 'src/main.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    minify: false,
    outDir: 'lib',
    sourcemap: true,
    rollupOptions: {
      external: [
        'electron',
        'original-fs',
        ...builtinModules,
        /^node:/,
      ],
    },
  },
});
