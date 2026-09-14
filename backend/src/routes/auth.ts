import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthServiceError, type AuthenticatedSession, type AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { GoogleIdentityError, type GoogleIdentityProvider } from '../auth/google.js';
import type { AuthRateLimiter } from '../auth/rateLimit.js';

export const SESSION_COOKIE_NAME = 'ikuck_session';

export interface AuthRouteDependencies {
  service: AuthService;
  google?: GoogleIdentityProvider;
  appOrigin: string;
  secureCookies: boolean;
  rateLimiter?: AuthRateLimiter;
}

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().max(256),
});

const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const resetSchema = credentialsSchema.extend({ token: z.string().min(32).max(256) });
const verifySchema = z.object({ token: z.string().min(32).max(256) });
const googleSchema = z.object({ credential: z.string().min(1).max(8192) });
const noOpRateLimiter: AuthRateLimiter = { enforce: async () => undefined };

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) throw new AuthServiceError('invalid_token', 400, 'Request payload is invalid');
  return result.data;
};

const readCookie = (header: string | undefined, name: string): string | null => {
  if (header === undefined) return null;
  const entry = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (entry === undefined) return null;
  return decodeURIComponent(entry.slice(name.length + 1));
};

const sessionCookie = (token: string, secure: boolean): string => [
  `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  ...(secure ? ['Secure'] : []),
].join('; ');

export const clearSessionCookie = (secure: boolean): string => [
  `${SESSION_COOKIE_NAME}=`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  'Max-Age=0',
  ...(secure ? ['Secure'] : []),
].join('; ');

export const ensureSameOrigin = (request: FastifyRequest, appOrigin: string): void => {
  if (request.headers.origin !== appOrigin) {
    throw new AuthServiceError('csrf_failed', 403, 'Request origin is not allowed');
  }
};

const getSessionToken = (request: FastifyRequest): string => {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  if (token === null) throw new AuthServiceError('session_required', 401, 'Authentication is required');
  return token;
};

export const requireSession = async (
  request: FastifyRequest,
  service: AuthService,
): Promise<{ token: string; session: AuthenticatedSession }> => {
  const token = getSessionToken(request);
  const session = await service.authenticate(token);
  if (session === null) throw new AuthServiceError('session_required', 401, 'Authentication is required');
  return { token, session };
};

export const ensureCsrf = (request: FastifyRequest, csrfTokenHash: string): void => {
  const csrfToken = request.headers['x-csrf-token'];
  if (typeof csrfToken !== 'string' || hashOpaqueToken(csrfToken) !== csrfTokenHash) {
    throw new AuthServiceError('csrf_failed', 403, 'CSRF token is invalid');
  }
};

export const registerAuthRoutes = ({ service, google, appOrigin, secureCookies, rateLimiter = noOpRateLimiter }: AuthRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/auth/register', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const credentials = parseBody(credentialsSchema, request.body);
    await rateLimiter.enforce('register', { ip: request.ip, email: credentials.email });
    const result = await service.register(credentials);
    return reply.code(202).send({
      status: result.verificationRequired ? 'verification_required' : 'registered',
      verificationRequired: result.verificationRequired,
    });
  });

  app.post('/v1/auth/resend-verification', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { email } = parseBody(emailSchema, request.body);
    await rateLimiter.enforce('resendVerification', { ip: request.ip, email });
    await service.resendVerification(email);
    return reply.code(202).send({ status: 'verification_required' });
  });

  app.get('/v1/auth/verify-email', async (request) => {
    const token = parseBody(verifySchema, request.query as { token?: string });
    const user = await service.verifyEmail(token.token);
    return { verified: true, user };
  });

  app.post('/v1/auth/login', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const credentials = parseBody(credentialsSchema, request.body);
    await rateLimiter.enforce('login', { ip: request.ip, email: credentials.email });
    const result = await service.login(credentials);
    reply.header('set-cookie', sessionCookie(result.sessionToken, secureCookies));
    return { authenticated: true, user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt.toISOString() };
  });

  app.post('/v1/auth/google', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    if (google === undefined) throw new AuthServiceError('provider_unavailable', 503, 'Google sign-in is unavailable');

    let identity;
    try {
      identity = await google.verifyCredential(parseBody(googleSchema, request.body).credential);
    } catch (error) {
      if (error instanceof GoogleIdentityError) {
        throw new AuthServiceError('invalid_google_credential', 401, 'Google credential is invalid');
      }
      throw new AuthServiceError('provider_unavailable', 503, 'Google sign-in is unavailable');
    }

    const result = await service.loginWithGoogle(identity);
    reply.header('set-cookie', sessionCookie(result.sessionToken, secureCookies));
    return { authenticated: true, user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt.toISOString() };
  });

  app.post('/v1/auth/google/link', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    if (google === undefined) throw new AuthServiceError('provider_unavailable', 503, 'Google sign-in is unavailable');
    const session = await requireSession(request, service);
    ensureCsrf(request, session.session.csrfTokenHash);

    let identity;
    try {
      identity = await google.verifyCredential(parseBody(googleSchema, request.body).credential);
    } catch (error) {
      if (error instanceof GoogleIdentityError) {
        throw new AuthServiceError('invalid_google_credential', 401, 'Google credential is invalid');
      }
      throw new AuthServiceError('provider_unavailable', 503, 'Google sign-in is unavailable');
    }

    await service.linkGoogle(session.session.userId, identity);
    return reply.code(204).send();
  });

  app.get('/v1/auth/session', async (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    if (token === null) return { authenticated: false };
    const result = await service.restoreSession(token);
    if (result === null) {
      reply.header('set-cookie', clearSessionCookie(secureCookies));
      return { authenticated: false };
    }
    return { authenticated: true, user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt.toISOString() };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const session = await requireSession(request, service);
    ensureCsrf(request, session.session.csrfTokenHash);
    await service.logout(session.token);
    reply.header('set-cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });

  app.post('/v1/auth/request-password-reset', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { email } = parseBody(emailSchema, request.body);
    await rateLimiter.enforce('requestPasswordReset', { ip: request.ip, email });
    await service.requestPasswordReset(email);
    return reply.code(202).send({ status: 'reset_requested' });
  });

  app.post('/v1/auth/reset-password', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    await service.resetPassword(parseBody(resetSchema, request.body));
    return reply.code(204).send();
  });
};
