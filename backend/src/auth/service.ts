import type { AccountSummary } from '@ikuck/shared/contracts';
import type { EmailProvider } from '../providers/types.js';
import { hashPassword, verifyPassword } from './crypto.js';
import type { AuthRepository, SessionRecord, UserRecord } from './repository.js';
import { createOpaqueToken, hashOpaqueToken, type OpaqueToken } from './tokens.js';

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_verified'
  | 'email_already_registered'
  | 'invalid_token'
  | 'password_too_short'
  | 'provider_unavailable'
  | 'session_required'
  | 'csrf_failed'
  | 'invalid_payload';

export class AuthServiceError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthServiceError';
  }
}

export interface AuthenticatedSession {
  id: string;
  userId: string;
  email: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

export interface AuthService {
  register: (input: { email: string; password: string }) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  verifyEmail: (token: string) => Promise<AccountSummary>;
  login: (input: { email: string; password: string }) => Promise<{
    user: AccountSummary;
    sessionToken: string;
    csrfToken: string;
    expiresAt: Date;
  }>;
  restoreSession: (sessionToken: string) => Promise<{
    user: AccountSummary;
    csrfToken: string;
    expiresAt: Date;
  } | null>;
  authenticate: (sessionToken: string) => Promise<AuthenticatedSession | null>;
  logout: (sessionToken: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPassword: (input: { token: string; password: string }) => Promise<void>;
}

interface PasswordOperations {
  hash: (password: string) => Promise<string>;
  verify: (hash: string, password: string) => Promise<boolean>;
}

interface AuthServiceOptions {
  repository: AuthRepository;
  email: EmailProvider;
  appOrigin: string;
  clock?: () => Date;
  password?: PasswordOperations;
  tokenFactory?: () => OpaqueToken;
}

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const toAccountSummary = (user: UserRecord): AccountSummary => ({
  id: user.id,
  email: user.email,
  emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? '',
});

const toSession = (session: SessionRecord): AuthenticatedSession => ({
  id: session.id,
  userId: session.userId,
  email: session.email,
  csrfTokenHash: session.csrfTokenHash,
  expiresAt: session.expiresAt,
});

const ensurePasswordLength = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthServiceError('password_too_short', 400, 'Password must contain at least 12 characters');
  }
};

const sendVerificationEmail = async (email: EmailProvider, appOrigin: string, recipient: string, token: string): Promise<void> => {
  try {
    await email.send({
      to: recipient,
      subject: 'Conferma il tuo account iKuck',
      html: `<p>Conferma il tuo account iKuck.</p><p><a href="${appOrigin}/verify-email?token=${encodeURIComponent(token)}">Conferma email</a></p>`,
    });
  } catch {
    throw new AuthServiceError('provider_unavailable', 503, 'Email service is unavailable');
  }
};

const sendResetEmail = async (email: EmailProvider, appOrigin: string, recipient: string, token: string): Promise<void> => {
  try {
    await email.send({
      to: recipient,
      subject: 'Reimposta la password di iKuck',
      html: `<p>Puoi reimpostare la password del tuo account iKuck.</p><p><a href="${appOrigin}/reset-password?token=${encodeURIComponent(token)}">Reimposta password</a></p>`,
    });
  } catch {
    throw new AuthServiceError('provider_unavailable', 503, 'Email service is unavailable');
  }
};

