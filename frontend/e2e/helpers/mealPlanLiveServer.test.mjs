import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as liveServer from './mealPlanLiveServer.mjs';

const helperUrl = new URL('./mealPlanLiveServer.mjs', import.meta.url).href;
const taskId = 't_7401eb8e';
const runId = 'f08d7e9a-2e51-4815-a6e2-fd9f35b924ca';
const databaseName = `ikuck_e2e_${runId.replaceAll('-', '')}`;
const pgSystemId = '7429123456789012345';
const redisServerRunId = '1'.repeat(40);

const makeManifest = () => ({
  schemaVersion: 1,
  provisioner: 'ikuck-meal-plan-disposable-v1',
  taskId,
  runId,
  postgres: {
    resourceId: `docker:pg:${runId}`,
    host: '127.0.0.1',
    port: 57432,
    database: databaseName,
    clusterSystemIdentifier: pgSystemId,
    proofToken: 'a'.repeat(64),
  },
  redis: {
    resourceId: `docker:redis:${runId}`,
    host: '127.0.0.1',
    port: 57379,
    database: 0,
    markerKey: 'ikuck:e2e:ownership',
    serverRunId: redisServerRunId,
    proofToken: 'b'.repeat(64),
  },
});

const makeEnvironment = (manifest) => ({
  IKUCK_MEAL_PLAN_DISPOSABLE: 'true',
  IKUCK_MEAL_PLAN_TASK_ID: taskId,
  INTEGRATION_DATABASE_URL: `postgres://integration:integration@127.0.0.1:${manifest.postgres.port}/${manifest.postgres.database}`,
  INTEGRATION_REDIS_URL: `redis://127.0.0.1:${manifest.redis.port}/0`,
});

const makeObservations = (manifest) => ({
  postgres: {
    databaseName: manifest.postgres.database,
    clusterSystemIdentifier: manifest.postgres.clusterSystemIdentifier,
    marker: {
      taskId: manifest.taskId,
      runId: manifest.runId,
      resourceId: manifest.postgres.resourceId,
      databaseName: manifest.postgres.database,
      clusterSystemIdentifier: manifest.postgres.clusterSystemIdentifier,
      proofToken: manifest.postgres.proofToken,
    },
  },
  redis: {
    serverRunId: manifest.redis.serverRunId,
    marker: {
      taskId: manifest.taskId,
      runId: manifest.runId,
      resourceId: manifest.redis.resourceId,
      serverRunId: manifest.redis.serverRunId,
      database: manifest.redis.database,
      proofToken: manifest.redis.proofToken,
    },
  },
});

const makeRuntime = (observations) => {
  const calls = {
    postgresChecks: 0,
    redisChecks: 0,
    migrations: 0,
    flushes: 0,
    resourceCleanups: 0,
    serverStarts: 0,
    connectionCloses: 0,
  };
  const events = [];
  return {
    calls,
    events,
    runtime: {
      readPostgresOwnership: async () => { calls.postgresChecks += 1; events.push('postgres-check'); return observations.postgres; },
      readRedisOwnership: async () => { calls.redisChecks += 1; events.push('redis-check'); return observations.redis; },
      migrate: async () => { calls.migrations += 1; events.push('migrate'); },
      flushDb: async () => { calls.flushes += 1; events.push('flush'); },
      cleanupOwnedResources: async () => { calls.resourceCleanups += 1; events.push('cleanup'); },
      startServer: async () => {
        calls.serverStarts += 1;
        events.push('start-server');
        return { close: async () => undefined };
      },
      closeConnections: async () => { calls.connectionCloses += 1; },
    },
  };
};

const runBoot = (manifest, observations, environment = makeEnvironment(manifest)) => {
  const fake = makeRuntime(observations);
  let runtimeCreations = 0;
  const promise = liveServer.bootMealPlanLiveServer({
    env: environment,
    manifest,
    createRuntime: async () => { runtimeCreations += 1; return fake.runtime; },
  });
  return { fake, promise, getRuntimeCreations: () => runtimeCreations };
};

const assertRejectedWithoutSideEffects = async (manifest, observations, environment = makeEnvironment(manifest)) => {
  const run = runBoot(manifest, observations, environment);
  await assert.rejects(run.promise);
  assert.equal(run.fake.calls.migrations, 0, 'migrations must not run before both ownership proofs pass');
  assert.equal(run.fake.calls.flushes, 0, 'Redis must never be flushed');
  assert.equal(run.fake.calls.resourceCleanups, 0, 'resources must not be cleaned up after a failed ownership proof');
  assert.equal(run.fake.calls.serverStarts, 0, 'the live app must not start after a failed ownership proof');
  assert.equal(run.fake.events.some((event) => ['migrate', 'flush', 'cleanup', 'start-server'].includes(event)), false);
  return run;
};

