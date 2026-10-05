import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PlatformProbe } from '../platform.js';
import * as schema from './schema.js';

export interface DatabaseProbeClient {
  unsafe: (query: string) => Promise<unknown>;
  end: (options: { timeout: number }) => Promise<unknown>;
}

export interface DatabaseAdapter extends PlatformProbe {
  close: () => Promise<void>;
}

export const createDatabaseWithClient = (client: DatabaseProbeClient): DatabaseAdapter => ({
  ping: async () => {
    await client.unsafe('SELECT 1');
  },
  close: async () => {
    await client.end({ timeout: 5 });
  },
});

export const createDatabase = (url: string, options: { max?: number; connectTimeoutSeconds?: number } = {}) => {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    ...(options.connectTimeoutSeconds === undefined ? {} : { connect_timeout: options.connectTimeoutSeconds }),
  });

  return {
    ...createDatabaseWithClient(client),
    db: drizzle(client, { schema }),
  };
};

export type ApplicationDatabase = ReturnType<typeof createDatabase>;

type RecoveringPoolClient = {
  reserve: () => Promise<{ release: () => void }>;
  end: (options: { timeout: number }) => Promise<unknown>;
};

type RecoveringPool = {
  client: RecoveringPoolClient;
  db: object;
};

export const createRecoveringDatabaseWithFactory = (createPool: () => RecoveringPool) => {
  let activePool: RecoveringPool | undefined = createPool();
  let rotation: Promise<void> | undefined;
  let closed = false;
  const dialect = Reflect.get(activePool.db, 'dialect', activePool.db);
  const currentPool = () => {
    if (closed) throw new Error('s2s_database_unavailable');
    if (!activePool) activePool = createPool();
    return activePool;
  };

  const poolClient = {
    reserve: async () => {
      if (rotation) await rotation.catch(() => undefined);
      if (closed) throw new Error('s2s_database_unavailable');
      const connection = await currentPool().client.reserve();
      if (closed) {
        connection.release();
        throw new Error('s2s_database_unavailable');
      }
      return connection;
    },
    end: (options: { timeout: number }) => {
      if (closed) return Promise.resolve();
      if (rotation) return rotation;
      const retiringPool = activePool;
      if (!retiringPool) return Promise.resolve();
      activePool = undefined;
      const ending = (async () => {
        try {
          await retiringPool.client.end(options);
        } finally {
          if (!closed) activePool = createPool();
        }
      })();
      rotation = ending;
      void ending.then(
        () => { if (rotation === ending) rotation = undefined; },
        () => { if (rotation === ending) rotation = undefined; },
      );
      return ending;
    },
  };

  const db = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
    get: (_target, property) => {
      if (property === '$client') return poolClient;
      if (property === 'dialect') return dialect;
      if (property === 'transaction') {
        return (...args: unknown[]) => {
          const run = () => {
            const pool = currentPool();
            const transaction = Reflect.get(pool.db, 'transaction', pool.db);
            return Reflect.apply(transaction, pool.db, args);
          };
          return rotation ? rotation.then(run, run) : run();
        };
      }
      if (closed) return undefined;
      const pool = currentPool();
      const value = Reflect.get(pool.db, property, pool.db);
      return typeof value === 'function' ? value.bind(pool.db) : value;
    },
  });

  return {
    db,
    close: async () => {
      closed = true;
      if (rotation) await rotation.catch(() => undefined);
      const pool = activePool;
      activePool = undefined;
      if (pool) await pool.client.end({ timeout: 5 });
    },
  };
};

export const createRecoveringDatabase = (url: string) => createRecoveringDatabaseWithFactory(() => {
  const client = postgres(url, { max: 1, idle_timeout: 20 });
  return { client, db: drizzle(client, { schema }) };
});
