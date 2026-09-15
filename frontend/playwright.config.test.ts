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

  it('keeps the local preview server for the default profile', () => {
    const config = createPlaywrightConfig({});

    expect(config.use?.baseURL).toBe('http://127.0.0.1:4173');
    expect(config.webServer).toMatchObject({
      url: 'http://127.0.0.1:4173',
    });
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
