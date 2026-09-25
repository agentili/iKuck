import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const appOrigin = 'http://127.0.0.1:5173';
const sessionService = {
  authenticate: async () => ({
    id: 'session-1',
    userId: 'user-1',
    email: 'user@example.com',
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService;

const probes = {
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
};

const authHeaders = { cookie: 'ikuck_session=session-token', origin: appOrigin };

describe('pantry lot routes', () => {
  it('creates, reads, updates and deletes an authenticated lot', async () => {
    const app = createApp({
      ...probes,
      auth: { service: sessionService, appOrigin, secureCookies: false },
      pantryLots: { repository: createMemorySyncRepository(), authService: sessionService, appOrigin },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/pantry-lots',
      headers: { ...authHeaders, 'x-csrf-token': 'csrf-token' },
      payload: {
        ingredientId: 'pasta',
        label: 'Pasta',
        known: true,
        quantity: null,
        unit: null,
        expiresAt: null,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ lot: { id: string; quantity: number | null } }>().lot;
    expect(created).toMatchObject({ ingredientId: 'pasta', quantity: null, unit: null });

    const read = await app.inject({ method: 'GET', url: '/v1/pantry-lots', headers: authHeaders });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ lots: [expect.objectContaining({ id: created.id })] });

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/pantry-lots/${encodeURIComponent(created.id)}`,
      headers: { ...authHeaders, 'x-csrf-token': 'csrf-token' },
      payload: { quantity: 320, unit: 'g', expiresAt: '2026-09-20' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ lot: { id: created.id, quantity: 320, unit: 'g', expiresAt: '2026-09-20' } });

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/pantry-lots/${encodeURIComponent(created.id)}`,
      headers: { ...authHeaders, 'x-csrf-token': 'csrf-token' },
    });
    expect(remove.statusCode).toBe(204);
    await app.close();
  });

  it('rejects invalid quantity details and preserves presence-only lots', async () => {
    const app = createApp({
      ...probes,
      auth: { service: sessionService, appOrigin, secureCookies: false },
      pantryLots: { repository: createMemorySyncRepository(), authService: sessionService, appOrigin },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/pantry-lots',
      headers: { ...authHeaders, 'x-csrf-token': 'csrf-token' },
      payload: { ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 0, unit: 'g', expiresAt: null },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/v1/pantry-lots',
      headers: authHeaders,
      payload: { ingredientId: 'pasta', label: 'Pasta', known: true, quantity: null, unit: null, expiresAt: null },
    });
    expect(missingCsrf.statusCode).toBe(403);
    await app.close();
  });
});