export const createAuthService = ({
  repository,
  email,
  appOrigin,
  clock = () => new Date(),
  password = { hash: hashPassword, verify: verifyPassword },
  tokenFactory = createOpaqueToken,
}: AuthServiceOptions): AuthService => ({
  register: async ({ email: rawEmail, password: rawPassword }) => {
    ensurePasswordLength(rawPassword);
    const emailAddress = normalizeEmail(rawEmail);
    if (await repository.findUserByEmail(emailAddress) !== null) {
      throw new AuthServiceError('email_already_registered', 409, 'Email is already registered');
    }

    const user = await repository.createUser({
      email: emailAddress,
      passwordHash: await password.hash(rawPassword),
    });
    const verificationToken = tokenFactory();
    const now = clock();
    await repository.createVerificationToken({
      userId: user.id,
      tokenHash: verificationToken.hash,
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    });
    await sendVerificationEmail(email, appOrigin, emailAddress, verificationToken.raw);
  },

  resendVerification: async (rawEmail) => {
    const emailAddress = normalizeEmail(rawEmail);
    const user = await repository.findUserByEmail(emailAddress);
    if (user === null || user.emailVerifiedAt !== null) return;
    const verificationToken = tokenFactory();
    await repository.createVerificationToken({
      userId: user.id,
      tokenHash: verificationToken.hash,
      expiresAt: new Date(clock().getTime() + VERIFICATION_TTL_MS),
    });
    await sendVerificationEmail(email, appOrigin, emailAddress, verificationToken.raw);
  },

  verifyEmail: async (token) => {
    const user = await repository.consumeVerificationToken(hashOpaqueToken(token), clock());
    if (user === null) throw new AuthServiceError('invalid_token', 400, 'Verification token is invalid or expired');
    return toAccountSummary(user);
  },

  login: async ({ email: rawEmail, password: rawPassword }) => {
    const user = await repository.findUserByEmail(normalizeEmail(rawEmail));
    if (user === null || !(await password.verify(user.passwordHash, rawPassword))) {
      throw new AuthServiceError('invalid_credentials', 401, 'Invalid email or password');
    }
    if (user.emailVerifiedAt === null) {
      throw new AuthServiceError('email_not_verified', 403, 'Email verification is required');
    }

    const sessionToken = tokenFactory();
    const csrfToken = tokenFactory();
    const expiresAt = new Date(clock().getTime() + SESSION_TTL_MS);
    await repository.createSession({
      userId: user.id,
      tokenHash: sessionToken.hash,
      csrfTokenHash: csrfToken.hash,
      expiresAt,
    });
    return {
      user: toAccountSummary(user),
      sessionToken: sessionToken.raw,
      csrfToken: csrfToken.raw,
      expiresAt,
    };
  },

  restoreSession: async (sessionToken) => {
    const session = await repository.findSessionByTokenHash(hashOpaqueToken(sessionToken), clock());
    if (session === null) return null;
    const user = await repository.findUserById(session.userId);
    if (user === null || user.emailVerifiedAt === null) return null;
    const csrfToken = tokenFactory();
    await repository.rotateCsrfToken(session.id, csrfToken.hash);
    await repository.touchSession(session.id, clock());
    return { user: toAccountSummary(user), csrfToken: csrfToken.raw, expiresAt: session.expiresAt };
  },

  authenticate: async (sessionToken) => {
    const session = await repository.findSessionByTokenHash(hashOpaqueToken(sessionToken), clock());
    return session === null ? null : toSession(session);
  },

  logout: async (sessionToken) => {
    await repository.revokeSession(hashOpaqueToken(sessionToken));
  },

  requestPasswordReset: async (rawEmail) => {
    const emailAddress = normalizeEmail(rawEmail);
    const user = await repository.findUserByEmail(emailAddress);
    if (user === null) return;
    const resetToken = tokenFactory();
    await repository.createPasswordResetToken({
      userId: user.id,
      tokenHash: resetToken.hash,
      expiresAt: new Date(clock().getTime() + RESET_TTL_MS),
    });
    await sendResetEmail(email, appOrigin, emailAddress, resetToken.raw);
  },

  resetPassword: async ({ token, password: rawPassword }) => {
    ensurePasswordLength(rawPassword);
    const now = clock();
    const userId = await repository.consumePasswordResetToken(hashOpaqueToken(token), now);
    if (userId === null) throw new AuthServiceError('invalid_token', 400, 'Reset token is invalid or expired');
    await repository.updatePassword(userId, await password.hash(rawPassword), now);
    await repository.revokeAllSessions(userId);
  },
});
