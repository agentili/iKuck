import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import type { SyncRepository } from '../sync/repository.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';

const authFor = (userId: string, email: string): AuthService => ({
  authenticate: async () => ({
    id: `session-${userId}`,
    userId,
    email,
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService);

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
      house: { service: createHouseService({ repository }), authService, appOrigin: origin },
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

  it('returns a negative typed result for an unregistered email', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const authService = authFor('admin-1', 'admin@example.com');
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService, appOrigin: origin },
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
      house: { service: createHouseService({ repository, syncRepository }), authService, appOrigin: origin },
    });
    await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });

    const response = await app.inject({ method: 'POST', url: '/v1/house/import-personal-data', headers });

    expect(response.statusCode).toBe(204);
    expect(migrateUserSharedDataToHouse).toHaveBeenCalledWith('admin-1', 'house-1');
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
      house: { service: createHouseService({ repository }), authService: adminAuth, appOrigin: origin },
    });
    const memberApp = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService: memberAuth, appOrigin: origin },
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
      house: { service: createHouseService({ repository }), authService: adminAuth, appOrigin: origin },
    });
    await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
    await createHouseService({ repository }).addMember('admin-1', 'member@example.com');

    const memberAuth = authFor('member-1', 'member@example.com');
    const memberApp = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService: memberAuth, appOrigin: origin },
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
