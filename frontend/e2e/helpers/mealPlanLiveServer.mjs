import { createRequire } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVISIONER_ID = 'ikuck-meal-plan-disposable-v1';
const POSTGRES_MARKER_TABLE = 'public.ikuck_e2e_ownership';
const REDIS_MARKER_KEY = 'ikuck:e2e:ownership';
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_PATTERN = /^t_[0-9a-f]{8,}$/i;
const PROOF_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$/;
const REDIS_RUN_ID_PATTERN = /^[0-9a-f]{40}$/i;
const LOOPBACK_HOST = '127.0.0.1';

const fail = (message) => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireString = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`Invalid disposable ownership manifest: ${label}`);
  return value;
};
const requirePort = (value, label) => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`Invalid disposable ownership manifest: ${label}`);
  return value;
};
const expectedDatabaseName = (runId) => `ikuck_e2e_${runId.replaceAll('-', '').toLowerCase()}`;

const readUrl = (value, protocols, label) => {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    fail(`Missing or invalid disposable ${label} URL`);
  }
  if (!protocols.includes(url.protocol) || url.hostname !== LOOPBACK_HOST || !url.port || url.search || url.hash) {
    fail(`Disposable ${label} target is not an isolated loopback endpoint`);
  }
  return url;
};

/**
 * The disposable provisioner writes this run/task/resource proof to both targets and its private manifest.
 * PostgreSQL marker: one row in public.ikuck_e2e_ownership with task_id, run_id, resource_id,
 * database_name, cluster_system_identifier, and proof_token. Redis marker: JSON at
 * ikuck:e2e:ownership with taskId, runId, resourceId, database, serverRunId, and proofToken.
 * The provisioner must create a fresh PostgreSQL cluster and Redis process for this run, then
 * remove only those exact resources after the test. This runner never provisions or deletes services.
 */
export const validateMealPlanLiveTarget = (env, manifest) => {
  if (env.IKUCK_MEAL_PLAN_DISPOSABLE !== 'true') fail('Disposable live-test opt-in is required');
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.provisioner !== PROVISIONER_ID) {
    fail('A resource manifest from the disposable-service provisioner is required');
  }
  const taskId = requireString(manifest.taskId, TASK_ID_PATTERN, 'taskId');
  const provisionedTaskId = env.IKUCK_MEAL_PLAN_TASK_ID;
  const activeTaskId = typeof env.HERMES_KANBAN_TASK === 'string' && env.HERMES_KANBAN_TASK !== ''
    ? env.HERMES_KANBAN_TASK
    : provisionedTaskId;
  if (typeof activeTaskId !== 'string' || activeTaskId !== taskId
    || (typeof provisionedTaskId === 'string' && provisionedTaskId !== taskId)) {
    fail('Disposable service ownership does not match the active task');
  }
  const runId = requireString(manifest.runId, RUN_ID_PATTERN, 'runId');
  if (!isRecord(manifest.postgres) || !isRecord(manifest.redis)) fail('Invalid disposable ownership manifest: targets');

  const postgres = manifest.postgres;
  const redis = manifest.redis;
  const postgresResourceId = requireString(postgres.resourceId, RESOURCE_ID_PATTERN, 'PostgreSQL resourceId');
  const redisResourceId = requireString(redis.resourceId, RESOURCE_ID_PATTERN, 'Redis resourceId');
  if (postgresResourceId === redisResourceId) fail('PostgreSQL and Redis must be separate disposable resources');

  const databaseName = expectedDatabaseName(runId);
  if (postgres.host !== LOOPBACK_HOST || postgres.database !== databaseName) {
    fail('PostgreSQL manifest does not identify a run-isolated database');
  }
  const postgresPort = requirePort(postgres.port, 'PostgreSQL port');
  const clusterSystemIdentifier = requireString(postgres.clusterSystemIdentifier, /^\d{10,30}$/, 'PostgreSQL cluster identifier');
  const postgresProofToken = requireString(postgres.proofToken, PROOF_TOKEN_PATTERN, 'PostgreSQL proof token');

  if (redis.host !== LOOPBACK_HOST || redis.database !== 0 || redis.markerKey !== REDIS_MARKER_KEY) {
    fail('Redis manifest does not identify the run-owned disposable service');
  }
  const redisPort = requirePort(redis.port, 'Redis port');
  const redisServerRunId = requireString(redis.serverRunId, REDIS_RUN_ID_PATTERN, 'Redis server run ID');
  const redisProofToken = requireString(redis.proofToken, PROOF_TOKEN_PATTERN, 'Redis proof token');

  const postgresUrl = readUrl(env.INTEGRATION_DATABASE_URL, ['postgres:', 'postgresql:'], 'PostgreSQL');
  if (postgresUrl.hostname !== postgres.host || Number(postgresUrl.port) !== postgresPort
    || decodeURIComponent(postgresUrl.pathname.slice(1)) !== databaseName) {
    fail('PostgreSQL connection target does not match the provisioned run');
  }
  const redisUrl = readUrl(env.INTEGRATION_REDIS_URL, ['redis:'], 'Redis');
  if (redisUrl.hostname !== redis.host || Number(redisUrl.port) !== redisPort || redisUrl.pathname !== '/0') {
    fail('Redis connection target does not match the provisioned run');
  }

  return Object.freeze({
    taskId,
    runId,
    manifest,
    postgres: Object.freeze({
      url: postgresUrl.toString(),
      resourceId: postgresResourceId,
      databaseName,
      clusterSystemIdentifier,
      proofToken: postgresProofToken,
    }),
    redis: Object.freeze({
      url: redisUrl.toString(),
      resourceId: redisResourceId,
      database: 0,
      markerKey: REDIS_MARKER_KEY,
      serverRunId: redisServerRunId,
      proofToken: redisProofToken,
    }),
  });
};

