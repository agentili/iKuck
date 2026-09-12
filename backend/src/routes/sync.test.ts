import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const sessionService = {
  authenticate: async () => ({
    id: 'session-1',
    userId: 'user-1',
    email: 'user@example.com',
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService;

describe('sync routes', () => {
  it('accepts authenticated mutations and returns a cursor', async () => {
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: { repository: createMemorySyncRepository(), authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: {
        cookie: 'ikuck_session=session-token',
        origin: 'http://127.0.0.1:5173',
        'x-csrf-token': 'csrf-token',
      },
      payload: {
        deviceId: 'device-1',
        cursor: 0,
        mutations: [{
          mutationId: 'mutation-1',
          deviceId: 'device-1',
          entityType: 'pantry_item',
          entityId: 'tomato',
          operation: 'upsert',
          payload: { id: 'tomato', label: 'Pomodoro', known: true },
          clientUpdatedAt: '2026-09-12T12:00:00.000Z',
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nextCursor: 1, changes: [{ entityId: 'tomato' }] });
  });
});
