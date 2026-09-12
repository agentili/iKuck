import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';

export const SESSION_COOKIE_NAME = 'ikuck_session';

export interface AuthRouteDependencies {
  service: AuthService;
  appOrigin: string;
  secureCookies: boolean;
}

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().max(256),
});

const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const resetSchema = credentialsSchema.extend({ token: z.string().min(32).max(256) });
const verifySchema = z.object({ token: z.string().min(32).max(256) });

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

const clearSessionCookie = (secure: boolean): string => [
  `${SESSION_COOKIE_NAME}=`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  'Max-Age=0',
  ...(secure ? ['Secure'] : []),
].join('; ');

const ensureSameOrigin = (request: FastifyRequest, appOrigin: string): void => {
  if (request.headers.origin !== appOrigin) {
    throw new AuthServiceError('csrf_failed', 403, 'Request origin is not allowed');
  }
};

const getSessionToken = (request: FastifyRequest): string => {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  if (token === null) throw new AuthServiceError('session_required', 401, 'Authentication is required');
  return token;
};

const requireSession = async (
  request: FastifyRequest,
  service: AuthService,
): Promise<{ token: string; csrfTokenHash: string }> => {
  const token = getSessionToken(request);
  const session = await service.authenticate(token);
  if (session === null) throw new AuthServiceError('session_required', 401, 'Authentication is required');
  return { token, csrfTokenHash: session.csrfTokenHash };
};

const ensureCsrf = (request: FastifyRequest, csrfTokenHash: string): void => {
  const csrfToken = request.headers['x-csrf-token'];
  if (typeof csrfToken !== 'string' || hashOpaqueToken(csrfToken) !== csrfTokenHash) {
    throw new AuthServiceError('csrf_failed', 403, 'CSRF token is invalid');
  }
};

export const registerAuthRoutes = ({ service, appOrigin, secureCookies }: AuthRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/auth/register', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    await service.register(parseBody(credentialsSchema, request.body));
    return reply.code(202).send({ status: 'verification_required' });
  });

  app.post('/v1/auth/resend-verification', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    await service.resendVerification(parseBody(emailSchema, request.body).email);
    return reply.code(202).send({ status: 'verification_required' });
  });

  app.get('/v1/auth/verify-email', async (request) => {
    const token = parseBody(verifySchema, request.query as { token?: string });
    const user = await service.verifyEmail(token.token);
    return { verified: true, user };
  });

  app.post('/v1/auth/login', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const result = await service.login(parseBody(credentialsSchema, request.body));
    reply.header('set-cookie', sessionCookie(result.sessionToken, secureCookies));
    return { authenticated: true, user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt.toISOString() };
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
    ensureCsrf(request, session.csrfTokenHash);
    await service.logout(session.token);
    reply.header('set-cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });

  app.post('/v1/auth/request-password-reset', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    await service.requestPasswordReset(parseBody(emailSchema, request.body).email);
    return reply.code(202).send({ status: 'reset_requested' });
  });

  app.post('/v1/auth/reset-password', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    await service.resetPassword(parseBody(resetSchema, request.body));
    return reply.code(204).send();
  });
};
