import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { createAuthService } from './auth/service.js';
import { createCache } from './cache/client.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { createDrizzleAuthRepository } from './auth/repository.js';
import { createProviders } from './providers/factory.js';
import { createDrizzleProfileRepository } from './profile/repository.js';
import { createDrizzleSyncRepository } from './sync/repository.js';
import { createRedisGenerationRateLimiter } from './ai/rateLimit.js';

export const start = async () => {
  const config = loadConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  const cache = createCache(config.redisUrl);
  const providers = createProviders(config);
  const auth = createAuthService({
    repository: createDrizzleAuthRepository(database.db),
    email: providers.email,
    appOrigin: config.appOrigin,
  });
  const sync = createDrizzleSyncRepository(database.db);
  const profile = createDrizzleProfileRepository(database.db, sync);
  const app = createApp(
    {
      database,
      cache,
      auth: {
        service: auth,
        appOrigin: config.appOrigin,
        secureCookies: config.nodeEnvironment === 'production',
      },
      profile: {
        repository: profile,
        authService: auth,
        appOrigin: config.appOrigin,
        secureCookies: config.nodeEnvironment === 'production',
      },
      sync: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      pantryLots: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      shoppingList: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      activity: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      recipePreferences: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      dietProfile: { repository: sync, authService: auth, appOrigin: config.appOrigin },
      recipeNutrition: { provider: providers.nutrition, authService: auth, appOrigin: config.appOrigin },
      aiRecipes: {
        provider: providers.recipes,
        limiter: createRedisGenerationRateLimiter(cache),
        repository: sync,
        authService: auth,
        appOrigin: config.appOrigin,
      },
    },
    { logger: { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] } },
  );

  const shutdown = async () => {
    await Promise.allSettled([app.close(), database.close(), cache.close()]);
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