test('importing the live-server helper does not start its server or touch service targets', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(helperUrl)});`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IKUCK_MEAL_PLAN_DISPOSABLE: 'true',
      INTEGRATION_DATABASE_URL: 'postgres://integration:integration@127.0.0.1:65432/ikuck_e2e_import_only',
      INTEGRATION_REDIS_URL: 'redis://127.0.0.1:65433/0',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rejects a missing provisioner manifest before any target connection', () => {
  assert.throws(() => liveServer.loadMealPlanLiveTarget({ IKUCK_MEAL_PLAN_DISPOSABLE: 'true' }), /manifest/i);
});

test('rejects a manifest not provisioned for the active task before connecting', async () => {
  const manifest = makeManifest();
  const environment = makeEnvironment(manifest);
  environment.IKUCK_MEAL_PLAN_TASK_ID = 't_deadbeef';
  const run = runBoot(manifest, makeObservations(manifest), environment);
  await assert.rejects(run.promise);
  assert.equal(run.getRuntimeCreations(), 0);
  assert.equal(run.fake.calls.migrations, 0);
  assert.equal(run.fake.calls.flushes, 0);
  assert.equal(run.fake.calls.resourceCleanups, 0);
  assert.equal(run.fake.calls.serverStarts, 0);
});

test('accepts only matching task-owned PostgreSQL and Redis targets before migrating', async () => {
  const manifest = makeManifest();
  const run = runBoot(manifest, makeObservations(manifest));
  const server = await run.promise;

  assert.equal(run.fake.calls.postgresChecks, 1);
  assert.equal(run.fake.calls.redisChecks, 1);
  assert.equal(run.fake.calls.migrations, 1);
  assert.equal(run.fake.calls.flushes, 0);
  assert.equal(run.fake.calls.resourceCleanups, 0);
  assert.equal(run.fake.calls.serverStarts, 1);
  assert.deepEqual(run.fake.events, ['postgres-check', 'redis-check', 'migrate', 'start-server']);
  await server.close();
});

test('rejects missing PostgreSQL ownership marker without service side effects', async () => {
  const manifest = makeManifest();
  const observations = makeObservations(manifest);
  observations.postgres.marker = null;
  await assertRejectedWithoutSideEffects(manifest, observations);
});

test('rejects a mismatched task/run proof marker without service side effects', async () => {
  const manifest = makeManifest();
  const observations = makeObservations(manifest);
  observations.postgres.marker.runId = '00000000-0000-4000-8000-000000000000';
  await assertRejectedWithoutSideEffects(manifest, observations);
});

test('rejects a Redis marker from another task without service side effects', async () => {
  const manifest = makeManifest();
  const observations = makeObservations(manifest);
  observations.redis.marker.taskId = 't_deadbeef';
  await assertRejectedWithoutSideEffects(manifest, observations);
});

test('rejects a missing Redis ownership marker without service side effects', async () => {
  const manifest = makeManifest();
  const observations = makeObservations(manifest);
  observations.redis.marker = null;
  await assertRejectedWithoutSideEffects(manifest, observations);
});

test('rejects a foreign PostgreSQL cluster or Redis process without service side effects', async (t) => {
  for (const [name, change] of [
    ['PostgreSQL cluster identifier mismatch', (observations) => { observations.postgres.clusterSystemIdentifier = '1'; }],
    ['Redis process run ID mismatch', (observations) => { observations.redis.serverRunId = '2'.repeat(40); }],
  ]) {
    await t.test(name, async () => {
      const manifest = makeManifest();
      const observations = makeObservations(manifest);
      change(observations);
      await assertRejectedWithoutSideEffects(manifest, observations);
    });
  }
});

test('rejects a non-isolated or non-loopback destination before connecting', async () => {
  for (const [name, mutateEnvironment] of [
    ['shared integration database name', (environment) => {
      environment.INTEGRATION_DATABASE_URL = 'postgres://integration:integration@127.0.0.1:57432/ikuck_integration';
    }],
    ['remote PostgreSQL endpoint', (environment) => {
      environment.INTEGRATION_DATABASE_URL = `postgres://integration:integration@db.example.test:57432/${databaseName}`;
    }],
    ['non-default Redis database namespace', (environment) => {
      environment.INTEGRATION_REDIS_URL = 'redis://127.0.0.1:57379/15';
    }],
    ['task ID not provisioned for this run', (environment) => {
      environment.IKUCK_MEAL_PLAN_TASK_ID = 't_deadbeef';
    }],
  ]) {
    const manifest = makeManifest();
    const environment = makeEnvironment(manifest);
    mutateEnvironment(environment);
    const run = runBoot(manifest, makeObservations(manifest), environment);
    await assert.rejects(run.promise);
    assert.equal(run.getRuntimeCreations(), 0, `${name}: target connections must not be opened`);
    assert.equal(run.fake.calls.migrations, 0);
    assert.equal(run.fake.calls.flushes, 0);
    assert.equal(run.fake.calls.resourceCleanups, 0);
    assert.equal(run.fake.calls.serverStarts, 0);
  }
});
