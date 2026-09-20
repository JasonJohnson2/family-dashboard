import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['landscape.jpg', 'icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Our Home — Family Dashboard',
        short_name: 'Our Home',
        description: 'A little less planning. A little more together.',
        theme_color: '#edf3f5',
        background_color: '#edf3f5',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,webmanifest,woff,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            // Preserve the Worker's same-origin guard when Vite forwards local/LAN requests.
            if (request.headers.origin === `http://${request.headers.host}`)
              proxyRequest.setHeader('Origin', 'http://127.0.0.1:8787');
          });
        },
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
