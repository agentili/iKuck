import { describe, expect, it } from 'vitest';
import { parsePushPayload, safePushDestination } from './payload';

describe('push messages', () => {
  it('accepts a valid Monday deep link and rejects external or malformed URLs', () => {
    expect(safePushDestination('/plan?week=2026-11-09')).toBe('/plan?week=2026-11-09');
    for (const value of ['https://evil.test', '//evil.test', '/plan?week=2026-11-10', '/plan?week=2026-02-30', '/plan?week=2026-11-09&url=evil']) expect(safePushDestination(value)).toBeNull();
  });
  it('ignores expired and malformed push messages', () => {
    const message = { accountId: 'user', title: 'Piano', body: 'Completa', tag: 'weekly', url: '/plan?week=2026-11-09', expiresAt: '2026-11-07T00:00:00Z' };
    expect(parsePushPayload(message, Date.parse('2026-11-06'))).toEqual(message);
    expect(parsePushPayload(message, Date.parse('2026-11-08'))).toBeNull();
    expect(parsePushPayload({ ...message, title: 42 }, 0)).toBeNull();
    expect(parsePushPayload({ ...message, url: '//evil.test' }, 0)).toBeNull();
  });
});
