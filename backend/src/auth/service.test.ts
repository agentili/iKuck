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
  markEmailVerified: vi.fn().mockResolvedValue(undefined),
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
  findExternalIdentity: vi.fn().mockResolvedValue(null),
  createExternalIdentity: vi.fn().mockResolvedValue(undefined),
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

  it('auto-verifies local registrations without requiring an email provider', async () => {
    const now = new Date('2026-09-13T12:00:00.000Z');
    const createdUser: UserRecord = {
      id: 'local-user-1',
      email: 'local@example.com',
      passwordHash: 'new-hash',
      emailVerifiedAt: now,
    };
    const createUser = vi.fn().mockResolvedValue(createdUser);
    const unavailableEmail: EmailProvider = { send: vi.fn().mockRejectedValue(new Error('email provider is not configured')) };
    const service = createAuthService({
      repository: repositoryWith({
        findUserByEmail: vi.fn().mockResolvedValue(null),
        createUser,
      }),
      email: unavailableEmail,
      appOrigin: 'http://localhost:5173',
      clock: () => now,
      autoVerifyEmail: true,
      password: {
        hash: vi.fn().mockResolvedValue('new-hash'),
        verify: vi.fn().mockResolvedValue(true),
      },
    });

    await expect(service.register({ email: 'Local@Example.com', password: 'a long enough password' }))
      .resolves.toEqual({ verificationRequired: false });
    expect(createUser).toHaveBeenCalledWith({
      email: 'local@example.com',
      passwordHash: 'new-hash',
      emailVerifiedAt: now,
    });
    expect(unavailableEmail.send).not.toHaveBeenCalled();
  });

  it('repairs an unverified local account on development login', async () => {
    const now = new Date('2026-09-13T12:00:00.000Z');
    const unverifiedUser: UserRecord = {
      ...user,
      emailVerifiedAt: null,
    };
    const markEmailVerified = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockResolvedValue({ id: 'session-1' });
    const service = createAuthService({
      repository: repositoryWith({
        findUserByEmail: vi.fn().mockResolvedValue(unverifiedUser),
        markEmailVerified,
        createSession,
      }),
      email,
      appOrigin: 'http://localhost:5173',
      autoVerifyEmail: true,
      clock: () => now,
      tokenFactory: vi.fn()
        .mockReturnValueOnce({ raw: 'session-token', hash: 'session-hash' })
        .mockReturnValueOnce({ raw: 'csrf-token', hash: 'csrf-hash' }),
      password: {
        hash: vi.fn().mockResolvedValue('new-hash'),
        verify: vi.fn().mockResolvedValue(true),
      },
    });

    await expect(service.login({ email: 'user@example.com', password: 'password' }))
      .resolves.toMatchObject({ user: { emailVerifiedAt: now.toISOString() } });
    expect(markEmailVerified).toHaveBeenCalledWith('user-1', now);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('creates a verified local account for a new Google identity', async () => {
    const now = new Date('2026-09-13T12:00:00.000Z');
    const createdUser: UserRecord = {
      id: 'google-user-1',
      email: 'google@example.com',
      passwordHash: null,
      emailVerifiedAt: now,
    };
    const createUser = vi.fn().mockResolvedValue(createdUser);
    const createExternalIdentity = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockResolvedValue({ id: 'session-1' });
    const service = createAuthService({
      repository: repositoryWith({
        findUserByEmail: vi.fn().mockResolvedValue(null),
        createUser,
        createExternalIdentity,
        createSession,
      }),
      email,
      appOrigin: 'http://127.0.0.1:5173',
      clock: () => now,
      tokenFactory: vi.fn()
        .mockReturnValueOnce({ raw: 'session-token', hash: 'session-hash' })
        .mockReturnValueOnce({ raw: 'csrf-token', hash: 'csrf-hash' }),
    });

    await expect(service.loginWithGoogle({
      subject: 'google-subject-1',
      email: 'Google@Example.com',
      emailVerified: true,
    })).resolves.toMatchObject({
      user: { id: 'google-user-1', email: 'google@example.com', emailVerifiedAt: now.toISOString() },
      sessionToken: 'session-token',
      csrfToken: 'csrf-token',
    });
    expect(createUser).toHaveBeenCalledWith({ email: 'google@example.com', passwordHash: null, emailVerifiedAt: now });
    expect(createExternalIdentity).toHaveBeenCalledWith({
      userId: 'google-user-1',
      provider: 'google',
      providerSubject: 'google-subject-1',
      providerEmail: 'google@example.com',
    });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'google-user-1' }));
  });
});
