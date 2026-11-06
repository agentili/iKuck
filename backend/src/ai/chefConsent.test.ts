import { describe, expect, it } from 'vitest';
import { isAiConsent, aiConsentSyncSchema } from './validation.js';

const updatedAt = '2026-10-28T00:00:00.000Z';

describe('chef chat consent validation', () => {
  it('accepts a provider and policy only as a coherent pair, and rejects both from sync', () => {
    const consent = { enabled: true, updatedAt, chatProvider: 'openai', chatPolicyVersion: 'chef-chat-v1' };
    expect(isAiConsent(consent)).toBe(true);
    expect(isAiConsent({ enabled: true, updatedAt, chatProvider: 'openai' })).toBe(false);
    expect(isAiConsent({ enabled: true, updatedAt, chatPolicyVersion: 'chef-chat-v1' })).toBe(false);
    expect(aiConsentSyncSchema.safeParse(consent).success).toBe(false);
  });
});