export const loadMealPlanLiveTarget = (env = process.env) => {
  if (env.IKUCK_MEAL_PLAN_DISPOSABLE !== 'true') fail('Disposable live-test opt-in is required');
  const manifestPath = env.IKUCK_MEAL_PLAN_RESOURCE_MANIFEST;
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '' || !isAbsolute(manifestPath)) {
    fail('IKUCK_MEAL_PLAN_RESOURCE_MANIFEST must be an absolute path from the disposable provisioner');
  }
  let manifest;
  try {
    const resolvedPath = resolve(manifestPath);
    const fileStat = lstatSync(resolvedPath);
    const fileIsPrivate = process.platform === 'win32'
      || (fileStat.uid === process.getuid() && (fileStat.mode & 0o077) === 0);
    if (!fileStat.isFile() || !fileIsPrivate) fail('Disposable resource manifest must be a private regular file');
    manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Disposable resource manifest')) throw error;
    fail('Unable to read the disposable resource manifest');
  }
  return validateMealPlanLiveTarget(env, manifest);
};

const matchesMarker = (actual, expected, keys) => isRecord(actual)
  && keys.every((key) => actual[key] === expected[key]);

export const verifyMealPlanLiveOwnership = (target, observations) => {
  if (!isRecord(observations) || !isRecord(observations.postgres) || !isRecord(observations.redis)) {
    fail('Disposable service ownership could not be verified');
  }
  const postgres = observations.postgres;
  const postgresExpected = {
    taskId: target.taskId,
    runId: target.runId,
    resourceId: target.postgres.resourceId,
    databaseName: target.postgres.databaseName,
    clusterSystemIdentifier: target.postgres.clusterSystemIdentifier,
    proofToken: target.postgres.proofToken,
  };
  if (postgres.databaseName !== target.postgres.databaseName
    || postgres.clusterSystemIdentifier !== target.postgres.clusterSystemIdentifier
    || !matchesMarker(postgres.marker, postgresExpected, Object.keys(postgresExpected))) {
    fail('PostgreSQL task-scoped ownership proof failed');
  }

  const redis = observations.redis;
  const redisExpected = {
    taskId: target.taskId,
    runId: target.runId,
    resourceId: target.redis.resourceId,
    database: target.redis.database,
    serverRunId: target.redis.serverRunId,
    proofToken: target.redis.proofToken,
  };
  if (redis.serverRunId !== target.redis.serverRunId
    || !matchesMarker(redis.marker, redisExpected, Object.keys(redisExpected))) {
    fail('Redis task-scoped ownership proof failed');
  }
};

export const bootMealPlanLiveServer = async ({ env, manifest, createRuntime }) => {
  const target = validateMealPlanLiveTarget(env, manifest);
  const runtime = await createRuntime(target);
  try {
    const [postgres, redis] = await Promise.all([
      runtime.readPostgresOwnership(),
      runtime.readRedisOwnership(),
    ]);
    verifyMealPlanLiveOwnership(target, { postgres, redis });

    // Ownership of both exact services is established before the first database write.
    // The PostgreSQL database is unique per run, and Redis is already a dedicated process; no FLUSHDB is used.
    await runtime.migrate();
    const app = await runtime.startServer();
    let closing = false;
    return {
      close: async () => {
        if (closing) return;
        closing = true;
        try {
          await app.close();
        } finally {
          await runtime.closeConnections();
        }
      },
    };
  } catch (error) {
    await runtime.closeConnections().catch(() => undefined);
    throw error;
  }
};

const parseRedisRunId = (info) => {
  const match = /^run_id:([0-9a-f]{40})$/im.exec(info);
  if (match === null) fail('Redis process identity could not be verified');
  return match[1];
};

