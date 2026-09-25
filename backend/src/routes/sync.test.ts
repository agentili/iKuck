import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

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

describe('sync routes', () => {
  it('rejects stale house-scoped mutations after membership is removed', async () => {
    let member = true;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => member ? { kind: 'house', id: 'house-1' } : null,
    });
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: { repository, authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
    });
    const headers = {
      cookie: 'ikuck_session=session-token',
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': 'csrf-token',
    };
    const baseMutation = {
      mutationId: 'stale-house-mutation',
      deviceId: 'device-1',
      entityType: 'pantry_item' as const,
      entityId: 'stale-item',
      operation: 'upsert' as const,
      payload: { id: 'stale-item', label: 'Stale', known: true },
      clientUpdatedAt: '2026-09-24T12:00:00.000Z',
      syncScope: 'house:house-1' as const,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers,
      payload: { deviceId: 'device-1', cursor: 0, mutations: [baseMutation] },
    });
    expect(accepted.statusCode).toBe(200);
    member = false;

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers,
      payload: {
        deviceId: 'device-1',
        cursor: accepted.json<{ nextCursor: number }>().nextCursor,
        mutations: [{ ...baseMutation, mutationId: 'stale-house-mutation-2' }],
      },
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ code: 'house_membership_required', message: 'House membership is required for shared data' });
    await expect(repository.readEntity('user-1', 'pantry_item', 'stale-item')).resolves.toBeNull();
    await app.close();
  });

  it('rejects shared mutations without an explicit scope marker', async () => {
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: { repository: createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) }), authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { cookie: 'ikuck_session=session-token', origin: 'http://127.0.0.1:5173', 'x-csrf-token': 'csrf-token' },
      payload: {
        deviceId: 'device-1',
        cursor: 0,
        mutations: [{
          mutationId: 'missing-scope', deviceId: 'device-1', entityType: 'pantry_item', entityId: 'item-1',
          operation: 'upsert', payload: { id: 'item-1', label: 'Item', known: true }, clientUpdatedAt: '2026-09-24T12:00:00.000Z',
        }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'sync_scope_required', message: 'A scope is required for shared data mutations' });
    await app.close();
  });

  it('rejects a read-only house sync after membership is removed', async () => {
    let member = true;
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: {
        repository: createMemorySyncRepository({ scopeResolver: async () => member ? { kind: 'house', id: 'house-1' } : null }),
        authService: sessionService,
        appOrigin: 'http://127.0.0.1:5173',
      },
    });
    member = false;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { cookie: 'ikuck_session=session-token', origin: 'http://127.0.0.1:5173', 'x-csrf-token': 'csrf-token' },
      payload: { deviceId: 'device-1', cursor: 0, syncScope: 'house:house-1', mutations: [] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'house_membership_required', message: 'House membership is required for shared data' });
    await app.close();
  });

  it('rejects a house scope for personal sync entities', async () => {
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: { repository: createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) }), authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { cookie: 'ikuck_session=session-token', origin: 'http://127.0.0.1:5173', 'x-csrf-token': 'csrf-token' },
      payload: {
        deviceId: 'device-1',
        cursor: 0,
        mutations: [{
          mutationId: 'personal-house-scope', deviceId: 'device-1', entityType: 'cook_event', entityId: 'event-1',
          operation: 'delete', payload: null, clientUpdatedAt: '2026-09-24T12:00:00.000Z', syncScope: 'house:house-1',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'sync_scope_invalid', message: 'House scope is only valid for shared data' });
    await app.close();
  });

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
          syncScope: 'account:user-1',
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
    expect(response.json()).toMatchObject({ code: 'INVALID_SYNC_PAYLOAD' });
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
    expect(response.json()).toMatchObject({ code: 'INVALID_SYNC_PAYLOAD' });
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
    expect(invalid.json()).toMatchObject({ code: 'INVALID_SYNC_PAYLOAD' });
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
    expect(response.json()).toMatchObject({ code: 'INVALID_SYNC_PAYLOAD' });
    await app.close();
  });

  it('accepts AI consent and generated recipe entities while validating private recipe deletes', async () => {
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
    const consent = {
      enabled: true,
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const recipe = {
      id: 'generated-1',
      source: 'ai' as const,
      title: 'Ceci croccanti',
      description: 'Una ricetta semplice.',
      ingredients: [{ name: 'Ceci', amount: '240 g' }],
      steps: ['Scola i ceci.'],
      diets: ['vegan' as const],
      allergens: [],
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
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
            mutationId: 'ai-consent-1', deviceId: 'device-1', entityType: 'ai_consent', entityId: 'profile',
            operation: 'upsert', payload: consent, clientUpdatedAt: consent.updatedAt,
          },
          {
            mutationId: 'generated-1', deviceId: 'device-1', entityType: 'generated_recipe', entityId: recipe.id,
            operation: 'upsert', payload: recipe, clientUpdatedAt: recipe.updatedAt,
          },
        ],
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ changes: [
      { entityType: 'ai_consent', entityId: 'profile' },
      { entityType: 'generated_recipe', entityId: recipe.id },
    ] });

    const removed = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers,
      payload: {
        deviceId: 'device-1',
        cursor: valid.json().nextCursor,
        mutations: [{
          mutationId: 'generated-delete-1', deviceId: 'device-1', entityType: 'generated_recipe', entityId: recipe.id,
          operation: 'delete', payload: null, clientUpdatedAt: '2026-09-13T12:01:00.000Z',
        }],
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ changes: [{ entityType: 'generated_recipe', operation: 'delete', payload: null }] });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers,
      payload: {
        deviceId: 'device-1',
        cursor: removed.json().nextCursor,
        mutations: [{
          mutationId: 'generated-invalid-1', deviceId: 'device-1', entityType: 'generated_recipe', entityId: 'generated-2',
          operation: 'upsert', payload: { ...recipe, id: 'generated-2', title: '' }, clientUpdatedAt: recipe.updatedAt,
        }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_SYNC_PAYLOAD' });
    await app.close();
  });

  it.each([
    ['malformed body', null],
    ['unknown entity', {
      deviceId: 'device-1', cursor: 0, mutations: [{
        mutationId: 'mutation-unknown', deviceId: 'device-1', entityType: 'unknown', entityId: 'item-1',
        operation: 'upsert', payload: {}, clientUpdatedAt: '2026-09-13T12:00:00.000Z',
      }],
    }],
    ['incomplete mutation', {
      deviceId: 'device-1', cursor: 0, mutations: [{
        deviceId: 'device-1', entityType: 'pantry_item', entityId: 'item-1',
        operation: 'upsert', payload: {}, clientUpdatedAt: '2026-09-13T12:00:00.000Z',
      }],
    }],
    ['incoherent device id', {
      deviceId: 'device-1', cursor: 0, mutations: [{
        mutationId: 'mutation-device', deviceId: 'device-2', entityType: 'pantry_item', entityId: 'item-1',
        operation: 'upsert', payload: {}, clientUpdatedAt: '2026-09-13T12:00:00.000Z',
      }],
    }],
  ])('returns a stable 400 for %s', async (_name, body) => {
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
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_SYNC_PAYLOAD', message: 'Request payload is invalid' });
    await app.close();
  });

  it('redacts repository failures instead of exposing internal details', async () => {
    const repository = createMemorySyncRepository();
    vi.spyOn(repository, 'applyMutation').mockRejectedValue(new Error('database connection details'));
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      sync: { repository, authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
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
        deviceId: 'device-1', cursor: 0, mutations: [{
          mutationId: 'mutation-error', deviceId: 'device-1', entityType: 'pantry_item', entityId: 'item-1',
          operation: 'upsert', payload: { id: 'item-1', label: 'Item', known: true }, clientUpdatedAt: '2026-09-13T12:00:00.000Z', syncScope: 'account:user-1',
        }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'internal_error', message: 'Internal server error' });
    expect(response.body).not.toContain('database connection details');
    await app.close();
  });
});
