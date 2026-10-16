import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';
import { createDrizzlePantryCandidateRepository } from '../pantry/candidatesRepository.js';

export const run = async (): Promise<number> => {
  const config = loadConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  try {
    const deletedCandidates = await createDrizzlePantryCandidateRepository(database.db)
      .cleanupExpiredCandidates(new Date());
    console.log(JSON.stringify({ deletedCandidates }));
    return deletedCandidates;
  } finally {
    await database.close();
  }
};

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Bring candidate cleanup failed');
    process.exitCode = 1;
  });
}
