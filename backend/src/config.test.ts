import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses local defaults only in development', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: 'postgres://ikuck:ikuck@127.0.0.1:5432/ikuck',
      redisUrl: 'redis://127.0.0.1:6379',
      appOrigin: 'http://127.0.0.1:5173',
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
});
