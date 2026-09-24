/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const appVersion = process.env.npm_package_version ?? '1.0.0';

const createVersionMetadata = (version: string, rawBuildId: string | undefined) => ({
  name: 'iKuck' as const,
  version,
  buildId: rawBuildId?.trim() || 'local',
});

const resolveBuildId = (): string => {
  const configuredBuildId = process.env.VITE_BUILD_ID?.trim();
  if (configuredBuildId !== undefined && configuredBuildId.length > 0) return configuredBuildId;
  const githubSha = process.env.GITHUB_SHA?.trim();
  if (githubSha !== undefined && githubSha.length > 0) return githubSha.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() || 'local';
  } catch {
    return 'local';
  }
};

const versionMetadata = createVersionMetadata(appVersion, resolveBuildId());

const versionMetadataPlugin: Plugin = {
  name: 'ikuck-version-metadata',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: `${JSON.stringify(versionMetadata, null, 2)}\n`,
    });
  },
};

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(versionMetadata.version),
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(versionMetadata.buildId),
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
    versionMetadataPlugin,
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
            name: 'Dispensa',
            short_name: 'Dispensa',
            description: 'Gestisci ingredienti, lotti e scadenze offline.',
            url: '/pantry',
            icons: [{ src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
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
        globPatterns: ['**/*.{js,css,html,json,png,svg,woff2}'],
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