const createMealPlanLiveRuntime = async (target) => {
  const require = createRequire(new URL('../../../backend/package.json', import.meta.url));
  const postgresModule = await import(require.resolve('postgres'));
  const postgres = postgresModule.default ?? postgresModule;
  const { createClient } = await import(require.resolve('redis'));
  const postgresClient = postgres(target.postgres.url, { max: 1, connect_timeout: 5, idle_timeout: 20 });
  const redisClient = createClient({
    url: target.redis.url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: () => false },
  });
  redisClient.on('error', () => undefined);
  try {
    await redisClient.connect();
  } catch {
    await postgresClient.end({ timeout: 5 }).catch(() => undefined);
    if (redisClient.isOpen) redisClient.destroy();
    fail('Unable to connect to the provisioned Redis service');
  }

  let databaseAdapter;
  let drizzleDatabase;
  const getDrizzleDatabase = async () => {
    if (drizzleDatabase !== undefined) return drizzleDatabase;
    const [{ drizzle }, schema] = await Promise.all([
      import(require.resolve('drizzle-orm/postgres-js')),
      import('../../../backend/dist/db/schema.js'),
    ]);
    drizzleDatabase = drizzle(postgresClient, { schema });
    return drizzleDatabase;
  };

  return {
    readPostgresOwnership: async () => {
      const [identity] = await postgresClient.unsafe(`
        SELECT current_database() AS database_name,
               (SELECT system_identifier::text FROM pg_control_system()) AS cluster_system_identifier
      `);
      const markers = await postgresClient.unsafe(`
        SELECT task_id AS "taskId", run_id::text AS "runId", resource_id AS "resourceId",
               database_name AS "databaseName", cluster_system_identifier::text AS "clusterSystemIdentifier",
               proof_token AS "proofToken"
          FROM ${POSTGRES_MARKER_TABLE}
         WHERE singleton = TRUE
      `);
      return {
        databaseName: identity?.database_name,
        clusterSystemIdentifier: identity?.cluster_system_identifier,
        marker: markers.length === 1 ? markers[0] : null,
      };
    },
    readRedisOwnership: async () => {
      const [info, markerText] = await Promise.all([
        redisClient.info('server'),
        redisClient.get(target.redis.markerKey),
      ]);
      return {
        serverRunId: parseRedisRunId(info),
        marker: markerText === null ? null : JSON.parse(markerText),
      };
    },
    migrate: async () => {
      const database = await getDrizzleDatabase();
      const { migrate } = await import(require.resolve('drizzle-orm/postgres-js/migrator'));
      await migrate(database, { migrationsFolder: fileURLToPath(new URL('../../../backend/src/db/migrations', import.meta.url)) });
    },
    startServer: async () => {
      const [appModule, databaseModule, cacheModule, authModule, authRepositoryModule, rateLimitModule,
        syncRepositoryModule, houseRepositoryModule, houseServiceModule, profileRepositoryModule] = await Promise.all([
        import('../../../backend/dist/app.js'),
        import('../../../backend/dist/db/client.js'),
        import('../../../backend/dist/cache/client.js'),
        import('../../../backend/dist/auth/service.js'),
        import('../../../backend/dist/auth/repository.js'),
        import('../../../backend/dist/auth/rateLimit.js'),
        import('../../../backend/dist/sync/repository.js'),
        import('../../../backend/dist/house/repository.js'),
        import('../../../backend/dist/house/service.js'),
        import('../../../backend/dist/profile/repository.js'),
      ]);
      const database = await getDrizzleDatabase();
      databaseAdapter = { ...databaseModule.createDatabaseWithClient(postgresClient), db: database };
      const cache = cacheModule.createCacheWithClient(redisClient);
      const appOrigin = 'http://127.0.0.1:5173';
      const auth = authModule.createAuthService({
        repository: authRepositoryModule.createDrizzleAuthRepository(database),
        appOrigin,
        autoVerifyEmail: true,
      });
      const rateLimiter = rateLimitModule.createRedisAuthRateLimiter(cache);
      const houseRepository = houseRepositoryModule.createDrizzleHouseRepository(database);
      const repository = syncRepositoryModule.createDrizzleSyncRepository(database, {
        mealPlanV2Enabled: true,
        scopeResolver: async (userId) => {
          const membership = await houseRepository.getMembershipForUser(userId);
          return membership === null ? null : { kind: 'house', id: membership.houseId };
        },
      });
      const houseService = houseServiceModule.createHouseService({ repository: houseRepository, syncRepository: repository });
      const route = { repository, authService: auth, appOrigin };
      const app = appModule.createApp({
        database: databaseAdapter,
        cache,
        auth: { service: auth, appOrigin, secureCookies: false, rateLimiter },
        sync: { ...route, rateLimiter },
        profile: {
          repository: profileRepositoryModule.createDrizzleProfileRepository(database, repository),
          authService: auth,
          appOrigin,
          secureCookies: false,
        },
        house: { service: houseService, authService: auth, appOrigin, rateLimiter },
        pantryLots: route,
        shoppingList: route,
        activity: route,
        recipePreferences: route,
        dietProfile: route,
      });
      await app.listen({ host: LOOPBACK_HOST, port: 3000 });
      return { close: () => app.close() };
    },
    closeConnections: async () => {
      await postgresClient.end({ timeout: 5 }).catch(() => undefined);
      if (redisClient.isOpen) redisClient.destroy();
    },
  };
};

const isMainModule = process.argv[1] !== undefined
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMainModule) {
  try {
    const target = loadMealPlanLiveTarget(process.env);
    const server = await bootMealPlanLiveServer({
      env: process.env,
      manifest: target.manifest,
      createRuntime: createMealPlanLiveRuntime,
    });
    const close = () => { void server.close().catch((error) => { console.error(error); process.exitCode = 1; }); };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Live test service startup failed');
    process.exitCode = 1;
  }
}
