import type { PushPreferences, PushStatus, PushSubscriptionInput } from '@ikuck/shared/contracts';
import { apiRequest } from '../api/apiClient';

const consentCache = 'ikuck-push-consent';
const consentPath = '/__ikuck_push_consent';
export const supportsPush = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function setPushConsent(userId: string | null): Promise<void> {
  if (!('caches' in globalThis)) return;
  if (userId === null) { await caches.delete(consentCache); return; }
  const cache = await caches.open(consentCache);
  await cache.put(consentPath, new Response(JSON.stringify({ userId }), { headers: { 'content-type': 'application/json' } }));
}
export async function clearLocalPush(): Promise<void> {
  await setPushConsent(null);
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    const notifications = await registration?.getNotifications?.();
    notifications?.forEach((notification) => notification.close());
    await (await registration?.pushManager?.getSubscription())?.unsubscribe();
  }
}
export async function reconcilePushAccount(userId: string): Promise<void> {
  if (!('caches' in globalThis)) return;
  const cached = await (await caches.open(consentCache)).match(consentPath);
  if (cached && (await cached.json() as { userId: string }).userId !== userId) await clearLocalPush();
}
export async function browserSubscription(): Promise<PushSubscription | null> {
  if (!supportsPush()) return null;
  return (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;
}
export const getPushStatus = () => apiRequest<PushStatus>('/v1/push');
export const getDeviceSubscriptions = () => apiRequest<{ id: string; endpoint: string }[]>('/v1/push/subscriptions');
export const savePushPreferences = (preferences: PushPreferences, csrfToken: string) => apiRequest<void>('/v1/push/preferences', { method: 'PUT', body: preferences, csrfToken });
export const deleteDeviceSubscription = (id: string, csrfToken: string) => apiRequest<void>(`/v1/push/subscriptions/${id}`, { method: 'DELETE', csrfToken });
export const sendPushTest = (id: string, csrfToken: string) => apiRequest<void>(`/v1/push/subscriptions/${id}/test`, { method: 'POST', csrfToken });

export async function enableDevicePush(publicKey: string, userId: string, csrfToken: string): Promise<string> {
  // This call must start directly in the click handler (not after a network round trip).
  if (await Notification.requestPermission() !== 'granted') throw new Error('Permesso negato. Puoi modificarlo nelle impostazioni del browser.');
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.active) throw new Error('La PWA non è ancora pronta. Ricarica la pagina e riprova.');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && subscription.options.applicationServerKey &&
      new Uint8Array(subscription.options.applicationServerKey).some((byte, index) => byte !== key[index])) {
    await subscription.unsubscribe(); subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try {
    const serialized = subscription.toJSON();
    if (!serialized.keys?.p256dh || !serialized.keys.auth) throw new Error('Chiavi della sottoscrizione non disponibili.');
    // Native JSON also contains expirationTime; send only the shared API contract.
    const body: PushSubscriptionInput = { endpoint: subscription.endpoint, keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth } };
    const result = await apiRequest<{ id: string }>('/v1/push/subscriptions', { method: 'POST', body, csrfToken });
    await setPushConsent(userId);
    return result.id;
  } catch (error) {
    await setPushConsent(null);
    await subscription.unsubscribe();
    throw error;
  }
}
