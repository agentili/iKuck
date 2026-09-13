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
});
