import { defineConfig, devices } from '@playwright/test';
import { loadMealPlanLiveTarget } from './e2e/helpers/mealPlanLiveServer.mjs';

// Reject missing or non-isolated provisioner output before starting the API build/server.
loadMealPlanLiveTarget(process.env);

export default defineConfig({
  testDir: './e2e',
  testMatch: /meal-plan-live-stack\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', serviceWorkers: 'block', trace: 'retain-on-failure' },
  projects: [{ name: 'meal-plan-postgres-chromium', use: { ...devices['Pixel 5'] } }],
  webServer: [
    { command: 'npm --prefix ../backend run build && node e2e/helpers/mealPlanLiveServer.mjs',
      url: 'http://127.0.0.1:3000/healthz', reuseExistingServer: false, timeout: 120000 },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173', reuseExistingServer: false,
      env: { VITE_SOUS_CHEF: 'true' } },
  ],
});
