import { fileURLToPath } from 'node:url';
import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  outDir: fileURLToPath(new URL('./.pkg', import.meta.url)),
  packagerConfig: {
    name: 'Glink',
    executableName: 'Glink',
    appBundleId: 'dev.glink.app',
    icon: fileURLToPath(new URL('./assets/icon.ico', import.meta.url)),
    asar: true,
    // Vite bundles runtime dependencies; include only the app's runtime files.
    prune: false,
    ignore: (path: string) => Boolean(path)
      && path !== '/package.json'
      && path !== '/index.ts'
      && path !== '/lib'
      && !path.startsWith('/lib/')
      && path !== '/assets'
      && !path.startsWith('/assets/'),
  },
};

export default config;
