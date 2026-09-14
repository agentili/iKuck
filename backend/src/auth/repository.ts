import { and, eq, gt, isNull } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import {
  authSessions,
  accountIdentities,
  emailVerificationTokens,
  passwordResetTokens,
  userProfiles,
  users,
} from '../db/schema.js';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  email: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

export interface AuthRepository {
  createUser: (input: { email: string; passwordHash: string | null; emailVerifiedAt?: Date | null }) => Promise<UserRecord>;
  createGoogleUser: (input: {
    email: string;
    providerSubject: string;
    providerEmail: string;
    emailVerifiedAt: Date;
  }) => Promise<UserRecord>;
  markEmailVerified: (userId: string, now: Date) => Promise<void>;
  findUserByEmail: (email: string) => Promise<UserRecord | null>;
  findUserById: (id: string) => Promise<UserRecord | null>;
  createVerificationToken: (input: { userId: string; tokenHash: string; expiresAt: Date }) => Promise<void>;
  consumeVerificationToken: (tokenHash: string, now: Date) => Promise<UserRecord | null>;
  createSession: (input: { userId: string; tokenHash: string; csrfTokenHash: string; expiresAt: Date }) => Promise<{ id: string }>;
  findSessionByTokenHash: (tokenHash: string, now: Date) => Promise<SessionRecord | null>;
  touchSession: (sessionId: string, now: Date) => Promise<void>;
  revokeSession: (tokenHash: string) => Promise<void>;
  revokeAllSessions: (userId: string) => Promise<void>;
  createPasswordResetToken: (input: { userId: string; tokenHash: string; expiresAt: Date }) => Promise<void>;
  consumePasswordResetToken: (tokenHash: string, now: Date) => Promise<string | null>;
  updatePassword: (userId: string, passwordHash: string, now: Date) => Promise<void>;
  findExternalIdentity: (provider: string, providerSubject: string) => Promise<{ userId: string } | null>;
  createExternalIdentity: (input: { userId: string; provider: string; providerSubject: string; providerEmail: string }) => Promise<void>;
}

const toUserRecord = (user: typeof users.$inferSelect): UserRecord => ({
  id: user.id,
  email: user.email,
  passwordHash: user.passwordHash,
  emailVerifiedAt: user.emailVerifiedAt,
});

export const createDrizzleAuthRepository = (database: ApplicationDatabase['db']): AuthRepository => ({
  createUser: async ({ email, passwordHash, emailVerifiedAt = null }) => database.transaction(async (transaction) => {
    const [user] = await transaction.insert(users).values({ email, passwordHash, emailVerifiedAt }).returning();
    await transaction.insert(userProfiles).values({ userId: user.id });
    return toUserRecord(user);
  }),

  createGoogleUser: async ({ email, providerSubject, providerEmail, emailVerifiedAt }) => database.transaction(async (transaction) => {
    const [user] = await transaction.insert(users).values({
      email,
      passwordHash: null,
      emailVerifiedAt,
    }).returning();
    await transaction.insert(accountIdentities).values({
      userId: user.id,
      provider: 'google',
      providerSubject,
      providerEmail,
    });
    return toUserRecord(user);
  }),

  markEmailVerified: async (userId, now) => {
    await database.update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
  },

  findUserByEmail: async (email) => {
    const [user] = await database.select().from(users).where(eq(users.email, email)).limit(1);
    return user === undefined ? null : toUserRecord(user);
  },

  findUserById: async (id) => {
    const [user] = await database.select().from(users).where(eq(users.id, id)).limit(1);
    return user === undefined ? null : toUserRecord(user);
  },

  createVerificationToken: async ({ userId, tokenHash, expiresAt }) => {
    await database.insert(emailVerificationTokens).values({ userId, tokenHash, expiresAt });
  },

  consumeVerificationToken: async (tokenHash, now) => database.transaction(async (transaction) => {
    const [token] = await transaction.select().from(emailVerificationTokens).where(and(
      eq(emailVerificationTokens.tokenHash, tokenHash),
      isNull(emailVerificationTokens.usedAt),
      gt(emailVerificationTokens.expiresAt, now),
    )).limit(1);
    if (token === undefined) return null;

    await transaction.update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(eq(emailVerificationTokens.id, token.id));
    const [user] = await transaction.update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(eq(users.id, token.userId))
      .returning();
    return user === undefined ? null : toUserRecord(user);
  }),

  createSession: async ({ userId, tokenHash, csrfTokenHash, expiresAt }) => {
    const [session] = await database.insert(authSessions)
      .values({ userId, tokenHash, csrfTokenHash, expiresAt })
      .returning({ id: authSessions.id });
    return session;
  },

  findSessionByTokenHash: async (tokenHash, now) => {
    const [result] = await database.select({ session: authSessions, user: users })
      .from(authSessions)
      .innerJoin(users, eq(authSessions.userId, users.id))
      .where(and(eq(authSessions.tokenHash, tokenHash), gt(authSessions.expiresAt, now)))
      .limit(1);
    if (result === undefined) return null;
    return {
      id: result.session.id,
      userId: result.session.userId,
      email: result.user.email,
      csrfTokenHash: result.session.csrfTokenHash,
      expiresAt: result.session.expiresAt,
    };
  },

  touchSession: async (sessionId, now) => {
    await database.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, sessionId));
  },

  revokeSession: async (tokenHash) => {
    await database.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash));
  },

  revokeAllSessions: async (userId) => {
    await database.delete(authSessions).where(eq(authSessions.userId, userId));
  },

  createPasswordResetToken: async ({ userId, tokenHash, expiresAt }) => {
    await database.insert(passwordResetTokens).values({ userId, tokenHash, expiresAt });
  },

  consumePasswordResetToken: async (tokenHash, now) => database.transaction(async (transaction) => {
    const [token] = await transaction.select().from(passwordResetTokens).where(and(
      eq(passwordResetTokens.tokenHash, tokenHash),
      isNull(passwordResetTokens.usedAt),
      gt(passwordResetTokens.expiresAt, now),
    )).limit(1);
    if (token === undefined) return null;

    await transaction.update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.id, token.id));
    return token.userId;
  }),

  updatePassword: async (userId, passwordHash, now) => {
    await database.update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, userId));
  },

  findExternalIdentity: async (provider, providerSubject) => {
    const [identity] = await database.select({ userId: accountIdentities.userId })
      .from(accountIdentities)
      .where(and(
        eq(accountIdentities.provider, provider),
        eq(accountIdentities.providerSubject, providerSubject),
      ))
      .limit(1);
    return identity ?? null;
  },

  createExternalIdentity: async ({ userId, provider, providerSubject, providerEmail }) => {
    await database.insert(accountIdentities).values({ userId, provider, providerSubject, providerEmail });
  },
});
