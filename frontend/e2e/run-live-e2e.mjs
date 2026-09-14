import { spawnSync } from 'node:child_process';

if (!process.env.E2E_BASE_URL?.trim()) {
  console.error('E2E_BASE_URL is required. Point it at the disposable frontend/live stack.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['./node_modules/@playwright/test/cli.js', 'test', '--project=live-chromium'], {
  env: { ...process.env, E2E_LIVE: 'true' },
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
