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

  it('rejects a production configuration without a session secret', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@database:5432/ikuck',
      REDIS_URL: 'redis://cache:6379',
      APP_ORIGIN: 'https://ikuck.example',
    })).toThrow('SESSION_SECRET is required');
  });

  it('maps the production sender variable to the existing email provider contract', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      SESSION_SECRET: 'production-session-secret-that-is-longer-than-thirty-two-characters',
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
      SESSION_SECRET: 'production-session-secret-that-is-longer-than-thirty-two-characters',
      APP_ORIGIN: 'https://app.ikuck.it',
      TRUST_PROXY: '10.0.0.10, 10.0.0.11/32',
    })).toMatchObject({ trustProxy: ['10.0.0.10', '10.0.0.11/32'] });
    expect(loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ikuck:secret@postgres:5432/ikuck',
      REDIS_URL: 'redis://redis:6379',
      SESSION_SECRET: 'production-session-secret-that-is-longer-than-thirty-two-characters',
      APP_ORIGIN: 'https://app.ikuck.it',
    }).trustProxy).toBeUndefined();
  });
});
