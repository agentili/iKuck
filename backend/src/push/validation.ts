import { z } from 'zod';
import { validTimeZone } from './calendar.js';

// Exact provider hosts: arbitrary URLs and custom ports are never accepted.
export function allowedPushEndpoint(value: string): boolean {
  try {
    if (value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname);
  } catch { return false; }
}
export const preferencesSchema = z.object({
  enabled: z.boolean(), fridayTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().max(100).refine(validTimeZone),
}).strict();
export const subscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(allowedPushEndpoint),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/).refine((key) => Buffer.from(key, 'base64url')[0] === 4),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }).strict(),
}).strict();
