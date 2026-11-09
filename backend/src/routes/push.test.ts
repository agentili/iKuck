import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { PushRepository } from '../push/repository.js';

const user = { id: 'session', userId: 'user', email: 'user@example.test', emailVerifiedAt: new Date(), csrfTokenHash: hashOpaqueToken('csrf'), expiresAt: new Date('2099-01-01') };
const preferences = { enabled: true, fridayTime: '19:00', timeZone: 'Europe/Rome' };
const repository: PushRepository = {
  status: vi.fn().mockResolvedValue({ preferences, effectiveTimeZone: 'Europe/Rome', preferencesConfigured: true }),
  savePreferences: vi.fn(), subscriptions: vi.fn().mockResolvedValue([]), subscribe: vi.fn().mockResolvedValue({ id: 'subscription' }), unsubscribe: vi.fn(), testSubscription: vi.fn().mockResolvedValue(null),
};
const send = vi.fn().mockResolvedValue(undefined);
const headers = { cookie: 'ikuck_session=token', origin: 'https://ikuck.test', 'x-csrf-token': 'csrf' };
const setup = (verified = true, enabled = true) => createApp({
  database: { ping: async () => {} }, cache: { ping: async () => {} },
  push: { enabled, publicKey: 'public', repository, appOrigin: 'https://ikuck.test',
    authService: { authenticate: async () => ({ ...user, emailVerifiedAt: verified ? user.emailVerifiedAt : null }) } as unknown as AuthService,
    rateLimiter: { enforce: vi.fn() }, send,
  },
});
beforeEach(() => vi.clearAllMocks());
describe('push routes', () => {
  it('requires verification, origin and CSRF before persisting', async () => {
    const app = setup(false);
    expect((await app.inject({ url: '/v1/push', headers })).statusCode).toBe(403);
    await app.close();
    const verified = setup();
    for (const invalidHeaders of [{ ...headers, origin: 'https://evil.test' }, { ...headers, 'x-csrf-token': 'wrong' }]) {
      expect((await verified.inject({ method: 'PUT', url: '/v1/push/preferences', headers: invalidHeaders, payload: preferences })).statusCode).toBe(403);
    }
    expect(repository.savePreferences).not.toHaveBeenCalled();
    await verified.close();
  });
  it('returns disabled status and blocks subscription writes when disabled', async () => {
    const app = setup(true, false);
    expect((await app.inject({ url: '/v1/push', headers })).json()).toMatchObject({ enabled: false });
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers, payload: {} })).statusCode).toBe(503);
    await app.close();
  });
  it('validates input and passes authenticated user/session to registration', async () => {
    const app = setup();
    expect((await app.inject({ method: 'PUT', url: '/v1/push/preferences', headers, payload: { ...preferences, fridayTime: 'invalid' } })).statusCode).toBe(400);
    const payload = { endpoint: 'https://fcm.googleapis.com/send/test', keys: { auth: Buffer.alloc(16).toString('base64url'), p256dh: generateVAPIDKeys().publicKey } };
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers, payload })).statusCode).toBe(200);
    expect(repository.subscribe).toHaveBeenCalledWith('user', 'session', payload);
    expect((await app.inject({ method: 'PUT', url: '/v1/push/preferences', headers, payload: preferences })).statusCode).toBe(204);
    await app.close();
  });
  it('scopes deletion and test lookup to the current user and session', async () => {
    const app = setup(); const id = '00000000-0000-4000-8000-000000000001';
    expect((await app.inject({ method: 'DELETE', url: `/v1/push/subscriptions/${id}`, headers })).statusCode).toBe(204);
    expect(repository.unsubscribe).toHaveBeenCalledWith('user', 'session', id);
    expect((await app.inject({ method: 'POST', url: `/v1/push/subscriptions/${id}/test`, headers })).statusCode).toBe(404);
    expect(repository.testSubscription).toHaveBeenCalledWith('user', 'session', id);
    await app.close();
  });
  it('removes an expired device and returns an actionable expiry code', async () => {
    const app = setup(); const id = '00000000-0000-4000-8000-000000000001';
    vi.mocked(repository.testSubscription).mockResolvedValueOnce({ endpoint: 'https://fcm.googleapis.com/send/test', keys: { auth: 'key', p256dh: 'public' } });
    send.mockRejectedValueOnce({ statusCode: 410 });
    const response = await app.inject({ method: 'POST', url: `/v1/push/subscriptions/${id}/test`, headers });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'push_subscription_expired' });
    expect(repository.unsubscribe).toHaveBeenCalledWith('user', 'session', id);
    await app.close();
  });

});
