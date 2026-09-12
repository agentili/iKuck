import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';

const run = async () => {
  const config = loadConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  const migrationFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

  try {
    await migrate(database.db, { migrationsFolder: migrationFolder });
  } finally {
    await database.close();
  }
};

void run();
