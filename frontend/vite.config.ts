/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(process.env.VITE_BUILD_ID ?? 'local'),
  },
  server: {
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      injectRegister: null,
      registerType: 'prompt',
      strategies: 'generateSW',
      includeAssets: [
        'icons/icon-192x192.png',
        'icons/icon-512x512.png',
        'icons/maskable-icon-192x192.png',
        'icons/maskable-icon-512x512.png',
      ],
      manifest: {
        name: 'iKuck',
        short_name: 'iKuck',
        description: 'Ricette semplici basate sugli ingredienti della tua dispensa.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        theme_color: '#247A4A',
        background_color: '#FAFBF7',
        lang: 'it',
        categories: ['food', 'lifestyle'],
        shortcuts: [
          {
            name: 'Lista della spesa',
            short_name: 'Spesa',
            description: 'Apri la lista della spesa offline.',
            url: '/shopping-list',
            icons: [{ src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Attività',
            short_name: 'Attività',
            description: 'Apri ricette cucinate e preferiti.',
            url: '/activity',
            icons: [{ src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
        icons: [
          {
            src: 'icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/maskable-icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icons/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
