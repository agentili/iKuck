import webpush from 'web-push';
import type { PushSubscriptionInput, WeeklyPushPayload } from '@ikuck/shared/contracts';
import { allowedPushEndpoint } from './validation.js';

export type PushTransport = (subscription: PushSubscriptionInput, payload: WeeklyPushPayload) => Promise<void>;
export function createPushTransport(subject: string, publicKey: string, privateKey: string): PushTransport {
  return async (subscription, payload) => {
    if (!allowedPushEndpoint(subscription.endpoint)) throw new Error('push_endpoint_invalid');
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: { subject, publicKey, privateKey }, timeout: 10_000,
      TTL: Math.max(0, Math.min(7200, Math.floor((Date.parse(payload.expiresAt) - Date.now()) / 1000))),
      urgency: 'normal',
    });
  };
}
export function pushStatusCode(error: unknown): number {
  return typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 0;
}
