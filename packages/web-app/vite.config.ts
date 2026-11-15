import { ServerResponse } from 'node:http';
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
    host: '0.0.0.0',
    allowedHosts: ['ques.tailca5ab3.ts.net'],
    port: 4311,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('error', (_error, _request, response) => {
            if (
              response instanceof ServerResponse
              && !response.headersSent
              && !response.writableEnded
            ) {
              response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
                .end(JSON.stringify({ error: 'Glink 后端服务暂不可用，请稍后重试。' }));
            }
          });
        },
      },
    },
  },
});
