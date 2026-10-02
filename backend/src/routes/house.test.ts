import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { AuthRateLimitError } from '../auth/rateLimit.js';
import type { SyncRepository } from '../sync/repository.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';

const authFor = (userId: string, email: string): AuthService => ({
  authenticate: async () => ({
    id: `session-${userId}`,
    userId,
    email,
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService);

const noOpRateLimiter = { enforce: async () => undefined };

const headers = {
  cookie: 'ikuck_session=session-token',
  origin,
  'x-csrf-token': 'csrf-token',
};

describe('house routes', () => {
  it('creates a house and adds a registered email without sending an invitation', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: authService, appOrigin: origin, secureCookies: false },
      house: { service: createHouseService({ repository }), authService, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/house',
      headers,
      payload: { name: 'Casa' },
    });
    expect(createResponse.statusCode).toBe(201);

    const addResponse = await app.inject({
      method: 'POST',
      url: '/v1/house/members',
      headers,
      payload: { email: ' MEMBER@EXAMPLE.COM ' },
    });
    expect(addResponse.statusCode).toBe(201);
    expect(addResponse.json()).toMatchObject({ member: { userId: 'member-1', role: 'member' } });

    const stateResponse = await app.inject({ method: 'GET', url: '/v1/house', headers });
    expect(stateResponse.statusCode).toBe(200);
    expect(stateResponse.json().members).toHaveLength(2);
  });

  it('rejects unverified sessions from house data and pantry merge routes', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: null },
    ]);
    const authService = authFor('member-1', 'member@example.com');
    authService.authenticate = async () => ({
      id: 'session-member-1',
      userId: 'member-1',
      email: 'member@example.com',
      emailVerifiedAt: null,
      csrfTokenHash: hashOpaqueToken('csrf-token'),
      expiresAt: new Date('2026-10-12T12:00:00.000Z'),
    });
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });

    const stateResponse = await app.inject({ method: 'GET', url: '/v1/house', headers });
    const mergeResponse = await app.inject({
      method: 'POST',
      url: '/v1/house/pantry/merge',
      headers,
      payload: { deviceId: 'device-1', lots: [], stapleIds: [] },
    });

    expect(stateResponse.statusCode).toBe(403);
    expect(mergeResponse.statusCode).toBe(403);
  });

  it('rate-limits direct member lookup before checking whether the target email is registered', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const authService = authFor('admin-1', 'admin@example.com');
    const enforce = vi.fn().mockRejectedValue(new AuthRateLimitError('rate_limited', 429, 'Too many requests', 3600));
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService, appOrigin: origin, rateLimiter: { enforce } },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
    const response = await app.inject({
      method: 'POST', url: '/v1/house/members', headers, payload: { email: 'member@example.com' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('3600');
    expect(enforce).toHaveBeenCalledWith('houseAddMember', {
      ip: expect.any(String), email: 'member@example.com', actorId: 'admin-1',
    });
    expect((await repository.getStateForUser('admin-1'))?.members).toHaveLength(1);
  });

  it('returns a negative typed result for an unregistered email', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/house/members',
      headers,
      payload: { email: 'missing@example.com' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'house_email_not_registered' });
  });

  it('exposes personal-data import only as an explicit CSRF-protected action', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const migrateUserSharedDataToHouse = vi.fn<SyncRepository['migrateUserSharedDataToHouse']>().mockResolvedValue(undefined);
    const syncRepository = { migrateUserSharedDataToHouse } as unknown as SyncRepository;
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository, syncRepository }), authService, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });

    const response = await app.inject({ method: 'POST', url: '/v1/house/import-personal-data', headers });

    expect(response.statusCode).toBe(204);
    expect(migrateUserSharedDataToHouse).toHaveBeenCalledWith('admin-1', 'house-1');
  });

  it('imports only authenticated account-scoped shared queue mutations into the current house', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const migrateUserSharedDataToHouse = vi.fn<SyncRepository['migrateUserSharedDataToHouse']>().mockResolvedValue(undefined);
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository, syncRepository: { migrateUserSharedDataToHouse } as unknown as SyncRepository }), authService, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
    migrateUserSharedDataToHouse.mockClear();
    const pending = {
      mutationId: 'pending-diet', deviceId: 'device-1', entityType: 'diet_profile', entityId: 'profile',
      operation: 'upsert', payload: { diet: 'vegetarian', excludedAllergens: ['milk'], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: '2026-09-24T12:00:00.000Z' },
      clientUpdatedAt: '2026-09-24T12:00:00.000Z', syncScope: 'account:admin-1',
    };
    const result = await app.inject({ method: 'POST', url: '/v1/house/account-queue/import', headers, payload: { mutations: [pending] } });
    expect(result.statusCode).toBe(204);
    expect(migrateUserSharedDataToHouse).toHaveBeenCalledExactlyOnceWith('admin-1', 'house-1', [pending]);
    const personal = await app.inject({ method: 'POST', url: '/v1/house/account-queue/import', headers, payload: { mutations: [{ ...pending, entityType: 'ai_consent', payload: { enabled: true, updatedAt: pending.clientUpdatedAt } }] } });
    expect(personal.statusCode).toBe(400);
    const foreign = await app.inject({ method: 'POST', url: '/v1/house/account-queue/import', headers, payload: { mutations: [{ ...pending, syncScope: 'account:another-user' }] } });
    expect(foreign.statusCode).toBe(400);
    expect(migrateUserSharedDataToHouse).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('imports only an unscope guest diet mutation through the authenticated House endpoint', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const mergeGuestDietProfileToHouse = vi.fn().mockResolvedValue(true);
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: {
        service: createHouseService({ repository, syncRepository: { mergeGuestDietProfileToHouse } as unknown as SyncRepository }),
        authService, appOrigin: origin, rateLimiter: noOpRateLimiter,
      },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
    const mutation = {
      mutationId: 'guest-diet-1', deviceId: 'guest-device', entityType: 'diet_profile', entityId: 'profile',
      operation: 'upsert', payload: {
        diet: 'omnivore', excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: '2026-09-24T12:00:00.000Z',
      }, clientUpdatedAt: '2026-09-24T12:00:00.000Z',
    };

    const response = await app.inject({ method: 'POST', url: '/v1/house/diet-profile/import', headers, payload: { mutation } });
    const forgedScope = await app.inject({
      method: 'POST', url: '/v1/house/diet-profile/import', headers,
      payload: { mutation: { ...mutation, syncScope: 'house:house-1' } },
    });

    expect(response.statusCode).toBe(204);
    expect(mergeGuestDietProfileToHouse).toHaveBeenCalledExactlyOnceWith('admin-1', 'house-1', mutation);
    expect(forgedScope.statusCode).toBe(400);
    expect(mergeGuestDietProfileToHouse).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('accepts a verified device pantry snapshot and returns the merge summary', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const mergeGuestPantryToHouse = vi.fn<SyncRepository['mergeGuestPantryToHouse']>().mockResolvedValue({
      addedLots: 2,
      mergedLots: 1,
      mergedGroups: 1,
      importedStaples: 1,
    });
    const syncRepository = { mergeGuestPantryToHouse } as unknown as SyncRepository;
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository, syncRepository }), authService, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/house/pantry/merge',
      headers,
      payload: { deviceId: 'device-1', lots: [], stapleIds: ['salt'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ summary: { addedLots: 2, mergedLots: 1, mergedGroups: 1, importedStaples: 1 } });
    expect(mergeGuestPantryToHouse).toHaveBeenCalledWith('admin-1', 'house-1', {
      deviceId: 'device-1',
      lots: [],
      stapleIds: ['salt'],
    });
  });

  it('allows a member to leave and protects the last admin', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const adminAuth = authFor('admin-1', 'admin@example.com');
    const memberAuth = authFor('member-1', 'member@example.com');
    const adminApp = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService: adminAuth, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    const memberApp = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService: memberAuth, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
    await createHouseService({ repository }).addMember('admin-1', 'member@example.com');

    const blockedAdminLeave = await adminApp.inject({ method: 'POST', url: '/v1/house/leave', headers });
    expect(blockedAdminLeave.statusCode).toBe(409);
    expect(blockedAdminLeave.json()).toMatchObject({ code: 'house_last_admin_required' });
    const memberLeave = await memberApp.inject({ method: 'POST', url: '/v1/house/leave', headers });
    expect(memberLeave.statusCode).toBe(204);
    const adminLeave = await adminApp.inject({ method: 'POST', url: '/v1/house/leave', headers });
    expect(adminLeave.statusCode).toBe(204);
  });

  it('does not allow a member to add another account', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const adminAuth = authFor('admin-1', 'admin@example.com');
    const adminApp = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService: adminAuth, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
    await createHouseService({ repository }).addMember('admin-1', 'member@example.com');

    const memberAuth = authFor('member-1', 'member@example.com');
    const memberApp = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService: memberAuth, appOrigin: origin, rateLimiter: noOpRateLimiter },
    });
    const response = await memberApp.inject({
      method: 'POST',
      url: '/v1/house/members',
      headers,
      payload: { email: 'admin@example.com' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'house_admin_required' });
  });
});
