import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type PlatformDependencies } from '../app.js';

const apps: Array<ReturnType<typeof createApp>> = [];

const createDependencies = (): PlatformDependencies => ({
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /healthz', () => {
  it('returns ok only when PostgreSQL and Redis are reachable', async () => {
    const app = createApp(createDependencies());
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns a generic 503 when a platform dependency fails', async () => {
    const app = createApp({
      database: { ping: async () => { throw new Error('postgres://private-host'); } },
      cache: { ping: async () => undefined },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded' });
    expect(response.body).not.toContain('private-host');
  });
});
