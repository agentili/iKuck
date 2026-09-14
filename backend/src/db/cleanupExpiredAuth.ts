import { sql, type SQL } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';

export interface AuthCleanupDatabase {
  execute: (query: SQL) => Promise<unknown>;
}

export interface AuthCleanupOptions {
  now?: Date;
  dryRun?: boolean;
}

export interface AuthCleanupResult {
  dryRun: boolean;
  sessions: number;
  verificationTokens: number;
  passwordResetTokens: number;
  total: number;
}

interface AuthCleanupCountRow {
  table_name?: unknown;
  count?: unknown;
}

const rowsFromResult = (result: unknown): AuthCleanupCountRow[] => (
  Array.isArray(result) ? result as AuthCleanupCountRow[] : []
);

const countForTable = (rows: AuthCleanupCountRow[], tableName: string): number => {
  const row = rows.find((candidate) => candidate.table_name === tableName);
  const count = typeof row?.count === 'number' || typeof row?.count === 'string' ? Number(row.count) : 0;
  return Number.isFinite(count) ? count : 0;
};

const buildCountQuery = (now: Date) => sql`
  SELECT 'auth_sessions' AS table_name, COUNT(*)::int AS count
  FROM auth_sessions
  WHERE expires_at <= ${now}
  UNION ALL
  SELECT 'email_verification_tokens' AS table_name, COUNT(*)::int AS count
  FROM email_verification_tokens
  WHERE expires_at <= ${now}
  UNION ALL
  SELECT 'password_reset_tokens' AS table_name, COUNT(*)::int AS count
  FROM password_reset_tokens
  WHERE expires_at <= ${now}
`;

export const cleanupExpiredAuth = async (
  database: AuthCleanupDatabase,
  options: AuthCleanupOptions = {},
): Promise<AuthCleanupResult> => {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    const rows = rowsFromResult(await database.execute(buildCountQuery(now)));
    const sessions = countForTable(rows, 'auth_sessions');
    const verificationTokens = countForTable(rows, 'email_verification_tokens');
    const passwordResetTokens = countForTable(rows, 'password_reset_tokens');
    return {
      dryRun,
      sessions,
      verificationTokens,
      passwordResetTokens,
      total: sessions + verificationTokens + passwordResetTokens,
    };
  }

  const sessions = rowsFromResult(await database.execute(sql`
    DELETE FROM auth_sessions
    WHERE expires_at <= ${now}
    RETURNING id
  `)).length;
  const verificationTokens = rowsFromResult(await database.execute(sql`
    DELETE FROM email_verification_tokens
    WHERE expires_at <= ${now}
    RETURNING id
  `)).length;
  const passwordResetTokens = rowsFromResult(await database.execute(sql`
    DELETE FROM password_reset_tokens
    WHERE expires_at <= ${now}
    RETURNING id
  `)).length;

  return {
    dryRun,
    sessions,
    verificationTokens,
    passwordResetTokens,
    total: sessions + verificationTokens + passwordResetTokens,
  };
};

export const run = async (): Promise<void> => {
  const config = loadConfig(process.env);
  const database = createDatabase(config.databaseUrl);

  try {
    const result = await cleanupExpiredAuth(database.db, { dryRun: process.env.DRY_RUN === 'true' });
    console.log(JSON.stringify(result));
  } finally {
    await database.close();
  }
};

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Auth cleanup failed');
    process.exitCode = 1;
  });
}
