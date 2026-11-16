import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { imageConfig } from './config.js';
import { runImageTick } from './repository.js';
const config = imageConfig();
if (config.enabled) {
  const database = createDatabase(loadConfig(process.env).databaseUrl, { max: 3 });
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      try { await runImageTick(database.db, config); } catch { console.error(JSON.stringify({ event: 'recipe_image_tick_failed' })); }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally { await database.close(); }
} else {
  // Keep the default Compose service idle while image processing is disabled.
  console.info(JSON.stringify({ event: 'recipe_images_disabled' }));
  const idle = setInterval(() => undefined, 60000);
  const stop = () => clearInterval(idle);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
