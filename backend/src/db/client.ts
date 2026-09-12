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

export const createDatabase = (url: string) => {
  const client = postgres(url, { max: 10, idle_timeout: 20 });

  return {
    ...createDatabaseWithClient(client),
    db: drizzle(client, { schema }),
  };
};

export type ApplicationDatabase = ReturnType<typeof createDatabase>;
