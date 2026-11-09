import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../api/apiClient';
import { enableDevicePush } from './client';
vi.mock('../api/apiClient', async (original) => ({ ...await original<typeof import('../api/apiClient')>(), apiRequest: vi.fn() }));
const publicKey = 'B' + 'A'.repeat(86);
const serialized = { endpoint: 'https://fcm.googleapis.com/send/device', expirationTime: null, keys: { p256dh: publicKey, auth: 'A'.repeat(22) } };
const unsubscribe = vi.fn().mockResolvedValue(true);
const subscribe = vi.fn().mockResolvedValue({ endpoint: serialized.endpoint, options: {}, toJSON: () => serialized, unsubscribe });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ active: {}, pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } }) } });
  vi.mocked(apiRequest).mockResolvedValue({ id: 'device' });
});
afterEach(() => vi.unstubAllGlobals());
describe('browser push registration', () => {
  it('sends only endpoint and keys, filtering the native expirationTime field', async () => {
    expect(await enableDevicePush(publicKey, 'user', 'csrf')).toBe('device');
    expect(apiRequest).toHaveBeenCalledWith('/v1/push/subscriptions', { method: 'POST', csrfToken: 'csrf', body: { endpoint: serialized.endpoint, keys: serialized.keys } });
    expect(unsubscribe).not.toHaveBeenCalled();
  });
  it('does not subscribe or send data when permission is denied', async () => {
    vi.mocked(Notification.requestPermission).mockResolvedValue('denied');
    await expect(enableDevicePush(publicKey, 'user', 'csrf')).rejects.toThrow('Permesso negato');
    expect(subscribe).not.toHaveBeenCalled(); expect(apiRequest).not.toHaveBeenCalled();
  });
  it('rolls back the browser subscription if the server rejects registration', async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error('unavailable'));
    await expect(enableDevicePush(publicKey, 'user', 'csrf')).rejects.toThrow('unavailable');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
