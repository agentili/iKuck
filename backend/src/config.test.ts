import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses local defaults only in development', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: 'postgres://ikuck:ikuck@127.0.0.1:5432/ikuck',
      redisUrl: 'redis://127.0.0.1:6379',
      appOrigin: 'http://localhost:5173',
      logLevel: 'debug',
      providers: { openAiModel: 'gpt-5.5' },
    });
  });

  it('accepts production configuration without an additional secret', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@database:5432/ikuck',
      REDIS_URL: 'redis://cache:6379',
      APP_ORIGIN: 'https://ikuck.example',
    })).toMatchObject({ appOrigin: 'https://ikuck.example' });
  });

  it('maps the SMTP variables onto the existing email provider contract', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      SMTP_HOST: 'smtp.example',
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'app-pass',
      EMAIL_FROM: 'noreply@app.ikuck.it',
    })).toMatchObject({
      providers: {
        smtpHost: 'smtp.example',
        smtpPort: 587,
        smtpUser: 'smtp-user',
        smtpPass: 'app-pass',
        emailFrom: 'noreply@app.ikuck.it',
      },
    });
  });

  it('accepts a named sender address and rejects an unusable one', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      SMTP_HOST: 'smtp.example',
    };

    expect(loadConfig({ ...base, EMAIL_FROM: 'iKuck <noreply@app.ikuck.it>' }).providers.emailFrom)
      .toBe('iKuck <noreply@app.ikuck.it>');
    expect(() => loadConfig({ ...base, EMAIL_FROM: 'not-an-email' })).toThrow();
  });

  it('defaults the SMTP port to 587 and rejects unusable ports', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      SMTP_HOST: 'smtp.example',
    };

    expect(loadConfig(base).providers.smtpPort).toBe(587);
    expect(loadConfig({ ...base, SMTP_PORT: '465' }).providers.smtpPort).toBe(465);
    expect(() => loadConfig({ ...base, SMTP_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...base, SMTP_PORT: 'smtps' })).toThrow();
  });

  it('parses only explicitly configured proxy addresses', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      TRUST_PROXY: '10.0.0.10, 10.0.0.11/32',
    })).toMatchObject({ trustProxy: ['10.0.0.10', '10.0.0.11/32'] });
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
    }).trustProxy).toBeUndefined();
  });

  it('parses the configurable sync clock skew tolerance in seconds', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      SYNC_MAX_CLIENT_CLOCK_SKEW_SECONDS: '900',
    })).toMatchObject({ syncMaxClientClockSkewMs: 900000 });
  });

  it('parses distinct provider timeouts and rejects unsafe values', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      SMTP_TIMEOUT_MS: '1200',
      USDA_TIMEOUT_MS: '2400',
      OPENAI_TIMEOUT_MS: '3600',
    })).toMatchObject({
      providers: { smtpTimeoutMs: 1200, usdaTimeoutMs: 2400, openAiTimeoutMs: 3600 },
    });

    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      SMTP_TIMEOUT_MS: '99',
    })).toThrow();

    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
    }).providers.smtpTimeoutMs).toBe(10000);
  });

  it('selects Gemini configuration for recipe generation', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it:30443',
      RECIPE_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-test-key',
      GEMINI_MODEL: 'gemini-test',
    })).toMatchObject({
      providers: {
        recipeProvider: 'gemini',
        geminiApiKey: 'gemini-test-key',
        geminiModel: 'gemini-test',
      },
    });
  });

  it('treats blank optional provider settings as absent', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      GOOGLE_CLIENT_ID: '',
      OPENAI_API_KEY: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      EMAIL_FROM: '',
      USDA_API_KEY: '',
    });

    expect(config.providers).toMatchObject({ openAiModel: 'gpt-5.5' });
    expect(config.googleClientId).toBeUndefined();
    expect(config.providers.smtpHost).toBeUndefined();
    expect(config.providers.smtpUser).toBeUndefined();
    expect(config.providers.smtpPass).toBeUndefined();
    expect(config.providers.emailFrom).toBeUndefined();
    expect(config.providers.usdaApiKey).toBeUndefined();
    expect(config.providers.openAiApiKey).toBeUndefined();
  });

  it('keeps the provider configuration limited to the documented ADR-001 keys', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
    });

    expect(Object.keys(config.providers).sort()).toEqual([
      'emailFrom',
      'geminiApiKey',
      'geminiModel',
      'openAiApiKey',
      'openAiModel',
      'openAiTimeoutMs',
      'recipeProvider',
      'smtpHost',
      'smtpPass',
      'smtpPort',
      'smtpTimeoutMs',
      'smtpUser',
      'usdaApiKey',
      'usdaTimeoutMs',
    ]);
  });

  it('keeps the S2S dinner context API disabled unless explicitly enabled', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://ikuck:***@postgres:5432/ikuck', REDIS_URL: 'redis://redis:6379', APP_ORIGIN: 'https://app.ikuck.it' };
    expect(loadConfig(base).s2sDinnerContextEnabled).toBe(false);
    expect(loadConfig({ ...base, S2S_DINNER_CONTEXT_ENABLED: 'true' }).s2sDinnerContextEnabled).toBe(true);
    expect(() => loadConfig({ ...base, S2S_DINNER_CONTEXT_ENABLED: 'yes' })).toThrow();
  });
  it('forwards the opt-in S2S flag with a false default to each API Compose service', async () => {
    for (const file of ['../../compose.dev.yml', '../../deploy/docker-compose.standalone.yml', '../../deploy/docker-compose.production.yml']) {
      const compose = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(compose).toMatch(/^ {6}S2S_DINNER_CONTEXT_ENABLED:\s*\$\{S2S_DINNER_CONTEXT_ENABLED:-false\}\s*$/m);
    }
  });

});
