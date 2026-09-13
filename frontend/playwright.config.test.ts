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
    expect(config.projects?.[0].testIgnore).toEqual(/production-smoke\.spec\.ts/);
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
});
