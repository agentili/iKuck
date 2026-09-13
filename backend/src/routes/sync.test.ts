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

  it('rejects an invalid pantry lot payload before writing it', async () => {
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
          mutationId: 'invalid-lot',
          deviceId: 'device-1',
          entityType: 'pantry_lot',
          entityId: 'lot-1',
          operation: 'upsert',
          payload: {
            id: 'lot-1', ingredientId: 'pasta', label: 'Pasta', known: true,
            quantity: 0, unit: 'g', expiresAt: null,
            createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
          },
          clientUpdatedAt: '2026-09-13T10:00:00.000Z',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects an invalid shopping list payload before writing it', async () => {
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
          mutationId: 'invalid-shopping',
          deviceId: 'device-1',
          entityType: 'shopping_list_item',
          entityId: 'shopping-1',
          operation: 'upsert',
          payload: {
            id: 'shopping-1', ingredientId: 'pasta', label: 'Pasta', quantity: 10, unit: null,
            note: null, purchased: false, sourceRecipeId: null,
            createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
          },
          clientUpdatedAt: '2026-09-13T10:00:00.000Z',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_payload' });
  });

  it('accepts valid activity and preference mutations and rejects invalid payloads', async () => {
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: { repository: createMemorySyncRepository(), authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
    });
    const headers = {
      cookie: 'ikuck_session=session-token',
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': 'csrf-token',
    };
    const event = {
      id: 'event-1', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2,
      cookedAt: '2026-09-13T12:00:00.000Z', note: null,
      createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const preference = {
      recipeId: 'recipe-1', favorite: true, rating: 5, note: 'Da rifare',
      createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z',
    };

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers,
      payload: {
        deviceId: 'device-1',
        cursor: 0,
        mutations: [
          {
            mutationId: 'event-1', deviceId: 'device-1', entityType: 'cook_event', entityId: event.id,
            operation: 'upsert', payload: event, clientUpdatedAt: event.updatedAt,
          },
          {
            mutationId: 'preference-1', deviceId: 'device-1', entityType: 'recipe_preference', entityId: preference.recipeId,
            operation: 'upsert', payload: preference, clientUpdatedAt: preference.updatedAt,
          },
        ],
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ changes: [
      { entityType: 'cook_event', entityId: event.id },
      { entityType: 'recipe_preference', entityId: preference.recipeId },
    ] });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers,
      payload: {
        deviceId: 'device-1',
        cursor: 2,
        mutations: [{
          mutationId: 'event-invalid', deviceId: 'device-1', entityType: 'cook_event', entityId: 'event-2',
          operation: 'upsert', payload: { ...event, id: 'event-2', servings: 0 }, clientUpdatedAt: event.updatedAt,
        }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });
    await app.close();
  });

  it('rejects an invalid diet profile mutation before writing it', async () => {
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
          mutationId: 'invalid-profile',
          deviceId: 'device-1',
          entityType: 'diet_profile',
          entityId: 'profile',
          operation: 'upsert',
          payload: {
            diet: 'unknown',
            excludedAllergens: [],
            nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
            updatedAt: '2026-09-13T12:00:00.000Z',
          },
          clientUpdatedAt: '2026-09-13T12:00:00.000Z',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_payload' });
    await app.close();
  });
});
