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

  it('maps the production sender variable to the existing email provider contract', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM_EMAIL: 'noreply@app.ikuck.it',
    })).toMatchObject({
      providers: {
        resendApiKey: 're_test_key',
        resendFrom: 'noreply@app.ikuck.it',
      },
    });
  });

  it('parses only explicitly configured proxy addresses', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
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
      RESEND_TIMEOUT_MS: '1200',
      USDA_TIMEOUT_MS: '2400',
      OPENAI_TIMEOUT_MS: '3600',
    })).toMatchObject({
      providers: { resendTimeoutMs: 1200, usdaTimeoutMs: 2400, openAiTimeoutMs: 3600 },
    });

    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      RESEND_TIMEOUT_MS: '99',
    })).toThrow();
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
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'https://app.ikuck.it',
      GOOGLE_CLIENT_ID: '',
      OPENAI_API_KEY: '',
      RESEND_API_KEY: '',
      RESEND_FROM_EMAIL: '',
      USDA_API_KEY: '',
    });

    expect(config.providers).toMatchObject({ openAiModel: 'gpt-5.5' });
    expect(config.googleClientId).toBeUndefined();
    expect(config.providers.resendApiKey).toBeUndefined();
    expect(config.providers.resendFrom).toBeUndefined();
    expect(config.providers.usdaApiKey).toBeUndefined();
    expect(config.providers.openAiApiKey).toBeUndefined();
  });

});
