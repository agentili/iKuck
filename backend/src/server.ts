import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { createAuthService } from './auth/service.js';
import { createCache } from './cache/client.js';
import { loadConfig } from './config.js';
import { createDatabase, createRecoveringDatabase } from './db/client.js';
import { createDrizzleAuthRepository } from './auth/repository.js';
import { createProviders } from './providers/factory.js';
import { createDrizzleProfileRepository } from './profile/repository.js';
import { createDrizzleSyncRepository } from './sync/repository.js';
import { createDrizzleHouseRepository } from './house/repository.js';
import { createHouseService } from './house/service.js';
import { createRedisGenerationRateLimiter } from './ai/rateLimit.js';
import { createGoogleIdentityProvider } from './auth/google.js';
import { createRedisAuthRateLimiter } from './auth/rateLimit.js';
import { createDrizzleS2sRepository, S2sRepositoryError } from './s2s/repository.js';
import { createS2sDinnerContextService } from './s2s/dinnerContext.js';
import { createRedisS2sRateLimiter } from './s2s/rateLimit.js';
import { createServerLoggerOptions } from './serverLogging.js';
import { closeServerResources } from './serverShutdown.js';

export const start = async () => {
  const config = loadConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  const s2sDatabase = config.s2sDinnerContextEnabled ? createRecoveringDatabase(config.databaseUrl) : undefined;
  const cache = createCache(config.redisUrl);
  const s2sRateCache = config.s2sDinnerContextEnabled
    ? createCache(config.redisUrl, { disableOfflineQueue: true, connectOnDemand: false, connectOnCreate: true, reconnectOnDemand: true })
    : undefined;
  const authRateLimiter = createRedisAuthRateLimiter(cache);
  const providers = createProviders(config);
  const auth = createAuthService({
    repository: createDrizzleAuthRepository(database.db),
    email: providers.email,
    appOrigin: config.appOrigin,
    autoVerifyEmail: config.nodeEnvironment === 'development',
  });
  const houseRepository = createDrizzleHouseRepository(database.db);
  const sync = createDrizzleSyncRepository(database.db, {
    maxClientClockSkewMs: config.syncMaxClientClockSkewMs,
    scopeResolver: async (userId) => {
      const membership = await houseRepository.getMembershipForUser(userId);
      return membership === null ? null : { kind: 'house', id: membership.houseId };
    },
  });
  const houseService = createHouseService({ repository: houseRepository, syncRepository: sync });
  const profile = createDrizzleProfileRepository(database.db, sync);
  const s2sRepository = createDrizzleS2sRepository((s2sDatabase ?? database).db);
  const s2sDinnerContext = createS2sDinnerContextService({
    enabled: config.s2sDinnerContextEnabled,
    source: { readAuthorizedSnapshot: async (token, options) => {
      const [keyId, secret] = token.split('.');
      try {
        const snapshot = await s2sRepository.readAuthorizedSnapshot({ keyId: keyId!, secret: secret! }, options);
        return { ...snapshot, grant: { keyId: snapshot.grant.keyId, digest: '', enabled: true, expiresAt: snapshot.grant.expiresAt, scope: snapshot.grant.scope } };
      } catch (error) { if (error instanceof S2sRepositoryError && error.code === 'service_auth_required') return null; throw error; }
    } },
    rateLimiter: createRedisS2sRateLimiter(s2sRateCache ?? cache),
    requestTimeoutMs: 5000,
  });
  const app = createApp(
    {
      database,
      cache,
      auth: {
        service: auth,
        google: config.googleClientId === undefined ? undefined : createGoogleIdentityProvider({ clientId: config.googleClientId }),
        appOrigin: config.appOrigin,
        secureCookies: config.nodeEnvironment === 'production',
        rateLimiter: authRateLimiter,
      },
      profile: {
        repository: profile,
        authService: auth,
        appOrigin: config.appOrigin,
        secureCookies: config.nodeEnvironment === 'production',
      },
      sync: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      house: { service: houseService, authService: auth, appOrigin: config.appOrigin, rateLimiter: authRateLimiter },
      dinnerDiary: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      s2sDinnerContext,
      pantryLots: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      shoppingList: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      activity: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      recipePreferences: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      dietProfile: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      recipeNutrition: { provider: providers.nutrition, authService: auth, appOrigin: config.appOrigin },
      aiRecipes: {
        provider: providers.recipes,
        dinnerReconstructionProvider: providers.dinnerReconstruction,
        limiter: createRedisGenerationRateLimiter(cache),
        repository: sync,
        authService: auth,
        appOrigin: config.appOrigin,
        recipeProvider: config.providers.recipeProvider ?? 'openai',
      },
    },
    {
      logger: createServerLoggerOptions(config.logLevel),
      trustProxy: config.trustProxy,
    },
  );

  const shutdown = async () => {
    await closeServerResources(
      () => app.close(),
      [
        () => database.close(),
        ...(s2sDatabase === undefined ? [] : [() => s2sDatabase.close()]),
        () => cache.close(),
        ...(s2sRateCache === undefined ? [] : [() => s2sRateCache.close()]),
      ],
      () => {
        app.log.warn('Forcing HTTP connections closed after the shutdown drain timeout');
        app.server.closeAllConnections();
      },
    );
  };

  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ error }, 'Unable to start API server');
    await shutdown();
    throw error;
  }
};

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void start().catch(() => {
    process.exitCode = 1;
  });
}
