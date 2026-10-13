import { describe, expect, it, vi } from 'vitest';
import { createGoogleIdentityProvider } from './google.js';

describe('Google identity provider', () => {
  it('verifies the configured audience and returns the stable Google subject', async () => {
    const verifyIdToken = vi.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-subject-1',
        email: 'person@example.com',
        email_verified: true,
        name: 'Person Example',
      }),
    });
    const provider = createGoogleIdentityProvider({ clientId: 'web-client-id', client: { verifyIdToken } });

    await expect(provider.verifyCredential('signed-id-token')).resolves.toEqual({
      subject: 'google-subject-1',
      email: 'person@example.com',
      emailVerified: true,
      displayName: 'Person Example',
    });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'signed-id-token', audience: 'web-client-id' });
  });

  it('rejects a Google credential without a verified email', async () => {
    const provider = createGoogleIdentityProvider({
      clientId: 'web-client-id',
      client: { verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => ({ sub: 'google-subject-1', email: 'person@example.com', email_verified: false }) }) },
    });

    await expect(provider.verifyCredential('signed-id-token')).rejects.toMatchObject({ name: 'GoogleIdentityError' });
  });

  it('logs the real verification failure reason without leaking the credential', async () => {
    const logger = { error: vi.fn() };
    const failure = Object.assign(new Error('Token verification failed: invalid signature'), { code: 'invalid_grant' });
    const provider = createGoogleIdentityProvider({
      clientId: 'web-client-id',
      client: { verifyIdToken: vi.fn().mockRejectedValue(failure) },
      logger,
    });

    await expect(provider.verifyCredential('leaked-secret-token')).rejects.toMatchObject({ name: 'GoogleIdentityError' });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [details, message] = logger.error.mock.calls[0]!;
    expect(message).toBe('Google credential verification failed');
    expect(details).toMatchObject({ provider: 'google', reason: 'Token verification failed: invalid signature', code: 'invalid_grant' });
    expect(JSON.stringify(details)).not.toContain('leaked-secret-token');
  });

  it('logs when the payload is missing a verified identity', async () => {
    const logger = { error: vi.fn() };
    const provider = createGoogleIdentityProvider({
      clientId: 'web-client-id',
      client: { verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => ({ sub: 'google-subject-1', email: 'person@example.com', email_verified: false }) }) },
      logger,
    });

    await expect(provider.verifyCredential('signed-id-token')).rejects.toMatchObject({ name: 'GoogleIdentityError' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', reason: 'Google credential is missing a verified identity' }),
      'Google credential verification failed',
    );
  });
});
