import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const localBaseURL = 'http://127.0.0.1:4173';

export const createPlaywrightConfig = (env: NodeJS.ProcessEnv = process.env): PlaywrightTestConfig => {
  const production = env.E2E_PRODUCTION === 'true';
  const live = env.E2E_LIVE === 'true';
  const suppliedBaseURL = env.E2E_BASE_URL?.trim() || undefined;
  const baseURL = suppliedBaseURL ?? localBaseURL;

  if (live && suppliedBaseURL === undefined) {
    throw new Error('E2E_BASE_URL is required when E2E_LIVE=true');
  }
  if (live && production) {
    throw new Error('E2E_LIVE and E2E_PRODUCTION cannot be enabled together');
  }
  if (production && suppliedBaseURL !== undefined && new URL(suppliedBaseURL).protocol !== 'https:') {
    throw new Error('E2E_BASE_URL must use HTTPS when E2E_PRODUCTION=true');
  }

  const useLocalWebServer = suppliedBaseURL === undefined && !production && !live;
  const offlineTestIgnore = /(?:production-smoke|live-stack)\.spec\.ts/;
  const offlineProjects = [
    { name: 'mobile-chromium', testIgnore: offlineTestIgnore, use: { ...devices['Pixel 5'] } },
    { name: 'desktop-chromium', testIgnore: offlineTestIgnore, use: { ...devices['Desktop Chrome'] } },
    { name: 'production-chromium', testMatch: /production-smoke\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ];

  return {
    testDir: './e2e',
    fullyParallel: true,
    retries: 0,
    forbidOnly: true,
    reporter: 'list',
    use: {
      baseURL,
      trace: 'retain-on-failure',
    },
    globalSetup: live ? './e2e/liveSetup.ts' : undefined,
    projects: live
      ? [{ name: 'live-chromium', testMatch: /live-stack\.spec\.ts/, use: { ...devices['Desktop Chrome'] } }]
      : offlineProjects,
    webServer: useLocalWebServer ? {
      command: 'npm run build && npm run preview -- --host 127.0.0.1',
      url: localBaseURL,
      reuseExistingServer: false,
    } : undefined,
  };
};

export default defineConfig(createPlaywrightConfig());
