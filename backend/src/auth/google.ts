import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
}

export class GoogleIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleIdentityError';
  }
}

interface GoogleTokenPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface GoogleTokenTicket {
  getPayload: () => GoogleTokenPayload | undefined;
}

interface GoogleTokenClient {
  verifyIdToken: (input: { idToken: string; audience: string }) => Promise<GoogleTokenTicket>;
}

export interface GoogleIdentityProvider {
  verifyCredential: (credential: string) => Promise<GoogleIdentity>;
}

export const createGoogleIdentityProvider = (input: {
  clientId: string;
  client?: GoogleTokenClient;
}): GoogleIdentityProvider => {
  const client = input.client ?? new OAuth2Client(input.clientId);

  return {
    verifyCredential: async (credential) => {
      try {
        const ticket = await client.verifyIdToken({ idToken: credential, audience: input.clientId });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email || payload.email_verified !== true) {
          throw new GoogleIdentityError('Google credential is missing a verified identity');
        }
        return {
          subject: payload.sub,
          email: payload.email,
          emailVerified: true,
          displayName: payload.name,
        };
      } catch (error) {
        if (error instanceof GoogleIdentityError) throw error;
        throw new GoogleIdentityError('Google credential could not be verified');
      }
    },
  };
};
