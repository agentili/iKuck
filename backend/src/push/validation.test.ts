import { generateVAPIDKeys } from 'web-push';
import { describe, expect, it } from 'vitest';
import { allowedPushEndpoint, preferencesSchema, subscriptionSchema } from './validation.js';
import { loadConfig } from '../config.js';

describe('push input and configuration', () => {
  it.each(['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.evil.test/a', 'https://fcm.googleapis.com:444/a', 'https://user@fcm.googleapis.com/a', 'https://internal.test/a', 'https://fcm.googleapis.com/è', 'https://fcm.googleapis.com/' + 'a'.repeat(2048)])('rejects endpoint %s', (url) => expect(allowedPushEndpoint(url)).toBe(false));
  it.each(['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com'])('accepts supported provider %s', (host) => expect(allowedPushEndpoint(`https://${host}/token`)).toBe(true));
  it('validates keys, time, timezone, and exact preference fields', () => {
    const valid = { endpoint: 'https://fcm.googleapis.com/send/token', keys: { p256dh: generateVAPIDKeys().publicKey, auth: Buffer.alloc(16).toString('base64url') } };
    expect(subscriptionSchema.safeParse(valid).success).toBe(true);
    expect(subscriptionSchema.safeParse({ ...valid, keys: { ...valid.keys, auth: 'invalid' } }).success).toBe(false);
    expect(preferencesSchema.safeParse({ enabled: true, fridayTime: '19:00', timeZone: 'Europe/Rome' }).success).toBe(true);
    expect(preferencesSchema.safeParse({ enabled: true, fridayTime: '24:00', timeZone: 'local' }).success).toBe(false);
  });
  it('keeps push disabled by default and requires VAPID only when enabled', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).pushEnabled).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'development', PUSH_ENABLED: 'true' })).toThrow();
    const keys = generateVAPIDKeys();
    expect(loadConfig({ NODE_ENV: 'development', PUSH_ENABLED: 'true', PUSH_VAPID_PUBLIC_KEY: keys.publicKey, PUSH_VAPID_PRIVATE_KEY: keys.privateKey, PUSH_VAPID_SUBJECT: 'mailto:push@example.com' }).pushEnabled).toBe(true);
  });
});
