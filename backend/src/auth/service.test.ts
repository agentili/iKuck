import { describe, expect, it, vi } from 'vitest';
import type { EmailProvider } from '../providers/types.js';
import type { AuthRepository, UserRecord } from './repository.js';
import { createAuthService } from './service.js';

const user: UserRecord = {
  id: 'user-1',
  email: 'user@example.com',
  passwordHash: 'stored-hash',
  emailVerifiedAt: null,
};

const repositoryWith = (overrides: Partial<AuthRepository> = {}): AuthRepository => ({
  createUser: vi.fn(),
  findUserByEmail: vi.fn().mockResolvedValue(user),
  findUserById: vi.fn().mockResolvedValue(user),
  createVerificationToken: vi.fn(),
  consumeVerificationToken: vi.fn(),
  createSession: vi.fn(),
  findSessionByTokenHash: vi.fn(),
  rotateCsrfToken: vi.fn(),
  touchSession: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllSessions: vi.fn(),
  createPasswordResetToken: vi.fn(),
  consumePasswordResetToken: vi.fn(),
  updatePassword: vi.fn(),
  ...overrides,
});

const email: EmailProvider = { send: vi.fn().mockResolvedValue({ messageId: 'message-1' }) };

describe('authentication service', () => {
  it('does not permit login before email verification', async () => {
    const service = createAuthService({
      repository: repositoryWith(),
      email,
      appOrigin: 'http://127.0.0.1:5173',
      password: {
        hash: vi.fn().mockResolvedValue('new-hash'),
        verify: vi.fn().mockResolvedValue(true),
      },
    });

    await expect(service.login({ email: 'user@example.com', password: 'password' }))
      .rejects.toMatchObject({ code: 'email_not_verified' });
  });
});
