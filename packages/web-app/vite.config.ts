import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify';

export default defineConfig({
  plugins: [
    vue({
      template: {
        transformAssetUrls,
      },
    }),
    vuetify({ autoImport: true }),
  ],
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4310',
    },
  },
});
