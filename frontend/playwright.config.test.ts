import { describe, expect, it } from 'vitest';
import { createPlaywrightConfig } from './playwright.config';

describe('Playwright execution profiles', () => {
  it('uses the supplied HTTPS target without a local web server in production mode', () => {
    const config = createPlaywrightConfig({
      E2E_BASE_URL: 'https://staging.example.test',
      E2E_PRODUCTION: 'true',
    });

    expect(config.use?.baseURL).toBe('https://staging.example.test');
    expect(config.webServer).toBeUndefined();
    expect(config.projects?.[0].testIgnore).toEqual(/(?:production-smoke|live-stack|pwa-update|accessibility)\.spec\.ts/);
  });

  it('rejects an HTTP target when production mode is enabled', () => {
    expect(() => createPlaywrightConfig({
      E2E_BASE_URL: 'http://staging.example.test',
      E2E_PRODUCTION: 'true',
    })).toThrow(/HTTPS/);
  });

  it('keeps the local preview server on port 4173 by default', () => {
    const config = createPlaywrightConfig({});

    expect(config.use?.baseURL).toBe('http://127.0.0.1:4173');
    expect(config.webServer).toMatchObject({
      command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    });
  });

  it('uses the selected local preview port in the web server command and URL', () => {
    const config = createPlaywrightConfig({ IKUCK_PLAYWRIGHT_PREVIEW_PORT: '4179' });

    expect(config.use?.baseURL).toBe('http://127.0.0.1:4179');
    expect(config.webServer).toMatchObject({
      command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4179 --strictPort',
      url: 'http://127.0.0.1:4179',
      reuseExistingServer: false,
    });
  });

  it.each(['0', '65536', '-1', '4abc', ''])('rejects an invalid local preview port: %j', (port) => {
    expect(() => createPlaywrightConfig({ IKUCK_PLAYWRIGHT_PREVIEW_PORT: port })).toThrow(/port/i);
  });

  it('requires an explicit target for the live-stack profile', () => {
    expect(() => createPlaywrightConfig({ E2E_LIVE: 'true' })).toThrow(/E2E_BASE_URL/);
  });

  it('selects only the live-stack project and health setup when enabled', () => {
    const config = createPlaywrightConfig({
      E2E_LIVE: 'true',
      E2E_BASE_URL: 'http://127.0.0.1:8080',
    });

    expect(config.projects).toEqual([
      expect.objectContaining({ name: 'live-chromium', testMatch: /live-stack\.spec\.ts/ }),
    ]);
    expect(config.globalSetup).toBe('./e2e/liveSetup.ts');
    expect(config.webServer).toBeUndefined();
  });
});
