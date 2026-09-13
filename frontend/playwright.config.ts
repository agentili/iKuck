import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const localBaseURL = 'http://127.0.0.1:4173';

export const createPlaywrightConfig = (env: NodeJS.ProcessEnv = process.env): PlaywrightTestConfig => {
  const production = env.E2E_PRODUCTION === 'true';
  const suppliedBaseURL = env.E2E_BASE_URL?.trim() || undefined;
  const baseURL = suppliedBaseURL ?? localBaseURL;

  if (production && suppliedBaseURL !== undefined && new URL(suppliedBaseURL).protocol !== 'https:') {
    throw new Error('E2E_BASE_URL must use HTTPS when E2E_PRODUCTION=true');
  }

  const useLocalWebServer = suppliedBaseURL === undefined && !production;

  return {
    testDir: './e2e',
    fullyParallel: true,
    retries: 0,
    reporter: 'list',
    use: {
      baseURL,
      trace: 'retain-on-failure',
    },
    projects: [
      { name: 'mobile-chromium', testIgnore: /production-smoke\.spec\.ts/, use: { ...devices['Pixel 5'] } },
      { name: 'desktop-chromium', testIgnore: /production-smoke\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
      { name: 'production-chromium', testMatch: /production-smoke\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: useLocalWebServer ? {
      command: 'npm run build && npm run preview -- --host 127.0.0.1',
      url: localBaseURL,
      reuseExistingServer: false,
    } : undefined,
  };
};

export default defineConfig(createPlaywrightConfig());
