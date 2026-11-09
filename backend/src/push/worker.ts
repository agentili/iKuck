import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { createPushTransport } from './transport.js';
import { runPushTick } from './repository.js';

const config = loadConfig(process.env);
if (config.pushEnabled) {
  const database = createDatabase(config.databaseUrl, { max: 3 });
  const send = createPushTransport(config.pushVapidSubject!, config.pushVapidPublicKey!, config.pushVapidPrivateKey!);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); wake?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopped) {
      try {
        await runPushTick(database.db, send, new Date(), (event) => console.info(JSON.stringify({ event: `push_${event}` })), () => stopped);
      } catch {
        console.error(JSON.stringify({ event: 'push_tick_failed' }));
      }
      if (!stopped) await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, 60_000); });
    }
  } finally {
    await database.close();
  }
}
